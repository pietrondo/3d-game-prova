/**
 * src/ui/title.js — the start screen: Nuova partita / Continua / Salva /
 * Informazioni.
 *
 * ## Why a screen and not a boot straight into the world
 *
 * The game used to open on the intro monologue with whatever state the last
 * session left in localStorage. That is two problems in one: a returning player
 * is dropped into a story they are halfway through with no way to say "no, start
 * over", and a first-time player never learns what the game IS before being
 * asked to move. A title is where both of those get answered, and it is the only
 * place a Load button can honestly live — loading mid-game is a restart wearing
 * a hat, so it belongs where restarts belong.
 *
 * ## No Three.js, no game state
 *
 * This module owns DOM and keyboard, and nothing else. It resolves a promise
 * with an ACTION STRING ('new' | 'continue' | 'save') and lets game.js decide
 * what that means. It never touches `level`, `bag` or `save`, so it cannot get
 * out of sync with them, and it unit-tests by hand because there is nothing in
 * it that needs a world.
 *
 * ## Disabled rows are skipped, not shown-and-refused
 *
 * `Continua` with no save and `Salva` with no live session are real states, not
 * errors. They render greyed and the cursor SKIPS them, because a row you can
 * land on and confirm into nothing is a broken row — the same reasoning that
 * made the battle command list hide items with no legal target.
 *
 * ## Keyboard ownership
 *
 * The listener lives on `window` and is gated on `isOpen`, exactly like
 * menu.js. game.js keeps `mode = 'title'` while this is up, so its own
 * `input.pressed('interact')` path is inert and there is no double handling.
 *
 * Exports: createTitle
 */
export function createTitle(root, info = {}) {
  const KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'KeyE']);
  const BACK = new Set(['Escape', 'Backspace', 'Tab']);

  const node = document.createElement('div');
  node.className = 'title';
  node.hidden = true;

  const wrap = document.createElement('div');
  wrap.className = 'title-wrap';

  const nameEl = document.createElement('h1');
  nameEl.className = 'title-name';
  nameEl.textContent = info.title || '';
  const subEl = document.createElement('p');
  subEl.className = 'title-sub';
  subEl.textContent = info.subtitle || '';

  const menuEl = document.createElement('div');
  menuEl.className = 'title-menu';

  const noteEl = document.createElement('p');
  noteEl.className = 'title-note';

  wrap.append(nameEl, subEl, menuEl, noteEl);
  node.appendChild(wrap);
  root.appendChild(node);

  let isOpen = false;
  let rows = [];            // [{ id, label, note, enabled }]
  let sel = 0;
  let view = 'menu';        // 'menu' | 'info'
  let done = null;

  // ---------------------------------------------------------------- rendering ---

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Only enabled rows are stops, so the cursor cannot land on a dead row. */
  function stops() {
    return rows.map((r, i) => (r.enabled ? i : -1)).filter((i) => i >= 0);
  }

  function renderMenu() {
    view = 'menu';
    menuEl.replaceChildren(...rows.map((r, i) => {
      const row = el('button',
        'menu-item title-row'
        + (i === sel ? ' is-sel' : '')
        + (r.enabled ? '' : ' is-disabled'));
      row.type = 'button';
      row.dataset.id = r.id;
      if (!r.enabled) row.disabled = true;
      row.appendChild(el('span', 'title-row-label', r.label));
      if (r.note) row.appendChild(el('span', 'title-row-note', r.note));
      return row;
    }));
    node.replaceChildren(wrap);
  }

  function renderInfo() {
    view = 'info';
    const panel = el('div', 'title-info');
    panel.appendChild(el('h2', 'title-info-h', info.title || ''));

    for (const section of info.sections || []) {
      panel.appendChild(el('h3', 'title-info-h3', section.title));
      for (const p of section.paragraphs || []) {
        panel.appendChild(el('p', 'title-info-p', p));
      }
      if (section.keys) {
        const dl = el('dl', 'title-keys');
        for (const [k, v] of section.keys) {
          dl.appendChild(el('dt', 'title-key', k));
          dl.appendChild(el('dd', 'title-key-desc', v));
        }
        panel.appendChild(dl);
      }
    }

    const back = el('button', 'menu-item title-row is-sel', 'Indietro');
    back.type = 'button';
    back.dataset.act = 'back';
    panel.appendChild(back);
    node.replaceChildren(panel);
  }

  /** Move the cursor by `d`, skipping disabled rows. */
  function move(d) {
    const all = stops();
    if (!all.length) return;
    const at = all.indexOf(sel);
    sel = all[(at + (d > 0 ? 1 : all.length - 1)) % all.length];
    renderMenu();
  }

  function choose(id) {
    const row = rows.find((r) => r.id === id);
    if (!row || !row.enabled) return;
    close();
    const resolve = done;
    done = null;
    if (resolve) resolve(id);
  }

  // ------------------------------------------------------------------- input ---

  function onKeyDown(e) {
    if (!isOpen || e.repeat) return;
    const c = e.code;
    if (view === 'info') {
      // Any of the "confirm" or "back" keys leaves the panel; there is nothing
      // to navigate inside it.
      if (KEYS.has(c) || BACK.has(c)) {
        e.preventDefault();
        renderMenu();
      }
      return;
    }
    if (c === 'ArrowDown') { e.preventDefault(); return move(1); }
    if (c === 'ArrowUp') { e.preventDefault(); return move(-1); }
    if (KEYS.has(c)) {
      e.preventDefault();
      const row = rows[sel];
      if (!row) return;
      if (row.id === 'info') { sel = 0; return renderInfo(); }
      return choose(row.id);
    }
  }

  function onPointerDown(e) {
    if (!isOpen || e.button !== 0) return;
    const t = e.target.closest && e.target.closest('.title-row');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.act === 'back') {
      sel = 0;
      return renderMenu();
    }
    const i = rows.findIndex((r) => r.id === t.dataset.id);
    if (i < 0) return;
    sel = i;
    if (t.dataset.id === 'info') { sel = 0; return renderInfo(); }
    choose(t.dataset.id);
  }

  window.addEventListener('keydown', onKeyDown);
  node.addEventListener('pointerdown', onPointerDown);

  return {
    get isOpen() { return isOpen; },
    get view() { return view; },
    get selection() { return rows[sel] ? rows[sel].id : null; },

    /**
     * Show the title and resolve with the chosen action.
     *
     * `hasSave`     — the Continue row is enabled
     * `sessionLive` — the Save row is enabled (a world is loaded and playing)
     * `saveNote`    — one line about the slot, shown under the menu
     */
    open(state = {}) {
      if (isOpen) close();
      rows = [
        { id: 'new', label: info.menu?.new || 'Nuova partita', note: info.menu?.newNote, enabled: true },
        { id: 'continue', label: info.menu?.continue || 'Continua', note: info.menu?.continueNote, enabled: !!state.hasSave },
        { id: 'save', label: info.menu?.save || 'Salva', note: info.menu?.saveNote, enabled: !!state.sessionLive },
        { id: 'info', label: info.menu?.info || 'Informazioni', note: info.menu?.infoNote, enabled: true },
      ];
      // Land on the first ENABLED row: with no save that is Nuova partita, with
      // one it is still Nuova partita, and the cursor never starts on a dead row.
      sel = stops()[0] ?? 0;
      noteEl.textContent = state.saveNote || '';
      view = 'menu';
      isOpen = true;
      node.hidden = false;
      renderMenu();
      return new Promise((res) => { done = res; });
    },

    close() { close(); },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      node.removeEventListener('pointerdown', onPointerDown);
      if (done) { const d = done; done = null; d(null); }
      node.remove();
    },
  };

  function close() {
    isOpen = false;
    view = 'menu';
    node.hidden = true;
  }
}
