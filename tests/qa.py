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
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

import qa_server

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


def tap(page, key, hold=60, settle=340):
    """A keystroke the input layer can actually see.

    core/input.js builds its press EDGE inside update() as (held - prev), so
    page.keyboard.press() — a down and an up a millisecond apart — is dropped
    whenever no frame lands between them. Every tap in this pass must be
    down / wait / up.
    """
    page.keyboard.down(key)
    page.wait_for_timeout(hold)
    page.keyboard.up(key)
    page.wait_for_timeout(settle)


def skip_dialogue(page, limit=40):
    """Close whatever is open at boot.

    A fresh game now opens with the area intro AND the first stage's lines
    (level1.json), because `speakStage()` is chained off the intro's promise.
    That is five lines, each needing two presses. Without this, every later
    measurement in the pass reads a game that is still talking, and BUG 7
    reports `real: 0.0` for a walk that never happened.
    """
    for _ in range(limit):
        if page.evaluate("() => window.__hd2d.state.mode") != "dialogue":
            return
        tap(page, "KeyE", hold=50, settle=90)


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


def sprite_boxes(page):
    """Screen-space box of every sprite in the scene, party and enemies alike.

    Read off the world matrix, because a sprite's local position is relative to
    its own group and reading it directly puts every party member at (0,0).
    """
    return page.evaluate(
        """() => {
      const H = window.__hd2d, THREE = H.THREE;
      const cam = H.engine.camera, w = H.engine.width, hh = H.engine.height;
      const v = new THREE.Vector3();
      const out = [];
      H.scene.traverse((o) => {
        if (!o.isSprite || !o.material.map) return;
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
    }"""
    )


def blocked_fraction(page, radius=3.0, step=0.25):
    """Sample a disc around the leader and report how much is impassable."""
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
        # A fresh game opens with the area intro. This pass measures rendering,
        # not prose, so it closes it before the first screenshot.
        page.evaluate("() => window.localStorage.clear()")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        wait_boot(page)
        # The intro is a promise chain: `speakStage()` for stage 1 runs in the
        # `.then()` AFTER the intro's last line closes, so a `skip_dialogue` that
        # only watches `mode` stops one beat early and leaves the briefing open.
        # Drain until the world is quiet for two consecutive reads.
        for _ in range(6):
            skip_dialogue(page)
            page.wait_for_timeout(250)
            if page.evaluate("() => window.__hd2d.state.mode") == "overworld":
                break
        page.wait_for_timeout(400)
        page.evaluate("() => window.__hd2d.teleport(20.5, 28.5)")
        page.wait_for_timeout(300)

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
        sprites = sprite_boxes(page)
        for s in sprites:
            print(f"  sprite h={s['h']:4d}px w={s['wpx']:3d}px at ({s['x']},{s['top']}) "
                  f"world=({s['worldX']},{s['worldZ']}) shown={s['shown']}")
        if len(sprites) >= 2:
            xs = [s["x"] for s in sprites]
            print(f"  bbox {max(xs) - min(xs)}px wide, "
                  f"median height {sorted(s['h'] for s in sprites)[len(sprites) // 2]}px")
            # overlap: pair the boxes and report the worst intersection
            worst = 0.0
            for i in range(len(sprites)):
                for j in range(i + 1, len(sprites)):
                    a, b = sprites[i], sprites[j]
                    ox = min(a["x"] + a["wpx"], b["x"] + b["wpx"]) - max(a["x"], b["x"])
                    oy = min(a["bottom"], b["bottom"]) - max(a["top"], b["top"])
                    if ox > 0 and oy > 0:
                        worst = max(worst, (ox * oy) / min(a["h"] * a["wpx"], b["h"] * b["wpx"]))
            print(f"  worst pairwise box overlap: {100 * worst:.0f}% of the smaller sprite")
            findings["partyOverlapPct"] = round(100 * worst, 1)
        findings["partySprites"] = sprites
        shot(page, "03-party")

        # BUG 8 — blocked ground
        print("\n== BUG 8: impassable ground ==")
        b = blocked_fraction(page)
        b["pct"] = round(100 * b["blocked"] / max(1, b["walkable"]), 1)
        print("  ", json.dumps(b))
        findings["blocked"] = b

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

    out = ROOT / "docs" / "qa-report.json"
    out.write_text(json.dumps(findings, indent=2), encoding="utf-8")
    print(f"\nwrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
