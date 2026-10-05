/**
 * src/core/save.js — localStorage persistence.
 *
 * ## Read this before judging the scope
 *
 * `docs/design.md` §97 lists "Save/load" as out of scope. This module is the
 * thing that makes that line wrong, and it is deliberately the SMALL version:
 * one slot, JSON, no schema migrations, no version picker, no cloud. It is here
 * because a level with stages and an inventory is state worth keeping, not
 * because a save system is a feature the game was missing.
 *
 * What is worth persisting is short and should be justified individually:
 *
 *   level   — the stage pointer. Without it, a reload drops the player back at
 *             stage 0 of a level they already finished. This is the whole
 *             reason the save exists.
 *   party   — HP/MP per member. A reload that refills everyone deletes the
 *             cost of every fight the player has already had.
 *   bag     — gold and item counts. An inventory that resets on reload is not
 *             an inventory, it is a number that blinks.
 *   player  — position, so you return where you stood instead of at the spawn.
 *
 * Everything else is derived and must NOT be stored: the terrain, the props and
 * the collision set are all regenerated from MAP.seed, so storing them would
 * only create a way for a save to disagree with the world.
 *
 * ## The failure mode worth naming
 *
 * localStorage throws in private windows and when the quota is full, and it
 * holds STRINGS. A save that throws on a full disk takes the game down with it,
 * because the call sits on the interaction that triggers it. So every operation
 * is wrapped and returns a boolean: the caller toasts, the game keeps running.
 * A save that cannot be written is a missing convenience, not a crash.
 */

const KEY = 'hd2d.save.v1';
const VERSION = 1;

function storage() {
  try {
    // Private-mode Safari and some embedded webviews throw on ACCESS, not on
    // write, so the probe has to be the read too.
    const s = window.localStorage;
    const probe = '__hd2d_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * Strip the bag down to what a save file should contain. `def` (the item
 * catalogue) is dropped on purpose: it is code, not state, and a save that
 * carries its own copy of items.json will drift from the real one the first
 * time an item is rebalanced.
 */
function trimBag(bag) {
  const items = {};
  for (const { id, count } of bag.entries()) items[id] = count;
  return { gold: bag.gold, items };
}

export function createSave({ level, bag, allies, leader, partyIds, markers = [], area = null }) {
  const store = storage();

  /** Build the payload. Kept separate so the QA handle can inspect it. */
  function snapshot() {
    return {
      version: VERSION,
      at: Date.now(),
      // WHICH area. The player's (x, z) is meaningless in another area, so a save
      // without this could only ever resume into the one the game starts in.
      area: area ? area.id : null,
      level: level.snapshot(),
      player: { x: +leader.position.x.toFixed(2), z: +leader.position.z.toFixed(2) },
      party: allies.map((a) => ({
        id: a.uid, hp: a.currentHP, mp: a.currentMP, boosted: !!a.boosted,
      })),
      bag: trimBag(bag),
      // WHICH markers have been consumed. Without this a reload rebuilt every
      // marker with `used: false`, so the wreck could be looted again on every
      // load: save, reload, Continue, take the 40 gold and the three tonics,
      // repeat. The shop is what made the duplicated gold worth farming.
      markers: markers.map((m) => ({ id: m.id, used: !!m.used, visited: !!m.visited })),
    };
  }

  return {
    get available() { return !!store; },

    snapshot,

    /**
     * Write the slot. Returns false rather than throwing, for every reason:
     * no storage, quota, serialisation failure. The caller toasts.
     */
    save() {
      if (!store) return false;
      try {
        store.setItem(KEY, JSON.stringify(snapshot()));
        return true;
      } catch {
        return false;
      }
    },

    /** Read the slot, or null if there is nothing there or it is unreadable. */
    load() {
      if (!store) return null;
      let raw;
      try {
        raw = store.getItem(KEY);
      } catch {
        return null;
      }
      if (!raw) return null;
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return null;
      }
      // A version this build does not know about is not loadable. Reading it
      // anyway would apply fields the current code no longer understands.
      if (!data || data.version !== VERSION || !data.level) return null;
      return data;
    },

    /**
     * Apply a loaded payload. Every field is validated against the LIVE
     * definitions, because a save is untrusted input: it is a string in a
     * browser store that any script on the page could have written.
     *
     *   - unknown item ids are dropped by `bag.add` rather than added
     *   - HP is clamped to [0, maxHP] so a hand-edited save cannot make a
     *     character unkillable or already dead at 0 on a fresh battle
     *   - position is only used if the terrain says it is walkable
     */
    apply(data) {
      if (!data) return false;
      if (!level.restore(data.level)) return false;

      const byUid = new Map(allies.map((a) => [a.uid, a]));
      for (const p of data.party || []) {
        const a = byUid.get(p.id);
        if (!a) continue;                       // a member that no longer exists
        a.currentHP = Math.max(0, Math.min(a.maxHP, Number(p.hp) || 0));
        a.currentMP = Math.max(0, Math.min(a.maxMP, Number(p.mp) || 0));
        a.boosted = !!p.boosted;
      }

      bag.addGold((data.bag?.gold || 0) - bag.gold);   // set, not add
      for (const [id, n] of Object.entries(data.bag?.items || {})) bag.add(id, Number(n) || 0);

      // Restore which markers were consumed. A save with no `markers` field (one
      // written before this existed) simply leaves them all fresh, which is the
      // old behaviour rather than a crash.
      const byId = new Map(markers.map((m) => [m.id, m]));
      for (const s of data.markers || []) {
        const m = byId.get(s.id);
        if (!m) continue;                       // a marker a later build removed
        m.used = !!s.used;
        m.visited = !!s.visited;
      }

      return true;
    },

    /**
     * Where the player wants to stand, or null. Exposed separately from
     * `apply` because the DIRECTOR has to move the party there through
     * setPosition + followLeader, and it is the only thing that can tell
     * whether the tile is still walkable after the world is built.
     */
    positionFor(data) {
      const p = data?.player;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
      return { x: p.x, z: p.z };
    },

    /** Wipe the slot. Returns false if there was nothing to wipe. */
    clear() {
      if (!store) return false;
      try {
        store.removeItem(KEY);
        return true;
      } catch {
        return false;
      }
    },

    /** Exposed for the QA handle. */
    get key() { return KEY; },
  };
}

export { KEY as SAVE_KEY, VERSION as SAVE_VERSION };

/**
 * The area a stored save belongs to, or null.
 *
 * Read WITHOUT constructing a save instance, because boot has to choose which
 * area to BUILD before it can build the save that refers to it — the world is a
 * factory now, and the save is created from the world.
 */
export function savedAreaId() {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== VERSION) return null;
    return typeof data.area === 'string' ? data.area : null;
  } catch {
    return null;
  }
}
