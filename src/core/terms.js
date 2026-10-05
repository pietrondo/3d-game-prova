/**
 * src/core/terms.js — the seam between data keys and displayed Italian.
 *
 * `element`, `kind`, `weaponType` are DATA KEYS. The combat layer reads them
 * (`weaknesses.js` switches on `element`, `battle.js` on `kind`) and they must
 * never be translated, or every lookup in the game breaks. The UI, meanwhile,
 * has to print "fuoco" for `fire` and "rianima" for `revive`.
 *
 * That is two names for one thing, which is exactly the kind of duplication
 * that drifts — so the maps live in ONE file and both the battle command list
 * and the pause menu read them. Not an i18n layer: one language, one map, and
 * no lookup for something that has no second case.
 */

export const ELEMENT_IT = {
  fire: 'fuoco',
  ice: 'ghiaccio',
  lightning: 'fulmine',
  dark: 'oscurità',
  light: 'luce',
  physical: 'fisico',
};

/** skills.json `kind`. */
export const SKILL_KIND_IT = {
  attack: 'attacco',
  buff: 'potenziamento',
  heal: 'cura',
};

/** items.json `kind`. `mp` and `revive` are item-only kinds. */
export const ITEM_KIND_IT = {
  heal: 'cura',
  mp: 'mana',
  revive: 'rianima',
};

/**
 * Look a data key up in a display map. Falls back to `alt` and then to the key
 * itself, so an untranslated value shows as its raw key rather than as a blank
 * row — a blank row hides the bug, a raw key shows it.
 */
export const tr = (map, key, alt = '') => map[key] || alt || key || '';
