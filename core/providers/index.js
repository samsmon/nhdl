const defaultProvider = require('./default');
const { createBoardsProvider } = require('./boards');
const { createSlugApiProvider } = require('./slugapi');

const PROVIDERS = [
    defaultProvider,
    createBoardsProvider({
        id: 'xxx',
        label: 'nhentai.xxx',
        origin: 'https://nhentai.xxx',
        hosts: ['nhentai.xxx'],
        galleryPath: 'g',
        imageHost: (server) => `i${server}.nhentaimg.com`
    }),
    createBoardsProvider({
        id: 'rox',
        label: 'hentairox.com',
        origin: 'https://hentairox.com',
        hosts: ['hentairox.com'],
        galleryPath: 'gallery',
        imageHost: (server) => `m${server}.hentairox.com`
    }),
    createSlugApiProvider({
        id: 'com',
        label: 'nhentai.com',
        origin: 'https://nhentai.com',
        hosts: ['nhentai.com']
    })
];

function registerProvider(provider) {
    const i = PROVIDERS.findIndex(p => p.id === provider.id);
    if (i === -1) PROVIDERS.push(provider);
    else PROVIDERS[i] = provider;
}

function byPrefix(prefix) {
    return PROVIDERS.find(p => p.prefix === prefix) || null;
}

function resolveInput(text) {
    const s = String(text ?? '').trim();
    if (!s) return null;

    const prefixed = s.match(/^([a-z][a-z0-9]*):(.+)$/i);
    if (prefixed && !/^https?$/i.test(prefixed[1])) {
        const provider = byPrefix(prefixed[1].toLowerCase());
        if (!provider) return null;
        const key = provider.makeKey(prefixed[2]);
        return key ? { provider, key, url: provider.buildUrl(key) } : null;
    }

    for (const provider of PROVIDERS) {
        for (const re of provider.urlPatterns) {
            const m = s.match(re);
            if (m) {
                const key = provider.makeKey(m[1]);
                return key ? { provider, key, url: provider.buildUrl(key) } : null;
            }
        }
    }

    const key = defaultProvider.makeKey(s);
    return key ? { provider: defaultProvider, key, url: defaultProvider.buildUrl(key) } : null;
}

function canonicalKey(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'number') {
        if (!Number.isInteger(input)) return null;
        return defaultProvider.makeKey(String(input));
    }
    const s = String(input).trim();
    if (/^https?:\/\//i.test(s)) return null;
    const r = resolveInput(s);
    return r ? r.key : null;
}

function providerForKey(key) {
    const s = String(key);
    const i = s.indexOf(':');
    if (i === -1) return defaultProvider;
    const provider = byPrefix(s.slice(0, i));
    if (!provider) throw new Error(`Unknown source in gallery key: ${s}`);
    return provider;
}

function sourceOf(key) {
    try { return providerForKey(key).id; } catch (e) { return 'default'; }
}

function toPublicId(key) {
    const s = String(key);
    return /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : s;
}

function listSources() {
    return PROVIDERS.map(p => ({ id: p.id, label: p.label }));
}

module.exports = {
    PROVIDERS,
    defaultProvider,
    registerProvider,
    resolveInput,
    canonicalKey,
    providerForKey,
    sourceOf,
    toPublicId,
    listSources
};
