/**
 * WebGL visuals (three.js).
 *
 * Scene (orthographic, 1 unit = 1 css px, y down):
 *   camera ghost image → drone orbits → ambient dust → strings → trails
 *   → particle hands → shed particles / shock rings → pulse flashes
 * Post: phosphor persistence (afterimage) → restrained bloom →
 *       final pass (white flash, glitch slices, grain, vignette, sRGB).
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { HandDust } from './handDust.js';
import { Trails, Strings, LineBatch } from './scope.js';
import { Particles } from './particles.js';
import { Orbits } from './orbits.js';
import { TIPS } from '../hands.js';

const WHITE = new THREE.Color(0xf2f6f8);
const ACCENT = new THREE.Color(0x8fd8ff);

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uGlitch: { value: 0 },
    uGrain: { value: 0.045 },
    uDepth: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uFlash, uGlitch, uGrain, uDepth;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main() {
      vec2 uv = vUv;
      float g = uGlitch;
      if (g > 0.002) {
        // horizontal slice displacement
        float band = floor(uv.y * 34.0) + floor(uTime * 26.0) * 7.0;
        float on = step(1.0 - 0.5 * g, hash(vec2(band, 1.0)));
        uv.x += (hash(vec2(band, 2.0)) - 0.5) * 0.14 * g * on;
      }
      vec3 c = texture2D(tDiffuse, uv).rgb;
      if (g > 0.002) {
        // monochrome echo + inverted scan bands
        float l = dot(texture2D(tDiffuse, uv + vec2(0.006 * g, 0.0)).rgb, vec3(0.333));
        c = max(c, vec3(l) * 0.8);
        float b2 = floor(uv.y * 120.0 + uTime * 60.0);
        float inv = step(1.0 - 0.2 * g, hash(vec2(b2, 3.0)));
        float lum = clamp(dot(c, vec3(0.333)), 0.0, 1.0);
        c = mix(c, vec3(1.0 - lum), inv);
      }
      // crush the faint bloom floor so black stays black, then encode
      c = max(c - 0.0022, 0.0) * 1.003;
      c = toSRGB(c);
      c = mix(c, vec3(1.0), clamp(uFlash, 0.0, 1.0));
      c += (hash(vUv * uRes + fract(uTime * 13.7) * 91.0) - 0.5) * uGrain;
      vec2 q = vUv - 0.5;
      c *= (1.0 - dot(q, q) * (0.7 + 1.6 * uDepth)) * (1.0 - 0.18 * uDepth);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

/**
 * Kaleidoscopic symmetry (K): the rendered scene is summed with mirrored /
 * rotated copies of itself around the screen centre — additive light, so the
 * hands become a living mandala. 2 = left/right mirror, 4 = both axes,
 * 6 = three rotations (120°) each with its mirror image.
 */
const SymmetryShader = {
  uniforms: {
    tDiffuse: { value: null },
    uN: { value: 0 },
    uMix: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform int uN;
    uniform float uMix;
    uniform vec2 uRes;
    varying vec2 vUv;
    vec3 sum; vec3 mx;
    void tap(vec2 p) {
      vec2 uv = p / uRes + 0.5;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return;
      vec3 c = texture2D(tDiffuse, uv).rgb * 0.72; // copies a little dimmer than the original
      sum += c; mx = max(mx, c);
    }
    vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
    void main() {
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      if (uN < 2 || uMix < 0.002) { gl_FragColor = vec4(base, 1.0); return; }
      vec2 p = (vUv - 0.5) * uRes; // px from centre
      sum = vec3(0.0); mx = base;
      if (uN == 2) {
        tap(vec2(-p.x, p.y));
      } else if (uN == 4) {
        tap(vec2(-p.x, p.y)); tap(vec2(p.x, -p.y)); tap(-p);
      } else {
        tap(vec2(-p.x, p.y));
        for (int k = 1; k < 3; k++) {
          vec2 r = rot(p, float(k) * 2.0943951);
          tap(r); tap(vec2(-r.x, r.y));
        }
      }
      // max keeps overlaps restrained, a little of the sum keeps it luminous
      vec3 sym = max(base, mx) + 0.1 * sum;
      gl_FragColor = vec4(mix(base, sym, uMix), 1.0);
    }`,
};

const MODE_LOOK = {
  theremin: { damp: 0.8, ambient: 0.05, swirl: 0, trails: 1, strings: 1, bloom: 0.7 },
  pulse: { damp: 0.62, ambient: 0.03, swirl: 0, trails: 0.8, strings: 1, bloom: 0.65 },
  drone: { damp: 0.92, ambient: 0.17, swirl: 1, trails: 0.55, strings: 0.6, bloom: 0.85 },
};

export class Visuals {
  constructor(canvas, video, toScreen) {
    this.canvas = canvas;
    this.video = video;
    this.toScreen = toScreen;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 1);
    this.renderer = renderer;
    this.pxRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(this.pxRatio);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -100, 100);
    this.camera.position.z = 10;

    // camera ghost image (mirrored, grey, very dark)
    this.videoTex = new THREE.VideoTexture(video);
    this.videoTex.colorSpace = THREE.SRGBColorSpace;
    this.videoMat = new THREE.ShaderMaterial({
      uniforms: { tVideo: { value: this.videoTex }, uOpacity: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tVideo; uniform float uOpacity; varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tVideo, vec2(1.0 - vUv.x, 1.0 - vUv.y)).rgb;
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          l = smoothstep(0.05, 0.9, l);
          gl_FragColor = vec4(vec3(l * l) * uOpacity, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.videoPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.videoMat);
    this.videoPlane.renderOrder = -10;
    this.scene.add(this.videoPlane);
    this.camOpacity = 0;
    this.camTarget = 0.05;

    this.orbits = new Orbits(this.scene, WHITE, ACCENT);
    this.particles = new Particles(this.scene, WHITE, ACCENT);
    this.strings = new Strings(this.scene, WHITE, ACCENT);
    this.trails = new Trails(this.scene, WHITE, ACCENT);
    this.dust = [new HandDust(this.scene, WHITE, ACCENT), new HandDust(this.scene, WHITE, ACCENT)];
    this.flashes = new LineBatch(this.scene, 256, WHITE, ACCENT);
    this.flashList = [];

    // post-processing
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.symmetry = new ShaderPass(SymmetryShader);
    this.composer.addPass(this.symmetry);
    this.symN = 0;
    this.symMix = 0;
    this.afterimage = new AfterimagePass(0.8);
    this.composer.addPass(this.afterimage);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.38, 0.12);
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);

    this.mode = 'theremin';
    this.look = { ...MODE_LOOK.theremin };
    this.time = 0;
    this.flash = 0;
    this.glitch = 0;
    this.hands = { left: null, right: null };
    this.wasPresent = [false, false];
    this.slowUntil = -1;
    this.everSeen = false;
    this.target = [new Float32Array(63), new Float32Array(63)];
    this.prevTips = [new Float32Array(10), new Float32Array(10)];
    this.fpsAvg = 60;
    this.lowFpsT = 0;
    this.W = 1;
    this.H = 1;
  }

  resize(W, H) {
    this.W = W;
    this.H = H;
    this.renderer.setSize(W, H, false);
    this.composer.setPixelRatio(this.pxRatio);
    this.composer.setSize(W, H);
    this.camera.left = 0;
    this.camera.right = W;
    this.camera.top = 0;
    this.camera.bottom = H;
    this.camera.updateProjectionMatrix();
    this.final.uniforms.uRes.value.set(W * this.pxRatio, H * this.pxRatio);
    this.symmetry.uniforms.uRes.value.set(W, H);
    this.video.classList.add('in-gl');
  }

  setMode(mode) {
    this.mode = mode;
  }

  /** 0 (off), 2, 4 or 6-fold symmetry; new copies fade in. */
  setSymmetry(n) {
    this.symN = n;
    this.symMix = 0;
  }

  setCamLevel(l) {
    this.camTarget = [0, 0.06, 0.16][l];
  }

  /** Called by the app on the first appearance of hands (slow, dramatic). */
  materialize(amount) {
    if (amount >= 1) this.slowUntil = this.time + 2.5;
  }

  onHands(hands) {
    this.hands = hands;
  }

  onPinch(e) {
    const p = this.toScreen(e.x, e.y);
    this.particles.burst(p.x, p.y, 36, 260);
    this.flashLine(0, p.y, this.W, p.y, 0.25, 0.06);
  }

  onClap(e) {
    const p = this.toScreen(e.x, e.y);
    this.particles.shock(p.x, p.y, this.W, this.H);
    this.flash = 0.85;
    this.glitch = 1;
  }

  onFreeze(hz) {
    this.orbits.add(hz);
    const R = this.hands.right || this.hands.left;
    if (R) {
      const p = this.toScreen(R.palm.x, R.palm.y);
      this.particles.ring(p.x, p.y, 120, 6, 0.5, 0.6, false); // implode
    }
  }

  onClear() {
    this.orbits.clear();
    this.glitch = Math.max(this.glitch, 0.35);
  }

  flashLine(x0, y0, x1, y1, alpha, life, acc = 0) {
    this.flashList.push({ x0, y0, x1, y1, alpha, life, t: 0, acc });
  }

  /** Screen-px landmarks of a hand. */
  project(h, out) {
    for (let i = 0; i < 21; i++) {
      const p = this.toScreen(h.lm[i * 3], h.lm[i * 3 + 1]);
      out[i * 3] = p.x;
      out[i * 3 + 1] = p.y;
      out[i * 3 + 2] = 0;
    }
    return out;
  }

  render(dt, s) {
    this.time += dt;
    const t = this.time;
    const { W, H } = this;
    const look = this.look;
    const L = MODE_LOOK[this.mode];
    for (const k in L) look[k] += (L[k] - look[k]) * (1 - Math.exp(-dt * 2));
    const level = Math.min(1, s.level * 2);
    const energy = s.ctl.energy || 0;
    const still = s.ctl.still || 0;
    const wave = s.wave;

    // ---- camera ghost
    this.camOpacity += (this.camTarget - this.camOpacity) * (1 - Math.exp(-dt * 3));
    this.videoMat.uniforms.uOpacity.value = this.camOpacity;
    this.videoPlane.visible = this.camOpacity > 0.002 && this.video.readyState >= 2;
    const a = this.toScreen(0, 0);
    const b = this.toScreen(1, 1);
    this.videoPlane.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, -5);
    this.videoPlane.scale.set(b.x - a.x, b.y - a.y, 1);

    // ---- hands (keyed by tracker slot id so dust never jumps between hands)
    const live = [null, null];
    for (const h of [this.hands.left, this.hands.right]) if (h) live[h.id] = h;
    const tips = [];
    for (let i = 0; i < 2; i++) {
      const h = live[i];
      const d = this.dust[i];
      if (h && !this.wasPresent[i]) {
        if (!this.everSeen) {
          this.everSeen = true;
          this.slowUntil = t + 2.5;
        }
        d.materialize(t < this.slowUntil);
      }
      this.wasPresent[i] = !!h;
      const scale = h ? h.size * (b.y - a.y) : 100;
      d.update(h ? this.project(h, this.target[i]) : null, dt, t, level, scale, this.pxRatio);

      // fingertips: trails + shed particles
      const ready = d.assemble > 0.75;
      for (let k = 0; k < 5; k++) {
        const x = d.px[TIPS[k] * 3];
        const y = d.px[TIPS[k] * 3 + 1];
        tips.push({ key: `${i}:${k}`, x, y, alive: !!h && ready, weight: k === 1 ? 1 : k === 0 ? 0.5 : 0.3 });
        if (h && ready) {
          const pv = this.prevTips[i];
          const vx = (x - pv[k * 2]) / Math.max(dt, 1e-3);
          const vy = (y - pv[k * 2 + 1]) / Math.max(dt, 1e-3);
          const sp = Math.hypot(vx, vy);
          if (sp > 60 && sp < 8000) this.particles.shed(x, y, vx, vy, sp, dt, (k === 1 ? 1.4 : 0.7) * (0.5 + 2.5 * energy));
        }
        this.prevTips[i][k * 2] = x;
        this.prevTips[i][k * 2 + 1] = y;
      }
    }
    this.trails.update(tips, wave, level, look.trails, { energy, still, length: still });

    // ---- strings between matching fingertips of left + right
    let pairs = null;
    const HL = this.hands.left;
    const HR = this.hands.right;
    if (HL && HR && this.dust[HL.id].assemble > 0.8 && this.dust[HR.id].assemble > 0.8) {
      const pl = this.dust[HL.id].px;
      const pr = this.dust[HR.id].px;
      pairs = TIPS.map((k) => [pl[k * 3], pl[k * 3 + 1], pr[k * 3], pr[k * 3 + 1]]);
    }
    this.strings.update(pairs, wave, level, dt, t, look.strings);

    // ---- orbits (frozen layers + live orbit in drone mode)
    const droneLive = this.mode === 'drone' && s.ctl.present ? 0.22 + s.ctl.volume * 0.25 : 0;
    this.orbits.update(dt, W, H, level, this.pxRatio, { hz: s.ctl.hz, alpha: droneLive });

    // ---- free particles + ambient dust (swirling around hands in drone mode)
    const attract = [];
    for (const h of [HL, HR]) if (h) {
      const p = this.toScreen(h.palm.x, h.palm.y);
      attract.push({ x: p.x, y: p.y, r: 1 });
    }
    this.particles.update(dt, this.pxRatio, W, H, look.ambient * (0.6 + level), look.swirl, attract);

    // ---- pulse mode: scan lines and barcode bars on sequencer hits
    for (const e of s.events) {
      if (e.type !== 'step') continue;
      if (e.hit && HR) {
        const y = this.toScreen(HR.palm.x, HR.palm.y).y;
        this.flashLine(0, y, W, y, 0.32, 0.07, 1);
      }
      if (e.sub) {
        const n = 3 + Math.floor(Math.random() * 6);
        for (let i = 0; i < n; i++) {
          const x = Math.random() * W;
          this.flashLine(x, 0, x, H, 0.14, 0.09);
        }
      }
    }
    const fb = this.flashes;
    fb.begin();
    for (let i = this.flashList.length - 1; i >= 0; i--) {
      const f = this.flashList[i];
      f.t += dt;
      const u = f.t / f.life;
      if (u >= 1) {
        this.flashList.splice(i, 1);
        continue;
      }
      const al = f.alpha * (1 - u);
      fb.seg(f.x0, f.y0, al, f.x1, f.y1, al, f.acc);
    }
    fb.end();

    // ---- post
    this.flash *= Math.exp(-dt * 14);
    this.glitch *= Math.exp(-dt * 3.2);
    this.symMix = Math.min(1, this.symMix + dt * 1.5);
    this.symmetry.uniforms.uN.value = this.symN;
    this.symmetry.uniforms.uMix.value = this.symN ? this.symMix : 0;
    this.symmetry.enabled = this.symN > 0;
    const fu = this.final.uniforms;
    fu.uTime.value = t;
    fu.uFlash.value = this.flash;
    fu.uGlitch.value = this.glitch;
    // persistence per frame, made frame-rate independent (tuned at 60 fps)
    // stillness: longer, softer glow, less bloom, deeper vignette — sinking into depth
    const damp = look.damp + (0.94 - look.damp) * still * 0.7;
    this.afterimage.uniforms.damp.value = Math.pow(damp, Math.min(4, dt * 60));
    this.bloom.strength = look.bloom * (0.85 + level * 0.3) * (this.symN ? 0.65 : 1) * (1 - 0.3 * still);
    fu.uDepth.value = still;

    this.composer.render(dt);
    this.adapt(dt);
  }

  /** Drop the render resolution if the machine can't hold ~60 fps. */
  adapt(dt) {
    this.fpsAvg += (1 / Math.max(dt, 1e-3) - this.fpsAvg) * 0.05;
    if (this.fpsAvg < 47 && this.pxRatio > 1) {
      this.lowFpsT += dt;
      if (this.lowFpsT > 2.5) {
        this.pxRatio = Math.max(1, this.pxRatio - 0.25);
        this.renderer.setPixelRatio(this.pxRatio);
        this.resize(this.W, this.H);
        this.lowFpsT = 0;
        this.fpsAvg = 60;
      }
    } else {
      this.lowFpsT = 0;
    }
  }
}
