const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function extOf(url) {
    const m = String(url).match(/\.(webp|jpe?g|png|gif)(?:\?|$)/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

function createSlugApiProvider(cfg) {
    const { id, label, origin, hosts } = cfg;
    const hostPattern = hosts.map(h => h.replace(/\./g, '\\.')).join('|');

    function parseBody(body) {
        const s = String(body ?? '').trim().toLowerCase();
        return SLUG.test(s) ? s : null;
    }

    function imageHeaders() {
        return { Referer: `${origin}/` };
    }

    return {
        id,
        label,
        prefix: id,
        isDefault: false,
        origin,
        urlPatterns: [new RegExp(`^https?:\\/\\/(?:www\\.)?(?:${hostPattern})\\/(?:[a-z]{2}\\/)?comic\\/([A-Za-z0-9-]+)`, 'i')],
        parseBody,
        makeKey(body) {
            const slug = parseBody(body);
            return slug ? `${id}:${slug}` : null;
        },
        buildUrl(key) {
            return `${origin}/en/comic/${key.slice(id.length + 1)}`;
        },
        imageHeaders,
        async fetchMeta(key, { fetchText }) {
            const slug = key.slice(id.length + 1);
            const res = await fetchText(`${origin}/api/comics/${slug}/images`, imageHeaders());
            if (res.status === 404) {
                const e = new Error('404 - comic not found / already removed');
                e.permanent = true;
                throw e;
            }
            if (res.status !== 200) throw new Error(`Comic API returned status ${res.status}`);

            let data;
            try { data = JSON.parse(res.body); } catch (e) { data = null; }
            if (!data || !data.comic || !Array.isArray(data.images) || data.images.length === 0) {
                throw new Error('Unexpected response from comic API (blocked page or changed format)');
            }

            const images = [...data.images].sort((a, b) => a.page - b.page);
            const pageExts = {};
            const urlsByPage = new Map();
            images.forEach((img, i) => {
                const n = i + 1;
                pageExts[n] = extOf(img.source_url);
                urlsByPage.set(n, img.source_url);
            });

            const rawTitle = String(data.comic.title || '').replace(/\s+porn comic$/i, '').trim();
            const authorMatch = String(data.comic.description || '').match(/\bporn comic by ([^.]+?)\./i);
            const tags = (data.comic.tags || []).map(t => ({ name: t.slug }));

            return {
                title: rawTitle || slug,
                numPages: images.length,
                ext: pageExts[1],
                pageExts,
                langStr: 'English',
                authorStr: authorMatch ? authorMatch[1].trim() : 'Other',
                extraMeta: { tags, source: id, uploadDate: data.comic.uploaded_at || null },
                pageUrls(n) {
                    const url = urlsByPage.get(n);
                    return url ? [{ ext: pageExts[n], url }] : [];
                }
            };
        },
        cfg
    };
}

module.exports = { createSlugApiProvider };
