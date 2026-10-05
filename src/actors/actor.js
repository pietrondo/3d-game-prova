/**
 * actor.js — owner: AGENT-ACTORS
 * A pixel sprite standing on a soft blob shadow. HD-2D needs both: the sprite is
 * 2D, the shadow is what glues it to the 3D diorama and sells the depth.
 *
 * Animation never rebuilds the texture — frames are swapped by mutating
 * texture.offset, column = facing, row = frame. Row indices follow the frozen
 * FRAMES order in spriteFactory.js.
 */

import * as THREE from 'three';
import { tween, Ease } from '../core/tween.js';
import { FACINGS, FRAMES } from './spriteFactory.js';

const WALK_FRAME = 0.11;   // seconds per walk frame
const IDLE_FRAME = 0.42;   // seconds per idle frame
const TINT_GAIN = 2.6;     // SpriteMaterial.color multiplies, so >1 is what glows
const RADIUS = 0.16;       // actor radius used against prop colliders
const NEUTRAL = new THREE.Color(1, 1, 1);
const SCRATCH = new THREE.Color();
const LUNGE = 0.45;        // world units travelled by playAttack
const DIR = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/**
 * The drawn figure's tight box inside a sheet cell, as fractions of `cell`:
 * `{ h, w, cx }` — height and width filled, and the horizontal centre of the
 * ink so an off-centre figure is not assumed to sit in the middle.
 *
 * A hardcoded FIG_H was wrong by construction: it only held for the humanoids,
 * which are drawn 18 units tall in a 24-unit design grid. The Sentinel fills its
 * cell edge to edge and the slime fills barely half, so every enemy came out at
 * whatever `cell / FIG_H` happened to be — the Sentinel at 3.7 world units
 * against a party member at 1.6, which is the "giant pale spike" QA reported.
 * Reading the alpha channel makes `worldHeight` mean the same thing for every
 * sprite: the height the player SEES, not the height of the texture cell.
 *
 * `w` and `cx` exist for the same reason on the QA side: a humanoid draws about
 * half its cell width, so a quad-overlap measurement counts mostly transparent
 * padding and reports a party as a blob when it is not one.
 */
function figureBox(sheet, cell, rows) {
  // The sheet was created with a plain 2d context, so this returns that same
  // context and any attribute here would be ignored. The readback runs once per
  // actor, not per frame, so the cost does not matter.
  const ctx = sheet.getContext('2d');
  if (!ctx) return { h: 0.75, w: 0.75, cx: 0.5, cy: 0.375 };
  let top = cell, bottom = 0, left = cell, right = 0;
  // Every frame of the first facing column: the tallest pose in the cycle is
  // what has to fit inside `worldHeight`, and a walking bob is a frame taller
  // than the idle pose.
  for (let row = 0; row < rows; row++) {
    const d = ctx.getImageData(0, row * cell, cell, cell).data;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        if (d[(y * cell + x) * 4 + 3] <= 8) continue;
        if (y < top) top = y;
        if (y + 1 > bottom) bottom = y + 1;
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
      }
    }
  }
  if (bottom <= top || right <= left) return { h: 0.75, w: 0.75, cx: 0.5, cy: 0.375 };
  return {
    h: (bottom - top) / cell,
    w: (right - left) / cell,
    cx: (left + right) / 2 / cell,
    // measured from the TOP of the cell, which is the top of the sprite quad:
    // figures stand on the ground, so the ink never starts at the quad's top
    // edge and assuming it does displaces the QA box vertically.
    cy: (top + bottom) / 2 / cell,
  };
}

export function createActor({ sheet, cell = 24, worldHeight = 1.6, speed = 3.2, terrain, colliders = [], alwaysOnTop = false }) {
  const cols = Math.max(1, Math.round(sheet.width / cell));
  const rows = Math.max(1, Math.round(sheet.height / cell));

  const texture = new THREE.CanvasTexture(sheet);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;                 // NPOT sheet, and it blurs the pixels
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(1 / cols, 1 / rows);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, alphaTest: 0.4 });
  const sprite = new THREE.Sprite(material);
  // `alwaysOnTop` is for the battle ENEMY row only, and it is the same
  // treatment the dialogue markers already get (game.js: `depthTest: false`).
  // The enemy line is staged 1.4-3.0 units up-screen of the leader, which is
  // exactly the band props are scattered through, and props are merged per type
  // so no single one can be culled at runtime: without this, a pillar swallows
  // the target the player is choosing. The party leaves it OFF on purpose, so
  // it still depth-sorts and can walk behind a hill.
  if (alwaysOnTop) {
    material.depthTest = false;
    sprite.renderOrder = 4;   // above terrain (0), water (1), the sun sprite (2)
  }
  sprite.center.set(0.5, 0);                       // feet sit on the group origin
  // The quad is one full cell tall; only `fill.h` of it is the figure, so the
  // quad has to be scaled UP by 1/fill.h for the figure itself to be worldHeight.
  const fill = figureBox(sheet, cell, rows);
  const scale = worldHeight / fill.h;
  sprite.scale.set(scale, scale, 1);
  // Read-only, for the QA harness: the figure's box as a fraction of the quad.
  sprite.userData.ink = fill;

  const shadowGeo = new THREE.CircleGeometry(worldHeight * 0.3, 16);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false,
  });
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;

  const object3D = new THREE.Group();
  object3D.add(sprite, shadow);

  const position = new THREE.Vector3();
  const state = { facing: 'down', mode: 'idle' };
  let animT = 0;
  let lungeX = 0, lungeZ = 0;
  let tintHex = null;      // external, driven by setTint()
  let flash = null;        // { hex, k } internal, owned by playAttack/playHurt
  let running = null;      // in-flight tween, cancelled on dispose

  /**
   * Flash as a LERP FROM the neutral colour, never as a scale toward zero.
   *
   * The old `multiplyScalar(TINT_GAIN * k)` fell below 1 for the last ~15% of
   * every envelope, driving all three channels to 0 — a Gloom Bat rendered as
   * a black silhouette mid-battle, and playAttack's tail dimmed instead of
   * flashing. Lerping from neutral keeps every channel at or above the untinted
   * value for the whole hit, and the apex is still TINT_GAIN, so a white/gold
   * flash is unchanged where it matters and keeps feeding the bloom pass.
   */
  function applyTint() {
    if (flash && flash.k > 0) {
      const k = Math.min(1, flash.k);
      const neutral = tintHex == null
        ? NEUTRAL
        : SCRATCH.set(tintHex).multiplyScalar(TINT_GAIN);
      material.color.set(flash.hex).multiplyScalar(TINT_GAIN).lerp(neutral, 1 - k);
      return;
    }
    if (tintHex == null) material.color.setRGB(1, 1, 1);
    else material.color.set(tintHex).multiplyScalar(TINT_GAIN);
  }

  function setFrame(name) {
    const col = Math.max(0, FACINGS.indexOf(state.facing));
    const row = Math.max(0, FRAMES.indexOf(name));
    // texture V is flipped: row 0 is the top of the sheet
    texture.offset.set(col / cols, 1 - (row + 1) / rows);
  }

  function sync() {
    object3D.position.set(position.x + lungeX, position.y, position.z + lungeZ);
  }

  function canStand(x, z) {
    if (terrain && !terrain.isWalkable(x, z)) return false;
    for (const c of colliders) {
      const dx = x - c.x, dz = z - c.z, r = c.r + RADIUS;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }

  /**
   * Collide and slide. Two rules the naive version gets wrong:
   *
   * 1. An axis fallback must involve an actual displacement. The old code did
   *    `canStand(nx, position.z)` and, when the heading was purely along Z, that
   *    is the same point — so it called setPosition with the current coordinates
   *    and returned `true`. The actor reported "moved" without moving, which
   *    silently inflated the encounter distance counter and left the player
   *    welded to a prop.
   * 2. Sliding cannot help when the heading is axis-aligned — there is no
   *    perpendicular component to slide along. So a blocked heading first tries
   *    a perpendicular deflection, which is what makes the player walk *around*
   *    an obstacle instead of into it.
   */
  function slide(nx, nz) {
    const sx = position.x, sz = position.z;
    if (canStand(nx, nz)) { api.setPosition(nx, nz); return true; }

    const dx = nx - sx, dz = nz - sz;
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      const px = -dz / len, pz = dx / len;   // perpendicular to the heading
      const n = Math.min(len, 0.5);
      for (const s of [1, -1]) {
        const tx = sx + dx + px * n * s;
        const tz = sz + dz + pz * n * s;
        if (canStand(tx, tz)) { api.setPosition(tx, tz); return true; }
      }
    }
    if (Math.abs(nx - sx) > 1e-6 && canStand(nx, sz)) { api.setPosition(nx, sz); return true; }
    if (Math.abs(nz - sz) > 1e-6 && canStand(sx, nz)) { api.setPosition(sx, nz); return true; }
    return false;
  }

  const api = {
    object3D,
    position,
    get facing() { return state.facing; },
    set facing(dir) { api.face(dir); },
    get state() { return state.mode; },
    set state(v) { state.mode = v; setFrame(currentFrame()); },

    setPosition(x, z) {
      position.set(x, terrain ? terrain.heightAt(x, z) : 0, z);
      sync();
    },

    face(dir) {
      if (DIR[dir]) state.facing = dir;
      setFrame(currentFrame());
    },

    moveTo(x, z) {
      const dx = x - position.x, dz = z - position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-4) return Promise.resolve();
      api.face(Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'right' : 'left') : (dz > 0 ? 'down' : 'up'));
      const sx = position.x, sz = position.z;
      const prev = state.mode;
      state.mode = 'walk';
      running = tween({
        from: 0, to: 1, duration: Math.min(4, dist / speed), ease: Ease.linear,
        onUpdate: (t) => { slide(sx + dx * t, sz + dz * t); },
        onComplete: () => { state.mode = prev === 'act' ? 'act' : 'idle'; running = null; },
      });
      return running.finished;
    },

    stepToward(x, z, dt) {
      const dx = x - position.x, dz = z - position.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) return false;
      api.face(Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'right' : 'left') : (dz > 0 ? 'down' : 'up'));
      const step = Math.min(d, speed * dt);
      const moved = slide(position.x + (dx / d) * step, position.z + (dz / d) * step);
      state.mode = moved ? 'walk' : 'idle';
      return moved;
    },

    playAttack(duration = 0.35) {
      const [fx, fz] = DIR[state.facing];
      const prev = state.mode;
      state.mode = 'act';
      flash = { hex: 0xffffff, k: 1 };
      applyTint();
      running = tween({
        from: 0, to: 1, duration, ease: Ease.quadOut,
        onUpdate: (t) => {
          // out fast, back slow: a lunge, not a slide
          const k = Math.sin(Math.PI * t);
          lungeX = fx * LUNGE * k;
          lungeZ = fz * LUNGE * k;
          flash.k = 1 - t;
          applyTint();
          sync();
        },
        onComplete: () => {
          lungeX = lungeZ = 0;
          flash = null;
          applyTint();
          sync();
          state.mode = prev === 'dead' ? 'dead' : 'idle';
          running = null;
        },
      });
      return running.finished;
    },

    playHurt(duration = 0.25) {
      flash = { hex: 0xff2410, k: 1 };
      applyTint();
      const prev = state.mode;
      state.mode = 'act';
      running = tween({
        from: 0, to: 1, duration, ease: Ease.quadOut,
        onUpdate: (t) => { flash.k = 1 - t; applyTint(); },
        onComplete: () => {
          flash = null;
          applyTint();
          state.mode = prev === 'dead' ? 'dead' : 'idle';
          running = null;
        },
      });
      return running.finished;
    },

    setVisible(v) { object3D.visible = v; },

    /** hex colour or null. Bright hexes (gold, white) exceed 1 after the gain,
     *  so they read as a flash and feed the bloom pass; dark ones tint. */
    setTint(hexColorOrNull) {
      tintHex = hexColorOrNull == null ? null : new THREE.Color(hexColorOrNull);
      applyTint();
    },

    update(dt) {
      animT += dt;
      if (state.mode === 'dead') {
        // no 'dead' frame exists in FRAMES, so lay the sprite on its side:
        // center is (0.5, 0) so it pivots at the feet and reads as fallen
        sprite.rotation.z = -Math.PI / 2;
        setFrame('idle0');
        return;
      }
      sprite.rotation.z = 0;
      if (state.mode === 'walk') {
        setFrame(`walk${Math.floor(animT / WALK_FRAME) % 4}`);
      } else if (state.mode === 'idle') {
        setFrame(`idle${Math.floor(animT / IDLE_FRAME) % 2}`);
      }
    },

    dispose() {
      if (running) running.cancel();
      running = null;
      object3D.remove(sprite, shadow);
      object3D.parent?.remove(object3D);
      texture.dispose();
      material.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
    },
  };

  function currentFrame() {
    if (state.mode === 'walk') return `walk${Math.floor(animT / WALK_FRAME) % 4}`;
    if (state.mode === 'idle') return `idle${Math.floor(animT / IDLE_FRAME) % 2}`;
    return 'idle0';
  }

  setFrame('idle0');
  applyTint();
  return api;
}
