# Refactor — split `src/game.js`

**Status:** planned, not started. `src/game.js` is ~1000 lines against the
project's own 600-line rule. The world is already out (`game/area.js`,
`game/areas.js`); what remains is the director itself.

**Do this one extraction at a time, verifying after each.** The order below goes
from the least coupled to the most, so an early mistake is cheap. Each step lands
green on its own; do not combine two.

## How to verify each step

```
npm test                      # unit + content invariants, seconds
npm run build                 # must be green
python tests/qa.py            # pixels: overlap, blocked, walk, fight
python tests/qa-level.py      # title, level, village, bag, save, shop, transition
```

The two Python passes drive the REAL game. They are the only thing that can tell
you a refactor preserved behaviour — the unit tests cannot see the wiring (see
`docs/design.md`, "npm test cannot see missing wiring").

A refactor step is done when all four are green **and** the numbers the passes
print are unchanged (party overlap, wilderness blocked, walk error).

## Why the bindings are `let`

`enterArea()` rebinds `area`, `terrain`, `village`, `props`, `colliders`, `spawn`,
`clearSpot`, `markerSpot`, `inVillage`, `MARKERS`, `LEVEL`, `party`, `markers`,
`level`, `stage` and `save`. Any extraction must not capture a stale copy of these —
**pass thunks, or a getter object, not values.** This is the single most likely way
to break something silently: a module that captured `terrain` at construction
keeps working until the first transition, and then draws the wrong world.

## Step 1 — `game/qa.js` (the `window.__hd2d` handle)

**~130 lines out.** Safest: it is a read-only view, no logic, and both passes
exercise it completely — if the shape or a value is wrong, they fail immediately.

```
export function installQaHandle(ctx) { window.__hd2d = { ... }; return window.__hd2d; }
```

`ctx` is an object of THUNKS (`engine: () => engine`, `colliders: () => colliders`,
`markers: () => markers`, …) because the handle must see the current area. Keep the
`state` getter's assembly in `game.js` and pass it as `state: () => ({...})`: it
reads ten closures and moving it buys nothing but coupling.

Watch: `teleport` and `encounter` are behaviours, not views. Keep their bodies in
`game.js` and expose them as thunks — `qa.js` must not need `clearSpot` or
`startEncounter`.

## Step 2 — `game/rustle.js` (the grass-rustle set)

**~65 lines out.** Self-contained: `createRustle({ engine, terrain, rng, def })`
returns `{ rustle(x, z), dispose() }`. It is the "Octopath beat" — the grass pops
before an encounter — and it is the only visual effect in the director.

Its geometry is built from `PROPS.grassTuft`, so pass the definition in rather than
importing the table: it is content.

## Step 3 — `game/cameraRig.js`

**~40 lines out.** The deadzone follow: `focusX/focusZ`, `followLeader`,
`followCamera`, and the lead-ahead factor. Interface:
`createCameraRig({ engine, terrain, party })` → `{ followLeader(), followCamera(),
snapTo(x, z) }`. `snapTo` is what `enterArea` needs today.

Constants to move with it: `DEADZONE`, `LEAD_AHEAD`. They describe the rig, not the
game.

## Step 4 — `game/hudGlue.js`

**~180 lines out.** `openMenu`, `openShop`, `applyHint`, `cycleScale`, `dumpState`,
plus the construction of `hud`/`dialogue`/`menu`/`title`/`shop` and the fade
element. It is the biggest single block, and the most coupled: it reads `allies`,
`bag`, `level`, `save`, `engine`, `mode`, `hintOn`, `hintText` and writes `mode`.

Do this one LAST, and expect to pass a large ctx. If it resists, split it again:
the shop glue and the hint are separable from the menu glue.

## Step 5 — the loop, if still over

`moveLeader`, the encounter roll and `frame` are the last ~100 lines. `frame` is
the director's spine; leave it in `game.js` and move `moveLeader` only, alongside
the wander counters (`walked`, `nextRoll`, `resetWander`, `ROLLS_*`).

## Target

After steps 1–4 `game.js` should be around 500 lines: the state, the builders, the
level driver, `enterArea`, boot and `frame`. That is one responsibility — the
director — and it fits.

## What NOT to do

- Do not move `enterArea` out. It rebinds everything, and a module that owns the
  rebinding while living elsewhere is how you get two sources of truth for the
  current area.
- Do not "clean up" the `let` bindings into a single `world` object mid-refactor.
  That is a second refactor wearing the first one's clothes.
- Do not skip the headless passes because "the unit tests pass". That is the exact
  mistake `docs/design.md` records twice.
