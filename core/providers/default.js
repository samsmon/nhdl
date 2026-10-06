const POSITIVE_INT = /^\d+$/;

function parseBody(body) {
    const s = String(body ?? '').trim();
    if (!POSITIVE_INT.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

module.exports = {
    id: 'default',
    label: 'nhentai.net',
    prefix: null,
    isDefault: true,
    urlPatterns: [/^https?:\/\/(?:www\.)?(?:nhentai\.net|certain\.site)\/g\/(\d+)/i],
    parseBody,
    makeKey: parseBody,
    buildUrl: (key) => `https://nhentai.net/g/${key}/`,
    imageHeaders: () => ({ Referer: 'https://nhentai.net/' })
};
