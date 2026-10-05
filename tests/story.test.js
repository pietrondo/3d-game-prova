/**
 * tests/story.test.js — the content invariants every area has to keep.
 *
 * These are not about prose quality; they are the mechanical promises the rest of
 * the game makes about its content, and every one has a failure mode that is
 * invisible until a player hits it:
 *
 *   - a `marker` naming an id no marker defines makes a stage unspendable, and the
 *     area unfinishable, in silence
 *   - an `anchor` naming an anchor the area does not define drops an NPC onto the
 *     village centre (this shipped: Vell stood on the well)
 *   - a battle marker's `zone` with no entry in the encounter table spawns the
 *     wrong fights instead of failing
 *   - a line longer than the dialogue box wraps somewhere the designer never saw
 *   - an exit naming an area that does not exist is a door to nowhere
 *
 * They are checked for EVERY area in the registry, so a second area is covered by
 * construction rather than by remembering to add a test. The first area's stage
 * ids are pinned because `tests/qa-level.py` reads them to tell a fresh game from
 * a resumed one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AREAS, START_AREA } from '../src/game/areas.js';

const read = (rel) => JSON.parse(readFileSync(new URL(`../src/data/${rel}`, import.meta.url), 'utf-8'));

const ITEMS = read('items.json');
const ENEMIES = read('enemies.json');
const SHOP = read('shop.json');
const ZONES = new Set(Object.values(ENEMIES).map((e) => e.encounter?.zone).filter(Boolean));

/** What the dialogue box can show without wrapping into the speaker plate. */
const MAX_LINE = 150;
const MAX_LINES = 3;
const KNOWN_EVENTS = new Set(['onMove', 'onTalk', 'onBattle', 'onMenu', 'onZone']);

const areas = Object.entries(AREAS);

describe('the area registry', () => {
  it('has a start area that exists', () => {
    expect(AREAS[START_AREA], `START_AREA "${START_AREA}" is not in the registry`).toBeTruthy();
  });

  it('gives every area an id matching its key', () => {
    for (const [key, def] of areas) {
      expect(def.id, `area "${key}" has id "${def.id}"`).toBe(key);
    }
  });

  it('points every exit marker at an area that exists', () => {
    // The destination lives on the MARKER, not in the registry: one source of
    // truth. A door to an area nobody defined is a door to nowhere, and it fails
    // in silence at the moment the player walks through it.
    let exits = 0;
    for (const [key, def] of areas) {
      for (const m of def.markers) {
        if (m.kind !== 'exit') continue;
        exits++;
        expect(typeof m.to, `${key}: exit "${m.id}" has no destination`).toBe('string');
        expect(AREAS[m.to], `${key}: exit "${m.id}" goes to "${m.to}", which does not exist`).toBeTruthy();
        expect(m.to, `${key}: exit "${m.id}" goes to its own area`).not.toBe(key);
      }
    }
    expect(exits, 'no exit marker anywhere: the second area is unreachable').toBeGreaterThan(0);
  });

  it('gives every area that is not the start a way out', () => {
    // A place you can enter and not leave is a trap, and the cheapest way to find
    // that out is a test rather than a player.
    for (const [key, def] of areas) {
      if (key === START_AREA) continue;
      const outs = def.markers.filter((m) => m.kind === 'exit');
      expect(outs.length, `${key} has no way out`).toBeGreaterThan(0);
    }
  });
});

describe.each(areas)('area %s', (_key, def) => {
  const markers = def.markers;
  const level = def.level;
  const village = def.village;

  it('can place every marker: an anchor, or dx/dz offsets', () => {
    for (const m of markers) {
      const placable = m.anchor != null || (m.dx != null && m.dz != null);
      expect(placable, `marker ${m.id} has no anchor and no offsets`).toBe(true);
    }
  });

  it('names only anchors the area defines', () => {
    const anchors = new Set(village.anchors.map((a) => a.id));
    for (const m of markers) {
      if (m.anchor != null) {
        expect(anchors.has(m.anchor), `marker ${m.id} names missing anchor ${m.anchor}`).toBe(true);
      }
    }
  });

  it('keeps every marker line inside the dialogue box budget', () => {
    for (const m of markers) {
      expect((m.lines || []).length, `marker ${m.id} has no lines`).toBeGreaterThan(0);
      expect((m.lines || []).length, `marker ${m.id} has too many lines`).toBeLessThanOrEqual(MAX_LINES);
      for (const l of m.lines || []) {
        expect(l.text.length, `marker ${m.id}: "${l.text}" is ${l.text.length} chars`)
          .toBeLessThanOrEqual(MAX_LINE);
      }
    }
  });

  it('gives every battle marker a zone the encounter table knows', () => {
    // enemies.json buckets its table by zone; a marker pointing at a zone with no
    // entry falls back to the whole table, which quietly spawns the wrong fights.
    // The two lists must agree — that is the check, not a runtime guard.
    for (const m of markers) {
      if (m.kind === 'battle') {
        expect(m.zone, `battle marker ${m.id} has no zone`).toBeTruthy();
        expect(ZONES.has(m.zone), `battle marker ${m.id} uses unknown zone "${m.zone}"`).toBe(true);
      }
    }
  });

  it('resolves every marker the level waits on to a real marker id', () => {
    const ids = new Set(markers.map((m) => m.id));
    const wanted = level.stages.map((s) => s.marker).filter(Boolean);
    expect(wanted.length).toBeGreaterThan(0);
    for (const id of wanted) {
      expect(ids.has(id), `level waits on marker "${id}", which is not defined`).toBe(true);
    }
  });

  it('gives every level stage a goal, a few lines, and a known event', () => {
    for (const s of level.stages) {
      expect(s.goal, `stage ${s.id} has no goal`).toBeTruthy();
      expect((s.lines || []).length, `stage ${s.id} has no lines`).toBeGreaterThan(0);
      expect((s.lines || []).length, `stage ${s.id} has too many lines`).toBeLessThanOrEqual(MAX_LINES);
      expect(KNOWN_EVENTS.has(s.advance), `stage ${s.id} advances on unknown "${s.advance}"`).toBe(true);
      if (s.when && s.when !== 'always') {
        expect(KNOWN_EVENTS.has(s.when), `stage ${s.id} is gated on unknown "${s.when}"`).toBe(true);
      }
    }
  });

  it('keeps every level line inside the budget, and completes exactly once, last', () => {
    const all = [...(level.intro || []), ...level.stages.flatMap((s) => s.lines || [])];
    for (const l of all) {
      expect(typeof l.speaker).toBe('string');
      expect(l.text.length, `"${l.text}" is ${l.text.length} chars`).toBeLessThanOrEqual(MAX_LINE);
    }
    const completing = level.stages.filter((s) => s.completes);
    expect(completing).toHaveLength(1);
    expect(level.stages[level.stages.length - 1].completes).toBe(true);
  });
});

describe('the shared catalogue', () => {
  it('gives every item a whole, positive price', () => {
    // The inventory charges with Number.isInteger, so a price that is a string or
    // a fraction makes the item silently unbuyable rather than exploitable. That
    // is a DATA bug, and it belongs here, where it fails loudly, rather than at
    // the counter where it looks like the shop is broken.
    for (const [id, def] of Object.entries(ITEMS)) {
      expect(Number.isInteger(def.price), `item ${id} has price ${JSON.stringify(def.price)}`).toBe(true);
      expect(def.price, `item ${id} is priced at ${def.price}`).toBeGreaterThan(0);
    }
  });

  it('stocks the shop with items that exist, and nothing else', () => {
    expect(Array.isArray(SHOP.stock)).toBe(true);
    expect(SHOP.stock.length).toBeGreaterThan(0);
    for (const id of SHOP.stock) {
      expect(ITEMS[id], `shop.json stocks "${id}", which items.json does not define`).toBeTruthy();
    }
  });
});

describe('the first area', () => {
  it('keeps the stage ids and the opening objective the harness depends on', () => {
    const def = AREAS[START_AREA];
    expect(def.level.stages.map((s) => s.id)).toEqual([
      'move', 'talk', 'cache', 'items', 'fight', 'sentinel', 'done',
    ]);
    expect(def.level.stages[0].goal).toBe('Muoviti con WASD');
  });
});
