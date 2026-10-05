/**
 * Damage and healing. Pure — no Three.js, no DOM.
 *
 * The formula below is a frozen, testable contract (contracts.md §13). The
 * `rng()` call ORDER matters: variance is drawn FIRST, crit SECOND. Tests stub
 * rng and assert the exact resulting number.
 *
 * This module never mutates `defender` — it returns `hpAfter` and the caller
 * (battle.js) is the only thing that writes HP. That keeps damage.js pure.
 *
 * `action.stat` selects the attacker's offensive stat and defaults to
 * `'attack'`. It exists so a staff skill can scale off `magic`: without it the
 * scholar is the designated answer to the Sentinel's ice weakness while being
 * the worst ice damage dealer in the party, because she has magic 20 and
 * attack 9. The default is unchanged, so the formula above stays character-exact.
 */

import { MULT, classify } from './weaknesses.js';

export const VARIANCE_MIN = 0.92;
export const VARIANCE_SPAN = 0.16;
export const CRIT_MULT = 1.5;
export const DEFAULT_CRIT_RATE = 0.05;

/**
 * @param {object}  o
 * @param {object}  o.attacker  needs `.attack`, and `.magic` when action.stat is 'magic'
 * @param {object}  o.defender  needs `.defense`, `.currentHP`
 * @param {object} [o.action]   `{ power, element, weaponType, critRate, stat }`
 * @param {number} [o.mult]     weakness multiplier; defaults to NORMAL
 * @param {() => number} [o.rng]
 * @returns {{ amount:number, crit:boolean, effectiveness:string, mult:number,
 *             hpAfter:number, dead:boolean, variance:number }}
 */
export function computeDamage({ attacker, defender, action = {}, mult = MULT.NORMAL, rng = Math.random }) {
  const power = action.power ?? 0;
  const stat = attacker[action.stat ?? 'attack'] ?? attacker.attack ?? 1;
  const base = (power * stat) / Math.max(1, defender.defense);
  const variance = VARIANCE_MIN + rng() * VARIANCE_SPAN;             // draw 1
  const crit = rng() < (action.critRate ?? DEFAULT_CRIT_RATE);       // draw 2
  const raw = base * variance * mult * (crit ? CRIT_MULT : 1);
  const amount = Math.min(Math.max(0, Math.round(raw)), defender.currentHP);
  const hpAfter = defender.currentHP - amount;

  return {
    amount,
    crit,
    effectiveness: classify(mult),
    mult,
    hpAfter,
    dead: hpAfter <= 0,
    variance,
  };
}

/**
 * HP restored by a heal skill/item. Floor of `power * caster.magic`, capped at
 * the target's MISSING hp (never overheals). Returns 0 on a full-health target.
 */
export function computeHeal({ caster, target, power }) {
  const missing = Math.max(0, (target.maxHP ?? 0) - (target.currentHP ?? 0));
  return Math.min(Math.floor(power * caster.magic), missing);
}

/** MP restored by an `mp` item. Same cap logic on the MP pool. */
export function computeRestoreMP({ power, target }) {
  const missing = Math.max(0, (target.maxMP ?? 0) - (target.currentMP ?? 0));
  return Math.min(Math.floor(power), missing);
}
