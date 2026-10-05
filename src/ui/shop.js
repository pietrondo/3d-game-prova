/**
 * src/ui/shop.js — the blacksmith's counter, buying AND selling.
 *
 * ## Why this exists
 *
 * `items.json` prices three items, battles award gold, and `inventory.spend()`
 * was called from nowhere: the economy was a number that only ever grew. The
 * blacksmith's own line promised otherwise ("portamelo e ci diamo un'occhiata" —
 * BRING it to me, which is selling), so the counter and its sell side are promises
 * the game was already making.
 *
 * ## Why it is not the battle command prompt
 *
 * `battle/commands.js` builds a one-screen list that resolves ONCE and closes on
 * the first confirm — right for choosing an action, wrong for a shop, where the
 * player trades several times, watches the gold change, and leaves when they
 * choose to. So this is its own small module: a persistent list, a live purse,
 * two sides, and a confirm that can be pressed again.
 *
 * The trade itself is NOT here. It calls `onBuy(id)` / `onSell(id)` and re-renders
 * from what those return, so the atomic operations live in `core/inventory.js`
 * where they unit-test without a DOM.
 *
 * Exports: createShop
 */
export function createShop(root, { input }) {
  const node = document.createElement('div');
  node.className = 'shop';
  node.hidden = true;

  const headEl = document.createElement('div');
  headEl.className = 'shop-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'shop-title';
  const tabsEl = document.createElement('div');
  tabsEl.className = 'shop-tabs';
  const goldEl = document.createElement('span');
  goldEl.className = 'shop-gold';
  const listEl = document.createElement('div');
  listEl.className = 'shop-list';
  const footEl = document.createElement('div');
  footEl.className = 'shop-foot';

  headEl.append(titleEl, tabsEl, goldEl);
  node.append(headEl, listEl, footEl);
  root.appendChild(node);

  const MODES = ['buy', 'sell'];
  const MODE_LABEL = { buy: 'Compra', sell: 'Vendi' };

  let isOpen = false;
  let sides = { buy: [], sell: [] };   // rows, keyed by mode
  let mode = 'buy';
  let sel = 0;
  let done = null;
  let onBuy = null;
  let onSell = null;
  let lastGold = 0;
  // Frames left in which `interact` must be ignored. See the note in open():
  // the press that closes the greeting is still queued when the counter appears.
  let grace = 0;

  const rows = () => sides[mode] || [];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render() {
    goldEl.textContent = `${lastGold} oro`;
    tabsEl.replaceChildren(...MODES.map((m) => {
      const t = el('span', 'shop-tab' + (m === mode ? ' is-active' : ''), MODE_LABEL[m]);
      return t;
    }));
    // A sell row is never unaffordable; a buy row is greyed when the purse is short.
    footEl.textContent = mode === 'buy' ? 'Invio compra · Esc esce' : 'Invio vende · Esc esce';

    listEl.replaceChildren(...rows().map((it, i) => {
      const can = mode === 'sell' || lastGold >= it.price;
      const row = el('div', 'menu-item shop-row'
        + (i === sel ? ' is-sel' : '')
        + (can ? '' : ' is-disabled'));
      row.appendChild(el('span', 'shop-row-name', it.name));
      row.appendChild(el('span', 'shop-row-note', it.note || ''));
      row.appendChild(el('span', 'shop-row-owned', it.owned > 0 ? `ne ho ${it.owned}` : ''));
      row.appendChild(el('span', 'shop-row-price', `${it.price} oro`));
      return row;
    }));
  }

  function move(d) {
    const n = rows().length;
    if (!n) return;
    sel = (sel + d + n) % n;
    render();
  }

  /** Switch sides. The cursor restarts: the two lists are different things. */
  function switchMode(next) {
    if (mode === next) return;
    mode = next;
    sel = 0;
    render();
  }

  function trade() {
    const it = rows()[sel];
    const act = mode === 'buy' ? onBuy : onSell;
    if (!it || !act) return;
    // The callback returns the fresh state, or null when the trade was refused
    // (not enough gold, nothing held, unknown id). The shop never decides.
    const next = act(it.id);
    if (next) {
      sides = { buy: next.buy, sell: next.sell };
      lastGold = next.gold;
      // The rows are REBUILT by the caller, so the array identity changes and a
      // shorter list would leave `sel` past the end: no highlight, and confirm
      // silently doing nothing. Clamp against the CURRENT side.
      sel = Math.max(0, Math.min(sel, rows().length - 1));
    }
    render();
  }

  function onPointerDown(e) {
    if (!isOpen || e.button !== 0) return;
    const tab = e.target.closest && e.target.closest('.shop-tab');
    if (tab) {
      e.preventDefault();
      return switchMode(MODES[Array.from(tabsEl.children).indexOf(tab)] || mode);
    }
    const t = e.target.closest && e.target.closest('.shop-row');
    if (!t) return;
    e.preventDefault();
    sel = Array.from(listEl.children).indexOf(t);
    if (sel < 0) return;
    render();
    trade();
  }

  function close() {
    isOpen = false;
    node.hidden = true;
    const resolve = done;
    done = null;
    if (resolve) resolve();
  }

  // Mouse only. The KEYBOARD goes through `read()`, not through a window
  // listener: core/input.js owns the edges and `frame()` calls read() once per
  // frame, exactly as battle/commands.js does. A second window keydown listener
  // here would handle the same press twice — the shop would trade two items per
  // Enter — which is the bug the two mechanisms would have hidden from each other.
  node.addEventListener('pointerdown', onPointerDown);

  return {
    get isOpen() { return isOpen; },
    get mode() { return mode; },
    get selection() { return rows()[sel] ? rows()[sel].id : null; },

    /**
     * Open the counter. Only `read()` and the DOM handlers run per frame; there is
     * no `update(dt)` on purpose, matching hud/dialogue/menu (contracts §17-19).
     */
    open({ title, buy = [], sell = [], gold, onBuy: buyFn, onSell: sellFn }) {
      if (isOpen) close();
      titleEl.textContent = title || 'Bottega';
      sides = { buy: buy.slice(), sell: sell.slice() };
      mode = 'buy';
      lastGold = gold;
      sel = 0;
      onBuy = buyFn;
      onSell = sellFn;
      isOpen = true;
      // ONE FRAME OF GRACE, and it is not paranoia. `core/input.js` latches the
      // `interact` edge once per frame and SHARES it between consumers, and
      // `dialogue.js` closes on its own window keydown listener without
      // consuming that edge. So the very press that ends the shopkeeper's
      // greeting is still queued when this runs — measured: the tonics went up
      // and 30 gold vanished on the press that opened the counter. Skipping the
      // first read() swallows exactly that one edge, because `downEdges` is
      // rebuilt every update().
      grace = 1;
      node.hidden = false;
      render();
      return new Promise((res) => { done = res; });
    },

    /** Once per frame, after input.update(). Mirrors battle/commands.js read(). */
    read() {
      if (!isOpen) return;
      if (grace > 0) {
        grace--;
        // Still allow leaving: only the CONFIRM key is suppressed, so an Escape
        // in the same press that opened the panel is not the thing that gets
        // swallowed and traps the player.
        if (input.pressed('cancel')) close();
        return;
      }
      // The keyboard path goes through here for the same reason the battle prompt
      // does: core/input.js owns the edges, and a second keydown listener on the
      // title/menu pattern would double-handle the same press.
      //
      // Left/right switch sides. They are also the movement keys, and reusing them
      // is safe BECAUSE the shop holds `mode = 'shop'`: `moveLeader` is gated on
      // the overworld, so nothing else is reading them while this is open.
      if (input.pressed('left')) switchMode('buy');
      if (input.pressed('right')) switchMode('sell');
      if (input.pressed('up')) move(-1);
      if (input.pressed('down')) move(1);
      if (input.pressed('interact')) trade();
      if (input.pressed('cancel')) close();
    },

    /** Exposed for the QA handle: what the counter is showing right now. */
    get state() {
      return {
        open: isOpen,
        mode,
        selection: rows()[sel] ? rows()[sel].id : null,
        rows: rows().map((it) => ({ id: it.id, price: it.price, owned: it.owned })),
        carry: (sides.sell || []).map((it) => ({ id: it.id, price: it.price, owned: it.owned })),
        gold: lastGold,
      };
    },

    dispose() {
      node.removeEventListener('pointerdown', onPointerDown);
      if (done) { const d = done; done = null; d(); }
      node.remove();
    },
  };
}
