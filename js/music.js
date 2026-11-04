/**
 * Pitch helpers: scales, quantisation with hysteresis, note names.
 * Everything is rooted on A (A1 = 55 Hz) so the low end of the range is a
 * tonic and drones built from frozen notes sit well together.
 */

export const ROOT_MIDI = 33; // A1 = 55 Hz

export const SCALES = [
  { key: 'free', label: 'FREE', steps: null },
  { key: 'minpent', label: 'MIN.PENT', steps: [0, 3, 5, 7, 10] },
  // "In" (miyako-bushi) scale: semitone + tritone-free gaps, dark and open.
  { key: 'in', label: 'DARK/IN', steps: [0, 1, 5, 7, 8] },
];

/** Interval set for the second voice, small → large hand distance (semitones below the lead). */
export const INTERVALS = [
  { semi: 0, label: 'UNISON' },
  { semi: 3, label: 'MIN3' },
  { semi: 5, label: 'P4' },
  { semi: 7, label: 'P5' },
  { semi: 10, label: 'MIN7' },
  { semi: 12, label: 'OCT' },
];

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** "A2 +12" style label for a (fractional) midi number. */
export function noteLabel(midi) {
  const n = Math.round(midi);
  const cents = Math.round((midi - n) * 100);
  const name = NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
  const c = cents === 0 ? '±0' : (cents > 0 ? '+' : '') + cents;
  return { name, cents: c };
}

/** All midi notes of a scale in [lo, hi]. */
export function scaleNotes(steps, lo, hi) {
  const out = [];
  for (let oct = -1; oct < 11; oct++) {
    for (const s of steps) {
      const m = ROOT_MIDI + oct * 12 + s;
      if (m >= lo - 0.001 && m <= hi + 0.001) out.push(m);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Snap a continuous midi value to the nearest scale note. Keeps the previous
 * note until the hand has clearly moved past the midpoint (hysteresis), so a
 * hand resting on a boundary does not flicker between two notes.
 */
export class Quantizer {
  constructor() {
    this.current = null;
  }
  reset() {
    this.current = null;
  }
  quantize(midi, steps) {
    if (!steps) {
      this.current = null;
      return midi;
    }
    const notes = scaleNotes(steps, midi - 14, midi + 14);
    let best = notes[0];
    for (const n of notes) if (Math.abs(n - midi) < Math.abs(best - midi)) best = n;
    if (this.current !== null && this.current !== best) {
      // stay on the current note if we're still within a margin past the midpoint
      const mid = (this.current + best) / 2;
      const margin = 0.22;
      if (Math.abs(midi - mid) < margin) return this.current;
    }
    this.current = best;
    return best;
  }
}
