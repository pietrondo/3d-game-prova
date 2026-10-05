/**
 * src/core/input.js — keyboard + Gamepad normalised into named ACTION edges.
 * See docs/contracts.md §3.
 *
 * `update()` MUST be called exactly once per frame, BEFORE anything reads
 * `pressed()` / `released()`. Edges are latched inside `update()` and stay stable
 * for the whole frame, so several consumers can read the same edge.
 *
 * `debug` has no key in the contract; it is bound to F3.
 */

export const ACTIONS = [
  'up',
  'down',
  'left',
  'right',
  'interact',
  'cancel',
  'menu',
  'sprint',
  'cycleRenderScale',
  'debug',
];

const KEY_MAP = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'interact',
  Enter: 'interact',
  NumpadEnter: 'interact',
  KeyE: 'interact',
  Escape: 'cancel',
  Backspace: 'cancel',
  Tab: 'menu',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  Backquote: 'cycleRenderScale',
  F3: 'debug',
};

const PAD_BUTTONS = {
  0: 'interact', // A / cross
  1: 'cancel', // B / circle
  5: 'sprint', // RB / R1
  9: 'menu', // Start / options
  12: 'up', // dpad up
  13: 'down',
  14: 'left',
  15: 'right',
};

const DEADZONE = 0.25;
const SWALLOW = { Tab: true, Space: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, Backquote: true };

export function createInput(target = window) {
  const keys = new Set();
  const held = new Set();
  const prev = new Set();
  const downEdges = new Set();
  const upEdges = new Set();
  const axis = { x: 0, y: 0 };
  const nav = target.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  let connected = false;

  const onKeyDown = (e) => {
    if (e.repeat) return;
    const code = e.code || e.key;
    if (SWALLOW[code]) e.preventDefault();
    keys.add(code);
  };
  const onKeyUp = (e) => keys.delete(e.code || e.key);
  const onBlur = () => keys.clear();

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  function update() {
    // Swap held -> prev, then rebuild held from the physical devices.
    prev.clear();
    for (const a of held) prev.add(a);
    held.clear();
    for (const k of keys) {
      const a = KEY_MAP[k];
      if (a) held.add(a);
    }

    connected = false;
    let px = 0;
    let py = 0;
    const pads = nav && nav.getGamepads ? nav.getGamepads() : null;
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (!pad || !pad.connected) continue;
        connected = true;
        const ax = pad.axes[0] || 0;
        const ay = pad.axes[1] || 0;
        if (Math.abs(ax) > DEADZONE) {
          px = ax;
          held.add(ax < 0 ? 'left' : 'right');
        }
        if (Math.abs(ay) > DEADZONE) {
          py = -ay; // stick up (negative Y) is forward
          held.add(ay < 0 ? 'up' : 'down');
        }
        for (const idx in PAD_BUTTONS) {
          const btn = pad.buttons[idx];
          if (btn && btn.pressed) held.add(PAD_BUTTONS[idx]);
        }
        break; // first connected pad wins
      }
    }

    downEdges.clear();
    upEdges.clear();
    for (const a of held) if (!prev.has(a)) downEdges.add(a);
    for (const a of prev) if (!held.has(a)) upEdges.add(a);

    // Sticky for the whole frame so several consumers can read the same edge.
    let kx = 0;
    let ky = 0;
    if (held.has('left')) kx -= 1;
    if (held.has('right')) kx += 1;
    if (held.has('down')) ky -= 1;
    if (held.has('up')) ky += 1;
    axis.x = px || kx;
    axis.y = py || ky;
  }

  return {
    axis,
    isDown: (action) => held.has(action),
    pressed: (action) => downEdges.has(action),
    released: (action) => upEdges.has(action),
    get gamepadConnected() {
      return connected;
    },
    update,
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      keys.clear();
      held.clear();
      prev.clear();
      downEdges.clear();
      upEdges.clear();
    },
  };
}
