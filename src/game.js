/**
 * src/game.js — owner: AGENT-INTEGRATION. The director (contracts.md §21).
 *
 * Owns the engine, sky, terrain, props, party, HUD, dialogue, menu, the
 * overworld <-> battle transition and the main loop. Everything that only
 * exists while a fight is on screen lives in src/battle/ (stage.js: the actors,
 * the camera, the event animations; commands.js: the command list). Every
 * phase-1 module is reached through its frozen signature; nothing here touches
 * another module's internals.
 *
 * Decisions that integration-notes.md did not cover, recorded because they are
 * the ones a later reader will question:
 *
 * - SPAWN is (20.5, 28.5), NOT the (20, 20) the notes recommend. Verified with a
 *   BFS over `terrain.isWalkable`: the mesa at (20, 20) is sealed by a complete
 *   cliff ring, so it is a 44-cell walled arena, while (20, 28) reaches all 495
 *   walkable cells of the island. Spawning as advised traps the player on the
 *   plateau and pins the encounter table to the `stone` zone forever. The
 *   plateau is still there to look at, from below, which is how the world agent
 *   described it ("a visible plateau you cannot climb").
 * - PROP_DENSITY 0.32, not the contract's 0.08 (notes: 0.08 leaves it bare).
 * - `sky.update(dt, engine.camera)` — the second argument pins the dome to the
 *   eye and is what stops the sun parallaxing as the camera pans.
 * - hud / dialogue / menu are NEVER ticked with `update(dt)`: they self-tick, and
 *   a second tick double-advances the typewriter.
 * - `Esc` (the `cancel` action) opens the menu, `Tab` (the `menu` action) toggles
 *   the contextual hint. core/input.js binds those two keys that way and is
 *   frozen, so the two requirements are met by routing them like this rather than
 *   by touching the key map.
 * - The battle dolly-in tweens `camera.fov`. `setCameraTarget` + `shake` are the
 *   only camera levers the frozen engine exposes, and fov is the only one that
 *   reads as a dolly. FOV_WORLD is 34 — see the constant for the measurement
 *   behind it. BUG 9 was measured, not assumed — see the report.
 * - The turn banner is driven by the 'turn' event from combat/battle.js
 *   (contracts §16), not by polling `battle.current` every frame. That is what
 *   the old header admitted to working around; the event exists now.
 * - `walked` counts the distance the leader ACTUALLY covered. actor.js's slide()
 *   deflects sideways around props, so the requested step is not the travelled
 *   step; counting the requested one inflated the encounter counter by up to
 *   ~1.7x while walking through the wood (measured: 7.7 units "walked" for 4.5
 *   units of real travel).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createEngine } from './core/engine.js';
import { createInput } from './core/input.js';
import { tween, wait, Ease } from './core/tween.js';
import { createParty } from './actors/party.js';
import { createHud } from './ui/hud.js';
import { createDialogue } from './ui/dialogue.js';
import { createMenu } from './ui/menu.js';
import { createStage, toCombatant } from './battle/stage.js';
import { el } from './battle/commands.js';
import { createInventory } from './core/inventory.js';
import { createLevel, EVENTS } from './core/level.js';
import { createSave, savedAreaId } from './core/save.js';
import { createTitle } from './ui/title.js';
import { createShop } from './ui/shop.js';
import { createArea } from './game/area.js';
import { AREAS, START_AREA } from './game/areas.js';
import { installQaHandle } from './game/qa.js';
import './battle/battle.css';

import PROPS from './data/props.json';
import ACTORS from './data/actors.json';
import SKILLS from './data/skills.json';
import ITEMS from './data/items.json';
import INFO from './data/info.json';
import SHOP from './data/shop.json';

const PARTY_IDS = ['olrik', 'brann', 'tess', 'maren'];   // formation + HUD order
const DEADZONE = 0.85;   // world units the leader may wander before the camera moves
const LEAD_AHEAD = 0.7;
const WALK_SPEED = 3.4;
const SPRINT = 1.7;
// 2.2, not the 1.5 of contracts.md §21: props push colliders and the leader
// slides around them, so the closest reachable spot to a marker is often ~1.7
// away. At 1.5 you stand right under the "!" and E silently does nothing.
const TALK_RANGE = 2.2;
const ROLLS_MIN = 5;     // metres of walking between encounter rolls
const ROLLS_MAX = 11;
const ROLLS_GRACE = 9;   // metres of peace after a battle or a conversation
// 34, not the rig's native 30 and not the 40 the previous pass settled on.
// Measured on 1280x720: 40 puts a 1.6-unit party member at 49px and leaves a
// ring of empty sea on three sides; 34 puts it at 58px (+18%) and still shows
// the island's beach on the left, right and bottom, so it reads as a diorama.
// 30 crops the top of the island and 26 is "standing in a wood", not a
// diorama. FOV is also the only framing lever that is free of side effects:
// engine.js derives uFocusDistance from the anchor-to-camera DISTANCE, so
// changing the fov cannot move what is in focus.
const FOV_WORLD = 34;
const DOF_WORLD = { dofStrength: 0.32, dofFocus: 34, dofRange: 50 };
const RUSTLE = 0.4;      // seconds of grass pop before the screen goes black
const STONE_TILES = new Set(['stone', 'cliff']);
const SUN_DIR = new THREE.Vector3(0.6, 0.7, 0.4).normalize();

export async function createGame({ canvas, uiRoot }) {
  const engine = createEngine(canvas);
  const input = createInput(window);
  const rng = Math.random;

  // The area this session is in, and its level definition. A transition rebinds
  // them, which is why they are `let` and why the world is a factory: it can be
  // built and thrown away, so a second area is a lookup and not a second copy of
  // the game.
  //
  // WHICH area comes from the save. A resumed game is in the area it was saved
  // in, and the party's (x, z) is meaningless anywhere else — resuming into the
  // start area would drop the party at coordinates from another map.
  const bootAreaId = savedAreaId() ?? START_AREA;
  let area = createArea({ engine, def: AREAS[bootAreaId] ?? AREAS[START_AREA] });
  let { sky, terrain, village, props, colliders, spawn } = area;
  let MARKERS = area.def.markers;   // CONTENT, from data/markers.json
  let LEVEL = area.def.level;       // this area's level definition

  // ---------------------------------------------------------------- state ---
  let mode = 'title';            // title | overworld | dialogue | menu | transition | battle
  let raf = 0;
  let elapsed = 0;
  let disposed = false;
  let freeze = 0;
  let encounterLock = false;
  let hintOn = true;
  let hintText = null;
  let walked = 0;
  let nextRoll = ROLLS_GRACE;

  // ---------------------------------------------------------------- world ---
  // The world — sky, terrain, terrace, village, props, colliders, spawn — is built
  // by `createArea` from the area registry. The director keeps the PARTY, because
  // the party is the player and has to survive a transition, and aliases to the
  // area's own searches so the call sites read as they did when this was one file.
  //
  // Every one of these is rebound by `enterArea()`: an actor captures its terrain
  // and its collider set in its own closure, so a new area means new actors, and
  // `createStage` captures the terrain and the party, so the stage is rebuilt too.
  let party;
  function buildParty() {
    party = createParty({
      memberIds: PARTY_IDS, data: ACTORS, terrain, colliders, scene: engine.scene,
    });
  }
  buildParty();
  let { clearSpot, markerSpot, inVillage } = area;

  /**
   * Put the WHOLE party at (x, z) as a short trail, every member cleared against
   * the colliders.
   *
   * Used by both a fresh start and a save restore, and it exists because a save
   * records only the LEADER's position. Restoring the leader alone left the three
   * followers at their boot positions by the village, and on the first overworld
   * frame `party.follow` sent them walking across the island — hidden once they
   * were further than MAX_DIST, so a resumed game appeared to have lost three of
   * its four members and then slowly gathered them back.
   */
  function placeParty(x, z) {
    party.members.forEach((m, i) => {
      const s = clearSpot(x, z - i * 0.9);
      m.setPosition(s.x, s.z);
    });
  }

  const allies = PARTY_IDS.map((id) => toCombatant(ACTORS[id], `a:${id}`, 'ally'));
  // The bag: gold and item counts. `ITEMS` is the catalogue (what exists),
  // this is what the party is actually carrying. Battle.js has implemented
  // items since the contract was written; this is what makes that code reachable.
  const bag = createInventory(ITEMS);
  // uid -> the 3D actor that plays it. Rebuilt by syncActors() after every battle.
  const actorOf = new Map();
  // actor -> its worldHeight, so the damage numbers can clear the sprite.
  const popY = new Map();
  const syncActors = () => {
    actorOf.clear();
    party.members.forEach((m, i) => { actorOf.set(allies[i].uid, m); popY.set(m, 1.6); });
  };

  // ------------------------------------------------------------------- UI ---
  const hud = createHud(uiRoot);
  const dialogue = createDialogue(uiRoot);
  const menu = createMenu(uiRoot);
  // The blacksmith's counter. It exists because items.json prices three items,
  // battles award gold, and nothing spent it: the economy was a number that only
  // grew, against an NPC whose line already promised otherwise.
  const shop = createShop(uiRoot, { input });

  const fadeEl = el('div');
  fadeEl.className = 'fade';
  uiRoot.appendChild(fadeEl);
  const fade = async (on) => { fadeEl.classList.toggle('is-active', on); await wait(0.24); };

  function syncHud() {
    hud.setParty(allies.map((a) => ({
      name: a.name, currentHP: a.currentHP, maxHP: a.maxHP,
      currentMP: a.currentMP, maxMP: a.maxMP, boosted: a.boosted,
    })));
    party.members.forEach((m, i) => { m.state = allies[i].currentHP <= 0 ? 'dead' : 'idle'; });
  }

  // hit-stop: the world holds still for a beat on impact
  const hitStop = (s) => { freeze = Math.max(freeze, s); };

  // -------------------------------------------------------------- camera ---
  let focusX = spawn.x;
  let focusZ = spawn.z;
  function followCamera() {
    const l = party.leader.position;
    // Deadzone: the focus only moves by the overflow past the box, so a small
    // wander never nudges the frame. engine.js lerps the rest of the way.
    const dx = l.x - focusX;
    const dz = l.z - focusZ;
    if (Math.abs(dx) > DEADZONE) focusX += (Math.abs(dx) - DEADZONE) * Math.sign(dx);
    if (Math.abs(dz) > DEADZONE) focusZ += (Math.abs(dz) - DEADZONE) * Math.sign(dz);
    const d = Math.hypot(dx, dz);
    // d is 0 whenever the leader is exactly on the focus, which is the resting
    // state — dividing first would put NaN in the camera anchor and blank the
    // whole scene. Fold lead/d into one factor so the resting case is 0 * 0.
    const k = d > 1e-4 && party.leader.state === 'walk' ? LEAD_AHEAD / d : 0;
    engine.setCameraTarget(
      focusX + dx * k,
      terrain.heightAt(focusX, focusZ) + 1.4,
      focusZ + dz * k,
    );
  }
  const followLeader = () => {
    focusX = party.leader.position.x;
    focusZ = party.leader.position.z;
  };

  // -------------------------------------------------------------- markers ---
  const markTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#0d0b14'; g.fillRect(5, 0, 6, 16);
    g.fillStyle = '#f0c860'; g.fillRect(6, 1, 4, 9); g.fillRect(6, 11, 4, 3);
    g.fillStyle = '#0d0b14'; g.fillRect(7, 3, 2, 6); g.fillRect(7, 11, 2, 1);
    const t = new THREE.CanvasTexture(c);
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  // Rebuilt on every area change, so this is a function and the two bindings are
  // `let`: a transition disposes the old sprites and builds the new area's. The
  // GROUP is reused (cleared, not replaced) so the scene graph keeps one node.
  /**
   * Marker progress, kept ACROSS a transition the same way HP and the bag are —
   * because a transition rebuilds the area, and rebuilding used to hand the player
   * back the wreck they had already emptied. Measured: after climbing to the
   * plateau and coming back down, the cache was lootable again, and the save taken
   * afterwards recorded it as unlooted.
   *
   * Keyed by AREA + id, not by id alone: two areas may both have a marker called
   * `vell` and they are different people. A bare id would mark the second area's
   * Vell as already-spoken the moment the first area's was.
   *
   * Declared BEFORE `buildMarkers` because that function recalls from this on its
   * very first call, and a `const` read before its line is a temporal-dead-zone
   * error — which is a crash at boot, not a warning.
   */
  const markerMemory = new Map();
  const markerKey = (id, markerId) => `${id}:${markerId}`;

  function rememberMarkers() {
    for (const m of markers) {
      markerMemory.set(markerKey(area.id, m.id), { used: !!m.used, visited: !!m.visited });
    }
  }

  function recallMarkers() {
    for (const m of markers) {
      const s = markerMemory.get(markerKey(area.id, m.id));
      if (s) { m.used = s.used; m.visited = s.visited; }
    }
  }

  let markerGroup = new THREE.Group();
  let markers = [];
  engine.scene.add(markerGroup);

  /** Place the current area's markers. Called at boot and on every transition. */
  function buildMarkers() {
    for (const m of markers) m.sprite.material.dispose();
    markerGroup.clear();
    markers = MARKERS.map((m, i) => {
      const at = markerSpot(m);
      // clearSpot against the VILLAGE colliders too: the elder stands beside the
      // well, and the marker nudge must not park the talking point inside a house.
      const spot = clearSpot(at.x, at.z);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: markTex, depthTest: false, transparent: true }));
      sprite.renderOrder = 5;
      sprite.scale.setScalar(0.7);
      sprite.position.set(spot.x, terrain.heightAt(spot.x, spot.z) + 1.5, spot.z);
      sprite.userData = { base: sprite.position.y, phase: i * 1.3 };
      markerGroup.add(sprite);
      return { ...m, x: spot.x, z: spot.z, sprite, used: false, visited: false };
    });
    recallMarkers();
  }
  buildMarkers();

  const nearestMarker = () => {
    const l = party.leader.position;
    let best = null;
    let bd = TALK_RANGE;
    for (const m of markers) {
      const d = Math.hypot(m.x - l.x, m.z - l.z);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  };

  // ------------------------------------------------------ grass rustle set ---
  const tufts = (() => {
    const def = PROPS.grassTuft;
    const blades = [];
    for (let i = 0; i < 3; i++) {
      const b = new THREE.BoxGeometry(0.07, def.height, 0.07);
      b.rotateZ((i - 1) * 0.24);
      b.rotateY((i / 3) * Math.PI);
      b.translate(0, def.height / 2, 0);
      blades.push(b.toNonIndexed());
    }
    const geo = mergeGeometries(blades, false);
    blades.forEach((b) => b.dispose());
    const mat = new THREE.MeshStandardMaterial({ color: def.color, flatShading: true, roughness: 1 });
    const group = new THREE.Group();
    const list = [];
    for (let i = 0; i < 18; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      group.add(m);
      list.push(m);
    }
    engine.scene.add(group);
    return { group, mat, geo, list };
  })();

  /**
   * The Octopath beat: the grass around the party shakes a beat before battle.
   *
   * One tween per tuft drives scale, roll and lift together. A pure scale pop
   * reads as GROWTH; the decaying roll is what makes it read as a shake. Ten
   * tufts at 1.5x was invisible at 24 units — 18 at 1.9x in a 3-unit ring
   * actually registers.
   */
  function rustle(x, z) {
    const n = tufts.list.length;
    tufts.list.forEach((m, i) => {
      const a = (i / n) * Math.PI * 2 + rng() * 0.5;
      const r = 0.9 + rng() * 2.1;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const baseY = terrain.heightAt(px, pz) - 0.05;
      m.position.set(px, baseY, pz);
      m.rotation.set(0, rng() * Math.PI, 0);
      m.visible = terrain.isWalkable(px, pz);
      const phase = rng() * 6.28;
      m.scale.setScalar(0.01);
      tween({
        duration: RUSTLE, delay: i * 0.012, ease: Ease.linear,
        onUpdate: (t) => {
          const pop = t < 0.28 ? Ease.backOut(t / 0.28) : 1 - 0.24 * ((t - 0.28) / 0.72);
          const s = 1.9 * pop;
          const wob = Math.sin(t * 34 + phase) * 0.2 * (1 - t);
          m.scale.set(s, s, s);
          m.rotation.z = wob;
          m.position.y = baseY + Math.abs(wob) * 0.5;
        },
        onComplete: () => { m.visible = false; m.rotation.z = 0; },
      });
    });
    return wait(RUSTLE);
  }

  // --------------------------------------------------------------- wander ---
  const zoneAt = (x, z) => (STONE_TILES.has(terrain.tileAt(x, z)) ? 'stone' : 'meadow');
  const resetWander = (gap) => { walked = 0; nextRoll = gap; };

  // ----------------------------------------------------------------- stage ---
  // Rebuilt by `enterArea`: the stage holds the terrain (it stages the battle on
  // it) and the party, and both are new after a transition.
  let stage;
  function buildStage() {
    stage = createStage({
      engine, terrain, party, root: uiRoot, allies, actorOf, popY, hud,
      input, hitStop, syncHud, fade, fovWorld: FOV_WORLD, dofWorld: DOF_WORLD, rng, bag,
    });
  }
  buildStage();

  async function startEncounter(zone, forced) {
    if (encounterLock) return;
    encounterLock = true;
    mode = 'transition';
    const l = party.leader.position;
    await rustle(l.x, l.z);            // grass pops first — the Octopath beat
    await fade(true);
    mode = 'battle';
    const { won, timedOut, loot, gold } = await stage.run(zone, forced);
    if (!timedOut) {
      if (won) {
        for (const a of allies) a.currentMP = Math.min(a.maxMP, a.currentMP + 4);
        // The gold used to end in a toast and vanish: items.json prices a
        // Phoenix Bloom at 120 oro and nothing could ever hold a coin.
        bag.addGold(gold);
        hud.toast(`Vittoria — ${loot} EXP, ${gold} oro`, 2400);
        // A won fight is how the level's battle stages are spent. This used to
        // call speakStage() directly, which showed the NEXT stage's lines
        // without ever spending the stage that the fight belonged to — so the
        // tutorial replayed the same fight forever and never advanced.
        await levelEvent(EVENTS.BATTLE);
      } else {
        hud.toast('Sconfitta — la squadra si risveglia sul ciglio', 2800);
      }
    }
    await fade(true);
    stage.teardown();
    syncActors();
    resetWander(ROLLS_GRACE);
    followLeader();
    followCamera();
    await fade(false);
    encounterLock = false;
    mode = 'overworld';
    applyHint();
    autosave();
  }

  // ------------------------------------------------------ level + saving ---
  //
  // The level is DATA (data/level1.json, level2.json) driven by a pure machine
  // (core/level.js). The director's only job is to feed it events and show what it
  // answers. Rebound by `enterArea`: each area has its own level.
  let level;
  function buildLevel() {
    level = createLevel(LEVEL, { intro: LEVEL.intro });
  }
  buildLevel();
  // True while a `hintOnly` briefing is up: mode is 'dialogue' so the box is
  // dismissible, but the world keeps running underneath it. The distinction is
  // the whole point of the flag — see speakStage().
  let talking = false;

  /**
   * Speak the CURRENT stage's lines, once.
   *
   * Two rules, both learned the hard way:
   *
   * 1. A stage's text plays when the stage OPENS, not when it closes. Speaking
   *    on close means the explanation of "press E" arrives after the player
   *    already pressed E, because the stage it belonged to was spent by that
   *    very press. Open-side is the only ordering that reads.
   *
   * 2. `mode` still goes to 'dialogue' so the box is DISMISSIBLE — the dialogue
   *    module owns the `interact` key while it is open, and a box the player
   *    cannot close is a box the player cannot get past. What `hintOnly` changes
   *    is the LEADER: he keeps walking while the briefing types out, because the
   *    first stage is spent by walking and the tutorial must not stop the player
   *    mid-stride to explain walking. A marker conversation keeps the freeze,
   *    because talking to a person is something you stop for.
   *
   * `shown` lives on the JSON object, not in the machine, because the machine
   * must stay pure and re-hydratable: after a save restore the stage pointer
   * comes back but the dialogue does not replay.
   */
  async function speakStage() {
    const s = level.stage;
    if (!s || !s.lines || s.shown) return;
    s.shown = true;
    const wasMode = mode;
    mode = 'dialogue';
    talking = !!s.hintOnly;
    applyHint();
    await dialogue.say(s.lines);
    talking = false;
    mode = wasMode === 'dialogue' ? 'overworld' : wasMode;
    applyHint();
  }

  /**
   * The one place the level hears about the world. Every event routes through
   * here, so a stage can only ever be spent by the event it declares and only
   * once — that is what stops the tutorial skipping itself.
   */
  async function levelEvent(type, detail = null) {
    if (level.isComplete) return;
    if (!level.canAdvance(type)) return false;
    level.advance(type, detail);
    applyHint();
    autosave();
    if (level.isComplete) {
      hud.toast(LEVEL.progress?.completeText || 'Area complete', 3200);
      return true;
    }
    await speakStage();
    return true;
  }

  const autosave = () => { save.save(); };

  // -------------------------------------------------------- conversation ---
  //
  // A marker is consumed when the player is DONE with it, and "done" is the
  // level's decision, not the marker interaction's. The bug this guards: a
  // player who talks to Vell before the level asks them to (they walk into her,
  // press E out of curiosity) used to burn the marker for good, and the `talk`
  // stage — which requires Vell — became unreachable. The area could never be
  // completed and nothing threw: no error, no toast, just an island whose last
  // step does not exist. So a marker the level is currently WAITING on is
  // never consumed, and the conversation does not even close the marker.
  async function useMarker() {
    const m = nearestMarker();
    if (!m) return;
    // Compared by ID, not by name. Names are player-facing text and get
    // translated; an id does not. Matching on the displayed string meant a
    // translation silently broke every marker-gated stage.
    const wanted = level.stage?.marker === m.id;
    // A shop is a COUNTER, not an event: it is never consumed, so the player can
    // come back and spend the gold the next fight gave them. Everything else is
    // one-shot, and a used marker the level is not waiting on has nothing to say.
    const repeatable = m.kind === 'shop';
    if (m.used && !wanted && !repeatable) { hud.toast('Qui non c\u2019\u00e8 pi\u00f9 niente.'); return; }
    // TWO FLAGS, not one. `used` means CONSUMED — the sprite dims and the marker
    // has nothing left to say. `visited` means "has been talked to at least
    // once", and it is what gates the greeting. A repeatable marker never sets
    // `used`, so keying the greeting on it made `firstVisit` permanently true:
    // the shopkeeper replayed his whole introduction on every visit, and any
    // `give`/`gold` ever put on a repeatable marker would have been re-awarded
    // every time. The two questions are different and now have different answers.
    const firstVisit = !m.visited;
    m.visited = true;
    // Consume only on a first visit that the level was not waiting for, or
    // explicitly on a stage that the level just spent.
    if (!repeatable && (firstVisit || wanted)) m.used = true;

    // A shopkeeper says hello once and then just serves. Making him repeat his
    // introduction every visit would be a greeting card, not a shop.
    if (!(repeatable && !firstVisit)) {
      mode = 'dialogue';
      applyHint();                    // the hint is HIDDEN while a dialogue is open
      // Only speak the marker's own lines the first time, or the return trip to
      // Vell would replay the introduction.
      await dialogue.say(firstVisit ? m.lines : [{ speaker: m.name, text: 'C\u2019\u00e8 qualcosa di nuovo, l\u00e0 fuori?' }]);
    }
    // The cache used to PRINT "Gained 3 x Field Tonic" and give the player
    // nothing, because no bag existed. `give` is the item table for the marker:
    // adding a pickup is a JSON edit, not a code path. First visit only, or a
    // return trip farms infinite tonics.
    if (firstVisit && m.give) {
      for (const [id, n] of Object.entries(m.give)) {
        bag.add(id, n);
        const def = ITEMS[id];
        if (def) hud.toast(`Ottenuto ${n} \u00d7 ${def.name}`, 2200);
      }
    }
    // Gold the wreck left behind. The blacksmith is in the village and reachable
    // in the first minute, while the first fight pays 7: a shop nobody can afford
    // to use is a locked door with a counter behind it. The cache is salvage, and
    // Ivo's own line already says the wreck pays.
    if (firstVisit && m.gold) {
      bag.addGold(m.gold);
      hud.toast(`Trovati ${m.gold} oro`, 2200);
    }
    resetWander(ROLLS_GRACE);
    // A marker the current stage points at is what the level is waiting for.
    // This must run BEFORE the fight: the stage's lines explain the fight.
    if (wanted) await levelEvent(EVENTS.TALK, m.id);
    if (m.kind === 'battle' && firstVisit) await startEncounter(m.zone);
    // Every visit, not just the first: a shop you can only enter once is a
    // vending machine, and the gold from the next fight would have nowhere to go.
    if (repeatable) await openShop();
    // An exit is a door. Fade, swap the world in place, fade back — no reload, and
    // the party's HP, MP and bag cross untouched.
    if (m.kind === 'exit' && m.to) {
      mode = 'transition';
      await fade(true);
      const moved = enterArea(m.to);
      mode = 'overworld';
      applyHint();
      await fade(false);
      if (moved) {
        hud.toast(AREAS[m.to].name, 2200);
        autosave();
      }
      return;
    }
    mode = 'overworld';
    applyHint();
    autosave();
  }

  // ------------------------------------------------------------ menu/hint ---
  function applyHint() {
    // The hint is HIDDEN while a dialogue is open. The 132px bottom margin in
    // style.css is a layout fallback, not a reason to leave both on screen.
    let text = null;
    if (mode === 'overworld' && !dialogue.isOpen && !menu.isOpen && hintOn) {
      const m = nearestMarker();
      // The objective outranks the marker prompt. A player who has not been told
      // what to do does not need a hint about the one person standing next to
      // them — they need to know the first step.
      const goal = level.objective;
      if (goal) text = `\u25c6 ${goal}`;
      // A counter is not a conversation: "parla con" reads wrong on a shop, and
      // the player is being told what the key does, not who is standing there.
      else if (m) text = m.kind === 'shop' ? `E \u2014 compra da ${m.name}` : `E \u2014 parla con ${m.name}`;
      else text = 'WASD per muoverti \u00b7 E per interagire \u00b7 Esc per il menu \u00b7 backtick = scala';
    }
    if (text === hintText) return;     // hud.setHint is a DOM write; skip no-ops
    hintText = text;
    hud.setHint(text);
  }

  async function openMenu() {
    mode = 'menu';
    // The party plates sit at left:20px and the menu panel is inset:40px, so
    // they poke out from behind it and read as a rendering bug.
    hud.setVisible(false);
    hintText = null;
    syncHud();
    await menu.open(
      allies.map((a) => ({ ...a })),
      Object.entries(SKILLS).map(([id, d]) => ({ id, ...d })),
      // Only what is CARRIED, with the count on the row. The old call passed the
      // whole catalogue, so the Items tab listed three things the player had
      // never owned and no indication of how many of anything they held.
      bag.entries().map(({ id, count, def }) => ({ ...def, id, count })),
      {
        renderScale: engine.renderScale,
        gold: bag.gold,
        saveState: save.available
          ? (save.load() ? 'Salvataggio presente' : 'Nessun salvataggio')
          : 'Salvataggio non disponibile in questo browser',
        onSave: () => {
          if (!save.available) { hud.toast('Questo browser non permette di salvare', 2600); return; }
          hud.toast(save.save() ? 'Salvato' : 'Salvataggio non riuscito: memoria piena o bloccata', 1800);
        },
        onTitle: () => { toTitleRequested = true; },
        onCycleRenderScale: (n) => { engine.setRenderScale(n); return engine.renderScale; },
      },
    );
    hud.setVisible(true);
    mode = 'overworld';
    applyHint();
    // The menu CLOSING is the event the `items` stage waits for. Firing on open
    // would put the next stage's dialogue on top of the menu the player is
    // reading; firing on close lets them read the menu, then hear what is next.
    if (toTitleRequested) {
      toTitleRequested = false;
      await openTitle({ sessionLive: true });
      return;
    }
    if (level.canAdvance(EVENTS.MENU)) await levelEvent(EVENTS.MENU);
  }

  async function openShop() {
    const ids = (Array.isArray(SHOP.stock) ? SHOP.stock : []).filter((id) => ITEMS[id]);
    if (!ids.length) return;

    // What he pays for what you bring him. The RATE is data (`shop.json`), so
    // rebalancing the economy is a JSON edit, and the price is computed at the
    // counter rather than stored on the item — a stored copy would drift the
    // moment a buy price changed.
    const rate = Number.isFinite(SHOP.sellRate) ? SHOP.sellRate : 0.5;
    const sellPrice = (id) => Math.max(1, Math.floor((ITEMS[id]?.price ?? 0) * rate));

    // Both sides are rebuilt from the bag on every trade, so the purse and the
    // "ne ho N" counts move together instead of being patched in place.
    const buyRows = () => ids.map((id) => ({
      id,
      name: ITEMS[id].name,
      price: ITEMS[id].price ?? 0,
      note: SHOP.note?.[id] || '',
      owned: bag.count(id),
    }));
    const sellRows = () => bag.entries()
      .filter(({ id }) => ITEMS[id])
      .map(({ id, def, count }) => ({
        id,
        name: def.name,
        price: sellPrice(id),
        note: SHOP.note?.[id] || '',
        owned: count,
      }));
    const snapshot = () => ({ buy: buyRows(), sell: sellRows(), gold: bag.gold });

    mode = 'shop';
    hud.setVisible(false);
    hintText = null;
    await shop.open({
      title: SHOP.title || 'Bottega',
      ...snapshot(),
      onBuy: (id) => {
        const def = ITEMS[id];
        if (!def) return null;
        // The atomic buy lives in the inventory: it refuses before charging, so a
        // purchase can never take the gold and deliver nothing.
        if (!bag.buy(id, def.price ?? 0)) {
          hud.toast('Non bastano i soldi', 1200);
          return null;
        }
        hud.toast(`Comprato ${def.name}`, 1200);
        return snapshot();
      },
      onSell: (id) => {
        const def = ITEMS[id];
        if (!def) return null;
        const price = sellPrice(id);
        // Nothing to hand over is a REFUSAL, not a silent no-op: the player
        // pressed a key and should be told why nothing moved.
        if (!bag.sell(id, price)) {
          hud.toast(`Non ne hai: ${def.name}`, 1200);
          return null;
        }
        hud.toast(`Venduto ${def.name} per ${price} oro`, 1200);
        return snapshot();
      },
    });
    hud.setVisible(true);
    mode = 'overworld';
    applyHint();
    autosave();
    syncHud();
  }

  function cycleScale() {
    const n = (engine.renderScale % 4) + 1;   // 1 -> 2 -> 3 -> 4 -> 1
    engine.setRenderScale(n);
    hud.toast(`Scala di rendering ${n} \u2014 buffer ${engine.bufferW}\u00d7${engine.bufferH}`, 1200);
  }

  // ----------------------------------------------------------------- loop ---
  //
  // Idle throttling. Measured, not assumed: under a software rasteriser
  // (SwiftShader — what every headless QA screenshot runs on) the render loop
  // costs ~7.7 CPU cores and starves everything else on the box, while
  // `dispose()` costs 0.0. Dropping the resolution does NOT help: the cost is
  // per-presented-frame, not per-pixel, so the only lever is frame COUNT.
  //
  // Throttled, never skipped: the camera lerp and the shake decay both live
  // inside engine.render(), so a hard skip would freeze them and leave QA
  // screenshotting a stale frame. While idle we present 1 frame in IDLE_EVERY
  // instead — the world still moves, just slowly, and a fresh frame is always
  // at most IDLE_EVERY rAF ticks away. Movement and battles render every frame.
  const IDLE_EVERY = 8;
  let idleFrames = 0;

  function moveLeader(dt) {
    const l = party.leader.position;
    // `talking` is the one case where a dialogue is open AND the world moves.
    if ((!talking && (mode !== 'overworld' || dialogue.isOpen)) || menu.isOpen || dt <= 0) {
      if (party.leader.state === 'walk') party.leader.state = 'idle';
      return;
    }
    const ax = input.axis.x;
    const ay = input.axis.y;
    const len = Math.hypot(ax, ay);
    if (len < 0.08) { party.leader.state = 'idle'; return; }
    const speed = WALK_SPEED * (input.isDown('sprint') ? SPRINT : 1);
    const step = Math.min(1, len) * speed * dt;
    // Count what was TRAVELLED, not what was asked for: slide() deflects around
    // props, so a blocked step covers a different distance than `step`.
    const px = l.x;
    const pz = l.z;
    party.leader.stepToward(l.x + (ax / len) * step, l.z - (ay / len) * step, dt);
    const moved = Math.hypot(l.x - px, l.z - pz);
    walked += moved;
    // The tutorial's first stage is spent by MOVING, not by pressing a key:
    // a player who walks into a pine has still moved, and a stage gated on the
    // key event would leave them pressing W against a wall wondering why the
    // objective did not change.
    if (moved > 0.02 && level.canAdvance(EVENTS.MOVE)) levelEvent(EVENTS.MOVE);
  }

  function dumpState() {
    const l = party.leader.position;
    const report = {
      mode, renderScale: engine.renderScale, buffer: [engine.bufferW, engine.bufferH],
      pos: [+l.x.toFixed(2), +l.y.toFixed(2), +l.z.toFixed(2)],
      tile: terrain.tileAt(l.x, l.z), zone: zoneAt(l.x, l.z),
      props: props.count, walked: +walked.toFixed(1), nextRoll: +nextRoll.toFixed(1),
      party: allies.map((a) => `${a.name} ${a.currentHP}/${a.maxHP}${a.boosted ? ' BOOSTED' : ''}`),
      battle: stage.live,
    };
    console.log('[hd2d]', JSON.stringify(report));
    hud.toast(`${mode} · scale ${engine.renderScale} · ${engine.bufferW}x${engine.bufferH}`, 1500);
  }

  function frame() {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    // Timer.update() must run once per frame BEFORE getDelta(); the same clamp
    // as before, so a stall still advances the world by at most 0.05s.
    engine.timer.update();
    const dt = Math.min(0.05, engine.timer.getDelta());
    input.update();
    elapsed += dt;

    // Idle: nothing is animating, so presenting is pure waste. Ticking the
    // state machine above is what matters, and it keeps running.
    const busy = input.axis.x !== 0 || input.axis.y !== 0
      || freeze > 0 || stage.live || dialogue.isOpen || menu.isOpen;
    idleFrames = busy ? 0 : idleFrames + 1;

    if (input.pressed('cycleRenderScale')) cycleScale();
    if (input.pressed('debug')) dumpState();
    if (input.pressed('menu')) { hintOn = !hintOn; applyHint(); }
    if (mode === 'overworld' && input.pressed('cancel')) openMenu();
    if (mode === 'overworld' && input.pressed('interact')) useMarker();

    // hit-stop: the world holds still for a beat on impact. The battle state
    // machine still runs on real time — freezing it would also freeze the
    // timeout clock — so only the actors animate on the frozen step.
    const step = freeze > 0 ? 0 : dt;
    freeze = Math.max(0, freeze - dt);

    stage.update(dt, step);
    stage.prompt.read();
    // The shop owns its own keyboard edges, read once per frame like the battle
    // prompt. It has no update(dt) on purpose (hud/dialogue/menu do not either).
    shop.read();

    // `talking` is the world-under-a-briefing case: mode is 'dialogue' so the
    // box is dismissible, but a `hintOnly` stage must not stop the leader, or
    // the stage that teaches walking would be taught by freezing the walk.
    if (mode === 'overworld' || talking) {
      moveLeader(step);
      party.follow(party.leader.position.x, party.leader.position.z, step);
      followCamera();
      // The village is a safe zone. A random encounter at the well, three steps
      // from where the player woke up, reads as the game being broken rather
      // than as danger — and it would interrupt the tutorial's own stage lines.
      if (walked > nextRoll && !encounterLock && !inVillage(party.leader.position)) {
        const l = party.leader.position;
        resetWander(ROLLS_MIN + rng() * (ROLLS_MAX - ROLLS_MIN));
        startEncounter(zoneAt(l.x, l.z));
      }
    } else {
      party.members.forEach((m) => m.update(step));
    }
    // The talking markers are `depthTest: false`, so they float over the battle
    // formation. Nothing is interactable mid-battle, so put them away.
    markerGroup.visible = !stage.live;
    for (const m of markers) {
      m.sprite.position.y = m.sprite.userData.base + Math.sin(elapsed * 3 + m.sprite.userData.phase) * 0.11;
      m.sprite.material.opacity = m.used ? 0.25 : 1;
    }
    applyHint();

    terrain.update(dt);
    props.update(dt);
    village.update(dt);
    sky.update(dt, engine.camera);
    // The markers bob and the water scrolls, so an "idle" world is not static on
    // screen — but a screenshot only needs ONE correct frame, not 60 a second.
    // Modulo, not a threshold: a threshold would present never again.
    if (idleFrames < IDLE_EVERY || idleFrames % IDLE_EVERY === 0) engine.render();
  }

  // ------------------------------------------------------------ transition ---
  /**
   * Move the party to another area, rebuilding everything the area owns.
   *
   * In place: no page reload, no black loading screen — the caller fades, swaps,
   * and fades back. That is why every area-dependent piece is a builder rather
   * than a `const`: an actor captures its terrain and collider set in a closure,
   * and `createStage` captures the terrain and the party, so a new area means new
   * actors and a new stage.
   *
   * The PARTY STATE IS NOT TOUCHED. `allies` (HP, MP, gold, the bag) is the
   * player, not the world, and it crosses the transition untouched — that is the
   * whole point of keeping it out of `createArea`.
   *
   * Returns false for an unknown area, so a bad exit in the data leaves the player
   * where they were instead of in an empty scene.
   */
  function enterArea(id, { at = null } = {}) {
    const def = AREAS[id];
    if (!def) {
      console.error(`[hd2d] no area "${id}"; the exit points nowhere`);
      return false;
    }

    // ---- tear down, in the reverse order of construction -------------------
    // Marker progress first: the rebuild hands out fresh markers, so what has
    // already been taken has to be remembered BEFORE they are thrown away.
    rememberMarkers();
    // The stage first: it owns the battle prompt and holds the old terrain.
    stage.dispose();
    // Actors hold their terrain and colliders, so they must go before the world.
    party.dispose();
    // Markers are the area's, and their materials are per-sprite.
    for (const m of markers) m.sprite.material.dispose();
    markerGroup.clear();
    markers = [];
    // The world last.
    area.dispose();

    // ---- rebuild ------------------------------------------------------------
    area = createArea({ engine, def });
    ({ sky, terrain, village, props, colliders, spawn } = area);
    ({ clearSpot, markerSpot, inVillage } = area);
    MARKERS = def.markers;
    LEVEL = def.level;
    buildParty();
    buildMarkers();
    buildLevel();
    buildStage();
    // The save refers to the level and the markers, so it is rebuilt last.
    buildSave();

    // Park the party at the arrival point and put the camera there in ONE step:
    // letting the camera lerp from the previous area's coordinates would fly it
    // across the map.
    const sx = at?.x ?? spawn.x;
    const sz = at?.z ?? spawn.z;
    placeParty(sx, sz);
    syncActors();
    syncHud();
    focusX = sx;
    focusZ = sz;
    engine.setCameraTarget(sx, terrain.heightAt(sx, sz) + 1.4, sz);
    walked = 0;
    return true;
  }

  // ----------------------------------------------------------------- boot ---
  // ----------------------------------------------------------------- title ---
  // The game opens on the title, not on the intro. See ui/title.js for why, but
  // the short version: the intro is the start of a NEW game, and a returning
  // player needs a way to say "not that" before it plays.
  const title = createTitle(uiRoot, INFO);
  let toTitleRequested = false;
  let sessionLive = false;

  const titleNote = () => {
    if (!save.available) return 'Salvataggio non disponibile in questo browser';
    return save.load() ? 'C\u2019\u00e8 un salvataggio' : 'Nessun salvataggio';
  };

  /** Show the title until it resolves a real action. Info is handled inside. */
  async function openTitle() {
    for (;;) {
      mode = 'title';
      hud.setVisible(false);
      const choice = await title.open({
        hasSave: save.available && !!save.load(),
        sessionLive,
        saveNote: titleNote(),
      });
      if (choice === 'save') {
        hud.setVisible(true);
        hud.toast(save.save() ? 'Salvato' : 'Salvataggio non riuscito', 1800);
        sessionLive = true;
        continue;
      }
      return choice;
    }
  }

  /** Put the world, the party and the bag back to a brand-new game. */
  function resetSession() {
    level.restore({ id: LEVEL.id, index: 0, complete: false });
    // `shown` lives on the stage objects, so a reset has to clear it too or the
    // second playthrough would skip every briefing it "already showed".
    for (const s of LEVEL.stages) delete s.shown;
    bag.clear();
    for (const a of allies) {
      a.currentHP = a.maxHP;
      a.currentMP = a.maxMP;
      a.boosted = false;
    }
    for (const m of markers) { m.used = false; m.visited = false; }
    markerMemory.clear();
    placeParty(spawn.x, spawn.z);
    focusX = spawn.x;
    focusZ = spawn.z;
    engine.setCameraTarget(spawn.x, terrain.heightAt(spawn.x, spawn.z) + 1.4, spawn.z);
    syncActors();
    syncHud();
  }

  async function enterWorld({ intro = false } = {}) {
    sessionLive = true;
    mode = 'overworld';
    hud.setVisible(true);
    hintText = null;
    applyHint();
    if (intro) {
      // Chained, not awaited in parallel: speakStage() must run after the last
      // line closes, or the first briefing types on top of the intro.
      mode = 'dialogue';
      applyHint();
      await dialogue.say(LEVEL.intro);
      mode = 'overworld';
      applyHint();
      await speakStage();
    }
  }

  /**
   * Run the title loop and start a session. Kept out of the module body so the
   * first call happens in start(), i.e. after main.js has removed #boot — the
   * title must not open behind the boot overlay.
   */
  async function boot() {
    const choice = await openTitle();
    if (choice === 'continue' && restore()) { await enterWorld({ intro: false }); return; }
    if (choice === 'continue') hud.toast('Salvataggio illeggibile: nuova partita', 2400);
    resetSession();
    await enterWorld({ intro: true });
  }

  // Party parked at the spawn before anything runs, so a screenshot taken before
  // the title resolves is of the village and not of the map origin.
  placeParty(spawn.x, spawn.z);
  syncActors();
  syncHud();
  engine.camera.fov = FOV_WORLD;
  engine.camera.updateProjectionMatrix();
  engine.setPostParams(DOF_WORLD);
  engine.setCameraTarget(spawn.x, terrain.heightAt(spawn.x, spawn.z) + 1.4, spawn.z);
  applyHint();

  // A save restores the STAGE POINTER, the party and the bag. It does not
  // restore the world, because the world is regenerated from MAP.seed: storing
  // terrain or props would only give a save a way to disagree with the island
  // the game actually built. A fresh game is "no save", which is also what a
  // corrupt or future-versioned slot falls back to.
  let save;
  function buildSave() {
    save = createSave({ level, bag, allies, leader: party.leader, partyIds: PARTY_IDS, markers, area });
  }
  buildSave();
  function restore() {
    const data = save.load();
    if (!data) return false;
    // A position is only honoured if the tile is still walkable: a save from a
    // world with a different prop seed can otherwise drop the party inside a
    // pine, and the slide() rules would leave them wedged with no free heading.
    const at = save.positionFor(data);
    if (at && terrain.isWalkable(at.x, at.z)) {
      // The WHOLE party, not just the leader: the followers would otherwise walk
      // in from the village on the first frame and the resumed game would look
      // like it had lost them. See placeParty.
      placeParty(at.x, at.z);
      followLeader();
      focusX = at.x;
      focusZ = at.z;
      engine.setCameraTarget(at.x, terrain.heightAt(at.x, at.z) + 1.4, at.z);
    }
    save.apply(data);
    if (level.isComplete) {
      hud.toast(LEVEL.progress?.completeText || 'Area completata: progressi ripristinati', 3000);
    } else {
      hud.toast('Progressi ripristinati', 2000);
    }
    syncActors();
    syncHud();
    return true;
  }

  const onResize = () => engine.resize();
  window.addEventListener('resize', onResize);

  // QA handle. The render is not unit-tested, so a screenshot pass needs a way to
  // ask what the scene contains without guessing from pixels.
  //
  // The view itself lives in game/qa.js. What is passed here is a table of
  // THUNKS, and that is load-bearing rather than stylistic: `enterArea` rebinds
  // almost all of it, so a captured VALUE would keep answering with the world the
  // player has already left — a bug that only appears after a transition and looks
  // like the harness being flaky.
  installQaHandle({
    engine: () => engine,
    input: () => input,
    THREE,
    colliders: () => colliders,
    terrain: () => terrain,
    party: () => party,
    leaderPos: () => [party.leader.position.x, party.leader.position.z],
    encounter: (zone, ids) =>
      startEncounter(zone || zoneAt(party.leader.position.x, party.leader.position.z), ids),
    inVillage: (x, z) => inVillage({ x, z }),
    // Teleport is a QA affordance, not a cheat hook for the game: the harness has
    // to reach the cache and the mesa without walking there, and walking there
    // means rolling random encounters that make the run non-deterministic.
    // clearSpot first, or the leader lands inside a prop and slide() leaves it
    // wedged with every heading refused.
    teleport: (x, z) => {
      const s = clearSpot(x, z);
      party.leader.setPosition(s.x, s.z);
      party.follow(s.x, s.z, 0.016);
      followLeader();
      followCamera();
      return [s.x, s.z];
    },
    // The state read stays here: it touches ten closures and moving it would only
    // give the handle a second way to be wrong.
    state: () => {
      const l = party.leader.position;
      const p = stage.promptState;
      return {
        mode, renderScale: engine.renderScale, buffer: [engine.bufferW, engine.bufferH],
        pos: [+l.x.toFixed(2), +l.y.toFixed(2), +l.z.toFixed(2)],
        tile: terrain.tileAt(l.x, l.z), zone: zoneAt(l.x, l.z),
        propCount: props.count, walked: +walked.toFixed(1),
        asking: stage.asking, draining: stage.draining, queued: stage.queued,
        promptOpen: p.open, promptRows: p.rows, promptSel: p.sel,
        camera: engine.camera.position.toArray().map((v) => +v.toFixed(2)),
        fov: engine.camera.fov,
        battle: stage.battleInfo,
        sceneChildren: engine.scene.children.length,
      };
    },
    levelState: () => {
      const s = level.stage;
      return {
        id: LEVEL.id, areaId: area.id, index: level.index, complete: level.isComplete,
        stage: s ? s.id : null, objective: level.objective,
      };
    },
    // Which world is loaded. A transition is otherwise invisible to the harness:
    // the handle would look identical in both areas.
    areaState: () => ({
      id: area.id, name: area.name, map: area.def.map, spawn: area.spawn,
      colliders: area.colliders.length, props: area.props.count,
    }),
    bag: () => bag.snapshot(),
    save: () => save.save(),
    loadSave: () => { const d = save.load(); return d ? save.snapshot() : null; },
    hasSave: () => !!save.load(),
    titleState: () => ({
      open: title.isOpen, view: title.view, selection: title.selection,
      hasSave: save.available && !!save.load(), sessionLive,
    }),
    villageState: () => ({
      name: village.name, centre: village.centre, radius: village.radius,
      safeRadius: village.safeRadius,
      // The spawn the village chose: the one place guaranteed to clear the party's
      // own wedge footprint. Measuring the party anywhere else measures a place
      // the game never promised would hold a formation.
      spawn: village.spawn,
      anchors: village.anchors, pieces: village.layout.length,
      colliders: village.colliders.length, shelf: village.shelf,
    }),
    markersState: () => markers.map((m) => ({
      id: m.id, name: m.name, x: +m.x.toFixed(2), z: +m.z.toFixed(2),
      kind: m.kind, used: m.used,
    })),
    shopState: () => shop.state,
    dispose,
  });

  function start() {
    if (!raf) raf = requestAnimationFrame(frame);
    // The title opens HERE, not in the module body: main.js removes #boot after
    // start() resolves, and a title screen rendered behind the boot overlay is a
    // black screen with a menu nobody can see.
    boot();
    return Promise.resolve();
  }

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener('resize', onResize);
    input.dispose();
    stage.dispose();
    party.dispose();
    popY.clear();
    // One call: the area owns its sky, terrain, village and props, and its
    // dispose also takes their groups out of the scene.
    area.dispose();
    hud.dispose();
    dialogue.dispose();
    menu.dispose();
    title.dispose();
    shop.dispose();
    for (const m of markers) m.sprite.material.dispose();
    markTex.dispose();
    tufts.geo.dispose();
    tufts.mat.dispose();
    fadeEl.remove();
    engine.dispose();
  }

  return { start, dispose };
}
