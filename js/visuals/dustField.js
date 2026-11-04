/**
 * Reactive dust field: a very sparse 3D field of tiny grains in the
 * background. Everything is computed on the GPU from a few uniforms:
 *  - slow drift (wrapped), nearer grains drift faster
 *  - parallax: the field shifts with the hands, nearer grains shift more
 *  - pulse: grains flare on clicks and sub hits
 *  - push: fast movement shoves the field outward from the hands
 * Barely visible when quiet, alive when playing.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
uniform float uTime;
uniform vec2 uRes;
uniform vec2 uParallax;
uniform vec2 uPushC;
uniform float uPush;
uniform float uPulse;
uniform float uAlpha;
uniform float uPx;
attribute vec3 aPos;   // x, y in 0..1, z = depth 0 (near) … 1 (far)
attribute vec4 aRand;
varying float vAlpha;
varying float vAccent;
void main() {
  float z = aPos.z;
  vec2 span = uRes * 1.2;
  vec2 p = aPos.xy * span;
  p += vec2(uTime * (3.0 + aRand.x * 5.0), -uTime * (1.5 + aRand.y * 3.0)) * (1.0 - 0.6 * z);
  p = mod(p, span) - uRes * 0.1;
  p += uParallax * (1.0 - z) * 0.14;
  vec2 d = p - uPushC;
  float r = length(d) + 1.0;
  p += d / r * uPush * exp(-r / (uRes.y * 0.6)) * (1.0 - 0.5 * z);
  p = uRes * 0.5 + (p - uRes * 0.5) * (1.0 - 0.22 * z); // depth: far grains huddle to the centre
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
  float flare = uPulse * (0.4 + aRand.z);
  gl_PointSize = uPx * (0.5 + 1.3 * (1.0 - z)) * (1.0 + 1.2 * flare);
  float tw = 0.6 + 0.4 * sin(uTime * (0.4 + aRand.w) + aRand.x * 6.2831);
  vAlpha = (uAlpha * tw + 0.3 * flare) * (0.25 + 0.75 * (1.0 - z));
  vAccent = step(0.9, aRand.y);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uAccent;
varying float vAlpha;
varying float vAccent;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  gl_FragColor = vec4(mix(uColor, uAccent, vAccent), smoothstep(0.25, 0.0, d) * vAlpha);
}`;

const N = 700;

export class DustField {
  constructor(scene, color, accent) {
    const pos = new Float32Array(N * 3);
    const rand = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = Math.random();
      pos[i * 3 + 1] = Math.random();
      pos[i * 3 + 2] = Math.pow(Math.random(), 0.7);
      for (let k = 0; k < 4; k++) rand[i * 4 + k] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aPos', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.u = {
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uParallax: { value: new THREE.Vector2() },
      uPushC: { value: new THREE.Vector2() },
      uPush: { value: 0 },
      uPulse: { value: 0 },
      uAlpha: { value: 0.04 },
      uPx: { value: 1 },
      uColor: { value: color },
      uAccent: { value: accent },
    };
    const m = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = -2;
    scene.add(this.points);
    this.pulse = 0;
    this.push = 0;
    this.time = 0;
  }

  /** Flare the field (click = small, sub hit / clap = big). */
  hit(amount) {
    this.pulse = Math.max(this.pulse, amount);
  }

  /**
   * @param {{x:number,y:number}|null} hands centre of the hands in px (null if none)
   */
  update(dt, W, H, pxRatio, hands, level, energy) {
    const u = this.u;
    this.time += dt;
    u.uTime.value = this.time;
    u.uRes.value.set(W, H);
    u.uPx.value = pxRatio;
    // parallax towards the hands (opposite direction reads as depth)
    const tx = hands ? -(hands.x - W / 2) : 0;
    const ty = hands ? -(hands.y - H / 2) : 0;
    const k = 1 - Math.exp(-dt * 1.5);
    u.uParallax.value.x += (tx - u.uParallax.value.x) * k;
    u.uParallax.value.y += (ty - u.uParallax.value.y) * k;
    if (hands) u.uPushC.value.set(hands.x, hands.y);
    // push: rises fast with energy, relaxes slowly
    const pt = energy * Math.min(W, H) * 0.12;
    this.push += (pt - this.push) * (1 - Math.exp(-dt * (pt > this.push ? 6 : 0.8)));
    u.uPush.value = this.push;
    this.pulse *= Math.exp(-dt * 7);
    u.uPulse.value = this.pulse;
    const at = 0.035 + 0.3 * level + 0.15 * energy;
    u.uAlpha.value += (at - u.uAlpha.value) * (1 - Math.exp(-dt * 3));
  }
}
