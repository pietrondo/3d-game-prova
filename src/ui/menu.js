/**
 * src/ui/menu.js — owner: AGENT-UI
 *
 * Tabs: Party | Skills | Items | System. DOM only, no Three.js.
 *
 * Optional 4th argument to `open()` — the contract signature is frozen, so this
 * is an added optional field, not a change:
 *
 *   open(members, skills, items, {
 *     renderScale,            // number, initial value of the System row
 *     onCycleRenderScale(n),  // returns the new scale; when absent a real
 *                             //   `Backquote` keydown is dispatched on window
 *                             //   so core/input.js sees the cycleRenderScale
 *                             //   action without this module owning input
 *     onQuit(),               // called by "Quit to overworld" before close()
 *     gold,                   // number, shown in the footer. This is what makes
 *                             //   items.json's `price` mean anything: before a
 *                             //   real inventory the gold was summed, toasted
 *                             //   and forgotten
 *     saveState,              // string, footer note about the slot
 *     onSave(),               // persists the game. The button is omitted when
 *                             //   absent, so a caller without a save system
 *                             //   gets no dead control
 *   })
 *
 * `items` rows take an optional `count`; when present it is rendered as `xN`, so
 * a caller with a real bag can pass what is carried instead of the whole
 * catalogue. Without it the Items tab still lists everything, which is the old
 * behaviour and is kept because it is useful before you own anything.
 *
 * Keyboard: Up/Down/Home/End move the selection, Left/Right switch tabs,
 * Enter/Space activate, Escape/Tab close. Clicking activates. Every key is
 * gated on `isOpen`, so the game layer must not also read these actions.
 *
 * `strongestWeakness` is loaded with a dynamic import so this module keeps
 * working while the combat layer is still being written; the Party tab
 * re-renders as soon as it lands.
 *
 * Exports: createMenu
 */
export function createMenu(root) {
  const TABS = ['Party', 'Skills', 'Items', 'System'];
  const RENDER_SCALES = [1, 2, 3, 4]; // mirrors core/engine.js RENDER_SCALES values
  const ACCENTS = ['#5fbf6a', '#5a9fe0', '#f0c860', '#c07ae0', '#e0805f', '#6fc9b8'];
  const KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'KeyE']);

  const node = document.createElement('div');
  node.className = 'menu';
  node.innerHTML = '<div class="menu-tabs"></div><div class="menu-panel"></div><div class="menu-foot"></div>';

  const tabsEl = node.querySelector('.menu-tabs');
  const panelEl = node.querySelector('.menu-panel');
  const footEl = node.querySelector('.menu-foot');

  let strongestWeakness = null;
  import('../combat/weaknesses.js')
    .then((m) => {
      if (typeof m.strongestWeakness === 'function') {
        strongestWeakness = m.strongestWeakness;
        if (isOpen && tab === 'Party') render();
      }
    })
    .catch(() => { /* combat layer not built yet — chips fall back to "—" */ });

  let isOpen = false;
  let tab = 'Party';
  let sel = 0;
  let scale = 2;
  let opts = {};
  let data = { members: [], skills: [], items: [] };
  let done = null;

  const list = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
  const label = (x) => (typeof x === 'string' ? x : (x && (x.name || x.id)) || '?');

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Same accent-lettered box the HUD uses, so both screens read as one set. */
  function face(name, i) {
    const f = el('div', 'hud-face');
    f.appendChild(el('span', null, (name || '?').slice(0, 2).toUpperCase()));
    f.style.setProperty('--accent', ACCENTS[i % ACCENTS.length]);
    return f;
  }

  /** A party row: face, name, HP bar, HP numbers, MP numbers, one weakness chip. */
  function partyRow(m, i, psel) {
    const row = el('div', 'menu-item is-row' + (i === psel ? ' is-sel' : ''));
    row.appendChild(face(label(m), i));
    row.appendChild(el('span', 'menu-row-name', label(m)));

    const low = m.maxHP > 0 && (m.currentHP || 0) / m.maxHP < 0.3;
    const bar = el('span', 'hud-bar');
    const fill = el('i', 'hud-fill');
    fill.style.width = Math.round((m.maxHP > 0 ? (m.currentHP || 0) / m.maxHP : 0) * 100) + '%';
    fill.style.setProperty('--fill', low ? 'var(--hp-low)' : 'var(--hp)');
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'menu-row-num', `${m.currentHP ?? 0}/${m.maxHP ?? 0}`));
    row.appendChild(el('span', 'menu-row-num', m.maxMP > 0 ? `${m.currentMP ?? 0}/${m.maxMP ?? 0}` : '—'));

    let chip = '—';
    if ((m.currentHP ?? 1) <= 0) chip = 'DOWN';
    else if (strongestWeakness) {
      const w = strongestWeakness(m);
      if (w) chip = `${String(w.element).toUpperCase()} x${w.mult}`;
    }
    row.appendChild(el('span', 'menu-chip', chip));
    return row;
  }

  function skillRow(s) {
    const row = el('div', 'menu-item is-row is-skill');
    if (typeof s === 'string') {
      row.appendChild(el('span', 'menu-row-name', s));
      return row;
    }
    row.appendChild(el('span', 'menu-row-name', label(s)));
    row.appendChild(el('span', 'menu-row-num', s.kind || ''));
    row.appendChild(el('span', 'menu-row-num', s.mp != null ? `${s.mp} MP` : ''));
    row.appendChild(el('span', 'menu-chip', String(s.element || s.weaponType || '—').toUpperCase()));
    return row;
  }

  function itemRow(it) {
    const row = el('div', 'menu-item is-row is-item');
    if (typeof it === 'string') {
      row.appendChild(el('span', 'menu-row-name', it));
      return row;
    }
    row.appendChild(el('span', 'menu-row-name', label(it)));
    // `count` is present only when the caller passed a real bag. Showing x0 for
    // an item the player does not have is a lie in a list they are reading to
    // decide what to use in a fight.
    if (it.count != null) row.appendChild(el('span', 'menu-row-num', `x${it.count}`));
    row.appendChild(el('span', 'menu-row-num', it.kind || ''));
    row.appendChild(el('span', 'menu-row-num', it.power != null ? `pow ${it.power}` : ''));
    row.appendChild(el('span', 'menu-chip', it.price != null ? `${it.price}G` : '—'));
    return row;
  }

  function cycleScale() {
    const next = RENDER_SCALES[(RENDER_SCALES.indexOf(scale) + 1) % RENDER_SCALES.length];
    if (typeof opts.onCycleRenderScale === 'function') {
      const got = opts.onCycleRenderScale(next);
      scale = typeof got === 'number' ? got : next;
    } else {
      scale = next;
      // No hook: fire the real action so core/input.js handles the cycle.
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`', bubbles: true }));
    }
    render();
  }

  function render() {
    // Selection is a single flat index across tabs + panel rows, so the panel's
    // own rows start after the four tab stops.
    const psel = sel - TABS.length;

    tabsEl.replaceChildren(...TABS.map((t) => {
      const b = el('button', 'menu-item is-tab' + (t === tab ? ' is-active' : ''), t);
      b.type = 'button';
      b.dataset.tab = t;
      return b;
    }));

    const rows = [];
    if (tab === 'Party') {
      if (!data.members.length) rows.push(el('div', 'menu-item is-note', 'No party data'));
      data.members.forEach((m, i) => rows.push(partyRow(m, i, psel)));
    } else if (tab === 'Skills') {
      const all = list(data.skills);
      if (!all.length) rows.push(el('div', 'menu-item is-note', 'No skills learned'));
      all.forEach((s) => rows.push(skillRow(s)));
    } else if (tab === 'Items') {
      const all = list(data.items);
      if (!all.length) rows.push(el('div', 'menu-item is-note', 'No items'));
      all.forEach((it) => rows.push(itemRow(it)));
    } else {
      // NOTE: never classList.add(cond ? 'x' : '') — the empty token throws a
      // SyntaxError, which used to abort render() between the tab bar and the
      // panel and leave the menu dead.
      const scaleBtn = el('button', 'menu-item' + (psel === 0 ? ' is-sel' : ''), `Render scale: ${scale}`);
      scaleBtn.type = 'button';
      scaleBtn.dataset.act = 'scale';
      rows.push(scaleBtn);
      // The Save button exists only if the caller can actually save. A button
      // that does nothing is a UX lie, and a browser that refuses localStorage
      // would give a permanent one.
      if (typeof opts.onSave === 'function') {
        const saveBtn = el('button', 'menu-item' + (psel === rows.length ? ' is-sel' : ''), 'Save game');
        saveBtn.type = 'button';
        saveBtn.dataset.act = 'act-save';
        rows.push(saveBtn);
      }
      const quit = el('button', 'menu-item' + (psel === rows.length ? ' is-sel' : ''), 'Quit to overworld');
      quit.type = 'button';
      quit.dataset.act = 'act-quit';
      rows.push(quit);
    }
    panelEl.replaceChildren(...rows);
    // The footer carries the two facts that used to exist nowhere: what you are
    // worth, and whether the game is holding your progress. It is outside the
    // panel on purpose — the panel scrolls, the footer must not.
    if (opts.gold != null || opts.saveState) {
      footEl.replaceChildren(
        el('span', 'menu-foot-gold', `${opts.gold ?? 0} G`),
        el('span', 'menu-foot-note', opts.saveState || ''),
      );
    } else footEl.textContent = '';
  }

  /** Flat list of navigable stops: the four tabs, then the panel rows. */
  function stops() {
    return [...tabsEl.children, ...panelEl.children];
  }

  function move(delta) {
    const all = stops();
    if (!all.length) return;
    sel = (sel + delta + all.length) % all.length;
    render();
    const node2 = stops()[sel];
    if (node2 && typeof node2.scrollIntoView === 'function') node2.scrollIntoView({ block: 'nearest' });
  }

  function activate(target) {
    const t = target || stops()[sel];
    if (!t) return;
    if (t.dataset.tab) {
      tab = t.dataset.tab;
      sel = 0;
      render();
      return;
    }
    if (t.dataset.act === 'scale') return cycleScale();
    if (t.dataset.act === 'act-save') {
      if (typeof opts.onSave === 'function') opts.onSave();
      // Re-render so the footer's save note reflects what just happened.
      return render();
    }
    if (t.dataset.act === 'act-quit') {
      if (typeof opts.onQuit === 'function') opts.onQuit();
      return close();
    }
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const t = e.target.closest && e.target.closest('.menu-item');
    if (!t) return;
    e.preventDefault();
    sel = stops().indexOf(t);
    render();
    if (t.dataset.tab || t.dataset.act) activate(t);
  }

  function onKeyDown(e) {
    if (!isOpen || e.repeat) return;
    const c = e.code;
    if (c === 'ArrowDown') { e.preventDefault(); return move(1); }
    if (c === 'ArrowUp') { e.preventDefault(); return move(-1); }
    if (c === 'Home') { e.preventDefault(); sel = 0; return render(); }
    if (c === 'End') { e.preventDefault(); sel = stops().length - 1; return render(); }
    if (c === 'ArrowRight' || c === 'ArrowLeft') {
      e.preventDefault();
      const i = TABS.indexOf(tab);
      tab = TABS[(i + (c === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      sel = 0;
      return render();
    }
    if (c === 'Escape' || c === 'Tab' || c === 'Backspace') { e.preventDefault(); return close(); }
    if (KEYS.has(c)) { e.preventDefault(); return activate(); }
  }

  function open(members, skills, items, options = {}) {
    if (isOpen) close();
    data = { members: members || [], skills: skills || [], items: items || [] };
    opts = options || {};
    scale = typeof opts.renderScale === 'number' ? opts.renderScale : scale;
    tab = 'Party';
    sel = 0;
    isOpen = true;
    node.hidden = false;
    render();
    return new Promise((resolve) => { done = resolve; });
  }

  function close() {
    isOpen = false;
    node.hidden = true;
    const resolve = done;
    done = null;
    if (resolve) resolve();
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    node.removeEventListener('pointerdown', onPointerDown);
    isOpen = false;
    done = null;
    node.remove();
  }

  node.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  node.hidden = true;
  root.appendChild(node);

  return {
    get isOpen() { return isOpen; },
    open,
    close,
    dispose,
  };
}
