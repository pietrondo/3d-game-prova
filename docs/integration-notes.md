# Integration Notes — facts the phase-1 agents discovered that the contract did not say

Every item here was found by an agent while building its own module. They are not
in `contracts.md`, and `src/game.js` will be wrong without them.

---

## WORLD — terrain, sky, props

**Spawn the party at `(20, 20)`.** It is walkable stone on top of the mesa at
`y = 2.03`, and it is the only guaranteed-walkable landmark. The 25-cell cliff
ring around the mesa is unwalkable by design, so the mesa reads as a visible
plateau you cannot climb; everything below it on the island is walkable.

**Prop density must be `0.2`–`0.5`, not the contract's `0.08`.** At 0.08 the
island gets ~105 props and looks bare. It saturates near 230 because props may
not overlap, so `maxCount: 700` is never reached and can be ignored.

**Call `sky.update(dt, engine.camera)`.** The second argument is optional and
pins the sky group to the eye. Without it the sun parallaxes about 6 degrees
while the camera pans a 40-unit map, and the whole illusion breaks.

Terrain shape, so you can place things sensibly: sea → sand → grass → moss →
stone → mesa, with a `cliff` ring only on cells that genuinely sit on a height
drop. Height is quantised to `heightScale / 26`. Water is a single mesh at
`y = 0`.

`terrain.isWalkable` and `props.colliders` (67 entries at default density) are
the two movement gates. Actors must respect both.

## COMBAT — driving the battle

A battle needs **two `update()` calls** to open round 1, and two per round after.
That is the `intro` beat, so the camera pan-in is free.

```js
battle.update(dt);
if (battle.state === 'command') {
  const log = await battle.whenRoundReady();   // valid before OR after submitting
  for (const c of battle.pending) {             // combatants still owing a command
    if (c.side === 'ally') battle.submitCommand(cmdFor(c));
    else battle.submitAiCommand(chooseEnemyCommand(c, battle, rng));
  }
}
```

`whenRoundReady()` must be captured before or after the submit loop, not inside
it. `submitCommand` throws on wrong state, unknown uid, wrong side, double
submit, and a dead/no-turn actor — do not wrap it in try/catch to hide a bug.

Event payloads (the full list is in `battle.js`'s header). Beat order per command
is `action` → optional `boost` break → `weak`|`immune` → `damage` → `down`, so
the flash always lands before the number pops. `recover` lands before the actor's
own `action`. **A turn always emits at least one beat**, so the renderer can
never stall waiting for an event that does not come.

Extra fields added by the agent, safe to read: `battle.round`, `battle.elapsed`,
`battle.pending`, `battle.combatants`, `battle.log`, `battle.living(side)`,
`battle.get(uid)`, and `timelineEntry.roll`.

## COMBAT — values you must not assume

- `BASIC_POWER` is **10**, not 1. Tuned so a basic attack clears a trash mob in
  3-7 hits but takes 25-43 against the Sentinel. Do not hard-code either.
- Skills may carry `"stat": "magic"`, which makes `computeDamage` scale off
  `attacker.magic` instead of `attacker.attack`. `frost_bolt` and `lumen_bolt`
  use it. **If you synthesise an action object by hand, omit `stat`** or the
  damage math silently changes.
- `computeHeal` caps at the target's *missing* HP, never overheals.
- The `effect` field in `skills.json` (`burn`, `poison`, `slow`, `haste`,
  `def_up`) is **inert** — the contract defined no status system, so nothing
  reads it. Do not animate it. Boost already covers the buff axis.
- `battle.js` clamps every ally to at least 1 HP on defeat, so the overworld
  hand-off is safe even if `game.js` does nothing.
- Enemies never Boost-recover; only `side === 'ally'` does.
- If a target dies before your queued command resolves the attack **fizzles**
  (`miss { reason: 'target-down' }`). It does not retarget. Do not "fix" this.

## DATA — rules the schema did not state

- **An immune element is never also present in the `resistances` map.** Brann
  and the Sentinel both omit `lightning` entirely; the `immunities` array is the
  single source of truth. Do not "helpfully" add `{lightning: 1}`.
- Party order in `actors.json` is `olrik, brann, tess, maren` — that is the
  formation order for `createParty` and the HUD.
- The four `weaponType`s are all different, and so are the four sprite kinds.
  Do not collapse them.
- Zones are `meadow` and `stone`. Weight your encounter table by which tile the
  player is standing on, or the Sentinel shows up in the grass.
- Weakness design, verified: the Sentinel is immune to lightning, so the only
  real answer is Tess's `frost_bolt` (ice, x2). The other three are x1. The
  physical 0.5 on every enemy means the basic attack is never the right answer.

## CORE — renderer

- `engine.width` / `height` / `bufferW` / `bufferH` are **accessors, not
  snapshots**. Read them; do not cache them across a `resize()`.
- `renderer.setSize(w, h, false)` — the canvas is sized by CSS, so do not set
  inline styles on it.
- The final post pass runs at **canvas** resolution while sampling a
  **low-res** `NearestFilter` target. That is where the pixels come from. Do not
  render the post pass at low resolution; the grade and the dither would go
  blocky in the wrong way.
- The sRGB conversion in the final shader is the linear/display boundary.
  Everything above it is light transport, everything below it is a display
  decision. If you add a shader stage, decide which side of that line it is on.
- `setCameraTarget(x, y, z)` lerps; call it every frame with the leader's
  position. `engine.shake(amount, duration)` decays exponentially. Both are
  applied inside `render()`.
- `cameraTarget` and `cameraOffset` are exposed read-only if you need the rig.

## Input

Actions are `up down left right interact cancel menu sprint cycleRenderScale debug`.
`debug` is **F3**. `input.update()` must be called exactly once per frame before
any consumer reads `pressed()` — the edge buffer is cleared by it.

---

## UI — deviations and two fixes I found in the screenshots

Additive 4th argument: `menu.open(members, skills, items, { renderScale, onCycleRenderScale, onQuit })`.
That is the only way the System tab is wired, since the UI agent does not own input. With no
`onCycleRenderScale` it dispatches a real `Backquote` keydown so `core/input.js` picks the
action up on its own. Verified end to end: `Render scale: 2` → Enter → `3`.

**No `update(dt)` on any UI module.** The typewriter, the toast and the caret self-tick. The
general convention in contracts.md says animated objects expose `update(dt)`, but the per-module
types in §17-19 do not, and a caller ticking them as well would double-advance. **Do not call
`update()` on hud/dialogue/menu.** They are not `Scene` objects and they are not in any
`update(dt)` chain.

Skill and item rows are **browsable, not activatable** — they are `div.menu-item`, while tabs and
System entries are `button`. A button that does nothing is a UX lie, so the battle command menu
is yours to build, not the menu module's.

`strongestWeakness` is a dynamic import with a `.catch`, so the Party tab degrades to `—` chips
instead of breaking if the combat layer is missing. It resolved live: chips read `FIRE x2`,
`ICE x2`, `—` for the dark-immune member. That is the weakness matrix surfacing correctly.

### Fix 1 — hide the HUD when the menu is open

The menu panel is `inset: 40px`, but the party portraits sit at `left: 20px`, so they poke out
from behind it and read as a rendering bug. Call `hud.setVisible(false)` when `menu.open()`
resolves and `hud.setVisible(true)` when it closes. Same rule as the hint: hide the contextual
hint while a dialogue is open, do not rely on `setHint`'s 132px margin.

### Fix 2 — the menu panel must hug its content

At 4 party rows the frame is a 650px-tall void. Either let the panel height follow the row count,
or give the empty space a job — a footer strip with the party's gold and a "press Esc to close"
line. The first is three lines of CSS; do that one.

---

## Art review — measured, not eyeballed

I rendered every sheet at 6x and measured frame-to-frame pixel deltas. Two real defects, one
fixed, one accepted.

**FIXED — the thief could not show which way it faced.** `renderFigure` draws `left` as `right`
mirrored, so a figure with no *visible* asymmetric mark is byte-identical to its own mirror.
The thief's only asymmetric element was a dagger stamped at `x = 18`, but its cloak was 12px wide
inside a 24px cell, so the cloak's own 1px outline already reached `x = 18` and swallowed the
weapon. `L/R` diff was **0**. Narrowed the cloak to 10px, which frees `x = 18..22`, moved the
dagger to draw after the body stamps, and gave it a blade + guard + grip. `L/R` diff is now **38**
and the dagger is legible in all four facings. Do not widen that cloak again.

**ACCEPTED — the walk cycle is a bob, not a stride.** Measured frame deltas are 7-10% of body
area on the four actors, and the cycle is uniform (`20/20/20/20`), so the four frames differ only
by a 1px vertical bob and a 2px leg swap. At 1x in-game that reads as a gentle shuffle. It is
enough to stop the character looking frozen; it is not a run cycle. If it ever bothers you, the
fix is bigger leg travel in `poseFor`, not more frames.

**ACCEPTED — `slime` and `bat` have four identical walk frames** (delta 0) and only animate in
`idle` (delta 98 and 136, the squash). Enemies never walk: the enemy sheet is a single `down`
facing used for the stationary battle row. The dead walk rows cost nothing.

Palette keys are `outline, skin, skinDark, hair, primary, primaryDark, primaryLight, secondary,
accent`, identical across all nine palettes, so `getPalette(name)` is the only place that knows
about colour. `seed` is accepted and ignored — the art is deterministic, which is what makes the
sheet diffable and the tests stable.

`setTint` **multiplies**, so a white flash is impossible without components above 1. The actor
adds a 2.6 gain, which also means gold and white tints feed the bloom pass for free. Use
`setTint` for the boost gold and the weakness white; do not try to do it with opacity.

---

## The grass rustle

Contracts §21 asks for it and it is fifteen lines, so do not skip it: when a
wander roll succeeds, pop the scale of the grass props near the party, wait
~400 ms, then fade to black and start the battle. It is the single moment that
makes the game read as Octopath rather than as a Three.js demo. Octopath does
exactly this.
