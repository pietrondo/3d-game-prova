/**
 * src/battle/stage.js — the battle as the player sees it.
 *
 * Owns: the enemy actors and where they stand, the camera dolly, the damage
 * numbers, the boost / weakness / damage flashes, the onEvent -> animation map,
 * and the lifecycle of one encounter (arm -> dolly -> form up -> fight -> tear
 * down). The director in game.js owns the world and the black-screen transition;
 * this module owns everything that only exists while a fight is on screen.
 *
 * Decisions worth keeping:
 *
 * - An enemy is built HIDDEN and only revealed once `formUp` has placed it. A
 *   freshly created actor sits at the world origin (0,0,0) because that is where
 *   createActor starts, and the origin is the middle of the map: creating it
 *   visible puts a sprite in the middle of the overworld for the length of the
 *   pan-in. That is the whole "giant spike in the middle of the island" report.
 * - ENEMY_HEIGHT is 1.9, not the cell size and not 4x the party. The party is
 *   1.6 world units (actors/party.js) and actor.js scales a sheet so the DRAWN
 *   figure is worldHeight tall, so this is measured in the same unit as the
 *   party: a Sentinel reads ~19% taller, which is a boss, not a monument.
 * - `bail()` (the timeout path) settles the `done` promise so `run()` returns
 *   and the director reaches its single teardown call. The old code disposed
 *   the battle and left the enemy sprites standing in the overworld AND left
 *   runBattle awaiting a promise nothing would ever resolve, which wedged the
 *   encounter lock for the rest of the session.
 * - 'turn' comes from combat/battle.js (contracts §16) and drives the banner.
 *   Reading `battle.current` every frame was a second, drifting source of truth
 *   for the same fact.
 */

import * as THREE from 'three';
import { tween, wait, Ease } from '../core/tween.js';
import { createActor } from '../actors/actor.js';
import { buildEnemySheet } from '../actors/spriteFactory.js';
import { createBattle } from '../combat/battle.js';
import { chooseEnemyCommand } from '../combat/ai.js';
import { createCommandPrompt, createCommander } from './commands.js';

import ENEMIES from '../data/enemies.json';
import SKILLS from '../data/skills.json';
import ITEMS from '../data/items.json';

const ENEMY_HEIGHT = 1.9;      // world units; the party is 1.6
const ENEMY_SPACING = 1.9;     // world units between two enemies on the line
const FOV_BATTLE = 30;
const DOF_BATTLE = { dofStrength: 0.16, dofFocus: 40, dofRange: 60 };
const BATTLE_TIMEOUT = 600;
const PUNCH = 2.6;             // fov dip at the swing

/** The Combatant shape of contracts §16, built from a data/*.json entry. */
export function toCombatant(def, uid, side) {
  return {
    uid, side, name: def.name, level: def.level,
    maxHP: def.maxHP, currentHP: def.maxHP, maxMP: def.maxMP, currentMP: def.maxMP,
    attack: def.attack, defense: def.defense, magic: def.magic, speed: def.speed,
    weaponType: def.weaponType,
    // Brann and the Sentinel omit `lightning` on purpose: `immunities` is the
    // single source of truth. Do not "helpfully" fill the gap.
    resistances: { ...(def.resistances || {}) },
    immunities: [...(def.immunities || [])],
    vulnerabilities: [...(def.vulnerabilities || [])],
    skills: [...(def.skills || [])],
    items: [...(def.items || [])],
    defending: false, boosted: false,
  };
}

export function createStage({
  engine, terrain, party, root, allies, actorOf, popY, hud,
  input, hitStop, syncHud, fade, fovWorld, dofWorld, rng, bag = null,
}) {
  let battle = null;
  let enemyActors = [];
  let battleIds = [];
  let asking = false;
  let queue = [];
  let draining = false;
  let brokeBoost = false;
  let battleDone = null;
  let timedOut = false;

  const prompt = createCommandPrompt({ root, input });
  const commander = createCommander({ prompt, skills: SKILLS, rng, chooseEnemyCommand, bag });

  // -------------------------------------------------------------- camera ---
  const setFov = (v) => {
    if (Math.abs(engine.camera.fov - v) < 0.005) return;
    engine.camera.fov = v;
    engine.camera.updateProjectionMatrix();
  };
  const dolly = (to, duration) =>
    tween({ from: engine.camera.fov, to, duration, ease: Ease.cubicOut, onUpdate: setFov }).finished;

  /** Camera push-in on the swing: dip the fov and spring it back. */
  const punchIn = (k = 1) => tween({
    duration: 0.36, ease: Ease.quadOut,
    onUpdate: (t) => setFov(FOV_BATTLE - Math.sin(Math.PI * t) * PUNCH * k),
  });

  // ------------------------------------------------------- floating text ---
  // Damage numbers have to clear the sprite, so the head is read from the same
  // worldHeight the actor was built with rather than guessed at.
  const headOf = (a) => new THREE.Vector3(
    a.position.x, a.position.y + (popY.get(a) || 1.6) + 0.55, a.position.z,
  );

  /** A pixel-hard number over a world point: overshoot in, rise, fade out. */
  function popAt(world, text, size, colour, rise = 46) {
    const p = world.clone().project(engine.camera);
    if (p.z > 1) return;
    const x = (p.x * 0.5 + 0.5) * engine.width;
    const y = (-p.y * 0.5 + 0.5) * engine.height;
    if (x < -60 || y < -40 || x > engine.width + 60 || y > engine.height + 40) return;
    const n = document.createElement('div');
    n.className = 'bt-pop';
    n.textContent = String(text);
    n.style.cssText = `left:${Math.round(x)}px;top:${Math.round(y)}px;font-size:${size}px;color:${colour}`;
    root.appendChild(n);
    tween({
      duration: 0.85, ease: Ease.linear,
      onUpdate: (t) => {
        const pop = t < 0.2 ? Ease.backOut(t / 0.2) : 1;
        n.style.transform = `translate(-50%,-50%) translateY(${(-rise * t).toFixed(1)}px) scale(${pop.toFixed(3)})`;
        n.style.opacity = String(t < 0.62 ? 1 : 1 - (t - 0.62) / 0.38);
      },
      onComplete: () => n.remove(),
    });
  }
  const popNum = (a, v, size, colour) => { if (a) popAt(headOf(a), v, size, colour); };
  const popTag = (a, t, colour, size) => { if (a) popAt(headOf(a), t, size || 17, colour, 28); };

  // ------------------------------------------------------------- staging ---
  /** Weighted pick from the zone's slice of the encounter table. */
  function pickEncounter(zone) {
    let table = Object.entries(ENEMIES).filter(([, d]) => (d.encounter?.zone || 'meadow') === zone);
    if (!table.length) table = Object.entries(ENEMIES);
    let roll = rng() * table.reduce((s, [, d]) => s + (d.encounter?.weight ?? 1), 0);
    for (const [id, d] of table) {
      roll -= d.encounter?.weight ?? 1;
      if (roll <= 0) return id;
    }
    return table[0][0];
  }
  const rollGroup = (zone) => {
    const n = zone === 'stone' ? (rng() < 0.4 ? 2 : 1) : (rng() < 0.55 ? 2 : 1);
    return Array.from({ length: n }, () => pickEncounter(zone));
  };

  const makeEnemyActor = (id) => {
    const d = ENEMIES[id];
    const cell = d.sprite.cell;
    // buildEnemySheet is one column wide, so an enemy may only ever face 'down'.
    // Battles are therefore staged with the enemy line up-screen (-z) so its
    // 'down' facing, and its attack lunge, point at the party.
    const sheet = buildEnemySheet({ kind: d.sprite.kind, palette: d.sprite.palette, cell });
    // alwaysOnTop: the enemy row is staged up-screen of the leader, in the band
    // the props are scattered through, and props are merged per type so none can
    // be culled. See actor.js — the party deliberately does NOT get this.
    const a = createActor({ sheet, cell, terrain, colliders: [], worldHeight: ENEMY_HEIGHT, speed: 2, alwaysOnTop: true });
    popY.set(a, ENEMY_HEIGHT);
    a.setVisible(false);          // see the header: origin-born sprites are the spike
    engine.scene.add(a.object3D);
    return a;
  };

  /**
   * Where to stage the fight, so both ranks land on walkable ground.
   *
   * The camera looks down +z, so smaller z is up-screen: the enemy line goes
   * up-screen facing 'down', the party diamond sits nearer the camera. An
   * unguarded +1.9 toward the camera walks straight off the island — measured on
   * a natural encounter: leader at z=33.98 (the last walkable row) put the
   * formation centre at z=35.88, `tileAt` = "water", and the party stood on the
   * sea at y=-0.12. So pull the offsets in until it fits.
   */
  function battleStage(lx, lz, n) {
    const xs = Array.from({ length: n }, (_, i) => lx + (i - (n - 1) / 2) * ENEMY_SPACING);
    for (const [back, away] of [[1.9, 3.0], [1.4, 2.6], [0.9, 2.2], [0.4, 1.8], [0, 1.4]]) {
      // DIAMOND in party.js has radius 0.85, so check the near point of the ring too.
      if (!terrain.isWalkable(lx, lz + back) || !terrain.isWalkable(lx, lz + back + 0.85)) continue;
      if (!xs.every((x) => terrain.isWalkable(x, lz - away))) continue;
      return { partyZ: lz + back, enemyZ: lz - away };
    }
    // The diamond is 0.85 deep, so a leader standing on the LAST walkable row
    // cannot host it in place however tight `back` gets. Slide the whole fight
    // inland until both ranks fit.
    for (let shift = 1; shift <= 6; shift++) {
      const pz = lz - shift;
      const ez = lz - shift - 1.6;
      if (terrain.isWalkable(lx, pz) && terrain.isWalkable(lx, pz + 0.85)
        && xs.every((x) => terrain.isWalkable(x, ez))) {
        return { partyZ: pz, enemyZ: ez };
      }
    }
    return { partyZ: lz, enemyZ: lz };   // boxed in: fight on the spot
  }

  async function formUp() {
    const l = party.leader.position;
    const { partyZ, enemyZ } = battleStage(l.x, l.z, enemyActors.length);
    enemyActors.forEach((a, i) => {
      a.setPosition(l.x + (i - (enemyActors.length - 1) / 2) * ENEMY_SPACING, enemyZ);
      a.face('down');
      a.setVisible(true);
      a.state = 'idle';
    });
    await party.enterBattleFormation(l.x, partyZ);
    party.members.forEach((m) => m.face('up'));
  }

  function arm(zone, forced) {
    // A forced group is an EXTERNAL input — the QA handle and level scripts pass
    // ids in. An id that is not in enemies.json used to reach `toCombatant(
    // undefined)` and die on `.name`, taking the whole session down mid-frame
    // with a TypeError and no battle on screen. Filter to known ids and fall
    // back to a real roll if nothing survives, so a bad id costs the caller its
    // request and not the game.
    const known = (forced || []).filter((id) => ENEMIES[id]);
    battleIds = known.length ? known : rollGroup(zone);
    const foes = battleIds.map((id, i) => toCombatant(ENEMIES[id], `e:${i}:${id}`, 'enemy'));
    enemyActors = foes.map((f, i) => {
      const a = makeEnemyActor(battleIds[i]);
      actorOf.set(f.uid, a);
      return a;
    });
    battle = createBattle({
      allies, enemies: foes, skills: SKILLS, items: ITEMS, rng,
      onEvent: (type, payload) => {
        queue.push([type, payload]);
        if (!draining) drain();
      },
    });
  }

  // ---------------------------------------------------- event -> animation ---
  const actorFor = (c) => (c ? actorOf.get(c.uid) : null);
  const facingToward = (a, b) => {
    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'right' : 'left') : (dz > 0 ? 'down' : 'up');
  };

  /**
   * Hard on/off hit flash that always returns to normal.
   *
   * Deliberately NOT actor.js's `playHurt`: that decays a flash gain, and
   * `color = hex * 2.6 * k` collapses toward black, so the last ~15% of every
   * hit renders the sprite as a black silhouette. A hard two-state flash is also
   * what Octopath's hit flash looks like, and it is the only way to honour
   * design.md's "gold on boost, white on weak" without touching a shared module.
   */
  function tintFlash(actor, hex, seconds) {
    if (!actor) return;
    actor.setTint(hex);
    wait(seconds).then(() => { if (actor.object3D.parent) actor.setTint(null); });
  }

  function handle(type, p) {
    const a = actorFor(p.actor);
    const t = actorFor(p.target);
    switch (type) {
      case 'turn':
        hud.setTurnHint(a ? `${p.actor.name}'s turn` : null);
        return wait(0.1);
      case 'action': {
        if (a && t) a.face(facingToward(a, t));
        const ct = p.command.type;
        const offensive = ct === 'attack' || (ct === 'skill' && p.action?.kind === 'attack');
        if (offensive && a) { punchIn(1); return a.playAttack(0.3).then(() => wait(0.08)); }
        if (a) {
          a.setTint(ct === 'boost' ? 0xffd060 : ct === 'defend' ? 0x8ab4ff : 0x9ff0c0);
          return wait(0.16).then(() => a.setTint(null));
        }
        return wait(0.1);
      }
      case 'boost':
        brokeBoost = !p.gained;
        if (t) t.setTint(0xffd050);
        popTag(t, p.gained ? 'BOOST' : 'BREAK', '#ffd050', 19);
        engine.shake(0.12, 0.2);
        return wait(0.22).then(() => t?.setTint(null));
      case 'weak':                                 // the target RESISTED the hit
        if (t) t.setTint(0xffffff);
        popTag(t, 'RESIST', '#c8c0d8', 16);
        return wait(0.14).then(() => t?.setTint(null));
      case 'immune':
        popTag(t, `IMMUNE ${String(p.element || '').toUpperCase()}`, '#8fb8e8', 18);
        return wait(0.3);
      case 'damage': {
        const r = p.result;
        const big = r.effectiveness === 'strong' || brokeBoost;
        brokeBoost = false;
        const size = big ? 42 : r.effectiveness === 'weak' ? 17 : 24;
        const colour = big ? '#ffd24a' : r.effectiveness === 'weak' ? '#a49cba'
          : r.crit ? '#ff8a4a' : '#f4ead6';
        // design.md §Game feel: gold flash on a boosted hit, white on a resisted one.
        tintFlash(t, big ? 0xffd050 : r.effectiveness === 'weak' ? 0xffffff : 0xff6a44, big ? 0.3 : 0.2);
        hitStop(big ? 0.1 : 0.055);
        engine.shake(big ? 0.55 : 0.18, big ? 0.36 : 0.2);
        if (r.amount > 0) {
          popNum(t, r.amount, size, colour);
          if (r.crit) popTag(t, 'CRIT', '#ff8a4a', 19);
        } else popTag(t, 'BLOCKED', '#8fb8e8', 17);
        return wait(big ? 0.11 : 0.06).then(() => { syncHud(); return wait(0.3); });
      }
      case 'heal':
        if (t) t.setTint(0x7fe0a0);
        popNum(t, `+${p.amount}`, 26, '#8bf0b0');
        return wait(0.3).then(() => { t?.setTint(null); syncHud(); });
      case 'recover':
        popNum(t, `+${p.amount}`, 22, '#8bf0b0');
        return wait(0.26).then(syncHud);
      case 'miss':
        popTag(t || a, p.reason === 'evaded' ? 'MISS' : '—', '#8a8299', 16);
        return wait(0.24);
      case 'down':
        if (t) t.state = 'dead';
        engine.shake(0.4, 0.3);
        popTag(t, 'DOWN', '#ff6a4a', 22);
        syncHud();
        return wait(0.42);
      case 'end':
        return wait(0.35);
      default:
        return wait(0.05);
    }
  }

  async function drain() {
    draining = true;
    while (queue.length) await handle(...queue.shift());
    draining = false;
    if (battle && battle.isOver && battleDone) {
      const done = battleDone;
      battleDone = null;
      done();
    }
  }

  // ----------------------------------------------------------- encounter ---
  /** Visual teardown. Runs under the black so nothing snaps on screen. */
  function teardown() {
    for (const a of enemyActors) { popY.delete(a); a.dispose(); }
    enemyActors = [];
    if (battle) { battle.dispose(); battle = null; }
    battleIds = [];
    prompt.cancel();
    actorOf.clear();
    party.members.forEach((m) => m.setVisible(true));
    syncHud();
    hud.setTurnHint(null);
    engine.setPostParams(dofWorld);
    setFov(fovWorld);
  }

  /**
   * A round that never resolves must not wedge the game loop. Unblock `run()`
   * and let it return, so the ONE teardown path (game.js calls teardown() right
   * after run() resolves) still disposes the enemies: tearing down here instead
   * would null `battle` out from under run()'s own `battle.result` read, and the
   * director would then never get past its `await`.
   */
  function bail(reason) {
    console.warn('[hd2d] battle timed out, bailing out');
    timedOut = true;
    asking = false;
    queue.length = 0;
    prompt.cancel();
    const done = battleDone;
    battleDone = null;
    if (done) done();
    hud.toast(reason, 2000);
  }

  async function run(zone, forced) {
    const cx = party.leader.position.x;
    const cz = party.leader.position.z;
    queue = [];
    brokeBoost = false;
    asking = false;
    timedOut = false;
    arm(zone, forced);
    await dolly(FOV_BATTLE, 0.7);      // hold the black for the pan-in
    engine.setPostParams(DOF_BATTLE);
    engine.shake(0.3, 0.3);
    await formUp();
    engine.setCameraTarget(cx, terrain.heightAt(cx, cz) + 1.6, cz);
    await fade(false);
    hud.setVisible(true);
    await new Promise((res) => { battleDone = res; });
    // defeat clamps every ally to 1 HP inside battle.js, so the overworld
    // hand-off cannot soft-lock even with nothing done here.
    const won = !timedOut && battle?.result === 'victory';
    const summary = {
      won,
      timedOut,
      loot: battleIds.reduce((s, id) => s + (ENEMIES[id].exp || 0), 0),
      gold: battleIds.reduce((s, id) => s + (ENEMIES[id].gold || 0), 0),
    };
    await wait(0.6);
    return summary;
  }

  /**
   * Per-frame battle bookkeeping. `dt` is real time (the battle clock and the
   * timeout must not slow down during hit-stop); `step` is the frozen step, which
   * is what the enemy sprites animate on.
   */
  function update(dt, step) {
    if (!battle) return;
    if (battle.isOver && prompt.isOpen) prompt.cancel();   // never strand an open prompt
    battle.update(dt);
    // battle.js opens the next round on the update AFTER resolveRound(), i.e. a
    // frame after that round's last event was emitted. Without this gate the
    // player is asked for round 2 while round 1's damage is still popping, so
    // they pick blind. Let the drain finish first.
    if (battle.state === 'command' && !asking && !prompt.isOpen && !draining && !queue.length) {
      asking = true;
      commander.collect(battle).finally(() => { asking = false; });
    }
    if (battle.elapsed > BATTLE_TIMEOUT && battleDone) bail('Battle lost in the confusion');
    for (const a of enemyActors) a.update(step);
  }

  return {
    run,
    update,
    teardown,
    prompt,
    /** QA-facing view of the command prompt. */
    get promptState() {
      return { open: prompt.isOpen, rows: prompt.rows, sel: prompt.sel };
    },
    // Read-only mirrors for the __hd2d QA handle.
    get asking() { return asking; },
    get draining() { return draining; },
    get queued() { return queue.length; },
    get live() { return !!battle; },
    get actorCount() { return enemyActors.length; },
    get battleInfo() {
      return battle ? { state: battle.state, round: battle.round, result: battle.result } : null;
    },
    dispose() {
      teardown();
      prompt.dispose();
    },
  };
}
