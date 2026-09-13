import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EyeMetrics, STATES, scoreEnergy, stateFor, smoothstep } from '../js/metrics.js';

// Feeds synthetic closure samples. Blinks are periodic; long closures are explicit.
function simulate(m, {
  seconds, fps = 30, baseline = 0.1, startT = 0,
  blinkEveryMs = null, blinkMs = 150, blinkLevel = 0.95, longClosures = [],
  gaze = null, onSample = null,
}) {
  const step = 1000 / fps;
  const end = startT + seconds * 1000;
  let t = startT;
  for (; t < end; t += step) {
    let c = baseline;
    if (blinkEveryMs) {
      const phase = (t - startT + blinkEveryMs - 1000) % blinkEveryMs;
      if (phase < blinkMs) c = blinkLevel;
    }
    for (const lc of longClosures) {
      if (t >= startT + lc.at && t < startT + lc.at + lc.dur) c = blinkLevel;
    }
    const g = gaze ? gaze(t) : { x: 0.5, y: 0.5 };
    m.push({ t, closure: c, gazeX: g.x, gazeY: g.y });
    if (onSample) onSample(t, m);
  }
  return t;
}

test('smoothstep clamps and eases', () => {
  assert.equal(smoothstep(0, 1, -1), 0);
  assert.equal(smoothstep(0, 1, 2), 1);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
});

test('steady open eyes read as replenished', () => {
  const m = new EyeMetrics();
  const t = simulate(m, { seconds: 70 });
  const s = m.snapshot(t);
  assert.equal(s.calibrated, true);
  assert.equal(s.blinkCount, 0);
  assert.equal(s.perclos, 0);
  assert.ok(s.energy >= 90, `energy ${s.energy}`);
  assert.equal(s.state, STATES.REPLENISHED);
});

test('normal blinking counts blinks and stays replenished', () => {
  const m = new EyeMetrics();
  const t = simulate(m, { seconds: 70, blinkEveryMs: 4000, blinkMs: 150 });
  const s = m.snapshot(t);
  assert.ok(s.blinkRate >= 12 && s.blinkRate <= 18, `blinkRate ${s.blinkRate}`);
  assert.ok(s.blinkDurationMs >= 110 && s.blinkDurationMs <= 230, `blinkDuration ${s.blinkDurationMs}`);
  assert.ok(s.perclos > 0 && s.perclos < 0.06, `perclos ${s.perclos}`);
  assert.ok(s.energy >= 85, `energy ${s.energy}`);
  assert.equal(s.state, STATES.REPLENISHED);
});

test('drowsy pattern drops below fatigued', () => {
  const m = new EyeMetrics();
  const t = simulate(m, {
    seconds: 70, baseline: 0.45, blinkEveryMs: 2500, blinkMs: 600,
    longClosures: [{ at: 20_000, dur: 1500 }, { at: 40_000, dur: 1500 }],
  });
  const s = m.snapshot(t);
  assert.equal(s.restRaw, 0.35, 'rest closure is capped so droopy calibration still registers');
  assert.ok(s.perclos > 0.2, `perclos ${s.perclos}`);
  assert.ok(s.blinkDurationMs > 500, `blinkDuration ${s.blinkDurationMs}`);
  assert.ok(s.energy < 50, `energy ${s.energy}`);
  assert.ok([STATES.DEPLETED, STATES.CRITICAL].includes(s.state), s.state);
});

test('hysteresis ignores jitter below the blink threshold', () => {
  const m = new EyeMetrics();
  let t = simulate(m, { seconds: 10 });
  const end = t + 20_000;
  let i = 0;
  for (; t < end; t += 33, i++) m.push({ t, closure: i % 2 ? 0.40 : 0.50 });
  assert.equal(m.snapshot(t).blinkCount, 0);
});

test('a long closure counts toward PERCLOS but is not a blink', () => {
  const m = new EyeMetrics();
  const t = simulate(m, { seconds: 40, longClosures: [{ at: 15_000, dur: 3000 }] });
  const s = m.snapshot(t);
  assert.equal(s.blinkCount, 0);
  assert.ok(s.perclos > 0.06 && s.perclos < 0.1, `perclos ${s.perclos}`);
});

test('recovery is reported while energy climbs back', () => {
  const m = new EyeMetrics();
  let t = simulate(m, { seconds: 60, baseline: 0.45, blinkEveryMs: 2500, blinkMs: 600 });
  const low = m.snapshot(t).energy;
  assert.ok(low < 50, `low ${low}`);
  const seen = new Set();
  t = simulate(m, { seconds: 75, startT: t, onSample: (tt, mm) => seen.add(mm.snapshot(tt).state) });
  assert.ok(seen.has(STATES.RECOVERING), [...seen].join(','));
  const s = m.snapshot(t);
  assert.ok(s.energy >= 75, `energy ${s.energy}`);
  assert.equal(s.state, STATES.REPLENISHED);
});

test('gaps in face tracking do not count as face time', () => {
  const m = new EyeMetrics();
  let t = simulate(m, { seconds: 5 });
  t = simulate(m, { seconds: 5, startT: t + 5000 });
  const s = m.snapshot(t);
  assert.ok(s.faceMs >= 9_800 && s.faceMs <= 10_000, `faceMs ${s.faceMs}`);
  assert.ok(s.spanMs <= 10_000, `spanMs ${s.spanMs}`);
});

test('recalibrate restarts the baseline and score', () => {
  const m = new EyeMetrics();
  let t = simulate(m, { seconds: 20 });
  assert.equal(m.snapshot(t).calibrated, true);
  m.recalibrate();
  assert.equal(m.snapshot(t).calibrated, false);
  assert.equal(m.snapshot(t).energy, null);
  t = simulate(m, { seconds: 10, startT: t });
  assert.equal(m.snapshot(t).calibrated, true);
});

test('gaze jitter penalises unstable fixation', () => {
  const steady = scoreEnergy({ perclos: 0, restClosure: 0, blinkRate: 15, blinkDurationMs: 150, gazeJitter: 0.005 }, 60_000);
  const jittery = scoreEnergy({ perclos: 0, restClosure: 0, blinkRate: 15, blinkDurationMs: 150, gazeJitter: 0.1 }, 60_000);
  assert.ok(steady > jittery);
  assert.equal(steady - jittery, 5);
});

test('state thresholds', () => {
  assert.equal(stateFor(null, null), STATES.CALIBRATING);
  assert.equal(stateFor(80, 0), STATES.REPLENISHED);
  assert.equal(stateFor(60, 0), STATES.FATIGUED);
  assert.equal(stateFor(30, 0), STATES.DEPLETED);
  assert.equal(stateFor(10, 0), STATES.CRITICAL);
  assert.equal(stateFor(60, 10), STATES.RECOVERING);
  assert.equal(stateFor(80, 10), STATES.REPLENISHED);
});
