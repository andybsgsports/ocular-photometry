// Canvas nebula that collapses toward a black hole as energy falls.
// Params are interpolated continuously from the energy score across keyframes.

export const CW = 220;
export const CH = 140;
const CX = CW / 2;
const CY = CH / 2 + 4;
const MAXR = 92;
const POOL = 150;

const KEYFRAMES = [
  { at: 100, colors: ['#5ec8c0', '#8fd9d1', '#d9a441', '#e8546b'], rim: '#5ec8c0', count: 130, speed: 1.0, pull: 0.05, spin: 0.16, coreR: 7, horizon: 0, glow: 0.3 },
  { at: 62, colors: ['#b98a63', '#8a8471', '#6f7d7c'], rim: '#b98a63', count: 85, speed: 0.65, pull: 0.2, spin: 0.26, coreR: 15, horizon: 0.08, glow: 0.4 },
  { at: 37, colors: ['#736a86', '#5c5568', '#443f52'], rim: '#736a86', count: 50, speed: 0.42, pull: 0.42, spin: 0.4, coreR: 26, horizon: 0.35, glow: 0.5 },
  { at: 12, colors: ['#e8546b', '#ff8a4c', '#ffcf6b'], rim: '#e8546b', count: 95, speed: 1.0, pull: 0.9, spin: 0.95, coreR: 40, horizon: 1, glow: 0.95 },
  { at: 0, colors: ['#e8546b', '#ff8a4c', '#ffcf6b'], rim: '#e8546b', count: 100, speed: 1.1, pull: 1.0, spin: 1.05, coreR: 46, horizon: 1, glow: 1.0 },
];

const RECOVERING = { colors: ['#5ec8c0', '#d9a441', '#8fd9d1', '#e8a15e'], rim: '#d9a441', count: 115, speed: 0.75, pull: -0.25, spin: 0.55, coreR: 18, horizon: 0.12, glow: 0.55 };
const IDLE = { colors: ['#3a3d4c', '#4a4e60', '#2f3242'], rim: '#3a3d4c', count: 40, speed: 0.3, pull: 0, spin: 0.08, coreR: 0, horizon: 0, glow: 0.08 };

const NUMERIC = ['count', 'speed', 'pull', 'spin', 'coreR', 'horizon', 'glow'];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

function lerp(a, b, f) {
  return a + (b - a) * f;
}

function mixFrames(a, b, f) {
  const out = { colorsA: a.colors, colorsB: b.colors, colorMix: f, rim: hexToRgb(a.rim).map((v, i) => lerp(v, hexToRgb(b.rim)[i], f)) };
  for (const k of NUMERIC) out[k] = lerp(a[k], b[k], f);
  return out;
}

export function paramsFor({ energy, state }) {
  if (state === 'idle' || energy == null) return mixFrames(IDLE, IDLE, 0);
  const e = Math.min(100, Math.max(0, energy));
  let hi = KEYFRAMES[0];
  let lo = KEYFRAMES[KEYFRAMES.length - 1];
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    if (e <= KEYFRAMES[i].at && e >= KEYFRAMES[i + 1].at) {
      hi = KEYFRAMES[i];
      lo = KEYFRAMES[i + 1];
      break;
    }
  }
  const f = hi.at === lo.at ? 1 : (e - lo.at) / (hi.at - lo.at);
  let p = mixFrames(lo, hi, f);
  if (state === 'recovering') {
    const base = { ...p, colors: f >= 0.5 ? hi.colors : lo.colors, rim: rgbToHex(p.rim) };
    p = mixFrames(base, RECOVERING, 0.65);
  }
  return p;
}

export function createNebula(canvas, { scale = 1 } = {}) {
  const ctx = canvas.getContext('2d');
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr = Math.min((globalThis.devicePixelRatio || 1) * scale, 3);
  canvas.width = CW * dpr;
  canvas.height = CH * dpr;
  canvas.style.width = CW + 'px';
  canvas.style.height = CH + 'px';

  let target = paramsFor({ energy: null, state: 'idle' });
  const current = {};
  for (const k of NUMERIC) current[k] = target[k];
  current.rim = [...target.rim];

  const rand = (a, b) => a + Math.random() * (b - a);

  function pickColor() {
    const list = Math.random() < target.colorMix ? target.colorsB : target.colorsA;
    return list[Math.floor(Math.random() * list.length)];
  }

  function spawn(initial) {
    const inward = target.pull >= 0;
    const radius = initial
      ? rand(target.coreR + 5, MAXR)
      : (inward ? rand(MAXR * 0.6, MAXR) : rand(target.coreR * 0.7 + 2, target.coreR * 1.3 + 4));
    return {
      angle: rand(0, Math.PI * 2),
      radius,
      vr: inward ? rand(-0.16, -0.04) : rand(0.1, 0.24),
      size: rand(1.3, 3.4),
      rgb: hexToRgb(pickColor()),
      alpha: initial ? rand(0.3, 1) : 0,
      seed: rand(0, 1000),
    };
  }

  const particles = [];
  for (let i = 0; i < POOL; i++) particles.push(spawn(true));

  let raf = 0;
  let last = 0;
  const tickGap = reducedMotion ? 140 : 16;

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - last < tickGap) return;
    last = t;

    for (const k of NUMERIC) current[k] += (target[k] - current[k]) * 0.035;
    for (let i = 0; i < 3; i++) current.rim[i] += (target.rim[i] - current.rim[i]) * 0.035;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(5,5,9,0.26)';
    ctx.fillRect(0, 0, CW, CH);

    ctx.globalCompositeOperation = 'lighter';
    const count = Math.round(current.count);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (i >= count) {
        p.alpha += (0 - p.alpha) * 0.08;
      } else {
        p.vr += (-current.pull) * 0.012 + Math.sin(t * 0.0006 + p.seed) * 0.006;
        p.radius += p.vr * current.speed;
        p.angle += current.spin * (0.006 + 4 / (p.radius + 12) * 0.03) * current.speed;

        let targetAlpha = 1;
        if (p.radius < current.coreR * 1.4) {
          targetAlpha = Math.max(0, Math.min(1, (p.radius - current.coreR * 0.55) / (current.coreR * 0.85 + 1)));
        }
        p.alpha += (targetAlpha - p.alpha) * 0.09;

        if (p.radius < current.coreR * 0.55 || p.radius > MAXR + 6) {
          particles[i] = spawn(false);
          continue;
        }
      }
      if (p.alpha <= 0.01) continue;
      const x = CX + Math.cos(p.angle) * p.radius;
      const y = CY + Math.sin(p.angle) * p.radius * 0.6;
      const tw = 0.75 + 0.35 * Math.sin(t * 0.004 + p.seed);
      const r = p.size * 2.4 * tw;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]},${p.alpha * 0.9})`);
      g.addColorStop(1, `rgba(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    const rim = current.rim.map(Math.round);
    const glowR = current.coreR + 14;
    const cg = ctx.createRadialGradient(CX, CY, 0, CX, CY, glowR);
    cg.addColorStop(0, `rgba(${rim[0]},${rim[1]},${rim[2]},${current.glow * (1 - current.horizon * 0.6)})`);
    cg.addColorStop(1, `rgba(${rim[0]},${rim[1]},${rim[2]},0)`);
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(CX, CY, glowR, 0, Math.PI * 2);
    ctx.fill();

    if (current.horizon > 0.02) {
      ctx.save();
      ctx.shadowBlur = 14;
      ctx.shadowColor = rgbToHex(rim);
      ctx.strokeStyle = `rgba(${rim[0]},${rim[1]},${rim[2]},${current.horizon})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(CX, CY, current.coreR * 1.05, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = `rgba(2,2,4,${current.horizon})`;
      ctx.beginPath();
      ctx.arc(CX, CY, current.coreR * 0.72, 0, Math.PI * 2);
      ctx.fill();
    }

    const vg = ctx.createRadialGradient(CX, CY, MAXR * 0.35, CX, CY, MAXR * 0.98);
    vg.addColorStop(0, 'rgba(5,5,9,0)');
    vg.addColorStop(1, 'rgba(5,5,9,0.85)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, CW, CH);
  }

  return {
    setTarget(reading) { target = paramsFor(reading); },
    get rimColor() { return rgbToHex(current.rim); },
    get current() { return current; },
    start() { if (!raf) raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
}
