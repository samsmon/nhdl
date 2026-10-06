function createBoardsProvider(cfg) {
    const { id, label, origin, galleryPath, hosts } = cfg;
    const hostPattern = hosts.map(h => h.replace(/\./g, '\\.')).join('|');

    function parseBody(body) {
        const s = String(body ?? '').trim();
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
    }

    return {
        id,
        label,
        prefix: id,
        isDefault: false,
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
        cfg
    };
}

module.exports = { createBoardsProvider };
