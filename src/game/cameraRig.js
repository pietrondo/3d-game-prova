/**
 * src/game/cameraRig.js — the deadzone follow.
 *
 * The camera does not sit on the leader: it does not move until the leader leaves
 * a box, and then only by the overflow. That is what stops a one-pixel walk from
 * nudging the frame, and `engine.js` lerps the rest of the way so the correction
 * is smooth rather than stepped.
 *
 * ## `terrain` and `party` are THUNKS
 *
 * Both are rebound by `enterArea`, so a captured value would keep the rig
 * measuring the leader of the area the party has already left, and focusing on
 * heights from a map that is no longer loaded. Same rule as `game/qa.js` and
 * `game/rustle.js`; see `docs/refactor-game-js.md`.
 *
 * ## Why `snapTo` exists
 *
 * A transition must put the camera on the arrival point in ONE step. Letting it
 * lerp from the previous area's coordinates would fly it across the map while the
 * fade is still up — and on a badly sized map, through the terrain.
 *
 * Exports: createCameraRig
 */
export function createCameraRig({ engine, terrain, party, deadzone, leadAhead }) {
  let focusX = 0;
  let focusZ = 0;

  /** Put the focus exactly here, no easing. Used on arrival and on a restore. */
  function snapTo(x, z) {
    focusX = x;
    focusZ = z;
  }

  /** Put the focus on the leader exactly, no easing. Used after a teleport. */
  function followLeader() {
    focusX = party().leader.position.x;
    focusZ = party().leader.position.z;
  }

  function followCamera() {
    const l = party().leader.position;
    const dx = l.x - focusX;
    const dz = l.z - focusZ;
    if (Math.abs(dx) > deadzone) focusX += (Math.abs(dx) - deadzone) * Math.sign(dx);
    if (Math.abs(dz) > deadzone) focusZ += (Math.abs(dz) - deadzone) * Math.sign(dz);
    const d = Math.hypot(dx, dz);
    // `d` is 0 whenever the leader is exactly on the focus, which is the resting
    // state — dividing first would put NaN in the camera anchor and blank the
    // whole scene. Fold lead/d into one factor so the resting case is 0 * 0.
    const k = d > 1e-4 && party().leader.state === 'walk' ? leadAhead / d : 0;
    engine.setCameraTarget(
      focusX + dx * k,
      terrain().heightAt(focusX, focusZ) + 1.4,
      focusZ + dz * k,
    );
  }

  return {
    followCamera,
    followLeader,
    snapTo,
    /** Read-only, for the QA handle and for debugging the follow. */
    get focus() { return { x: focusX, z: focusZ }; },
  };
}
