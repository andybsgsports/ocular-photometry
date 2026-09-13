// Pure eye-signal math. No DOM, no MediaPipe — runs in node for tests.

export const STATES = Object.freeze({
  CALIBRATING: 'calibrating',
  REPLENISHED: 'replenished',
  FATIGUED: 'fatigued',
  DEPLETED: 'depleted',
  CRITICAL: 'critical',
  RECOVERING: 'recovering',
});

export const DEFAULTS = Object.freeze({
  windowMs: 60_000,
  calibrationMs: 8_000,
  blinkOn: 0.5,
  blinkOff: 0.3,
  perclosLevel: 0.8,
  minBlinkMs: 40,
  maxBlinkMs: 2_000,
  gazeWindowMs: 2_000,
  energyTauMs: 3_000,
  trendLagMs: 30_000,
  maxRestClosure: 0.35,
  gapMs: 1_000,
});

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 100 = fully rested. Each signal subtracts; PERCLOS carries the most weight
// because it is the one with real drowsiness-detection literature behind it.
export function scoreEnergy(stats, faceMs) {
  let penalty = 0;
  penalty += 55 * smoothstep(0.06, 0.4, stats.perclos);
  penalty += 20 * smoothstep(200, 500, stats.blinkDurationMs ?? 0);
  penalty += 20 * smoothstep(0.08, 0.4, stats.restClosure);
  if (stats.blinkRate != null && faceMs >= 30_000) {
    penalty += 5 * smoothstep(20, 35, stats.blinkRate);
    penalty += 5 * (1 - smoothstep(3, 8, stats.blinkRate));
  }
  penalty += 5 * smoothstep(0.02, 0.08, stats.gazeJitter ?? 0);
  return clamp(100 - penalty, 0, 100);
}

export function stateFor(energy, trend) {
  if (energy == null) return STATES.CALIBRATING;
  if (trend != null && trend >= 5 && energy >= 15 && energy < 75) return STATES.RECOVERING;
  if (energy >= 75) return STATES.REPLENISHED;
  if (energy >= 50) return STATES.FATIGUED;
  if (energy >= 25) return STATES.DEPLETED;
  return STATES.CRITICAL;
}

export class EyeMetrics {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.samples = [];
    this.calibration = [];
    this.restRaw = 0;
    this.calibrated = false;
    this.faceMs = 0;
    this.lastT = null;
    this.blinks = [];
    this.inBlink = false;
    this.blinkStart = 0;
    this.gaze = [];
    this.energy = null;
    this.energyHist = [];
  }

  recalibrate() {
    this.calibration = [];
    this.restRaw = 0;
    this.calibrated = false;
    this.faceMs = 0;
    this.energy = null;
    this.energyHist = [];
  }

  // Raw blendshape closure for an open eye is rarely 0 — it depends on the
  // person — so closure is re-zeroed against their own calibrated rest value.
  normalize(raw) {
    const r = this.restRaw;
    return clamp((raw - r) / ((1 - r) || 1), 0, 1);
  }

  push({ t, closure, gazeX = null, gazeY = null }) {
    const o = this.o;
    let dt = 0;
    let gap = false;
    if (this.lastT != null) {
      dt = t - this.lastT;
      if (dt <= 0) return;
      if (dt > o.gapMs) { gap = true; dt = 0; }
    }
    this.lastT = t;
    this.faceMs += dt;
    if (gap) this.inBlink = false;

    if (!this.calibrated) {
      this.calibration.push(closure);
      if (this.calibration.length >= 10) {
        this.restRaw = Math.min(median(this.calibration), o.maxRestClosure);
      }
      if (this.faceMs >= o.calibrationMs) this.calibrated = true;
    }

    this.samples.push({ t, c: closure });
    const cutoff = t - o.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();

    const n = this.normalize(closure);
    if (!this.inBlink && n >= o.blinkOn) {
      this.inBlink = true;
      this.blinkStart = t;
    } else if (this.inBlink && n <= o.blinkOff) {
      this.inBlink = false;
      const dur = t - this.blinkStart;
      if (dur >= o.minBlinkMs && dur <= o.maxBlinkMs) this.blinks.push({ t, dur });
    }
    while (this.blinks.length && this.blinks[0].t < cutoff) this.blinks.shift();

    if (gazeX != null && gazeY != null) {
      this.gaze.push({ t, x: gazeX, y: gazeY });
      const gc = t - o.gazeWindowMs;
      while (this.gaze.length && this.gaze[0].t < gc) this.gaze.shift();
    }

    if (this.calibrated) {
      const score = scoreEnergy(this.windowStats(t), this.faceMs);
      if (this.energy == null) this.energy = score;
      else this.energy += (score - this.energy) * (1 - Math.exp(-(dt || 16) / o.energyTauMs));
      this.energyHist.push({ t, e: this.energy });
      const hc = t - o.trendLagMs * 2;
      while (this.energyHist.length && this.energyHist[0].t < hc) this.energyHist.shift();
    }
  }

  windowStats(t = this.lastT) {
    const o = this.o;
    let total = 0, closed = 0, restSum = 0, restTotal = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1];
      const s = this.samples[i];
      const dt = s.t - prev.t;
      if (dt <= 0 || dt > o.gapMs) continue;
      const n = this.normalize(s.c);
      total += dt;
      if (n >= o.perclosLevel) closed += dt;
      if (n < o.blinkOff) { restSum += n * dt; restTotal += dt; }
    }
    const recent = this.blinks.slice(-10);
    const last = this.samples[this.samples.length - 1];
    return {
      perclos: total ? closed / total : 0,
      restClosure: restTotal ? restSum / restTotal : 0,
      blinkRate: total >= 10_000 ? this.blinks.length / (total / 60_000) : null,
      blinkDurationMs: recent.length ? recent.reduce((a, b) => a + b.dur, 0) / recent.length : null,
      blinkCount: this.blinks.length,
      gazeJitter: this.gazeJitter(),
      closureNow: last ? this.normalize(last.c) : 0,
      spanMs: total,
    };
  }

  gazeJitter() {
    const g = this.gaze;
    if (g.length < 5) return null;
    let mx = 0, my = 0;
    for (const p of g) { mx += p.x; my += p.y; }
    mx /= g.length;
    my /= g.length;
    let v = 0;
    for (const p of g) v += (p.x - mx) ** 2 + (p.y - my) ** 2;
    return Math.sqrt(v / g.length);
  }

  // Energy change per minute, measured against the reading ~trendLagMs ago.
  trend(t = this.lastT) {
    const h = this.energyHist;
    if (h.length < 2 || this.energy == null) return null;
    const target = t - this.o.trendLagMs;
    if (h[0].t > target + 2_000) return null;
    let then = h[0];
    for (const p of h) {
      if (p.t <= target) then = p;
      else break;
    }
    const minutes = (t - then.t) / 60_000;
    return minutes > 0 ? (this.energy - then.e) / minutes : null;
  }

  snapshot(t = this.lastT) {
    const stats = this.lastT == null
      ? { perclos: 0, restClosure: 0, blinkRate: null, blinkDurationMs: null, blinkCount: 0, gazeJitter: null, closureNow: 0, spanMs: 0 }
      : this.windowStats(t);
    const energy = this.calibrated && this.energy != null ? Math.round(this.energy) : null;
    const trend = this.calibrated ? this.trend(t) : null;
    return {
      ...stats,
      faceMs: this.faceMs,
      calibrated: this.calibrated,
      calibrationProgress: clamp(this.faceMs / this.o.calibrationMs, 0, 1),
      restRaw: this.restRaw,
      energy,
      trend,
      state: stateFor(energy, trend),
    };
  }
}
