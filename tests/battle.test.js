import { describe, it, expect, vi } from 'vitest';
import { createBattle as createBattleRaw, DEFEND_MULT, RECOVER_RATIO } from '../src/combat/battle.js';
import { chooseEnemyCommand } from '../src/combat/ai.js';

// These tests assert on round counts and exact HP totals, so they must not move
// when the basic-attack power is retuned. Pin basicPower to 1 for the whole
// suite: the state machine is what is under test here, not the numbers.
// tests/combat.test.js covers the formula. A test that breaks every time
// someone tunes an attack is a bad test.
function createBattle(opts) {
  return createBattleRaw({ basicPower: 1, ...opts });
}

/** Overriding `maxHP` moves `currentHP` with it unless you pin both. */
const fighter = (base, over) => {
  const merged = { ...base, ...over };
  if (!('currentHP' in over)) merged.currentHP = merged.maxHP;
  return merged;
};

const ally = (over = {}) => fighter({
  uid: 'a1', side: 'ally', name: 'Olrik', level: 3,
  maxHP: 100, currentHP: 100, maxMP: 20, currentMP: 20,
  attack: 20, defense: 10, magic: 6, speed: 11,
  weaponType: 'sword', resistances: { physical: 1 },
  immunities: [], vulnerabilities: [],
  skills: [], items: [], defending: false, boosted: false,
}, over);

const foe = (over = {}) => fighter({
  uid: 'e1', side: 'enemy', name: 'Bog Slime', level: 2,
  maxHP: 20, currentHP: 20, maxMP: 0, currentMP: 0,
  attack: 12, defense: 1, magic: 4, speed: 3,
  weaponType: 'dagger', resistances: { physical: 0.5 },
  immunities: [], vulnerabilities: [],
  skills: [], items: [], defending: false, boosted: false,
}, over);

/** variance 1.0, never a crit — the arithmetic in these tests stays readable. */
const flat = () => 0.5;

/** Records every onEvent beat in order. */
function recorder() {
  const events = [];
  const onEvent = vi.fn((type, payload) => events.push({ type, payload }));
  onEvent.events = events;
  onEvent.of = (type) => events.filter((e) => e.type === type);
  onEvent.types = () => events.map((e) => e.type);
  return onEvent;
}

/** Advance frames until the battle is accepting commands. */
function toCommand(battle, max = 8) {
  for (let i = 0; i < max && battle.state !== 'command'; i++) battle.update(1 / 60);
  return battle.state;
}

/** One full round: open it, route each command through its side's channel, settle. */
function playRound(battle, commands) {
  expect(toCommand(battle)).toBe('command');
  for (const cmd of commands) {
    if (battle.get(cmd.actorUid).side === 'ally') battle.submitCommand(cmd);
    else battle.submitAiCommand(cmd);
  }
  return battle.whenRoundReady();
}

const attack = (actorUid, targetUid) => ({ actorUid, type: 'attack', targetUid });

describe('battle — state machine', () => {
  it('starts in intro and only leaves it on update', () => {
    const b = createBattle({ allies: [ally()], enemies: [foe()], rng: flat, onEvent: recorder() });
    expect(b.state).toBe('intro');
    expect(b.isOver).toBe(false);
    expect(b.result).toBe(null);
    b.update(1 / 60);
    expect(b.state).toBe('turnStart');
    b.update(1 / 60);
    expect(b.state).toBe('command');
    expect(b.round).toBe(1);
  });

  it('builds the timeline on the first update', () => {
    const b = createBattle({
      allies: [ally({ uid: 'a1', speed: 11 }), ally({ uid: 'a2', speed: 4 })],
      enemies: [foe({ uid: 'e1', speed: 8 })],
      rng: flat, onEvent: recorder(),
    });
    b.update(1 / 60);
    expect(b.timeline.map((e) => e.uid)).toEqual(['a1', 'e1', 'a2']);
    expect(b.turnIndex).toBe(0);
    expect(b.current.uid).toBe('a1');
  });

  it('tracks elapsed time', () => {
    const b = createBattle({ allies: [ally()], enemies: [foe()], rng: flat, onEvent: recorder() });
    b.update(0.5);
    b.update(0.25);
    expect(b.elapsed).toBeCloseTo(0.75, 10);
  });

  it('collects one command from every living combatant before resolving', () => {
    const b = createBattle({ allies: [ally()], enemies: [foe()], rng: flat, onEvent: recorder() });
    toCommand(b);
    expect(b.pending.map((c) => c.uid).sort()).toEqual(['a1', 'e1']);

    b.submitCommand(attack('a1', 'e1'));
    expect(b.state).toBe('command'); // still waiting on the enemy
    expect(b.pending.map((c) => c.uid)).toEqual(['e1']);

    b.submitAiCommand(attack('e1', 'a1'));
    expect(b.state).toBe('resolving'); // the round settled
  });

  it('resolves the round in timeline order, not submission order', () => {
    const a1 = ally({ uid: 'a1', speed: 9 });
    const a2 = ally({ uid: 'a2', speed: 8 });
    const onEvent = recorder();
    const b = createBattle({ allies: [a1, a2], enemies: [foe({ uid: 'e1', speed: 7, maxHP: 500 })], rng: flat, onEvent });
    toCommand(b);
    // submit the slow ally first
    b.submitCommand(attack('a2', 'e1'));
    b.submitCommand(attack('a1', 'e1'));
    b.submitAiCommand(attack('e1', 'a1'));
    const beats = onEvent.of('action').map((e) => e.payload.actor.uid);
    expect(beats).toEqual(['a1', 'a2', 'e1']);
  });

  it('opens the next round on the frame after a resolution', () => {
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 500 })], rng: flat, onEvent: recorder() });
    toCommand(b);
    b.submitCommand(attack('a1', 'e1'));
    b.submitAiCommand(attack('e1', 'a1'));
    expect(b.state).toBe('resolving');
    expect(b.round).toBe(1);
    b.update(1 / 60);
    expect(b.state).toBe('turnStart');
    expect(b.round).toBe(2);
    b.update(1 / 60);
    expect(b.state).toBe('command');
  });

  it('whenRoundReady still points at the round that just settled', async () => {
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 500 })], rng: flat, onEvent: recorder() });
    toCommand(b);
    b.submitCommand(attack('a1', 'e1'));
    b.submitAiCommand(attack('e1', 'a1'));
    // called AFTER the last submit — must not hang on round 2
    const log = await b.whenRoundReady();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ actorUid: 'a1', outcome: 'damage', amount: 10 });
  });

  it('is hooked to round 1 even if whenRoundReady is called before any update', async () => {
    const b = createBattle({ allies: [ally()], enemies: [foe()], rng: flat, onEvent: recorder() });
    const pending = b.whenRoundReady();
    toCommand(b);
    b.submitCommand(attack('a1', 'e1'));
    b.submitAiCommand(attack('e1', 'a1'));
    expect((await pending).length).toBeGreaterThan(0);
  });

  it('rejects commands once the battle is over', () => {
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 10 })], rng: flat, onEvent: recorder() });
    playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')]);
    expect(b.state).toBe('victory');
    expect(() => b.submitCommand(attack('a1', 'e1'))).toThrow(/not accepting commands/);
  });
});

describe('battle — submit guards', () => {
  const newBattle = () => {
    const b = createBattle({ allies: [ally()], enemies: [foe()], rng: flat, onEvent: recorder() });
    toCommand(b);
    return b;
  };

  it('throws when an enemy is submitted through the player channel', () => {
    const b = newBattle();
    expect(() => b.submitCommand(attack('e1', 'a1'))).toThrow(/is a enemy, submitted through the ally channel/);
  });

  it('throws when an ally is submitted through the AI channel', () => {
    const b = newBattle();
    expect(() => b.submitAiCommand(attack('a1', 'e1'))).toThrow(/is a ally, submitted through the enemy channel/);
  });

  it('leaves the battle untouched after a rejected command', () => {
    const b = newBattle();
    expect(() => b.submitCommand(attack('e1', 'a1'))).toThrow();
    expect(b.pending).toHaveLength(2);
    expect(b.state).toBe('command');
  });

  it('throws on an unknown actor', () => {
    const b = newBattle();
    expect(() => b.submitCommand(attack('ghost', 'e1'))).toThrow(/unknown actor/);
  });

  it('throws on a second command from the same actor', () => {
    const b = newBattle();
    b.submitCommand(attack('a1', 'e1'));
    expect(() => b.submitCommand(attack('a1', 'e1'))).toThrow(/already submitted/);
  });

  it('throws when submitted before the command phase opens', () => {
    const b = createBattle({ allies: [ally()], enemies: [foe()], rng: flat, onEvent: recorder() });
    expect(() => b.submitCommand(attack('a1', 'e1'))).toThrow(/not accepting commands/);
  });
});

describe('battle — the boost mechanic', () => {
  it('a boost command flags the target and emits boost { gained: true }', () => {
    const onEvent = recorder();
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 500 })], rng: flat, onEvent });
    playRound(b, [{ actorUid: 'a1', type: 'boost', targetUid: 'a1' }, { actorUid: 'e1', type: 'defend', targetUid: 'e1' }]);

    expect(b.get('a1').boosted).toBe(true);
    const [beat] = onEvent.of('boost');
    expect(beat.payload.gained).toBe(true);
    expect(beat.payload.target.uid).toBe('a1');
    expect(beat.payload.actor.uid).toBe('a1');
  });

  it('attacking a Boosted target clears the flag and emits boost { gained: false }', () => {
    const onEvent = recorder();
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 500 })], rng: flat, onEvent });
    // round 1: the ally boosts the slime, the slime guards so the boost survives
    playRound(b, [{ actorUid: 'a1', type: 'boost', targetUid: 'e1' }, { actorUid: 'e1', type: 'defend', targetUid: 'e1' }]);
    expect(b.get('e1').boosted).toBe(true);

    playRound(b, [attack('a1', 'e1'), { actorUid: 'e1', type: 'defend', targetUid: 'e1' }]);
    const breaks = onEvent.of('boost').filter((e) => e.payload.gained === false);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].payload.actor.uid).toBe('a1');
    expect(breaks[0].payload.target.uid).toBe('e1');
    expect(b.get('e1').boosted).toBe(false);
  });

  it('immunity does NOT break a boost — the hit removes no HP', () => {
    const onEvent = recorder();
    const wall = foe({ maxHP: 500, immunities: ['physical'] });
    const b = createBattle({ allies: [ally()], enemies: [wall], rng: flat, onEvent });
    playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')]);
    expect(b.get('e1').boosted).toBe(false);
    expect(onEvent.of('boost').filter((e) => e.payload.gained === false)).toHaveLength(0);
  });

  it('a Boosted ally recovers a chunk of HP at the top of its own turn', () => {
    const onEvent = recorder();
    const hurt = ally({ currentHP: 20, boosted: true });
    const b = createBattle({ allies: [hurt], enemies: [foe({ maxHP: 500, speed: 1 })], rng: flat, onEvent });
    playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')]);

    const [beat] = onEvent.of('recover');
    expect(beat.payload.target.uid).toBe('a1');
    expect(beat.payload.amount).toBe(Math.round(100 * RECOVER_RATIO));
    expect(beat.payload.hpBefore).toBe(20);
    expect(beat.payload.hpAfter).toBe(30);
  });

  it('the recovery does not consume the boost', () => {
    const hurt = ally({ currentHP: 20, boosted: true });
    const b = createBattle({ allies: [hurt], enemies: [foe({ maxHP: 500, speed: 1 })], rng: flat, onEvent: recorder() });
    // the slime guards, so nothing hits the boosted ally but its own recovery
    playRound(b, [attack('a1', 'e1'), { actorUid: 'e1', type: 'defend', targetUid: 'e1' }]);
    expect(hurt.boosted).toBe(true);
    expect(hurt.currentHP).toBe(30);
  });

  it('no recover beat at full HP, when downed, or for an enemy', () => {
    const onEvent = recorder();
    const b = createBattle({
      allies: [ally({ uid: 'a1', currentHP: 100, boosted: true }), ally({ uid: 'a2', currentHP: 50, boosted: true })],
      enemies: [foe({ uid: 'e1', maxHP: 500, currentHP: 10, boosted: true, speed: 12 })],
      rng: flat, onEvent,
    });
    playRound(b, [attack('a1', 'e1'), attack('a2', 'e1'), attack('e1', 'a1')]);
    // the enemy acts first (speed 12) and is Boosted but NOT a party member
    expect(onEvent.of('recover')).toHaveLength(0);
  });

  it('a boost command on a target that died mid-round fizzles into a miss', () => {
    const onEvent = recorder();
    const a1 = ally({ uid: 'a1', speed: 12 });
    const a2 = ally({ uid: 'a2', speed: 11 });
    const e1 = foe({ uid: 'e1', maxHP: 10, speed: 10 }); // a1 one-shots it
    const e2 = foe({ uid: 'e2', maxHP: 500, speed: 5 });
    const b = createBattle({ allies: [a1, a2], enemies: [e1, e2], rng: flat, onEvent });

    playRound(b, [
      attack('a1', 'e1'),
      { actorUid: 'a2', type: 'boost', targetUid: 'e1' }, // e1 is already down
      attack('e1', 'a1'),
      attack('e2', 'a1'),
    ]);

    const fizzle = onEvent.of('miss').find((e) => e.payload.actor.uid === 'a2');
    expect(fizzle.payload.reason).toBe('target-down');
    expect(b.get('e1').boosted).toBe(false);
    expect(b.get('e2').boosted).toBe(false); // it was NOT redirected to a live target
  });
});

describe('battle — event payloads', () => {
  it('emits action -> weak -> damage -> down in that order on a killing hit', () => {
    const onEvent = recorder();
    const b = createBattle({ allies: [ally({ uid: 'a1', speed: 9 })], enemies: [foe({ maxHP: 8 })], rng: flat, onEvent });
    playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')]);
    const seen = onEvent.types().filter((t) => ['action', 'weak', 'damage', 'down', 'end'].includes(t));
    expect(seen).toEqual(['action', 'weak', 'damage', 'down', 'end']);

    const dmg = onEvent.of('damage')[0].payload;
    expect(dmg.attacker.uid).toBe('a1');
    expect(dmg.target.uid).toBe('e1');
    expect(dmg.result).toMatchObject({ amount: 8, mult: 0.5, effectiveness: 'weak', crit: false, dead: true, hpAfter: 0 });
    expect(onEvent.of('weak')[0].payload).toMatchObject({ attacker: { uid: 'a1' }, target: { uid: 'e1' }, mult: 0.5 });
    expect(onEvent.of('down')[0].payload).toMatchObject({ target: { uid: 'e1' }, side: 'enemy' });
  });

  it('the action beat carries the actor, the target, the command and the resolved action', () => {
    const onEvent = recorder();
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 500 })], rng: flat, onEvent });
    playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')]);
    const beat = onEvent.of('action')[0].payload;
    expect(beat.actor.uid).toBe('a1');
    expect(beat.target.uid).toBe('e1');
    expect(beat.command).toEqual({ actorUid: 'a1', type: 'attack', targetUid: 'e1' });
    expect(beat.action).toMatchObject({ kind: 'attack', power: 1, element: null, weaponType: 'sword' });
  });

  it('emits immune with the element and a zero-damage result', () => {
    const onEvent = recorder();
    const wall = foe({ maxHP: 500, immunities: ['physical'] });
    const b = createBattle({ allies: [ally()], enemies: [wall], rng: flat, onEvent });
    playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')]);
    const beat = onEvent.of('immune')[0].payload;
    expect(beat.element).toBe('physical');
    expect(beat.damage).toMatchObject({ amount: 0, mult: 0, effectiveness: 'immune', dead: false });
    expect(beat.target.currentHP).toBe(500);
  });

  it('emits heal for a heal skill and spends its MP', () => {
    const onEvent = recorder();
    const skills = { mend: { id: 'mend', name: 'Mend', kind: 'heal', power: 1, target: 'ally', mp: 3 } };
    const hurt = ally({ uid: 'a2', currentHP: 40 });
    const caster = ally({ uid: 'a1', magic: 8, skills: ['mend'], speed: 12 });
    const b = createBattle({ allies: [caster, hurt], enemies: [foe({ maxHP: 500, speed: 1 })], skills, rng: flat, onEvent });
    playRound(b, [{ actorUid: 'a1', type: 'skill', targetUid: 'a2', actionId: 'mend' }, attack('e1', 'a1'), attack('a2', 'e1')]);

    const [beat] = onEvent.of('heal');
    expect(beat.payload).toMatchObject({
      caster: { uid: 'a1' }, target: { uid: 'a2' },
      amount: 8, hpBefore: 40, hpAfter: 48, source: 'skill',
    });
    expect(caster.currentMP).toBe(17);
  });

  it('emits miss when the target is already down (no retarget)', () => {
    const onEvent = recorder();
    const a1 = ally({ uid: 'a1', speed: 12 });
    const a2 = ally({ uid: 'a2', speed: 11 });
    const e1 = foe({ uid: 'e1', maxHP: 10, speed: 10 });   // a1 one-shots it
    const e2 = foe({ uid: 'e2', maxHP: 500, speed: 5 });
    const b = createBattle({ allies: [a1, a2], enemies: [e1, e2], rng: flat, onEvent });

    // both allies aimed at e1, and e1 also queued a swing of its own
    playRound(b, [attack('a1', 'e1'), attack('a2', 'e1'), attack('e1', 'a1'), attack('e2', 'a1')]);

    const fizzle = onEvent.of('miss').find((e) => e.payload.reason === 'target-down');
    expect(fizzle.payload.actor.uid).toBe('a2');
    expect(fizzle.payload.target.uid).toBe('e1');
    expect(e2.currentHP).toBe(500); // the damage was NOT redirected to a live enemy
  });

  it('emits miss with actor-down when a combatant dies before their command lands', () => {
    const onEvent = recorder();
    const a1 = ally({ uid: 'a1', speed: 12 });
    const a2 = ally({ uid: 'a2', speed: 11 });
    const e1 = foe({ uid: 'e1', maxHP: 10, speed: 10 });
    const e2 = foe({ uid: 'e2', maxHP: 500, speed: 5 });
    const b = createBattle({ allies: [a1, a2], enemies: [e1, e2], rng: flat, onEvent });

    playRound(b, [attack('a1', 'e1'), attack('a2', 'e1'), attack('e1', 'a1'), attack('e2', 'a1')]);

    const gone = onEvent.of('miss').find((e) => e.payload.reason === 'actor-down');
    expect(gone.payload.actor.uid).toBe('e1');
    expect(a1.currentHP).toBe(100 - 1); // e2 still got its swing in
  });

  it('emits miss with no-mp when the caster cannot pay', () => {
    const onEvent = recorder();
    const skills = { bolt: { id: 'bolt', name: 'Bolt', kind: 'attack', element: 'fire', power: 2, target: 'enemy', mp: 5 } };
    const broke = ally({ currentMP: 1, skills: ['bolt'] });
    const b = createBattle({ allies: [broke], enemies: [foe({ maxHP: 500, speed: 1 })], skills, rng: flat, onEvent });
    playRound(b, [{ actorUid: 'a1', type: 'skill', targetUid: 'e1', actionId: 'bolt' }, attack('e1', 'a1')]);
    expect(onEvent.of('miss')[0].payload.reason).toBe('no-mp');
    expect(b.get('e1').currentHP).toBe(500);
  });

  it('emits miss for an unknown skill id instead of silently swapping in a basic attack', () => {
    const onEvent = recorder();
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 500, speed: 1 })], rng: flat, onEvent });
    playRound(b, [{ actorUid: 'a1', type: 'skill', targetUid: 'e1', actionId: 'nope' }, attack('e1', 'a1')]);
    expect(onEvent.of('miss')[0].payload.reason).toBe('unknown-skill');
    expect(b.get('e1').currentHP).toBe(500);
  });

  it('emits end with the result, the round and both rosters', () => {
    const onEvent = recorder();
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 10 })], rng: flat, onEvent });
    playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')]);
    const [beat] = onEvent.of('end');
    expect(beat.payload.result).toBe('victory');
    expect(beat.payload.round).toBe(1);
    expect(beat.payload.allies).toHaveLength(1);
    expect(beat.payload.enemies).toHaveLength(1);
    expect(beat.payload.timeline).toHaveLength(2);
  });

  it('goes silent after dispose', () => {
    const onEvent = recorder();
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 10 })], rng: flat, onEvent });
    b.dispose();
    playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')]);
    expect(onEvent.events).toHaveLength(0);
    expect(b.state).toBe('victory'); // logic still ran
  });

  it('survives a missing onEvent', () => {
    const b = createBattle({ allies: [ally()], enemies: [foe({ maxHP: 10 })], rng: flat });
    expect(() => playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')])).not.toThrow();
    expect(b.state).toBe('victory');
  });
});

describe('battle — command types', () => {
  it('defend halves incoming damage and clears at the start of the next turn', () => {
    const onEvent = recorder();
    // the brute is SLOWER, so the guard is actually up before it swings
    const tank = foe({ maxHP: 500, attack: 20, speed: 1 });
    const b = createBattle({ allies: [ally()], enemies: [tank], rng: flat, onEvent });
    // raw hit would be (1*20)/10 = 2, halved to 1
    playRound(b, [{ actorUid: 'a1', type: 'defend', targetUid: 'a1' }, attack('e1', 'a1')]);
    expect(b.get('a1').currentHP).toBe(100 - Math.floor(2 * DEFEND_MULT));
    expect(b.get('a1').defending).toBe(true);

    playRound(b, [attack('a1', 'e1'), attack('e1', 'a1')]);
    expect(b.get('a1').defending).toBe(false); // reset by beginTurn
    expect(b.get('a1').currentHP).toBe(100 - Math.floor(2 * DEFEND_MULT) - 2);
  });

  it('a guard is not up before your own turn has resolved', () => {
    const tank = foe({ maxHP: 500, attack: 20, speed: 12 }); // faster than the ally
    const b = createBattle({ allies: [ally()], enemies: [tank], rng: flat, onEvent: recorder() });
    playRound(b, [{ actorUid: 'a1', type: 'defend', targetUid: 'a1' }, attack('e1', 'a1')]);
    expect(b.get('a1').currentHP).toBe(98); // took the full 2
  });

  it('an item heal emits heal with the item source and does not overheal', () => {
    const onEvent = recorder();
    const items = { tonic: { id: 'tonic', name: 'Tonic', kind: 'heal', power: 4, target: 'ally' } };
    const hurt = ally({ uid: 'a2', currentHP: 90 });
    const b = createBattle({
      allies: [ally({ uid: 'a1', magic: 5, items: ['tonic'], speed: 12 }), hurt],
      enemies: [foe({ maxHP: 500, speed: 1 })], items, rng: flat, onEvent,
    });
    playRound(b, [{ actorUid: 'a1', type: 'item', targetUid: 'a2', itemId: 'tonic' }, attack('a2', 'e1'), attack('e1', 'a1')]);
    const [beat] = onEvent.of('heal');
    expect(beat.payload).toMatchObject({ caster: { uid: 'a1' }, target: { uid: 'a2' }, amount: 10, hpAfter: 100, source: 'item' });
  });

  it('an mp item restores MP through the same heal beat', () => {
    const onEvent = recorder();
    const items = { ether: { id: 'ether', name: 'Ether', kind: 'mp', power: 6, target: 'ally' } };
    const b = createBattle({
      allies: [ally({ uid: 'a1', currentMP: 2, items: ['ether'] })],
      enemies: [foe({ maxHP: 500, speed: 1 })], items, rng: flat, onEvent,
    });
    playRound(b, [{ actorUid: 'a1', type: 'item', targetUid: 'a1', itemId: 'ether' }, attack('e1', 'a1')]);
    expect(onEvent.of('heal')[0].payload).toMatchObject({ amount: 6, mpBefore: 2, mpAfter: 8, hpAfter: 100 });
  });

  it('a revive item brings a downed target back at half HP', () => {
    const onEvent = recorder();
    const items = { phoenix: { id: 'phoenix', name: 'Phoenix', kind: 'revive', power: 1, target: 'ally' } };
    const downed = ally({ uid: 'a2', currentHP: 0 });
    const b = createBattle({
      allies: [ally({ uid: 'a1', items: ['phoenix'], speed: 1 }), downed],
      enemies: [foe({ maxHP: 500, speed: 2 })], items, rng: flat, onEvent,
    });
    // the downed ally has no turn this round, so only the two living ones submit
    playRound(b, [{ actorUid: 'a1', type: 'item', targetUid: 'a2', itemId: 'phoenix' }, attack('e1', 'a1')]);
    expect(downed.currentHP).toBe(50);
    expect(onEvent.of('heal')[0].payload).toMatchObject({ target: { uid: 'a2' }, hpBefore: 0, hpAfter: 50, source: 'item' });
  });

  it('a downed combatant is dropped from pending and the turn order', () => {
    const b = createBattle({
      allies: [ally({ uid: 'a1' }), ally({ uid: 'a2', currentHP: 0 })],
      enemies: [foe({ uid: 'e1', maxHP: 500 })], rng: flat, onEvent: recorder(),
    });
    toCommand(b);
    expect(b.pending.map((c) => c.uid)).toEqual(['a1', 'e1']);
    expect(() => b.submitCommand(attack('a2', 'e1'))).toThrow(/no turn this round/);
  });

  it('a buff skill applies Boost, it does not swing', () => {
    const onEvent = recorder();
    const skills = { guard_up: { id: 'guard_up', name: 'Guard Up', kind: 'buff', element: null, weaponType: 'sword', power: 6, mp: 3, target: 'self', critRate: 0 } };
    const caster = ally({ skills: ['guard_up'], speed: 12 });
    const b = createBattle({
      allies: [caster, ally({ uid: 'a2' })],
      enemies: [foe({ uid: 'e1', maxHP: 500, speed: 1 })], skills, rng: flat, onEvent,
    });
    playRound(b, [
      { actorUid: 'a1', type: 'skill', targetUid: 'a1', actionId: 'guard_up' },
      attack('a2', 'e1'),
      { actorUid: 'e1', type: 'defend', targetUid: 'e1' }, // so nothing breaks the Boost
    ]);

    expect(caster.boosted).toBe(true);
    expect(caster.currentHP).toBe(100); // no self-inflicted damage
    expect(caster.currentMP).toBe(17);
    expect(onEvent.of('boost')[0].payload).toMatchObject({ target: { uid: 'a1' }, actor: { uid: 'a1' }, gained: true });
    expect(onEvent.of('damage')).toHaveLength(1); // only a2's swing landed
  });

  it('a buff skill on an ally targets that ally', () => {
    const onEvent = recorder();
    const skills = { bulwark: { id: 'bulwark', name: 'Bulwark', kind: 'buff', element: null, weaponType: 'axe', power: 8, mp: 5, target: 'ally' } };
    const b = createBattle({
      allies: [ally({ uid: 'a1', skills: ['bulwark'], speed: 12 }), ally({ uid: 'a2' })],
      enemies: [foe({ uid: 'e1', maxHP: 500, speed: 1 })], skills, rng: flat, onEvent,
    });
    playRound(b, [
      { actorUid: 'a1', type: 'skill', targetUid: 'a2', actionId: 'bulwark' },
      attack('a2', 'e1'),
      attack('e1', 'a1'),
    ]);
    expect(b.get('a2').boosted).toBe(true);
    expect(b.get('a1').boosted).toBe(false);
  });
});

describe('battle — scripted victory', () => {
  it('two allies focus down a weak slime and the battle reports victory', async () => {
    const onEvent = recorder();
    const a1 = ally({ uid: 'a1', name: 'Olrik', speed: 11 });
    const a2 = ally({ uid: 'a2', name: 'Tess', speed: 10 });
    const slime = foe({ uid: 'e1', name: 'Bog Slime', maxHP: 20, currentHP: 20 });
    const b = createBattle({ allies: [a1, a2], enemies: [slime], rng: flat, onEvent });

    // 10 damage a hit (1*20/1 * 1.0 * 0.5) -> exactly two hits kill it
    const log = await playRound(b, [attack('a1', 'e1'), attack('a2', 'e1'), attack('e1', 'a1')]);

    expect(slime.currentHP).toBe(0);
    expect(b.state).toBe('victory');
    expect(b.result).toBe('victory');
    expect(b.isOver).toBe(true);
    expect(a1.currentHP).toBe(100); // the slime never got a swing in
    expect(log.map((e) => e.actorName)).toEqual(['Olrik', 'Tess']);
    expect(log.map((e) => e.amount)).toEqual([10, 10]);
    expect(onEvent.of('down').map((e) => e.payload.target.uid)).toEqual(['e1']);
    expect(onEvent.of('end')[0].payload.result).toBe('victory');
  });

  it('the enemy is still asked for a command before the party kills it', () => {
    const b = createBattle({
      allies: [ally({ uid: 'a1' })],
      enemies: [foe({ uid: 'e1', maxHP: 10 })], rng: flat, onEvent: recorder(),
    });
    toCommand(b);
    b.submitCommand(attack('a1', 'e1'));
    expect(b.state).toBe('command'); // the enemy command is still owed
    b.submitAiCommand(chooseEnemyCommand(b.get('e1'), b, flat));
    expect(b.state).toBe('victory');
  });

  it('a live AI plus the state machine runs a multi-round fight to victory', async () => {
    const onEvent = recorder();
    const a1 = ally({ uid: 'a1', speed: 14, attack: 30 });
    const a2 = ally({ uid: 'a2', speed: 13, attack: 30 });
    const e1 = foe({ uid: 'e1', speed: 5, maxHP: 40, currentHP: 40 });
    const b = createBattle({ allies: [a1, a2], enemies: [e1], rng: flat, onEvent });

    let guard = 0;
    while (!b.isOver && guard++ < 10) {
      await playRound(b, [
        attack('a1', 'e1'),
        attack('a2', 'e1'),
        chooseEnemyCommand(e1, b, flat),
      ]);
    }

    expect(b.result).toBe('victory');
    expect(b.round).toBe(2); // 15 damage a hit -> 3 hits -> two rounds
    expect(e1.currentHP).toBe(0);
    expect(a1.currentHP).toBeLessThan(100); // the AI did land a hit
    expect(onEvent.of('end')).toHaveLength(1);
  });
});

describe('battle — scripted defeat', () => {
  it('a lone ally against two brutes is wiped and the party is left at 1 HP', async () => {
    const onEvent = recorder();
    const hero = ally({ uid: 'a1', maxHP: 10, currentHP: 10, defense: 1, speed: 1 });
    const brute1 = foe({ uid: 'e1', speed: 9, attack: 50, maxHP: 500, currentHP: 500 });
    const brute2 = foe({ uid: 'e2', speed: 8, attack: 50, maxHP: 500, currentHP: 500 });
    const b = createBattle({ allies: [hero], enemies: [brute1, brute2], rng: flat, onEvent });

    const log = await playRound(b, [
      attack('a1', 'e1'),
      chooseEnemyCommand(brute1, b, flat),
      chooseEnemyCommand(brute2, b, flat),
    ]);

    expect(b.state).toBe('defeat');
    expect(b.result).toBe('defeat');
    expect(b.isOver).toBe(true);
    expect(hero.currentHP).toBe(1); // the overworld hand-off contract
    expect(onEvent.of('down').map((e) => e.payload.side)).toEqual(['ally']);
    expect(onEvent.of('end')[0].payload.result).toBe('defeat');
    // the battle stopped the instant the party fell — the second brute never swung
    expect(log.map((e) => e.actorUid)).toEqual(['e1']);
  });

  it('the round stops resolving once a side is wiped', async () => {
    const hero = ally({ uid: 'a1', maxHP: 10, currentHP: 10, defense: 1, speed: 1 });
    const e1 = foe({ uid: 'e1', speed: 9, attack: 50, maxHP: 500, currentHP: 500 }); // one-shots
    const e2 = foe({ uid: 'e2', speed: 8, attack: 1, maxHP: 500, currentHP: 500 });  // 0 damage
    const b = createBattle({ allies: [hero], enemies: [e1, e2], rng: flat, onEvent: recorder() });
    const log = await playRound(b, [attack('a1', 'e1'), attack('e1', 'a1'), attack('e2', 'a1')]);
    expect(log).toHaveLength(1);
    expect(hero.currentHP).toBe(1);
  });

  it('a battle with no enemies is won on the first frame', () => {
    const onEvent = recorder();
    const b = createBattle({ allies: [ally()], enemies: [], rng: flat, onEvent });
    b.update(1 / 60);
    expect(b.state).toBe('victory');
    expect(onEvent.of('end')).toHaveLength(1);
  });

  it('a battle with no allies is lost on the first frame', () => {
    const onEvent = recorder();
    const b = createBattle({ allies: [], enemies: [foe()], rng: flat, onEvent });
    b.update(1 / 60);
    expect(b.state).toBe('defeat');
  });

  it('a turn log is produced per resolved command', async () => {
    const b = createBattle({
      allies: [ally({ uid: 'a1', speed: 12, magic: 8 })],
      enemies: [foe({ uid: 'e1', maxHP: 500, speed: 1 })],
      skills: { mend: { id: 'mend', name: 'Mend', kind: 'heal', power: 1, target: 'ally', mp: 1 } },
      rng: flat, onEvent: recorder(),
    });
    const log = await playRound(b, [
      { actorUid: 'a1', type: 'skill', targetUid: 'a1', actionId: 'mend' },
      attack('e1', 'a1'),
    ]);
    expect(log).toEqual([
      { actorUid: 'a1', actorName: 'Olrik', type: 'skill', targetUid: 'a1', targetName: 'Olrik', outcome: 'heal', amount: 0, result: null },
      { actorUid: 'e1', actorName: 'Bog Slime', type: 'attack', targetUid: 'a1', targetName: 'Olrik', outcome: 'damage', amount: 1, result: expect.objectContaining({ amount: 1 }) },
    ]);
    expect(b.log).toHaveLength(2);
  });
});
