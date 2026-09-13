# Ocular Photometry

Reads eye fatigue from the webcam and renders it as a living nebula that collapses toward a
black hole as the eyes run down. Everything runs in the browser; no video is stored or sent
anywhere.

Open the site, press **Start reading**, and look at the camera. After an eight-second
calibration the page shows an energy score (0–100), a state, and the eyelid signals behind it.
Each session's final reading is kept in local storage so the next visit can show what changed
since the last time you looked.

## How it works

1. **Camera → face landmarks.** MediaPipe's Face Landmarker (runtime and model served from
   this site, see `vendor/mediapipe/`) runs on each video frame and returns 478 landmarks plus
   face blendshapes. The `eyeBlinkLeft` / `eyeBlinkRight` blendshapes give eyelid closure directly;
   iris landmarks give gaze position.
2. **Closure → signals** (`js/metrics.js`, pure, unit-tested):
   - **Calibration** — the median closure over the first 8 s of face time becomes the
     open-eye baseline, so a person whose "open" reads 0.2 is not scored as half-shut.
   - **PERCLOS (P80)** — share of the last minute the eyes were ≥ 80% closed.
   - **Blinks** — hysteresis detector (enter at 0.5, leave at 0.3); duration and rate over the
     rolling window. Closures longer than 2 s are not blinks but still count for PERCLOS.
   - **Lids at rest** — mean closure between blinks.
   - **Gaze jitter** — spread of the iris position over the last 2 s.
3. **Signals → energy.** 100 minus weighted penalties (PERCLOS carries 55 points, blink
   duration and lid rest 20 each, blink rate and gaze jitter 5 each), smoothed with a 3 s
   time constant. States: replenished ≥ 75, fatigued ≥ 50, depleted ≥ 25, critical below;
   *recovering* when energy is climbing by 5+ points a minute.
4. **Energy → sky** (`js/nebula.js`). Particle parameters — pull, spin, core radius, event
   horizon, palette — are interpolated between keyframes at 100 / 62 / 37 / 12 / 0, so the
   nebula thins, dims, and finally collapses into a ringed black hole.

Two things help the input signal stay honest:

- **Lighting check.** Average frame brightness is sampled continuously; a "Low" or "Bright"
  reading during calibration is called out in the caption, since bad lighting is the largest
  practical source of a bad reading in an ordinary RGB webcam.
- **Camera picker.** If a device exposes more than one camera — most visibly a Windows Hello
  infrared camera alongside the regular webcam — a picker lets you choose it. `getUserMedia`
  never reaches the actual biometric IR sensor behind Face ID or similar unlock systems (that
  is walled off from web pages entirely); this only helps on the rarer devices where an IR
  webcam is exposed as an ordinary camera device.

## Layout

```
index.html            page
css/app.css
js/app.js             camera loop, UI, persistence glue
js/landmarker.js      MediaPipe wrapper + eye reading from a result
js/metrics.js         pure eye-signal math and scoring
js/nebula.js          canvas renderer
js/store.js           localStorage readings, since-last-reading delta
test/metrics.test.js
```

Plain ES modules, no build step. Pushes to `main` run the tests and deploy to GitHub Pages.

## Running locally

The camera needs a secure context, which `localhost` counts as:

```sh
npm run serve          # python3 -m http.server 8000
open http://localhost:8000/
```

Unit tests (Node 20+):

```sh
npm test
```

## Privacy and security

[`privacy.html`](privacy.html) is the plain-language record of what the page keeps (one small
numeric reading per session, in the browser's local storage) and what it never stores (frames,
landmarks, anything identifying).

- **No third-party code at runtime.** The MediaPipe runtime, the model, and the fonts are all
  served from this repository (`vendor/`), so no CDN sees a request and no CDN can inject code.
- **Content-Security-Policy** on every page restricts scripts, connections, fonts, and styles
  to the page's own origin; WebAssembly is allowed via `'wasm-unsafe-eval'` only.
- **Nothing is transmitted.** There is no server, no analytics, no cookies, no accounts.
- **Camera access** is video-only, gated by the browser's own prompt, and released on Stop.

## Limits

Eyelid behaviour is an indirect, noisy proxy for how tired someone is. Lighting, glasses,
camera angle, and eye shape all move the numbers, and none of this is medical guidance. The
PERCLOS thresholds are adapted loosely from drowsiness-detection literature, not validated
against any ground truth.
