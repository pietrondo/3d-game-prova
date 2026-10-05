/**
 * src/battle/commands.js — how the player gives orders in a battle.
 *
 * Two things live here and nothing else: the one-screen list prompt (the DOM,
 * the keyboard edges, the el() helper) and the composition of a round's orders
 * (what rows the list shows, what value each row is worth).
 *
 * It is deliberately NOT src/ui/menu.js. menu.js is the pause menu: a tabbed
 * frame with its own open()/close() lifecycle. The battle list is a different
 * interaction — keyboard, one screen, no tabs, driven by contracts §21 — and
 * routing it through menu.js would drag the tab frame into every fight. What
 * they must share is the *styling discipline*, which lives in battle.css.
 *
 * The el() argument order is (tag, text, class). That order is load-bearing:
 * passing (tag, class, text) does not throw, it silently prints the class name
 * as the row's label — which is exactly what QA caught on screen. Every call
 * site here passes the label first.
 */

import { multiplier } from '../combat/weaknesses.js';
import { ELEMENT_IT, SKILL_KIND_IT, ITEM_KIND_IT, WEAPON_TYPE_IT, tr } from '../core/terms.js';

/** @param {string} tag @param {*} text @param {string} [cls] */
export const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * The one-screen list prompt: a title plus one row per option, `interact` picks,
 * `up`/`down` move, and `cancel()` closes it resolving `null` so a caller can
 * never be left awaiting a promise that nobody will settle.
 */
export function createCommandPrompt({ root, input }) {
  const panel = el('div', null, 'bt-prompt');
  panel.hidden = true;
  root.appendChild(panel);

  let title = '';
  let opts = [];
  let sel = 0;
  let done = null;

  function render() {
    const rows = opts.map((o, i) => {
      const row = el('div', null, 'bt-row' + (i === sel ? ' is-sel' : ''));
      row.appendChild(el('span', o.label, 'bt-name'));
      row.appendChild(el('span', o.sub, 'bt-sub'));
      return row;
    });
    panel.replaceChildren(el('div', title, 'bt-title'), ...rows);
  }

  function close(value) {
    const d = done;
    done = null;
    opts = [];
    panel.hidden = true;
    if (d) d(value);
  }

  return {
    choose(t, options) {
      title = t;
      opts = options;
      sel = 0;
      panel.hidden = false;
      render();
      return new Promise((res) => { done = res; });
    },
    /** Once per frame, after input.update(). */
    read() {
      if (!done || !opts.length) return;
      const n = opts.length;
      if (input.pressed('up')) { sel = (sel - 1 + n) % n; render(); }
      if (input.pressed('down')) { sel = (sel + 1) % n; render(); }
      if (input.pressed('interact')) close(opts[sel] ? opts[sel].value : null);
    },
    cancel: () => close(null),
    get isOpen() { return !!done; },
    get rows() { return opts.map((o) => o.label); },
    get sel() { return sel; },
    dispose() { close(null); panel.remove(); },
  };
}

/** Best multiplier this actor can land on `foe` — the weakness matrix, on screen. */
function bestAgainst(actor, foe, skills) {
  const actions = [{ weaponType: actor.weaponType, element: null },
    ...actor.skills.map((id) => skills[id]).filter(Boolean)];
  let best = 1;
  let bestName = '';
  for (const a of actions) {
    const m = multiplier(actor, foe, a);
    if (m > best) { best = m; bestName = a.name || a.element || 'colpo'; }
  }
  return best > 1 ? `${bestName} x${best}` : 'resiste';
}

/**
 * Round-order collection. `battle` is passed in rather than captured because the
 * director builds a fresh battle per encounter.
 *
 * `bag` is the player's inventory. Items used to be unreachable: battle.js has
 * implemented `type: 'item'` since the contract was written, but nothing ever
 * submitted one, so the tonics a marker promised went nowhere and the gold from
 * a victory was thrown away. `bag` is what makes that code live.
 */
export function createCommander({ prompt, skills, rng, chooseEnemyCommand, bag = null }) {
  const bail = (ally) => ({ actorUid: ally.uid, type: 'defend', targetUid: ally.uid });

  /**
   * Which entries of `items` are worth offering right now.
   *
   * A row the player cannot act on is worse than an absent row: it reads as a
   * bug. So an item is listed only if the bag holds it AND it has at least one
   * legal target — a heal with every ally at full HP heals nothing, and a revive
   * with nobody down does nothing.
   */
  function usableItems(battle) {
    if (!bag) return [];
    const livingAllies = battle.living('ally');
    const downed = battle.combatants.filter((c) => c.side === 'ally' && c.currentHP <= 0);
    return bag.entries()
      .map(({ id, count, def }) => ({ id, count, def }))
      .filter(({ def }) => {
        if (def.kind === 'revive') return downed.length > 0;
        // A heal on a full party is a wasted turn; a revive needs a body.
        return def.target === 'ally'
          ? livingAllies.some((c) => (def.kind === 'mp' ? c.currentMP < c.maxMP : c.currentHP < c.maxHP))
          : true;
      });
  }

  async function askCommand(battle, ally, foes) {
    const known = ally.skills.map((id) => ({ id, def: skills[id] })).filter((s) => s.def);
    const carried = usableItems(battle);
    const pick = await prompt.choose(ally.name, [
      { label: 'Attacco', sub: tr(WEAPON_TYPE_IT, ally.weaponType), value: { type: 'attack', def: null } },
      ...known.map((s) => ({
        label: s.def.name,
        sub: s.def.mp
          ? `${s.def.mp} PM · ${tr(ELEMENT_IT, s.def.element, tr(SKILL_KIND_IT, s.def.kind))}`
          : tr(SKILL_KIND_IT, s.def.kind),
        value: { type: 'skill', def: s.def, actionId: s.id },
      })),
      ...carried.map(({ id, count, def }) => ({
        label: def.name,
        sub: `${tr(ITEM_KIND_IT, def.kind)} · x${count}`,
        value: { type: 'item', def, itemId: id },
      })),
      { label: 'Potenziamento', sub: 'cura 10% per turno', value: { type: 'boost', def: null } },
      { label: 'Guardia', sub: 'dimezza i danni', value: { type: 'defend', def: null } },
    ]);
    if (!pick) return bail(ally);
    if (pick.type === 'boost' || pick.type === 'defend' || pick.def?.target === 'self') {
      return { actorUid: ally.uid, type: pick.type, actionId: pick.actionId, targetUid: ally.uid };
    }
    // Every pending ally owes a command or the round never resolves, so a dead
    // target pool falls back to Guard rather than leaving `whenRoundReady` hanging.
    // A revive is the one case whose pool is the DOWNED: `living('ally')` can
    // never contain a corpse, so asking it for revive targets is an empty list.
    const downed = battle.combatants.filter((c) => c.side === 'ally' && c.currentHP <= 0);
    const pool = pick.type === 'item' && pick.def?.kind === 'revive' ? downed
      : pick.def?.target === 'ally' ? battle.living('ally') : foes;
    if (!pool.length) return bail(ally);
    const t = await prompt.choose(`${ally.name} — bersaglio`, pool.map((c) => ({
      label: c.name,
      sub: c.side === 'enemy' ? bestAgainst(ally, c, skills)
        : c.currentHP <= 0 ? 'A TERRA · rianima'
          : `${c.currentHP}/${c.maxHP} PV`,
      value: c,
    })));
    if (!t) return bail(ally);
    // Spend at the moment the order is formed, not when it resolves. battle.js
    // can still fizzle a queued command (the target dies first), and refunding
    // on a fizzle is a second rule to get wrong for no player benefit.
    if (pick.type === 'item' && bag) bag.use(pick.itemId);
    return { actorUid: ally.uid, type: pick.type, actionId: pick.actionId, targetUid: t.uid };
  }

  async function collect(battle) {
    try {
      // Captured BEFORE the submit loop: whenRoundReady() points at the round in
      // flight and resolves the moment the last command lands.
      const ready = battle.whenRoundReady();
      for (const c of battle.pending.slice()) {
        if (battle.state !== 'command') break;
        if (c.side === 'ally') {
          const cmd = await askCommand(battle, c, battle.living('enemy'));
          if (cmd && battle.state === 'command') battle.submitCommand(cmd);
        } else {
          battle.submitAiCommand(chooseEnemyCommand(c, battle, rng));
        }
      }
      await ready;
    } catch (err) {
      console.error('[hd2d] command collection failed', err);
    }
  }

  return { askCommand, collect };
}
