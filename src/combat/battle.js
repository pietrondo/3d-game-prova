/**
 * Round-based battle state machine. Pure — no Three.js, no DOM, no async.
 * The renderer listens to `onEvent(type, payload)` and animates; this file only
 * decides what happened and mutates Combatant stats in place.
 *
 * Phases
 *   intro       -> first `update(dt)` builds the timeline and opens round 1
 *   turnStart   -> `update(dt)` advanced the opening actor via nextTurn(); one
 *                  frame of `turnStart` so the HUD can read the new round
 *   command     -> submitCommand() / submitAiCommand() until every living
 *                  combatant has one, then the whole round resolves at once
 *   resolving   -> commands applied in timeline order (synchronous burst of events)
 *   victory|defeat
 *
 * The round after a resolution opens on the next `update(dt)`, not inline, so
 * `whenRoundReady()` keeps pointing at the round that just finished.
 *
 * Documented edge-case choices
 * - A command whose target is already down FIZZLES into a `'miss'` with
 *   reason `'target-down'`. It is not retargeted: silently hitting a different
 *   enemy than the one the player aimed at is worse than a whiff.
 * - A combatant who died before their queued command resolves emits `'miss'`
 *   with reason `'actor-down'` rather than being silently skipped, so the
 *   renderer still gets a beat for that turn.
 * - Immunity does NOT break a Boost (`amount === 0`), matching Octopath.
 * - `defend` halves the final damage in this file, not inside computeDamage, so
 *   the weakness classification in the DamageResult survives the reduction.
 * - 'turn' is emitted from both places where the active combatant changes:
 *   startRound() (the timeline picked the next living combatant) and beginTurn()
 *   (a queued command is resolving). Payload: { actor, uid, side, round, index }.
 *   The renderer drives the turn banner off it, so nothing polls `battle.current`.
 *
 * Additive fields beyond the contracts §16 Battle type (safe for consumers):
 * `round`, `elapsed`, `pending`, `combatants`, `log`, `skills`, `items`,
 * `living(side)`, `get(uid)`.
 */

import { multiplier, resolveElement } from './weaknesses.js';
import { computeDamage, computeHeal, computeRestoreMP, DEFAULT_CRIT_RATE } from './damage.js';
import { buildTimeline, nextTurn } from './turnOrder.js';

// Power of a bare attack. Must sit in the same ballpark as a weak skill (enemy
// skills run 10-20), not at 1: against defense 8 a power-1 attack rounds to a
// single damage, and against the Sentinel's defense it rounds to ZERO, so the
// basic attack can never finish anything. Physical is 0.5 on every enemy by
// design, so at power 10 a correct boosted skill still lands ~2-3x harder.
export const BASIC_POWER = 10;
export const DEFEND_MULT = 0.5;    // incoming damage while `defending`
export const RECOVER_RATIO = 0.1;  // boost recovery = 10% of maxHP
export const REVIVE_RATIO = 0.5;   // a revive item restores half of maxHP

export function createBattle({
  allies = [],
  enemies = [],
  skills = {},
  items = {},
  rng = Math.random,
  onEvent,
  basicPower = BASIC_POWER,
}) {
  let disposed = false;
  const emit = (type, payload) => { if (!disposed && typeof onEvent === 'function') onEvent(type, payload); };

  const combatants = [...allies, ...enemies];
  const byUid = new Map(combatants.map((c) => [c.uid, c]));

  const allLog = [];
  let state = 'intro';
  let timeline = [];
  let turnIndex = -1;
  let current = null;
  let round = 0;
  let elapsed = 0;
  let result = null;
  let queue = new Map();
  let pending = [];
  let roundResolve = null;
  // Created at construction so an early whenRoundReady() (before the first
  // update) is still hooked to round 1 instead of resolving instantly.
  let roundPromise = new Promise((res) => { roundResolve = res; });

  const dead = (c) => !c || c.currentHP <= 0;
  const living = (side) => combatants.filter((c) => !dead(c) && (!side || c.side === side));
  const get = (uid) => byUid.get(uid);
  const aliveUids = () => new Set(living().map((c) => c.uid));

  // ---- action construction --------------------------------------------------

  function basicAction(actor) {
    return {
      id: null, name: 'Attack', kind: 'attack', power: basicPower,
      element: null, weaponType: actor.weaponType,
      critRate: DEFAULT_CRIT_RATE, target: 'enemy',
    };
  }

  /** null means "unknown skill/item id" — the caller turns that into a miss. */
  function actionFor(command, actor) {
    if (command.type === 'skill') {
      const def = skills[command.actionId];
      return def ? { ...def, id: command.actionId } : null;
    }
    if (command.type === 'item') {
      const def = items[command.itemId];
      return def ? { ...def, id: command.itemId } : null;
    }
    return basicAction(actor);
  }

  // ---- per-turn bookkeeping -------------------------------------------------

  /**
   * contracts §16 requires a 'turn' beat, and the honest definition of "a turn"
   * is "the active combatant changed". That happens twice: once per round when
   * the timeline picks the next living combatant (startRound), and once per
   * command while the round resolves (beginTurn). Emitting from both is what
   * lets the renderer drive the banner off the event stream instead of polling
   * `battle.current` — a second source of truth for the same fact.
   */
  function announce() {
    if (!current) return;
    emit('turn', { actor: current, uid: current.uid, side: current.side, round, index: turnIndex });
  }

  function beginTurn(uid) {
    current = get(uid);
    turnIndex = timeline.findIndex((e) => e.uid === uid);
    const c = current;
    if (!c || dead(c)) return;
    c.defending = false;
    announce();

    // Octopath: a Boosted party member mends itself at the top of its own turn.
    if (c.side === 'ally' && c.boosted && c.currentHP < c.maxHP) {
      const amount = Math.min(Math.max(1, Math.round(c.maxHP * RECOVER_RATIO)), c.maxHP - c.currentHP);
      const hpBefore = c.currentHP;
      c.currentHP += amount;
      emit('recover', { target: c, amount, hpBefore, hpAfter: c.currentHP });
    }
  }

  // ---- resolution primitives ------------------------------------------------

  function miss(actor, target, reason) {
    emit('miss', { actor, target, reason });
    return { outcome: 'miss', amount: 0, result: null };
  }

  function strike(actor, target, action) {
    if (!target || dead(target)) return miss(actor, target, 'target-down');
    if (action.missRate && rng() < action.missRate) return miss(actor, target, 'evaded');

    const mult = multiplier(actor, target, action);
    const result = computeDamage({ attacker: actor, defender: target, action, mult, rng });
    if (target.defending && result.amount > 0) {
      const halved = Math.floor(result.amount * DEFEND_MULT);
      result.amount = halved;
      result.hpAfter = target.currentHP - halved;
      result.dead = result.hpAfter <= 0;
    }

    // Boost break — only a hit that actually removed HP breaks it.
    if (result.amount > 0 && target.boosted) {
      target.boosted = false;
      emit('boost', { target, actor, gained: false });
    }
    if (result.effectiveness === 'weak') emit('weak', { attacker: actor, target, mult, damage: result });
    if (result.effectiveness === 'immune') {
      emit('immune', { attacker: actor, target, element: resolveElement(action), damage: result });
    }

    target.currentHP = result.hpAfter;
    emit('damage', { attacker: actor, target, result });
    if (result.dead) {
      target.boosted = false;
      target.defending = false;
      emit('down', { target, side: target.side });
    }
    return { outcome: 'damage', amount: result.amount, result };
  }

  function applyBoost(actor, target) {
    if (!target || dead(target)) return miss(actor, target, 'target-down');
    target.boosted = true;
    emit('boost', { target, actor, gained: true });
    return { outcome: 'boost', amount: 0, result: null };
  }

  function applyHeal(actor, target, action, source) {
    if (!target || dead(target)) return miss(actor, target, 'target-down');
    const hpBefore = target.currentHP;
    const amount = computeHeal({ caster: actor, target, power: action.power ?? 0 });
    target.currentHP = hpBefore + amount;
    emit('heal', {
      caster: actor, target, amount, hpBefore, hpAfter: target.currentHP,
      mpBefore: null, mpAfter: null, source,
    });
    return { outcome: 'heal', amount, result: null };
  }

  function applyItem(actor, target, def) {
    if (!def) return miss(actor, target, 'unknown-item');
    if (def.kind === 'revive') {
      if (!dead(target)) return miss(actor, target, 'target-alive');
      const hpBefore = target.currentHP;
      target.currentHP = Math.max(1, Math.round(target.maxHP * REVIVE_RATIO));
      emit('heal', {
        caster: actor, target, amount: target.currentHP - hpBefore, hpBefore, hpAfter: target.currentHP,
        mpBefore: null, mpAfter: null, source: 'item',
      });
      return { outcome: 'heal', amount: target.currentHP - hpBefore, result: null };
    }
    if (!target || dead(target)) return miss(actor, target, 'target-down');

    const hpBefore = target.currentHP;
    const mpBefore = target.currentMP;
    let amount = 0;
    if (def.kind === 'mp') {
      amount = computeRestoreMP({ power: def.power ?? 0, target });
      target.currentMP = mpBefore + amount;
    } else {
      amount = computeHeal({ caster: actor, target, power: def.power ?? 0 });
      target.currentHP = hpBefore + amount;
    }

    emit('heal', {
      caster: actor, target, amount, hpBefore, mpBefore,
      hpAfter: target.currentHP, mpAfter: target.currentMP, source: 'item',
    });
    return { outcome: 'heal', amount, result: null };
  }

  // ---- one command ----------------------------------------------------------

  function applyCommand(command) {
    const actor = get(command.actorUid);
    const target = get(command.targetUid);
    if (dead(actor)) return miss(actor, target, 'actor-down');

    beginTurn(command.actorUid);

    const action = actionFor(command, actor);
    // One 'action' beat per resolved command, whatever the type: the renderer
    // branches on `command.type` (attack lunge / cast / buff pose / guard).
    emit('action', { actor, target, command, action });

    if (command.type === 'defend') {
      actor.defending = true;
      return { outcome: 'defend', amount: 0, result: null };
    }
    if (command.type === 'boost') return applyBoost(actor, target);
    if (!action) return miss(actor, target, `unknown-${command.type}`);
    if (command.type === 'item') return applyItem(actor, target, action);

    const cost = command.type === 'skill' ? (action.mp ?? 0) : 0;
    if (cost > actor.currentMP) return miss(actor, target, 'no-mp');
    if (cost > 0) actor.currentMP -= cost;

    if (action.kind === 'heal') return applyHeal(actor, target, action, 'skill');
    // skills.json also ships kind:'buff' (guard_up, bulwark, shadowstep). The
    // contract defines exactly one buff mechanic — Boost — so a buff skill
    // applies Boost to its target instead of being mistaken for a physical hit.
    if (action.kind === 'buff') return applyBoost(actor, target);
    return strike(actor, target, action);
  }

  // ---- round driver ---------------------------------------------------------

  function finish(winner) {
    if (result) return;
    result = winner;
    state = winner;
    if (winner === 'defeat') for (const a of allies) a.currentHP = Math.max(1, a.currentHP);
    emit('end', { result: winner, round, allies, enemies, timeline });
  }

  function checkEnd() {
    if (result) return;
    if (!living('enemy').length) finish('victory');
    else if (!living('ally').length) finish('defeat');
  }

  function startRound() {
    round++;
    checkEnd(); // an empty side ends the battle before any command is asked for
    if (result) { roundResolve?.([]); return; }

    turnIndex = nextTurn(timeline, turnIndex, aliveUids());
    if (turnIndex < 0) {
      // Nobody can act. Whoever is still standing won.
      roundResolve?.([]);
      finish(living('ally').length ? 'victory' : 'defeat');
      return;
    }
    current = get(timeline[turnIndex].uid);
    state = 'turnStart';
    announce();
    queue = new Map();
    pending = living();
    if (round > 1) roundPromise = new Promise((res) => { roundResolve = res; });
  }

  function resolveRound() {
    state = 'resolving';
    const from = allLog.length;

    for (const slot of timeline) {
      if (result) break;
      const command = queue.get(slot.uid);
      if (!command) continue;
      const actor = get(slot.uid);
      const target = get(command.targetUid);
      const outcome = applyCommand(command);
      allLog.push({
        actorUid: actor.uid, actorName: actor.name, type: command.type,
        targetUid: target?.uid ?? null, targetName: target?.name ?? null,
        outcome: outcome.outcome, amount: outcome.amount, result: outcome.result,
      });
      checkEnd();
    }

    // The round is settled. The NEXT round opens on the next update(dt), so
    // whenRoundReady() still points at the round that just finished.
    roundResolve(allLog.slice(from));
  }

  function submit(command, side) {
    if (state !== 'command') {
      throw new Error(`battle: not accepting commands (state="${state}")`);
    }
    const actor = get(command?.actorUid);
    if (!actor) throw new Error(`battle: unknown actor "${command?.actorUid}"`);
    if (actor.side !== side) {
      throw new Error(`battle: ${actor.uid} is a ${actor.side}, submitted through the ${side} channel`);
    }
    if (queue.has(actor.uid)) throw new Error(`battle: ${actor.uid} already submitted this round`);
    if (!pending.some((c) => c.uid === actor.uid)) {
      throw new Error(`battle: ${actor.uid} has no turn this round`);
    }

    queue.set(actor.uid, { ...command, actorUid: actor.uid });
    pending = pending.filter((c) => c.uid !== actor.uid);
    if (!pending.length) resolveRound();
  }

  function update(dt) {
    elapsed += dt ?? 0;
    if (state === 'intro') {
      timeline = buildTimeline(allies, enemies, rng);
      startRound();
    } else if (state === 'resolving') {
      startRound();
    } else if (state === 'turnStart') {
      state = 'command';
    }
  }

  return {
    get state() { return state; },
    get timeline() { return timeline; },
    get turnIndex() { return turnIndex; },
    get current() { return current; },
    get round() { return round; },
    get elapsed() { return elapsed; },
    get isOver() { return result !== null; },
    get result() { return result; },
    get pending() { return pending.slice(); },
    get combatants() { return combatants; },
    get log() { return allLog.slice(); },

    skills,
    items,
    living,
    get,

    submitCommand: (command) => submit(command, 'ally'),
    submitAiCommand: (command) => submit(command, 'enemy'),
    whenRoundReady: () => roundPromise,
    update,
    dispose() { disposed = true; },
  };
}
