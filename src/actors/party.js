/**
 * party.js — owner: AGENT-ACTORS
 * The follow-leader chain and the battle formation.
 *
 * `follow` takes the LEADER'S CURRENT position (not a destination): the leader
 * is moved by the game loop and every member chases its own slot, derived from
 * that position and the leader's heading. Passing a destination here would make
 * the followers cut the corner and arrive before the leader.
 */

import { createActor } from './actor.js';
import { buildActorSheet } from './spriteFactory.js';
import { tween, Ease } from '../core/tween.js';

// The camera is pitched 40 degrees down with NO yaw (engine.js CAMERA_OFFSET is
// (0, y, z)), so screen-x is world-x and depth moves a sprite only up-screen.
// That is the whole geometry of this problem: the only way four figures read as
// four figures is for them to occupy four different world-x values, and depth
// buys separation, not distinctness.
//
// A single diagonal fails that. Spaced along one line, member i sits behind
// member i-1, so the two rear figures spend the walk hidden — measured at 52%
// worst-case box overlap. The formation is a WEDGE instead: two flankers at
// their own depth, one further back dead centre. Nothing is ever behind
// anything, which is what an eye actually reads as four people.
//
// Offsets are in world units, [lateral, depth behind]. Measured at FOV 34 on
// 1280x720: 1 lateral unit is ~47px and 1 depth unit ~31px, against a ~75px
// sprite box. So LATERAL 1.15 leaves 21px of box intersection and DEPTH 0.8
// takes another 38px off — enough to read as four, without spreading the party
// across 3 units of map, which is more arrow than convoy.
const LATERAL = 1.15;
const DEPTH_SIDE = 0.8;   // the two flankers
const DEPTH_TAIL = 2.05;  // the straggler, centred
const WEDGE = [[-1, DEPTH_SIDE], [1, DEPTH_SIDE], [0, DEPTH_TAIL]];
const FACING_VEC = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] };
const DELAY = 0.06;  // per-member startup delay
const MAX_DIST = 24;  // beyond this a member hides instead of stretching the map
const COL = 1.25;    // battle formation: half the lateral gap between columns
const ROW = 1.0;     // and half the depth gap between rows. 2.0 of depth is
                      // 1.46 world units of screen travel at this pitch, clear of
                      // the 1.6 sprite, so the near rank is not inside the far one.
const DIAMOND = [[-COL, -ROW], [COL, -ROW], [-COL, ROW], [COL, ROW]];

export function createParty({ memberIds, data, terrain, colliders = [], scene }) {
  const members = memberIds.map((id, i) => {
    const def = data[id] || {};
    const sp = def.sprite || {};
    const cell = sp.cell || 24;
    const sheet = buildActorSheet({
      kind: sp.kind || 'hero', palette: sp.palette || 'warrior', seed: i + 1, cell,
    });
    const actor = createActor({ sheet, cell, terrain, colliders, speed: 3.6, worldHeight: 1.6 });
    actor.setPosition(0, 0);                                  // valid state; game.js places the party
    actor.userData = { id, delay: i * DELAY };
    if (scene) scene.add(actor.object3D);
    return actor;
  });

  const leader = members[0];
  const chain = { x: 0, z: 0, has: false };

  const party = {
    members,
    leader,

    setVisible(v) { for (const m of members) m.setVisible(v); },

    /**
     * Call every frame with the leader's live position. Members 1..3 take the
     * three WEDGE slots on the leader's facing, and stay hidden while further
     * than MAX_DIST from it.
     */
    follow(targetX, targetZ, dt) {
      if (chain.has) {
        const mx = targetX - chain.x, mz = targetZ - chain.z;
        if (Math.hypot(mx, mz) > 1e-4) {
          // the leader's facing belongs to whoever moves it, but a caller that
          // only sets its position would leave it moonwalking — so set it here
          leader.face(Math.abs(mx) > Math.abs(mz) ? (mx > 0 ? 'right' : 'left') : (mz > 0 ? 'down' : 'up'));
        }
      }
      chain.x = targetX;
      chain.z = targetZ;
      chain.has = true;

      // The formation is built on the leader's FACING, not on its travel
      // direction. Direction is the perpendicular of travel, so it swings 180
      // the instant you walk backwards and the two flankers swap sides with a
      // visible jump; facing only changes when the turn is real. Walking
      // backwards therefore trails the party the right way round instead of
      // reshuffling it.
      // `leader.facing`, NOT `leader.state.facing`: actor.js's `get state()`
      // returns state.mode ('idle'|'walk'|'act'|'dead'), a string, so
      // `.facing` on it was always undefined and the wedge was permanently
      // pinned to `down` whatever the leader did.
      const [fx, fz] = FACING_VEC[leader.facing] || FACING_VEC.down;
      const px = -fz, pz = fx;   // left of the leader, on screen

      for (let i = 1; i < members.length; i++) {
        const m = members[i];
        // Every slot is anchored to the LEADER, not to the member in front.
        // Chaining the anchors meant one member caught on a prop dragged every
        // slot behind it off its mark, so the party lost its shape exactly where
        // it was most needed.
        const [side, depth] = WEDGE[(i - 1) % WEDGE.length];
        const tx = targetX + px * LATERAL * side - fx * depth;
        const tz = targetZ + pz * LATERAL * side - fz * depth;

        m.userData.delay -= dt;
        if (m.userData.delay <= 0) m.stepToward(tx, tz, dt);

        const far = Math.hypot(m.position.x - targetX, m.position.z - targetZ);
        m.setVisible(far <= MAX_DIST);
      }
      for (const m of members) m.update(dt);
    },

    /**
     * Battle formation — a 2x2 box, members staggered by DELAY. `setPosition`
     * goes through `heightAt`, so the ranks stand on the real ground slope and
     * not through a cliff.
     */
    enterBattleFormation(centerX, centerZ) {
      const jobs = members.map((m, i) => {
        const [ox, oz] = DIAMOND[i % DIAMOND.length];
        const sx = m.position.x, sz = m.position.z;
        const tx = centerX + ox, tz = centerZ + oz;
        m.setVisible(true);
        m.face('down');
        return tween({
          from: 0, to: 1, duration: 0.45, delay: i * DELAY, ease: Ease.cubicOut,
          onUpdate: (t) => m.setPosition(sx + (tx - sx) * t, sz + (tz - sz) * t),
        }).finished;
      });
      return Promise.all(jobs).then(() => undefined);
    },

    dispose() {
      for (const m of members) {
        if (scene) scene.remove(m.object3D);
        m.dispose();
      }
      members.length = 0;
    },
  };

  return party;
}
