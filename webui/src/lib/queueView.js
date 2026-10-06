// Pure helpers for the queue view (status grouping, "added at" column, cooldown chip).
// Plain ES module without runes so node:test can import it (see test/webuiQueueView.test.js).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/;
const COOLDOWN_TYPES = { COOLDOWN: 'next', BATCH_REST: 'next', RATE_LIMIT: 'rate_limit' };

const pad = (n) => String(n).padStart(2, '0');

// "Queue" view = waiting items plus the one currently downloading.
export function isQueuedStatus(raw) {
  return raw === 'PENDING' || raw === 'ON_PROGRESS';
}

// SQLite stores UTC as "YYYY-MM-DD HH:MM:SS" without a zone marker; PostgreSQL returns ISO.
export function parseAddedAt(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const m = s.match(SQLITE_UTC);
  const d = new Date(m ? `${m[1]}T${m[2]}${m[3] || ''}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatAddedAt(value) {
  const d = parseAddedAt(value);
  if (!d) return '—';
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatAddedAtFull(value) {
  const d = parseAddedAt(value);
  if (!d) return '—';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// Under a minute -> "22s"; otherwise "m:ss" (minutes are not wrapped into hours).
export function formatCooldown(seconds) {
  const n = Number(seconds);
  const s = Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

// liveProgress is `{ type, remaining, message, title, ... }` from the engine `cooldown` event.
export function cooldownInfo(liveProgress, _engineStatus) {
  if (!liveProgress || typeof liveProgress !== 'object') return null;
  const kind = COOLDOWN_TYPES[liveProgress.type];
  if (!kind) return null;
  const remaining = liveProgress.remaining;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining <= 0) return null;
  return { kind, remaining, message: liveProgress.message || liveProgress.title || '' };
}
