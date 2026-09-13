# Ocular Photometry

Reads eye fatigue from the webcam and renders it as a living nebula that collapses toward a
black hole as the eyes run down. Everything runs in the browser; no video is stored or sent
anywhere.

Open the site, press **Start reading**, and look at the camera. After an eight-second
calibration the page shows an energy score (0–100), a state, and the eyelid signals behind it.
Each session's final reading is kept in local storage so the next visit can show what changed
since the last time you looked.

## How it works

1. **Camera → face landmarks.** MediaPipe's Face Landmarker (loaded from jsDelivr, model from
   Google's public bucket) runs on each video frame and returns 478 landmarks plus face
   blendshapes. The `eyeBlinkLeft` / `eyeBlinkRight` blendshapes give eyelid closure directly;
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

## Limits

Eyelid behaviour is an indirect, noisy proxy for how tired someone is. Lighting, glasses,
camera angle, and eye shape all move the numbers, and none of this is medical guidance. The
PERCLOS thresholds are adapted loosely from drowsiness-detection literature, not validated
against any ground truth.
