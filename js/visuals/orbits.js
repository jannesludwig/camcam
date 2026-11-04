/**
 * Frozen drone layers as slow, faint orbit structures in the background.
 * Each orbit is a tilted ring of particles (computed on the GPU) whose radius
 * encodes the pitch (lower = wider) and whose ripple count encodes the note.
 * In DRONE mode an extra "live" orbit follows the playing tone.
 */

import * as THREE from 'three';
import { hzToMidi } from '../music.js';

const VERT = /* glsl */ `
uniform float uTime;
uniform float uR;
uniform float uK;
uniform float uSpin;
uniform float uLevel;
uniform float uAlpha;
uniform float uPx;
uniform mat3 uRot;
uniform vec2 uCenter;
attribute vec2 aOrbit; // theta, band offset
attribute vec4 aRand;
varying float vAlpha;
varying float vAccent;
void main() {
  float th = aOrbit.x + uTime * uSpin * (1.0 + aRand.z * 0.05);
  float ripple = sin(uK * th + uTime * 0.6) * (0.012 + 0.05 * uLevel);
  float r = uR * (1.0 + ripple + aOrbit.y);
  vec3 p = uRot * vec3(cos(th) * r, sin(th) * r, 0.0);
  float persp = 1.0 / (1.0 + p.z / 1800.0);
  vec2 pos = uCenter + p.xy * persp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 0.0, 1.0);
  gl_PointSize = uPx * (0.7 + aRand.x * 0.9) * persp;
  float depth = clamp(0.55 - p.z / (uR * 2.2), 0.15, 1.0);
  vAlpha = uAlpha * depth * (0.3 + 0.7 * aRand.y) * (0.75 + 0.25 * sin(uTime * (0.5 + aRand.w) + aRand.x * 6.28));
  vAccent = step(0.85, aRand.w);
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

const N = 2600;

function geometry() {
  const orbit = new Float32Array(N * 2);
  const rand = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    orbit[i * 2] = Math.random() * Math.PI * 2;
    // most grains on the line, a few scattered in a soft band
    const b = Math.random();
    orbit[i * 2 + 1] = (Math.random() - 0.5) * (b < 0.7 ? 0.006 : 0.08);
    for (let k = 0; k < 4; k++) rand[i * 4 + k] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 2));
  g.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

class Orbit {
  constructor(scene, geo, color, accent, hz, live = false) {
    const tiltX = (live ? 1.05 : 0.9 + Math.random() * 0.5) * (Math.random() < 0.5 ? 1 : -1);
    const rotZ = Math.random() * Math.PI;
    const m4 = new THREE.Matrix4().makeRotationZ(rotZ).multiply(new THREE.Matrix4().makeRotationX(tiltX));
    this.u = {
      uTime: { value: 0 },
      uR: { value: 10 },
      uK: { value: 3 },
      uSpin: { value: (0.03 + Math.random() * 0.05) * (Math.random() < 0.5 ? 1 : -1) },
      uLevel: { value: 0 },
      uAlpha: { value: 0 },
      uPx: { value: 1 },
      uRot: { value: new THREE.Matrix3().setFromMatrix4(m4) },
      uCenter: { value: new THREE.Vector2() },
      uColor: { value: color },
      uAccent: { value: accent },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -1;
    scene.add(this.points);
    this.scene = scene;
    this.hz = hz;
    this.t = 0;
    this.dying = false;
    this.deadT = 0;
    this.live = live;
    this.alphaTarget = live ? 0 : 0.32;
    this.rFactor = 0.05; // grows to 1 on birth
  }

  /** Radius from pitch: low notes = wide orbits. */
  targetRadius(W, H) {
    const m = hzToMidi(Math.max(20, this.hz));
    const u = Math.max(0, Math.min(1, (m - 28) / 56));
    return Math.min(W, H) * (0.5 - 0.34 * u);
  }

  update(dt, W, H, level, pxRatio) {
    this.t += dt;
    const u = this.u;
    u.uTime.value = this.t + 20;
    u.uPx.value = pxRatio * 1.3;
    u.uLevel.value = level;
    u.uCenter.value.set(W / 2, H / 2);
    // ripple count follows the note (pitch class + octave)
    u.uK.value = 2 + (Math.round(hzToMidi(Math.max(20, this.hz))) % 12);
    this.rFactor += (1 - this.rFactor) * (1 - Math.exp(-dt * (this.live ? 3 : 1.4)));
    let R = this.targetRadius(W, H) * this.rFactor;
    let a = u.uAlpha.value + (this.alphaTarget - u.uAlpha.value) * (1 - Math.exp(-dt * (this.live ? 2 : 1.2)));
    if (this.dying) {
      this.deadT += dt;
      R *= 1 + this.deadT * this.deadT * 1.2;
      a *= Math.exp(-dt * 2.2);
    }
    u.uR.value = R;
    u.uAlpha.value = a;
    return !(this.dying && a < 0.004);
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.material.dispose();
  }
}

export class Orbits {
  constructor(scene, color, accent) {
    this.scene = scene;
    this.color = color;
    this.accent = accent;
    this.geo = geometry();
    this.list = [];
    this.live = new Orbit(scene, this.geo, color, accent, 110, true);
  }

  add(hz) {
    const alive = this.list.filter((o) => !o.dying);
    if (alive.length >= 3) alive[0].dying = true;
    this.list.push(new Orbit(this.scene, this.geo, this.color, this.accent, hz));
  }

  clear() {
    for (const o of this.list) o.dying = true;
  }

  /** @param {{hz:number, alpha:number}} live tone shown as a live orbit (DRONE mode) */
  update(dt, W, H, level, pxRatio, live) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (!this.list[i].update(dt, W, H, level, pxRatio)) {
        this.list[i].dispose();
        this.list.splice(i, 1);
      }
    }
    this.live.hz += (live.hz - this.live.hz) * (1 - Math.exp(-dt * 1.5));
    this.live.alphaTarget = live.alpha;
    this.live.update(dt, W, H, level, pxRatio);
    this.live.points.visible = this.live.u.uAlpha.value > 0.003;
  }
}
