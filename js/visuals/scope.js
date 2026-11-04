/**
 * Waveform-driven line work — "see the sound you are playing".
 *
 *  Trails  — phosphor beams behind every fingertip. Each trail is the recent
 *            path of the tip, displaced perpendicular to its direction by the
 *            live audio waveform (like an oscilloscope beam riding the path).
 *  Strings — hairlines between the matching fingertips of both hands that
 *            vibrate with the actual waveform: amplitude = loudness,
 *            number of wiggles = pitch. Ends stay pinned to the fingertips.
 *
 * Both draw through `LineBatch`: one LineSegments draw call with per-vertex
 * alpha + accent.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aAlpha;
attribute float aAccent;
varying float vAlpha;
varying float vAccent;
void main() {
  vAlpha = aAlpha;
  vAccent = aAccent;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uAccent;
varying float vAlpha;
varying float vAccent;
void main() { gl_FragColor = vec4(mix(uColor, uAccent, vAccent), vAlpha); }`;

export class LineBatch {
  constructor(scene, maxSegments, color, accent) {
    this.max = maxSegments;
    this.pos = new Float32Array(maxSegments * 6);
    this.alpha = new Float32Array(maxSegments * 2);
    this.accent = new Float32Array(maxSegments * 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAccent', new THREE.BufferAttribute(this.accent, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uAccent: { value: accent } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.LineSegments(g, m);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.n = 0;
  }
  begin() {
    this.n = 0;
  }
  seg(x0, y0, a0, x1, y1, a1, acc = 0) {
    if (this.n >= this.max) return;
    const i = this.n++;
    const p = this.pos;
    p[i * 6] = x0;
    p[i * 6 + 1] = y0;
    p[i * 6 + 2] = 0;
    p[i * 6 + 3] = x1;
    p[i * 6 + 4] = y1;
    p[i * 6 + 5] = 0;
    this.alpha[i * 2] = a0;
    this.alpha[i * 2 + 1] = a1;
    this.accent[i * 2] = acc;
    this.accent[i * 2 + 1] = acc;
  }
  end() {
    const g = this.geo;
    g.setDrawRange(0, this.n * 2);
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aAccent.needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }
}

/** Index of a rising zero crossing near the start of the buffer — stable oscilloscope trigger. */
export function trigger(wave, maxSearch = 1024) {
  if (!wave) return 0;
  for (let i = 1; i < Math.min(maxSearch, wave.length - 1); i++) {
    if (wave[i - 1] < 0 && wave[i] >= 0) return i;
  }
  return 0;
}

// ------------------------------------------------------------------ trails

const HIST = 34; // samples of tip history (~0.7 s at 60 fps)
const RES = 120; // vertices per drawn trail

class TipHistory {
  constructor() {
    this.x = new Float32Array(HIST);
    this.y = new Float32Array(HIST);
    this.n = 0;
  }
  push(x, y) {
    if (this.n < HIST) {
      this.x[this.n] = x;
      this.y[this.n] = y;
      this.n++;
    } else {
      this.x.copyWithin(0, 1);
      this.y.copyWithin(0, 1);
      this.x[HIST - 1] = x;
      this.y[HIST - 1] = y;
    }
  }
  /** Retract from the tail (the beam fades when the hand is gone). */
  shrink() {
    if (this.n > 0) {
      this.x.copyWithin(0, 1);
      this.y.copyWithin(0, 1);
      this.n--;
    }
  }
}

export class Trails {
  constructor(scene, color, accent) {
    this.batch = new LineBatch(scene, 10 * RES + 64, color, accent);
    this.hist = new Map(); // key → TipHistory
    this.tmpX = new Float32Array(RES);
    this.tmpY = new Float32Array(RES);
  }

  /**
   * @param {Array<{key:string, x:number, y:number, alive:boolean, weight:number}>} tips
   * @param {Float32Array} wave audio time-domain data
   */
  update(tips, wave, level, intensity = 1) {
    const b = this.batch;
    b.begin();
    const trig = trigger(wave);
    for (const tip of tips) {
      let h = this.hist.get(tip.key);
      if (!h) this.hist.set(tip.key, (h = new TipHistory()));
      if (tip.alive) h.push(tip.x, tip.y);
      else {
        h.shrink();
        h.shrink();
      }
      if (h.n < 3) continue;

      // resample the history uniformly in time
      let len = 0;
      for (let i = 1; i < h.n; i++) len += Math.hypot(h.x[i] - h.x[i - 1], h.y[i] - h.y[i - 1]);
      if (len < 2) continue;
      const X = this.tmpX;
      const Y = this.tmpY;
      for (let j = 0; j < RES; j++) {
        const u = (j / (RES - 1)) * (h.n - 1);
        const i0 = Math.floor(u);
        const i1 = Math.min(h.n - 1, i0 + 1);
        const f = u - i0;
        X[j] = h.x[i0] + (h.x[i1] - h.x[i0]) * f;
        Y[j] = h.y[i0] + (h.y[i1] - h.y[i0]) * f;
      }

      // displace along the normal by the waveform; head (j = RES-1) stays on the tip
      const amp = tip.weight * tip.weight * (5 + 34 * Math.min(level * 2.2, 1)) * Math.min(1, len / 120) * intensity;
      const step = 7; // audio samples per vertex → ~17 ms of signal along the beam
      let px = 0;
      let py = 0;
      let pa = 0;
      for (let j = 0; j < RES; j++) {
        const j0 = Math.max(0, j - 1);
        const j1 = Math.min(RES - 1, j + 1);
        let tx = X[j1] - X[j0];
        let ty = Y[j1] - Y[j0];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const un = j / (RES - 1); // 0 tail → 1 head
        const env = Math.min(1, (1 - un) * 8) * Math.min(1, un * 2.5);
        const w = wave ? wave[(trig + (RES - 1 - j) * step) % wave.length] : 0;
        const x = X[j] - ty * w * amp * env;
        const y = Y[j] + tx * w * amp * env;
        const a = Math.pow(un, 1.7) * 0.7 * tip.weight * intensity;
        if (j > 0) b.seg(px, py, pa, x, y, a, tip.weight > 0.8 ? 0.6 : 0.15);
        px = x;
        py = y;
        pa = a;
      }
    }
    b.end();
  }
}

// ------------------------------------------------------------------ strings

const STRING_RES = 150;

export class Strings {
  constructor(scene, color, accent) {
    this.batch = new LineBatch(scene, 5 * STRING_RES, color, accent);
    this.presence = 0;
  }

  /**
   * @param {Array<[number,number,number,number]>|null} pairs [x0,y0,x1,y1] per fingertip pair
   */
  update(pairs, wave, level, dt, time, intensity = 1) {
    const b = this.batch;
    b.begin();
    this.presence += ((pairs ? 1 : 0) - this.presence) * (1 - Math.exp(-dt * 5));
    if (this.presence < 0.01 || !this.last) {
      if (pairs) this.last = pairs;
      if (this.presence < 0.01) return b.end();
    }
    if (pairs) this.last = pairs;
    const P = this.last;
    const trig = trigger(wave);
    const loud = Math.min(1, level * 2.5);
    for (let s = 0; s < P.length; s++) {
      const [x0, y0, x1, y1] = P[s];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L;
      const ny = dx / L;
      const amp = (3 + 70 * loud) * Math.min(1, L / 300);
      // each string reads the waveform at a different speed → a different "harmonic"
      const span = 900 * (1 + s * 0.3);
      const alpha = this.presence * (0.12 + 0.55 * loud) * (s === 1 ? 1 : 0.6) * intensity;
      let px = x0;
      let py = y0;
      for (let j = 1; j < STRING_RES; j++) {
        const u = j / (STRING_RES - 1);
        const env = Math.sin(Math.PI * u);
        const idx = Math.floor(trig + u * span);
        let w = wave ? wave[idx % wave.length] : 0;
        // a slow standing-wave swing so silence still breathes a little
        w += 0.03 * Math.sin(time * 2.1 + s) * Math.sin(Math.PI * u * (s + 1));
        const x = x0 + dx * u + nx * w * amp * env;
        const y = y0 + dy * u + ny * w * amp * env;
        b.seg(px, py, alpha, x, y, alpha, s === 1 ? 0.5 : 0);
        px = x;
        py = y;
      }
    }
    b.end();
  }
}
