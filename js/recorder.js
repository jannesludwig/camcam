/**
 * Records what you see and hear: the WebGL canvas + HUD composited into one
 * canvas, plus the master audio bus, via MediaRecorder.
 * Prefers MP4 (H.264/AAC — Instagram-friendly) where the browser can encode
 * it (Safari, recent Chrome), otherwise WebM (VP9/Opus).
 */

const TYPES = [
  ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'mp4'],
  ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
  ['video/mp4;codecs=avc1,opus', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm'],
];

function pickType() {
  if (!window.MediaRecorder) return null;
  for (const [t, ext] of TYPES) if (MediaRecorder.isTypeSupported(t)) return { type: t, ext };
  return { type: '', ext: 'webm' };
}

export class Recorder {
  constructor(glCanvas, hudCanvas, audio) {
    this.gl = glCanvas;
    this.hud = hudCanvas;
    this.audio = audio;
    this.recording = false;
    this.comp = document.createElement('canvas');
    this.g = this.comp.getContext('2d', { alpha: false });
  }

  toggle() {
    if (this.recording) {
      this.stop();
      return 'SAVING';
    }
    return this.start();
  }

  start() {
    const fmt = pickType();
    if (!fmt || !this.comp.captureStream) return 'RECORDING NOT SUPPORTED';
    // output: window aspect, 1080 px tall (max 1920 wide), even dimensions
    const aspect = innerWidth / innerHeight;
    let h = 1080;
    let w = Math.round(h * aspect);
    if (w > 1920) {
      w = 1920;
      h = Math.round(w / aspect);
    }
    this.comp.width = w - (w % 2);
    this.comp.height = h - (h % 2);
    this.g.fillStyle = '#000';
    this.g.fillRect(0, 0, this.comp.width, this.comp.height);

    const stream = this.comp.captureStream(60);
    if (this.audio.recDest) for (const t of this.audio.recDest.stream.getAudioTracks()) stream.addTrack(t);
    const opts = { videoBitsPerSecond: 14_000_000, audioBitsPerSecond: 192_000 };
    if (fmt.type) opts.mimeType = fmt.type;
    try {
      this.rec = new MediaRecorder(stream, opts);
    } catch (e) {
      console.warn(e);
      return 'RECORDING FAILED';
    }
    this.ext = fmt.ext;
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data && e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => this.save();
    this.rec.start(250);
    this.t0 = performance.now();
    this.recording = true;
    document.body.classList.add('recording');
    return `REC ${fmt.ext.toUpperCase()}`;
  }

  stop() {
    if (!this.recording) return;
    this.recording = false;
    document.body.classList.remove('recording');
    this.rec.stop();
  }

  save() {
    const blob = new Blob(this.chunks, { type: this.rec.mimeType || `video/${this.ext}` });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `aether-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${this.ext}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.lastFile = { name, size: blob.size, type: blob.type };
  }

  /** Call right after the WebGL frame was rendered (same task → buffer still valid). */
  frame() {
    if (!this.recording) return;
    const { g, comp } = this;
    if (this.gl) g.drawImage(this.gl, 0, 0, comp.width, comp.height);
    else {
      g.fillStyle = '#000';
      g.fillRect(0, 0, comp.width, comp.height);
    }
    g.drawImage(this.hud, 0, 0, comp.width, comp.height);
  }

  elapsed() {
    if (!this.recording) return '';
    const s = Math.floor((performance.now() - this.t0) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
}
