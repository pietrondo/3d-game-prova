/**
 * _spawncheck.mjs — does the WEDGE fit where the village chooses to spawn?
 *
 * clearSpawn clears a DISC around the leader. The party is not a disc: it is a
 * wedge that reaches 2.05 behind the leader along its facing and 1.15 to each
 * side, and it trails in the direction the leader FACES. So the real question is
 * whether the three follower slots are also clear, in both facings.
 *
 * Deleted once the spawn clears the wedge.
 */

import { createTerrain } from '../src/world/terrain.js';
import { createVillage } from '../src/world/village.js';
import TILES from '../src/data/tiles.json' with { type: 'json' };
import VILLAGE from '../src/data/village.json' with { type: 'json' };

const terrain = createTerrain({
  width: 64, depth: 64, seed: 1337, heightScale: 3.2, tiles: TILES,
  shelf: { angle: Math.PI / 2, at: 0.62, r: 7.5, feather: 2.0 },
});
const v = createVillage({ terrain, definitions: VILLAGE });
const s = v.shelf;

console.log(`shelf y=${s.y.toFixed(3)} inner=${s.inner} r=${s.r}`);
console.log(`spawn ${JSON.stringify(v.spawn)}`);

// Mirror party.js.
const LATERAL = 1.15, DEPTH_SIDE = 0.8, DEPTH_TAIL = 2.05;
const RADIUS = 0.16;   // actor.js, for collider tests

function clearance(x, z) {
  let min = Infinity;
  for (const c of v.colliders) min = Math.min(min, Math.hypot(c.x - x, c.z - z) - c.r - RADIUS);
  return min;
}

for (const [name, fx, fz] of [['down', 0, 1], ['up', 0, -1], ['left', -1, 0], ['right', 1, 0]]) {
  const px = -fz, pz = fx;
  const slots = [
    ['leader', 0, 0],
    ['left', -1, 0],
    ['right', 1, 0],
    ['tail', 0, 0],
  ];
  const pts = [];
  pts.push(['leader', v.spawn.x, v.spawn.z]);
  const W = [[-1, DEPTH_SIDE], [1, DEPTH_SIDE], [0, DEPTH_TAIL]];
  W.forEach(([side, depth], i) => {
    pts.push([`m${i + 1}`, v.spawn.x + px * LATERAL * side - fx * depth,
      v.spawn.z + pz * LATERAL * side - fz * depth]);
  });
  const worst = pts.map(([n, x, z]) => [n, +clearance(x, z).toFixed(3)]);
  const walk = pts.map(([n, x, z]) => [n, terrain.isWalkable(x, z)]);
  console.log(`facing ${name.padEnd(6)} clearance ${worst.map(([n, c]) => `${n}=${c}`).join(' ')}`
    + `  walkable ${walk.every(([, w]) => w) ? 'all' : walk.filter(([, w]) => !w).map(([n]) => n).join(',')}`);
}
