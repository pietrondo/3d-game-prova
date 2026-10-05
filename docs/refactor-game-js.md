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

## Step 1 — `game/qa.js` (the `window.__hd2d` handle) — **DONE**

**Measured result: −32 lines net, not the ~130 estimated.** Moving the view out
removes 120 lines but the `ctx` table of thunks costs 88, and `state` plus the two
behaviours (`teleport`, `encounter`) stay in the director by design. The estimate
below the fold is corrected so the remaining steps are not planned against a
wish.

What it did buy: the only test-only surface in the project is now one file, and
the extraction proved the thunk rule — both headless passes stayed green, which is
the evidence that the handle still reports the LIVE area rather than a copy.

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

## Step 2 — `game/rustle.js` (the grass-rustle set) — **DONE**

**Measured: −57 lines.** Self-contained as predicted, and it is the step that
proves the rule from step 1 in the other direction: `terrain` arrives PER CALL
(`rustle(x, z, terrain)`) rather than at construction, because the area is
rebuilt on every transition and a captured terrain would plant the tufts at the
wrong heights after the climb — in silence. `rng` is captured, because
`Math.random` cannot go stale.

## Step 3 — `game/cameraRig.js` — **DONE**

**Measured: −15 lines.** Small because the win is small, and the trick that made
it safe is worth copying: the rig's methods are **aliased to the local names**
(`const { followCamera, followLeader } = rig`), so the six existing call sites did
not change at all, and every `focusX/focusZ` pair became one `rig.snapTo(x, z)` —
three of them, by regex, with an assert that no `focusX` survived.

The nine touch points I counted before starting were real; aliasing removed six of
them from the diff.

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

**Corrected after step 1:** those four steps will not reach 500. Step 1 moved 120
lines and netted 32, because a ctx table of thunks and a preserved `state` cost
most of the win. Steps 2 and 3 (rustle, camera rig) are genuinely self-contained
and should net most of their length; step 4 is the big one and should net well
over half of 180. Realistic landing point is **~650–700**, which is close enough
to the rule to be worth doing and far enough that the honest thing to say is: the
rule wants 600, and the last stretch will need a fifth extraction — probably the
wander counters and `moveLeader` (step 5), pulled up to run before step 4.

Do not chase the number by collapsing `let` bindings into one object. That is the
change that would make a transition silently wrong.

## What NOT to do

- Do not move `enterArea` out. It rebinds everything, and a module that owns the
  rebinding while living elsewhere is how you get two sources of truth for the
  current area.
- Do not "clean up" the `let` bindings into a single `world` object mid-refactor.
  That is a second refactor wearing the first one's clothes.
- Do not skip the headless passes because "the unit tests pass". That is the exact
  mistake `docs/design.md` records twice.
