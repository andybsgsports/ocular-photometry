import { createLandmarker, readEyes, IDX } from './landmarker.js';
import { EyeMetrics, STATES } from './metrics.js';
import { createNebula } from './nebula.js';
import { upsertReading, previousReading, loadReadings, clearReadings, formatElapsed } from './store.js';

const $ = (id) => document.getElementById(id);
const els = {
  clock: $('clock'), irBadge: $('irBadge'), phaseBadge: $('phaseBadge'),
  eyeShell: $('eyeShell'), nebula: $('nebula'),
  energyNum: $('energyNum'), stateLabel: $('stateLabel'), stateCaption: $('stateCaption'),
  calBar: $('calBar'), calFill: $('calFill'), status: $('status'),
  startBtn: $('startBtn'), previewBtn: $('previewBtn'), recalBtn: $('recalBtn'), clearBtn: $('clearBtn'),
  preview: $('preview'), cam: $('cam'), overlay: $('overlay'),
  mPerclos: $('mPerclos'), mBlinkRate: $('mBlinkRate'), mBlinkDur: $('mBlinkDur'),
  mRest: $('mRest'), mGaze: $('mGaze'), mFace: $('mFace'), mLight: $('mLight'),
  delta: $('delta'), history: $('historyStrip'),
  onboard: $('onboard'), onboardEyebrow: $('onboardEyebrow'), onboardTitle: $('onboardTitle'),
  onboardBody: $('onboardBody'), onboardTimer: $('onboardTimer'), onboardSkip: $('onboardSkip'),
  cameraPicker: $('cameraPicker'), cameraSelect: $('cameraSelect'),
};

const COPY = {
  idle: ['Waiting for the camera', 'Start a reading to let the page look at your eyes. Nothing leaves this device.'],
  loading: ['Loading', 'Fetching the vision runtime and face model.'],
  error: ['Something got in the way', ''],
  'no-face': ['No eyes in frame', 'Face the camera in decent light, about an arm\'s length away.'],
  [STATES.CALIBRATING]: ['Calibrating', 'Hold still a moment — learning what your open eyes look like.'],
  [STATES.REPLENISHED]: ['Replenished', 'Clear signal. Structure holds all the way to the core.'],
  [STATES.FATIGUED]: ['Fatigued', 'Dimming. The outer arms are the first to fade.'],
  [STATES.DEPLETED]: ['Depleted', 'Mostly dark. A thin ring is what is left of the light.'],
  [STATES.CRITICAL]: ['Critical', 'Past the horizon. Nothing here escapes on its own.'],
  [STATES.RECOVERING]: ['Recovering', 'An accretion disk, rebuilding turn by turn.'],
};

const SAVE_EVERY_MS = 30_000;
const FACE_LOST_MS = 1_200;
const CAMERA_KEY = 'ocular.cameraId';
const LIGHT_DARK = 55;
const LIGHT_BRIGHT = 225;

const ONBOARD_KEY = 'ocular.onboarded.v1';
const ONBOARD_STEPS = {
  calibrating: {
    eyebrow: 'Calibrating',
    title: 'Learning your baseline',
    body: 'Look at the camera the way you normally would for the next few seconds. This learns what "eyes open" looks like for you, so glasses or naturally heavy lids aren’t mistaken for fatigue.',
  },
  prompt: {
    eyebrow: 'Try it',
    title: 'Close your eyes now',
    body: 'Gently close your eyes and hold them shut until this reaches zero.',
  },
  result: {
    eyebrow: 'That’s the reading responding',
    title: 'Open again to recover',
    body: 'Closed eyes pull the sky toward its core; open, alert eyes bring it back. Explore freely — Reset baseline recalibrates any time.',
  },
};

const session = Date.now();
const metrics = new EyeMetrics();
const eyeScale = parseFloat(getComputedStyle(els.eyeShell).getPropertyValue('--eye-scale')) || 1;
const nebula = createNebula(els.nebula, { scale: eyeScale });
nebula.start();

let landmarker = null;
let stream = null;
let running = false;
let phase = 'idle';
let lastFaceAt = 0;
let lastUiAt = 0;
let lastSaveAt = 0;
let lastVideoTime = -1;
let latestSnapshot = null;
let onboardSeen = localStorage.getItem(ONBOARD_KEY) === '1';
let onboardActive = false;
let onboardHandle = null;
let lightingEma = null;

const lightCanvas = document.createElement('canvas');
lightCanvas.width = 12;
lightCanvas.height = 9;
const lightCtx = lightCanvas.getContext('2d', { willReadFrequently: true });

function sampleLuminance(video) {
  lightCtx.drawImage(video, 0, 0, lightCanvas.width, lightCanvas.height);
  const { data } = lightCtx.getImageData(0, 0, lightCanvas.width, lightCanvas.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return sum / (data.length / 4);
}

function updateLighting() {
  if (!els.cam.videoWidth) return;
  const lum = sampleLuminance(els.cam);
  lightingEma = lightingEma == null ? lum : lightingEma + (lum - lightingEma) * 0.25;
}

function lightingLabel() {
  if (lightingEma == null) return null;
  if (lightingEma < LIGHT_DARK) return 'Low';
  if (lightingEma > LIGHT_BRIGHT) return 'Bright';
  return 'Good';
}

function labelForCamera(device, index) {
  const raw = device.label || `Camera ${index + 1}`;
  return /infrared|\bir\b|windows hello/i.test(raw) ? `${raw} (IR — steadier in low light)` : raw;
}

async function refreshCameraList(selectedId) {
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const cams = devices.filter((d) => d.kind === 'videoinput');
  if (cams.length < 2) {
    els.cameraPicker.hidden = true;
    return;
  }
  els.cameraSelect.replaceChildren(...cams.map((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = labelForCamera(d, i);
    return opt;
  }));
  els.cameraSelect.selectedIndex = selectedId ? cams.findIndex((d) => d.deviceId === selectedId) : -1;
  if (els.cameraSelect.selectedIndex < 0) els.cameraSelect.selectedIndex = 0;
  els.cameraPicker.hidden = false;
}

async function switchCamera(deviceId) {
  if (!running) return;
  status('Switching camera…');
  stream?.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    console.error(err);
    status(null);
    return;
  }
  els.cam.srcObject = stream;
  await els.cam.play();
  lastVideoTime = -1;
  lastFaceAt = 0;
  lightingEma = null;
  metrics.recalibrate();
  latestSnapshot = null;
  status(null);
  setPhase('no-face');
}

function showOnboardStep(key) {
  const step = ONBOARD_STEPS[key];
  els.onboardEyebrow.textContent = step.eyebrow;
  els.onboardTitle.textContent = step.title;
  els.onboardBody.textContent = step.body;
  els.onboard.hidden = false;
}

function onboardCountdown(seconds, { visible, onDone }) {
  clearInterval(onboardHandle);
  let remaining = seconds;
  els.onboardTimer.hidden = !visible;
  if (visible) els.onboardTimer.textContent = String(remaining);
  onboardHandle = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(onboardHandle);
      onboardHandle = null;
      onDone();
    } else if (visible) {
      els.onboardTimer.textContent = String(remaining);
    }
  }, 1000);
}

function beginOnboarding() {
  if (onboardSeen) return;
  localStorage.setItem(ONBOARD_KEY, '1');
  onboardSeen = true;
  onboardActive = true;
  showOnboardStep('calibrating');
}

function continueOnboarding() {
  if (!onboardActive) return;
  onboardActive = false;
  showOnboardStep('prompt');
  onboardCountdown(6, {
    visible: true,
    onDone: () => {
      showOnboardStep('result');
      onboardCountdown(4, { visible: false, onDone: endOnboarding });
    },
  });
}

function endOnboarding() {
  clearInterval(onboardHandle);
  onboardHandle = null;
  onboardActive = false;
  els.onboard.hidden = true;
  els.onboardTimer.hidden = true;
}

function setCopy(key, detail) {
  const [label, caption] = COPY[key];
  els.stateLabel.textContent = label;
  els.stateCaption.textContent = detail ?? caption;
}

function setPhase(next) {
  phase = next;
  document.body.dataset.phase = next;
  els.phaseBadge.textContent = next.replace('-', ' ');
  els.irBadge.hidden = !running;
  els.recalBtn.disabled = !running;
  els.calBar.hidden = next !== STATES.CALIBRATING;
  if (next !== 'reading') {
    setCopy(next === STATES.CALIBRATING ? STATES.CALIBRATING : next);
    if (next !== STATES.CALIBRATING) els.energyNum.textContent = '—';
  }
  if (next === STATES.CALIBRATING) beginOnboarding();
  if (next === 'idle' || next === 'no-face' || next === 'error' || next === 'loading') {
    nebula.setTarget({ energy: null, state: 'idle' });
  }
}

function status(text) {
  els.status.hidden = !text;
  els.status.textContent = text ?? '';
}

function explain(err) {
  switch (err?.name) {
    case 'NotAllowedError': return 'Camera permission was denied. Allow camera access for this site, then try again.';
    case 'NotFoundError': return 'No camera was found on this device.';
    case 'NotReadableError': return 'The camera is busy in another app. Close it and try again.';
    case 'SecurityError': return 'The camera only works on HTTPS (or localhost).';
    default:
      if (!navigator.mediaDevices?.getUserMedia) return 'This browser can\'t reach the camera here — the page has to be served over HTTPS or localhost.';
      return `Couldn't get started: ${err?.message ?? err}. Check your connection and try again.`;
  }
}

async function start() {
  els.startBtn.disabled = true;
  try {
    setPhase('loading');
    status('Loading vision runtime…');
    landmarker ??= await createLandmarker({ onStage: status });
    status('Requesting camera…');
    const savedCameraId = localStorage.getItem(CAMERA_KEY);
    const wantDevice = savedCameraId ? { deviceId: { exact: savedCameraId } } : { facingMode: 'user' };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...wantDevice, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err) {
      if (savedCameraId && err.name === 'OverconstrainedError') {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
      } else {
        throw err;
      }
    }
    els.cam.srcObject = stream;
    await els.cam.play();
    running = true;
    lastVideoTime = -1;
    lightingEma = null;
    status(null);
    await refreshCameraList(stream.getVideoTracks()[0]?.getSettings().deviceId);
    setPhase('no-face');
    els.startBtn.textContent = 'Stop';
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    running = false;
    setPhase('error');
    setCopy('error', explain(err));
    status(null);
  } finally {
    els.startBtn.disabled = false;
  }
}

function stop() {
  running = false;
  endOnboarding();
  saveReading(true);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.cam.srcObject = null;
  clearOverlay();
  els.startBtn.textContent = 'Start reading';
  setPhase('idle');
}

function loop() {
  if (!running) return;
  const v = els.cam;
  if (v.readyState >= 2 && v.currentTime !== lastVideoTime) {
    lastVideoTime = v.currentTime;
    const result = landmarker.detectForVideo(v, performance.now());
    const eyes = readEyes(result);
    const t = Date.now();
    if (eyes) {
      lastFaceAt = t;
      metrics.push({ t, closure: eyes.closure, gazeX: eyes.gazeX, gazeY: eyes.gazeY });
      if (!els.preview.hidden) drawOverlay(eyes.landmarks);
    } else if (!els.preview.hidden) {
      clearOverlay();
    }
    if (t - lastUiAt > 150) {
      lastUiAt = t;
      updateLighting();
      render(t);
    }
  }
  requestAnimationFrame(loop);
}

function render(t) {
  const light = lightingLabel();
  els.mLight.textContent = light ?? '—';
  els.mLight.classList.toggle('warn', light === 'Low' || light === 'Bright');

  if (t - lastFaceAt > FACE_LOST_MS) {
    if (phase !== 'no-face') setPhase('no-face');
    return;
  }
  const s = metrics.snapshot(t);
  latestSnapshot = s;
  if (!s.calibrated) {
    if (phase !== STATES.CALIBRATING) setPhase(STATES.CALIBRATING);
    els.calFill.style.width = `${Math.round(s.calibrationProgress * 100)}%`;
    setCopy(STATES.CALIBRATING, light && light !== 'Good'
      ? `${COPY[STATES.CALIBRATING][1]} Lighting looks ${light.toLowerCase()} — try a brighter, even light.`
      : undefined);
    return;
  }
  if (phase !== 'reading') {
    setPhase('reading');
    continueOnboarding();
  }

  els.energyNum.textContent = String(s.energy);
  setCopy(s.state);
  els.stateLabel.dataset.state = s.state;
  nebula.setTarget({ energy: s.energy, state: s.state });
  els.eyeShell.style.setProperty('--rim-color', nebula.rimColor);

  els.mPerclos.textContent = `${(s.perclos * 100).toFixed(1)}%`;
  els.mBlinkRate.textContent = s.blinkRate == null ? 'measuring…' : `${s.blinkRate.toFixed(0)} / min`;
  els.mBlinkDur.textContent = s.blinkDurationMs == null ? 'no blinks yet' : `${Math.round(s.blinkDurationMs)} ms`;
  els.mRest.textContent = `${Math.round(s.restClosure * 100)}% closed`;
  els.mGaze.textContent = s.gazeJitter == null ? '—' : s.gazeJitter.toFixed(3);
  els.mFace.textContent = formatFaceTime(s.faceMs);

  renderDelta(s, t);
  if (t - lastSaveAt > SAVE_EVERY_MS) saveReading(false, t);
}

function formatFaceTime(ms) {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

function renderDelta(s, t) {
  const prev = previousReading(session);
  if (!prev) {
    els.delta.textContent = 'First reading on this device.';
    return;
  }
  if (!s) {
    els.delta.innerHTML = `Last exposure <b>${formatElapsed(t - prev.t)}</b> ago read <b>${prev.energy}</b>. Start a reading to compare.`;
    return;
  }
  const d = s.energy - prev.energy;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  els.delta.innerHTML = `Last exposure <b>${formatElapsed(t - prev.t)}</b> ago read <b>${prev.energy}</b> · now <b>${s.energy}</b> · <b class="delta-${d >= 0 ? 'up' : 'down'}">${sign}${Math.abs(d)}</b> since then`;
}

function saveReading(force, t = Date.now()) {
  const s = latestSnapshot;
  if (!s?.calibrated || s.energy == null) return;
  if (!force && t - lastSaveAt < SAVE_EVERY_MS) return;
  lastSaveAt = t;
  upsertReading({
    session,
    t,
    energy: s.energy,
    state: s.state,
    perclos: Number(s.perclos.toFixed(3)),
    blinkRate: s.blinkRate == null ? null : Number(s.blinkRate.toFixed(1)),
    blinkDurationMs: s.blinkDurationMs == null ? null : Math.round(s.blinkDurationMs),
    faceMs: Math.round(s.faceMs),
  });
  renderHistory();
}

function renderHistory() {
  const list = loadReadings();
  els.history.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'history-empty';
    empty.textContent = 'No readings yet.';
    els.history.append(empty);
    return;
  }
  for (const r of list.slice(-32)) {
    const bar = document.createElement('span');
    bar.className = `bar state-${r.state}`;
    bar.style.height = `${8 + r.energy * 0.48}px`;
    bar.title = `${new Date(r.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${r.energy} · ${r.state}`;
    if (r.session === session) bar.classList.add('current');
    els.history.append(bar);
  }
}

function sizeOverlay() {
  const { videoWidth: w, videoHeight: h } = els.cam;
  if (w && (els.overlay.width !== w || els.overlay.height !== h)) {
    els.overlay.width = w;
    els.overlay.height = h;
  }
}

function drawOverlay(lm) {
  sizeOverlay();
  const c = els.overlay;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(94,200,192,0.9)';
  ctx.fillStyle = 'rgba(217,164,65,0.95)';
  ctx.lineWidth = 1.5;
  for (const ring of [IDX.rightRing, IDX.leftRing]) {
    ctx.beginPath();
    ring.forEach((i, k) => {
      const x = lm[i].x * c.width;
      const y = lm[i].y * c.height;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  for (const i of [IDX.rightIris, IDX.leftIris]) {
    ctx.beginPath();
    ctx.arc(lm[i].x * c.width, lm[i].y * c.height, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function clearOverlay() {
  const c = els.overlay;
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

function tickClock() {
  els.clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

els.startBtn.addEventListener('click', () => (running ? stop() : start()));
els.previewBtn.addEventListener('click', () => {
  els.preview.hidden = !els.preview.hidden;
  els.previewBtn.textContent = els.preview.hidden ? 'Show camera' : 'Hide camera';
  if (els.preview.hidden) clearOverlay();
});
els.recalBtn.addEventListener('click', () => {
  metrics.recalibrate();
  latestSnapshot = null;
  if (running) setPhase(STATES.CALIBRATING);
});
els.onboardSkip.addEventListener('click', endOnboarding);
els.cameraSelect.addEventListener('change', () => {
  const id = els.cameraSelect.value;
  localStorage.setItem(CAMERA_KEY, id);
  switchCamera(id);
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (running) refreshCameraList(stream?.getVideoTracks()[0]?.getSettings().deviceId);
});
els.clearBtn.addEventListener('click', () => {
  clearReadings();
  renderHistory();
  els.delta.textContent = 'First reading on this device.';
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveReading(true);
});
window.addEventListener('pagehide', () => saveReading(true));

tickClock();
setInterval(tickClock, 15_000);
renderHistory();
renderDelta(null, Date.now());
setPhase('idle');
if (!navigator.mediaDevices?.getUserMedia) {
  setPhase('error');
  setCopy('error', explain(new TypeError('mediaDevices unavailable')));
  els.startBtn.disabled = true;
}
