/**
 * Enemy AI. Pure — no Three.js, no DOM.
 *
 * `battle` is duck-typed, not imported: it only has to expose
 *   living(side) -> Combatant[]   (living members of that side)
 *   skills       -> Record<id, SkillDef>
 * which `createBattle()` in battle.js satisfies. Keeping the dependency that way
 * avoids a cycle and lets this be unit-tested against a stub.
 *
 * One rng() draw drives the branch, in the order the contract lists them:
 *   < 0.15              use a random skill      (needs one, and >= 50% HP)
 *   < 0.35              heal a wounded ally     (needs a heal skill + a wounded ally)
 *   < 0.65              attack the lowest-HP ally
 *   else                attack a random living ally
 * If a branch's precondition fails it falls through to the next cheaper branch
 * rather than re-rolling, so the thresholds stay stable for a given rng stream.
 *
 * When the enemy `knowsWeakness` (optional flag on the Combatant; the UI can
 * set it from enemies.json to expose an enemy that plays to the matrix) target
 * choice is narrowed to the best-scoring candidates: Boosted first, then the
 * element the enemy can hurt most.
 */

import { multiplier } from './weaknesses.js';

const SKILL_CHANCE = 0.15;
const HEAL_CHANCE = 0.20;
const LOW_HP_CHANCE = 0.30;

const pickOne = (list, rng) => list[Math.floor(rng() * list.length)];

/** `{ id, def }` pairs for the ids the enemy actually owns and that exist. */
function ownedSkills(enemy, skills) {
  return (enemy.skills ?? [])
    .map((id) => ({ id, def: skills?.[id] }))
    .filter((s) => s.def);
}

function attackActions(enemy, skills) {
  return [
    { weaponType: enemy.weaponType, element: null },
    ...skills.filter((s) => s.def.kind === 'attack').map((s) => s.def),
  ];
}

/** Best multiplier this enemy can land on `foe`, boosted targets ranked higher. */
function attackScore(enemy, foe, actions) {
  const best = actions.reduce((m, a) => Math.max(m, multiplier(enemy, foe, a)), 0);
  return (foe.boosted && best > 0 ? 10 : 0) + best;
}

/** Keep only the best-scoring candidates when the enemy plays to the matrix. */
function narrow(cands, score, enemy, rng) {
  if (!enemy.knowsWeakness) return cands;
  const best = Math.max(...cands.map(score));
  const pool = cands.filter((c) => score(c) === best);
  return pool.length ? pool : cands;
}

const lowestHP = (list) => list.reduce((a, b) => (b.currentHP < a.currentHP ? b : a));

/**
 * @param {object} enemy  the acting Combatant (side must be 'enemy')
 * @param {object} battle `{ living(side), skills }`
 * @param {() => number} [rng]
 * @returns {{ actorUid:string, type:'attack'|'skill'|'item'|'boost'|'defend',
 *             targetUid:string, actionId?:string, itemId?:string }}
 */
export function chooseEnemyCommand(enemy, battle, rng = Math.random) {
  const foes = battle.living(enemy.side === 'ally' ? 'enemy' : 'ally') ?? [];
  // Nothing left to hit: the side is wiped. Defend is a safe no-op so the round
  // still gets a full set of commands and the battle can finish cleanly.
  if (!foes.length) return { actorUid: enemy.uid, type: 'defend', targetUid: enemy.uid };

  const skills = ownedSkills(enemy, battle.skills);
  const actions = attackActions(enemy, skills);
  const roll = rng();

  if (roll < SKILL_CHANCE && enemy.currentHP >= enemy.maxHP * 0.5) {
    const offensive = skills.filter((s) => s.def.kind === 'attack' && s.def.power > 0);
    if (offensive.length) {
      const { id, def } = pickOne(offensive, rng);
      const pool = narrow(foes, (f) => multiplier(enemy, f, def), enemy, rng);
      return { actorUid: enemy.uid, type: 'skill', targetUid: pickOne(pool, rng).uid, actionId: id };
    }
  }

  if (roll < SKILL_CHANCE + HEAL_CHANCE) {
    const healers = skills.filter((s) => s.def.kind === 'heal' && (s.def.target === 'ally' || s.def.target === 'self'));
    const hurt = (battle.living(enemy.side) ?? []).filter((c) => c.currentHP < c.maxHP);
    if (healers.length && hurt.length) {
      const { id, def } = pickOne(healers, rng);
      const target = def.target === 'self' ? enemy : lowestHP(hurt);
      return { actorUid: enemy.uid, type: 'skill', targetUid: target.uid, actionId: id };
    }
  }

  const pool = narrow(foes, (f) => attackScore(enemy, f, actions), enemy, rng);
  const target = roll < SKILL_CHANCE + HEAL_CHANCE + LOW_HP_CHANCE ? lowestHP(pool) : pickOne(pool, rng);
  return { actorUid: enemy.uid, type: 'attack', targetUid: target.uid };
}
