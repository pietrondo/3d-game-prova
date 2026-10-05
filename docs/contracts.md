# Module Contracts — HD-2D RPG

**This file is the interface between parallel agents. Do not change a signature that another module owns.**
If you truly need a change, add an optional field and document it in your own module header.

Conventions:
- ES modules, `import * as THREE from 'three'` where Three.js is needed.
- Pure logic modules (combat, noise, damage, weaknesses, turn order) MUST NOT import Three.js and MUST be unit-testable in Node.
- Every factory returns a plain object with explicit methods. No classes needed.
- Every resource-creating factory exposes `dispose()`.
- Every animated object exposes `update(dt)` where `dt` is seconds.
- Files stay under 600 lines. If yours grows past that, split it.

---

## 1. `src/core/engine.js` — owner: AGENT-CORE

```js
export const RENDER_SCALES = { hd2d: 1, pixel2: 2, pixel3: 3, chunky: 4 };
export const DEFAULT_RENDER_SCALE = 2;

export function createEngine(canvas) -> Engine
```

```ts
type Engine = {
  renderer: THREE.WebGLRenderer;   // antialias:false, powerPreference:'high-performance'
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera; // fov 30, near 0.5, far 400, pitched down ~40deg
  clock: THREE.Clock;
  canvas: HTMLCanvasElement;

  width: number; height: number;   // css pixels
  bufferW: number; bufferH: number; // low-res render target dimensions (floor(width/renderScale))

  renderScale: number;
  setRenderScale(n: number): void;  // clamps 1..4, triggers resize of RT

  setPostParams(p: Partial<PostParams>): void;
  postParams: PostParams;

  setCameraTarget(x: number, y: number, z: number): void; // smooth follow anchor
  shake(amount: number, duration: number): void;          // additive camera shake

  render(): void;     // scene -> sceneRT -> bloom chain -> final post -> screen
  resize(): void;     // called on window resize by main.js
  dispose(): void;
};

type PostParams = {
  bloomStrength: number;  // 0..1.5   default 0.65
  bloomThreshold: number; // 0..1     default 0.72
  dofStrength: number;    // 0..1     default 0.55
  dofFocus: number;       // world units, distance that stays sharp, default 14
  dofRange: number;       // world units beyond focus that reach full blur, default 22
  paletteLevels: number;  // 2..64 posterize steps, default 16
  dither: number;         // 0..1     default 0.35
  saturation: number;     // 0..2     default 1.12
  vignette: number;       // 0..1     default 0.35
  warmHighlights: boolean;// default true
};
```

Pipeline the agent must build:
1. `sceneRT` — `WebGLRenderTarget(bufferW, bufferH, { minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true, depthTexture: DepthTexture })`
2. bright-pass into `bloomA` (half res), separable blur H then V into `bloomB`, one more octave at quarter res, combine
3. final fullscreen `ShaderMaterial` pass: bloom add, depth-driven DoF blur, tone/saturation, posterize + ordered 4x4 Bayer dither, warm/cool grade, vignette
4. blit to `null` target with `NearestFilter` upscale (the canvas itself does the integer-ish upscale)

Notes:
- `renderer.outputColorSpace = THREE.SRGBColorSpace`; render the scene in linear, do the post in linear, convert to sRGB **once** in the final shader.
- DoF needs linear view depth. Reconstruct with `perspectiveDepthToViewZ(depth, near, far)`.
- `renderer.setPixelRatio(1)` — the low-res RT is where the pixelation lives, not the canvas backing store.
- `shake` decays exponentially; apply as a small offset to the camera position each frame.
- `setCameraTarget` is a lerped anchor; main.js calls it every frame with the player position.

## 2. `src/core/pixelPass.js` — owner: AGENT-CORE
(imported only by `engine.js`)

```js
export function createFullscreenQuad() -> { scene, camera, mesh, render(renderer, target) }
export function createBloomChain(renderer, w, h) -> { setSize(w,h), render(sourceTexture, params, out: THREE.Texture), dispose() }
export const FINAL_FRAGMENT_SHADER = string
export const VERTEX_SHADER = string
```

## 3. `src/core/input.js` — owner: AGENT-CORE

```js
export const ACTIONS = ['up','down','left','right','interact','cancel','menu','sprint','cycleRenderScale','debug'];
export function createInput(target = window) -> Input
```

```ts
type Input = {
  axis: { x: number; y: number };   // -1..1, analog from stick/dpad/keys, y = forward
  isDown(action: string): boolean;
  pressed(action: string): boolean;  // edge, true for exactly one frame
  released(action: string): boolean;
  gamepadConnected: boolean;
  update(): void;                    // called once per frame BEFORE consumers read edges
  dispose(): void;
};
```

Mappings: WASD + arrows for movement. `Space`/`Enter`/`E` = interact & confirm. `Escape`/`Backspace` = cancel. `Tab` = menu. `Shift` = sprint. `` ` `` = cycleRenderScale. Gamepad: left stick + dpad, A(0)=interact, B(1)=cancel, Start(9)=menu, RB(5)=sprint.

## 4. `src/core/tween.js` — owner: AGENT-CORE (pure, testable, no Three.js)

```js
export const Ease = {
  linear, quadIn, quadOut, quadInOut,
  cubicOut, cubicInOut, backOut, backIn, elasticOut, bounceOut,
};
export function tween({ from = 0, to = 1, duration = 0.3, delay = 0, ease = Ease.linear, onUpdate, onComplete }) -> { cancel(), finished: Promise<void> }
export function wait(seconds) -> Promise<void>
export function sequence(steps) -> Promise<void>   // steps: [{ wait: 0.2 }, { tween: {...} }, { call: fn }]
export function ticker(fn) -> { stop() }            // fn(dt, elapsed); started immediately
```

## 5. `src/world/noise.js` — owner: AGENT-WORLD (pure, testable)

```js
export function makeNoise(seed: number) -> {
  value2(x: number, y: number): number,   // -1..1, smooth
  fbm2(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number, // -1..1
}
```

Deterministic for a given seed. Same seed => same terrain on every reload (required for tests).

## 6. `src/world/terrain.js` — owner: AGENT-WORLD

```js
export function createTerrain({ width = 40, depth = 40, tileSize = 1, seed = 1337, heightScale = 3.2, tiles, chunkSize = 8 }) -> Terrain
```

```ts
type Terrain = {
  group: THREE.Group;            // add to scene
  heightAt(x: number, z: number): number;      // world coords, continuous
  normalYAt(x, z): number;
  tileAt(x, z): string | null;                 // tile type id, null outside bounds
  isWalkable(x, z): boolean;
  bounds: { minX, maxX, minZ, maxZ };
  worldToTile(v: number): number;              // world -> fractional tile index
  update(dt): void;   // water animation tick
  dispose(): void;
};
```

- Heightmap = `makeNoise(seed).fbm2` shaped by a radial falloff so the map is an island/diorama slab with cliff edges.
- Greedy-mesh per chunk into a `BufferGeometry` with per-vertex color (palette per tile type from `data/tiles.json`).
- **Water**: tiles whose type has `"water": true` get a flat animated plane at `heightAt` of level 0, with a procedurally generated `NearestFilter` texture whose `offset` scrolls. Only one water mesh for the whole map.
- Walkability comes from the tile data (`walkable: false` for water/cliff/prop-solid).

## 7. `src/world/sky.js` — owner: AGENT-WORLD

```js
export function createSky({ sunDir = new THREE.Vector3(0.6, 0.7, 0.4), sunColor = 0xffe0a8, topColor = 0x2b3a6b, horizonColor = 0xf0a868, groundColor = 0x1a1830 }) -> Sky
```
```ts
type Sky = { group: THREE.Group; update(dt: number): void; dispose(): void };
```
- A large inverted sphere/box with a vertical-gradient `ShaderMaterial` (no texture needed).
- A sun billboard (additive, `depthWrite:false`) positioned along `sunDir` — this is what feeds the bloom pass.
- Also returns the lights it created so `engine`/main can use them: add `lights: { sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight }` to the returned object.

## 8. `src/world/props.js` — owner: AGENT-WORLD

```js
export function createProps({ terrain, definitions, seed = 7, density = 0.08, maxCount = 700 }) -> Props
```
```ts
type Props = { group: THREE.Group; count: number; colliders: {x,z,r}[]; update(dt): void; dispose(): void };
```
- Uses `terrain.isWalkable` / `terrain.heightAt` for placement. Rejection-sample a few times per candidate, then give up.
- **Geometry is blocky low-poly on purpose**: `BoxGeometry`, `ConeGeometry(r, h, 5)`, `CylinderGeometry(r, r, h, 5)`, `DodecahedronGeometry` for rocks, `IcosahedronGeometry(r, 0)` for crystals. No spheres with high segment counts.
- Merge same-type props into one geometry per type via `BufferGeometryUtils.mergeGeometries` to keep draw calls low. Import as `import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'`.
- Solid props push a collider; main.js asks the actor to slide around them.

## 9. `src/actors/spriteFactory.js` — owner: AGENT-ACTORS (pure canvas work, no Three.js needed except for textures)

```js
export const FACINGS = ['down','up','left','right'];
export const FRAMES = ['idle0','idle1','walk0','walk1','walk2','walk3'];

export function buildActorSheet({ kind, palette, seed = 1, cell = 24, frames = FRAMES }) -> HTMLCanvasElement
//   returns one canvas: 4 columns (facing) x frames.length rows
export function buildEnemySheet({ kind, palette, seed = 1, cell = 32 }) -> HTMLCanvasElement
//   returns one canvas: 1 row per FRAMES, single facing 'down'
export function buildPropTexture({ kind, size = 32, palette }) -> HTMLCanvasElement
//   small standalone texture for battle backdrops
```

Pixel-art drawing rules (this IS the art direction, follow exactly):
- Draw with `fillRect` on integer pixel coordinates ONLY. No `arc()`, no `bezierCurveTo()`, no gradients inside sprites, no `imageSmoothingEnabled` tricks.
- Hard 1px dark outline (palette.outline) around the silhouette: draw the shape in outline colour 1px larger, then the fill on top.
- Limbs: 2px wide. Body: 6-8px. Head: 6-7px tall. Total figure ~14-18px tall inside a `cell` of 24.
- Shading: 3 tones per material (light / base / dark) from the palette, applied as horizontal bands.
- Animation: `walk0..walk3` = 4-frame cycle with 1px vertical bob and leg swap; `idle0/idle1` = breathing 1px on a 2-frame loop.
- `kind` is a string: `'hero' | 'scholar' | 'thief' | 'knight' | 'slime' | 'bat' | 'sentinel'`. Each kind needs a recognisable silhouette (hat, hood, shield, wings...).
- Output must look intentional at 1x. Squint-test it.

## 10. `src/actors/actor.js` — owner: AGENT-ACTORS

```js
export function createActor({ sheet, cell = 24, worldHeight = 1.6, speed = 3.2, terrain, colliders = [], alwaysOnTop = false }) -> Actor
```
`alwaysOnTop` (optional, default false) sets `depthTest: false` on the sprite
material and a `renderOrder` above the terrain and props. Set it ONLY for
battle enemies, which are staged in the band the props occupy; the party must
stay depth-sorted.
```ts
type Actor = {
  object3D: THREE.Object3D;   // THREE.Group holding a THREE.Sprite + a soft blob shadow
  position: THREE.Vector3;
  facing: 'up'|'down'|'left'|'right';
  state: 'idle'|'walk'|'act'|'dead';
  setPosition(x: number, z: number): void;      // snaps to terrain height
  face(dir): void;
  moveTo(x: number, z: number): Promise<void>;  // resolves when arrived or blocked; sets state
  stepToward(x, z, dt): boolean;                // continuous free movement, returns true if moved
  playAttack(duration = 0.35): Promise<void>;   // lunge + flash, does not change position permanently
  playHurt(duration = 0.25): Promise<void>;     // red tint flash
  setVisible(v: boolean): void;
  setTint(hexColorOrNull): void;
  update(dt: number): void;
  dispose(): void;
};
```
- Use a `THREE.Sprite` with a `THREE.CanvasTexture(sheet)` and `NearestFilter` on both min and mag. Swap frames by changing `texture.offset` / `texture.repeat` (set `wrapS/wrapT = ClampToEdgeWrapping`) — NOT by rebuilding the texture.
- Blob shadow: a `CircleGeometry` mesh, black, `transparent`, `opacity 0.28`, laid flat (`rotation.x = -PI/2`) at the terrain height. It sells the HD-2D look more than any post effect.
- `moveTo` uses `core/tween.js`. Collides by sliding: try full move, else try X-only, else try Z-only. Uses `terrain.isWalkable` and the `colliders` array.

## 11. `src/actors/party.js` — owner: AGENT-ACTORS

```js
export function createParty({ memberIds, data, terrain, colliders, scene }) -> Party
```
```ts
type Party = {
  members: Actor[];             // length === memberIds.length, in fixed formation order
  leader: Actor;
  setVisible(v: boolean): void;
  /** follow-leader chain: call every frame with the leader's desired position */
  follow(targetX: number, targetZ: number, dt: number): void;
  /** battle formation — party arranged in a 2x2 diamond */
  enterBattleFormation(centerX: number, centerZ: number): Promise<void>;
  dispose(): void;
};
```
Follow chain: member *i* targets a trailing offset position behind member *i-1* (offset `0.9` world units, alternating side ±0.35) with a per-member delay of 0.06s. Members lerp toward their target and are invisible if too far (> 24 units) so they don't stretch across the map.

## 12. `src/combat/weaknesses.js` — owner: AGENT-COMBAT (pure)

```js
export const ELEMENTS  = ['physical','fire','ice','lightning','dark','light'];
export const WEAPON_TYPES = ['sword','spear','axe','bow','staff','dagger'];
export const MULT = { WEAKENED: 0.5, NORMAL: 1, STRONG: 2, IMMUNE: 0 };

/** action = { element, weaponType } — either may be null */
export function multiplier(attacker, defender, action) -> number
```
- `attacker`/`defender` are stat objects: `{ resistances: { fire: 1, ... }, immunities: ['light'], vulnerabilities: ['dark'] }` where the values ARE the multiplier for that element. Element default from `weaponType` if `action.element` is null: `sword/spear/axe/dagger -> physical`, `bow -> physical`, `staff -> light`.
- Resolution order: immunity (0) > explicit `resistances`/`vulnerabilities` entry > weapon-type table > NORMAL.
- Export `classify(m) -> 'immune'|'weak'|'strong'|'normal'` and `strongestWeakness(defender) -> { element, mult } | null` (used by the UI to draw the weakness icons).

## 13. `src/combat/damage.js` — owner: AGENT-COMBAT (pure)

```js
export function computeDamage({ attacker, defender, action, mult, rng = Math.random }) -> DamageResult
```
```ts
type DamageResult = {
  amount: number;            // integer >= 0
  crit: boolean;
  effectiveness: 'weak'|'strong'|'immune'|'normal';
  mult: number;
  hpAfter: number;
  dead: boolean;
  variance: number;          // 0.92..1.08, the roll that was used
};
```
Formula (implement EXACTLY, this is the testable contract):
```
base      = (power * attacker.attack) / max(1, defender.defense)
variance  = 0.92 + rng() * 0.16
crit      = rng() < (action.critRate ?? 0.05)     // crit x1.5, applied after mult
raw       = base * variance * mult * (crit ? 1.5 : 1)
amount    = min(max(0, Math.round(raw)), defender.currentHP)
hpAfter   = defender.currentHP - amount
dead      = hpAfter <= 0
```
Plus `export function computeHeal({ caster, target, power }) -> number` (floor of `power * caster.magic`, capped at maxHP).

## 14. `src/combat/turnOrder.js` — owner: AGENT-COMBAT (pure)

```js
export function buildTimeline(allies, enemies, rng = Math.random) -> TimelineEntry[]
/** Sorted by `speed * (0.9 + rng()*0.2)` descending; returns every combatant once. */
export type TimelineEntry = { uid: string; side: 'ally'|'enemy'; index: number; name: string; speed: number };
export function nextTurn(timeline, currentIndex, alive) -> number  // skips dead, wraps, -1 if nobody alive
```

## 15. `src/combat/ai.js` — owner: AGENT-COMBAT (pure)

```js
export function chooseEnemyCommand(enemy, battle, rng = Math.random) -> Command
```
Logic: 15% chance to use a random skill if the enemy has one and has ≥ 50% HP, 20% to heal a wounded ally if the enemy has a heal skill, 30% to attack the *lowest-HP* ally, otherwise attack a random alive ally. Always prefer an attack that is boosted (weak) against the target when the enemy knows weaknesses.

```ts
type Command = {
  actorUid: string;
  type: 'attack' | 'skill' | 'item' | 'boost' | 'defend';
  targetUid: string;
  actionId?: string;
  itemId?: string;
};
```

## 16. `src/combat/battle.js` — owner: AGENT-COMBAT

```js
export function createBattle({ allies, enemies, skills, items, rng = Math.random, onEvent }) -> Battle
```
```ts
type Battle = {
  state: 'intro'|'turnStart'|'command'|'resolving'|'victory'|'defeat';
  timeline: TimelineEntry[];
  turnIndex: number;
  current: Combatant | null;
  /** player side: call this. Resolves when the command has been queued (animation is the renderer's job). */
  submitCommand(cmd: Command): void;
  /** enemy side: the game loop calls this with chooseEnemyCommand() output */
  submitAiCommand(cmd: Command): void;
  /** true once all allies have submitted for this round; resolves with the turn log */
  whenRoundReady(): Promise<TurnLog[]>;
  isOver: boolean;
  result: null | 'victory' | 'defeat';
  update(dt: number): void;
  dispose(): void;
};
```
Behaviour:
- `intro` immediately moves to `turnStart` after one `update` call (let the renderer pan in).
- Each `turnStart` advances `turnIndex` via `nextTurn`, skipping dead combatants, and if the actor is dead skips forward.
- Allies collect commands until every alive ally has one, then resolve the whole round in timeline order. Same for enemies.
- Resolution emits `onEvent(type, payload)` for EVERY beat so the renderer can animate. Required event types:
  `'turn'`, `'action'`, `'damage'`, `'heal'`, `'miss'`, `'boost'`, `'weak'`, 'immune'`, `'down'`, `'recover'`, `'end'`.
- **Boost mechanic** (Octopath's signature, implement it): attacking an enemy that is currently Boosted breaks the boost. A living party member who is Boosted at the start of their turn recovers a chunk of HP automatically and emits `'recover'`.
- `result` is set when one side is wiped. `'defeat'` sends the player back to the overworld with the party at 1 HP.

`Combatant` shape (produced by the game layer from `data/actors.json` / `data/enemies.json`):
```ts
type Combatant = {
  uid: string; side: 'ally'|'enemy'; name: string; level: number;
  maxHP, currentHP, maxMP, currentMP, attack, defense, magic, speed,
  weaponType: string; resistances: Record<string, number>; immunities: string[]; vulnerabilities: string[];
  skills: string[]; items: string[]; defending: boolean; boosted: boolean;
};
```

## 17. `src/ui/hud.js` — owner: AGENT-UI

```js
export function createHud(root: HTMLElement) -> Hud
```
```ts
type Hud = {
  setParty(members: { name, currentHP, maxHP, currentMP, maxMP, boosted }[]): void;
  setTurnHint(text: string | null): void;     // e.g. "Olrik's turn" — top-centre
  setHint(text: string | null): void;         // contextual hint near the leader
  toast(text: string, ms?: number): void;      // transient centre message
  setVisible(v: boolean): void;
  dispose(): void;
};
```
DOM only, absolutely positioned inside `#ui-root`, `pointer-events: none` except where needed. Must be legible on top of a low-res render: use a monospace pixel-ish font stack (`ui-monospace, 'Courier New', monospace`), `image-rendering: pixelated` on any bars implemented as background images, and solid colour blocks (no blur, no transparency gradients).

## 18. `src/ui/dialogue.js` — owner: AGENT-UI

```js
export function createDialogue(root: HTMLElement) -> Dialogue
```
```ts
type Dialogue = {
  isOpen: boolean;
  /** lines: [{ speaker?: string, text: string }] — types one line at a time, click/Space advances */
  say(lines: { speaker?: string; text: string }[]): Promise<void>;
  close(): void;
  dispose(): void;
};
```
Letter-by-letter reveal at ~35ms/char, blinking continue caret, speaker name plate. A click anywhere or `interact`/`confirm` skips the reveal then advances.

## 19. `src/ui/menu.js` — owner: AGENT-UI

```js
export function createMenu(root: HTMLElement) -> Menu
```
```ts
type Menu = {
  isOpen: boolean;
  open(members, skills, items): Promise<void>;   // resolves on close
  close(): void;
  dispose(): void;
};
```
Tabs: `Party | Skills | Items | System`. Party shows HP/MP/weakness chips (read `strongestWeakness`). System has `Render scale: N` cycling with the `cycleRenderScale` action and a `Quit to overworld` entry.

## 20. `src/data/*.json` — owner: AGENT-DATA

All data-driven. Adding content must never require touching code.

`tiles.json`
```json
{
  "grass":  { "colors": ["#4a7a3a", "#3d6630", "#2f4f27"], "height": 0.0, "walkable": true,  "roughness": 1 },
  "sand":   { "colors": ["#d9c07a", "#c2a862", "#a08a4c"], "height": 0.15,"walkable": true,  "roughness": 0.9 },
  "stone":  { "colors": ["#8d8a95", "#75727d", "#5c5a64"], "height": 0.5, "walkable": true,  "roughness": 0.8 },
  "water":  { "colors": ["#3a6ea5", "#2f5c8c", "#264a72"], "height": -0.4,"walkable": false, "water": true },
  "cliff":  { "colors": ["#6b5545", "#574538", "#3f322a"], "height": 2.2, "walkable": false, "roughness": 1 },
  "moss":   { "colors": ["#3f6b45", "#345a3a", "#28462e"], "height": 0.3, "walkable": true,  "roughness": 1 }
}
```
`colors` is `[base, dark, light]` — the terrain mesher uses them for per-vertex shading based on the local slope. A `height` above ~1.5 should also trigger a cliff wall on the chunk edge so the diorama has sides.

`props.json`
```json
{
  "pine":   { "geometry": "cone",  "color": "#2e5b34", "color2": "#24492a", "height": 2.4, "radius": 0.55, "solid": true,  "tiles": ["grass","moss"] },
  "rock":   { "geometry": "rock",  "color": "#7d7a85", "color2": "#5f5c66", "height": 0.7, "radius": 0.5,  "solid": true,  "tiles": ["stone","grass","sand"] },
  "ruin":   { "geometry": "box",   "color": "#b8b2a4", "color2": "#8d8879", "height": 1.8, "radius": 0.45, "solid": true,  "tiles": ["stone","sand"] },
  "grassTuft": { "geometry": "tuft", "color": "#5f8f47", "color2": "#436a34", "height": 0.35, "radius": 0.2, "solid": false, "tiles": ["grass","moss"] },
  "crystal":{ "geometry": "crystal","color": "#7fd6e8", "color2": "#4aa6c0", "height": 1.1, "radius": 0.3, "solid": false, "tiles": ["stone","moss"] },
  "flower": { "geometry": "tuft",  "color": "#e8d06a", "color2": "#c8a83f", "height": 0.3, "radius": 0.18, "solid": false, "tiles": ["grass"] }
}
```
`geometry` is one of `cone | rock | box | tuft | crystal | pillar`. `props.js` maps that to the blocky geometry — it must support ALL of them.

`actors.json` — 4 party members, fields exactly as the `Combatant` type in §16 plus `sprite: { kind, palette, cell }`:
```json
{ "olrik": { "name":"Olrik","sprite":{"kind":"hero","palette":"warrior","cell":24},
  "level":3,"maxHP":120,"maxMP":20,"attack":18,"defense":12,"magic":6,"speed":11,
  "weaponType":"sword","resistances":{"physical":1,"fire":0.5,"ice":1,"lightning":1,"dark":1,"light":1},
  "immunities":[],"vulnerabilities":[],"skills":["ember","guard_up"],"items":["tonic"] },
  ... 3 more }
```
`enemies.json` — same stat shape plus `encounter: { zone, weight }` and `exp`/`gold`:
```json
{ "slime": { "name":"Bog Slime","sprite":{"kind":"slime","palette":"slime","cell":32},
  "level":2,"maxHP":70,"maxMP":0,"attack":12,"defense":8,"magic":4,"speed":7,
  "weaponType":"dagger","resistances":{"physical":0.5,"fire":2,"ice":1,"lightning":1,"dark":1,"light":1},
  "immunities":[],"vulnerabilities":[],"skills":["slime_goo"],"items":[],
  "encounter":{"zone":"meadow","weight":5},"exp":18,"gold":7 } }
```
Required: at least 3 enemy types across 2 zones.

`skills.json` — `{ "id": { "name","kind":"attack"|"heal"|"buff","element","weaponType","power","mp","target":"enemy"|"ally"|"self","critRate","effect" } }`
`items.json` — `{ "id": { "name","kind":"heal"|"mp"|"revive","power","target","price" } }`

## 21. `src/game.js` — owner: AGENT-INTEGRATION (written LAST)

The director. Owns: engine, sky, terrain, props, party, hud, dialogue, menu, battle, and the overworld↔battle transition.

```js
export async function createGame({ canvas, uiRoot }) -> {
  start(): Promise<void>,
  dispose(): void,
}
```
Required behaviour:
- Build the world, place the party at the map centre, camera follows the leader.
- A wandering encounter system: every N metres walked (or a timer, `rng < p` per step) roll against `enemies.json` `encounter.weight` for the current zone. Fade the screen to black, run the battle, then fade back and apply exp/gold.
- Battle presentation: dolly the camera in, move the two parties into formation, show the command menu in the HUD, drive `onEvent` animations with `core/tween.js` and `engine.shake`. On `'boost'` flash the target gold, on `'weak'` flash it white.
- Grass tiles near the party occasionally rustle (`tween` a scale pop) when a battle is about to trigger. Octopath does this. It's 15 lines and it is the single best "this feels like Octopath" moment in the whole project. Do it.
- Talking points: 3-4 `THREE.Sprite` markers in the world. `interact` on the nearest one within 1.5 units opens `dialogue.say(...)`. Two of them start battles on a flag, one gives an item, one explains the controls.
- `Esc`/`menu` opens the in-game menu. `debug` key logs a state dump.
- Main loop: `requestAnimationFrame` → `clock.getDelta()` → `input.update()` → `update(dt)` everything → `engine.render()`.

## 22. `tests/*.test.js` — owner: AGENT-COMBAT + AGENT-WORLD

`vitest`, Node environment, no DOM, no Three.js import. Cover: noise determinism, `multiplier` resolution order, `computeDamage` (including the crit branch and the immune branch), `buildTimeline` ordering, `nextTurn` skipping the dead, `Ease` monotonicity, and the battle state machine's turn progression + boost break.

## 23. `src/main.js` — owner: AGENT-INTEGRATION

Thin. Wires the canvas, `#ui-root`, `window.addEventListener('resize')`, catches and prints errors to `#boot`, removes `#boot` once `game.start()` resolves.

## Shared CSS — `src/style.css` — owner: AGENT-UI

All UI classes the other agents use must be defined here or created by AGENT-UI. Class names used across modules: `.hud`, `.hud-portrait`, `.hud-bar`, `.hud-name`, `.hud-turn-hint`, `.hud-hint`, `.hud-toast`, `.dialogue`, `.dialogue-plate`, `.dialogue-text`, `.dialogue-caret`, `.menu`, `.menu-tabs`, `.menu-panel`, `.menu-item`, `.fade`.

---

## Execution order

| Phase | Agents | Modules | Parallel? |
|---|---|---|---|
| 1 | CORE, WORLD, ACTORS, COMBAT, DATA, UI | §1-4, §5-8, §9-11, §12-16, §20, §17-19 + CSS | all 6 at once |
| 2 | INTEGRATION | §21, §23, wiring, `npm run build` green | after phase 1 |
| 3 | QA | review + fix | after phase 2 |

Phase 1 contract boundaries are strict: **nobody imports another phase-1 module except through the signatures above.** The only exception: `game.js` in phase 2 imports everything.
