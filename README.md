# AETHER

A webcam theremin for the browser. You play sound with your hands in the air
without touching anything, and your hands turn into light.

Dark, raw, minimal: sine tones, sub bass, precise clicks, phosphor lines,
particle dust.

**Everything runs locally.** Hand tracking (MediaPipe HandLandmarker) runs in
your browser via WASM/WebGL. The camera image is never uploaded anywhere.

## Run

It is a static site with no build step and no backend.

- **GitHub Pages:** push the repo, enable Pages on the branch root, and open the URL.
- **Locally:** serve the folder over HTTP. Camera access needs `localhost` or HTTPS.
  ```bash
  python3 -m http.server 8000
  ```
  Then open <http://localhost:8000>.

Built for a laptop (MacBook). Chrome comes first; Safari 16.4+ works too.
Click once to enter, which unlocks audio, then allow the camera and raise
your hands. Headphones or decent speakers help a lot with the sub layer.

If there's no camera, or you deny permission, AETHER falls back to mouse control.

## Playing

| hand | controls |
| --- | --- |
| **right hand height** | pitch: continuous glide, 55–880 Hz (low/mid, never shrill) |
| **right hand distance** to the camera | timbre: far = pure sine, close = FM + grit |
| **left hand height** | volume |
| **left hand x position** | filter: further left = darker |
| **distance between the hands** | interval of a second voice below the lead (unison, m3, P4, P5, m7, octave) **and space**: close together = dry, intimate, short trails; spread wide = long dark delay/reverb tail, long afterglow, the scene gently zooms out |
| **how fast you move** | energy ↔ stillness (see below) |

With only one hand in view, volume and filter rest at a comfortable default.

### Energy ↔ stillness

AETHER measures how fast your hands move.

- **Fast movement** sprays short gated noise bursts and glitch clicks into the
  sound. The trails turn sharp and jagged, and more dust sheds from the fingertips.
- **Stillness** builds up over about 3.5 seconds. The tone purifies to a sine
  and a deep layer two octaves down slowly fades in. The visuals calm down:
  trails become long, soft and smooth, the glow lengthens and the edges
  darken. Hold perfectly still and you sink into depth.

The HUD shows `ENERGY`, `STILL` and `SPACE` live.

## Gestures

| gesture | effect |
| --- | --- |
| **pinch** (thumb + index) | a precise click/glitch at the current pitch. Pinch repeatedly to play rhythms. In PULSE mode it switches to the next pattern. |
| **fist** | freezes the current tone (taken from just before the fist closed) into a sustained drone layer. Up to 3 layers; a 4th replaces the oldest. |
| **both hands spread wide** (hold ~1 s) | clears all drone layers. A ring between the hands shows the progress. |
| **clap / palms touching** | white glitch flash, shock wave and sub drop. This is the big moment. |

## Modes

| key | mode | |
| --- | --- | --- |
| `1` | **THEREMIN** | continuous and expressive (default) |
| `2` | **PULSE** | tempo-synced (124 BPM) Euclidean click / sub / gated-noise pattern. Right hand height sets the density, right hand x sets the pitch of the blips, and pinch changes the pattern. |
| `3` | **DRONE** | slow and deep. Long glides, detuned pad partials, and noise that breathes with your movement. Visuals turn into slow orbits and dust. |

## Keys

| key | |
| --- | --- |
| `1` `2` `3` | modes |
| `S` | scale: free (continuous) → minor pentatonic → dark ("in" scale: 0 1 5 7 8) |
| `G` | glide amount: tight / soft / slow / long |
| `C` | camera image: off / ghost (default, almost invisible) / dim |
| `K` | symmetry: off → 2 → 4 → 6-fold kaleidoscope of all visuals around the centre |
| `R` | start or stop recording |
| `M` | mouse mode (move = pitch, click = pinch, scroll = timbre, space = fist) |
| `X` | clear drone layers |
| `space` | freeze the current tone |
| `F` | fullscreen |
| `H` | help overlay |

All hints and readouts fade out after 5 seconds without keyboard input, so the
screen is pure visuals while you play. Any key brings them back.

## Visual extras

- **Symmetry (`K`):** hands, trails, strings and particles are mirrored
  around the centre into a living mandala of light. 2-fold mirrors
  left/right, 4-fold mirrors both axes, and 6-fold uses three 120° rotations,
  each with its mirror image.
- **Reactive dust field:** a very sparse 3D field of tiny grains in the
  background. It drifts slowly, shifts with parallax as your hands move,
  flares on clicks and sub hits, and gets pushed outward by fast movement.
  Barely visible when quiet, alive when playing.

## Recording

`R` records the canvas (visuals + HUD readouts) and the master audio through
`MediaRecorder`. The file downloads automatically when you press `R` again.

AETHER prefers **MP4** (H.264, with AAC where the browser can encode it, as
Safari and recent Chrome on macOS do) and falls back to **WebM** (VP9/Opus).
The output is 1080 px tall in the window's aspect ratio.

For Instagram, a 4:5 or 9:16 browser window gives a portrait clip. If a file
ends up with Opus audio and Instagram refuses it, convert it:

```bash
ffmpeg -i aether.webm -c:v libx264 -crf 18 -c:a aac aether.mp4
```

Press `C` before recording if you want the camera ghost completely gone.

## How it works

```
camera ─► MediaPipe HandLandmarker (2 hands, GPU delegate, on every video frame)
       ─► One Euro filter (screen + metric world landmarks), stable hand slots
       ─► features: palm, apparent size, pinch / curl / spread ratios
       ─► gestures (hysteresis, hold times, cooldowns)
       ─► control mapping ─► Web Audio params (ramped, same frame)
                          ─► three.js visuals + HUD (60 fps)
```

- **Latency:** detection runs in `requestVideoFrameCallback`, so it fires as
  soon as a camera frame arrives. Audio parameters update in the same callback
  through short `setTargetAtTime` ramps on an `interactive` AudioContext.
  The One Euro filter removes jitter at rest without lagging fast moves.
- **Sound** (plain Web Audio, no library): one `ConstantSource` drives the
  frequency, so the FM carrier, modulator and sub stay locked during glides.
  Oscillators never stop; every gate is ramped. The chain ends in a dark
  feedback delay, a generated small dark room, a limiter and a soft clip.
- **Visuals:** the particle skeletons are computed on the GPU from 21 landmark
  uniforms. Fingertip trails and the strings are displaced by the live
  waveform, triggered at a zero crossing like an oscilloscope. Post-processing
  adds phosphor persistence, restrained bloom, grain, and the flash/glitch pass.
- **Handedness:** with two hands in view, the hand on the right of the screen
  is your right hand. With one hand, AETHER uses MediaPipe's label. Whether
  that label is mirrored is learned at runtime from two-hand frames.

### Files

```
index.html          page, import map (three.js), help overlay
css/style.css       almost-no-UI styling
js/main.js          app wiring, control mapping, keys, onboarding
js/tracker.js       camera + MediaPipe, synthetic mouse hand
js/hands.js         slots, filtering, roles, features
js/filters.js       One Euro filter
js/gestures.js      pinch / fist / clear / clap detection
js/audio.js         audio engine, drone layers, pulse sequencer
js/pulse.js         Euclidean rhythms
js/music.js         scales, quantiser, note names
js/hud.js           data readouts (2D canvas)
js/recorder.js      MediaRecorder export
js/visuals/         three.js scene: hand dust, trails + strings, particles, orbits,
                    dust field, symmetry + final post passes
```

`window.AETHER` exposes the live state in the console for tuning. The HUD
shows the live gesture ratios too: `p` = pinch, `c` = curl.
