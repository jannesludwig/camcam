/**
 * Gesture detection — few gestures, made reliable with hysteresis,
 * hold times and cooldowns. Ratios come from metric world landmarks
 * (normalised by the wrist → middle-knuckle length), so they do not
 * depend on distance to the camera.
 *
 *   pinch  thumb tip ↔ index tip           → 'pinch'  (per hand, instant)
 *   fist   all fingertips curled to palm    → 'fist'   (per hand, ~90 ms hold)
 *   open   both hands spread wide           → 'clear'  (held 0.8 s, shows progress)
 *   clap   palms meet (or both vanish while → 'clap'
 *          merging into one blob)
 */

const T = {
  pinchOn: 0.3,
  pinchOff: 0.48,
  pinchMinIndex: 1.0, // index tip must not be curled into the palm (avoids fist → pinch)
  pinchMinInterval: 0.06,
  fistOn: 1.12,
  fistOff: 1.38,
  fistHold: 0.09,
  openCurl: 1.6,
  openSpread: 1.25,
  openThumb: 0.7,
  clearHold: 0.8,
  clapOn: 0.95, // palm distance / hand size
  clapRearm: 2.4,
  clapNear: 1.9,
  clapCooldown: 0.6,
};

class HandGestureState {
  constructor() {
    this.pinch = false;
    this.lastPinch = -1;
    this.fist = false;
    this.fistSince = -1;
    this.fistFired = false;
    this.open = false;
  }
}

export class Gestures {
  constructor() {
    this.state = { left: new HandGestureState(), right: new HandGestureState() };
    this.clearSince = -1;
    this.clearProgress = 0;
    this.clapArmed = true;
    this.lastClap = -10;
    this.prevPair = null; // {ratio, closing, x, y, t}
    this.debug = {};
  }

  /** @returns {Array<object>} events this frame */
  update(hands, t) {
    const ev = [];
    for (const role of ['left', 'right']) {
      const h = hands[role];
      const g = this.state[role];
      if (!h) {
        g.pinch = false;
        g.fist = false;
        g.fistSince = -1;
        g.fistFired = false;
        g.open = false;
        continue;
      }
      // ---- pinch (rising edge)
      if (!g.pinch && h.pinch < T.pinchOn && h.indexExt > T.pinchMinIndex && !g.fist) {
        g.pinch = true;
        if (t - g.lastPinch > T.pinchMinInterval) {
          g.lastPinch = t;
          const tx = (h.lm[4 * 3] + h.lm[8 * 3]) / 2;
          const ty = (h.lm[4 * 3 + 1] + h.lm[8 * 3 + 1]) / 2;
          ev.push({ type: 'pinch', role, x: tx, y: ty });
        }
      } else if (g.pinch && h.pinch > T.pinchOff) {
        g.pinch = false;
      }

      // ---- fist (held briefly to confirm)
      if (h.curl < T.fistOn) {
        if (g.fistSince < 0) g.fistSince = t;
        if (!g.fistFired && t - g.fistSince > T.fistHold) {
          g.fist = true;
          g.fistFired = true;
          ev.push({ type: 'fist', role, x: h.palm.x, y: h.palm.y });
        }
      } else if (h.curl > T.fistOff) {
        g.fist = false;
        g.fistSince = -1;
        g.fistFired = false;
      }

      // ---- open wide
      g.open = h.curl > T.openCurl && h.spread > T.openSpread && h.thumbOut > T.openThumb;
    }

    // ---- clear: both hands open wide, held
    const L = hands.left;
    const R = hands.right;
    if (L && R && this.state.left.open && this.state.right.open) {
      if (this.clearSince < 0) this.clearSince = t;
      this.clearProgress = Math.min(1, (t - this.clearSince) / T.clearHold);
      if (this.clearProgress >= 1) {
        ev.push({ type: 'clear' });
        this.clearSince = t + 1.5; // cooldown: progress restarts after 1.5 s
        this.clearProgress = 0;
      }
    } else {
      this.clearSince = -1;
      this.clearProgress = 0;
    }

    // ---- clap / hands touching
    if (L && R && L.visible && R.visible) {
      const size = (L.size + R.size) / 2;
      const d = Math.hypot((L.palm.x - R.palm.x) * 1.6, L.palm.y - R.palm.y);
      const ratio = d / Math.max(0.03, size);
      const closing = this.prevPair ? (this.prevPair.ratio - ratio) / Math.max(1e-3, t - this.prevPair.t) : 0;
      const x = (L.palm.x + R.palm.x) / 2;
      const y = (L.palm.y + R.palm.y) / 2;
      if (this.clapArmed && ratio < T.clapOn && t - this.lastClap > T.clapCooldown) {
        ev.push({ type: 'clap', x, y, strength: Math.min(1, 0.5 + closing / 20) });
        this.clapArmed = false;
        this.lastClap = t;
      }
      if (ratio > T.clapRearm) this.clapArmed = true;
      this.prevPair = { ratio, closing, x, y, t };
      this.debug.clapRatio = ratio;
    } else {
      // hands that merge into each other often make the tracker drop one of them
      const p = this.prevPair;
      if (p && this.clapArmed && t - p.t < 0.15 && p.ratio < T.clapNear && p.closing > 2 && t - this.lastClap > T.clapCooldown) {
        ev.push({ type: 'clap', x: p.x, y: p.y, strength: 1 });
        this.clapArmed = false;
        this.lastClap = t;
      }
      if (!p || t - p.t > 0.15) this.prevPair = null;
      // re-arm when both hands are gone for a moment
      if (!L && !R && t - this.lastClap > 1) this.clapArmed = true;
    }
    return ev;
  }
}
