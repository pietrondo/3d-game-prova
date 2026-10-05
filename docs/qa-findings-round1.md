# QA Findings — round 1

> Superseded by [`qa-findings.md`](./qa-findings.md) (now round 3). Kept
> because two later rounds overturned findings from this one — BUG 5 was wrong,
> and the 89% overlap figure behind BUG 6/10 turned out to be a broken
> measurement rather than a broken game. A reader needs to see that they were
> overturned rather than never made.

Found by driving the real game headlessly (`window.__hd2d` handle) and reading
screenshots. Every item below was reproduced at the time.

Status at the time: **awaiting AGENT-INTEGRATION to stop writing `src/game.js`**,
then a fix agent is dispatched with this file. `src/core/pixelPass.js` and
`src/actors/actor.js` were already fixed and listed as DONE.

---

## BUG 1 — the battle command menu prints CSS class names as text  (CRITICAL)

`src/game.js:111` defines the helper as `el(tag, text, cls)`. Line 227 calls it in
that order and is correct. Lines 230-232 do not:

```js
el('div',  promptTitle, 'menu-item')                      // correct
el('div',  'menu-item' + (i === promptSel ? ' is-sel' : ''))   // WRONG: 2 args, so
                                                                 // 'menu-item' becomes the TEXT
el('span', 'menu-row-name', o.label)                      // WRONG: text and class swapped
el('span', 'menu-row-num',  o.sub)                        // WRONG: same
```

On screen this rendered literally as `menu-itemmenu-row-name  menu-row-num`.

The cause was that the battle list was built inline in `game.js` with `el()` and
inline `cssText`, duplicating `src/ui/menu.js` — which is BUG 3, and the reason
this was never a one-off.

## BUG 2 — the enemy sprite is gigantic and stands in the middle of the map  (CRITICAL)

The Stone Sentinel rendered as a pale spike roughly four times the height of a
party member. Root cause found in round 2: `actor.js` scaled with
`worldHeight * cell / FIG_H` and `FIG_H = 18` describes a *humanoid*, not a
Sentinel, which fills its cell. Not a placement bug and not a teardown leak —
plainly arithmetic.

## BUG 3 — the command menu is not the UI module's menu  (HIGH)

`src/ui/menu.js` builds a real tabbed menu and renders correctly in isolation.
The battle command list was a *different* thing built inline in `game.js` with
bare `el()` calls and inline `style.cssText`. That duplication is why BUG 1
exists. The correct answer was to keep the battle list separate — it is a
different interaction — but move it out of `game.js` and style it through real
CSS classes.

## BUG 4 — the whole scene is tinted deep blue  (HIGH) — **ALREADY FIXED**

`src/core/pixelPass.js` applied the warm/cool grade *above* the sRGB conversion.
The cool-shadow lift was `+0.11` blue, authored as if it were a display-space
value; after the transfer function that becomes about `+0.37`. Fixed: the grade
now runs *below* `linearToSRGB`, and the values were halved. The rule is now
enforced by the file's own header comment: **above the sRGB line is light
transport, below it is a display decision.**

## BUG 5 — `renderScale 2` is not visibly pixelating  (HIGH) — **WRONG**

Round 2 overturned this. The pipeline pixelates correctly; the Bayer dither runs
at canvas resolution and re-noises each output pixel, which hides the block
structure from the eye. See round 2 for the side-by-side.

## BUG 6 — the four party sprites overlap into one blob  (MEDIUM)

All four sprites occupy the same few pixels. `enterBattleFormation` used
RING = 0.85, which spaces members 1.2 units apart against sprites ~1.1 units
wide.

## BUG 7 — movement lied about itself  (CRITICAL) — **ALREADY FIXED**

`slide()` in `src/actors/actor.js` returned `true` for a no-op: when the heading
was purely along Z, `nx === position.x`, so it called `setPosition` with the
current coordinates and reported success. Measured: `walked` climbed 1.1 → 7.7
over two seconds of held W while the position stayed at `[20, 0.49, 28.03]`.

Fixed. `slide` now refuses any axis fallback with no displacement in it, and
when the heading is axis-aligned it first tries a perpendicular deflection.

The second half of this bug — `moveLeader` counting the *requested* step rather
than the distance actually travelled — was fixed in round 2.

## BUG 8 — 62% of the ground within 3 units is blocked  (MEDIUM)

137 colliders, 62% of the area inside a 3-unit radius impassable. Still true in
round 2, at 62.8%.

## BUG 9 — the camera sits far too far back  (HIGH)

The island occupies maybe a third of the frame with a large empty expanse of
water around it, and the party is roughly 30px tall on a 720px screen. Round 2
measured 61–74px, so it is less bad than reported, but still a bird's-eye view.

## BUG 10 — BUG 6 promoted: the party is a single blob  (HIGH)

The overworld follow-chain offsets were also too tight. Round 2 measured the
battle diamond as fixed (0% overlap) and the overworld chain as still broken
(89% overlap).

---

- Terrain mesh matches `heightAt` to 1.09e-7 over 2732 sampled points, no holes
- Water is a single mesh, scrolls, and is impassable
- 108/108 combat unit tests green
- The battle state machine reaches `command` and emits turn hints
- Spawn, zone detection, camera follow and `renderScale` cycling all respond
- No page errors on load
