/**
 * AETHER audio engine — plain Web Audio, no library.
 *
 * Design goals
 *  - lowest possible latency: AudioContext({latencyHint:'interactive'}); every
 *    tracking frame writes parameters straight to AudioParams.
 *  - no clicks / pops: oscillators run forever, everything is gated with
 *    setTargetAtTime ramps; one-shot nodes always start and end at gain 0.
 *  - palette: sines with subtle FM, a sub an octave down, precise clicks,
 *    short gated noise, dark delay, small dark room, master limiter.
 *
 * Signal flow
 *
 *   lead FM voice ─┐
 *   sub (f/2) ─────┤→ leadGate → leadPan ─┐
 *   pad (drone) ───┘                      │
 *   voice 2 (harmony) → v2Gate → v2Pan ───┼→ toneFilter (LP) → toneVol → dryBus
 *   air noise (drone mode) ───────────────┘
 *
 *   dryBus, percBus, droneBus → master → limiter → softclip → out → speakers
 *                                 ├→ delay (dark feedback loop) → master
 *                                 └→ reverb (generated dark IR) → master
 *   scope analyser taps dryBus + percBus + droneBus for the visuals.
 */

import { euclid } from './pulse.js';

// ---------------------------------------------------------------- helpers

function tanhCurve(n = 4096, k = 1.6) {
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

/** 4-bit staircase used for the clap glitch. */
function crushCurve(n = 4096, steps = 12) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * steps) / steps;
  }
  return c;
}

function noiseBuffer(ctx, seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** Small, dark stereo room: decaying low-passed noise with a little predelay. */
function roomImpulse(ctx, seconds = 1.7, decay = 3.0) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const pre = Math.floor(sr * 0.012);
  const b = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      // the cutoff of the one-pole falls over time → the tail darkens
      const a = 0.55 - 0.45 * t;
      lp += a * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.pow(1 - t, decay) * (ch ? 0.95 : 1);
    }
  }
  return b;
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---------------------------------------------------------------- voices

/**
 * Sine carrier with a sine modulator. A single ConstantSource carries the
 * frequency so carrier, modulator ratio and FM depth stay locked together
 * at audio rate during glides (deviation = index · f).
 * A parallel tanh path adds "grit" which is crossfaded in.
 */
class FMVoice {
  constructor(ctx, curve) {
    this.ctx = ctx;
    this.freq = new ConstantSourceNode(ctx, { offset: 110 });
    this.car = new OscillatorNode(ctx, { type: 'sine', frequency: 0 });
    this.mod = new OscillatorNode(ctx, { type: 'sine', frequency: 0 });
    this.ratio = new GainNode(ctx, { gain: 1 });
    this.index = new GainNode(ctx, { gain: 0.04 });
    this.modAmp = new GainNode(ctx, { gain: 0 });

    this.freq.connect(this.car.frequency);
    this.freq.connect(this.ratio).connect(this.mod.frequency);
    this.freq.connect(this.index).connect(this.modAmp.gain);
    this.mod.connect(this.modAmp).connect(this.car.frequency);

    this.clean = new GainNode(ctx, { gain: 1 });
    this.drive = new GainNode(ctx, { gain: 2 });
    this.shaper = new WaveShaperNode(ctx, { curve, oversample: '2x' });
    this.grit = new GainNode(ctx, { gain: 0 });
    this.out = new GainNode(ctx, { gain: 1 });
    this.car.connect(this.clean).connect(this.out);
    this.car.connect(this.drive).connect(this.shaper).connect(this.grit).connect(this.out);

    this.freq.start();
    this.car.start();
    this.mod.start();
  }

  /** timbre 0 → pure sine, 1 → FM + saturated grit (still restrained). */
  setTimbre(t, now, tau = 0.04) {
    t = clamp(t, 0, 1);
    this.index.gain.setTargetAtTime(0.04 + t * t * 1.6, now, tau);
    this.grit.gain.setTargetAtTime(t * t * 0.45, now, tau);
    this.clean.gain.setTargetAtTime(1 - t * t * 0.4, now, tau);
    this.drive.gain.setTargetAtTime(1.2 + t * 3.5, now, tau);
  }
}

/**
 * A frozen tone: two detuned sines + sub + faint octave, slow FM drift,
 * slow amplitude breathing. Fades in, keeps playing until released.
 */
class DroneLayer {
  constructor(engine, freq, timbre, pan) {
    const ctx = engine.ctx;
    this.ctx = ctx;
    this.freq = freq;
    this.born = ctx.currentTime;
    const now = ctx.currentTime;
    this.out = new GainNode(ctx, { gain: 0 }); // envelope
    this.body = new GainNode(ctx, { gain: 1 }); // breathing (LFO-modulated)
    this.pan = new StereoPannerNode(ctx, { pan });
    this.out.connect(this.body).connect(this.pan).connect(engine.droneBus);

    const parts = [
      [1, 0.5],
      [Math.pow(2, 7 / 1200), 0.32], // +7 cents → slow beating
      [0.5, 0.42],
      [2, 0.05 + timbre * 0.08],
    ];
    this.nodes = [];
    for (const [ratio, amp] of parts) {
      const o = new OscillatorNode(ctx, { type: 'sine', frequency: freq * ratio });
      const g = new GainNode(ctx, { gain: amp });
      o.connect(g).connect(this.out);
      o.start(now);
      this.nodes.push(o, g);
    }
    // slow FM drift on the main partial
    const mod = new OscillatorNode(ctx, { type: 'sine', frequency: freq });
    const modAmp = new GainNode(ctx, { gain: freq * (0.05 + timbre * 0.5) });
    const lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 0.05 + Math.random() * 0.07 });
    const lfoAmp = new GainNode(ctx, { gain: freq * (0.04 + timbre * 0.3) });
    lfo.connect(lfoAmp).connect(modAmp.gain);
    mod.connect(modAmp).connect(this.nodes[0].frequency);
    // amplitude breathing
    const breath = new OscillatorNode(ctx, { type: 'sine', frequency: 0.08 + Math.random() * 0.06 });
    const breathAmp = new GainNode(ctx, { gain: 0.12 });
    breath.connect(breathAmp).connect(this.body.gain);
    mod.start(now);
    lfo.start(now);
    breath.start(now);
    this.nodes.push(mod, modAmp, lfo, lfoAmp, breath, breathAmp);

    this.level = 0.3;
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.setTargetAtTime(this.level, now, 0.6);
    this.released = false;
  }

  release(time = 2.5) {
    if (this.released) return;
    this.released = true;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.setTargetAtTime(0, now, time / 4);
    for (const n of this.nodes) if (n.stop) n.stop(now + time + 0.5);
    setTimeout(() => {
      for (const n of this.nodes) n.disconnect();
      this.out.disconnect();
      this.body.disconnect();
      this.pan.disconnect();
    }, (time + 1) * 1000);
  }
}

// ---------------------------------------------------------------- engine

export const MODES = ['theremin', 'pulse', 'drone'];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.mode = 'theremin';
    this.drones = [];
    this.maxDrones = 3;
    this.events = []; // scheduled visual events {time, type, ...}
    this.leadHz = 110;
    this.leadOn = false;
    this.level = 0; // RMS of the scope bus (for visuals)
    // pulse sequencer state
    this.seq = { bpm: 124, step: 0, nextTime: 0, timer: null, density: 0.4, variant: 0, pitchHz: 110, timbre: 0, grid: [] };
  }

  /** Must be called from a user gesture (click / key). */
  async init() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    if (ctx.state !== 'running') await ctx.resume();
    const now = ctx.currentTime;
    const curve = tanhCurve();
    this.noise = noiseBuffer(ctx, 2);

    // ---------------- master chain
    this.master = new GainNode(ctx, { gain: 0.56 });
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -5, knee: 2, ratio: 20, attack: 0.002, release: 0.15 });
    this.softclip = new WaveShaperNode(ctx, { curve: tanhCurve(4096, 1.1), oversample: '4x' });
    this.out = new GainNode(ctx, { gain: 0.92 });
    this.master.connect(this.limiter).connect(this.softclip).connect(this.out).connect(ctx.destination);
    // stream for the recorder
    this.recDest = ctx.createMediaStreamDestination();
    this.out.connect(this.recDest);

    // ---------------- effects: dark delay + small room
    this.delay = new DelayNode(ctx, { delayTime: 0.36, maxDelayTime: 2 });
    this.delayLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1500, Q: 0.4 });
    this.delayHP = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 140, Q: 0.5 });
    this.delayFb = new GainNode(ctx, { gain: 0.36 });
    this.delayOut = new GainNode(ctx, { gain: 0.32 });
    this.delaySend = new GainNode(ctx, { gain: 1 });
    this.delaySend.connect(this.delay);
    this.delay.connect(this.delayLP).connect(this.delayHP).connect(this.delayFb).connect(this.delay);
    this.delayHP.connect(this.delayOut).connect(this.master);

    this.reverb = new ConvolverNode(ctx, { buffer: roomImpulse(ctx) });
    this.reverbSend = new GainNode(ctx, { gain: 1 });
    this.reverbOut = new GainNode(ctx, { gain: 0.3 });
    this.reverbSend.connect(this.reverb).connect(this.reverbOut).connect(this.master);
    this.delayOut.connect(this.reverbSend);

    // ---------------- buses
    this.dryBus = new GainNode(ctx, { gain: 1 });
    this.percBus = new GainNode(ctx, { gain: 0.9 });
    this.droneBus = new GainNode(ctx, { gain: 0.9 });
    this.toneDelaySend = new GainNode(ctx, { gain: 0.22 });
    this.toneVerbSend = new GainNode(ctx, { gain: 0.35 });
    this.dryBus.connect(this.master);
    this.dryBus.connect(this.toneDelaySend).connect(this.delaySend);
    this.dryBus.connect(this.toneVerbSend).connect(this.reverbSend);
    this.percBus.connect(this.master);
    this.percDelaySend = new GainNode(ctx, { gain: 0.3 });
    this.percBus.connect(this.percDelaySend).connect(this.delaySend);
    this.percBus.connect(new GainNode(ctx, { gain: 0.25 })).connect(this.reverbSend);
    this.droneBus.connect(this.master);
    this.droneBus.connect(new GainNode(ctx, { gain: 0.6 })).connect(this.reverbSend);
    this.droneBus.connect(new GainNode(ctx, { gain: 0.12 })).connect(this.delaySend);

    // scope (visuals)
    this.scope = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 });
    for (const b of [this.dryBus, this.percBus, this.droneBus]) b.connect(this.scope);
    const silent = new GainNode(ctx, { gain: 0 });
    this.scope.connect(silent).connect(ctx.destination);
    this.scopeData = new Float32Array(this.scope.fftSize);

    // ---------------- tone section
    this.toneFilter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3000, Q: 0.9 });
    this.toneVol = new GainNode(ctx, { gain: 0 });
    this.toneFilter.connect(this.toneVol).connect(this.dryBus);

    this.lead = new FMVoice(ctx, curve);
    this.leadGate = new GainNode(ctx, { gain: 0 });
    this.leadPan = new StereoPannerNode(ctx, { pan: 0 });
    this.lead.out.connect(this.leadGate);
    this.leadGate.connect(this.leadPan).connect(this.toneFilter);

    // sub an octave below, locked to the lead frequency signal
    this.sub = new OscillatorNode(ctx, { type: 'sine', frequency: 0 });
    this.subHalf = new GainNode(ctx, { gain: 0.5 });
    this.subAmp = new GainNode(ctx, { gain: 0.5 });
    this.lead.freq.connect(this.subHalf).connect(this.sub.frequency);
    this.sub.connect(this.subAmp).connect(this.leadGate);
    this.sub.start(now);

    // pad partials (only audible in DRONE mode)
    this.pad = new GainNode(ctx, { gain: 0 });
    this.pad.connect(this.leadGate);
    this.padNodes = [];
    for (const [ratio, amp] of [[Math.pow(2, 9 / 1200), 0.45], [Math.pow(2, -11 / 1200), 0.45], [1.5, 0.12], [2, 0.16], [3, 0.04]]) {
      const o = new OscillatorNode(ctx, { type: 'sine', frequency: 0 });
      const r = new GainNode(ctx, { gain: ratio });
      const g = new GainNode(ctx, { gain: amp });
      this.lead.freq.connect(r).connect(o.frequency);
      o.connect(g).connect(this.pad);
      o.start(now);
      this.padNodes.push(o);
    }

    // second voice (harmony)
    this.voice2 = new FMVoice(ctx, curve);
    this.v2Gate = new GainNode(ctx, { gain: 0 });
    this.v2Pan = new StereoPannerNode(ctx, { pan: -0.35 });
    this.voice2.out.connect(this.v2Gate).connect(this.v2Pan).connect(this.toneFilter);

    // air: band-passed noise breathing with movement (DRONE mode)
    this.air = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true });
    this.airBP = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 600, Q: 3 });
    this.airAmp = new GainNode(ctx, { gain: 0 });
    this.air.connect(this.airBP).connect(this.airAmp).connect(this.toneFilter);
    this.air.start(now);

    this.ready = true;
    this.setMode(this.mode);
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // ------------------------------------------------------------ modes

  setMode(mode) {
    this.mode = mode;
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const P = {
      theremin: { delay: 0.36, fb: 0.36, dOut: 0.3, verb: 0.3, pad: 0, sub: 0.5 },
      pulse: { delay: (60 / this.seq.bpm) * 0.75, fb: 0.3, dOut: 0.26, verb: 0.22, pad: 0, sub: 0.5 },
      drone: { delay: 0.9, fb: 0.55, dOut: 0.38, verb: 0.7, pad: 1, sub: 0.7 },
    }[mode];
    this.delay.delayTime.setTargetAtTime(P.delay, now, 0.3);
    this.delayFb.gain.setTargetAtTime(P.fb, now, 0.3);
    this.delayOut.gain.setTargetAtTime(P.dOut, now, 0.3);
    this.reverbOut.gain.setTargetAtTime(P.verb, now, 0.5);
    this.pad.gain.setTargetAtTime(P.pad, now, 0.8);
    this.subAmp.gain.setTargetAtTime(P.sub, now, 0.5);
    if (mode !== 'drone') this.airAmp.gain.setTargetAtTime(0, now, 0.3);
    if (mode === 'pulse') this.startSequencer();
    else this.stopSequencer();
  }

  // ------------------------------------------------------------ continuous control

  /**
   * Called on every tracking frame.
   * c = { present, hz, timbre, volume, filter, pan, glide,
   *       v2: {on, hz}, motion }
   */
  update(c) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const drone = this.mode === 'drone';
    const pulse = this.mode === 'pulse';

    // ---- pitch
    const glide = drone ? Math.max(0.6, c.glide) : c.glide;
    if (c.present) {
      if (!this.leadOn) {
        // jump to the pitch silently when a hand appears — no glide from the old note
        this.lead.freq.offset.cancelScheduledValues(now);
        this.lead.freq.offset.setValueAtTime(c.hz, now);
      } else {
        this.lead.freq.offset.setTargetAtTime(c.hz, now, glide);
      }
      this.leadHz = c.hz;
    }
    this.lead.setTimbre(c.timbre, now, drone ? 0.5 : 0.04);

    // ---- gate: lead sustains in theremin/drone, silent in pulse (the sequencer plays)
    const gateOn = c.present && !pulse;
    this.leadGate.gain.setTargetAtTime(gateOn ? 0.55 : 0, now, gateOn ? (drone ? 0.5 : 0.05) : drone ? 1.8 : 0.12);
    this.leadOn = c.present;

    // ---- amplitude & colour (left hand)
    const vol = c.volume * c.volume; // perceptual
    this.toneVol.gain.setTargetAtTime(vol, now, drone ? 0.3 : 0.03);
    const cutoff = 160 * Math.pow(45, clamp(c.filter, 0, 1)); // 160 Hz … 7.2 kHz
    this.toneFilter.frequency.setTargetAtTime(cutoff, now, drone ? 0.4 : 0.04);
    this.leadPan.pan.setTargetAtTime(clamp(c.pan, -1, 1) * 0.4, now, 0.08);

    // ---- second voice
    const v2On = c.present && c.v2 && c.v2.on && !pulse;
    if (v2On) {
      if (this.v2Gate.gain.value < 0.01) {
        this.voice2.freq.offset.cancelScheduledValues(now);
        this.voice2.freq.offset.setValueAtTime(c.v2.hz, now);
      } else {
        this.voice2.freq.offset.setTargetAtTime(c.v2.hz, now, Math.max(glide, 0.06));
      }
      this.voice2.setTimbre(c.timbre * 0.6, now, 0.06);
    }
    this.v2Gate.gain.setTargetAtTime(v2On ? 0.3 : 0, now, drone ? 0.8 : 0.12);

    // ---- air (drone mode): band-passed noise follows movement
    if (drone) {
      this.airBP.frequency.setTargetAtTime(clamp(c.hz * 4, 200, 4000), now, 0.5);
      this.airAmp.gain.setTargetAtTime(c.present ? clamp(c.motion * 0.25, 0, 0.12) : 0, now, 0.4);
    }

    // ---- sequencer parameters
    this.seq.density = c.density ?? this.seq.density;
    this.seq.pitchHz = c.pulseHz ?? this.seq.pitchHz;
    this.seq.timbre = c.timbre;
    this.seq.active = c.present;
    this.seq.volume = c.volume;
  }

  // ------------------------------------------------------------ one-shots

  /** Precise click at a pitch: a 1-2 ms transient + a very short sine tick. */
  click(hz, pan = 0, vel = 1, time = null) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = time ?? ctx.currentTime + 0.003;
    const p = new StereoPannerNode(ctx, { pan: clamp(pan, -1, 1) });
    p.connect(this.percBus);

    // transient
    const n = new AudioBufferSourceNode(ctx, { buffer: this.noise, playbackRate: 1 });
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 2500 });
    const ng = new GainNode(ctx, { gain: 0 });
    n.connect(hp).connect(ng).connect(p);
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.5 * vel, t + 0.0004);
    ng.gain.exponentialRampToValueAtTime(0.0005, t + 0.006);
    n.start(t, Math.random() * 1.5, 0.02);

    // pitched tick: fundamental + a high partial, very short
    const f = clamp(hz, 40, 1200);
    for (const [mult, amp, dur] of [[2, 0.55, 0.045], [8, 0.18, 0.012]]) {
      const o = new OscillatorNode(ctx, { type: 'sine', frequency: Math.min(f * mult, 9000) });
      const g = new GainNode(ctx, { gain: 0 });
      o.connect(g).connect(p);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * vel, t + 0.0008);
      g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    setTimeout(() => p.disconnect(), 400 + (t - ctx.currentTime) * 1000);
    this.events.push({ time: t, type: 'click', hz });
  }

  /** Short sine blip for the pulse pattern. */
  blip(hz, time, len = 0.05, vel = 0.6, grit = 0) {
    const ctx = this.ctx;
    const o = new OscillatorNode(ctx, { type: grit > 0.55 ? 'triangle' : 'sine', frequency: hz });
    const g = new GainNode(ctx, { gain: 0 });
    o.connect(g).connect(this.percBus);
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(vel, time + 0.002);
    g.gain.setValueAtTime(vel, time + len * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0005, time + len);
    o.start(time);
    o.stop(time + len + 0.02);
  }

  /** Short sine kick: pitch drop 95 → 38 Hz. */
  subKick(time, vel = 1) {
    const ctx = this.ctx;
    const o = new OscillatorNode(ctx, { type: 'sine', frequency: 95 });
    const g = new GainNode(ctx, { gain: 0 });
    o.connect(g).connect(this.percBus);
    o.frequency.setValueAtTime(95, time);
    o.frequency.exponentialRampToValueAtTime(38, time + 0.11);
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.9 * vel, time + 0.003);
    g.gain.setTargetAtTime(0, time + 0.03, 0.09);
    o.start(time);
    o.stop(time + 0.6);
  }

  /** Rectangular-gated high noise burst (1 ms edges). */
  noiseHit(time, len = 0.03, vel = 0.3, freq = 7000) {
    const ctx = this.ctx;
    const n = new AudioBufferSourceNode(ctx, { buffer: this.noise });
    const f = new BiquadFilterNode(ctx, { type: 'highpass', frequency: freq });
    const g = new GainNode(ctx, { gain: 0 });
    n.connect(f).connect(g).connect(this.percBus);
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(vel, time + 0.001);
    g.gain.setValueAtTime(vel, time + len);
    g.gain.linearRampToValueAtTime(0, time + len + 0.001);
    n.start(time, Math.random() * 1.5, len + 0.01);
  }

  /** Clap: white glitch (stuttered crushed noise) + big sub drop + duck. */
  clap() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.003;

    // glitch: gated noise bursts through a bit-crusher-ish staircase
    const crush = new WaveShaperNode(ctx, { curve: crushCurve() });
    const glitchOut = new GainNode(ctx, { gain: 0.5 });
    crush.connect(glitchOut).connect(this.percBus);
    const gates = [0, 0.03, 0.05, 0.095, 0.11, 0.16, 0.2, 0.27];
    gates.forEach((dt, i) => {
      const len = 0.006 + Math.random() * 0.02;
      const v = 0.7 * (1 - i / gates.length);
      this.noiseHit(t + dt, len, v * 0.45, 1500 + Math.random() * 5000);
      // crushed tone burst, tied to the lead pitch
      const o = new OscillatorNode(ctx, { type: 'square', frequency: this.leadHz * (i % 2 ? 4 : 8) });
      const g = new GainNode(ctx, { gain: 0 });
      o.connect(g).connect(crush);
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(v * 0.25, t + dt + 0.001);
      g.gain.setValueAtTime(v * 0.25, t + dt + len);
      g.gain.linearRampToValueAtTime(0, t + dt + len + 0.001);
      o.start(t + dt);
      o.stop(t + dt + len + 0.01);
    });

    // sub drop
    const o = new OscillatorNode(ctx, { type: 'sine', frequency: 120 });
    const o2 = new OscillatorNode(ctx, { type: 'sine', frequency: 60 });
    const g = new GainNode(ctx, { gain: 0 });
    o.connect(g);
    o2.connect(new GainNode(ctx, { gain: 0.5 })).connect(g);
    g.connect(this.percBus);
    g.connect(this.reverbSend);
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(27, t + 1.8);
    o2.frequency.setValueAtTime(60, t);
    o2.frequency.exponentialRampToValueAtTime(30, t + 1.4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.0, t + 0.006);
    g.gain.setTargetAtTime(0, t + 0.25, 0.7);
    o.start(t);
    o2.start(t);
    o.stop(t + 4.5);
    o2.stop(t + 4.5);
    setTimeout(() => { crush.disconnect(); glitchOut.disconnect(); g.disconnect(); }, 5200);

    // duck the tone for impact
    const d = this.dryBus.gain;
    d.cancelScheduledValues(t);
    d.setValueAtTime(d.value, t);
    d.linearRampToValueAtTime(0.12, t + 0.01);
    d.setTargetAtTime(1, t + 0.25, 0.25);
    this.events.push({ time: t, type: 'clap' });
  }

  /** First appearance of the hands: a deep sub swell rising out of nothing. */
  swell(amount = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const g = new GainNode(ctx, { gain: 0 });
    g.connect(this.droneBus);
    g.connect(this.reverbSend);
    const fs = [[27.5, 55, 0.9], [41.2, 82.4, 0.35], [55, 110, 0.18]];
    const oscs = fs.map(([a, b, amp]) => {
      const o = new OscillatorNode(ctx, { type: 'sine', frequency: a });
      o.frequency.setValueAtTime(a, t);
      o.frequency.exponentialRampToValueAtTime(b, t + 2.6);
      o.connect(new GainNode(ctx, { gain: amp })).connect(g);
      o.start(t);
      o.stop(t + 7);
      return o;
    });
    // rising band of filtered noise
    const n = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true });
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 120, Q: 4 });
    const ng = new GainNode(ctx, { gain: 0.05 });
    lp.frequency.setValueAtTime(120, t);
    lp.frequency.exponentialRampToValueAtTime(2400, t + 2.6);
    lp.frequency.exponentialRampToValueAtTime(200, t + 6);
    n.connect(lp).connect(ng).connect(g);
    n.start(t);
    n.stop(t + 7);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.85 * amount, t + 2.4);
    g.gain.setTargetAtTime(0, t + 2.6, 1.1);
    setTimeout(() => g.disconnect(), 7600);
    void oscs;
  }

  /** Freeze a tone into a drone layer (max 3, oldest is released). */
  freeze(hz, timbre, pan = 0) {
    if (!this.ready) return null;
    if (this.drones.length >= this.maxDrones) this.drones.shift().release(3);
    const layer = new DroneLayer(this, hz, timbre, pan);
    this.drones.push(layer);
    // soft "lock" transient
    this.click(hz, pan, 0.35);
    return layer;
  }

  clearDrones() {
    for (const d of this.drones) d.release(2.2);
    this.drones = [];
  }

  // ------------------------------------------------------------ pulse sequencer

  startSequencer() {
    if (this.seq.timer || !this.ready) return;
    this.seq.nextTime = this.ctx.currentTime + 0.06;
    this.seq.step = 0;
    this.seq.timer = setInterval(() => this.schedule(), 20);
  }

  stopSequencer() {
    clearInterval(this.seq.timer);
    this.seq.timer = null;
  }

  nextPattern() {
    this.seq.variant = (this.seq.variant + 1) % 6;
  }

  /** Current 16-step pattern lanes for a density + variant. */
  pattern(density = this.seq.density, variant = this.seq.variant) {
    const d = clamp(density, 0, 1);
    const V = [
      [0, 2, 3], [3, 0, 7], [1, 4, 2], [5, 2, 11], [2, 6, 5], [7, 3, 9],
    ][variant];
    const clicks = euclid(Math.round(2 + d * 12), 16, V[0]);
    const subs = euclid(Math.round(1 + d * 4), 16, 0);
    const noise = euclid(Math.round(d * d * 11), 16, V[2]);
    const accents = euclid(3 + (variant % 3), 16, V[1]);
    return { clicks, subs, noise, accents, ratchet: d > 0.82 };
  }

  schedule() {
    const s = this.seq;
    const ctx = this.ctx;
    const stepDur = 60 / s.bpm / 4;
    while (s.nextTime < ctx.currentTime + 0.1) {
      const i = s.step;
      const t = s.nextTime;
      const pat = this.pattern();
      s.grid = pat;
      if (s.active) {
        const vol = 0.25 + 0.75 * (s.volume ?? 0.7);
        const accent = pat.accents[i];
        if (pat.subs[i]) this.subKick(t, vol * (i === 0 ? 1 : 0.75));
        if (pat.clicks[i]) {
          // pitch pattern: accented steps an octave up, variant shifts a fifth
          const mult = accent ? 2 : (s.variant % 2 && i % 4 === 2 ? 1.5 : 1);
          const hz = clamp(s.pitchHz * mult, 40, 1400);
          const len = 0.018 + s.timbre * 0.09;
          this.blip(hz, t, len, (accent ? 0.5 : 0.32) * vol, s.timbre);
          this.click(hz, (i % 2 ? 0.3 : -0.3), 0.35 * vol, t);
          if (pat.ratchet && i % 4 === 3) this.click(hz * 2, 0, 0.25 * vol, t + stepDur / 2);
        }
        if (pat.noise[i]) this.noiseHit(t, 0.012 + (accent ? 0.03 : 0), 0.14 * vol, accent ? 4000 : 8000);
        this.events.push({ time: t, type: 'step', step: i, sub: !!pat.subs[i], hit: !!pat.clicks[i] });
      } else {
        this.events.push({ time: t, type: 'step', step: i, sub: false, hit: false });
      }
      s.nextTime += stepDur;
      s.step = (i + 1) % 16;
    }
  }

  // ------------------------------------------------------------ analysis for visuals

  /** Fills and returns the scope buffer (time domain, −1..1). Also updates `level`. */
  waveform() {
    if (!this.ready) return null;
    this.scope.getFloatTimeDomainData(this.scopeData);
    let s = 0;
    const d = this.scopeData;
    for (let i = 0; i < d.length; i += 4) s += d[i] * d[i];
    const rms = Math.sqrt(s / (d.length / 4));
    this.level += (rms - this.level) * 0.3;
    return d;
  }

  /** Visual events whose time has come. */
  drainEvents() {
    if (!this.ready || !this.events.length) return [];
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0) * 0.5;
    const due = [];
    const keep = [];
    for (const e of this.events) (e.time <= now ? due : keep).push(e);
    this.events = keep;
    return due;
  }
}
