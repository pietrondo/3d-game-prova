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
  return { ...H.state, level: H.level, bag: H.bag, village: H.village, area: H.area };
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

        # THE REGRESSION. Opening the counter must not buy anything: `core/input.js`
        # latches the `interact` edge once per frame and shares it, and dialogue.js
        # closes on its own listener without consuming it, so the press that ends
        # the greeting used to arrive at `shop.read()` on the next frame and buy a
        # 30-gold tonic nobody chose. Measured before the fix: gold 40 -> 10 and the
        # tonics went up on the very press that opened the panel.
        #
        # The old assertion could not see it: it compared against `before_shop`
        # AFTER the drain, so an auto-buy plus a refused explicit tap still summed
        # to exactly one price.
        opened = page.evaluate("() => window.__hd2d.bag")
        check("opening the counter buys nothing", opened == before_shop,
              f"{before_shop} -> {opened}")

        qa_drive.tap(page)   # Enter buys the selected row, deliberately
        page.wait_for_timeout(300)
        after_buy = page.evaluate("() => window.__hd2d.bag")
        check("one buy takes exactly one price",
              after_buy["gold"] == opened["gold"] - first["price"],
              f"{opened['gold']} - {first['price']} -> {after_buy['gold']}")
        check("one buy delivers exactly one item",
              after_buy["items"].get(first["id"], 0) == opened["items"].get(first["id"], 0) + 1,
              f"{opened['items']} -> {after_buy['items']}")

        # Spend the rest, then try one more: a refusal must change nothing at all,
        # and must SAY so where the player can see it.
        for _ in range(12):
            page.evaluate("() => window.__hd2d.shopState")
            if page.evaluate("() => window.__hd2d.bag.gold") < first["price"]:
                break
            qa_drive.tap(page)
            page.wait_for_timeout(140)
        short = page.evaluate("() => window.__hd2d.bag")
        check("the purse cannot afford another", short["gold"] < first["price"], short["gold"])
        qa_drive.tap(page)   # this one must be refused
        page.wait_for_timeout(300)
        refused = page.evaluate("() => window.__hd2d.bag")
        check("a refused buy changes nothing", refused == short, f"{short} -> {refused}")
        # And the refusal is VISIBLE: the toast used to render inside the hidden
        # `.hud`, so "non bastano i soldi" was a message nobody could read.
        seen = page.evaluate("""() => {
          const t = document.querySelector('.hud-toast');
          const hud = document.querySelector('.hud');
          if (!t) return { found: false, hudHidden: hud ? hud.hidden : null };
          const cs = getComputedStyle(t);
          const r = t.getBoundingClientRect();
          return {
            found: true, text: t.textContent, display: cs.display, visibility: cs.visibility,
            opacity: cs.opacity, h: Math.round(r.height), w: Math.round(r.width),
            hudDisplay: hud ? getComputedStyle(hud).display : null,
            hudHidden: hud ? hud.hidden : null,
            hudClass: hud ? hud.className : null,
          };
        }""")
        check("a refused buy is visible to the player",
              seen.get("found") is True and seen.get("display") != "none" and seen.get("h", 0) > 0,
              seen)

        # ---- the sell side -------------------------------------------------
        # Ivo's own line is "portamelo e ci diamo un'occhiata" — BRING it to me.
        # The counter only bought, so the promise the dialogue makes was the one
        # thing the shop could not do.
        qa_drive.tap(page, "ArrowRight", hold=60, settle=300)
        side = page.evaluate("() => window.__hd2d.shopState")
        check("right switches to the sell side", side["mode"] == "sell", side["mode"])
        check("the sell side lists what is carried", len(side["rows"]) > 0, side["rows"])
        page.screenshot(path=str(SHOTS / "08-shop-sell.png"))
        print(f"  shot  {(SHOTS / '08-shop-sell.png').relative_to(ROOT)}")

        row = side["rows"][0]
        before_sell = page.evaluate("() => window.__hd2d.bag")
        qa_drive.tap(page)   # Enter sells the selected row
        page.wait_for_timeout(300)
        after_sell = page.evaluate("() => window.__hd2d.bag")
        check("selling hands over the item",
              after_sell["items"].get(row["id"], 0) == before_sell["items"].get(row["id"], 0) - 1,
              f"{before_sell['items']} -> {after_sell['items']}")
        check("selling pays the sell price",
              after_sell["gold"] == before_sell["gold"] + row["price"],
              f"{before_sell['gold']} + {row['price']} -> {after_sell['gold']}")

        # Empty the stack: the row must go, because it lists what is CARRIED and
        # nothing else, and a row for an item you do not have is a lie.
        for _ in range(12):
            if page.evaluate(f"() => window.__hd2d.bag.items['{row['id']}'] || 0") == 0:
                break
            qa_drive.tap(page)
            page.wait_for_timeout(140)
        left = page.evaluate("() => window.__hd2d.bag")
        gone = page.evaluate(f"() => window.__hd2d.shopState.rows.some(r => r.id === '{row['id']}')")
        check("the stack empties", (left["items"].get(row["id"], 0)) == 0, left["items"])
        check("an empty stack leaves the sell list", gone is False, gone)

        # Back to buy, then leave: left/right must not be one-way.
        qa_drive.tap(page, "ArrowLeft", hold=60, settle=300)
        back = page.evaluate("() => window.__hd2d.shopState")
        check("left switches back to the buy side", back["mode"] == "buy", back["mode"])

        qa_drive.tap(page, "Escape", hold=50, settle=300)
        check("Esc leaves the counter",
              page.evaluate("() => window.__hd2d.shopState.open") is False)

        print("\n== the second area ==")
        # The story climbs to the plateau. This walks through the door and back,
        # because a second area that is not reachable is data, not a level.
        home_bag = page.evaluate("() => window.__hd2d.bag")
        home_area = page.evaluate("() => window.__hd2d.area.id")
        climb = page.evaluate("() => window.__hd2d.markers.find(m => m.id === 'salita')")
        check("the first area has a way up", climb is not None, climb)
        page.evaluate(f"() => window.__hd2d.teleport({climb['x']}, {climb['z']})")
        page.wait_for_timeout(400)
        qa_drive.tap(page, "KeyE", hold=50, settle=300)
        qa_drive.dismiss(page)
        # The swap is a fade out, a rebuild, a fade back: bounded, never a blind sleep.
        page.wait_for_function("() => window.__hd2d.area.id !== 'riva'", timeout=15000)
        page.wait_for_timeout(600)
        up = page.evaluate(PAGE)
        check("the climb changes the area", up["area"]["id"] == "altipiano", up["area"]["id"])
        check("the second area has its own level", up["level"]["id"] == "level2", up["level"]["id"])
        check("the second area has its own markers", len(page.evaluate("() => window.__hd2d.markers")) > 0)
        check("the bag crosses the transition untouched", up["bag"] == home_bag,
              f"{home_bag} -> {up['bag']}")
        landed = page.evaluate("() => window.__hd2d.leaderPos()")
        check("the party arrives on the second area's own map",
              page.evaluate(f"() => window.__hd2d.walkable({landed[0]}, {landed[1]})") is True, landed)
        check("no page errors after a transition", not errors, (errors or [])[:2])
        page.screenshot(path=str(SHOTS / "09-altipiano.png"))
        print(f"  shot  {(SHOTS / '09-altipiano.png').relative_to(ROOT)}")

        # And back down, so the rest of this pass runs where it started.
        down = page.evaluate("() => window.__hd2d.markers.find(m => m.id === 'uscita')")
        check("the second area has a way down", down is not None, down)
        page.evaluate(f"() => window.__hd2d.teleport({down['x']}, {down['z']})")
        page.wait_for_timeout(400)
        qa_drive.tap(page, "KeyE", hold=50, settle=300)
        qa_drive.dismiss(page)
        page.wait_for_function("() => window.__hd2d.area.id === 'riva'", timeout=15000)
        page.wait_for_timeout(600)
        back_home = page.evaluate("() => window.__hd2d.area.id")
        check("and back", back_home == home_area, f"{home_area} -> {back_home}")

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

        # A save records only the LEADER's position. Restoring the leader alone
        # left the other three at their boot spots by the village, and the first
        # overworld frame sent them walking across the island — hidden past
        # MAX_DIST, so a resumed game looked like it had lost three members.
        page.wait_for_timeout(600)
        spread = page.evaluate("""() => {
          const H = window.__hd2d;
          const lead = H.party.leader.position;
          return H.party.members.map((m) => +Math.hypot(m.position.x - lead.x, m.position.z - lead.z).toFixed(2));
        }""")
        check("the whole party resumes together, not just the leader",
              max(spread) <= 3.0, spread)

        # The reload must not RESET what has already been taken. Markers are
        # rebuilt fresh on every load, and the save used to carry no marker state,
        # so the wreck could be looted again on every Continue: 40 gold and three
        # tonics, forever. With the counter in the game, that gold became spendable
        # and the duplication became worth doing.
        cache_after = page.evaluate("() => window.__hd2d.markers.find(m => m.id === 'cache')")
        page.evaluate(f"() => window.__hd2d.teleport({cache_after['x']}, {cache_after['z']})")
        page.wait_for_timeout(400)
        qa_drive.tap(page, "KeyE", hold=50, settle=300)
        qa_drive.dismiss(page)
        reloot = page.evaluate("() => window.__hd2d.bag")
        check("the wreck cannot be looted again after a reload", reloot == before_bag,
              f"{before_bag} -> {reloot}")

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
