/**
 * src/game/area.js — one playable area's WORLD, built from a definition.
 *
 * Everything that a fresh world needs and nothing about how the game runs: sky,
 * terrain, the terrace, the village, the prop scatter, the collider set, and a
 * spawn cleared against it. The director reads this and drives it; it does not
 * know which area it is holding.
 *
 * ## Why this is a function and not just code in the director
 *
 * The world used to be constructed inline in `game.js`, which is now 1100 lines
 * against a 600-line rule and could not hold a second area anyway. An area is a
 * THING THAT CAN BE BUILT AND THROWN AWAY — that is what makes a transition
 * possible — so it is a factory with a `dispose`, exactly like every other
 * resource holder in the project.
 *
 * ## What is deliberately NOT here
 *
 * The party, the markers and the level. The party is the player, not the world,
 * and it must survive a transition; the markers are built from the village
 * anchors the director already holds; the level is progression, not geometry.
 */
import * as THREE from 'three';
import { createSky } from '../world/sky.js';
import { createTerrain } from '../world/terrain.js';
import { createProps } from '../world/props.js';
import { createVillage } from '../world/village.js';

// sky.js authors its lights in three.js physical units. Measured off the
// framebuffer, a 2.1 sun + 0.8 hemi lands the whole island between luminance 30
// and 110 out of 255 — it reads as night, not as a sunlit diorama, and the dark
// albedos never recover. contracts.md §7 hands `lights` to the game layer
// precisely so the director can balance them.
const SUN_INTENSITY = 3.7;
const HEMI_INTENSITY = 1.55;

export function createArea({ engine, def }) {
  const sunDir = new THREE.Vector3(...def.sunDir).normalize();
  const sky = createSky({ mapSize: def.map.width, sunDir });
  sky.lights.sun.intensity = SUN_INTENSITY;
  sky.lights.hemi.intensity = HEMI_INTENSITY;

  const terrain = createTerrain({ ...def.map, tiles: def.tiles, shelf: def.villageSite });
  // The village is built BEFORE the props scatter, so the scatter can be told to
  // leave the terrace alone. A pine through a roof is the same defect as a pine
  // in front of the party: the world was generated without knowing the building
  // was going to be there.
  const village = createVillage({ terrain, definitions: def.village, scene: engine.scene });

  /**
   * Where a marker stands, resolved against the village. `anchor` takes a named
   * spot from the area's village file; `dx`/`dz` are offsets from its centre.
   * Both are world space by the time this returns, so nothing downstream needs to
   * know the village exists.
   */
  function markerSpot(m) {
    if (m.anchor) {
      const a = village.anchors.find((x) => x.id === m.anchor);
      if (a) return { x: a.x, z: a.z };
      // A marker naming an anchor that does not exist used to fall through to the
      // village centre SILENTLY, which put Vell — the NPC two level stages gate on
      // — on top of the well while her intended anchor sat unused. Loud, and still
      // survivable: the fallback keeps the game playable.
      console.error(`[hd2d] marker "${m.id}" wants anchor "${m.anchor}", which the area does not define`);
    }
    const c = village.centre || def.spawn;
    return { x: c.x + (m.dx || 0), z: c.z + (m.dz || 0) };
  }

  /** Inside the village the wilderness does not roll encounters. */
  const inVillage = (p) =>
    !!village.centre
    && Math.hypot(p.x - village.centre.x, p.z - village.centre.z) <= (village.safeRadius || 0);

  const villageSolid = [
    { x: village.centre?.x ?? def.spawn.x, z: village.centre?.z ?? def.spawn.z, r: (village.radius || 0) + 1.5 },
  ];
  // Nothing solid inside `keepOut` units of the spawn, the village or a marker.
  // Two reasons, both measured: a 2.4-unit pine in front of the party is a
  // rendering defect the moment the HUD is up, and the follow chain's slots are
  // anchored to the leader, so a collider sitting on a slot makes that member
  // slide off it forever. On seed 11 that was 3 of 3 follower slots in a collider.
  const keepOut = [def.spawn, ...villageSolid, ...def.markers.map(markerSpot)]
    .map((p) => ({ x: p.x, z: p.z, r: Math.max(def.keepOut, p.r || 0) }));
  const props = createProps({
    terrain, definitions: def.props, density: def.density, seed: def.propSeed,
    keepOut, maxCount: def.maxCount,
  });
  engine.scene.add(sky.group, terrain.group, props.group);

  // Both colliders, and the village's own first: a building is a much larger
  // obstacle than a trunk and the player hits it far more often.
  const colliders = [...village.colliders, ...props.colliders];

  /**
   * Spawn with prop clearance. A solid prop pushes a collider and actor.js slides
   * off them, so starting INSIDE one leaves the leader wedged with three of the
   * four directions refused and the game reads as "the controls do not work".
   */
  function clearSpot(x, z, against = colliders) {
    for (let ring = 0; ring <= 4; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const px = x + dx * 0.5;
          const pz = z + dz * 0.5;
          if (!terrain.isWalkable(px, pz)) continue;
          if (against.some((c) => Math.hypot(c.x - px, c.z - pz) < c.r + 0.55)) continue;
          return { x: px, z: pz };
        }
      }
    }
    return { x, z };
  }

  // The village terrace is walkable, but the well and the houses are not, so the
  // spawn still goes through the clearance search.
  const spawn = clearSpot(village.spawn?.x ?? def.spawn.x, village.spawn?.z ?? def.spawn.z);

  function dispose() {
    engine.scene.remove(sky.group, terrain.group, props.group);
    village.dispose();
    props.dispose();
    terrain.dispose();
    sky.dispose();
  }

  return {
    def,
    id: def.id,
    name: def.name,
    sky, terrain, village, props,
    colliders,
    spawn,
    markerSpot,
    inVillage,
    clearSpot,
    dispose,
  };
}
