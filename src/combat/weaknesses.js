/**
 * Weakness / element resolution. Pure — no Three.js, no DOM, no imports.
 *
 * Resolution order (contracts.md §12, frozen):
 *   1. immunity            -> 0
 *   2. explicit entry      -> defender.immunities / .vulnerabilities / .resistances
 *   3. weapon-type table   -> WEAPON_ELEMENT, only supplies the element to look up
 *   4. NORMAL              -> 1
 *
 * Step 3 note: the frozen Combatant shape has no shield field, so the only
 * weapon-type table that exists is the weapon -> default-element map. It cannot
 * yield a multiplier on its own; it is folded into step 2 by construction
 * (resolveElement runs first, then the explicit lookup). Documented choice.
 *
 * Within step 2, immunity wins, then an explicit vulnerability (2), then an
 * explicit `resistances[element]` value. That tiebreak is ours, not the
 * contract's: a designed weakness must not be cancelled by a resistance entry.
 */

export const ELEMENTS = ['physical', 'fire', 'ice', 'lightning', 'dark', 'light'];
export const WEAPON_TYPES = ['sword', 'spear', 'axe', 'bow', 'staff', 'dagger'];
export const MULT = { WEAKENED: 0.5, NORMAL: 1, STRONG: 2, IMMUNE: 0 };

/** weaponType -> element used when the action carries no explicit element. */
export const WEAPON_ELEMENT = {
  sword: 'physical',
  spear: 'physical',
  axe: 'physical',
  bow: 'physical',
  dagger: 'physical',
  staff: 'light',
};

const inList = (list, value) => Array.isArray(list) && list.includes(value);

/** The element an action hits with: explicit `element`, else the weapon-type table. */
export function resolveElement(action) {
  if (action?.element) return action.element;
  return WEAPON_ELEMENT[action?.weaponType] ?? null;
}

/** Full multiplier, including the weapon-type table step. `attacker` is unused by the
 *  frozen table but kept in the signature because the contract defines it. */
export function multiplier(attacker, defender, action = {}) {
  const element = resolveElement(action);

  // 1. immunity beats every other rule
  if (inList(defender?.immunities, element)) return MULT.IMMUNE;

  // 2. explicit entry on the defender
  if (inList(defender?.vulnerabilities, element)) return MULT.STRONG;
  const table = defender?.resistances;
  if (element !== null && table && Object.hasOwn(table, element)) return table[element];

  // 4. nothing matched
  return MULT.NORMAL;
}

/** Bucket a multiplier for the UI / damage result. */
export function classify(m) {
  if (m === MULT.IMMUNE) return 'immune';
  if (m < MULT.NORMAL) return 'weak';
  if (m > MULT.NORMAL) return 'strong';
  return 'normal';
}

/** Weakest point of `defender` for the weakness icons: the element it takes most from. */
export function strongestWeakness(defender) {
  let best = null;
  for (const element of ELEMENTS) {
    const mult = multiplier(null, defender, { element });
    if (mult <= MULT.NORMAL) continue; // immune and weak are not weaknesses
    if (!best || mult > best.mult) best = { element, mult };
  }
  return best;
}
