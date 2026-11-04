/**
 * One Euro Filter (Casiez, Roussel, Vogel — CHI 2012).
 *
 * An adaptive low-pass filter: at low speeds the cutoff is low (kills jitter),
 * at high speeds the cutoff rises (kills lag). That is exactly what a
 * theremin needs: a hand held still must not wobble the pitch, a fast gesture
 * must not feel late.
 *
 *   cutoff = minCutoff + beta * |speed|
 *
 * `LandmarkFilter` filters N 3D points at once and drives the cutoff of each
 * point from its *vector* speed (not per axis), which keeps a point's motion
 * direction intact.
 */

const TWO_PI = Math.PI * 2;

/** Smoothing factor of a one-pole low-pass for a given cutoff (Hz) and dt (s). */
function alpha(cutoff, dt) {
  const tau = 1 / (TWO_PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** Scalar One Euro filter. */
export class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.tPrev = null;
    this.xHat = 0;
    this.dxHat = 0;
  }

  /** @param {number} x raw value  @param {number} t time in seconds */
  filter(x, t) {
    if (this.tPrev === null) {
      this.tPrev = t;
      this.xHat = x;
      this.dxHat = 0;
      return x;
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    this.tPrev = t;
    const dx = (x - this.xHat) / dt;
    this.dxHat += alpha(this.dCutoff, dt) * (dx - this.dxHat);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    this.xHat += alpha(cutoff, dt) * (x - this.xHat);
    return this.xHat;
  }
}

/** One Euro filter for `n` 3D points stored flat as [x0,y0,z0, x1,y1,z1, ...]. */
export class LandmarkFilter {
  constructor(n, minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.n = n;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xHat = new Float32Array(n * 3);
    this.dxHat = new Float32Array(n * 3);
    /** filtered speed per point (units / s) — handy for particle emission */
    this.speed = new Float32Array(n);
    this.reset();
  }

  reset() {
    this.tPrev = null;
    this.dxHat.fill(0);
    this.speed.fill(0);
  }

  /**
   * @param {ArrayLike<number>} src flat array of n*3 raw values
   * @param {number} t time in seconds
   * @returns {Float32Array} filtered values (internal buffer, do not keep)
   */
  filter(src, t) {
    const { n, xHat, dxHat } = this;
    if (this.tPrev === null) {
      this.tPrev = t;
      for (let i = 0; i < n * 3; i++) xHat[i] = src[i];
      return xHat;
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    this.tPrev = t;
    const aD = alpha(this.dCutoff, dt);
    for (let p = 0; p < n; p++) {
      const o = p * 3;
      // derivative (velocity) estimate, smoothed with a fixed cutoff
      let sp2 = 0;
      for (let k = 0; k < 3; k++) {
        const dx = (src[o + k] - xHat[o + k]) / dt;
        dxHat[o + k] += aD * (dx - dxHat[o + k]);
        sp2 += dxHat[o + k] * dxHat[o + k];
      }
      const speed = Math.sqrt(sp2);
      this.speed[p] = speed;
      const a = alpha(this.minCutoff + this.beta * speed, dt);
      for (let k = 0; k < 3; k++) xHat[o + k] += a * (src[o + k] - xHat[o + k]);
    }
    return xHat;
  }
}
