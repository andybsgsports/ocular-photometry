const KEY = 'ocular.readings.v1';
const MAX = 96;

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    // Storage can be unavailable (private mode, quota); the app still works without history.
  }
}

export function loadReadings() {
  return read();
}

// One entry per session, updated in place as the reading settles.
export function upsertReading(reading) {
  const list = read();
  const i = list.findIndex((r) => r.session === reading.session);
  if (i >= 0) list[i] = reading;
  else list.push(reading);
  write(list);
  return list;
}

export function previousReading(session) {
  const others = read().filter((r) => r.session !== session);
  return others.length ? others[others.length - 1] : null;
}

export function clearReadings() {
  write([]);
}

export function formatElapsed(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'under a minute';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}
