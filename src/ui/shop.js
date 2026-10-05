/**
 * src/ui/shop.js — the blacksmith's counter.
 *
 * ## Why this exists
 *
 * `items.json` prices three items, battles award gold, and `inventory.spend()`
 * was called from nowhere: the economy was a number that only ever grew. The
 * blacksmith's own line promised otherwise ("portamelo e ci diamo un'occhiata"),
 * so the missing counter was a promise the game was already making.
 *
 * ## Why it is not the battle command prompt
 *
 * `battle/commands.js` builds a one-screen list that resolves ONCE and closes on
 * the first confirm — right for choosing an action, wrong for a shop, where the
 * player buys several things, watches the gold change, and leaves when they
 * choose to. So this is its own small module: a persistent list, a live purse,
 * and a confirm that can be pressed again.
 *
 * The purchase itself is NOT here. It calls `onBuy(id)` and re-renders from what
 * that returns, so the atomic spend-and-deliver lives in `core/inventory.js`
 * where it can be unit-tested without a DOM.
 *
 * Exports: createShop
 */
export function createShop(root, { input }) {
  const node = document.createElement('div');
  node.className = 'shop';
  node.hidden = true;

  const headEl = document.createElement('div');
  headEl.className = 'shop-head';
  const goldEl = document.createElement('span');
  goldEl.className = 'shop-gold';
  const titleEl = document.createElement('span');
  titleEl.className = 'shop-title';
  const listEl = document.createElement('div');
  listEl.className = 'shop-list';
  const footEl = document.createElement('div');
  footEl.className = 'shop-foot';

  headEl.append(titleEl, goldEl);
  node.append(headEl, listEl, footEl);
  root.appendChild(node);

  let isOpen = false;
  let stock = [];       // [{ id, name, price, owned, note }]
  let sel = 0;
  let done = null;
  let onBuy = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render(gold) {
    goldEl.textContent = `${gold} oro`;
    footEl.textContent = 'Invio compra · Esc esce';
    listEl.replaceChildren(...stock.map((it, i) => {
      const can = gold >= it.price;
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
    const n = stock.length;
    if (!n) return;
    sel = (sel + d + n) % n;
    render(lastGold);
  }

  function confirm() {
    const it = stock[sel];
    if (!it || !onBuy) return;
    // `onBuy` returns the fresh state, or null when the purchase was refused
    // (not enough gold, unknown item). The shop never decides either way.
    const next = onBuy(it.id);
    if (next) {
      stock = next.stock;
      lastGold = next.gold;
    }
    render(lastGold);
  }

  let lastGold = 0;

  function onPointerDown(e) {
    if (!isOpen || e.button !== 0) return;
    const t = e.target.closest && e.target.closest('.shop-row');
    if (!t) return;
    e.preventDefault();
    sel = Array.from(listEl.children).indexOf(t);
    if (sel < 0) return;
    render(lastGold);
    confirm();
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
  // here would handle the same press twice — the shop would buy two items per
  // Enter — which is the bug the two mechanisms would have hidden from each other.
  node.addEventListener('pointerdown', onPointerDown);

  return {
    get isOpen() { return isOpen; },
    get selection() { return stock[sel] ? stock[sel].id : null; },

    /**
     * Open the counter. Only `read()` and the DOM handlers run per frame; there is
     * no `update(dt)` on purpose, matching hud/dialogue/menu (contracts §17-19).
     */
    open({ title, stock: items, gold, onBuy: buy }) {
      if (isOpen) close();
      titleEl.textContent = title || 'Bottega';
      stock = items.slice();
      lastGold = gold;
      sel = 0;
      onBuy = buy;
      isOpen = true;
      node.hidden = false;
      render(gold);
      return new Promise((res) => { done = res; });
    },

    /** Once per frame, after input.update(). Mirrors battle/commands.js read(). */
    read() {
      if (!isOpen) return;
      // The keyboard path goes through here for the same reason the battle prompt
      // does: core/input.js owns the edges, and a second keydown listener on the
      // title/menu pattern would double-handle the same press.
      if (input.pressed('up')) move(-1);
      if (input.pressed('down')) move(1);
      if (input.pressed('interact')) confirm();
      if (input.pressed('cancel')) close();
    },

    /** Exposed for the QA handle: what the counter is showing right now. */
    get state() {
      return {
        open: isOpen,
        selection: stock[sel] ? stock[sel].id : null,
        rows: stock.map((it) => ({ id: it.id, price: it.price, owned: it.owned })),
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
