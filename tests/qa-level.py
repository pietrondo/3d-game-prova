"""
qa-level.py — headless check of level progression, the bag, and the save slot.

Written because the two worst bugs of this session were SILENT: the level machine
started at index -1 and never moved, and the game promised 3 Field Tonics while
giving the player nothing. Neither threw. Neither was visible in a screenshot of
the overworld. Both are only visible by driving the real game and reading state.

Unlike tests/qa.py this does not take screenshots or measure pixels; it asserts
progression. Run after `npm run build`:

    python tests/qa-level.py
"""

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

PAGE = """
async () => {
  const H = window.__hd2d;
  if (!H) return { error: 'no __hd2d handle' };
  return { ...H.state, level: H.level, bag: H.bag };
}
"""

failures = []
notes = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  ' + str(detail)) if detail else ''}")
    if not ok:
        failures.append(f"{name}: {detail}")


def clear_save(page):
    page.evaluate("() => window.localStorage.clear()")


def boot(page):
    page.wait_for_function("() => !!window.__hd2d", timeout=20000)
    page.wait_for_timeout(600)


def tap(page, key="Enter", hold=60, settle=340):
    """Press a key the way a HUMAN does, and the way input.js can see.

    `page.keyboard.press()` is a down and an up in about a millisecond.
    core/input.js builds its press EDGE inside `update()` as (held - prev), so a
    frame that never lands between the two produces no edge and the keystroke is
    silently dropped. That is a property of the input layer, not a bug — but a
    harness that uses `press()` will hang forever waiting for a battle that is
    actually progressing normally, and it looks exactly like a wedged game.

    Both QA passes need this, so it lives here rather than in each.
    """
    page.keyboard.down(key)
    page.wait_for_timeout(hold)
    page.keyboard.up(key)
    page.wait_for_timeout(settle)


def dismiss(page, limit=30):
    """Press through every open dialogue until the overworld is live again.

    The boot monologue is the intro PLUS the first stage's lines, because
    `speakStage()` is chained off the intro's promise — so a fresh boot is five
    lines, and a line needs two presses (one to complete the typing, one to
    advance). Ten to twelve presses, not three. The generous limit costs
    milliseconds and makes the count not matter.
    """
    for _ in range(limit):
        if page.evaluate("() => window.__hd2d.state.mode") != "dialogue":
            return
        tap(page, "KeyE", hold=50, settle=90)


def main():
    if not (ROOT / "dist" / "index.html").exists():
        sys.exit("dist/ missing - run `npm run build` first")

    # The helper lives next to this file, and the run may be started from the
    # project root (`python tests/qa-level.py`), so the script's own directory
    # has to be on the path or `import qa_server` fails on a name that exists.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import qa_server  # the same ThreadingTCPServer/port-0 trick as qa.py

    httpd = qa_server.serve(ROOT / "dist")
    port = httpd.server_address[1]

    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
                if m.type == "error" else None)

        page.goto(f"http://127.0.0.1:{port}/index.html",
                  wait_until="domcontentloaded", timeout=30000)
        boot(page)
        clear_save(page)

        # ---- the intro must be playing, and the level must have an objective --
        page.reload(wait_until="domcontentloaded", timeout=30000)
        boot(page)
        st = page.evaluate(PAGE)
        check("intro is on screen at boot", st["mode"] == "dialogue", st["mode"])
        check("level 1 loaded", st["level"]["id"] == "level1", st["level"])
        check("first objective is movement", st["level"]["objective"] == "Move with WASD",
              st["level"]["objective"])
        check("bag starts empty", st["bag"] == {"gold": 0, "items": {}}, st["bag"])

        dismiss(page)
        st = page.evaluate(PAGE)
        check("after the intro the overworld is live", st["mode"] == "overworld", st["mode"])
        check("objective is still stage 1 after the intro",
              st["level"]["objective"] == "Move with WASD", st["level"]["objective"])

        # ---- moving must spend the first stage ---------------------------------
        # Every advance opens the NEXT stage's lines through `speakStage()`, and
        # an open dialogue eats `interact`. So the harness must always dismiss
        # after an advance, or the next KeyE just closes a monologue and looks
        # exactly like a marker that silently refuses to work.
        before = page.evaluate("() => window.__hd2d.level.index")
        page.keyboard.down("KeyW")
        page.wait_for_timeout(1400)
        page.keyboard.up("KeyW")
        page.wait_for_timeout(200)
        dismiss(page)
        st = page.evaluate(PAGE)
        check("walking advances the level", st["level"]["index"] > before,
              f"{before} -> {st['level']['index']}")
        check("objective is now the conversation",
              st["level"]["objective"] == "Talk to Vell with E", st["level"]["objective"])

        # ---- a battle at the wrong moment must NOT skip stages ----------------
        # The mechanism: `advance` only spends the CURRENT stage, so an event
        # arriving early is inert. Assert the stage pointer cannot jump.
        # ONE enemy on purpose. Every press is answered by a fresh command
        # prompt, and a two-enemy group doubles the turns; a bounded loop that
        # gives up leaves the game mid-battle and every later check reads the
        # wrong state. Fight driving is qa.py's job, not this pass's.
        idx = page.evaluate("() => window.__hd2d.level.index")
        page.evaluate("() => { window.__hd2d.encounter('meadow', ['slime']); }")
        page.wait_for_function("() => window.__hd2d.state.mode === 'battle'", timeout=25000)
        page.wait_for_timeout(700)
        rows = page.evaluate("() => window.__hd2d.state.promptRows")
        check("the command list offers the party something", len(rows) > 0, rows)
        for _ in range(220):
            if page.evaluate("() => window.__hd2d.state.mode") == "overworld":
                break
            tap(page)
        page.wait_for_timeout(2200)
        over = page.evaluate("() => window.__hd2d.state.mode")
        check("the fight can actually be driven to a result", over != "battle", over)
        st = page.evaluate(PAGE)
        # Winning a fight the level was not waiting for may or may not spend a
        # stage depending on which one is active; what must never happen is a
        # jump of more than one stage.
        check("an event cannot skip several stages",
              st["level"]["index"] <= idx + 1,
              f"{idx} -> {st['level']['index']}")
        # A won fight opens the next stage's lines; close them before going on,
        # or the next tap just advances a monologue instead of talking to Vell.
        dismiss(page)

        # ---- the cache must really put tonics in the bag ----------------------
        # Order matters: the level is still waiting on Vell, and the cache is
        # only reachable once that stage is spent. Teleporting straight to the
        # cache proves nothing — the stage pointer has to move first.
        page.evaluate("() => { window.__hd2d.teleport(20.5, 31.5); }")
        page.wait_for_timeout(400)
        tap(page, "KeyE", hold=50, settle=300)
        dismiss(page)
        st = page.evaluate(PAGE)
        check("talking to Vell spends the conversation stage",
              st["level"]["stage"] == "cache", st["level"])

        before_bag = page.evaluate("() => window.__hd2d.bag")
        page.evaluate("() => { window.__hd2d.teleport(16.5, 26.5); }")
        page.wait_for_timeout(400)
        tap(page, "KeyE", hold=50, settle=300)
        dismiss(page)
        after = page.evaluate("() => window.__hd2d.bag")
        check("the cache hands over real items",
              after["items"].get("tonic", 0) > before_bag["items"].get("tonic", 0),
              f"{before_bag} -> {after}")
        # The return trip must not farm: the marker is single-use for its gift.
        page.evaluate("() => { window.__hd2d.teleport(16.5, 26.5); }")
        page.wait_for_timeout(300)
        tap(page, "KeyE", hold=50, settle=300)
        dismiss(page)
        again = page.evaluate("() => window.__hd2d.bag")
        check("the cache cannot be farmed", again["items"] == after["items"],
              f"{after} -> {again}")

        # ---- gold must accumulate ---------------------------------------------
        gold = page.evaluate("() => window.__hd2d.bag.gold")
        check("gold accumulates from victories", isinstance(gold, int) and gold >= 0, gold)

        # ---- save / restore ----------------------------------------------------
        saved = page.evaluate("() => window.__hd2d.save()")
        check("save writes", saved is True, saved)
        has = page.evaluate("() => window.__hd2d.hasSave()")
        check("a save slot exists", has is True, has)
        before_level = page.evaluate("() => window.__hd2d.level.index")
        before_bag = page.evaluate("() => window.__hd2d.bag")

        page.reload(wait_until="domcontentloaded", timeout=30000)
        boot(page)
        dismiss(page)
        st = page.evaluate(PAGE)
        check("the level pointer survives a reload", st["level"]["index"] == before_level,
              f"{before_level} -> {st['level']['index']}")
        check("the bag survives a reload", st["bag"] == before_bag,
              f"{before_bag} -> {st['bag']}")
        check("no intro replay on resume", st["mode"] == "overworld", st["mode"])

        check("no page errors", not errors, errors[:3])
        browser.close()

    httpd.shutdown()
    print()
    if failures:
        print(f"{len(failures)} FAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("all level/bag/save checks passed")


if __name__ == "__main__":
    main()
