import { describe, it, expect } from 'vitest';
import {
  ELEMENTS, WEAPON_TYPES, MULT, WEAPON_ELEMENT,
  multiplier, classify, strongestWeakness, resolveElement,
} from '../src/combat/weaknesses.js';
import { computeDamage, computeHeal, computeRestoreMP } from '../src/combat/damage.js';
import { buildTimeline, nextTurn } from '../src/combat/turnOrder.js';
import { chooseEnemyCommand } from '../src/combat/ai.js';

/** Replays a fixed sequence of draws and records how many were consumed. */
function seqRng(...values) {
  let i = 0;
  const fn = () => values[i++];
  fn.draws = () => i;
  return fn;
}

const stub = (uid, over = {}) => ({
  uid, side: 'ally', name: uid, level: 1,
  maxHP: 100, currentHP: 100, maxMP: 10, currentMP: 10,
  attack: 10, defense: 10, magic: 4, speed: 5,
  weaponType: 'sword',
  resistances: {}, immunities: [], vulnerabilities: [],
  skills: [], items: [], defending: false, boosted: false,
  ...over,
});

describe('weaknesses — resolution order', () => {
  it('exposes the frozen element and weapon-type tables', () => {
    expect(ELEMENTS).toEqual(['physical', 'fire', 'ice', 'lightning', 'dark', 'light']);
    expect(WEAPON_TYPES).toEqual(['sword', 'spear', 'axe', 'bow', 'staff', 'dagger']);
    expect(MULT).toEqual({ WEAKENED: 0.5, NORMAL: 1, STRONG: 2, IMMUNE: 0 });
  });

  it('1. immunity beats an explicit resistance AND an explicit vulnerability', () => {
    const d = stub('d', {
      immunities: ['fire'],
      resistances: { fire: 0.5 },
      vulnerabilities: ['fire'],
    });
    expect(multiplier(null, d, { element: 'fire' })).toBe(0);
  });

  it('2. an explicit vulnerability wins over an explicit resistance on the same element', () => {
    const d = stub('d', { resistances: { dark: 0.5 }, vulnerabilities: ['dark'] });
    expect(multiplier(null, d, { element: 'dark' })).toBe(2);
  });

  it('2. an explicit resistance value is used verbatim', () => {
    expect(multiplier(null, stub('d', { resistances: { fire: 0.5 } }), { element: 'fire' })).toBe(0.5);
    expect(multiplier(null, stub('d', { resistances: { fire: 2 } }), { element: 'fire' })).toBe(2);
    // an explicit 0 in the table is NOT immunity, but it is still 0 damage
    expect(multiplier(null, stub('d', { resistances: { ice: 0 } }), { element: 'ice' })).toBe(0);
  });

  it('2. a resistance entry of 0 does not stop the vulnerability step from being reachable', () => {
    const d = stub('d', { resistances: { light: 0 } });
    expect(multiplier(null, d, { element: 'light' })).toBe(0);
    expect(multiplier(null, stub('d', {}), { element: 'light' })).toBe(1);
  });

  it('3. the weapon-type table supplies the element when the action has none', () => {
    const d = stub('d', { resistances: { light: 0.5 } });
    expect(multiplier(null, d, { weaponType: 'staff' })).toBe(0.5);
    expect(multiplier(null, d, { weaponType: 'sword' })).toBe(1);
  });

  it('an explicit element overrides the weapon-type table', () => {
    const d = stub('d', { resistances: { fire: 2, physical: 1 } });
    expect(multiplier(null, d, { element: 'fire', weaponType: 'sword' })).toBe(2);
    expect(multiplier(null, d, { element: 'physical', weaponType: 'staff' })).toBe(1);
  });

  it('4. falls through to NORMAL when nothing matches', () => {
    expect(multiplier(null, stub('d'), { element: 'fire' })).toBe(1);
    expect(multiplier(null, stub('d'), { weaponType: 'axe' })).toBe(1);
    expect(multiplier(null, stub('d'), {})).toBe(1);
    expect(multiplier(null, undefined, { element: 'fire' })).toBe(1);
  });

  it('2 beats 3: an explicit entry wins over what the weapon table resolves to', () => {
    const d = stub('d', { immunities: ['light'] });
    // staff -> light, and light is immune, so the weapon table result is honoured
    expect(multiplier(null, d, { weaponType: 'staff' })).toBe(0);
    // and the same defender is plain normal against physical
    expect(multiplier(null, d, { weaponType: 'sword' })).toBe(1);
  });

  it('ignores the attacker entirely (the table is defender-side)', () => {
    const d = stub('d', { resistances: { fire: 2 } });
    expect(multiplier(stub('a', { resistances: { fire: 0.5 } }), d, { element: 'fire' })).toBe(2);
  });

  it('resolveElement reads the action first, then the weapon table', () => {
    expect(resolveElement({ element: 'ice', weaponType: 'staff' })).toBe('ice');
    expect(resolveElement({ weaponType: 'staff' })).toBe('light');
    expect(resolveElement({})).toBe(null);
    expect(WEAPON_ELEMENT.sword).toBe('physical');
  });
});

describe('weaknesses — classify / strongestWeakness', () => {
  it('buckets every multiplier', () => {
    expect(classify(0)).toBe('immune');
    expect(classify(0.5)).toBe('weak');
    expect(classify(1)).toBe('normal');
    expect(classify(2)).toBe('strong');
    expect(classify(4)).toBe('strong');
    expect(classify(0.25)).toBe('weak');
  });

  it('finds the best weakness and ignores immune/weak entries', () => {
    const d = stub('d', {
      resistances: { fire: 0.5, ice: 1, lightning: 1, dark: 2, light: 1, physical: 1 },
      immunities: ['light'],
    });
    expect(strongestWeakness(d)).toEqual({ element: 'dark', mult: 2 });
  });

  it('returns null when the defender has no weakness', () => {
    expect(strongestWeakness(stub('d'))).toBe(null);
    expect(strongestWeakness(stub('d', { immunities: [...ELEMENTS] }))).toBe(null);
    expect(strongestWeakness(stub('d', { resistances: { fire: 0.5 } }))).toBe(null);
  });

  it('reports the strongest of several', () => {
    const d = stub('d', { vulnerabilities: ['fire'], resistances: { ice: 2, dark: 2 } });
    expect(strongestWeakness(d).element).toBe('fire'); // both 2, first in ELEMENTS order wins
    expect(strongestWeakness(d).mult).toBe(2);
  });
});

describe('damage — exact formula', () => {
  const attacker = stub('a', { attack: 20 });
  const defender = stub('d', { defense: 10, currentHP: 100 });

  it('matches the contract for a plain hit', () => {
    // base = 3*20/10 = 6 ; variance = 0.92+0.5*0.16 = 1.0 ; no crit ; mult 1
    const r = computeDamage({ attacker, defender, action: { power: 3 }, mult: 1, rng: seqRng(0.5, 0.9) });
    expect(r.amount).toBe(6);
    expect(r.variance).toBe(1);
    expect(r.crit).toBe(false);
    expect(r.effectiveness).toBe('normal');
    expect(r.hpAfter).toBe(94);
    expect(r.dead).toBe(false);
  });

  it('draws variance FIRST and crit SECOND', () => {
    // If the order were swapped, variance would be 1.0784 and the crit would fire
    // -> raw 9.7056 -> amount 10. The correct order gives variance 0.92, no crit.
    const rng = seqRng(0, 0.99);
    const r = computeDamage({ attacker, defender, action: { power: 3 }, mult: 1, rng });
    expect(r.variance).toBe(0.92);
    expect(r.crit).toBe(false);
    expect(r.amount).toBe(6);
    expect(rng.draws()).toBe(2);
  });

  it('applies the 1.5x crit multiplier after mult', () => {
    const r = computeDamage({ attacker, defender, action: { power: 3 }, mult: 1, rng: seqRng(0.5, 0.01) });
    expect(r.crit).toBe(true);
    expect(r.amount).toBe(9); // 6 * 1.0 * 1 * 1.5
  });

  it('crit and weakness multiply together', () => {
    const r = computeDamage({ attacker, defender, action: { power: 3 }, mult: 2, rng: seqRng(0.5, 0.01) });
    expect(r.amount).toBe(18); // 6 * 1.0 * 2 * 1.5
    expect(r.effectiveness).toBe('strong');
  });

  it('defaults critRate to 0.05', () => {
    expect(computeDamage({ attacker, defender, action: { power: 1 }, mult: 1, rng: seqRng(0.5, 0.049) }).crit).toBe(true);
    expect(computeDamage({ attacker, defender, action: { power: 1 }, mult: 1, rng: seqRng(0.5, 0.051) }).crit).toBe(false);
    // a critRate of 0 can never crit
    expect(computeDamage({ attacker, defender, action: { power: 1, critRate: 0 }, mult: 1, rng: seqRng(0.5, 0) }).crit).toBe(false);
  });

  it('variance stays inside 0.92..1.08', () => {
    const lo = computeDamage({ attacker, defender, action: { power: 100 }, mult: 1, rng: seqRng(0, 0.99) });
    const hi = computeDamage({ attacker, defender, action: { power: 100 }, mult: 1, rng: seqRng(1, 0.99) });
    expect(lo.variance).toBeCloseTo(0.92, 10);
    expect(hi.variance).toBeCloseTo(1.08, 10);
  });

  it('IMMUNE branch: amount 0, hp untouched, dead false', () => {
    const r = computeDamage({ attacker, defender, action: { power: 3 }, mult: 0, rng: seqRng(0.5, 0.5) });
    expect(r.amount).toBe(0);
    expect(r.hpAfter).toBe(100);
    expect(r.dead).toBe(false);
    expect(r.effectiveness).toBe('immune');
    expect(r.mult).toBe(0);
  });

  it('clamps overkill to the target remaining HP', () => {
    const weakling = stub('d', { defense: 1, currentHP: 4 });
    const r = computeDamage({ attacker, defender: weakling, action: { power: 3 }, mult: 2, rng: seqRng(0.5, 0.9) });
    expect(r.amount).toBe(4);
    expect(r.hpAfter).toBe(0);
    expect(r.dead).toBe(true);
  });

  it('never returns a negative amount on a WEAKENED hit', () => {
    const tank = stub('d', { defense: 500, currentHP: 30 });
    const r = computeDamage({ attacker, defender: tank, action: { power: 3 }, mult: 0.5, rng: seqRng(0, 0.99) });
    expect(r.amount).toBe(0);
    expect(r.hpAfter).toBe(30);
    expect(r.dead).toBe(false);
  });

  it('floor defense at 1 instead of dividing by zero', () => {
    const naked = stub('d', { defense: 0, currentHP: 50 });
    const r = computeDamage({ attacker, defender: naked, action: { power: 1 }, mult: 1, rng: seqRng(0.5, 0.9) });
    expect(r.amount).toBe(20); // 1*20 / max(1,0)
  });

  it('defaults power to 0 and mult to NORMAL', () => {
    const r = computeDamage({ attacker, defender, rng: seqRng(0.5, 0.9) });
    expect(r.amount).toBe(0);
    expect(r.mult).toBe(1);
  });

  it('never mutates the defender', () => {
    const d = stub('d', { defense: 10, currentHP: 100 });
    computeDamage({ attacker, defender: d, action: { power: 3 }, mult: 1, rng: seqRng(0.5, 0.9) });
    expect(d.currentHP).toBe(100);
  });
});

describe('damage — healing', () => {
  it('floors power * magic', () => {
    const caster = stub('c', { magic: 3.7 });
    const target = stub('t', { currentHP: 10 });
    expect(computeHeal({ caster, target, power: 5 })).toBe(18); // floor(18.5)
  });

  it('never overheals', () => {
    const caster = stub('c', { magic: 10 });
    // 8*10 = 80 wanted, only 60 missing
    expect(computeHeal({ caster, target: stub('t', { currentHP: 40 }), power: 8 })).toBe(60);
    expect(computeHeal({ caster, target: stub('t', { currentHP: 100 }), power: 8 })).toBe(0);
    expect(computeHeal({ caster, target: stub('t', { currentHP: 0, maxHP: 0 }), power: 8 })).toBe(0);
  });

  it('restores MP up to maxMP', () => {
    expect(computeRestoreMP({ power: 12, target: stub('t', { maxMP: 20, currentMP: 5 }) })).toBe(12);
    expect(computeRestoreMP({ power: 30, target: stub('t', { maxMP: 20, currentMP: 5 }) })).toBe(15);
    expect(computeRestoreMP({ power: 30, target: stub('t', { maxMP: 20, currentMP: 20 }) })).toBe(0);
  });
});

describe('turnOrder — buildTimeline', () => {
  const allies = [stub('a1', { speed: 11, name: 'Olrik' }), stub('a2', { speed: 10 })];
  const enemies = [stub('e1', { side: 'enemy', speed: 3, name: 'Slime' })];

  it('is deterministic for a constant rng and sorts by the roll descending', () => {
    const t = buildTimeline(allies, enemies, () => 0.5);
    expect(t.map((e) => e.uid)).toEqual(['a1', 'a2', 'e1']);
    // roll = speed * (0.9 + 0.5*0.2) = speed * 1.0
    expect(t.map((e) => e.roll)).toEqual([11, 10, 3]);
  });

  it('carries uid, side, name, speed and the formation index', () => {
    const t = buildTimeline(allies, enemies, () => 0.5);
    expect(t[0]).toEqual({ uid: 'a1', side: 'ally', index: 0, name: 'Olrik', speed: 11, roll: 11 });
    expect(t.find((e) => e.uid === 'e1')).toMatchObject({ side: 'enemy', index: 0 });
  });

  it('draws exactly one rng value per combatant, allies first', () => {
    const rng = seqRng(0, 1, 0.5);
    const t = buildTimeline(allies, enemies, rng);
    expect(rng.draws()).toBe(3);
    // a1: 11*(0.9+0) = 9.9 ; a2: 10*(0.9+1*0.2) = 11 ; e1: 3*(0.9+0.5*0.2) = 3.3
    expect(t.map((e) => e.uid)).toEqual(['a2', 'a1', 'e1']);
  });

  it('lets the rng reorder equal-speed combatants', () => {
    const tie = [stub('a1', { speed: 10 }), stub('a2', { speed: 10 })];
    // a1 gets 0.0 -> 9.0 ; a2 gets 1.0 -> 11.0
    const t = buildTimeline(tie, [], seqRng(0, 1));
    expect(t.map((e) => e.uid)).toEqual(['a2', 'a1']);
  });

  it('breaks exact ties stably, allies before enemies', () => {
    const t = buildTimeline(
      [stub('a1', { speed: 5 })],
      [stub('e1', { side: 'enemy', speed: 5 })],
      () => 0.5,
    );
    expect(t.map((e) => e.uid)).toEqual(['a1', 'e1']);
  });

  it('returns every combatant exactly once and tolerates missing sides', () => {
    const t = buildTimeline(allies, [], () => 0.5);
    expect(t).toHaveLength(2);
    expect(buildTimeline([], [], () => 0.5)).toEqual([]);
    expect(buildTimeline(null, null, () => 0.5)).toEqual([]);
  });
});

describe('turnOrder — nextTurn', () => {
  const t = buildTimeline(
    [stub('a1', { speed: 11 }), stub('a2', { speed: 10 })],
    [stub('e1', { side: 'enemy', speed: 9 }), stub('e2', { side: 'enemy', speed: 8 })],
    () => 0.5,
  );

  it('advances to the next slot', () => {
    expect(nextTurn(t, 0, new Set(['a1', 'a2', 'e1', 'e2']))).toBe(1);
  });

  it('skips dead combatants', () => {
    expect(nextTurn(t, 0, new Set(['a1', 'e2']))).toBe(3);
  });

  it('skips several in a row', () => {
    // a1 and a2 are dead, so the scan walks past both to e1
    expect(nextTurn(t, 0, new Set(['e1', 'e2']))).toBe(2);
    expect(nextTurn(t, 1, new Set(['a1', 'e2']))).toBe(3);
  });

  it('wraps past the end', () => {
    expect(nextTurn(t, 3, new Set(['a1', 'a2', 'e1', 'e2']))).toBe(0);
  });

  it('wraps when everything after the cursor is dead', () => {
    expect(nextTurn(t, 2, new Set(['a1', 'a2']))).toBe(0);
  });

  it('returns the only survivor, even from the last slot', () => {
    expect(nextTurn(t, 3, new Set(['a2']))).toBe(1);
  });

  it('starts at slot 0 when the cursor is -1', () => {
    expect(nextTurn(t, -1, new Set(['a1', 'a2', 'e1', 'e2']))).toBe(0);
    expect(nextTurn(t, -1, new Set(['e1', 'e2']))).toBe(2);
  });

  it('returns -1 when nobody is alive', () => {
    expect(nextTurn(t, 0, new Set())).toBe(-1);
    expect(nextTurn(t, 3, new Set())).toBe(-1);
  });

  it('returns -1 for an empty timeline', () => {
    expect(nextTurn([], 0, new Set(['a1']))).toBe(-1);
    expect(nextTurn(null, 0, null)).toBe(-1);
  });

  it('accepts a Set, a Map, a plain object, a predicate, or nothing at all', () => {
    const uids = ['a1', 'a2', 'e1', 'e2'];
    const asSet = new Set(uids);
    const asMap = new Map(uids.map((u) => [u, { uid: u }]));
    const asObj = Object.fromEntries(uids.map((u) => [u, true]));
    for (const alive of [asSet, asMap, asObj, (u) => asSet.has(u), null]) {
      expect(nextTurn(t, 0, alive)).toBe(1);
    }
  });
});

describe('ai — chooseEnemyCommand', () => {
  const skills = {
    slime_goo: { id: 'slime_goo', name: 'Goo', kind: 'attack', element: 'physical', power: 1.2, target: 'enemy', mp: 0 },
    mend: { id: 'mend', name: 'Mend', kind: 'heal', power: 1, magic: 3, target: 'ally', mp: 2 },
  };

  const party = () => [
    stub('p1', { side: 'ally', currentHP: 90, maxHP: 100 }),
    stub('p2', { side: 'ally', currentHP: 40, maxHP: 100 }),
  ];

  const stubBattle = (allies, enemies) => ({
    living: (side) => (side === 'ally' ? allies : enemies).filter((c) => c.currentHP > 0),
    get: (uid) => [...allies, ...enemies].find((c) => c.uid === uid),
    skills,
  });

  it('stamps the acting enemy as actorUid', () => {
    const me = stub('e1', { side: 'enemy', skills: [] });
    const cmd = chooseEnemyCommand(me, stubBattle(party(), [me]), () => 0.9);
    expect(cmd.actorUid).toBe('e1');
    expect(cmd.type).toBe('attack');
  });

  it('attacks the lowest-HP ally on the 0.15..0.35 branch', () => {
    const me = stub('e1', { side: 'enemy', skills: [] });
    const cmd = chooseEnemyCommand(me, stubBattle(party(), [me]), () => 0.2);
    expect(cmd).toEqual({ actorUid: 'e1', type: 'attack', targetUid: 'p2' });
  });

  it('attacks a random alive ally on the last branch', () => {
    const me = stub('e1', { side: 'enemy', skills: [] });
    const cmd = chooseEnemyCommand(me, stubBattle(party(), [me]), seqRng(0.9, 0.99));
    expect(cmd.type).toBe('attack');
    expect(['p1', 'p2']).toContain(cmd.targetUid);
  });

  it('uses a skill in the first 15% when it has one and is above half HP', () => {
    const me = stub('e1', { side: 'enemy', skills: ['slime_goo'] });
    const cmd = chooseEnemyCommand(me, stubBattle(party(), [me]), seqRng(0.1, 0, 0));
    expect(cmd.type).toBe('skill');
    expect(cmd.actionId).toBe('slime_goo');
    expect(['p1', 'p2']).toContain(cmd.targetUid);
  });

  it('falls through to an attack below half HP', () => {
    const me = stub('e1', { side: 'enemy', skills: ['slime_goo'], currentHP: 30, maxHP: 100 });
    const cmd = chooseEnemyCommand(me, stubBattle(party(), [me]), () => 0.1);
    expect(cmd.type).toBe('attack');
  });

  it('heals a wounded ally in the next 20% band', () => {
    const hurt = stub('e2', { side: 'enemy', currentHP: 20, maxHP: 100 });
    const me = stub('e1', { side: 'enemy', skills: ['mend'] });
    const cmd = chooseEnemyCommand(me, stubBattle(party(), [me, hurt]), () => 0.2);
    expect(cmd).toEqual({ actorUid: 'e1', type: 'skill', targetUid: 'e2', actionId: 'mend' });
  });

  it('does not heal when nobody on its side is wounded', () => {
    const me = stub('e1', { side: 'enemy', skills: ['mend'] });
    const cmd = chooseEnemyCommand(me, stubBattle(party(), [me]), () => 0.2);
    expect(cmd.type).toBe('attack');
  });

  it('ignores skill ids that do not exist', () => {
    const me = stub('e1', { side: 'enemy', skills: ['nope'] });
    const cmd = chooseEnemyCommand(me, stubBattle(party(), [me]), () => 0.1);
    expect(cmd.type).toBe('attack');
  });

  it('never targets a downed ally', () => {
    const allies = [stub('p1', { side: 'ally', currentHP: 0 }), stub('p2', { side: 'ally', currentHP: 10 })];
    const me = stub('e1', { side: 'enemy', skills: [] });
    for (const roll of [0.2, 0.5, 0.99]) {
      expect(chooseEnemyCommand(me, stubBattle(allies, [me]), () => roll).targetUid).toBe('p2');
    }
  });

  it('prefers a Boosted target when the enemy knows weaknesses', () => {
    const allies = [
      stub('p1', { side: 'ally', currentHP: 50, boosted: true }),
      stub('p2', { side: 'ally', currentHP: 10 }),
    ];
    const blind = stub('e1', { side: 'enemy', skills: [] });
    const smart = stub('e1', { side: 'enemy', skills: [], knowsWeakness: true });
    expect(chooseEnemyCommand(smart, stubBattle(allies, [smart]), () => 0.2).targetUid).toBe('p1');
    expect(chooseEnemyCommand(blind, stubBattle(allies, [blind]), () => 0.2).targetUid).toBe('p2');
  });

  it('prefers the element it can hurt most when it knows weaknesses', () => {
    const allies = [
      stub('p1', { side: 'ally', currentHP: 50, resistances: { physical: 0.5 } }),
      stub('p2', { side: 'ally', currentHP: 60, resistances: { physical: 2 } }),
    ];
    const smart = stub('e1', { side: 'enemy', skills: [], knowsWeakness: true });
    for (const roll of [0.2, 0.5, 0.99]) {
      expect(chooseEnemyCommand(smart, stubBattle(allies, [smart]), () => roll).targetUid).toBe('p2');
    }
  });

  it('respects a skill element when narrowing', () => {
    const allies = [
      stub('p1', { side: 'ally', currentHP: 50, resistances: { fire: 2, physical: 0.5 } }),
      stub('p2', { side: 'ally', currentHP: 60, resistances: { fire: 0.5, physical: 2 } }),
    ];
    const smart = stub('e1', { side: 'enemy', skills: ['slime_goo'], knowsWeakness: true });
    const cmd = chooseEnemyCommand(smart, stubBattle(allies, [smart]), seqRng(0.1, 0, 0));
    expect(cmd.type).toBe('skill');
    expect(cmd.targetUid).toBe('p2'); // the skill is physical, and p2 folds to physical
  });

  it('defends when the opposing side is empty', () => {
    const me = stub('e1', { side: 'enemy' });
    expect(chooseEnemyCommand(me, stubBattle([], [me]), () => 0.5))
      .toEqual({ actorUid: 'e1', type: 'defend', targetUid: 'e1' });
  });
});
