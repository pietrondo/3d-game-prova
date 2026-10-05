/**
 * src/game/areas.js — the registry of playable areas.
 *
 * ## Why a registry in JS and not a JSON file of file names
 *
 * The data files are JSON and stay JSON, but Vite resolves imports at BUILD time:
 * a string in a config file cannot name the JSON to load, because there is no
 * runtime file system in the browser. So the mapping from an area id to its data
 * is an explicit import table. The CONTENT is still data — everything below is a
 * reference to `src/data/*.json`, plus the numbers that describe how that content
 * is laid out on the terrain — and adding an area is adding one entry here and
 * its data files.
 *
 * ## What an area is
 *
 * Everything that a fresh world needs and nothing about how the game runs: the
 * map parameters the terrain is generated from, the content tables, its own level
 * definition, and where the party starts. The director reads this and builds a
 * world; it does not know which area is which.
 */
import TILES from '../data/tiles.json';
import PROPS from '../data/props.json';
import VILLAGE from '../data/village.json';
import MARKERS from '../data/markers.json';
import LEVEL1 from '../data/level1.json';
import LEVEL2 from '../data/level2.json';
import VILLAGE2 from '../data/village2.json';
import MARKERS2 from '../data/markers2.json';

/** How a prop scatter is tuned. Shared, because it is one world's look. */
const PROP_DENSITY = 0.16;
const PROP_MAX = 1600;

export const AREAS = {
  /**
   * The island. 64x64, one terrace with the village on it, and a mesa in the
   * middle that the story climbs.
   */
  riva: {
    id: 'riva',
    name: 'La Riva',
    map: { width: 64, depth: 64, seed: 1337, heightScale: 3.2 },
    tiles: TILES,
    props: PROPS,
    density: PROP_DENSITY,
    maxCount: PROP_MAX,
    propSeed: 11,
    village: VILLAGE,
    // Measured, not chosen: see game.js's history — r=7.5/feather=2.0 gives a
    // 5.5 flat core, which is what the layout needs, and 0 of 11 pieces end up
    // on the feather slope.
    villageSite: { angle: Math.PI / 2, at: 0.62, r: 7.5, feather: 2.0 },
    spawn: { x: 32, z: 42 },
    markers: MARKERS,
    level: LEVEL1,
    sunDir: [0.6, 0.7, 0.4],
    keepOut: 3,
    // Where the party goes when they leave by the area's exit.
    exits: { watch: 'altipiano' },
  },

  /**
   * The plateau top. A SMALLER map on purpose: it is the place the story climbs
   * to, so it should feel like a summit and not like a second island. Different
   * seed, so the shape is its own, and no village — the terrace is not needed
   * because the whole area is meant to be walked.
   */
  altipiano: {
    id: 'altipiano',
    name: "L'Altipiano",
    map: { width: 40, depth: 40, seed: 90210, heightScale: 2.6 },
    tiles: TILES,
    props: PROPS,
    density: 0.1,
    maxCount: 400,
    propSeed: 23,
    village: VILLAGE2,
    villageSite: { angle: -Math.PI / 2, at: 0.34, r: 6.5, feather: 2.0 },
    spawn: { x: 20, z: 26 },
    markers: MARKERS2,
    level: LEVEL2,
    sunDir: [0.6, 0.7, 0.4],
    keepOut: 3,
    // The way back down.
    exits: { vell: 'riva' },
  },
};

/** Where a brand-new game begins. */
export const START_AREA = 'riva';
