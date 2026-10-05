"""
qa_drive.py — driving the real game from a headless browser, shared by both
passes (qa.py measures pixels, qa-level.py asserts progression).

Two lessons live here, and both cost a debugging session before they were
written down:

## `tap`, never `keyboard.press()`

`core/input.js` builds its press EDGE inside `update()` as `(held - prev)`. A
`page.keyboard.press()` is a down and an up about a millisecond apart, so
whenever no rendered frame lands between them the edge NEVER EXISTS and the
keystroke is silently dropped. A harness that uses `press()` hangs forever
waiting for a battle that is progressing perfectly, and it looks exactly like a
wedged game. Every key must be down / wait / up.

## The title is up at boot

Since ui/title.js, the first thing on screen is the start menu, not the
overworld. Anything that walks, talks or swings must go through
`start_new_game()` first, or it is talking to a menu.
"""


def tap(page, key="Enter", hold=60, settle=340):
    """One keystroke the input layer can actually see. See the module docstring."""
    page.keyboard.down(key)
    page.wait_for_timeout(hold)
    page.keyboard.up(key)
    page.wait_for_timeout(settle)


def dismiss(page, limit=40):
    """Press through every open dialogue until the overworld is live again.

    A fresh game is the intro PLUS the first stage's briefing (speakStage() is
    chained off the intro's promise), and a line needs two presses: one to finish
    the typing, one to advance. Ten to twelve presses, not three — so the limit
    is generous and the exact count does not matter.
    """
    for _ in range(limit):
        if page.evaluate("() => window.__hd2d.state.mode") != "dialogue":
            return
        tap(page, "KeyE", hold=50, settle=90)


def title_open(page):
    return page.evaluate("() => !!window.__hd2d && window.__hd2d.titleState.open")


def start_new_game(page, limit=6):
    """From the title, pick Nuova partita and clear the opening monologue.

    The cursor lands on the first ENABLED row, which is always `new` (title.js
    -> stops()), so a single confirm starts a new game whether or not a save is
    present. The title resolves asynchronously and then the intro chain runs, so
    the dialogue drain is repeated: a `dismiss` that stops after the last intro
    line returns one beat before the first stage briefing opens.
    """
    for _ in range(limit):
        if not title_open(page):
            break
        tap(page)
    for _ in range(limit):
        dismiss(page)
        page.wait_for_timeout(250)
        if page.evaluate("() => window.__hd2d.state.mode") == "overworld":
            return True
    return page.evaluate("() => window.__hd2d.state.mode") == "overworld"
