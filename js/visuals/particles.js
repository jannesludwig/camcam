/**
 * Free particles: dust shed from moving fingertips, spark bursts (pinch),
 * shock waves (clap), and a faint ambient dust field.
 *
 * CPU-simulated pool (typed arrays) rendered as one Points draw call.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
attribute float aAccent;
uniform float uPx;
varying float vAlpha;
varying float vAccent;
void main() {
  vAlpha = aAlpha;
  vAccent = aAccent;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPx;
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

export class Particles {
  constructor(scene, color, accent, max = 9000) {
    this.max = max;
    this.x = new Float32Array(max);
    this.y = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.life = new Float32Array(max); // remaining s
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.acc = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.head = 0;

    this.pos = new Float32Array(max * 3);
    this.aAlpha = new Float32Array(max);
    this.aSize = new Float32Array(max);
    this.aAccent = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAccent', new THREE.BufferAttribute(this.aAccent, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.uniforms = { uColor: { value: color }, uAccent: { value: accent }, uPx: { value: 1 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // expanding shock rings (clap) and small rings (pinch / freeze)
    this.rings = [];
    this.ringGroup = new THREE.Group();
    scene.add(this.ringGroup);
    this.ringGeo = new THREE.RingGeometry(0.985, 1, 256, 1);
    this.ringGeoThick = new THREE.RingGeometry(0.94, 1, 256, 1);

    // ambient dust (separate, slow, very faint)
    this.ambient = { n: 1400, x: null, y: null, s: null, alpha: 0.05 };
    this.time = 0;
  }

  spawn(x, y, vx, vy, life, size = 1.2, accent = 0, drag = 1.6) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.acc[i] = accent;
    this.drag[i] = drag;
  }

  /** Dust shed from a moving fingertip. */
  shed(x, y, vx, vy, speed, dt, weight = 1) {
    const n = Math.min(14, speed * dt * 0.045 * weight);
    let count = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    while (count--) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 18 + 4;
      this.spawn(
        x + (Math.random() - 0.5) * 6,
        y + (Math.random() - 0.5) * 6,
        vx * 0.12 + Math.cos(a) * r,
        vy * 0.12 + Math.sin(a) * r - 6,
        0.8 + Math.random() * 1.8,
        0.8 + Math.random() * 1.2,
        Math.random() < 0.2 ? 1 : 0,
        1.2
      );
    }
  }

  /** Tight radial burst (pinch click). */
  burst(x, y, n = 40, speed = 220) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.1;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, 0.25 + Math.random() * 0.35, 1.1, Math.random() < 0.5 ? 1 : 0, 6);
    }
    this.ring(x, y, 4, 70, 0.35, 0.5, false);
  }

  /** Clap shock wave: push every particle away + ring of new dust + rings. */
  shock(x, y, W, H) {
    const R = Math.hypot(W, H);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      const dx = this.x[i] - x;
      const dy = this.y[i] - y;
      const d = Math.hypot(dx, dy) + 1;
      const f = 2600 / (1 + d / 120);
      this.vx[i] += (dx / d) * f;
      this.vy[i] += (dy / d) * f;
      this.life[i] = Math.max(this.life[i], 0.6);
    }
    const n = 900;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 500 + Math.random() * 1600;
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, 0.6 + Math.random() * 1.4, 0.8 + Math.random() * 1.6, Math.random() < 0.25 ? 1 : 0, 2.4);
    }
    // push the ambient dust too
    const A = this.ambient;
    if (A.x) {
      for (let i = 0; i < A.n; i++) {
        const dx = A.x[i] - x;
        const dy = A.y[i] - y;
        const d = Math.hypot(dx, dy) + 1;
        const f = 900 / (1 + d / 200);
        A.vx[i] += (dx / d) * f;
        A.vy[i] += (dy / d) * f;
      }
    }
    this.ring(x, y, 10, R * 0.9, 1.1, 0.55, false);
    this.ring(x, y, 4, R * 0.5, 1.6, 0.3, false);
    this.ring(x, y, 2, R * 0.25, 0.5, 0.5, false);
  }

  ring(x, y, r0, r1, life, alpha, thick) {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: alpha, blending: THREE.AdditiveBlending, depthTest: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(thick ? this.ringGeoThick : this.ringGeo, m);
    mesh.position.set(x, y, 0);
    this.ringGroup.add(mesh);
    this.rings.push({ mesh, r0, r1, life, t: 0, alpha });
  }

  initAmbient(W, H) {
    const A = this.ambient;
    A.W = W;
    A.H = H;
    A.x = new Float32Array(A.n);
    A.y = new Float32Array(A.n);
    A.vx = new Float32Array(A.n);
    A.vy = new Float32Array(A.n);
    A.s = new Float32Array(A.n);
    A.p = new Float32Array(A.n);
    for (let i = 0; i < A.n; i++) {
      A.x[i] = Math.random() * W;
      A.y[i] = Math.random() * H;
      A.s[i] = 0.6 + Math.random() * 1.1;
      A.p[i] = Math.random() * 6.28;
    }
  }

  /**
   * @param {number} dt
   * @param {{x:number,y:number,r:number}[]} attractors hands (ambient dust swirls around them)
   */
  update(dt, pxRatio, W, H, ambientAlpha = 0.05, swirl = 0, attractors = []) {
    this.time += dt;
    const t = this.time;
    this.uniforms.uPx.value = pxRatio;
    let n = 0;
    const P = this.pos;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt);
      // gentle flow field so dust curls instead of moving in straight lines
      const fx = Math.sin(this.y[i] * 0.011 + t * 0.7) * 22;
      const fy = Math.cos(this.x[i] * 0.009 - t * 0.5) * 22 - 8;
      this.vx[i] = this.vx[i] * k + fx * dt;
      this.vy[i] = this.vy[i] * k + fy * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      const f = Math.max(0, this.life[i] / this.maxLife[i]);
      P[n * 3] = this.x[i];
      P[n * 3 + 1] = this.y[i];
      P[n * 3 + 2] = 0;
      this.aAlpha[n] = Math.pow(f, 1.3) * 0.8;
      this.aSize[n] = this.size[i] * (0.6 + 0.4 * f);
      this.aAccent[n] = this.acc[i];
      n++;
    }

    // ambient dust
    const A = this.ambient;
    if (!A.x || A.W !== W || A.H !== H) this.initAmbient(W, H);
    if (ambientAlpha > 0.002) {
      for (let i = 0; i < A.n; i++) {
        let ax = Math.sin(A.y[i] * 0.004 + t * 0.07 + A.p[i]) * 6;
        let ay = Math.cos(A.x[i] * 0.003 + t * 0.05) * 6 - 2;
        // orbit around attractors (drone mode)
        for (const h of attractors) {
          const dx = A.x[i] - h.x;
          const dy = A.y[i] - h.y;
          const d2 = dx * dx + dy * dy + 900;
          const f = (swirl * h.r * 140) / d2;
          ax += -dy * f;
          ay += dx * f;
        }
        const k = Math.exp(-1.2 * dt);
        A.vx[i] = A.vx[i] * k + ax * dt * 4;
        A.vy[i] = A.vy[i] * k + ay * dt * 4;
        A.x[i] += A.vx[i] * dt;
        A.y[i] += A.vy[i] * dt;
        if (A.x[i] < -10) A.x[i] += W + 20;
        else if (A.x[i] > W + 10) A.x[i] -= W + 20;
        if (A.y[i] < -10) A.y[i] += H + 20;
        else if (A.y[i] > H + 10) A.y[i] -= H + 20;
        if (n >= this.max) break;
        P[n * 3] = A.x[i];
        P[n * 3 + 1] = A.y[i];
        P[n * 3 + 2] = 0;
        this.aAlpha[n] = ambientAlpha * (0.5 + 0.5 * Math.sin(t * 0.6 + A.p[i] * 3));
        this.aSize[n] = A.s[i];
        this.aAccent[n] = i % 9 === 0 ? 1 : 0;
        n++;
      }
    }

    const g = this.geo;
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAccent.needsUpdate = true;
    // partial upload would be nicer; the arrays are small enough (≈ 200 kB)

    // rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const u = Math.min(1, r.t / r.life);
      const e = 1 - Math.pow(1 - u, 3);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      r.mesh.scale.set(rad, rad, 1);
      r.mesh.material.opacity = r.alpha * Math.pow(1 - u, 1.5);
      if (u >= 1) {
        this.ringGroup.remove(r.mesh);
        r.mesh.material.dispose();
        this.rings.splice(i, 1);
      }
    }
  }
}
