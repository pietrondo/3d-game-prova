/**
 * tests/level.test.js — the level machine and the inventory.
 *
 * Both are pure on purpose: no Three.js, no DOM, no localStorage. The tutorial
 * is the code most likely to break silently (a stage that never fires leaves the
 * player with no objective and nothing throws), so its ordering is pinned here
 * rather than discovered by walking around an island.
 */

import { describe, it, expect } from 'vitest';
import { createLevel, EVENTS } from '../src/core/level.js';
import { createInventory } from '../src/core/inventory.js';

const AREA = {
  id: 'test',
  stages: [
    { id: 'a', when: 'always', advance: 'onMove', goal: 'walk' },
    { id: 'b', when: 'onMove', advance: 'onTalk', goal: 'talk' },
    { id: 'c', when: 'onTalk', advance: 'onBattle', goal: 'fight' },
    { id: 'd', when: 'onBattle', advance: 'onBattle', goal: 'boss' },
    { id: 'e', when: 'onBattle', advance: 'onTalk', goal: 'return', completes: true },
  ],
};

describe('level machine', () => {
  it('starts ON the first stage, not before it', () => {
    // Regression: the machine used to start at index -1 with `at()` returning
    // null, so the first advance() was silently dropped and the level never
    // moved. The opening monologue belongs to the director, not to the index.
    const lv = createLevel(AREA);
    expect(lv.index).toBe(0);
    expect(lv.objective).toBe('walk');
    expect(lv.isComplete).toBe(false);
  });

  it('an event nothing is waiting for does not advance', () => {
    const lv = createLevel(AREA);
    // The first stage is spent by onMove; a battle must be inert.
    expect(lv.canAdvance(EVENTS.BATTLE)).toBe(false);
    expect(lv.advance(EVENTS.BATTLE)).toBe(null);
    expect(lv.index).toBe(0);
  });

  it('walks the whole chain in order and completes once', () => {
    const lv = createLevel(AREA);
    const order = [EVENTS.MOVE, EVENTS.TALK, EVENTS.BATTLE, EVENTS.BATTLE, EVENTS.TALK];
    const seen = [];
    for (const e of order) {
      expect(lv.canAdvance(e)).toBe(true);
      lv.advance(e);
      seen.push(lv.objective);
    }
    expect(seen).toEqual(['talk', 'fight', 'boss', 'return', null]);
    expect(lv.isComplete).toBe(true);
  });

  it('does NOT let one event skip several stages', () => {
    // The regression this file exists for. Stages c and d are BOTH spent by
    // onBattle. A single win arriving while d is active must spend d, not c.
    const lv = createLevel(AREA);
    lv.advance(EVENTS.MOVE);
    lv.advance(EVENTS.TALK);
    expect(lv.stage.id).toBe('c');
    lv.advance(EVENTS.BATTLE);
    expect(lv.stage.id).toBe('d');
  });

  it('reports the gate for the current stage', () => {
    const lv = createLevel(AREA);
    expect(lv.gateForCurrent()).toBe('always');
    lv.advance(EVENTS.MOVE);
    expect(lv.gateForCurrent()).toBe('onMove');
  });

  it('an event after completion is inert', () => {
    const lv = createLevel(AREA);
    for (const e of [EVENTS.MOVE, EVENTS.TALK, EVENTS.BATTLE, EVENTS.BATTLE, EVENTS.TALK]) lv.advance(e);
    expect(lv.isComplete).toBe(true);
    // Spending the completing stage parks the index one PAST the last stage,
    // which is what `at() === null` and `objective === null` report.
    const parked = lv.index;
    expect(lv.stage).toBe(null);
    expect(lv.objective).toBe(null);
    lv.advance(EVENTS.MOVE);
    lv.advance(EVENTS.BATTLE);
    expect(lv.index).toBe(parked);      // completion is terminal
    expect(lv.isComplete).toBe(true);
  });

  it('round-trips through a snapshot', () => {
    const lv = createLevel(AREA);
    lv.advance(EVENTS.MOVE);
    lv.advance(EVENTS.TALK);
    const snap = lv.snapshot();
    const other = createLevel(AREA);
    expect(other.restore(snap)).toBe(true);
    expect(other.stage.id).toBe('c');
    expect(other.objective).toBe('fight');
  });

  it('refuses a snapshot from a different area', () => {
    const a = createLevel(AREA);
    const b = createLevel({ ...AREA, id: 'other' });
    expect(b.restore(a.snapshot())).toBe(false);
  });

  it('clamps an out-of-range restored index instead of throwing', () => {
    const lv = createLevel(AREA);
    // A save from a build with more stages must not brick the game: it clamps
    // to the last stage and counts as complete, because past-the-end means done.
    expect(lv.restore({ id: 'test', index: 99, complete: false })).toBe(true);
    expect(lv.index).toBe(AREA.stages.length - 1);
    expect(lv.isComplete).toBe(true);
    // Negative and junk clamp to the start rather than into an undefined stage.
    expect(lv.restore({ id: 'test', index: -5 })).toBe(true);
    expect(lv.index).toBe(0);
    expect(lv.restore({ id: 'test', index: 'nonsense' })).toBe(true);
    expect(lv.index).toBe(0);
  });

  it('throws on a definition with no stages', () => {
    expect(() => createLevel({ id: 'x' })).toThrow();
    expect(() => createLevel({ id: 'x', stages: [] })).toThrow();
    expect(() => createLevel(null)).toThrow();
  });
});

describe('inventory', () => {
  const ITEMS = { tonic: { name: 'Tonic' }, ether: { name: 'Ether' }, bloom: { name: 'Bloom' } };

  it('starts empty with no gold', () => {
    const bag = createInventory(ITEMS);
    expect(bag.gold).toBe(0);
    expect(bag.count('tonic')).toBe(0);
    expect(bag.entries()).toEqual([]);
  });

  it('adds and counts', () => {
    const bag = createInventory(ITEMS);
    bag.add('tonic', 3);
    expect(bag.count('tonic')).toBe(3);
  });

  it('ignores an id that is not in the catalogue', () => {
    const bag = createInventory(ITEMS);
    expect(bag.add('sword', 5)).toBe(0);
    expect(bag.count('sword')).toBe(0);
  });

  it('never goes negative', () => {
    const bag = createInventory(ITEMS);
    bag.add('tonic', 1);
    expect(bag.use('tonic')).toBe(true);
    expect(bag.use('tonic')).toBe(false);
    expect(bag.count('tonic')).toBe(0);
    bag.add('tonic', -5);
    expect(bag.count('tonic')).toBe(0);
  });

  it('entries omits empty slots and carries the def', () => {
    const bag = createInventory(ITEMS);
    bag.add('ether', 2);
    const e = bag.entries();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ id: 'ether', count: 2, def: ITEMS.ether });
  });

  it('adds gold and floors at zero', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(90);
    expect(bag.gold).toBe(90);
    bag.addGold(-200);
    expect(bag.gold).toBe(0);
  });

  it('spend is all-or-nothing and checks before deducting', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(100);
    expect(bag.spend(120)).toBe(false);
    expect(bag.gold).toBe(100);      // refused, and nothing was taken
    expect(bag.spend(100)).toBe(true);
    expect(bag.gold).toBe(0);
  });

  it('refuses a nonsense price', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(50);
    for (const bad of [0, -1, NaN, Infinity, undefined, null]) {
      expect(bag.spend(bad)).toBe(false);
    }
    expect(bag.gold).toBe(50);
  });

  it('refuses a FRACTIONAL price, which would leave a non-integer purse', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(50);
    // `Number.isFinite(30.5)` is true, so this used to pass and leave the purse
    // reading "19.5 oro".
    expect(bag.spend(30.5)).toBe(false);
    expect(bag.gold).toBe(50);
  });

  it('refuses a price that is a string, and does not make the item free', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(50);
    expect(bag.spend('30')).toBe(false);
    expect(bag.buy('tonic', '30')).toBe(false);
    expect(bag.gold).toBe(50);
    expect(bag.count('tonic')).toBe(0);
  });

  it('snapshot carries only what is held', () => {
    const bag = createInventory(ITEMS);
    bag.add('tonic', 2);
    bag.addGold(35);
    expect(bag.snapshot()).toEqual({ gold: 35, items: { tonic: 2 } });
  });

  it('buy charges and delivers as ONE operation', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(50);
    expect(bag.buy('tonic', 30)).toBe(true);
    expect(bag.gold).toBe(20);
    expect(bag.count('tonic')).toBe(1);
  });

  it('buy refuses before charging when the purse is short', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(29);
    expect(bag.buy('tonic', 30)).toBe(false);
    // The refusal must not have taken anything: the whole reason `buy` exists is
    // that `spend` then `add` has a window where a failure loses the gold.
    expect(bag.gold).toBe(29);
    expect(bag.count('tonic')).toBe(0);
  });

  it('buy refuses an id that is not in the catalogue, and charges nothing', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(999);
    expect(bag.buy('sword', 100)).toBe(false);
    expect(bag.gold).toBe(999);
  });

  it('buy is repeatable until the gold runs out', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(70);
    expect(bag.buy('tonic', 30)).toBe(true);
    expect(bag.buy('tonic', 30)).toBe(true);
    expect(bag.buy('tonic', 30)).toBe(false);
    expect(bag.count('tonic')).toBe(2);
    expect(bag.gold).toBe(10);
  });

  it('sell hands over the item and pays, as ONE operation', () => {
    const bag = createInventory(ITEMS);
    bag.add('tonic', 1);
    expect(bag.sell('tonic', 15)).toBe(true);
    expect(bag.count('tonic')).toBe(0);
    expect(bag.gold).toBe(15);
  });

  it('sell refuses what the bag does not hold, and pays nothing', () => {
    const bag = createInventory(ITEMS);
    expect(bag.sell('tonic', 15)).toBe(false);
    expect(bag.gold).toBe(0);
    expect(bag.count('tonic')).toBe(0);
    // An id outside the catalogue is refused the same way.
    expect(bag.sell('sword', 50)).toBe(false);
    expect(bag.gold).toBe(0);
  });

  it('sell refuses a nonsense price without taking the item', () => {
    const bag = createInventory(ITEMS);
    bag.add('tonic', 2);
    for (const bad of [0, -5, 12.5, '15', NaN, Infinity, null, undefined]) {
      expect(bag.sell('tonic', bad)).toBe(false);
    }
    expect(bag.count('tonic')).toBe(2);   // the item must still be there
    expect(bag.gold).toBe(0);
  });

  it('buy then sell loses the spread and never gains gold from nothing', () => {
    const bag = createInventory(ITEMS);
    bag.addGold(30);
    expect(bag.buy('tonic', 30)).toBe(true);
    expect(bag.gold).toBe(0);
    expect(bag.sell('tonic', 15)).toBe(true);
    expect(bag.gold).toBe(15);
    expect(bag.count('tonic')).toBe(0);
  });
});
