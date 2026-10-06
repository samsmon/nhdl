// Pure helpers for the content type (comic / manga / other) shown in the queue and library.
export const TYPE_ORDER = ['comic', 'manga', 'other'];

const LABELS = { comic: 'Comic', manga: 'Manga', other: 'Other' };

const BADGE_CLASSES = {
  comic: 'bg-[#2a1f0a] text-[#fbbf24] border border-[#78350f]',
  manga: 'bg-[#1f1030] text-[#c4b5fd] border border-[#4c1d95]',
  other: 'bg-[#1a1a1a] text-[#9ca3af] border border-[#374151]'
};

export function typeLabel(type) {
  return LABELS[type] || '';
}

export function itemType(item) {
  const c = item && item.category;
  return TYPE_ORDER.includes(c) ? c : null;
}

export function matchesTypeFilter(item, filter) {
  if (!filter || filter === 'all') return true;
  return itemType(item) === filter;
}

export function countByType(items) {
  const counts = new Map();
  for (const item of items) {
    const t = itemType(item);
    if (t) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

export function typeBadgeClass(type) {
  return BADGE_CLASSES[type] || BADGE_CLASSES.other;
}
