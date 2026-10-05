/**
 * src/core/pixelPass.js — the fullscreen-quad machinery and the GLSL for the
 * single final post pass. Imported only by `engine.js`. See docs/contracts.md §2.
 *
 * Colour: every pass here works in LINEAR light. sceneRT holds linear radiance
 * (three forces LinearSRGB when drawing to a render target), the bloom chain is
 * linear, and `FINAL_FRAGMENT_SHADER` performs the sRGB conversion exactly once,
 * on its way out. Do not add a second conversion anywhere.
 */

import * as THREE from 'three';

export const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Fullscreen triangle-pair. Assign `mesh.material` before calling `render()`. */
export function createFullscreenQuad() {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  mesh.frustumCulled = false;
  scene.add(mesh);
  return {
    scene,
    camera,
    mesh,
    render(renderer, target = null) {
      renderer.setRenderTarget(target || null);
      renderer.render(scene, camera);
    },
  };
}

// --- private bloom-chain shaders (linear) -----------------------------------

const BRIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D tSource;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tSource, vUv ).rgb;
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  gl_FragColor = vec4( c * ( max( 0.0, l - uThreshold ) / max( 1e-4, l ) ), 1.0 );
}
`;

/** 9-tap gaussian folded into 5 linear samples. Offsets are in SOURCE texels. */
const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;
uniform vec2 uDirection;
varying vec2 vUv;
void main() {
  vec2 o = uDirection * uTexel;
  vec3 c = texture2D( tSource, vUv ).rgb * 0.227027;
  c += ( texture2D( tSource, vUv + o * 1.3846 ).rgb + texture2D( tSource, vUv - o * 1.3846 ).rgb ) * 0.316216;
  c += ( texture2D( tSource, vUv + o * 3.2308 ).rgb + texture2D( tSource, vUv - o * 3.2308 ).rgb ) * 0.070270;
  gl_FragColor = vec4( c, 1.0 );
}
`;

const COMBINE_FRAGMENT = /* glsl */ `
uniform sampler2D tOct1;
uniform sampler2D tOct2;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4( texture2D( tOct1, vUv ).rgb + texture2D( tOct2, vUv ).rgb * 0.7, 1.0 );
}
`;

// --- the final pass --------------------------------------------------------

/**
 * Runs at CANVAS resolution. The pixels come from sampling `tScene` with
 * NearestFilter: each low-res texel becomes a renderScale-sized block.
 *
 * Order: DoF blur -> bloom add -> warm/cool grade -> sRGB (once, the boundary)
 *        -> saturation -> posterize + Bayer dither -> vignette.
 * The sRGB line is the linear/display boundary. Nothing above it is a display
 * decision; nothing below it is light transport.
 */
export const FINAL_FRAGMENT_SHADER = /* glsl */ `
#include <packing>

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform vec2 uTexel;          // 1 / bufferW, 1 / bufferH  (LOW-res texel)
uniform float uRenderScale;   // canvas pixels per low-res texel
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uFocusDistance; // world units from camera to the follow anchor
uniform float uBloomStrength;
uniform float uDofStrength;
uniform float uDofFocus;      // world units that stay sharp
uniform float uDofRange;      // world units past focus that reach full blur
uniform float uDofRadius;     // max blur radius, in LOW-res texels
uniform float uPaletteLevels;
uniform float uDither;
uniform float uSaturation;
uniform float uVignette;
uniform bool uWarmHighlights;

varying vec2 vUv;

// 4x4 ordered Bayer, built from the 2x2 matrix. Values land in [0, 0.9375].
float bayer2( vec2 a ) {
  a = floor( a );
  return fract( a.x * 0.5 + a.y * a.y * 0.75 );
}
float bayer4( vec2 a ) {
  return bayer2( a * 0.5 ) * 0.25 + bayer2( a );
}

vec3 linearToSRGB( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  vec3 lo = c * 12.92;
  vec3 hi = pow( c, vec3( 0.41666 ) ) * 1.055 - 0.055;
  return mix( hi, lo, step( c, vec3( 0.0031308 ) ) );
}

void main() {
  // Low-res texel step, expressed in OUTPUT (canvas) pixels.
  vec2 px = uTexel * uRenderScale;

  // --- depth-driven circle of confusion ------------------------------------
  float depth = texture2D( tDepth, vUv ).x;
  float viewDistance = -perspectiveDepthToViewZ( depth, uCameraNear, uCameraFar );
  float coc = clamp( ( abs( viewDistance - uFocusDistance ) - uDofFocus ) / uDofRange, 0.0, 1.0 );
  coc *= uDofStrength;

  vec3 color = texture2D( tScene, vUv ).rgb;
  if ( coc > 0.001 ) {
    float radius = coc * uDofRadius;
    vec3 sum = color;
    for ( int i = 0; i < 8; i ++ ) {
      float fi = float( i );
      float a = fi * 2.39996323;                                  // golden angle
      float r = radius * sqrt( ( fi + 0.5 ) / 8.0 );
      sum += texture2D( tScene, vUv + vec2( cos( a ), sin( a ) ) * r * px ).rgb;
    }
    color = sum / 9.0;
  }

  // --- bloom ---------------------------------------------------------------
  color += texture2D( tBloom, vUv ).rgb * uBloomStrength;

  // --- to display space, once ------------------------------------------------
  // This line is the linear/display boundary. Everything above it is light
  // transport and belongs in linear; everything below it is a display decision
  // and belongs in sRGB.
  //
  // The warm/cool grade used to sit above this line and that was the single
  // worst bug in the pipeline: a +0.11 linear lift in the shadows becomes +0.37
  // after the transfer function, so every shadow in the game turned deep blue
  // and the whole island read as night. A colour grade is a look choice, not a
  // light measurement, so it belongs below — where the numbers behave.
  color = linearToSRGB( color );

  // --- warm highlights / cool shadows --------------------------------------
  if ( uWarmHighlights ) {
    float l = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
    color += vec3( 0.055, 0.020, -0.030 ) * smoothstep( 0.35, 1.1, l );
    color += vec3( -0.020, -0.002, 0.050 ) * ( 1.0 - smoothstep( 0.0, 0.4, l ) );
  }

  // --- saturation ----------------------------------------------------------
  float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  color = mix( vec3( luma ), color, uSaturation );

  // --- posterize with ordered dither ---------------------------------------
  float levels = max( 2.0, uPaletteLevels );
  float d = ( bayer4( gl_FragCoord.xy ) - 0.46875 ) * uDither / levels;
  color = floor( ( color + d ) * levels + 0.5 ) / levels;

  // --- vignette ------------------------------------------------------------
  float d2 = length( ( vUv - 0.5 ) * vec2( 1.0, 1.0 ) ) * 1.414;
  color *= 1.0 - uVignette * smoothstep( 0.35, 0.78, d2 );

  gl_FragColor = vec4( clamp( color, 0.0, 1.0 ), 1.0 );
}
`;

// --- bloom chain -----------------------------------------------------------

const RT_OPTS = {
  type: THREE.HalfFloatType, // HDR so the bright pass has something to isolate
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
};

const mkMaterial = (fragmentShader, uniforms) =>
  new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });

/**
 * bright pass (1/2 res) -> separable blur -> second octave (1/4 res) -> combine.
 *
 * `out` follows the contract signature but a bare THREE.Texture cannot be a
 * render destination, so it is honoured when a WebGLRenderTarget is passed and
 * otherwise the chain's own half-res target is used. Either way the combined
 * texture is returned.
 */
export function createBloomChain(renderer, w, h) {
  const quad = createFullscreenQuad();

  const rtHalf = new THREE.WebGLRenderTarget(1, 1, RT_OPTS);
  const rtHalfTmp = new THREE.WebGLRenderTarget(1, 1, RT_OPTS);
  const rtQuarter = new THREE.WebGLRenderTarget(1, 1, RT_OPTS);
  const rtQuarterTmp = new THREE.WebGLRenderTarget(1, 1, RT_OPTS);
  const rtOut = new THREE.WebGLRenderTarget(1, 1, RT_OPTS);

  const brightMat = mkMaterial(BRIGHT_FRAGMENT, {
    tSource: { value: null },
    uThreshold: { value: 0.72 },
  });
  const blurMat = mkMaterial(BLUR_FRAGMENT, {
    tSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDirection: { value: new THREE.Vector2() },
  });
  const combineMat = mkMaterial(COMBINE_FRAGMENT, {
    tOct1: { value: null },
    tOct2: { value: null },
  });

  let halfW = 1;
  let halfH = 1;
  let qW = 1;
  let qH = 1;

  function setSize(nw, nh) {
    halfW = Math.max(1, Math.floor(nw / 2));
    halfH = Math.max(1, Math.floor(nh / 2));
    qW = Math.max(1, Math.floor(nw / 4));
    qH = Math.max(1, Math.floor(nh / 4));
    rtHalf.setSize(halfW, halfH);
    rtHalfTmp.setSize(halfW, halfH);
    rtQuarter.setSize(qW, qH);
    rtQuarterTmp.setSize(qW, qH);
    rtOut.setSize(halfW, halfH);
  }
  setSize(w, h);

  function blur(source, target, dx, dy, srcW, srcH) {
    blurMat.uniforms.tSource.value = source;
    blurMat.uniforms.uTexel.value.set(1 / srcW, 1 / srcH);
    blurMat.uniforms.uDirection.value.set(dx, dy);
    quad.mesh.material = blurMat;
    quad.render(renderer, target);
  }

  function render(sourceTexture, params = {}, out = null) {
    const target = out && out.isRenderTarget ? out : rtOut;

    brightMat.uniforms.tSource.value = sourceTexture;
    brightMat.uniforms.uThreshold.value = params.bloomThreshold ?? 0.72;
    quad.mesh.material = brightMat;
    quad.render(renderer, rtHalf);

    // Octave 1 — half res.
    blur(rtHalf.texture, rtHalfTmp, 1, 0, halfW, halfH);
    blur(rtHalfTmp.texture, rtHalf, 0, 1, halfW, halfH);

    // Octave 2 — quarter res. Horizontal pass reads the half-res buffer, so its
    // offsets are half-res texels and land ~2x wider once written to 1/4 res.
    blur(rtHalf.texture, rtQuarterTmp, 1, 0, halfW, halfH);
    blur(rtQuarterTmp.texture, rtQuarter, 0, 1, qW, qH);

    combineMat.uniforms.tOct1.value = rtHalf.texture;
    combineMat.uniforms.tOct2.value = rtQuarter.texture;
    quad.mesh.material = combineMat;
    quad.render(renderer, target);

    return target.texture;
  }

  function dispose() {
    rtHalf.dispose();
    rtHalfTmp.dispose();
    rtQuarter.dispose();
    rtQuarterTmp.dispose();
    rtOut.dispose();
    brightMat.dispose();
    blurMat.dispose();
    combineMat.dispose();
    quad.mesh.geometry.dispose();
    quad.mesh.material.dispose();
  }

  return { setSize, render, dispose };
}
