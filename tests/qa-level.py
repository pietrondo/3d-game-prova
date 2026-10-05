"""
qa-level.py — headless check of the title screen, level progression, the bag,
the village and the save slot.

Written because the worst bugs of this project were SILENT. The level machine
started at index -1 and never advanced; the game promised 3 tonici and gave the
player nothing; the title screen did not disappear on "Nuova partita" because a
CSS `display` beat the browser's `[hidden]`. None of the three threw. None was
visible in a screenshot of the overworld. All three are only visible by driving
the real game and reading state, which is what this pass does.

Run after `npm run build`:

    python tests/qa-level.py
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qa_server
import qa_drive

ROOT = Path(__file__).resolve().parent.parent

PAGE = """
async () => {
  const H = window.__hd2d;
  if (!H) return { error: 'no __hd2d handle' };
  return { ...H.state, level: H.level, bag: H.bag, village: H.village };
}
"""

# Is the start panel ACTUALLY gone? `hidden` is not enough to ask: an author
# `display` rule overrides the UA `[hidden]` rule, so the attribute can be true
# while the panel is still on screen. This reads the computed style.
TITLE_VISIBLE = """() => {
  const t = document.querySelector('.title');
  if (!t) return false;
  const cs = getComputedStyle(t);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && t.getBoundingClientRect().height > 0;
}"""

failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  ' + str(detail)) if detail else ''}")
    if not ok:
        failures.append(f"{name}: {detail}")


def main():
    if not (ROOT / "dist" / "index.html").exists():
        sys.exit("dist/ missing - run `npm run build` first")

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
        page.wait_for_function("() => !!window.__hd2d", timeout=30000)
        page.wait_for_timeout(900)
        page.evaluate("() => window.localStorage.clear()")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        page.wait_for_function("() => !!window.__hd2d", timeout=30000)
        page.wait_for_timeout(1000)

        print("\n== start screen ==")
        ts = page.evaluate("() => window.__hd2d.titleState")
        check("the title is up at boot", ts["open"] is True, ts)
        check("the cursor starts on Nuova partita", ts["selection"] == "new", ts["selection"])
        check("Continua is disabled with no save", ts["hasSave"] is False, ts["hasSave"])
        check("the title panel is actually visible", page.evaluate(TITLE_VISIBLE) is True)

        # The regression: an author `display: grid` on `.title` beat the UA
        # `[hidden] { display: none }`, so el.hidden = true did nothing and the
        # menu stayed over the game after starting.
        page.click(".title-row[data-id='new']")
        page.wait_for_timeout(800)
        check("choosing Nuova partita hides the title", page.evaluate(TITLE_VISIBLE) is False)
        check("starting a game leaves the title state",
              page.evaluate("() => window.__hd2d.titleState.open") is False)

        print("\n== intro and first stage ==")
        page.wait_for_timeout(400)
        st = page.evaluate(PAGE)
        check("the intro is playing", st["mode"] == "dialogue", st["mode"])
        check("level 1 loaded", st["level"]["id"] == "level1", st["level"]["id"])
        check("the first objective is movement",
              st["level"]["objective"] == "Muoviti con WASD", st["level"]["objective"])
        check("the bag starts empty", st["bag"] == {"gold": 0, "items": {}}, st["bag"])

        qa_drive.start_new_game(page)
        st = page.evaluate(PAGE)
        check("the overworld is live after the intro", st["mode"] == "overworld", st["mode"])

        print("\n== village ==")
        v = st["village"]
        check("the village has a name", bool(v["name"]), v.get("name"))
        check("the village has a terrace centre", v["centre"] is not None, v["centre"])
        check("the village has buildings", v["pieces"] > 4, v["pieces"])
        check("the village has solid colliders", v["colliders"] > 4, v["colliders"])
        check("the village has talkable anchors", len(v["anchors"]) >= 2, len(v["anchors"]))
        spawn = page.evaluate("() => window.__hd2d.leaderPos()")
        check("the party starts inside the village safe zone",
              page.evaluate(f"() => window.__hd2d.inVillage({spawn[0]}, {spawn[1]})") is True, spawn)

        print("\n== progression ==")
        before = page.evaluate("() => window.__hd2d.level.index")
        qa_drive.tap(page, "KeyW", hold=50, settle=60)
        page.keyboard.down("KeyW")
        page.wait_for_timeout(1500)
        page.keyboard.up("KeyW")
        page.wait_for_timeout(300)
        qa_drive.dismiss(page)
        st = page.evaluate(PAGE)
        check("walking advances the level", st["level"]["index"] > before,
              f"{before} -> {st['level']['index']}")

        markers = page.evaluate("() => window.__hd2d.markers")
        by_id = {m["id"]: m for m in markers}
        check("the village elder is a marker", "vell" in by_id, list(by_id))

        # Winning a fight the level is not waiting for must not skip stages.
        idx = page.evaluate("() => window.__hd2d.level.index")
        page.evaluate("() => { window.__hd2d.encounter('meadow', ['slime']); }")
        page.wait_for_function("() => window.__hd2d.state.mode === 'battle'", timeout=25000)
        page.wait_for_timeout(700)
        rows = page.evaluate("() => window.__hd2d.state.promptRows")
        check("the command list is in Italian", "Attacco" in rows, rows)
        for _ in range(220):
            if page.evaluate("() => window.__hd2d.state.mode") == "overworld":
                break
            qa_drive.tap(page)
        page.wait_for_timeout(2200)
        st = page.evaluate(PAGE)
        check("the fight can be driven to a result", st["mode"] != "battle", st["mode"])
        check("an event cannot skip several stages",
              st["level"]["index"] <= idx + 1, f"{idx} -> {st['level']['index']}")
        check("gold accumulates from victories", st["bag"]["gold"] > 0, st["bag"]["gold"])
        qa_drive.dismiss(page)

        print("\n== the cache ==")
        # Order matters: the level is waiting on the elder, and the cache's stage
        # is only reachable once that one is spent. Teleporting straight to the
        # cache proves nothing about ordering.
        elder = page.evaluate("() => window.__hd2d.markers.find(m => m.id === 'vell')")
        page.evaluate(f"() => window.__hd2d.teleport({elder['x']}, {elder['z']})")
        page.wait_for_timeout(400)
        qa_drive.tap(page, "KeyE", hold=50, settle=300)
        qa_drive.dismiss(page)
        st = page.evaluate(PAGE)
        check("talking to the elder spends its stage",
              st["level"]["stage"] == "cache", st["level"])

        before_bag = page.evaluate("() => window.__hd2d.bag")
        cache = page.evaluate("() => window.__hd2d.markers.find(m => m.id === 'cache')")
        page.evaluate(f"() => window.__hd2d.teleport({cache['x']}, {cache['z']})")
        page.wait_for_timeout(400)
        qa_drive.tap(page, "KeyE", hold=50, settle=300)
        qa_drive.dismiss(page)
        after = page.evaluate("() => window.__hd2d.bag")
        check("the cache hands over real items",
              after["items"].get("tonic", 0) > before_bag["items"].get("tonic", 0),
              f"{before_bag} -> {after}")

        page.evaluate(f"() => window.__hd2d.teleport({cache['x']}, {cache['z']})")
        page.wait_for_timeout(300)
        qa_drive.tap(page, "KeyE", hold=50, settle=300)
        qa_drive.dismiss(page)
        again = page.evaluate("() => window.__hd2d.bag")
        check("the cache cannot be farmed", again["items"] == after["items"],
              f"{after} -> {again}")

        print("\n== the shop ==")
        # The economy had no sink: gold accumulated and items.json's `price` was
        # read by nothing. This asserts the counter actually takes gold and hands
        # over the item, which a screenshot of a toast cannot prove.
        before_shop = page.evaluate("() => window.__hd2d.bag")
        check("the wreck paid enough to shop", before_shop["gold"] >= 30, before_shop["gold"])
        smith = page.evaluate("() => window.__hd2d.markers.find(m => m.id === 'fabbro')")
        check("the blacksmith is a marker", smith is not None, smith)
        page.evaluate(f"() => window.__hd2d.teleport({smith['x']}, {smith['z']})")
        page.wait_for_timeout(400)
        # Talk, then drain his greeting and the counter opens. The marker is
        # repeatable, so a second tap reopens the shop directly if the first
        # landed a beat early.
        for _ in range(3):
            qa_drive.tap(page, "KeyE", hold=50, settle=300)
            qa_drive.dismiss(page)
            page.wait_for_timeout(300)
            if page.evaluate("() => window.__hd2d.shopState.open"):
                break
        shop = page.evaluate("() => window.__hd2d.shopState")
        check("the shop opens", shop["open"] is True, shop)
        check("the shop lists its stock", len(shop["rows"]) >= 3, shop["rows"])
        # Evidence, not just a number: the counter is the one UI that has never
        # been looked at, and "the rows exist" says nothing about whether they fit.
        SHOTS = ROOT / "docs" / "shots"
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / "07-shop.png"))
        print(f"  shot  {(SHOTS / '07-shop.png').relative_to(ROOT)}")

        first = page.evaluate("() => window.__hd2d.shopState.rows[0]")
        bought = page.evaluate("() => window.__hd2d.shopState.selection")
        check("the cursor starts on the first item", bought == first["id"], bought)
        qa_drive.tap(page)   # Enter buys the selected row
        page.wait_for_timeout(300)
        after_buy = page.evaluate("() => window.__hd2d.bag")
        check("buying takes the gold",
              after_buy["gold"] == before_shop["gold"] - first["price"],
              f"{before_shop['gold']} - {first['price']} -> {after_buy['gold']}")
        check("buying delivers the item",
              after_buy["items"].get(first["id"], 0) > before_shop["items"].get(first["id"], 0),
              f"{before_shop['items']} -> {after_buy['items']}")

        # Buying again with too little gold must refuse without charging.
        short = page.evaluate("() => window.__hd2d.bag.gold")
        for _ in range(8):
            qa_drive.tap(page)
            page.wait_for_timeout(120)
        drained = page.evaluate("() => window.__hd2d.bag.gold")
        check("the shop never lets the purse go negative", drained >= 0, f"{short} -> {drained}")
        qa_drive.tap(page, "Escape", hold=50, settle=300)
        check("Esc leaves the counter",
              page.evaluate("() => window.__hd2d.shopState.open") is False)

        print("\n== save / load ==")
        saved = page.evaluate("() => window.__hd2d.save()")
        check("save writes", saved is True, saved)
        before_level = page.evaluate("() => window.__hd2d.level.index")
        before_bag = page.evaluate("() => window.__hd2d.bag")

        page.reload(wait_until="domcontentloaded", timeout=30000)
        page.wait_for_function("() => !!window.__hd2d", timeout=30000)
        page.wait_for_timeout(1000)
        ts = page.evaluate("() => window.__hd2d.titleState")
        check("the title offers Continua once a save exists", ts["hasSave"] is True, ts)
        # Continua is row index 1; navigate to it explicitly rather than relying
        # on the cursor position.
        page.click(".title-row[data-id='continue']")
        page.wait_for_timeout(900)
        qa_drive.dismiss(page)
        st = page.evaluate(PAGE)
        check("the title hides on Continua too", page.evaluate(TITLE_VISIBLE) is False)
        check("the level pointer survives a reload", st["level"]["index"] == before_level,
              f"{before_level} -> {st['level']['index']}")
        check("the bag survives a reload", st["bag"] == before_bag,
              f"{before_bag} -> {st['bag']}")
        check("no intro replay on resume", st["mode"] == "overworld", st["mode"])

        print("\n== info panel ==")
        # Esc via tap(), not press(): core/input.js derives the edge inside
        # update(), so a press() with no frame between down and up never fires.
        qa_drive.tap(page, "Escape", hold=60, settle=500)
        menu_open = page.evaluate("() => !!document.querySelector('.menu:not([hidden])')")
        check("Esc opens the pause menu", menu_open is True, menu_open)
        # Back to the title from the pause menu: Sistema tab -> Torna al titolo.
        page.click(".menu-item[data-tab='Sistema']")
        page.wait_for_timeout(300)
        page.click(".menu-item[data-act='act-title']")
        page.wait_for_timeout(700)
        check("Torna al titolo reopens the start screen", page.evaluate(TITLE_VISIBLE) is True)
        page.click(".title-row[data-id='info']")
        page.wait_for_timeout(400)
        has_info = page.evaluate("() => !!document.querySelector('.title-info')")
        check("Informazioni opens a panel", has_info is True, has_info)
        qa_drive.tap(page, "Escape", hold=60, settle=300)
        check("the info panel closes back to the menu",
              page.evaluate("() => window.__hd2d.titleState.view") == "menu")

        check("no page errors", not errors, errors[:3])
        browser.close()

    httpd.shutdown()
    print()
    if failures:
        print(f"{len(failures)} FAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("all title / level / village / bag / save checks passed")


if __name__ == "__main__":
    main()
