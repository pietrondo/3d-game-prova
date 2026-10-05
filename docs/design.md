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
- Blocky low-poly props (`BoxGeometry`, 5-sided cones/cylinders, icosahedra), merged
  per type to keep draw calls low.
- `src/data/tiles.json` and `src/data/props.json` are the content layer. New biomes,
  props, enemies and skills are JSON edits, never code changes.

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
           inventory.js  level.js  save.js
  world/   noise.js  terrain.js  props.js  sky.js
  actors/  spriteFactory.js  actor.js  party.js
  combat/  weaknesses.js  damage.js  turnOrder.js  ai.js  battle.js
  battle/  stage.js  commands.js  battle.css
  ui/      hud.js  dialogue.js  menu.js
  data/    tiles.json  props.json  actors.json  enemies.json  skills.json
           items.json  level1.json
  game.js  main.js
```

One responsibility per file, every file under 600 lines. Contracts between modules are
frozen in [`contracts.md`](./contracts.md) so six agents can build in parallel without
talking to each other.

## Testing

`vitest` on the pure logic only: noise determinism, multiplier resolution order, damage
(crit + immune branches), timeline ordering, dead-skipping, `Ease` monotonicity, battle
turn progression, boost break, the inventory and the level machine. The renderer is not
unit-tested — QA reviews it by screenshot and console output.

**`npm test` cannot see missing wiring.** Every module above is individually
correct and unit-testable, and the game still had no reachable items, no gold and
no progression. Pure logic that nothing calls passes its tests forever. Two
headless passes cover what unit tests structurally cannot:

| pass | asserts |
|---|---|
| `python tests/qa.py` | pixels: chunkiness, party spread, blocked ground, the walked counter, the battle sprites, a driven fight |
| `python tests/qa-level.py` | progression: intro, stage order, the bag, the cache, the save round-trip |

`qa-level.py` exists because of that failure class specifically. It drives the
real game and reads `window.__hd2d.level` and `window.__hd2d.bag`, which are
questions no screenshot answers.

Both passes share `tests/qa_server.py` and both use `tap()` rather than
`keyboard.press()`. `core/input.js` builds a press edge inside `update()` as
`(held - prev)`, so a down and an up a millisecond apart produce **no edge at
all** whenever no frame lands between them. A harness using `press()` hangs
forever waiting for a battle that is progressing perfectly, and it is
indistinguishable from a wedged game. That cost this session an hour of
chasing a bug that was in the ruler.

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
