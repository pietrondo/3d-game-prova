/**
 * src/core/level.js — level progression, as a pure state machine.
 *
 * No Three.js, no DOM, no timers. It takes events in and answers questions:
 * "which stage am I on", "has this event advanced me", "is the level done".
 * That is the whole job, and keeping it pure is what makes the ordering of the
 * tutorial testable in Node instead of by walking around an island.
 *
 * ## The shape of a level (src/data/level1.json)
 *
 * A level is not a different island, it is a SHAPE: an opening, an objective
 * with a completion rule, and an end. The area definition is DATA on purpose —
 * AGENTS.md requires new content to be a JSON edit, not a recompile. The
 * introduction has to teach in a sequence (walk, then talk, then fight), which a
 * single `onEnter` cannot express, so it is an ordered `stages` list.
 *
 * ## The three event kinds, and why conflating them breaks a tutorial
 *
 *   onMove    the leader actually TRAVELLED, not the key was pressed
 *   onTalk    a marker finished its dialogue
 *   onBattle  a fight was WON
 *
 * `advance` is the event that SPENDS a stage; `when` is the gate checked when a
 * stage is ENTERED. Two fields because "what teaches this step" and "when may
 * this step begin" are different questions. A stage that teaches walking but
 * opens only after a battle is nonsense, and a single shared field would let you
 * write exactly that.
 *
 * `onMove` is measured on real displacement, not on the key: a player walking
 * into a pine HAS moved, and gating on the key event leaves them pressing W
 * against a trunk watching an objective that never changes and nothing on screen
 * to say why.
 *
 * `hintOnly: true` plays the stage's lines WITHOUT freezing the game. Set it on
 * the movement stage: `mode = 'dialogue'` stops the leader, so briefing walking
 * by stopping the player mid-stride teaches them nothing and costs them the
 * stride they were halfway through. A briefing is a monologue over a live
 * world; a conversation with a person still freezes, because that is a
 * different thing and the player expects to stop for it.
 *
 * ## Why a machine and not a chain of `if`s in the director
 *
 * The tutorial is the most bug-prone code in a JRPG and the least noticed,
 * because its failure mode is SILENCE: a stage that never fires leaves the
 * player wandering with no objective, and nothing throws. One rule makes the
 * illegal transitions unrepresentable: **an event only advances the stage that
 * is CURRENTLY active.** Without it, winning a fight at the wrong moment skips
 * three stages, because the completing event matches every later stage's
 * `advance`. That is the bug this file exists to make impossible.
 *
 * ## Lifecycle
 *
 *   active --(event matching `advance`, gate `when` already open)--> spent
 *
 * `completes: true` ends the level. There is exactly one such stage and it is
 * last, so the level cannot complete early: reaching it requires every earlier
 * stage to have been spent.
 *
 * ## No comments in level1.json
 *
 * The area file is strict JSON (`vite:json`) and a comment block there fails the
 * build with a stack trace pointing into rolldown rather than at the file. The
 * reasoning lives here; the data stays data.
 */

/** The tutorial's events. Each maps to exactly one string in level1.json. */
export const EVENTS = {
  MOVE: 'onMove',
  TALK: 'onTalk',
  BATTLE: 'onBattle',
  ZONE: 'onZone',
};

export function createLevel(def, { intro = [] } = {}) {
  if (!def || !Array.isArray(def.stages) || !def.stages.length) {
    throw new Error('createLevel: def.stages missing or empty');
  }

  // Index 0, not -1. The opening monologue is the DIRECTOR's concern — it owns
  // the dialogue box and decides whether to play it at all (it must not replay on
  // a resume). If the machine started "before the first stage" then `at()`
  // returned null and the very first advance was silently dropped: the level
  // never moved, no error, and the player got an island with no objective.
  let index = 0;
  let lastEvent = null;
  let complete = false;

  const at = () => (index >= 0 && index < def.stages.length ? def.stages[index] : null);

  return {
    /** Opening monologue, shown once before any stage. */
    get intro() { return intro; },

    /** The stage the player is on, or null when the level is over. */
    get stage() { return at(); },

    get index() { return index; },

    get isComplete() { return complete; },

    /**
     * The line the HUD should show right now, or null. This is the entire
     * player-facing contract: the director renders it, nothing else.
     */
    get objective() {
      const s = at();
      return s ? (s.goal || null) : null;
    },

    /**
     * Feed one event. Returns the stage the player should now be shown, or
     * null if nothing changed — the caller only re-renders on a real change,
     * because every dialogue costs a `hud.setHint` DOM write.
     *
     * `progress` is optional: the caller uses it to decide whether the stage's
     * own `lines` should be spoken (see game.js — a stage whose lines were
     * already shown must not speak them twice).
     */
    advance(type, detail = null) {
      lastEvent = { type, detail };
      const s = at();
      if (!s || complete) return null;
      if (s.advance !== type) return null;      // not the event this stage wants

      index++;
      if (s.completes) complete = true;
      return at();
    },

    /**
     * May `type` be spent right now? The director asks this BEFORE opening a
     * dialogue it was not sure about, so a stage cannot be double-advanced by
     * two events arriving in the same frame.
     */
    canAdvance(type) {
      const s = at();
      return !!s && !complete && s.advance === type;
    },

    /** The stage's own gate, exposed so the director can decide when to enter it. */
    gateForCurrent() {
      const s = at();
      return s ? (s.when || 'always') : null;
    },

    /**
     * Serialisable position. The world is regenerated from a seed, so a save is
     * the stage pointer plus the party's HP/MP and the bag — see
     * src/core/save.js, which owns the format.
     */
    snapshot() {
      return { id: def.id, index, complete };
    },

    /**
     * Restore from a snapshot. An out-of-range index is CLAMPED rather than
     * thrown: a save written by a build with more stages must not brick the
     * game, and a save from a build with fewer must not either. Past the end
     * means the area was finished, so it clamps to complete.
     */
    restore(snap) {
      if (!snap || snap.id !== def.id) return false;
      const n = def.stages.length;
      const raw = Number(snap.index);
      index = Number.isFinite(raw) ? Math.max(0, Math.min(n - 1, Math.trunc(raw))) : 0;
      complete = !!snap.complete || index >= n - 1;
      return true;
    },
  };
}
