const TYPE_LABELS = { comic: 'Comic', manga: 'Manga', other: 'Other' };

const COMIC_SLUGS = new Set(['western', 'porn-comic', 'comic']);
const MANGA_SLUGS = new Set(['manga', 'doujinshi']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

function normalizeCategorySlug(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().toLowerCase();
    return SLUG.test(s) ? s : null;
}

function mapCategoryToType(raw) {
    const slug = normalizeCategorySlug(raw);
    if (!slug) return null;
    if (COMIC_SLUGS.has(slug)) return 'comic';
    if (MANGA_SLUGS.has(slug)) return 'manga';
    return 'other';
}

function isContentType(v) {
    return v === 'comic' || v === 'manga' || v === 'other';
}

// Folder names come only from this fixed table, never from remote text.
function typeFolderName(type) {
    return isContentType(type) ? TYPE_LABELS[type] : null;
}

module.exports = { TYPE_LABELS, normalizeCategorySlug, mapCategoryToType, isContentType, typeFolderName };
