/**
 * A hand rendered as a glowing skeleton made of fine particle dust.
 *
 * All particle positions are computed on the GPU: each particle knows which
 * bone (landmark a → b) it lives on and where along it (t). The 21 landmark
 * positions are uploaded as a uniform array per frame — no per-particle CPU work.
 *
 * `assemble` (0 → 1) drives the materialisation: particles start in a wide
 * swirling cloud and converge, staggered, onto the bones.
 */

import * as THREE from 'three';
import { BONES } from '../hands.js';

const VERT = /* glsl */ `
uniform vec3 uL[21];
uniform float uTime;
uniform float uAssemble;
uniform float uAlpha;
uniform float uPx;
uniform float uScale;
uniform float uLevel;
uniform vec2 uCenter;
attribute vec3 aInfo;   // landmark a, landmark b, t along bone
attribute vec4 aRand;
attribute float aKind;  // 0 bone dust, 1 joint cloud, 2 joint core
varying float vAlpha;
varying float vAccent;

void main() {
  int ia = int(aInfo.x + 0.5);
  int ib = int(aInfo.y + 0.5);
  vec3 a = uL[ia];
  vec3 b = uL[ib];
  vec2 p = mix(a.xy, b.xy, aInfo.z);
  vec2 d = b.xy - a.xy;
  float len = length(d) + 1e-3;
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  float sh = sin(uTime * (1.3 + aRand.y * 5.0) + aRand.z * 6.2831);
  float size = 1.0;
  float alpha = (0.2 + 0.5 * aRand.y);

  if (aKind < 0.5) {
    // dust around the bone line, thickening with the sound level
    float thick = uScale * (0.012 + 0.05 * uLevel);
    p += nrm * (aRand.x - 0.5) * thick * (1.0 + 0.5 * sh);
    p += dir * sh * 0.8;
  } else if (aKind < 1.5) {
    // small orbiting cloud at each joint
    float ang = aRand.x * 6.2831 + uTime * (0.4 + aRand.y * 1.2);
    float r = uScale * (0.02 + 0.03 * uLevel) * pow(aRand.z, 1.6);
    p += vec2(cos(ang), sin(ang)) * r;
    size = 1.2;
    alpha *= 0.8;
  } else {
    // bright core point on the joint
    bool tip = (ia == 4 || ia == 8 || ia == 12 || ia == 16 || ia == 20);
    size = tip ? 3.4 : 2.2;
    alpha = tip ? 1.0 : 0.75;
  }

  // materialise: staggered flight in from a swirling cloud
  float st = aRand.w * 0.55;
  float e = clamp((uAssemble - st) / 0.45, 0.0, 1.0);
  e = e * e * (3.0 - 2.0 * e);
  float ang2 = aRand.x * 6.2831 + (1.0 - e) * 4.0 + uTime * 0.2;
  vec2 cloud = uCenter + vec2(cos(ang2), sin(ang2) * 0.7) * uScale * (0.9 + 3.2 * aRand.y * aRand.y);
  vec2 pos = mix(cloud, p, e);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 0.0, 1.0);
  gl_PointSize = uPx * size * (0.7 + 0.7 * aRand.y) * mix(1.6, 1.0, e);
  vAlpha = uAlpha * alpha * mix(0.25, 1.0, e) * (0.8 + 0.2 * sh);

  // the cold accent: fingertips + a few random grains
  bool tipBone = (ib == 4 || ib == 8 || ib == 12 || ib == 16 || ib == 20);
  vAccent = tipBone ? smoothstep(0.55, 1.0, aInfo.z) : 0.0;
  if (aKind > 1.5 && (ia == 4 || ia == 8 || ia == 12 || ia == 16 || ia == 20)) vAccent = 1.0;
  vAccent = max(vAccent, step(0.94, aRand.y));
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
  float a = smoothstep(0.25, 0.0, d);
  gl_FragColor = vec4(mix(uColor, uAccent, vAccent), a * vAlpha);
}`;

const BONE_DUST = 80;
const JOINT_DUST = 26;

function buildGeometry() {
  const info = [];
  const rand = [];
  const kind = [];
  const push = (a, b, t, k) => {
    info.push(a, b, t);
    rand.push(Math.random(), Math.random(), Math.random(), Math.random());
    kind.push(k);
  };
  for (const [a, b] of BONES) {
    for (let i = 0; i < BONE_DUST; i++) push(a, b, Math.random(), 0);
  }
  for (let j = 0; j < 21; j++) {
    for (let i = 0; i < JOINT_DUST; i++) push(j, j, 0, 1);
    push(j, j, 0, 2);
  }
  const g = new THREE.BufferGeometry();
  // position is unused by the shader but three needs it for draw range / bounds
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(kind.length * 3), 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 3));
  g.setAttribute('aRand', new THREE.Float32BufferAttribute(rand, 4));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export class HandDust {
  constructor(scene, color, accent) {
    this.uniforms = {
      uL: { value: Array.from({ length: 21 }, () => new THREE.Vector3()) },
      uTime: { value: 0 },
      uAssemble: { value: 0 },
      uAlpha: { value: 0 },
      uPx: { value: 1.5 },
      uScale: { value: 100 },
      uLevel: { value: 0 },
      uCenter: { value: new THREE.Vector2() },
      uColor: { value: color },
      uAccent: { value: accent },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(buildGeometry(), mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // hairline bones underneath the dust
    this.lineGeo = new THREE.BufferGeometry();
    this.linePos = new Float32Array(BONES.length * 2 * 3);
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false });
    this.lines = new THREE.LineSegments(this.lineGeo, this.lineMat);
    this.lines.frustumCulled = false;
    scene.add(this.lines);

    this.px = new Float32Array(63); // displayed landmark positions (screen px)
    this.hasPos = false;
    this.present = false;
    this.alpha = 0;
    this.assemble = 0;
    this.assembleRate = 0.45;
  }

  /** Begin materialising (slow = the first, dramatic appearance). */
  materialize(slow) {
    this.assemble = slow ? 0 : Math.min(this.assemble, 0.55);
    this.assembleRate = slow ? 0.42 : 1.6;
  }

  /**
   * @param {Float32Array|null} target landmarks in screen px (63) or null if absent
   */
  update(target, dt, time, level, scale, pxRatio) {
    const u = this.uniforms;
    if (target) {
      if (!this.hasPos) {
        this.px.set(target);
        this.hasPos = true;
      }
      // smooth 30 Hz tracking up to the display rate (~20 ms time constant)
      const k = 1 - Math.exp(-dt * 50);
      for (let i = 0; i < 63; i++) this.px[i] += (target[i] - this.px[i]) * k;
      this.alpha += (1 - this.alpha) * (1 - Math.exp(-dt * 6));
      this.assemble = Math.min(1, this.assemble + dt * this.assembleRate);
    } else {
      // dissolve: fade and let the dust drift apart a bit
      this.alpha *= Math.exp(-dt * 3.5);
      this.assemble = Math.max(0.6, this.assemble - dt * 0.5);
      if (this.alpha < 0.01) this.hasPos = false;
    }
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < 21; i++) {
      u.uL.value[i].set(this.px[i * 3], this.px[i * 3 + 1], 0);
      cx += this.px[i * 3];
      cy += this.px[i * 3 + 1];
    }
    u.uCenter.value.set(cx / 21, cy / 21);
    u.uTime.value = time;
    u.uAssemble.value = this.assemble;
    u.uAlpha.value = this.alpha;
    u.uLevel.value = level;
    u.uScale.value = scale;
    u.uPx.value = 1.5 * pxRatio;
    this.points.visible = this.alpha > 0.005;

    // bone lines appear only once assembled
    let o = 0;
    for (const [a, b] of BONES) {
      this.linePos[o++] = this.px[a * 3];
      this.linePos[o++] = this.px[a * 3 + 1];
      this.linePos[o++] = 0;
      this.linePos[o++] = this.px[b * 3];
      this.linePos[o++] = this.px[b * 3 + 1];
      this.linePos[o++] = 0;
    }
    this.lineGeo.attributes.position.needsUpdate = true;
    this.lineMat.opacity = this.alpha * Math.max(0, (this.assemble - 0.8) / 0.2) * 0.22;
    this.lines.visible = this.lineMat.opacity > 0.003;
  }
}
