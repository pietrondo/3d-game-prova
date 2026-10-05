/**
 * src/game/qa.js — the `window.__hd2d` handle.
 *
 * The render is not unit-tested (`design.md`: QA reviews it by screenshot), so a
 * screenshot pass needs a way to ask what the scene contains without guessing
 * from pixels. This is that view, and it is deliberately the ONLY thing in the
 * project that exists purely for the tests — which is why it is its own file and
 * not scattered through the director.
 *
 * ## Everything here is a THUNK, and that is not style
 *
 * `enterArea` rebinds the area, the terrain, the village, the party, the markers,
 * the level, the stage and the save. A module that captured any of them as a
 * VALUE would keep working until the first transition and then answer with the
 * world the player has already left — the kind of bug that looks like the
 * harness being flaky. So `ctx` is a table of functions, and every read goes
 * through it at call time.
 *
 * ## What is NOT here
 *
 * `state` and the behaviours (`teleport`, `encounter`). `state` reads ten
 * closures; `teleport` needs `clearSpot` and the camera rig, and `encounter`
 * needs `startEncounter`. Moving their bodies would pull the director in here and
 * buy nothing — they arrive as `ctx` entries instead.
 *
 * Exports: installQaHandle
 */
export function installQaHandle(ctx) {
  const handle = {
    get engine() { return ctx.engine(); },
    get scene() { return ctx.engine().scene; },

    // Assembled in game.js: it is a read of ten live bindings, not a module.
    get state() { return ctx.state(); },

    setPost: (p) => ctx.engine().setPostParams(p),
    scale: (n) => ctx.engine().setRenderScale(n),

    // BOTH collider sets, because this is what the party actually collides with —
    // the blocked-ground measurement is meaningless if it only sees the props and
    // then walks into a house.
    get colliders() { return ctx.colliders(); },

    // The input module, not a wrapper: the harness installs its own spies on it.
    get input() { return ctx.input(); },
    // QA needs to build world-space vectors to project sprite bounding boxes into
    // screen space. Exposing the module, not a wrapper.
    THREE: ctx.THREE,

    // Read-only world probes. These are questions a screenshot cannot answer.
    leaderPos: () => ctx.leaderPos(),
    walkable: (x, z) => ctx.terrain().isWalkable(x, z),
    // Height and tile probes: the village is placed by SEARCHING the terrain for a
    // flat walkable patch, and these two are what make that search possible from
    // outside the world layer.
    heightAt: (x, z) => ctx.terrain().heightAt(x, z),
    tileAt: (x, z) => ctx.terrain().tileAt(x, z),
    get terrainBounds() { return ctx.terrain().bounds; },
    get party() { return ctx.party(); },

    encounter: (zone, ids) => ctx.encounter(zone, ids),

    // Progression and inventory, for the same reason: "did the tutorial advance"
    // and "did the tonics actually land in the bag" are invisible on screen, and
    // both were previously broken in ways that threw nothing.
    get level() { return ctx.levelState(); },
    get area() { return ctx.areaState(); },
    get bag() { return ctx.bag(); },
    save: () => ctx.save(),
    loadSave: () => ctx.loadSave(),
    hasSave: () => ctx.hasSave(),
    get titleState() { return ctx.titleState(); },
    get village() { return ctx.villageState(); },
    get markers() { return ctx.markersState(); },
    inVillage: (x, z) => ctx.inVillage(x, z),
    get shopState() { return ctx.shopState(); },

    teleport: (x, z) => ctx.teleport(x, z),
    dispose: () => ctx.dispose(),
  };

  window.__hd2d = handle;
  return handle;
}
