# QA Findings — round 4

Measured, not inferred. Every number below comes from `tests/qa.py`, which drives
the real game in headless Chromium through the `window.__hd2d` handle and writes
`docs/shots/*.png` plus `docs/qa-report.json`.

```
npm run build && python tests/qa.py
```

> Round 1 is [`qa-findings-round1.md`](./qa-findings-round1.md). Rounds 2 and 3 are
> kept below because they each overturned numbers from the round before, and a
> reader needs to see that they were overturned rather than never made.
> Round 4 is a **world change**, not a bug-fix round: the island doubled, gained a
> village, and the game gained a title screen and Italian.

## Round 4 — what changed and what it measured

The world went from a 40×40 island to 64×64 and gained a starting village on a
carved terrace. Measured after that change:

| metric | round 3 | round 4 | note |
|---|---|---|---|
| party overlap | 13% | **16%** | settled formation, party sprites only; the 16% is the leader↔tail pair, whose boxes still touch by ~12px |
| blocked ground | 2.3% | **20%** | and see below: the 2.3% was never a wilderness reading |
| walked counter error | 0.7% | **0.6%** | within tolerance |
| page errors | none | **none** | |
| props | 499 | **369** | density 0.32 → 0.16 |

### The 2.3% was measured on the mesa top and called "ground"

For three rounds the blocked-ground target was "under 25%" and the reading was
2.3%. Both were wrong to trust. The sample was taken around the leader at SPAWN,
and the spawn sat on the mesa top — the flattest, most open, most keepOut-protected
ground on the island. It was a measurement of the one place that is guaranteed
clear, labelled as if it described the island.

Measured where wilderness actually is — a 3-unit disc with 95% of it on walkable
land — the same island read **36%**. That is the original complaint from round 1
("walking feels like wading through a wood"), never actually retested because the
number said otherwise. Prop density is now 0.16 and the reading is **20%**.

Two measurement bugs had to be fixed before that number was trustworthy, and both
are the same class:

- the wilderness search walked **±x only**, so the sampled spot depended on which
  axis left the village fastest and two runs could measure two places;
- taking the **first** walkable point landed on a coastal strip 21.9 units from
  the island centre, past the shore at 18.7, where almost the whole disc is water.
  The walkable remainder is beach dotted with props, so "blocked" read 34.6% — a
  fact about the sample point, not the island.

The search now sweeps eight directions and requires the disc to be **mostly land**
before it accepts a spot, and the chosen coordinates go into the report so a later
round can be compared against them rather than against a memory.

### The overlap measurement now names the pair

`worst pairwise box overlap: 16%` used to be unattributable — no way to tell a
real residual overlap from an arithmetic slip, and no way to compare one round to
the next. It now reports which two members produced it and by how many pixels:
`m0(30.08,50.48)<->m3(30.08,48.43) ox=53px oy=12px`. That 12px is the intrinsic
cost of the wedge's 2.05-unit tail depth at this camera pitch, not a defect.

### The pixel pass can now fail

`tests/qa.py` had no assertion and no `sys.exit` — it printed numbers and exited 0
whatever they said, so this document was a report rather than a test result. It now
ends with a verdict block that fails the run on: a party that never settles, a
follower stuck out of reach, overlap ≥ 25%, wilderness blocked ≥ 25%, a walk
counter off by ≥ 10%, a command list with no rows, a fight that cannot be finished,
or any page error.

## Verdict — rounds 1 to 3, still standing

| # | Round 1 claim | Round 2 said | Round 3 measures | Verdict |
|---|---|---|---|---|
| 1 | command menu prints CSS class names | fixed | fixed | **fixed** |
| 2 | enemy gigantic, left mid-map | fixed | Sentinel 98px vs party 94–103px | **fixed** |
| 3 | battle menu duplicates menu.js | fixed | fixed | **fixed** |
| 4 | whole scene tinted deep blue | already fixed | warm daylight | **fixed** |
| 5 | `renderScale 2` not pixelating | false positive | false positive | **not a bug** |
| 6 / 10 | party is one overlapping blob | 89% → 52% | **13% of the ink** | **fixed** (wedge) |
| 7 | walked counter uses requested step | 4.5% error | **0.7% error** | **fixed** |
| 8 | 62% of ground blocked | 62.8% | **2.3%** | **fixed** |
| 9 | camera far too far back | 61–74px, FOV 40 | **73–89px, FOV 34** | **fixed** |

All ten are closed. Nothing is open, and nothing is "accepted as a known
limitation" except BUG 5, which is a false positive.

---

## The metric was lying

Round 2 reported the overworld party at 52% overlap and called it broken. It was
not. The measurement had two independent errors, and they compounded:

1. **Half a sprite of phantom offset.** `sprite_boxes()` lifted the projected
   point to the sprite's centre, then reported `top = py - h` and used `py` as
   the bottom. Every box was displaced upward by half its own height. The party
   is four sprites of four different heights, so the displacement differed per
   sprite and manufactured vertical overlap between figures that never touched.
2. **Measuring the quad, not the drawing.** A humanoid draws about 60% of its
   cell width and 75% of its height. A quad box is square, so roughly half of
   every reported overlap was transparent padding.

`actor.js` already read the alpha channel to size sprites (`figureFill`, now
`figureBox`); it now also publishes the box as `sprite.userData.ink`, and the
harness measures that. Boxes are 55–66px wide instead of 89px, and the figure
sits on the ground rather than floating a half-sprite up.

**The lesson is the one worth keeping: a metric that has never been checked
against a screenshot will confidently report a bug that is not there.** The
round 2 screenshot already showed four distinguishable figures and the number
said "blob". The screenshot was right.

## BUG 6 / BUG 10 — the diagonal was the real defect, and it is now a wedge

The round 2 diagnosis was right about the geometry and wrong about the size. The
constraint is in the camera, not the numbers: `engine.js` builds
`CAMERA_OFFSET` as `(0, y, z)` with no yaw, so screen-x **is** world-x and depth
only moves a sprite up-screen.

What was actually wrong is the *shape*, not the spacing: the chain put members
1, 2 and 3 at `SIDE * i` along a single perpendicular, so each one sat directly
behind the one in front. Any amount of spacing along a line leaves the rear
figures hidden. `party.js` now uses a **wedge** — two flankers at their own
depth, one further back dead centre — so nothing is ever behind anything:

```
WEDGE = [[-1, 0.8], [1, 0.8], [0, 2.05]]   // [lateral, depth behind]
```

Two supporting changes, both forced by the wedge:

- **The formation is anchored to the leader's facing, not its travel
  direction.** The lateral axis was the perpendicular of the movement vector,
  which swings 180° the moment you walk backwards — the two flankers would swap
  sides with a visible jump every time. Facing only changes on a real turn.
- **`chain.dx`/`chain.dz` are gone.** They only existed to compute that
  perpendicular. The facing is now read from `leader.state.facing`.

Measured: **13%** worst-case ink overlap, down from 52%, and the residual is
12px where the outrider's weapon crosses a neighbour's arm. See
`docs/shots/03-party.png`.

## BUG 8 — 62.8% blocked down to 2.3%

Fixed by giving props a collider that is not its canopy. `props.json` gave a
pine `radius 0.55` (its *canopy*) and `props.js` pushed `r * 1.1` as the
collider, with `actor.js` adding its own 0.3 on top: a 0.9-unit exclusion disc
around a one-tile tree, 137 of them. Props now carry an explicit `collider` —
0.25 for a pine, which is the trunk — and `actor.js`'s `RADIUS` is 0.16.

**2.3%** of the walkable ground within 3 units is blocked, against a target
under 25%. The island still reads as wooded (`PROP_DENSITY` 0.32, 192 props)
without being a wood you wade through.

## BUG 9 — framing, and why FOV is the only lever

`engine.js` is frozen and exposes only `setCameraTarget` and `shake`, so
distance and pitch are not the director's to pull. FOV is. `FOV_WORLD` is now
**34**, down from 40, chosen by measurement on 1280x720: 40 put a party member
at 49px and left a ring of empty sea on three sides; 34 puts it at **73–89px**
and keeps the beach visible left, right and bottom, so the frame reads as a
diorama rather than a strategy map. 30 crops the island and 26 is "standing in
a wood".

`game.js` carries the reasoning inline, because the next person will otherwise
read 34 as a typo and "fix" it back to the rig's native 30.

## BUG 2 — enemy scale measured from the art, not a constant

`actor.js` used to scale with `worldHeight * cell / FIG_H`, where `FIG_H = 18`
describes a *humanoid* in a 24-unit design grid. The Sentinel fills its cell, so
it came out at `2.1 * 32/18 = 3.7` world units against a party member's 1.6 — the
giant pale spike, by arithmetic rather than by accident.

`figureBox()` reads the alpha channel, so `worldHeight` means the same thing for
every sprite: the height the player sees. Measured in battle: Sentinel **98px**,
party **94–103px**.

## BUG 5 is a false positive — the pixel pipeline works

The Bayer dither in `FINAL_FRAGMENT_SHADER` runs at **canvas** resolution and
re-noises every output pixel, which destroys the flat runs a human eye uses to
see blocks. At `renderScale 4` the terrain silhouettes are visibly stair-stepped
and the sprites lose their sub-pixel edges; at `renderScale 1` they are smooth.
Compare `docs/shots/02-scale1.png` with `docs/shots/02-scale4.png`.

An automated flat-run metric does not work here — `meanStep` moves 7.52 → 6.85
across the four scales, because the dither dominates the statistic. The only
honest check is the screenshot pair. **Do not "fix" this.** A fix would mean
removing the dither, which costs more than the chunkiness gains.

## Also confirmed

- no page errors on load
- the command prompt opens with the correct title (`Olrik`) and the correct five
  rows, and `is-sel` tracks the cursor
- `walked` tracks real displacement to within **0.7%**
- the battle state machine advances round to round under scripted input
  (round 1 → 2 with no stalls), and `sceneChildren` is stable at 10 across
  rounds, so nothing leaks per round
- 148/148 unit tests green (was 108 when this line was written), `npm run build` green

## The harness itself

`tests/qa.py` exists because round 1 was a manual screenshot pass, and half of
it was wrong. Four things it learned the hard way, so the next person does not
re-learn them:

- `page.evaluate` **awaits any promise the callback returns**, so
  `__hd2d.encounter(...)` must be called without `return` or the run deadlocks
  on the first command prompt
- a screenshot taken straight after a state read races the renderer and comes out
  black; wait two rAFs, and longer when a fade is in flight
- serve `dist/` from a `ThreadingTCPServer` on port **0**. A single-threaded
  server on a fixed port wedges the whole pass on the second run
- **validate every new metric against the screenshot it claims to describe**,
  and measure the drawing rather than its container. Round 2 got both wrong and
  spent a round chasing a bug that was in the ruler, not the game
