/**
 * Input sources. Both produce HandLandmarker-shaped results
 * ({landmarks, worldLandmarks, handedness}) so the rest of the app
 * does not care where hands come from.
 *
 *  CameraTracker — webcam + MediaPipe HandLandmarker (runs locally in WASM/GPU;
 *                  the camera image never leaves the browser).
 *  MouseHand     — synthetic right hand driven by the mouse (fallback / M key).
 */

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class CameraTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.onResult = null; // (result, tSeconds) => void
    this.detectMs = 0;
    this.fps = 0;
    this._frames = 0;
    this._fpsT = performance.now();
  }

  /** Ask for the camera. Throws if unavailable / denied. */
  async startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no getUserMedia');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
    });
    this.stream = stream;
    const v = this.video;
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    await v.play();
    if (!v.videoWidth) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    return { width: v.videoWidth, height: v.videoHeight };
  }

  /** Load MediaPipe (GPU delegate first, CPU fallback). */
  async loadModel() {
    const { FilesetResolver, HandLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('GPU delegate failed, using CPU', e);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
      this.delegate = 'CPU';
    }
  }

  /**
   * Run detection on every new camera frame. requestVideoFrameCallback fires
   * as soon as a frame is decoded — lower latency than polling in rAF.
   */
  start() {
    this.running = true;
    const v = this.video;
    const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    const step = () => {
      if (!this.running) return;
      this.detect();
      if (hasRVFC) v.requestVideoFrameCallback(step);
      else requestAnimationFrame(step);
    };
    if (hasRVFC) v.requestVideoFrameCallback(step);
    else requestAnimationFrame(step);
  }

  stop() {
    this.running = false;
  }

  detect() {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const t0 = performance.now();
    let res;
    try {
      res = this.landmarker.detectForVideo(v, t0);
    } catch (e) {
      console.warn(e);
      return;
    }
    const t1 = performance.now();
    this.detectMs += (t1 - t0 - this.detectMs) * 0.1;
    this._frames++;
    if (t1 - this._fpsT > 1000) {
      this.fps = (this._frames * 1000) / (t1 - this._fpsT);
      this._frames = 0;
      this._fpsT = t1;
    }
    if (this.onResult) this.onResult(res, t1 / 1000);
  }
}

// ------------------------------------------------------------------ mouse hand

/**
 * A plausible open right hand, in units of the wrist → middle-knuckle length,
 * relative to the wrist; y points down, x points to the user's right.
 * (Seen from the camera, mirrored — i.e. as it appears on screen.)
 */
const TEMPLATE = [
  [0, 0], // 0 wrist
  [-0.38, -0.18], [-0.66, -0.42], [-0.86, -0.64], [-1.02, -0.84], // thumb
  [-0.3, -0.95], [-0.36, -1.35], [-0.4, -1.6], [-0.43, -1.82], // index
  [0, -1], [0, -1.45], [0, -1.73], [0, -1.97], // middle
  [0.27, -0.94], [0.32, -1.35], [0.35, -1.6], [0.37, -1.82], // ring
  [0.52, -0.82], [0.62, -1.12], [0.68, -1.32], [0.73, -1.5], // pinky
];
/** Same hand as a closed fist (tips folded onto the palm). */
const FIST = TEMPLATE.map((p, i) => {
  if (i === 0 || [1, 5, 9, 13, 17].includes(i)) return p;
  const finger = Math.floor((i - 1) / 4);
  const k = (i - 1) % 4; // 0 = knuckle … 3 = tip
  const mcp = TEMPLATE[finger * 4 + 1];
  if (finger === 0) return [mcp[0] * (1 - k * 0.1) + 0.12 * k, mcp[1] - 0.12 * k];
  // fold down towards the palm centre
  return [mcp[0] * 0.95, mcp[1] + [0, -0.25, 0.05, 0.3][k]];
});

export class MouseHand {
  constructor(el) {
    this.x = 0.65;
    this.y = 0.5;
    this.scale = 0.16; // hand size on screen (height units) → timbre
    this.down = false;
    this.fist = false;
    this.pinchAmt = 0;
    this.fistAmt = 0;
    this.aspect = 16 / 9;
    this.active = false;
    this._onMove = (e) => {
      // map from window to the "cover"-fitted video frame (inverse of visuals)
      const p = this.mapFn ? this.mapFn(e.clientX, e.clientY) : { x: e.clientX / innerWidth, y: e.clientY / innerHeight };
      this.x = p.x;
      this.y = p.y;
    };
    this._onDown = () => (this.down = true);
    this._onUp = () => (this.down = false);
    this._onWheel = (e) => {
      this.scale = Math.max(0.08, Math.min(0.32, this.scale * Math.exp(-e.deltaY * 0.0012)));
    };
    this.el = el;
  }

  enable() {
    if (this.active) return;
    this.active = true;
    this.el.addEventListener('pointermove', this._onMove);
    this.el.addEventListener('pointerdown', this._onDown);
    addEventListener('pointerup', this._onUp);
    this.el.addEventListener('wheel', this._onWheel, { passive: true });
  }

  disable() {
    this.active = false;
    this.el.removeEventListener('pointermove', this._onMove);
    this.el.removeEventListener('pointerdown', this._onDown);
    removeEventListener('pointerup', this._onUp);
    this.el.removeEventListener('wheel', this._onWheel);
  }

  /** Build a HandLandmarker-like result for time t (seconds). Already mirrored. */
  result(t) {
    // frame-rate independent easing of the gesture poses
    const dt = Math.min(0.1, Math.max(0.001, t - (this._t ?? t - 1 / 60)));
    this._t = t;
    this.pinchAmt += ((this.down ? 1 : 0) - this.pinchAmt) * (1 - Math.exp(-dt * 55));
    this.fistAmt += ((this.fist ? 1 : 0) - this.fistAmt) * (1 - Math.exp(-dt * 22));
    const s = this.scale;
    // palm centre ≈ 0.55 units above the wrist; anchor the pointer on the palm
    const wx = this.x;
    const wy = this.y + 0.55 * s;
    const lm = [];
    const world = [];
    for (let i = 0; i < 21; i++) {
      let [px, py] = TEMPLATE[i];
      const [fx, fy] = FIST[i];
      px += (fx - px) * this.fistAmt;
      py += (fy - py) * this.fistAmt;
      // pinch: thumb tip and index tip meet in between
      if (i === 4 || i === 8 || i === 3 || i === 7) {
        const mx = (TEMPLATE[4][0] + TEMPLATE[8][0]) / 2 + 0.05;
        const my = (TEMPLATE[4][1] + TEMPLATE[8][1]) / 2 + 0.25;
        const w = i === 3 || i === 7 ? 0.5 : 1;
        px += (mx - px) * this.pinchAmt * w;
        py += (my - py) * this.pinchAmt * w;
      }
      // breathing micro-motion so the hand feels alive
      const wob = 0.02 * Math.sin(t * 1.3 + i * 0.7);
      px += wob;
      py += wob * 0.5;
      lm.push({ x: wx + (px * s) / this.aspect, y: wy + py * s, z: 0 });
      world.push({ x: px * 0.09, y: py * 0.09, z: 0 });
    }
    return { landmarks: [lm], worldLandmarks: [world], handedness: [[{ categoryName: 'Mouse', score: 1 }]], mouse: true };
  }
}
