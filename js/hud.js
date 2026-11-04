/**
 * HUD: small, low-opacity data readouts in the spirit of Ryoji Ikeda —
 * frequency, note, coordinates, layers, a pitch ruler. Drawn on a 2D canvas
 * above the WebGL canvas (and composited into recordings).
 */

import { noteLabel, hzToMidi, scaleNotes } from './music.js';
import { BONES } from './hands.js';

const FONT = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const ACCENT = '150, 220, 255';

const f2 = (x, n = 3) => (x >= 0 ? ' ' : '') + x.toFixed(n);

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.dpr = 1;
    this.drawSkeleton = false; // simple 2D skeleton (used before WebGL visuals load)
  }

  resize(w, h, dpr) {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  text(s, x, y, a = 0.45, align = 'left', size = 10, color = '255,255,255') {
    const g = this.g;
    g.font = `${size}px ${FONT}`;
    g.textAlign = align;
    g.fillStyle = `rgba(${color},${a})`;
    g.fillText(s, x, y);
  }

  /**
   * @param {object} s snapshot of app state (see main.js `hudState`)
   * @param {(x:number,y:number)=>{x:number,y:number}} toScreen video → css px
   */
  draw(s, toScreen) {
    const g = this.g;
    const { w, h } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!s.started || s.fade < 0.01) return;
    g.globalAlpha = s.fade; // readouts fade out while playing (auto-hide)
    const m = 22; // margin
    const lh = 14;

    // ---- top-left: identity + modes
    this.text('AETHER', m, m + 8, 0.7, 'left', 11);
    this.text('// HAND-THEREMIN 0.1', m + 58, m + 8, 0.25);
    const modes = ['THEREMIN', 'PULSE', 'DRONE'];
    modes.forEach((name, i) => {
      const on = s.mode === ['theremin', 'pulse', 'drone'][i];
      this.text(`${i + 1} ${name}`, m + i * 84, m + 8 + lh * 1.6, on ? 0.75 : 0.22, 'left', 10, on ? ACCENT : '255,255,255');
    });
    this.text(`SCALE ${s.scale}   GLIDE ${s.glide}   ${s.input}`, m, m + 8 + lh * 2.8, 0.3);

    // ---- top-right: pitch readout
    const R = w - m;
    const midi = hzToMidi(s.hz);
    const nl = noteLabel(midi);
    this.text(`${s.hz.toFixed(2).padStart(7, ' ')} HZ`, R, m + 10, s.sounding ? 0.85 : 0.3, 'right', 15);
    this.text(`${nl.name.padEnd(3, ' ')} ${nl.cents.padStart(3, ' ')}c   MIDI ${midi.toFixed(2)}`, R, m + 10 + lh * 1.4, 0.45, 'right');
    this.text(`TIMBRE ${s.timbre.toFixed(3)}  VOL ${s.volume.toFixed(3)}  LPF ${(s.cutoff / 1000).toFixed(2)}k`, R, m + 10 + lh * 2.5, 0.3, 'right');
    this.text(`ENERGY ${s.energy.toFixed(2)}  STILL ${s.still.toFixed(2)}  SPACE ${s.space.toFixed(2)}`, R, m + 10 + lh * 3.6, 0.3, 'right');
    if (s.v2) this.text(`VOICE2 ${s.v2}`, R, m + 10 + lh * 4.7, 0.3, 'right');

    // ---- bottom-left: coordinates + layers
    let y = h - m - lh * 3;
    for (const role of ['right', 'left']) {
      const hd = s.hands[role];
      const tag = role === 'right' ? 'R' : 'L';
      if (hd) this.text(`${tag}  x${f2(hd.palm.x)}  y${f2(hd.palm.y)}  z${f2(hd.size)}  p${f2(hd.pinch, 2)}  c${f2(hd.curl, 2)}`, m, y, 0.38);
      else this.text(`${tag}  ----`, m, y, 0.18);
      y += lh;
    }
    let layers = 'LAYERS ';
    for (let i = 0; i < 3; i++) layers += i < s.layers.length ? '■ ' : '□ ';
    this.text(layers + s.layers.map((hz) => hz.toFixed(1)).join('  '), m, y, 0.38);

    // ---- bottom-right: system
    this.text(`TRK ${s.trackFps.toFixed(0).padStart(2)}FPS ${s.detectMs.toFixed(1)}MS ${s.delegate}   GFX ${s.fps.toFixed(0)}FPS`, R, h - m, 0.25, 'right');

    // ---- pitch ruler on the right edge
    this.drawRuler(s);

    // ---- hand markers
    for (const role of ['left', 'right']) {
      const hd = s.hands[role];
      if (!hd) continue;
      const p = toScreen(hd.palm.x, hd.palm.y);
      g.strokeStyle = `rgba(255,255,255,0.25)`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(p.x - 6, p.y);
      g.lineTo(p.x + 6, p.y);
      g.moveTo(p.x, p.y - 6);
      g.lineTo(p.x, p.y + 6);
      g.stroke();
      if (role === 'right') {
        this.text(`${s.hz.toFixed(1)}`, p.x + 10, p.y - 6, 0.5, 'left', 9, ACCENT);
        this.text(nl.name, p.x + 10, p.y + 6, 0.3, 'left', 9);
      } else {
        this.text(`V${s.volume.toFixed(2)}`, p.x - 10, p.y - 6, 0.4, 'right', 9);
        this.text(`F${(s.cutoff / 1000).toFixed(1)}k`, p.x - 10, p.y + 6, 0.3, 'right', 9);
      }
      if (this.drawSkeleton) this.skeleton(hd, toScreen);
    }

    // ---- clear progress: thin arc between the hands
    if (s.clearProgress > 0 && s.hands.left && s.hands.right) {
      const a = toScreen(s.hands.left.palm.x, s.hands.left.palm.y);
      const b = toScreen(s.hands.right.palm.x, s.hands.right.palm.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      g.strokeStyle = `rgba(${ACCENT},0.6)`;
      g.beginPath();
      g.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + s.clearProgress * Math.PI * 2);
      g.stroke();
      this.text('CLEAR', cx, cy + 3, 0.5, 'center', 9);
    }

    // ---- pulse step grid
    if (s.mode === 'pulse' && s.grid && s.grid.clicks) this.drawGrid(s);
  }

  drawRuler(s) {
    const g = this.g;
    const x = this.w - 22;
    const top = this.h * 0.16;
    const bot = this.h * 0.84;
    const [lo, hi] = s.range;
    const yOf = (m) => bot - ((m - lo) / (hi - lo)) * (bot - top);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, bot);
    g.stroke();
    const steps = s.steps || [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    for (const n of scaleNotes(steps, lo, hi)) {
      const y = yOf(n);
      const octave = (n - 33) % 12 === 0;
      g.strokeStyle = `rgba(255,255,255,${octave ? 0.35 : 0.14})`;
      g.beginPath();
      g.moveTo(x - (octave ? 10 : 5), y);
      g.lineTo(x, y);
      g.stroke();
      if (octave) this.text(noteLabel(n).name, x - 14, y + 3, 0.25, 'right', 8);
    }
    const midi = hzToMidi(s.hz);
    if (midi >= lo - 1 && midi <= hi + 1) {
      const y = yOf(Math.min(hi, Math.max(lo, midi)));
      g.strokeStyle = `rgba(${ACCENT},${s.sounding ? 0.9 : 0.3})`;
      g.beginPath();
      g.moveTo(x - 18, y);
      g.lineTo(x + 4, y);
      g.stroke();
    }
    for (const hz of s.layers) {
      const y = yOf(Math.min(hi, Math.max(lo, hzToMidi(hz))));
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.fillRect(x + 3, y - 1, 3, 3);
    }
  }

  drawGrid(s) {
    const g = this.g;
    const n = 16;
    const cw = 9;
    const gap = 4;
    const W = n * (cw + gap);
    const x0 = (this.w - W) / 2;
    const y0 = this.h - 34;
    const lanes = [s.grid.clicks, s.grid.noise, s.grid.subs];
    lanes.forEach((lane, li) => {
      for (let i = 0; i < n; i++) {
        const on = lane[i];
        const cur = i === s.step;
        const a = cur ? (on ? 0.95 : 0.35) : on ? 0.35 : 0.08;
        g.fillStyle = `rgba(${cur && on ? ACCENT : '255,255,255'},${a})`;
        g.fillRect(x0 + i * (cw + gap), y0 + li * 6, cw, 2);
      }
    });
    this.text(`DENSITY ${s.density.toFixed(2)}  PATTERN ${s.variant}  ${s.bpm}BPM`, this.w / 2, y0 - 8, 0.3, 'center', 9);
  }

  skeleton(hd, toScreen) {
    const g = this.g;
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.beginPath();
    for (const [a, b] of BONES) {
      const p = toScreen(hd.lm[a * 3], hd.lm[a * 3 + 1]);
      const q = toScreen(hd.lm[b * 3], hd.lm[b * 3 + 1]);
      g.moveTo(p.x, p.y);
      g.lineTo(q.x, q.y);
    }
    g.stroke();
  }
}
