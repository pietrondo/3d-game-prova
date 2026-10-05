/**
 * tests/story.test.js — the content invariants the writing has to keep.
 *
 * These are not about prose quality; they are the mechanical promises the rest of
 * the game makes about the content, and every one of them has a failure mode that
 * is invisible until a player hits it:
 *
 *   - a stage id renamed breaks the level machine's ordering
 *   - a `marker` naming an id no marker defines makes a stage unspendable, and the
 *     area unfinishable, in silence
 *   - an `anchor` naming an anchor village.json does not define drops an NPC onto
 *     the village centre (this shipped: Vell stood on the well)
 *   - a line longer than the dialogue box wraps somewhere the designer never saw
 *   - more than three lines per stage is more than a briefing
 *
 * The first objective is pinned because `tests/qa-level.py` asserts it to tell a
 * fresh game from a resumed one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel) => JSON.parse(readFileSync(new URL(`../src/data/${rel}`, import.meta.url), 'utf-8'));

const level = read('level1.json');
const markers = read('markers.json');
const village = read('village.json');

/** What the dialogue box can show without wrapping into the speaker plate. */
const MAX_LINE = 150;
const MAX_LINES = 3;

const STAGE_IDS = ['move', 'talk', 'cache', 'items', 'fight', 'sentinel', 'done'];

describe('level1.json', () => {
  it('keeps the stage ids the level machine and the harness depend on', () => {
    expect(level.stages.map((s) => s.id)).toEqual(STAGE_IDS);
  });

  it('pins the first objective, which qa-level.py uses to detect a new game', () => {
    expect(level.stages[0].goal).toBe('Muoviti con WASD');
  });

  it('gives every stage a goal and at most three lines', () => {
    for (const s of level.stages) {
      expect(s.goal, `stage ${s.id} has no goal`).toBeTruthy();
      expect((s.lines || []).length, `stage ${s.id} has too many lines`).toBeLessThanOrEqual(MAX_LINES);
      expect((s.lines || []).length, `stage ${s.id} has no lines`).toBeGreaterThan(0);
    }
  });

  it('keeps every line inside the dialogue box budget', () => {
    const all = [...(level.intro || []), ...level.stages.flatMap((s) => s.lines || [])];
    for (const l of all) {
      expect(typeof l.speaker).toBe('string');
      expect(l.text.length, `"${l.text}" is ${l.text.length} chars`).toBeLessThanOrEqual(MAX_LINE);
    }
  });

  it('spends its stages on events the machine can actually deliver', () => {
    const known = new Set(['onMove', 'onTalk', 'onBattle', 'onMenu', 'onZone']);
    for (const s of level.stages) {
      expect(known.has(s.advance), `stage ${s.id} advances on unknown "${s.advance}"`).toBe(true);
      if (s.when && s.when !== 'always') {
        expect(known.has(s.when), `stage ${s.id} is gated on unknown "${s.when}"`).toBe(true);
      }
    }
  });

  it('completes exactly once, on the last stage', () => {
    const completing = level.stages.filter((s) => s.completes);
    expect(completing).toHaveLength(1);
    expect(level.stages[level.stages.length - 1].completes).toBe(true);
  });
});

describe('markers.json', () => {
  it('names only anchors village.json defines', () => {
    const anchors = new Set(village.anchors.map((a) => a.id));
    for (const m of markers) {
      if (m.anchor != null) {
        expect(anchors.has(m.anchor), `marker ${m.id} names missing anchor ${m.anchor}`).toBe(true);
      }
    }
  });

  it('can place every marker: an anchor, or dx/dz offsets', () => {
    for (const m of markers) {
      const placable = m.anchor != null || (m.dx != null && m.dz != null);
      expect(placable, `marker ${m.id} has no anchor and no offsets`).toBe(true);
    }
  });

  it('keeps every line inside the dialogue box budget', () => {
    for (const m of markers) {
      expect((m.lines || []).length).toBeLessThanOrEqual(MAX_LINES);
      expect((m.lines || []).length).toBeGreaterThan(0);
      for (const l of m.lines || []) {
        expect(l.text.length, `marker ${m.id}: "${l.text}" is ${l.text.length} chars`)
          .toBeLessThanOrEqual(MAX_LINE);
      }
    }
  });

  it('gives a battle marker a zone the encounter table knows', () => {
    // enemies.json buckets its table by zone; a marker pointing at a zone with no
    // entry falls back to the whole table, which quietly spawns the wrong fights.
    const enemies = read('enemies.json');
    const zones = new Set(Object.values(enemies).map((e) => e.encounter?.zone).filter(Boolean));
    for (const m of markers) {
      if (m.kind === 'battle') {
        expect(m.zone, `battle marker ${m.id} has no zone`).toBeTruthy();
        expect(zones.has(m.zone), `battle marker ${m.id} uses unknown zone "${m.zone}"`).toBe(true);
      }
    }
  });
});

describe('story coherence', () => {
  it('resolves every level marker to a real marker id', () => {
    const ids = new Set(markers.map((m) => m.id));
    const wanted = level.stages.map((s) => s.marker).filter(Boolean);
    expect(wanted.length).toBeGreaterThan(0);
    for (const id of wanted) {
      expect(ids.has(id), `level1.json waits on marker "${id}", which is not defined`).toBe(true);
    }
  });

  it('gives the level stage ids a name the marker table can be matched against', () => {
    // The `items` and `move` stages are deliberately marker-less, so this is not
    // "every stage has a marker" — it is that a marker-gated stage points at a
    // marker the player can actually reach.
    const gated = level.stages.filter((s) => s.marker);
    expect(gated.map((s) => s.id)).toEqual(['talk', 'cache', 'fight', 'sentinel', 'done']);
  });
});
