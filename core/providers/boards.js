const PAGE_EXTS = ['webp', 'jpg', 'png', 'gif'];
const NON_LANGUAGE_FLAGS = new Set(['translated', 'rewritten', 'speechless', 'text-cleaned']);

function decodeEntities(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'");
}

function cleanTitle(raw) {
    const text = decodeEntities(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const stripped = text
        .replace(/^(?:\s*(?:\([^)]*\)|\[[^\]]*\]))+\s*/, '')
        .replace(/(?:\s*\[[^\]]*\])+\s*$/, '')
        .trim();
    return stripped || text;
}

function titleCaseSlug(slug) {
    return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function hiddenValue(html, name) {
    const m = html.match(new RegExp(`id="${name}"\\s+value="([^"]*)"`));
    return m ? m[1] : null;
}

function taxonomy(html, kind) {
    const out = [];
    const re = new RegExp(`href='/${kind}/([^'/]+)/'`, 'g');
    let m;
    while ((m = re.exec(html)) !== null) {
        if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
}

function createBoardsProvider(cfg) {
    const { id, label, origin, galleryPath, hosts, imageHost, imageBase } = cfg;
    const hostPattern = hosts.map(h => h.replace(/\./g, '\\.')).join('|');

    function parseBody(body) {
        const s = String(body ?? '').trim();
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
    }

    function imageHeaders() {
        return { Referer: `${origin}/` };
    }

    function parseGallery(key, html) {
        const server = hiddenValue(html, 'load_server');
        const dir = hiddenValue(html, 'load_dir');
        const loadId = hiddenValue(html, 'load_id');
        const pages = parseInt(hiddenValue(html, 'load_pages'), 10);
        // These values end up in image URLs, so they must be plain tokens, not arbitrary remote text.
        if (!server || !dir || !loadId || !Number.isFinite(pages) || pages <= 0
            || !/^[0-9]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(dir) || !/^[A-Za-z0-9_-]+$/.test(loadId)) {
            throw new Error('Gallery page is blocked or unexpected page layout (no page data found)');
        }

        const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        const title = h1 ? cleanTitle(h1[1]) : '';

        const artists = taxonomy(html, 'artist');
        const groups = taxonomy(html, 'group');
        const authorSlug = artists[0] || groups[0] || null;
        const languages = taxonomy(html, 'language').filter(l => !NON_LANGUAGE_FLAGS.has(l));
        const tags = taxonomy(html, 'tag').map(slug => ({ name: slug.replace(/-/g, ' ') }));
        const host = imageHost(server);

        return {
            title: title || `Gallery ${key.slice(id.length + 1)}`,
            numPages: pages,
            ext: PAGE_EXTS[0],
            pageExts: {},
            langStr: languages[0] ? titleCaseSlug(languages[0]) : 'Unknown',
            authorStr: authorSlug ? titleCaseSlug(authorSlug) : 'Other',
            extraMeta: { tags, source: id },
            pageUrls(n) {
                return PAGE_EXTS.map(ext => ({
                    ext,
                    url: imageBase
                        ? imageBase(host, dir, loadId, n, ext)
                        : `https://${host}/${dir}/${loadId}/${n}.${ext}`
                }));
            }
        };
    }

    return {
        id,
        label,
        prefix: id,
        isDefault: false,
        transport: 'node',
        origin,
        urlPatterns: [new RegExp(`^https?:\\/\\/(?:www\\.)?(?:${hostPattern})\\/${galleryPath}\\/(\\d+)`, 'i')],
        parseBody,
        makeKey(body) {
            const n = parseBody(body);
            return n ? `${id}:${n}` : null;
        },
        buildUrl(key) {
            return `${origin}/${galleryPath}/${key.slice(id.length + 1)}/`;
        },
        imageHeaders,
        async fetchMeta(key, { fetchText }) {
            const url = this.buildUrl(key);
            const res = await fetchText(url, imageHeaders());
            if (res.status === 404) {
                const e = new Error('404 - gallery not found / already removed');
                e.permanent = true;
                throw e;
            }
            if (res.status !== 200) {
                const e = new Error(`Gallery page returned status ${res.status}`);
                e.statusCode = res.status;
                throw e;
            }
            return parseGallery(key, res.body);
        },
        cfg
    };
}

module.exports = { createBoardsProvider, PAGE_EXTS };
