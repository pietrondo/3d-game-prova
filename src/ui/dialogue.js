/**
 * src/ui/dialogue.js — owner: AGENT-UI
 *
 * Letter-by-letter dialogue box with a speaker plate and a blinking caret.
 * No Three.js, no dependencies.
 *
 * Two-stage press (the standard JRPG feel): a press while the line is still
 * typing completes it instantly; the NEXT press advances. Both a click on the
 * box and the `interact` / `confirm` keys trigger it.
 *
 * The key listener lives here, on `window`, and only acts while `isOpen` — the
 * game layer should ignore its own input while a dialogue is running.
 *
 * Timing is driven by its own timer chain, not by an `update(dt)` hook, so the
 * typing cannot be double-advanced by a caller that also ticks it. Each step
 * subtracts the time already spent so the rate does not drift.
 *
 * Exports: createDialogue
 */
export function createDialogue(root) {
  const TYPE_MS = 35;   // per character
  const KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'KeyE']);

  const node = document.createElement('div');
  node.className = 'dialogue';
  node.innerHTML =
    '<div class="dialogue-plate" hidden></div>' +
    '<p class="dialogue-text"></p>' +
    '<span class="dialogue-caret" hidden></span>';

  const plateEl = node.querySelector('.dialogue-plate');
  const textEl = node.querySelector('.dialogue-text');
  const caretEl = node.querySelector('.dialogue-caret');

  let isOpen = false;
  let lines = [];
  let index = 0;
  let shown = 0;      // characters revealed on the current line
  let typing = false;
  let timer = 0;
  let due = 0;        // timestamp the next character is owed at
  let done = null;

  function currentText() {
    return lines[index] ? lines[index].text : '';
  }

  function step() {
    const text = currentText();
    shown++;
    textEl.textContent = text.slice(0, shown);
    if (shown >= text.length) {
      typing = false;
      caretEl.hidden = false;
      return;
    }
    // `due` is the timestamp the next character is owed at. Advancing it by
    // TYPE_MS (instead of re-stamping "now") keeps the cadence exact: stamping
    // "now" made every second character fire immediately, doubling the speed.
    due += TYPE_MS;
    timer = setTimeout(step, Math.max(0, due - performance.now()));
  }

  function startTyping() {
    shown = 0;
    typing = true;
    caretEl.hidden = true;
    textEl.textContent = '';
    if (timer) clearTimeout(timer);
    due = performance.now();
    timer = setTimeout(step, TYPE_MS);
  }

  function showLine(i) {
    index = i;
    const line = lines[i] || {};
    plateEl.textContent = line.speaker || '';
    plateEl.hidden = !line.speaker;
    startTyping();
  }

  /** One press. Stage 1 completes the line, stage 2 advances. */
  function press() {
    if (!isOpen) return;
    const text = currentText();
    if (typing || shown < text.length) {
      shown = text.length;
      typing = false;
      if (timer) clearTimeout(timer);
      timer = 0;
      textEl.textContent = text;
      caretEl.hidden = false;
      return;
    }
    if (index + 1 < lines.length) showLine(index + 1);
    else close();
  }

  function onPointerDown(e) {
    // Only a primary press counts; a right-click must not skip the line.
    if (e.button !== 0) return;
    e.preventDefault();
    press();
  }

  function onKeyDown(e) {
    if (!isOpen || e.repeat || !KEYS.has(e.code)) return;
    e.preventDefault(); // space would otherwise scroll / re-trigger focused UI
    press();
  }

  function say(list) {
    // A second call while open settles the previous promise instead of leaking it.
    if (isOpen) close();
    lines = Array.isArray(list) ? list.slice() : [];
    if (lines.length === 0) {
      close();
      return Promise.resolve();
    }
    isOpen = true;
    node.hidden = false;
    showLine(0);
    return new Promise((resolve) => { done = resolve; });
  }

  function close() {
    if (timer) clearTimeout(timer);
    timer = 0;
    isOpen = false;
    typing = false;
    node.hidden = true;
    textEl.textContent = '';
    caretEl.hidden = true;
    plateEl.hidden = true;
    const resolve = done;
    done = null;
    if (resolve) resolve();
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    node.removeEventListener('pointerdown', onPointerDown);
    if (timer) clearTimeout(timer);
    timer = 0;
    isOpen = false;
    node.remove();
  }

  node.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  node.hidden = true;
  root.appendChild(node);

  return {
    get isOpen() { return isOpen; },
    say,
    close,
    dispose,
  };
}
