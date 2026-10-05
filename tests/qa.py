"""
qa.py — headless QA harness for the HD-2D game.

Drives the real game in Chromium through the `window.__hd2d` handle that
game.js exposes, measures what it claims, and writes screenshots to
docs/shots/. Nothing here is a unit test: it is the "look at the screen"
pass from docs/qa-findings.md, made repeatable.

Usage (from the project root, after `npm run build`):
    python tests/qa.py            # full pass
    python tests/qa.py shots      # screenshots only
"""

import json
import math
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

import qa_server
import qa_drive

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
SHOTS = ROOT / "docs" / "shots"

PAGE = """
async () => {
  const H = window.__hd2d;
  if (!H) return { error: 'no __hd2d handle' };
  const s = H.state;
  return { ...s };
}
"""


def serve():
    # ThreadingTCPServer on port 0, quiet logging. Shared with qa-level.py via
    # qa_server.py, because all three properties are load-bearing and a
    # single-threaded server on a fixed port wedges the pass rather than
    # failing it.
    return qa_server.serve(DIST)


def wait_boot(page):
    page.wait_for_function("() => !!window.__hd2d", timeout=20000)
    # one rendered frame is enough for the first pixels to exist
    page.wait_for_timeout(700)


# tap / dismiss / start_new_game live in qa_drive.py: both headless passes need
# them, and the reasons they are written the way they are are worth stating once.
tap = qa_drive.tap
skip_dialogue = qa_drive.dismiss
start_new_game = qa_drive.start_new_game


def shot(page, name, settle=0):
    """Screenshot, after waiting for the frame to be genuinely on screen.

    A black PNG here means the capture raced the renderer, not that the game is
    broken: the state read a frame earlier was mid-fade. Waiting for two rAFs and
    a short settle makes the capture describe the state we just read.
    """
    SHOTS.mkdir(parents=True, exist_ok=True)
    path = SHOTS / f"{name}.png"
    page.evaluate(
        "() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"
    )
    if settle:
        page.wait_for_timeout(settle)
    page.screenshot(path=str(path))
    print(f"  shot  {path.relative_to(ROOT)}")
    return path


def block_stats(path, size=220):
    """How chunky is this frame, measured on the PNG the player would see.

    A pixelated frame is made of flat runs: neighbouring pixels are identical.
    So the mean absolute difference between horizontally adjacent pixels is
    near zero inside a block and jumps at every block edge. The lower the mean,
    the more the image is genuinely made of blocks — which is the thing BUG 5 is
    about. Counting distinct greys is not enough: the scene can be one colour.
    """
    from PIL import Image
    im = Image.open(path).convert("L")
    w, h = im.size
    im = im.crop((w // 2 - size // 2, h // 2 - size // 2, w // 2 + size // 2, h // 2 + size // 2))
    px = list(im.getdata())
    row = size
    diffs = [abs(px[y * row + x] - px[y * row + x + 1]) for y in range(row) for x in range(row - 1)]
    # longest horizontal run of identical pixels = the block width, in px
    runs, run = [], 1
    for y in range(row):
        for x in range(1, row):
            if px[y * row + x] == px[y * row + x - 1]:
                run += 1
            else:
                runs.append(run)
                run = 1
        runs.append(run)
    runs.sort(reverse=True)
    return {
        "meanStep": round(sum(diffs) / len(diffs), 2),
        "longestFlatRun": runs[0],
        "distinct": len(set(px)),
    }


def settle_party(page, timeout=1500, interval=120):
    """Wait for the follow chain to reach its formation slots.

    A teleport moves the leader instantly; the followers are still walking to
    their new slots, so a measurement taken in the same frame sees a stack that
    is about to resolve and files it as an overlap regression. Poll the members'
    world positions and return as soon as two consecutive samples agree.

    Returns `(waited_ms, settled, reach)`, where `reach` is each follower's
    distance from the leader. `settled` is False when the timeout expires with the
    party still moving, and the CALLER MUST FAIL on that.

    `reach` exists because "motionless" is not "arrived": a follower wedged
    against a collider is also motionless, and an earlier version of this function
    reported a stuck formation as settled after 120ms. A member further than the
    wedge can reach (~2.6 units) is stuck, not parked.
    """
    prev = None
    waited = 0
    while waited < timeout:
        now = page.evaluate(
            "() => window.__hd2d.party.members.map((m) => "
            "[+m.position.x.toFixed(3), +m.position.z.toFixed(3)])"
        )
        if prev is not None and now == prev:
            lead = now[0]
            reach = [round(math.hypot(p[0] - lead[0], p[1] - lead[1]), 2) for p in now]
            return waited, True, reach
        prev = now
        page.wait_for_timeout(interval)
        waited += interval
    lead = prev[0] if prev else [0, 0]
    reach = [round(math.hypot(p[0] - lead[0], p[1] - lead[1]), 2) for p in (prev or [])]
    return waited, False, reach


def sprite_boxes(page, party_only=False):
    """Screen-space box of sprites in the scene.

    Read off the world matrix, because a sprite's local position is relative to
    its own group and reading it directly puts every party member at (0,0).

    With `party_only`, only the PLAYER PARTY is kept. The scene also carries the
    six talking markers, which are not party members; counting them turned a
    settled, well-spread party into a 64% "overlap" no sprite ever drew.
    """
    return page.evaluate(
        """([partyOnly]) => {
      const H = window.__hd2d, THREE = H.THREE;
      const cam = H.engine.camera, w = H.engine.width, hh = H.engine.height;
      const v = new THREE.Vector3();
      const out = [];
      H.scene.traverse((o) => {
        if (!o.isSprite || !o.material.map) return;
        // actor.js puts the Sprite (and its shadow Mesh) INSIDE the member's
        // Object3D, so the party test looks at the parent of the sprite, not at
        // the sprite itself. The marker talk-sprites have no such parent.
        if (partyOnly && !H.party.members.some((m) => m.object3D === o.parent)) return;
        o.getWorldPosition(v);
        const centre = v.clone();
        centre.y += o.scale.y * (0.5 - o.center.y);   // centre.y is 0: feet at origin
        const d = centre.distanceTo(cam.position);
        const s = centre.clone().project(cam);
        const px = (s.x * 0.5 + 0.5) * w;
        const py = (-s.y * 0.5 + 0.5) * hh;
        const f = (hh / 2) / (Math.tan((cam.fov * Math.PI) / 360) * d);
        // Measure the INK, not the quad. A humanoid draws about half of its
        // cell width and 0.75 of its height, so a quad-box overlap counts the
        // transparent padding and reports a party that reads fine as a blob.
        // actor.js publishes the alpha-measured box as sprite.userData.ink.
        const ink = o.userData.ink || { h: 1, w: 1, cx: 0.5, cy: 0.5 };
        const q = o.scale.y * f;              // quad edge in px
        const hpx = q * ink.h, wpx = q * ink.w;
        // The quad's bottom edge is the feet (sprite.center = (0.5, 0)) and its
        // projected bottom is `py + q/2`. The ink sits inside the quad with its
        // centre at `cy` from the quad's TOP, so work from the top edge down.
        const quadTop = py - q / 2;
        const top = quadTop + q * (ink.cy - ink.h / 2);
        const bottom = top + hpx;
        const left = px + q * (ink.cx - 0.5) - wpx / 2;
        out.push({
          x: Math.round(left), y: Math.round(bottom), h: Math.round(hpx),
          top: Math.round(top), bottom: Math.round(bottom),
          wpx: Math.round(wpx), quad: Math.round(q),
          worldX: +v.x.toFixed(2), worldZ: +v.z.toFixed(2),
          shown: !!(o.parent && o.parent.visible && o.visible),
        });
      });
      return out;
    }""",
        [party_only],
    )


def blocked_fraction(page, radius=3.0, step=0.25):
    """Sample a disc around the leader and report how much is impassable.

    This is a WILDERNESS measurement: the documented target (<25%) is about the
    open island. Stand the leader inside the starting village and the same maths
    counts houses and fences that are obstacles BY DESIGN.
    """
    return page.evaluate(
        """([radius, step]) => {
      const H = window.__hd2d;
      const p = H.leaderPos();
      const R = 0.3;
      let blocked = 0, total = 0, offIsland = 0;
      for (let dz = -radius; dz <= radius; dz += step) {
        for (let dx = -radius; dx <= radius; dx += step) {
          if (dx * dx + dz * dz > radius * radius) continue;
          total++;
          const x = p[0] + dx, z = p[1] + dz;
          if (!H.walkable(x, z)) { offIsland++; continue; }
          let bad = false;
          for (const c of H.colliders) {
            const ddx = x - c.x, ddz = z - c.z, r = c.r + R;
            if (ddx * ddx + ddz * ddz < r * r) { bad = true; break; }
          }
          if (bad) blocked++;
        }
      }
      return { blocked, walkable: total - offIsland, offIsland, total };
    }""",
        [radius, step],
    )


def wilderness_spot(page, step=1.0, limit=24, margin=3.0):
    """Teleport the leader onto representative walkable wilderness.

    Walks outward from `window.__hd2d.village.centre` in EIGHT directions and
    scores every candidate that is out of the village by how much of its sampling
    disc is walkable LAND, then takes the best.

    Two earlier versions were wrong in ways that produced uncomparable numbers:

    - a ±x-only search made the spot depend on which axis left the village
      fastest, so two runs could measure two different places;
    - taking the FIRST walkable point landed on a coastal strip 21.9 units from
      the island centre, past the shore at 18.7, where almost everything in the
      disc is water. The walkable remainder is beach dotted with props, so
      "blocked" read 34.6% — a fact about the sample point, not about the island.

    Requiring the disc to be mostly land is what makes the number mean "how
    obstructed is the wilderness" instead of "where did the search happen to
    stop". The chosen spot is returned and recorded in the report so a later run
    can be compared against it, not against a memory of it.
    """
    return page.evaluate(
        """([step, limit, margin]) => {
      const H = window.__hd2d, c = H.village.centre;
      const out = (x, z) =>
        !H.inVillage(x, z) &&
        !H.inVillage(x + margin, z) && !H.inVillage(x - margin, z) &&
        !H.inVillage(x, z + margin) && !H.inVillage(x, z - margin);
      const landFraction = (x, z) => {
        let ok = 0, n = 0;
        for (let dz = -margin; dz <= margin; dz += 0.5) {
          for (let dx = -margin; dx <= margin; dx += 0.5) {
            if (dx * dx + dz * dz > margin * margin) continue;
            n++;
            if (H.walkable(x + dx, z + dz)) ok++;
          }
        }
        return n ? ok / n : 0;
      };
      const dirs = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        dirs.push([Math.cos(a), Math.sin(a)]);
      }
      let best = null;
      for (let i = 1; i <= limit; i++) {
        for (const [dx, dz] of dirs) {
          const x = c.x + dx * i * step, z = c.z + dz * i * step;
          if (!out(x, z) || !H.walkable(x, z)) continue;
          const land = landFraction(x, z);
          // 0.9 of the disc on solid ground is a representative wilderness
          // sample; take the first that clears it, else keep the best seen.
          if (!best || land > best.land) best = { x, z, land, steps: i, dir: [+dx.toFixed(2), +dz.toFixed(2)] };
          if (land >= 0.9) { i = limit + 1; break; }
        }
      }
      if (!best) return { error: 'no wilderness spot found' };
      // Return where the leader ACTUALLY landed: teleport() nudges through
      // clearSpot inside a collider, and a caller comparing the requested
      // coordinates never sees the leader arrive.
      const at = H.teleport(best.x, best.z);
      return {
        x: at[0], z: at[1], asked: [+best.x.toFixed(2), +best.z.toFixed(2)],
        land: +best.land.toFixed(3), steps: best.steps, dir: best.dir,
      };
    }""",
        [step, limit, margin],
    )


def main():
    if not (DIST / "index.html").exists():
        sys.exit("dist/ missing — run `npm run build` first")
    httpd = serve()
    port = httpd.server_address[1]
    findings = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
                if m.type == "error" else None)
        # `load` never fires: the game holds the GPU context and the rAF loop
        # open, so the page never reaches the "everything quiesced" state.
        # domcontentloaded + the handle is the real readiness signal.
        page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="domcontentloaded", timeout=30000)
        wait_boot(page)
        # Deterministic boot: wipe any slot the previous run left, reload, then
        # drive the title into a NEW game. This pass measures rendering, not
        # prose, so it clears the opening monologue before the first screenshot.
        page.evaluate("() => window.localStorage.clear()")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        wait_boot(page)
        started = start_new_game(page)
        print(f"  new game started: {started}")
        if not started:
            print("  WARNING: could not get past the title")
        # Stand the party where the game PROMISES a formation fits: the village's
        # own spawn, which clearSpawn chose by searching for a disc clear of every
        # collider it built. Teleporting to the village centre instead put the
        # wedge slots inside the houses, one follower could not reach its slot, and
        # the resulting overlap was reported as a party-spread regression.
        page.evaluate("() => window.__hd2d.teleport(window.__hd2d.village.spawn.x, window.__hd2d.village.spawn.z)")
        page.wait_for_timeout(400)

        print("\n== overworld ==")
        state = page.evaluate(PAGE)
        print("  state:", json.dumps(state))
        findings["bootState"] = state
        shot(page, "01-overworld-scale2")

        # BUG 5 — does renderScale change the image at all? Measured on the PNG.
        print("\n== BUG 5: renderScale pixelation ==")
        chunk = {}
        for n in (1, 2, 3, 4):
            page.evaluate(f"() => window.__hd2d.scale({n})")
            page.wait_for_timeout(400)
            path = shot(page, f"02-scale{n}")
            chunk[n] = block_stats(path)
            print(f"  scale {n}: {json.dumps(chunk[n])}")
        findings["chunkinessByScale"] = chunk

        page.evaluate("() => window.__hd2d.scale(2)")

        # BUG 6 / BUG 10 — party overlap
        print("\n== BUG 6/10: party sprite spread ==")
        # The leader was teleported a moment ago, so the follow chain is still
        # walking into its slots; three stacked-in-transit members are not a
        # regression, so measure only once they have stopped moving. If they never
        # stop, that IS the finding: fail here rather than measure a moving party.
        waited, settled, reach = settle_party(page)
        print(f"  party settled after {waited}ms: {settled}; reach from leader {reach}")
        if not settled:
            sys.exit("FAIL: the party never stopped moving — the formation is stuck")
        # The wedge reaches ~2.6 with the actor radius. A follower further than
        # that is not parked, it is blocked.
        if max(reach) > 2.8:
            sys.exit(f"FAIL: a follower is {max(reach)} from the leader — it is stuck, not in its slot")
        sprites = sprite_boxes(page, party_only=True)
        for s in sprites:
            print(f"  sprite h={s['h']:4d}px w={s['wpx']:3d}px at ({s['x']},{s['top']}) "
                  f"world=({s['worldX']},{s['worldZ']}) shown={s['shown']}")
        if len(sprites) >= 2:
            xs = [s["x"] for s in sprites]
            print(f"  bbox {max(xs) - min(xs)}px wide, "
                  f"median height {sorted(s['h'] for s in sprites)[len(sprites) // 2]}px")
            # Overlap: pair the boxes and report the worst intersection, WITH
            # attribution. A bare "13%" cannot be checked — without knowing which
            # pair produced it you cannot tell a real residual overlap from an
            # arithmetic slip, and a later round's number cannot be compared to
            # this one. So the worst pair is named in the output and the report.
            worst = 0.0
            worst_pair = None
            for i in range(len(sprites)):
                for j in range(i + 1, len(sprites)):
                    a, b = sprites[i], sprites[j]
                    ox = min(a["x"] + a["wpx"], b["x"] + b["wpx"]) - max(a["x"], b["x"])
                    oy = min(a["bottom"], b["bottom"]) - max(a["top"], b["top"])
                    if ox > 0 and oy > 0:
                        frac = (ox * oy) / min(a["h"] * a["wpx"], b["h"] * b["wpx"])
                        if frac > worst:
                            worst = frac
                            worst_pair = (
                                f"m{i}({a['worldX']},{a['worldZ']})"
                                f"<->m{j}({b['worldX']},{b['worldZ']}) ox={ox}px oy={oy}px"
                            )
            if worst_pair:
                print(f"  worst pairwise box overlap: {100 * worst:.0f}% of the smaller sprite  [{worst_pair}]")
            else:
                print("  worst pairwise box overlap: 0% (no pair intersects)")
            findings["partyOverlapPct"] = round(100 * worst, 1)
            findings["partyOverlapPair"] = worst_pair
        findings["partySprites"] = sprites
        shot(page, "03-party")

        # BUG 8 — blocked ground. The target (<25%) is a WILDERNESS reading, so
        # the two numbers below are measured in the two different places and
        # only the wilderness one is compared against it.
        print("\n== BUG 8: impassable ground (wilderness) ==")
        village = blocked_fraction(page)
        village["pct"] = round(100 * village["blocked"] / max(1, village["walkable"]), 1)
        print("  village (INFORMATIONAL ONLY — houses and fences are obstacles by "
              "design here, so this is not read against 25%):")
        print("   ", json.dumps(village))
        findings["blockedVillage"] = village

        wild = wilderness_spot(page)
        print("  wilderness spot:", json.dumps(wild))
        if "x" in wild:
            # bounded poll: a teleport is synchronous, so this returns at once
            # in the happy case and costs 3s only if the leader is frozen.
            page.wait_for_function(
                "([x, z]) => { const p = window.__hd2d.leaderPos();"
                " return Math.hypot(p[0] - x, p[1] - z) < 0.05; }",
                arg=[wild["x"], wild["z"]],
                timeout=3000,
            )
        b = blocked_fraction(page)
        b["where"] = "wilderness"
        b["pct"] = round(100 * b["blocked"] / max(1, b["walkable"]), 1)
        print("  wilderness:", json.dumps(b), f"(target < 25%)")
        findings["blocked"] = b

        # Back to the terrace: BUG 7 below is a walk test and wants the clear
        # ground it was written against, so it stands where the run started.
        page.evaluate("() => window.__hd2d.teleport(window.__hd2d.village.spawn.x, window.__hd2d.village.spawn.z)")
        page.wait_for_timeout(400)

        # BUG 7 — walked vs real displacement. Real key events, real input.js.
        print("\n== BUG 7: walked counter ==")
        before = page.evaluate("() => ({ p: window.__hd2d.leaderPos(), w: window.__hd2d.state.walked })")
        page.keyboard.down("KeyW")
        page.wait_for_timeout(1500)
        page.keyboard.up("KeyW")
        page.wait_for_timeout(150)
        after = page.evaluate("() => ({ p: window.__hd2d.leaderPos(), w: window.__hd2d.state.walked })")
        walk = {
            "real": round(((after["p"][0] - before["p"][0]) ** 2 + (after["p"][1] - before["p"][1]) ** 2) ** 0.5, 2),
            "walked": round(after["w"] - before["w"], 2),
        }
        walk["errorPct"] = round(100 * abs(walk["walked"] - walk["real"]) / max(0.01, walk["real"]), 1)
        print("  ", json.dumps(walk))
        findings["walk"] = walk
        shot(page, "04-after-walk")

        # BUG 1 / BUG 2 / BUG 3 — battle
        print("\n== BUG 1/2/3: battle ==")
        # No `return`: encounter() resolves when the FIGHT ends, and page.evaluate
        # awaits any promise the callback returns. Returning it deadlocks the run
        # on the first command prompt, waiting for a keypress nobody sends.
        page.evaluate("() => { window.__hd2d.encounter('meadow', ['sentinel']); }")
        # bounded: every step below is a poll, never a blind sleep, so a stall
        # costs one iteration instead of the whole run.
        page.wait_for_function("() => window.__hd2d.state.promptOpen === true", timeout=25000)
        page.wait_for_timeout(400)
        st = page.evaluate(PAGE)
        print("  state:", json.dumps(st))
        # The battle reveal is behind a fade, so give it the length of the fade
        # before capturing or the shot is a black rectangle.
        shot(page, "05-battle", settle=900)
        findings["battleState"] = st

        prompt = page.evaluate(
            """() => {
      const p = document.querySelector('.bt-prompt');
      if (!p) return { error: 'no .bt-prompt element' };
      return {
        hidden: p.hidden,
        cls: p.className,
        title: p.querySelector('.bt-title')?.textContent ?? null,
        rows: [...p.querySelectorAll('.bt-row')].map((r) => ({
          cls: r.className, text: r.textContent.trim(),
        })),
      };
    }"""
        )
        print("  prompt:", json.dumps(prompt, indent=2))
        findings["prompt"] = prompt

        esprites = sprite_boxes(page)
        print("  sprites in battle:")
        for s in esprites:
            print(f"    h={s['h']:4d}px w={s['wpx']:3d}px at ({s['x']},{s['top']}) shown={s['shown']}")
        findings["battleSprites"] = esprites

        # BUG 2 teardown leak: drive the fight to its end, then count sprites.
        print("  driving the fight out…")
        for _ in range(120):
            mode = page.evaluate("() => window.__hd2d.state.mode")
            if mode == "overworld":
                break
            tap(page, "Enter")
        page.wait_for_timeout(1500)
        after_b = page.evaluate(
            """() => {
      const H = window.__hd2d;
      let sprites = 0;
      H.scene.traverse((o) => { if (o.isSprite && o.material.map) sprites++; });
      return { mode: H.state.mode, sprites, battle: H.state.battle };
    }"""
        )
        print("  after battle:", json.dumps(after_b))
        shot(page, "06-after-battle")
        findings["afterBattle"] = after_b

        page.wait_for_timeout(400)
        print("\npage errors:", errors or "none")
        findings["errors"] = errors
        browser.close()
    httpd.shutdown()

    # ------------------------------------------------------------------ verdict --
    # An ASSERTION BLOCK, because without one this pass cannot fail: it printed
    # numbers and exited 0 whatever they said, so docs/qa-findings.md was a report
    # rather than a test result, and a later regression in any of these would have
    # been read past. thresholds are guards, not targets — the party overlap band
    # is generous on purpose, since the exact figure depends on frame timing.
    failures = []

    def must(name, ok, detail=""):
        print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  ' + str(detail)) if detail else ''}")
        if not ok:
            failures.append(f"{name}: {detail}")

    print("\n== verdict ==")
    over = findings.get("partyOverlapPct")
    must("party overlap under 25%", isinstance(over, (int, float)) and over < 25, f"{over}%")
    blocked = findings.get("blocked", {}).get("pct")
    must("wilderness blocked under 25%", isinstance(blocked, (int, float)) and blocked < 25, f"{blocked}%")
    walk = findings.get("walk", {})
    must("walked counter within 10% of real travel",
         walk.get("errorPct") is not None and walk["errorPct"] < 10, f"{walk.get('errorPct')}%")
    rows = findings.get("prompt", {}).get("rows") or []
    must("the battle command list rendered rows", len(rows) >= 3, f"{len(rows)} rows")
    after = findings.get("afterBattle", {})
    must("the fight can be driven to a result", after.get("mode") == "overworld", after.get("mode"))
    must("no page errors", not errors, (errors or [])[:2])

    out = ROOT / "docs" / "qa-report.json"
    out.write_text(json.dumps(findings, indent=2), encoding="utf-8")
    print(f"\nwrote {out.relative_to(ROOT)}")

    if failures:
        print(f"\n{len(failures)} FAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\npixel pass: all checks passed")


if __name__ == "__main__":
    main()
