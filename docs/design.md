# Design — HD-2D Pixel-Art JRPG (Three.js)

Approved 2026-10-04. Slice: full vertical slice. Vanilla JS + Vite + three.

## Goal

An Octopath-Traveler-style HD-2D JRPG: a 3D diorama world with 2D pixel-art character
sprites, rendered through a low-resolution pixel pipeline, with a turn-based combat
system built around the weapon/element **boost/weakness** matrix.

## The one decision that makes it work

"3D pixel-art" is not a look, it is a **resolution decision**. Octopath Traveler is
*not* low-resolution — it is crisp 3D with pixel sprites. A true pixel 3D game is a
different aesthetic. Rather than pick one, the post-processing pass exposes a single
`renderScale` constant:

| `renderScale` | Result |
|---|---|
| 1 | HD-2D authentic — crisp 3D, pixel sprites |
| 2 | **default** — visible pixels, still readable |
| 3 | chunky pixel 3D |
| 4 | near 8-bit |

One code path, three aesthetics, live-tunable with the backtick key.

## Pipeline

1. Scene → `sceneRT` at `floor(cssSize / renderScale)`, `NearestFilter`, with a depth texture
2. Bright-pass → separable blur at 1/2 and 1/4 resolution → bloom texture
3. One fullscreen `ShaderMaterial` pass:
   bloom add → depth-driven DoF (focus band in world units) → warm-highlight /
   cool-shadow grade → posterize to N levels with 4x4 Bayer dither → saturation → vignette
4. Blit to the canvas; the low-res buffer is what produces the pixels

Colour is managed once: scene renders linear, post runs linear, sRGB conversion happens
in the final shader only.

## World

- **Zero binary assets.** Every texture is drawn at runtime on a `<canvas>` with
  `fillRect` on integer pixels and uploaded as a `NearestFilter` `CanvasTexture`.
  The entire game is a text diff: no asset pipeline, no glTF, no licences.
- Heightmap from seeded value-noise fBm shaped by a radial falloff → an island slab
  that reads as a diorama. Greedy-meshed per chunk into `BufferGeometry` with
  per-vertex colour driven by tile type and local slope.
- **64×64, not 40×40.** The island IS the map size — the falloff is radial, so
  enlarging it makes the island bigger rather than the view — and at 40 the whole
  game happened inside a 27-unit disc, which is a clearing, not a place.
- **One terrace, because the island has no flat ground.** Measured on the 64×64
  island: only 33.9% of cells are walkable and exactly ONE radius-6 disc has relief
  under 0.6 — the mesa top. A village needs flat ground, so the ground is prepared:
  `createTerrain({ shelf })` carves a level terrace, addressed in NORMALISED terms
  (a direction from the island centre and a fraction of the island radius) so it
  follows the island when the size or the seed changes instead of ending up in the
  sea. The terrace level is the disc MEAN of the natural height, not a constant — a
  fixed Y floats on one seed and sinks into the water on the next.
- The starting village, `La Riva`, is built on that terrace by `world/village.js`
  from `data/village.json`. It is not a scatter of props: it has a fixed layout, a
  name, solid buildings, and a safe radius inside which the wilderness does not roll
  encounters.
- Blocky low-poly props (`BoxGeometry`, 5-sided cones/cylinders, icosahedra), merged
  per type to keep draw calls low.
- `src/data/tiles.json`, `props.json`, `village.json` and `level1.json` are the
  content layer. New biomes, props, buildings, enemies and skills are JSON edits,
  never code changes.

## Language

The game is **Italian**. Code comments and identifiers are English, as they are
throughout the project. The seam between the two is `src/core/terms.js`: `element`,
`kind` and `weaponType` are DATA KEYS that the combat layer switches on
(`weaknesses.js` reads `element`, `battle.js` reads `kind`) and must never be
translated, while the UI has to print "fuoco" for `fire`. The maps live in one file
because that is exactly the duplication that drifts.

There is no i18n layer, on purpose: one language, and a lookup table with no second
case to justify it is indirection. If a second language is ever needed, the strings
are already clustered in the files that render them.

## Start screen

`ui/title.js` is the title: **Nuova partita / Continua / Salva / Informazioni**. It
exists for two reasons that a boot-straight-into-the-world cannot serve. A returning
player gets no chance to say "not that" before the intro plays, and a first-time
player never learns what the game is before being asked to move. It is also the only
honest home for a Load action — loading mid-game is a restart wearing a hat, so it
belongs where restarts belong.

Disabled rows are SKIPPED by the cursor, not shown-and-refused: `Continua` with no
save and `Salva` with no session are real states, and a row you can land on and
confirm into nothing is a broken row.

`Informazioni` is content: `data/info.json`.


## Combat

Octopath's differentiator is the **weakness matrix**, so it gets implemented properly
rather than approximated:

- each defender carries `resistances` / `immunities` / `vulnerabilities`
- resolution order: immunity → explicit entry → weapon-type table → normal
- `0` immune, `0.5` weak, `1` normal, `2` strong
- attacking a Boosted enemy **breaks** the boost; a living Boosted ally at the start
  of its turn auto-recovers HP
- turn order from `speed * (0.9 + rng * 0.2)`, timeline visible in the HUD

All combat logic is pure and Three.js-free so it can be unit-tested in Node.

## Game feel

Hit-stop, camera push-in on the swing, `engine.shake` on impact, damage numbers that
pop and fade, gold flash on boost / white flash on weakness, and — the single best
"this is Octopath" moment for fifteen lines of code — **the grass rustles around the
party a beat before a random encounter triggers.**

## Structure

```
src/
  core/    engine.js  pixelPass.js  input.js  tween.js
           inventory.js  level.js  save.js  terms.js
  world/   noise.js  terrain.js  props.js  sky.js  village.js
  actors/  spriteFactory.js  actor.js  party.js
  combat/  weaknesses.js  damage.js  turnOrder.js  ai.js  battle.js
  battle/  stage.js  commands.js  battle.css
  ui/      hud.js  dialogue.js  menu.js  title.js
  data/    tiles.json  props.json  actors.json  enemies.json  skills.json
           items.json  level1.json  village.json  info.json
  game.js  main.js
```

One responsibility per file, every file under 600 lines. Contracts between modules are
frozen in [`contracts.md`](./contracts.md) so six agents can build in parallel without
talking to each other.

## Testing

`vitest` on the pure logic only: noise determinism, multiplier resolution order, damage
(crit + immune branches), timeline ordering, dead-skipping, `Ease` monotonicity, battle
turn progression, boost break, the inventory, the level machine, the terrain terrace
and the village. The renderer is not unit-tested — QA reviews it by screenshot and
console output.

**`npm test` cannot see missing wiring.** Every module above is individually
correct and unit-testable, and the game still had no reachable items, no gold and
no progression. Pure logic that nothing calls passes its tests forever. Two
headless passes cover what unit tests structurally cannot:

| pass | asserts |
|---|---|
| `python tests/qa.py` | pixels: chunkiness, party spread, wilderness blocked ground, the walked counter, the battle sprites, a driven fight |
| `python tests/qa-level.py` | the title screen, intro, stage order, the village, the bag, the cache, the save round-trip, the info panel |

`qa-level.py` exists because of that failure class specifically. It drives the
real game and reads `window.__hd2d.level`, `.bag` and `.village`, which are
questions no screenshot answers.

Both passes share `tests/qa_server.py` and `tests/qa_drive.py`, and all synthetic
keys go through `tap()` rather than `keyboard.press()`. `core/input.js` builds a
press edge inside `update()` as `(held - prev)`, so a down and an up a millisecond
apart produce **no edge at all** whenever no frame lands between them. A harness
using `press()` hangs forever waiting for a battle that is progressing perfectly,
and it is indistinguishable from a wedged game. That mistake has now been made
twice, in two different harnesses, and each time cost an hour of chasing a bug
that was in the ruler.

Two more measurement rules, both of which produced a false report before they were
written down:

- **Measure the settled state, not the transient.** The party spawns as a wedge and
  the followers need a moment to reach their slots; sampling during the walk reports
  a "blob" that does not exist. `settle_party()` waits for the members to stop moving.
- **Measure the drawing, not its container, and only the sprites you mean.** The
  party overlap counts party members only (markers are sprites too), and it uses the
  alpha-measured ink box rather than the square quad. A quad box is mostly
  transparent padding; measuring it once reported 52% for a party that read fine.


## Out of scope

Audio, multiplayer, real asset authoring tools.

Superseded on 2026-10-05: **"Save/load" and "more than one map" are no longer out
of scope.** `src/core/save.js` exists and `src/data/level1.json` makes the island
a level with stages. Both were added after the fact, in that order, because a
save needs something worth saving — see the note below.

## The thing that was missing, and why it was invisible

The game had a full turn-based battle, a weakness matrix, a procedural island and
a UI — and **items, gold and progression did not exist**. `battle.js` had
implemented `command.type === 'item'` since the contract was written: heal, MP
restore, revive, `REVIVE_RATIO`, all of it unit-tested. `items.json` shipped
three items with prices. None of it was reachable:

- the battle command list had no Item row
- no inventory existed, so the "Gained 3 × Field Tonic" a marker announced was a
  `hud.toast` and nothing else
- gold was summed in `stage.run()`, printed, and discarded

None of it threw. The game looked finished. The failure mode of missing *content
plumbing* is silence, and silence is invisible in a screenshot.

The same silence hid two more: the level machine started at index -1 and never
advanced, and a player who talked to Vell before the level asked them to burned
the marker permanently, making the area impossible to finish. All three are now
covered by `tests/qa-level.py`, which drives the real game and asserts
progression — a class of bug `npm test` cannot see, because the logic is pure and
the wiring is not.

## The village that was in the sea

`world/village.js` built every piece in village-local coordinates (offsets from
the centre, as `village.json` gives them) and **never translated the result onto
the terrace**. The merged mesh was a perfectly good village, 648 triangles,
`visible: true`, sitting at the world origin — which on a 64×64 island is open
water at the map corner. The colliders WERE offset correctly, so the player walked
into an invisible village.

Nothing threw. The scene had a mesh with the right name and the right colour
attribute. `npm test` had nothing to say, because the module had no test. The
pixel QA pass screenshotted the overworld and the village simply was not in frame.
It was caught by looking at the picture and asking "where is the village?", which
is the one check that reading the code cannot replace.

The fix translates each piece's geometry by its own world position, so the
colliders and the drawing are derived from the SAME `wx`/`wz` and can no longer
disagree. The per-piece Y comes from `terrain.heightAt` — deliberately NOT a
recreated terrace formula, because the terrace is
`lerp(naturalHeight, meanY, w)` and the natural height comes from noise, so it
cannot be recomputed from the shelf alone.

## The spawn that trapped a follower

Fixing the village exposed a second bug that the trade press would call a design
flaw and an engineer should call an invariant violation: the party does not spawn
as a point, it spawns as a **wedge**, and `clearSpot` only ever cleared the
LEADER. The old spawn put the leader at (31.5, 47.76) with the signpost collider at
(31.5, 47.93), so the tail's slot was behind an obstacle. `actor.js` collides by
sliding, so the tail pressed into the post forever, the formation never closed, and
it sat permanently on top of the leader — measured as a 66% overlap.

The invariant is: **a spawn must clear the party's own footprint, not just its
centre.** The village is the only thing that knows its own obstacles, so the village
now picks the spot, searching outward from the terrace centre for the first point
whose disc is clear of every collider it built.

Worth stating plainly: the pixel pass had reported the overlap as a *false*
regression and the plan was to make the measurement smarter. Making it smarter — 
waiting for the formation to settle instead of sampling mid-walk — turned a noisy
number into a stable one, and the stable number showed the formation was genuinely
stuck. The measurement was never the problem. The ruler was fine; it was measuring
something real that nobody had looked at.

