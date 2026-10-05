/**
 * src/main.js — owner: AGENT-INTEGRATION. Thin (contracts.md §23).
 *
 * Wires the canvas and `#ui-root`, surfaces any boot failure into `#boot` so a
 * broken module is visible instead of a silent black screen, and removes `#boot`
 * once `game.start()` resolves. The resize listener lives in game.js because it
 * is the engine's, not the page's.
 */

import { createGame } from './game.js';

const boot = document.getElementById('boot');
const canvas = document.getElementById('viewport');
const uiRoot = document.getElementById('ui-root');

function fail(err) {
  console.error('[hd2d] boot failed', err);
  if (!boot) return;
  boot.hidden = false;
  boot.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = `Failed to start: ${err && err.message ? err.message : err}`;
  p.style.cssText = 'color:#d4553f;max-width:70ch;text-align:center;line-height:1.5';
  boot.appendChild(p);
}

if (!canvas || !uiRoot) {
  fail(new Error('index.html is missing #viewport or #ui-root'));
} else {
  createGame({ canvas, uiRoot })
    .then((game) => game.start())
    .then(() => { if (boot) boot.remove(); })
    .catch(fail);
}
