const { resolveInput, defaultProvider, toPublicId } = require('../providers');

const LEGACY_PATTERNS = [
    /(?:(?:nhentai\.net|certain\.site)\/g\/|^)\s*(\d+)\b/i,
    /\b(\d{5,7})\b/
];

const SITE_A_HOST = /(?:^|\.)(?:nhentai\.net|certain\.site)$/i;

function resolveLine(head, line) {
    const direct = resolveInput(head);
    if (direct) return direct;
    // Legacy loose formats are site A only, and only for lines that do not look like a
    // URL of some other host (otherwise "https://other/g/539224/" would match \b\d{5,7}\b).
    if (/^https?:\/\//i.test(head)) return null;
    // Scheme-less URL of a known provider ("host.tld/g/123/"): resolve it as https.
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}\//i.test(head)) {
        const viaHttps = resolveInput('https://' + head);
        if (viaHttps) return viaHttps;
    }
    // A host-like token that no provider recognized (and that is not site A) must not fall
    // through to the digit fallbacks, or an unknown site's id would become a site A download.
    const hostLike = line.match(/(?:^|[^a-z0-9.-])((?:[a-z0-9-]+\.)+[a-z]{2,})\//i);
    if (hostLike && !SITE_A_HOST.test(hostLike[1])) return null;
    for (const re of LEGACY_PATTERNS) {
        const m = line.match(re);
        if (!m) continue;
        const key = defaultProvider.makeKey(m[1]);
        if (key) return { provider: defaultProvider, key, url: defaultProvider.buildUrl(key) };
    }
    return null;
}

function parseListTextDetailed(text, defaultFormat = null) {
    const lines = String(text || '').split(/\r?\n/);
    let currentBatch = 1;
    let currentFormat = defaultFormat;
    const items = [];
    const seen = new Set();
    let ignored = 0;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const batchMatch = line.match(/^#\s*BATCH\s+(\d+)(?:\s+FORMAT=(\w+))?/i);
        if (batchMatch) {
            currentBatch = parseInt(batchMatch[1], 10);
            currentFormat = batchMatch[2] ? batchMatch[2].toLowerCase() : defaultFormat;
            continue;
        }
        if (line.startsWith('#')) continue;

        const pipeIdx = line.indexOf('|');
        const head = (pipeIdx === -1 ? line : line.slice(0, pipeIdx)).trim();
        const resolved = resolveLine(head, line);
        if (!resolved) { ignored++; continue; }
        if (seen.has(resolved.key)) continue;
        seen.add(resolved.key);

        let title = null;
        if (pipeIdx !== -1) {
            const afterPipe = line.slice(pipeIdx + 1).trim();
            if (afterPipe) title = afterPipe;
        }

        items.push({
            galleryId: toPublicId(resolved.key),
            url: resolved.url,
            title,
            batch: currentBatch,
            format: currentFormat
        });
    }

    return { items, ignored };
}

function parseListText(text, defaultFormat = null) {
    return parseListTextDetailed(text, defaultFormat).items;
}

module.exports = { parseListText, parseListTextDetailed };
