/**
 * Turn order. Pure — no Three.js, no DOM.
 *
 * The HUD timeline is built once per battle from `buildTimeline`, then walked
 * with `nextTurn`. `roll` is the effective initiative that the sort used; it is
 * an extra field beyond the contract type and the renderer may draw it.
 */

/**
 * @param {object[]} allies
 * @param {object[]} enemies
 * @param {() => number} [rng]
 * @returns {{ uid:string, side:'ally'|'enemy', index:number, name:string,
 *             speed:number, roll:number }[]}
 */
export function buildTimeline(allies, enemies, rng = Math.random) {
  const rows = [];
  (allies ?? []).forEach((c, i) => rows.push(entry(c, 'ally', i, rng)));
  (enemies ?? []).forEach((c, i) => rows.push(entry(c, 'enemy', i, rng)));

  // Array#sort is stable (ES2019+), so equal rolls keep allies-then-enemies order
  // and the whole timeline stays deterministic for a given rng sequence.
  return rows.sort((a, b) => b.roll - a.roll);
}

function entry(c, side, index, rng) {
  const speed = c.speed ?? 0;
  return { uid: c.uid, side, index, name: c.name, speed, roll: speed * (0.9 + rng() * 0.2) };
}

/** `alive` may be a Set, a Map, a plain object keyed by uid, a predicate, or
 *  omitted (everything alive). Accepting all of them keeps the caller from
 *  having to guess which shape this wants. */
function isAlive(alive, uid) {
  if (alive == null) return true;
  if (typeof alive === 'function') return !!alive(uid);
  if (typeof alive.has === 'function') return alive.has(uid);
  return !!alive[uid];
}

/**
 * Next timeline index that belongs to a living combatant, scanning forward from
 * `currentIndex + 1` and wrapping once. Returns -1 when nobody is alive.
 */
export function nextTurn(timeline, currentIndex, alive) {
  const n = timeline?.length ?? 0;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step++) {
    const i = (((currentIndex + step) % n) + n) % n;
    if (isAlive(alive, timeline[i].uid)) return i;
  }
  return -1;
}
