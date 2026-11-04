/**
 * AETHER — webcam theremin.
 *
 * main.js wires everything together:
 *   input (camera / mouse) → HandProcessor (filter + features) → Gestures
 *     → control mapping → AudioEngine          (immediately, per tracking frame)
 *     → Visuals + HUD                          (every animation frame)
 */

import { AudioEngine } from './audio.js';
import { HandProcessor } from './hands.js';
import { Gestures } from './gestures.js';
import { CameraTracker, MouseHand } from './tracker.js';
import { Hud } from './hud.js';
import { SCALES, INTERVALS, Quantizer, midiToHz } from './music.js';

const $ = (s) => document.querySelector(s);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ------------------------------------------------------------------ state

// glide time constants (s): `scale` between quantised notes, `free` in continuous mode
const GLIDES = [
  { label: 'TIGHT', scale: 0.015, free: 0.01 },
  { label: 'SOFT', scale: 0.06, free: 0.02 },
  { label: 'SLOW', scale: 0.16, free: 0.06 },
  { label: 'LONG', scale: 0.42, free: 0.16 },
];

const RANGES = {
  theremin: [33, 81], // A1 55 Hz … A5 880 Hz
  pulse: [40, 76], // pulse pitch is played with the x position
  drone: [33, 57], // A1 … A3
};

const app = {
  started: false,
  mode: 'theremin',
  scaleIdx: 0,
  glideIdx: 1,
  camLevel: 1, // 0 off, 1 almost invisible, 2 dim
  inputMode: 'none', // 'camera' | 'mouse'
  cameraOk: false,
  everSeen: false,
  lastSeen: -10,
  // latest control values (for HUD / visuals)
  ctl: { present: false, hz: 110, timbre: 0, volume: 0.7, filter: 0.72, pan: 0, cutoff: 3000, v2: null, motion: 0 },
  history: [], // recent {t, hz, timbre} of the lead, to freeze the pre-fist tone
  layers: [], // frozen drone frequencies (mirror of audio.drones)
  pitchMidi: 45,
  fps: 60,
  hands: { left: null, right: null },
  clearProgress: 0,
  step: 0,
};

const audio = new AudioEngine();
const processor = new HandProcessor();
const gestures = new Gestures();
const quant = new Quantizer();
const pulseQuant = new Quantizer();
const video = $('#video');
const tracker = new CameraTracker(video);
const stage = $('#stage');
const hud = new Hud($('#hud'));
const mouse = new MouseHand(stage);
let visuals = null; // WebGL visuals, loaded lazily (see boot)
let recorder = null;

window.AETHER = { app, audio, processor, gestures, MouseHand }; // for debugging in the console

// ------------------------------------------------------------------ geometry

/** "cover" fit of the video frame into the window; returns css-px mapping. */
function coverFit() {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const W = innerWidth;
  const H = innerHeight;
  const s = Math.max(W / vw, H / vh);
  const dw = vw * s;
  const dh = vh * s;
  return { ox: (W - dw) / 2, oy: (H - dh) / 2, dw, dh };
}
let fit = coverFit();
const toScreen = (x, y) => ({ x: fit.ox + x * fit.dw, y: fit.oy + y * fit.dh });
const fromScreen = (px, py) => ({ x: (px - fit.ox) / fit.dw, y: (py - fit.oy) / fit.dh });
mouse.mapFn = fromScreen;

function resize() {
  fit = coverFit();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  hud.resize(innerWidth, innerHeight, dpr);
  visuals?.resize(innerWidth, innerHeight);
  processor.aspect = (video.videoWidth || 1280) / (video.videoHeight || 720);
  mouse.aspect = processor.aspect;
}
addEventListener('resize', resize);

// ------------------------------------------------------------------ control mapping

/** Hands → sound parameters. Runs on every tracking frame. */
function mapControls(hands, t) {
  const R = hands.right;
  const L = hands.left;
  const c = app.ctl;
  const mode = app.mode;
  const steps = SCALES[app.scaleIdx].steps;
  const [lo, hi] = RANGES[mode];
  c.present = !!R;

  if (R) {
    // height → pitch: bottom of frame = low, top = high (log-frequency)
    const h = clamp01((0.88 - R.palm.y) / 0.72);
    c.height = h;
    // distance to camera (apparent size) → timbre
    c.timbre = clamp01((R.size - 0.11) / 0.17);
    c.pan = (R.palm.x - 0.5) * 2;
    if (mode === 'pulse') {
      // PULSE: height = density, x = pitch of the blips (always on a scale)
      c.density = h;
      const pm = RANGES.pulse[0] + clamp01((R.palm.x - 0.35) / 0.6) * (RANGES.pulse[1] - RANGES.pulse[0]);
      c.pulseHz = midiToHz(pulseQuant.quantize(pm, steps || SCALES[1].steps));
      c.hz = c.pulseHz;
    } else {
      const midi = lo + h * (hi - lo);
      const q = quant.quantize(midi, steps);
      c.hz = midiToHz(q);
    }
    app.history.push({ t, hz: c.hz, timbre: c.timbre, pan: c.pan });
    while (app.history.length && t - app.history[0].t > 0.6) app.history.shift();
  }

  // left hand: height → volume, x → filter (left = dark)
  if (L) {
    c.volume = clamp01((0.9 - L.palm.y) / 0.62);
    c.filter = clamp01((L.palm.x - 0.04) / 0.42);
  } else {
    // only one hand: gently return to a comfortable default
    c.volume += (0.72 - c.volume) * 0.05;
    c.filter += (0.72 - c.filter) * 0.05;
  }
  c.cutoff = 160 * Math.pow(45, c.filter);

  // two hands: distance → interval of the second voice (below the lead)
  if (L && R) {
    const d = Math.hypot((R.palm.x - L.palm.x) * processor.aspect, R.palm.y - L.palm.y);
    const k = Math.min(INTERVALS.length - 1, Math.floor(clamp01((d - 0.2) / 1.0) * INTERVALS.length));
    const iv = INTERVALS[k];
    const ratio = Math.pow(2, -iv.semi / 12) * (iv.semi === 0 ? 1.0035 : 1);
    c.v2 = { on: true, hz: c.hz * ratio, label: iv.label, k };
  } else {
    c.v2 = null;
  }

  // motion energy (drone "air", particles)
  const sp = (R ? R.speed : 0) + (L ? L.speed : 0);
  c.motion += (sp - c.motion) * 0.2;

  // glide: free mode stays tight (theremin), scale modes use the chosen glide
  const g = GLIDES[app.glideIdx];
  c.glide = steps || mode === 'pulse' ? g.scale : g.free;
  audio.update(c);
}

/** Tone of the lead ~200 ms ago — before the hand started closing into a fist. */
function preGestureTone(t) {
  const h = app.history;
  if (!h.length) return null;
  let best = h[h.length - 1];
  for (const e of h) if (t - e.t >= 0.2) best = e;
  return best;
}

// ------------------------------------------------------------------ events

function freeze(t) {
  const tone = preGestureTone(t) || (app.ctl.present ? { hz: app.ctl.hz, timbre: app.ctl.timbre, pan: app.ctl.pan } : null);
  if (!tone) return;
  const layer = audio.freeze(tone.hz, tone.timbre, Math.max(-0.6, Math.min(0.6, tone.pan * 0.6)));
  if (layer) visuals?.onFreeze(tone.hz, tone.timbre);
  syncLayers();
}

function clearLayers() {
  if (!audio.drones.length) return;
  audio.clearDrones();
  visuals?.onClear();
  syncLayers();
}

function syncLayers() {
  app.layers = audio.drones.map((d) => d.freq);
}

function handleEvents(events, hands, t) {
  for (const e of events) {
    switch (e.type) {
      case 'pinch': {
        if (app.mode === 'pulse') {
          audio.nextPattern();
          audio.click(app.ctl.hz * 2, (e.x - 0.5) * 1.6, 0.4);
        } else {
          const hz = e.role === 'right' ? app.ctl.hz : app.ctl.hz / 2;
          audio.click(hz, (e.x - 0.5) * 1.6, 1);
        }
        visuals?.onPinch(e);
        break;
      }
      case 'fist':
        freeze(t);
        break;
      case 'clear':
        clearLayers();
        break;
      case 'clap':
        audio.clap();
        visuals?.onClap(e);
        break;
    }
  }
}

// ------------------------------------------------------------------ tracking frame

function onTrackingResult(res, t) {
  const mirrored = !res.mouse;
  const hands = processor.process(res, t, mirrored);
  app.hands = hands;
  const any = hands.left || hands.right;
  if (any) {
    if (!app.everSeen) {
      app.everSeen = true;
      audio.swell(1);
      visuals?.materialize(1);
      if (app.inputMode === 'camera') hint('');
    } else if (t - app.lastSeen > 4) {
      // hands come back after a while: smaller swell, faster materialisation
      audio.swell(0.35);
      visuals?.materialize(0.5);
    }
    app.lastSeen = t;
  }
  const events = gestures.update(hands, t);
  app.clearProgress = gestures.clearProgress;
  mapControls(hands, t);
  handleEvents(events, hands, t);
  visuals?.onHands(hands, t);
}

tracker.onResult = onTrackingResult;
window.AETHER.feed = onTrackingResult; // lets tests inject synthetic hands

// ------------------------------------------------------------------ render loop

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  app.fps += (1 / Math.max(dt, 1e-3) - app.fps) * 0.05;

  // the mouse hand is sampled at display rate
  if (app.inputMode === 'mouse') onTrackingResult(mouse.result(now / 1000), now / 1000);

  const vEvents = audio.drainEvents();
  for (const e of vEvents) if (e.type === 'step') app.step = e.step;
  const wave = audio.waveform();

  visuals?.render(dt, { wave, level: audio.level, ctl: app.ctl, mode: app.mode, events: vEvents, layers: app.layers });
  hud.draw(hudState(), toScreen);
  recorder?.frame();
  if (recorder?.recording) $('#rec').textContent = '● REC ' + recorder.elapsed();
}

function hudState() {
  const c = app.ctl;
  const steps = SCALES[app.scaleIdx].steps;
  return {
    started: app.started,
    mode: app.mode,
    scale: SCALES[app.scaleIdx].label,
    steps: app.mode === 'pulse' ? steps || SCALES[1].steps : steps,
    glide: GLIDES[app.glideIdx].label,
    input: app.inputMode === 'mouse' ? 'INPUT MOUSE' : app.cameraOk ? 'INPUT CAM' : 'INPUT --',
    hz: c.hz,
    sounding: c.present && c.volume > 0.02,
    timbre: c.timbre,
    volume: c.volume,
    cutoff: c.cutoff,
    v2: c.v2 && app.mode !== 'pulse' ? c.v2.label : null,
    hands: app.hands,
    layers: app.layers,
    range: RANGES[app.mode],
    trackFps: app.inputMode === 'mouse' ? app.fps : tracker.fps,
    detectMs: app.inputMode === 'mouse' ? 0 : tracker.detectMs,
    delegate: app.inputMode === 'mouse' ? 'MOUSE' : tracker.delegate || '---',
    fps: app.fps,
    clearProgress: app.clearProgress,
    grid: audio.seq.grid,
    step: app.step,
    density: audio.seq.density,
    variant: audio.seq.variant,
    bpm: audio.seq.bpm,
    recording: recorder?.recording,
    recTime: recorder?.elapsed(),
  };
}

// ------------------------------------------------------------------ UI

let hintTimer = 0;
function hint(text, sub = '', ms = 0) {
  $('#hint').textContent = text;
  $('#hint-sub').textContent = sub;
  $('#onboard').classList.toggle('hidden', !text && !sub);
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(() => hint(''), ms);
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1400);
}

function setMode(mode) {
  app.mode = mode;
  quant.reset();
  audio.setMode(mode);
  visuals?.setMode(mode);
  toast(mode.toUpperCase());
}

function setCamLevel(l) {
  app.camLevel = l;
  video.dataset.level = String(l);
  visuals?.setCamLevel(l);
}

/** Switch between camera and mouse input. Returns false if not possible. */
function setInput(mode) {
  if (mode === 'mouse') {
    app.inputMode = 'mouse';
    tracker.stop();
    mouse.enable();
    stage.classList.add('mouse');
  } else {
    if (!app.cameraOk || !tracker.landmarker) return false;
    app.inputMode = 'camera';
    mouse.disable();
    stage.classList.remove('mouse');
    tracker.start();
  }
  processor.slots.forEach((s) => (s.present = false));
  return true;
}

addEventListener('keydown', async (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!app.started) return start();
  const k = e.key.toLowerCase();
  if (k === '1') setMode('theremin');
  else if (k === '2') setMode('pulse');
  else if (k === '3') setMode('drone');
  else if (k === 's') {
    app.scaleIdx = (app.scaleIdx + 1) % SCALES.length;
    quant.reset();
    toast('SCALE ' + SCALES[app.scaleIdx].label);
  } else if (k === 'g') {
    app.glideIdx = (app.glideIdx + 1) % GLIDES.length;
    toast('GLIDE ' + GLIDES[app.glideIdx].label);
  } else if (k === 'c') {
    setCamLevel((app.camLevel + 1) % 3);
    toast('CAMERA ' + ['OFF', 'GHOST', 'DIM'][app.camLevel]);
  } else if (k === 'm') {
    const ok = setInput(app.inputMode === 'mouse' ? 'camera' : 'mouse');
    toast(ok ? 'INPUT ' + app.inputMode.toUpperCase() : 'NO CAMERA');
  } else if (k === 'h' || k === '?') {
    $('#help').classList.toggle('show');
  } else if (k === 'escape') {
    $('#help').classList.remove('show');
  } else if (k === 'r') {
    toggleRecording();
  } else if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  } else if (k === 'x' || k === 'backspace') {
    clearLayers();
  } else if (k === ' ') {
    e.preventDefault();
    if (app.inputMode === 'mouse') mouse.fist = true;
    else freeze(performance.now() / 1000);
  }
});
addEventListener('keyup', (e) => {
  if (e.key === ' ') mouse.fist = false;
});

async function toggleRecording() {
  if (!recorder) {
    try {
      const { Recorder } = await import('./recorder.js');
      recorder = new Recorder(visuals?.canvas || null, $('#hud'), audio);
    } catch (e) {
      console.warn(e);
      return toast('RECORDING UNAVAILABLE');
    }
  }
  const r = recorder.toggle();
  if (r) toast(r);
}

$('#help-close').addEventListener('click', () => $('#help').classList.remove('show'));

// ------------------------------------------------------------------ boot

async function loadVisuals() {
  try {
    const { Visuals } = await import('./visuals/visuals.js');
    visuals = new Visuals($('#gl'), video, toScreen);
    visuals.setMode(app.mode);
    visuals.setCamLevel(app.camLevel);
    hud.drawSkeleton = false;
  } catch (e) {
    console.warn('WebGL visuals unavailable, using 2D fallback', e);
    hud.drawSkeleton = true;
  }
  resize();
}

async function start() {
  if (app.started) return;
  app.started = true;
  $('#onboard').classList.add('started');
  await audio.init();
  hint('raise your hands');
  try {
    await tracker.startCamera();
    app.cameraOk = true;
    resize();
    setCamLevel(app.camLevel);
    hint('raise your hands', 'loading hand model');
    await tracker.loadModel();
    hint('raise your hands');
    if (app.inputMode !== 'mouse') setInput('camera');
  } catch (e) {
    console.warn('camera unavailable → mouse mode', e);
    app.cameraOk = !!tracker.stream;
    setInput('mouse');
    hint('no camera — mouse mode', 'move = pitch · click = pinch · scroll = timbre · space = freeze', 6000);
  }
}

$('#onboard').addEventListener('pointerdown', () => start());
stage.addEventListener('pointerdown', () => start());

resize();
loadVisuals();
requestAnimationFrame(frame);
