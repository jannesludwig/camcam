/**
 * Turns raw HandLandmarker results into two stable, filtered hands
 * (`left` = user's left hand, `right` = user's right hand) plus features.
 *
 * Coordinates: everything is stored in *mirrored* normalised video space
 * (x: 0 = left of the screen as the user sees it, y: 0 = top). Geometry that
 * needs equal units on both axes multiplies x by the video aspect ratio.
 *
 * Pipeline per frame
 *   1. match detections to two persistent slots (nearest palm) → stable filters
 *   2. One Euro filter landmarks (screen) + world landmarks (metric)
 *   3. assign roles: two hands → by x order; one hand → keep the role it had,
 *      otherwise use MediaPipe's handedness label. Whether the label is
 *      mirrored is *learned* at runtime from frames where both hands are visible.
 *   4. compute features (palm, size/depth, pinch, curl, spread, speeds)
 *   5. short grace period so a dropped frame does not cut the sound
 */

import { LandmarkFilter } from './filters.js';

export const TIPS = [4, 8, 12, 16, 20];
const PALM = [0, 5, 9, 13, 17];
const GRACE = 0.11; // s a hand is kept alive after it was last seen

/** Hand skeleton connections (bones), used by the visuals. */
export const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

function dist3(a, i, j) {
  const dx = a[i * 3] - a[j * 3];
  const dy = a[i * 3 + 1] - a[j * 3 + 1];
  const dz = a[i * 3 + 2] - a[j * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

class Slot {
  constructor(id) {
    this.id = id;
    this.lmFilter = new LandmarkFilter(21, 1.4, 14, 2.5);
    this.worldFilter = new LandmarkFilter(21, 4, 10, 2.5);
    this.lm = new Float32Array(63); // filtered, mirrored normalised
    this.world = new Float32Array(63); // filtered, metres
    this.raw = new Float32Array(63);
    this.rawWorld = new Float32Array(63);
    this.present = false;
    this.visible = false;
    this.lastSeen = -1;
    this.appearedAt = 0;
    this.role = null;
    this.label = null;
    this.palm = { x: 0.5, y: 0.5 };
    this.size = 0.15;
    this.pinch = 1;
    this.curl = 1.8;
    this.indexExt = 1.8;
    this.spread = 1;
    this.thumbOut = 1;
    this.tipSpeed = new Float32Array(5);
    this.speed = 0; // palm speed (normalised units / s)
  }

  reset() {
    this.lmFilter.reset();
    this.worldFilter.reset();
    this.role = null;
  }
}

export class HandProcessor {
  constructor() {
    this.slots = [new Slot(0), new Slot(1)];
    this.aspect = 16 / 9;
    // evidence about whether MediaPipe's handedness label is mirrored
    // (> 0: label "Left" is the user's right hand). Prior: mirrored.
    this.labelFlip = 4;
    this.hands = { left: null, right: null };
  }

  /**
   * @param {{landmarks: Array, worldLandmarks: Array, handedness: Array}} res
   * @param {number} t seconds
   * @param {boolean} mirrored whether input x still needs mirroring
   */
  process(res, t, mirrored = true) {
    // ---- 1. collect detections
    const dets = [];
    const n = res && res.landmarks ? res.landmarks.length : 0;
    for (let i = 0; i < n; i++) {
      const lm = res.landmarks[i];
      const raw = new Float32Array(63);
      for (let k = 0; k < 21; k++) {
        raw[k * 3] = mirrored ? 1 - lm[k].x : lm[k].x;
        raw[k * 3 + 1] = lm[k].y;
        raw[k * 3 + 2] = lm[k].z;
      }
      const w = res.worldLandmarks && res.worldLandmarks[i];
      const rawW = new Float32Array(63);
      if (w) {
        for (let k = 0; k < 21; k++) {
          rawW[k * 3] = mirrored ? -w[k].x : w[k].x;
          rawW[k * 3 + 1] = w[k].y;
          rawW[k * 3 + 2] = w[k].z;
        }
      }
      let px = 0;
      let py = 0;
      for (const p of PALM) {
        px += raw[p * 3];
        py += raw[p * 3 + 1];
      }
      const h = res.handedness && res.handedness[i] && res.handedness[i][0];
      dets.push({ raw, rawW, px: px / 5, py: py / 5, label: h ? h.categoryName : null });
    }
    // drop a duplicate detection of the same hand
    if (dets.length === 2 && Math.hypot(dets[0].px - dets[1].px, dets[0].py - dets[1].py) < 0.04) dets.pop();

    // ---- 2. match detections to slots (2×2 is small enough to brute force)
    const [A, B] = this.slots;
    const cost = (s, d) => (s.present ? Math.hypot(s.palm.x - d.px, s.palm.y - d.py) : 0.5);
    let assign = []; // [slot, det]
    if (dets.length === 1) {
      const d = dets[0];
      const ca = cost(A, d);
      const cb = cost(B, d);
      // prefer a live slot if it is close; a far jump means a different hand
      let s = ca <= cb ? A : B;
      if (s.present && cost(s, d) > 0.3) s = s === A ? B : A;
      assign = [[s, d]];
    } else if (dets.length === 2) {
      const straight = cost(A, dets[0]) + cost(B, dets[1]);
      const crossed = cost(A, dets[1]) + cost(B, dets[0]);
      assign = straight <= crossed ? [[A, dets[0]], [B, dets[1]]] : [[A, dets[1]], [B, dets[0]]];
    }

    const seen = new Set();
    for (const [s, d] of assign) {
      seen.add(s);
      if (!s.present) {
        s.reset();
        s.appearedAt = t;
      }
      s.raw.set(d.raw);
      s.rawWorld.set(d.rawW);
      s.lm.set(s.lmFilter.filter(d.raw, t));
      s.world.set(s.worldFilter.filter(d.rawW, t));
      s.present = true;
      s.visible = true;
      s.lastSeen = t;
      s.label = d.label;
      this.features(s);
    }
    for (const s of this.slots) {
      if (seen.has(s)) continue;
      s.visible = false;
      if (s.present && t - s.lastSeen > GRACE) {
        s.present = false;
        s.role = null;
      }
    }

    // ---- 3. roles
    const live = this.slots.filter((s) => s.present);
    if (live.length === 2) {
      const [l, r] = live[0].palm.x <= live[1].palm.x ? live : [live[1], live[0]];
      l.role = 'left';
      r.role = 'right';
      // learn label orientation (only when both are clearly apart)
      if (l.visible && r.visible && r.palm.x - l.palm.x > 0.15 && l.label && r.label && l.label !== r.label) {
        const vote = r.label === 'Left' ? 1 : -1;
        this.labelFlip = Math.max(-30, Math.min(30, this.labelFlip + vote));
      }
    } else if (live.length === 1) {
      const s = live[0];
      if (!s.role) {
        if (s.label === 'Mouse') {
          s.role = 'right';
        } else if (s.label) {
          const isLeftLabel = s.label === 'Left';
          const flip = this.labelFlip >= 0;
          s.role = isLeftLabel === flip ? 'right' : 'left';
        } else {
          s.role = s.palm.x > 0.5 ? 'right' : 'left';
        }
      }
    }

    this.hands.left = live.find((s) => s.role === 'left') || null;
    this.hands.right = live.find((s) => s.role === 'right') || null;
    this.hands.count = live.length;
    this.hands.visibleCount = this.slots.filter((s) => s.visible).length;
    return this.hands;
  }

  /** Geometric features of a slot, from filtered data. */
  features(s) {
    const a = this.aspect;
    const L = s.lm;
    let px = 0;
    let py = 0;
    for (const p of PALM) {
      px += L[p * 3];
      py += L[p * 3 + 1];
    }
    px /= 5;
    py /= 5;
    s.speed = s.lmFilter.speed[9];
    s.palm.x = px;
    s.palm.y = py;

    // apparent size → closeness to the camera. Max of two roughly orthogonal
    // palm segments makes it robust to rotating the hand.
    const seg = (i, j) => Math.hypot((L[i * 3] - L[j * 3]) * a, L[i * 3 + 1] - L[j * 3 + 1]);
    s.size = Math.max(seg(0, 9), seg(5, 17) * 1.3);

    // pose-invariant ratios from metric world landmarks
    const W = s.world;
    const palmW = Math.max(0.02, dist3(W, 0, 9));
    s.pinch = dist3(W, 4, 8) / palmW;
    s.indexExt = dist3(W, 8, 0) / palmW;
    s.curl = (dist3(W, 8, 0) + dist3(W, 12, 0) + dist3(W, 16, 0) + dist3(W, 20, 0)) / (4 * palmW);
    s.spread = dist3(W, 8, 20) / palmW;
    s.thumbOut = dist3(W, 4, 5) / palmW;
    for (let i = 0; i < 5; i++) s.tipSpeed[i] = s.lmFilter.speed[TIPS[i]];
  }
}
