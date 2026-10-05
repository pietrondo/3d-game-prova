/**
 * src/ui/hud.js — owner: AGENT-UI
 *
 * DOM HUD: party plates (name / HP / MP / BOOSTED chip), the top-centre turn
 * banner, a contextual hint band and a transient toast. No Three.js.
 *
 * Legibility contract: the render behind is upscaled from ~1/2 resolution, so
 * every plate here is an opaque block with a hard border. No blur, no
 * translucent fill, no gradient.
 *
 * Exports: createHud
 */
export function createHud(root) {
  const LOW_HP = 0.3;
  const ACCENTS = ['#5fbf6a', '#5a9fe0', '#f0c860', '#c07ae0', '#e0805f', '#6fc9b8'];

  const node = document.createElement('div');
  node.className = 'hud';
  node.innerHTML =
    '<div class="hud-party"></div>' +
    '<div class="hud-turn-hint" hidden></div>' +
    '<div class="hud-hint" hidden></div>';

  const partyEl = node.querySelector('.hud-party');
  const turnEl = node.querySelector('.hud-turn-hint');
  const hintEl = node.querySelector('.hud-hint');

  let toastEl = null;
  let toastTimer = 0;

  function makePlate() {
    const p = document.createElement('div');
    p.className = 'hud-portrait';
    p.innerHTML =
      '<div class="hud-face"><span></span></div>' +
      '<div class="hud-info">' +
        '<div class="hud-name"></div>' +
        '<div class="hud-bar"><i class="hud-fill"></i></div>' +
        '<div class="hud-bar"><i class="hud-fill"></i></div>' +
        '<div class="hud-chip" hidden>POTENZIATO</div>' +
      '</div>';
    p.ui = {
      face: p.querySelector('.hud-face'),
      initial: p.querySelector('.hud-face span'),
      name: p.querySelector('.hud-name'),
      fills: Array.from(p.querySelectorAll('.hud-fill')),
      chip: p.querySelector('.hud-chip'),
    };
    return p;
  }

  /** Integer percentages only — a fractional width softens the fill edge. */
  function setBar(fill, cur, max, colour) {
    const pct = max > 0 ? Math.max(0, Math.min(1, (cur || 0) / max)) : 0;
    fill.style.width = Math.round(pct * 100) + '%';
    fill.style.setProperty('--fill', colour);
  }

  function setParty(members = []) {
    // Rebuild only when the roster size changes; HP-only updates reuse the
    // nodes so damage ticks do not churn the DOM.
    if (partyEl.childElementCount !== members.length) {
      partyEl.replaceChildren(...members.map(makePlate));
    }
    Array.from(partyEl.children).forEach((p, i) => {
      const m = members[i] || {};
      const u = p.ui;
      const low = m.maxHP > 0 && (m.currentHP || 0) / m.maxHP < LOW_HP;
      u.face.style.setProperty('--accent', ACCENTS[i % ACCENTS.length]);
      u.initial.textContent = (m.name || '?').slice(0, 2).toUpperCase();
      u.name.textContent = m.name || '';
      setBar(u.fills[0], m.currentHP, m.maxHP, low ? 'var(--hp-low)' : 'var(--hp)');
      // The MP track is always present: hiding it for a 0-MP member made the
      // party column ragged. An empty track reads as "no resource".
      setBar(u.fills[1], m.currentMP, m.maxMP, 'var(--mp)');
      u.chip.hidden = !m.boosted;
    });
  }

  function setTurnHint(text) {
    turnEl.textContent = text || '';
    turnEl.hidden = !text;
  }

  function setHint(text) {
    hintEl.textContent = text || '';
    hintEl.hidden = !text;
  }

  function toast(text, ms = 1600) {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.remove();
    toastEl = document.createElement('div');
    toastEl.className = 'hud-toast';
    toastEl.textContent = text || '';
    node.appendChild(toastEl);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.remove();
      toastEl = null;
    }, ms);
  }

  function setVisible(v) {
    // Hides the PARTY PLATES and the hint, but NOT the toast. The shop calls this
    // to clear the screen while the player is at the counter, and a toast inside
    // a hidden subtree is a message nobody reads: "non bastano i soldi" was
    // invisible exactly when it mattered, and the only feedback a refused
    // purchase had was the gold not changing.
    node.classList.toggle('is-plates-hidden', !v);
  }

  function dispose() {
    clearTimeout(toastTimer);
    node.remove();
  }

  root.appendChild(node);

  return { setParty, setTurnHint, setHint, toast, setVisible, dispose };
}
