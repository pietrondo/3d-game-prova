/**
 * src/core/engine.js — renderer, camera and the HD-2D post pipeline.
 * See docs/contracts.md §1.
 *
 * Pipeline: scene -> sceneRT (low res, Nearest, + DepthTexture) -> bright pass ->
 * 2-octave separable bloom -> ONE final fullscreen ShaderMaterial (DoF, bloom,
 * grade, posterize+dither, saturation, vignette) -> canvas.
 *
 * The pixelation is produced by sampling sceneRT with NearestFilter inside the
 * final pass, which runs at canvas resolution. Each low-res texel therefore
 * becomes a renderScale-sized block of identical colour. Do not "fix" this by
 * rendering the final pass into a low-res target — the DoF, grade and dither all
 * have to run per canvas pixel.
 *
 * Colour is converted to sRGB exactly once, at the bottom of the final shader.
 */

import * as THREE from 'three';
import { createFullscreenQuad, createBloomChain, VERTEX_SHADER, FINAL_FRAGMENT_SHADER } from './pixelPass.js';

export const RENDER_SCALES = { hd2d: 1, pixel2: 2, pixel3: 3, chunky: 4 };
export const DEFAULT_RENDER_SCALE = 2;

const MIN_SCALE = 1;
const MAX_SCALE = 4;

/** Camera rig: fov 30 pitched 40 degrees down, this far from the follow anchor. */
const CAMERA_DISTANCE = 24;
const CAMERA_PITCH = (40 * Math.PI) / 180;
const CAMERA_OFFSET = new THREE.Vector3(
  0,
  Math.sin(CAMERA_PITCH) * CAMERA_DISTANCE,
  Math.cos(CAMERA_PITCH) * CAMERA_DISTANCE,
);

const POST_DEFAULTS = {
  bloomStrength: 0.65,
  bloomThreshold: 0.72,
  dofStrength: 0.55,
  dofFocus: 14,
  dofRange: 22,
  paletteLevels: 16,
  dither: 0.35,
  saturation: 1.12,
  vignette: 0.35,
  warmHighlights: true,
};

/** Max DoF blur radius, in LOW-res texels. Scaled by renderScale in the shader. */
const DOF_RADIUS = 5;

const CLAMPS = {
  bloomStrength: [0, 1.5],
  bloomThreshold: [0, 1],
  dofStrength: [0, 1],
  dofFocus: [0.1, 200],
  dofRange: [0.1, 200],
  paletteLevels: [2, 64],
  dither: [0, 1],
  saturation: [0, 2],
  vignette: [0, 1],
};

const clamp = (v, [lo, hi]) => (v < lo ? lo : v > hi ? hi : v);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function createEngine(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // the low-res RT is the pixel filter; MSAA here would be wasted
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // grade by hand in the final pass
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);
  // THREE.Timer, not THREE.Clock: Clock is deprecated in r186 and warns on the
  // console. Same contract — one update() per frame, then getDelta() in seconds
  // — except that forgetting update() returns the LAST delta forever instead of
  // a fresh one, so the two must always be called together.
  const timer = new THREE.Timer();

  let renderScale = DEFAULT_RENDER_SCALE;
  let width = 1;
  let height = 1;
  let bufferW = 1;
  let bufferH = 1;

  const depthTexture = new THREE.DepthTexture(1, 1);
  const sceneRT = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    depthTexture,
    generateMipmaps: false,
  });
  sceneRT.texture.colorSpace = THREE.NoColorSpace; // linear radiance, not sRGB

  const quad = createFullscreenQuad();
  const bloom = createBloomChain(renderer, 1, 1);

  const postParams = { ...POST_DEFAULTS };

  const finalMat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FINAL_FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tScene: { value: sceneRT.texture },
      tBloom: { value: null },
      tDepth: { value: depthTexture },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uRenderScale: { value: renderScale },
      uCameraNear: { value: camera.near },
      uCameraFar: { value: camera.far },
      uFocusDistance: { value: CAMERA_DISTANCE },
      uBloomStrength: { value: POST_DEFAULTS.bloomStrength },
      uDofStrength: { value: POST_DEFAULTS.dofStrength },
      uDofFocus: { value: POST_DEFAULTS.dofFocus },
      uDofRange: { value: POST_DEFAULTS.dofRange },
      uDofRadius: { value: DOF_RADIUS },
      uPaletteLevels: { value: POST_DEFAULTS.paletteLevels },
      uDither: { value: POST_DEFAULTS.dither },
      uSaturation: { value: POST_DEFAULTS.saturation },
      uVignette: { value: POST_DEFAULTS.vignette },
      uWarmHighlights: { value: POST_DEFAULTS.warmHighlights },
    },
  });

  const anchor = new THREE.Vector3();
  const anchorTarget = new THREE.Vector3();
  const shakeOffset = new THREE.Vector3();
  let shakeAmount = 0;
  let shakeLeft = 0;
  let shakeDuration = 0;
  let shakeT = 0;
  let lastTime = now();

  function resize() {
    width = Math.max(1, Math.floor(canvas.clientWidth || window.innerWidth || 1));
    height = Math.max(1, Math.floor(canvas.clientHeight || window.innerHeight || 1));

    // updateStyle false: the canvas is already 100%/100% in style.css, so let CSS
    // own layout and only tell WebGL how big the drawing buffer should be.
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    bufferW = Math.max(1, Math.floor(width / renderScale));
    bufferH = Math.max(1, Math.floor(height / renderScale));
    sceneRT.setSize(bufferW, bufferH); // three re-syncs depthTexture.image with the RT
    bloom.setSize(bufferW, bufferH);

    finalMat.uniforms.uTexel.value.set(1 / bufferW, 1 / bufferH);
    finalMat.uniforms.uRenderScale.value = renderScale;
  }

  function setRenderScale(n) {
    const next = clamp(Math.round(Number(n) || DEFAULT_RENDER_SCALE), [MIN_SCALE, MAX_SCALE]);
    if (next === renderScale) return;
    renderScale = next;
    resize();
  }

  function setPostParams(p) {
    for (const key in p) {
      if (!(key in postParams)) continue;
      const v = p[key];
      if (key === 'warmHighlights') {
        postParams.warmHighlights = !!v;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        postParams[key] = CLAMPS[key] ? clamp(v, CLAMPS[key]) : v;
      }
    }
  }

  function setCameraTarget(x, y, z) {
    anchorTarget.set(x, y, z);
  }

  function shake(amount, duration = 0.3) {
    shakeAmount = Math.min(2, shakeAmount + amount); // additive, capped
    shakeDuration = Math.max(0.01, duration);
    shakeLeft = shakeDuration;
  }

  function updateCamera(dt) {
    // Frame-rate independent follow. render() owns its own clock so it never
    // steals a delta from the shared frame timer that game.js is driving.
    const k = 1 - Math.exp(-8 * dt);
    anchor.lerp(anchorTarget, k);

    let amp = 0;
    if (shakeLeft > 0) {
      shakeLeft = Math.max(0, shakeLeft - dt);
      shakeT += dt;
      amp = shakeAmount * Math.exp(-4 * (shakeDuration - shakeLeft) / shakeDuration);
      if (shakeLeft === 0) shakeAmount = 0;
    }
    // Phase advances with elapsed time, not the wall clock, so the wobble stays a
    // ~30 rad/s sine instead of aliasing into per-frame white noise.
    const t = shakeT * 30;
    shakeOffset.set(
      Math.sin(t * 1.0) * amp,
      Math.sin(t * 1.37 + 1.1) * amp * 0.7,
      Math.cos(t * 1.19 + 2.2) * amp,
    );

    camera.position.copy(anchor).add(CAMERA_OFFSET).add(shakeOffset);
    camera.lookAt(anchor);
    camera.updateMatrixWorld();
  }

  function render() {
    const t = now();
    const dt = Math.min(0.1, (t - lastTime) / 1000);
    lastTime = t;
    updateCamera(dt);

    // 1. scene -> low-res linear target (autoClear wipes it each frame)
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    // 2. bright pass + 2-octave separable blur, all linear
    finalMat.uniforms.tBloom.value = bloom.render(sceneRT.texture, {
      bloomThreshold: postParams.bloomThreshold,
    });

    // 3. one final pass -> canvas
    const u = finalMat.uniforms;
    u.uCameraNear.value = camera.near;
    u.uCameraFar.value = camera.far;
    u.uFocusDistance.value = anchor.distanceTo(camera.position);
    u.uBloomStrength.value = postParams.bloomStrength;
    u.uDofStrength.value = postParams.dofStrength;
    u.uDofFocus.value = postParams.dofFocus;
    u.uDofRange.value = postParams.dofRange;
    u.uPaletteLevels.value = postParams.paletteLevels;
    u.uDither.value = postParams.dither;
    u.uSaturation.value = postParams.saturation;
    u.uVignette.value = postParams.vignette;
    u.uWarmHighlights.value = postParams.warmHighlights;

    quad.mesh.material = finalMat;
    quad.render(renderer, null);
  }

  function dispose() {
    timer.dispose();
    sceneRT.dispose();
    depthTexture.dispose();
    bloom.dispose();
    finalMat.dispose();
    quad.mesh.geometry.dispose();
    quad.mesh.material.dispose();
    renderer.dispose();
  }

  resize();

  return {
    renderer,
    scene,
    camera,
    timer,
    canvas,

    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get bufferW() {
      return bufferW;
    },
    get bufferH() {
      return bufferH;
    },

    get renderScale() {
      return renderScale;
    },
    setRenderScale,

    postParams,
    setPostParams,

    setCameraTarget,
    shake,

    /** World-space point the camera orbits and focuses on. Extra, read-only. */
    get cameraTarget() {
      return anchor;
    },
    /** Orthonormal basis of the rig, for anything that needs the camera heading. */
    get cameraOffset() {
      return CAMERA_OFFSET;
    },

    render,
    resize,
    dispose,
  };
}
