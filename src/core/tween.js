/**
 * src/core/tween.js — pure animation driver. No Three.js, no DOM, unit-testable in Node.
 * See docs/contracts.md §4.
 *
 * Deviation from the contract (additive only, documented per the contract's escape hatch):
 *   the handle returned by `tween()` also exposes `cancelled: boolean`, so `sequence()`
 *   can stop early instead of running the remaining steps after a `cancel()`.
 *
 * Monotonic eases (safe to assert f(0)=0, f(1)=1 and non-decreasing):
 *   linear, quadIn, quadOut, quadInOut, cubicOut, cubicInOut.
 *   Deliberately NON-monotonic — do NOT assert monotonicity on these:
 *   backOut, backIn (overshoot past the target), elasticOut (oscillates),
 *   bounceOut (arcs back down between bounces; its first arc already reaches
 *   ~1.0 at t=0.36, which is the classic easings.net shape).
 *   All ten are exact at t=0 and t=1, so f(0)===0 / f(1)===1 holds for every one.
 */

const BACK_S = 1.70158;

export const Ease = {
  linear: (t) => t,
  quadIn: (t) => t * t,
  quadOut: (t) => t * (2 - t),
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  cubicOut: (t) => 1 - (1 - t) ** 3,
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  // endpoints guarded so f(0) is exactly 0, not 2.2e-16 from the coefficient sum
  backOut: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 + (t - 1) ** 2 * ((BACK_S + 1) * (t - 1) + BACK_S)),
  backIn: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * ((BACK_S + 1) * t - BACK_S)),
  elasticOut: (t) =>
    t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
  bounceOut: (t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

const STEP_MS = 16;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const active = new Set();
const tickers = new Set();
let timer = null;
let last = 0;

function finish(rec, complete) {
  if (rec.done) return;
  rec.done = true;
  active.delete(rec);
  if (complete) {
    if (rec.onUpdate) rec.onUpdate(rec.to); // always land exactly on `to`
    if (rec.onComplete) rec.onComplete();
  }
  rec.resolve();
}

function pump() {
  const t = now();
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;

  for (const rec of Array.from(active)) {
    if (rec.done) continue;
    rec.elapsed += dt;
    if (rec.elapsed < rec.delay) continue;
    const k = rec.duration === 0 ? 1 : Math.min(1, (rec.elapsed - rec.delay) / rec.duration);
    if (rec.onUpdate) rec.onUpdate(rec.from + (rec.to - rec.from) * rec.ease(k));
    if (k >= 1) finish(rec, true);
  }

  for (const tk of Array.from(tickers)) {
    if (tk.stopped) continue;
    tk.elapsed += dt;
    tk.fn(dt, tk.elapsed);
  }

  if (active.size === 0 && tickers.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** One shared interval, started lazily and cleared when nothing is animating. */
function ensureDriver() {
  if (timer !== null) return;
  last = now();
  timer = setInterval(pump, STEP_MS);
}

/**
 * @returns {{ cancel(): void, finished: Promise<void>, cancelled: boolean }}
 */
export function tween({
  from = 0,
  to = 1,
  duration = 0.3,
  delay = 0,
  ease = Ease.linear,
  onUpdate,
  onComplete,
} = {}) {
  const rec = {
    from,
    to,
    duration: Math.max(0, duration),
    delay: Math.max(0, delay),
    ease: ease || Ease.linear,
    onUpdate,
    onComplete,
    elapsed: 0,
    done: false,
    cancelled: false,
    resolve: null,
  };
  const finished = new Promise((resolve) => {
    rec.resolve = resolve;
  });

  active.add(rec);
  ensureDriver();

  return {
    cancel() {
      if (rec.done) return;
      rec.cancelled = true;
      finish(rec, false); // `finished` still resolves — a cancel must never hang a caller
    },
    finished,
    get cancelled() {
      return rec.cancelled;
    },
  };
}

export function wait(seconds) {
  return tween({ from: 0, to: 0, duration: Math.max(0, seconds) || 0 }).finished;
}

/**
 * steps: [{ wait: 0.2 }, { tween: {...} }, { call: fn }] — a step may combine the keys.
 * `step.tween` accepts EITHER a tween spec or a live handle from `tween()`. Pass a
 * handle when you need to be able to `cancel()` it: a cancelled step resolves
 * `finished` and the sequence stops there instead of running the remaining steps.
 */
export function sequence(steps) {
  return (async () => {
    for (const step of steps || []) {
      if (!step) continue;
      if (step.wait !== undefined) await wait(step.wait);
      if (step.tween) {
        const handle = typeof step.tween.cancel === 'function' ? step.tween : tween(step.tween);
        await handle.finished;
        if (handle.cancelled) return;
      }
      if (step.call) step.call();
    }
  })();
}

/** fn(dt, elapsed), called immediately and on every driver tick. */
export function ticker(fn) {
  const tk = { fn, elapsed: 0, stopped: false };
  tickers.add(tk);
  ensureDriver();
  return {
    stop() {
      tk.stopped = true;
      tickers.delete(tk);
    },
  };
}
