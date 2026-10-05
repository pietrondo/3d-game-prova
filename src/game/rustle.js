/**
 * src/game/rustle.js — the grass-rustle set, and the "Octopath beat".
 *
 * When a wander roll succeeds the grass around the party pops a beat before the
 * screen goes black. `contracts.md` §21 asks for it and it is the single moment
 * that makes the game read as Octopath rather than as a Three.js demo, so it gets
 * a file of its own instead of living in the middle of the director.
 *
 * ## Why `terrain` arrives per CALL and not at construction
 *
 * The area is rebuilt on every transition, so a `terrain` captured here would
 * keep describing the island after the party has climbed the plateau — and the
 * tufts would be planted at the wrong heights, in silence. This is the same trap
 * `docs/refactor-game-js.md` names for the QA handle: **pass thunks or pass per
 * call, never capture a rebindable value**.
 *
 * `rng` is captured, because it is `Math.random` for the life of the page and
 * cannot go stale.
 *
 * Exports: createRustle
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { tween, wait, Ease } from '../core/tween.js';

// Eighteen at 1.9x in a 3-unit ring. Measured: ten at 1.5x is invisible at the
// camera distance the game actually uses.
const COUNT = 18;
const POP = 1.9;
const NEAR = 0.9;
const SPREAD = 2.1;

export function createRustle({ engine, def, seconds = 0.4, rng = Math.random }) {
  // One shared geometry and material for the whole set: eighteen meshes, one
  // draw call's worth of description, and the tufts are never seen for longer
  // than a beat.
  const blades = [];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.BoxGeometry(0.07, def.height, 0.07);
    b.rotateZ((i - 1) * 0.24);
    b.rotateY((i / 3) * Math.PI);
    b.translate(0, def.height / 2, 0);
    blades.push(b.toNonIndexed());
  }
  const geo = mergeGeometries(blades, false);
  blades.forEach((b) => b.dispose());
  const mat = new THREE.MeshStandardMaterial({ color: def.color, flatShading: true, roughness: 1 });

  const group = new THREE.Group();
  group.name = 'rustle';
  const list = [];
  for (let i = 0; i < COUNT; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    group.add(m);
    list.push(m);
  }
  engine.scene.add(group);

  /**
   * One tween per tuft drives scale, roll and lift together. A pure scale pop
   * reads as GROWTH; the decaying roll is what makes it read as a shake.
   *
   * Returns a promise that resolves when the beat is over, so the caller can
   * sequence it against the fade instead of guessing a duration.
   */
  function rustle(x, z, terrain) {
    const n = list.length;
    list.forEach((m, i) => {
      const a = (i / n) * Math.PI * 2 + rng() * 0.5;
      const r = NEAR + rng() * SPREAD;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const baseY = terrain.heightAt(px, pz) - 0.05;
      m.position.set(px, baseY, pz);
      m.rotation.set(0, rng() * Math.PI, 0);
      m.visible = terrain.isWalkable(px, pz);
      const phase = rng() * 6.28;
      m.scale.setScalar(0.01);
      tween({
        duration: seconds, delay: i * 0.012, ease: Ease.linear,
        onUpdate: (t) => {
          const pop = t < 0.28 ? Ease.backOut(t / 0.28) : 1 - 0.24 * ((t - 0.28) / 0.72);
          const s = POP * pop;
          const wob = Math.sin(t * 34 + phase) * 0.2 * (1 - t);
          m.scale.set(s, s, s);
          m.rotation.z = wob;
          m.position.y = baseY + Math.abs(wob) * 0.5;
        },
        onComplete: () => { m.visible = false; m.rotation.z = 0; },
      });
    });
    return wait(seconds);
  }

  function dispose() {
    engine.scene.remove(group);
    group.clear();
    list.length = 0;
    geo.dispose();
    mat.dispose();
  }

  return { rustle, dispose, get count() { return list.length; } };
}
