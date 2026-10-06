// Pure helpers shared by the queue/library UI. Prefixes mirror core/providers (kept in sync
// by test/webuiSources.test.js and the server-provided `sources` list for labels).
const KNOWN_PREFIXES = ['xxx', 'rox', 'com'];

export function sourceOfKey(key) {
  const s = String(key ?? '');
  const i = s.indexOf(':');
  if (i > 0 && KNOWN_PREFIXES.includes(s.slice(0, i))) return s.slice(0, i);
  return 'default';
}

export function itemSource(item) {
  if (!item) return 'default';
  if (item.source) return item.source;
  return sourceOfKey(item.galleryId ?? item.id);
}

export function matchesSourceFilter(item, filter) {
  if (!filter || filter === 'all') return true;
  return itemSource(item) === filter;
}

export function countBySource(items) {
  const counts = new Map();
  for (const item of items) {
    const id = itemSource(item);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

export function sourceLabel(id, sources) {
  const found = (sources || []).find((s) => s.id === id);
  if (found) return found.label;
  return id === 'default' ? 'nhentai.net' : id;
}

export function shortKey(key) {
  const s = String(key ?? '');
  const i = s.indexOf(':');
  return i > 0 ? s.slice(i + 1) : s;
}

export function urlKey(raw) {
  const s = String(raw ?? '').trim();
  let m = s.match(/^(xxx|rox|com):(.+)$/i);
  if (m) return `${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
  m = s.match(/^https?:\/\/(?:www\.)?nhentai\.xxx\/g\/(\d+)/i);
  if (m) return `xxx:${Number(m[1])}`;
  m = s.match(/^https?:\/\/(?:www\.)?hentairox\.com\/gallery\/(\d+)/i);
  if (m) return `rox:${Number(m[1])}`;
  m = s.match(/^https?:\/\/(?:www\.)?nhentai\.com\/(?:[a-z]{2}\/)?comic\/([A-Za-z0-9-]+)/i);
  if (m) return `com:${m[1].toLowerCase()}`;
  m = s.match(/^https?:\/\/(?:www\.)?(?:nhentai\.net|certain\.site)\/g\/(\d+)/i);
  if (m) return String(Number(m[1]));
  if (/^\d+$/.test(s)) return String(Number(s));
  return null;
}
