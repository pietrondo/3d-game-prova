// AGENT-WORLD. Frozen signature plus two OPTIONAL fields (documented, additive):
//   mapSize         — world extent the sun's shadow camera must cover (default 64)
//   shadowMapSize   — shadow texture resolution (default 2048)
// `update(dt, camera)` is also tolerant of an extra second argument: pass
// engine.camera (or a Vector3) to pin the sky to the eye and kill the parallax
// on the sun. `update(dt)` alone still works, exactly as contracts.md says.

import * as THREE from 'three';

const SKY_R = 200;    // inside the engine's far plane (400)
const SUN_DIST = 170;
const SUN_SIZE = 60;

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Scene renders in LINEAR; engine's post pass does the single sRGB conversion.
const FRAG = /* glsl */`
uniform vec3 uTop, uHorizon, uGround, uHaze, uSea, uSunColor, uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  // The rig is pitched 40 degrees down with a 30-34 degree fov, so the frame
  // only ever spans d.y in about [-0.9, -0.3]: this dome is never seen as sky,
  // it is the air BEYOND the sea. A pow(-h, 0.5) ramp between the warm horizon
  // and the dark ground put ~58% of the ground tone into the top corners, which
  // is the flat tan wall, and it met the water on a hard geometric seam because
  // nothing at the waterline matched the water.
  //
  // So the below-horizon half gets its own two-stop ramp: pale haze where the
  // frame starts, and a tone that matches the lit sea at the waterline. The
  // above-horizon branch is untouched, for a camera that ever looks up.
  vec3 c = h > 0.0 ? mix(uHorizon, uTop, pow(h, 0.6))
                   : mix(mix(uHaze, uSea, smoothstep(0.26, 0.48, -h)),
                         uGround, smoothstep(0.52, 0.95, -h));
  float s = max(dot(d, normalize(uSunDir)), 0.0);
  c += uSunColor * pow(s, 6.0) * 0.20;      // wide warm halo
  c += uSunColor * pow(s, 48.0) * 0.55;     // hot core
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.010;
  gl_FragColor = vec4(c, 1.0);
}`;

/** 32x32 chunky pixel sun. Null outside the browser (Node smoke tests). */
function makeSunTexture() {
  if (typeof document === 'undefined') return null;
  const N = 32;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const d = img.data;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5 - N / 2) / (N / 2);
      const dy = (y + 0.5 - N / 2) / (N / 2);
      let a = Math.max(0, 1 - Math.hypot(dx, dy));
      a = a * a * (3 - 2 * a);
      a = Math.min(1, a * 1.6);
      a = Math.round(a * 4) / 4;              // 5 alpha levels => pixel-art sun
      const i = (y * N + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createSky({
  sunDir = new THREE.Vector3(0.6, 0.7, 0.4),
  sunColor = 0xffe0a8,
  topColor = 0x2b3a6b,
  horizonColor = 0xf0a868,
  groundColor = 0x1a1830,
  // Below the horizon only. hazeColor is what the top of the frame shows;
  // seaColor has to sit close to the lit water (terrain.js: #3f79b4 under this
  // game's sun) or the water mesh ends on a visible straight edge.
  hazeColor = 0x8fa3b8,
  seaColor = 0x35505f,
  mapSize = 64,
  shadowMapSize = 2048,
} = {}) {
  const group = new THREE.Group();
  group.name = 'sky';

  const dir = (sunDir.isVector3 ? sunDir.clone() : new THREE.Vector3().fromArray(sunDir)).normalize();
  const cSun = new THREE.Color(sunColor);
  const cTop = new THREE.Color(topColor);
  const cHor = new THREE.Color(horizonColor);
  const cGnd = new THREE.Color(groundColor);
  const cHaze = new THREE.Color(hazeColor);
  const cSea = new THREE.Color(seaColor);

  // --- gradient dome ---------------------------------------------------------
  const skyGeo = new THREE.SphereGeometry(SKY_R, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: cTop },
      uHorizon: { value: cHor },
      uGround: { value: cGnd },
      uHaze: { value: cHaze },
      uSea: { value: cSea },
      uSunColor: { value: cSun.clone() },
      uSunDir: { value: dir.clone() },
    },
  });
  const dome = new THREE.Mesh(skyGeo, skyMat);
  dome.name = 'skyDome';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  group.add(dome);

  // --- sun billboard (this is what feeds the bloom pass) ---------------------
  const sunTex = makeSunTexture();
  const sunMat = new THREE.SpriteMaterial({
    map: sunTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    transparent: true,
    fog: false,
  });
  sunMat.color.copy(cSun).multiplyScalar(2.4);   // > 1.0 linear => over threshold
  const sunSprite = new THREE.Sprite(sunMat);
  sunSprite.name = 'sun';
  sunSprite.position.copy(dir).multiplyScalar(SUN_DIST);
  sunSprite.scale.setScalar(SUN_SIZE);
  sunSprite.renderOrder = 2;
  group.add(sunSprite);

  // --- lights ----------------------------------------------------------------
  const sun = new THREE.DirectionalLight(cSun.getHex(), 2.1);
  sun.name = 'sunLight';
  sun.position.copy(dir).multiplyScalar(70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  const half = mapSize / 2;
  const sc = sun.shadow.camera;
  sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
  sc.near = 1; sc.far = 260;
  sc.updateProjectionMatrix();
  sun.target.position.set(0, 0, 0);
  group.add(sun);
  group.add(sun.target);

  const hemi = new THREE.HemisphereLight(cHor.getHex(), cGnd.getHex(), 0.8);
  hemi.name = 'hemiLight';
  group.add(hemi);

  // --- public ----------------------------------------------------------------
  const lights = { sun, hemi };

  function update(_dt, camera) {
    const p = camera && camera.isVector3 ? camera : camera && camera.position;
    if (p) group.position.copy(p);
  }

  function dispose() {
    skyGeo.dispose();
    skyMat.dispose();
    sunMat.dispose();
    if (sunTex) sunTex.dispose();
    if (sun.shadow.map) sun.shadow.map.dispose();
    group.clear();
  }

  return { group, lights, update, dispose };
}
