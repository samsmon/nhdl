const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function createSlugApiProvider(cfg) {
    const { id, label, origin, hosts } = cfg;
    const hostPattern = hosts.map(h => h.replace(/\./g, '\\.')).join('|');

    function parseBody(body) {
        const s = String(body ?? '').trim().toLowerCase();
        return SLUG.test(s) ? s : null;
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
        cfg
    };
}

module.exports = { createSlugApiProvider };
