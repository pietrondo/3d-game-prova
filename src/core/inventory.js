/**
 * src/core/inventory.js — the party's gold and item counts.
 *
 * Pure data plus five operations, deliberately Three.js-free and DOM-free so it
 * unit-tests in Node like the rest of src/combat.
 *
 * Why this exists at all: battle.js already implements items end to end —
 * `command.type === 'item'`, `applyItem` for heal/mp/revive, REVIVE_RATIO — and
 * items.json ships three of them. Nothing connected them. The game *promised*
 * the player 3 Field Tonics in a dialogue and then only printed a toast, because
 * there was nowhere to put them. The battle had no way to spend anything, so
 * the gold from `enemies.json` was summed, toasted and forgotten, and a 120 G
 * Phoenix Bloom could neither be bought nor used.
 *
 * `ITEMS` (items.json) is the catalogue: what exists and what it costs. This
 * module is the bag: how many of each you actually carry. Never mix the two.
 *
 * The id is the key everywhere. Adding an item is a one-line edit to
 * items.json plus a `bag.add(id, n)` where it is found — no code path per item.
 */

/** What a bag starts as. New play: empty, no gold. */
export function createInventory(items = {}) {
  // id -> count, only for ids that are actually in the catalogue. A count for
  // an unknown id is a data bug, so it is dropped here rather than shown in the
  // menu as an item with no name, no effect and no price.
  const counts = new Map();
  for (const id of Object.keys(items)) counts.set(id, 0);
  let gold = 0;

  return {
    /** How many of `id` are carried. 0 for anything not in the catalogue. */
    count(id) {
      return counts.get(id) || 0;
    },

    /**
     * Add `n` of `id`. `n` may be negative to remove, which keeps every caller
     * from needing a separate `remove` and its guard. Clamped at 0: a count can
     * never go negative, so `use` is just `add(id, -1)` with an exists-check.
     */
    add(id, n = 1) {
      if (!counts.has(id)) return 0;           // unknown id: no-op, not a throw
      const next = Math.max(0, counts.get(id) + n);
      counts.set(id, next);
      return next;
    },

    /** Spend one of `id`. False when the bag is empty — the caller must check. */
    use(id) {
      if ((counts.get(id) || 0) <= 0) return false;
      this.add(id, -1);
      return true;
    },

    /** Add gold. `n` may be negative; the balance floors at 0. */
    addGold(n = 0) {
      gold = Math.max(0, gold + n);
      return gold;
    },

    /**
     * Try to pay `n` gold. The check and the deduction are ONE operation on
     * purpose: a caller that did `if (gold >= n) addGold(-n)` has a window where
     * the balance is still readable between the two, and the cost is a purchase
     * that can go through twice.
     */
    spend(n) {
      if (!Number.isFinite(n) || n <= 0 || gold < n) return false;
      gold -= n;
      return true;
    },

    get gold() { return gold; },

    /** Every non-zero entry, catalogue order. What the UI renders. */
    entries() {
      const out = [];
      for (const [id, n] of counts) if (n > 0) out.push({ id, count: n, def: items[id] });
      return out;
    },

    /** Flat snapshot for the QA handle and for debugging. */
    snapshot() {
      const bag = {};
      for (const [id, n] of counts) if (n > 0) bag[id] = n;
      return { gold, items: bag };
    },
  };
}
