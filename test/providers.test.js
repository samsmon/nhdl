const test = require('node:test');
const assert = require('node:assert');
const providers = require('../core/providers');

test('resolveInput: site A URL, bare id, and certain.site alias map to the default provider', () => {
    for (const input of ['https://nhentai.net/g/468614/', 'https://certain.site/g/468614', '468614', '0468614']) {
        const r = providers.resolveInput(input);
        assert.ok(r, input);
        assert.strictEqual(r.key, '468614');
        assert.strictEqual(r.provider.id, 'default');
        assert.strictEqual(r.url, 'https://nhentai.net/g/468614/');
    }
});

test('resolveInput: site B1/B2 URLs become prefixed keys and are NOT mistaken for site A ids', () => {
    const a = providers.resolveInput('https://nhentai.xxx/g/539224/');
    assert.strictEqual(a.key, 'xxx:539224');
    assert.strictEqual(a.provider.id, 'xxx');
    assert.strictEqual(a.url, 'https://nhentai.xxx/g/539224/');
    const b = providers.resolveInput('https://hentairox.com/gallery/817456/');
    assert.strictEqual(b.key, 'rox:817456');
    assert.strictEqual(b.url, 'https://hentairox.com/gallery/817456/');
});

test('resolveInput: site C URL becomes a lowercase slug key, with or without language segment', () => {
    for (const input of [
        'https://nhentai.com/en/comic/Amys-Country-Wrangle-Porn-Comic',
        'https://nhentai.com/comic/amys-country-wrangle-porn-comic/'
    ]) {
        const r = providers.resolveInput(input);
        assert.strictEqual(r.key, 'com:amys-country-wrangle-porn-comic');
        assert.strictEqual(r.provider.id, 'com');
        assert.strictEqual(r.url, 'https://nhentai.com/en/comic/amys-country-wrangle-porn-comic');
    }
});

test('resolveInput: prefixed keys round-trip and garbage is rejected', () => {
    assert.strictEqual(providers.resolveInput('xxx:539224').key, 'xxx:539224');
    assert.strictEqual(providers.resolveInput('com:some-slug').key, 'com:some-slug');
    for (const bad of ['', 'abc', 'xxx:abc', 'xxx:0', 'com:Not A Slug', 'zzz:123', 'https://example.org/g/1/', '-5', '0']) {
        assert.strictEqual(providers.resolveInput(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
});

test('canonicalKey accepts numbers and numeric strings, rejects non-positive and junk', () => {
    assert.strictEqual(providers.canonicalKey(468614), '468614');
    assert.strictEqual(providers.canonicalKey(' 468614 '), '468614');
    assert.strictEqual(providers.canonicalKey('rox:12'), 'rox:12');
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '12abc', 'rox:', 'rox:-1']) {
        assert.strictEqual(providers.canonicalKey(bad), null, String(bad));
    }
});

test('sourceOf / toPublicId / providerForKey', () => {
    assert.strictEqual(providers.sourceOf('468614'), 'default');
    assert.strictEqual(providers.sourceOf(468614), 'default');
    assert.strictEqual(providers.sourceOf('rox:12'), 'rox');
    assert.strictEqual(providers.sourceOf('zzz:12'), 'default');
    assert.strictEqual(providers.toPublicId('468614'), 468614);
    assert.strictEqual(providers.toPublicId('xxx:1'), 'xxx:1');
    assert.strictEqual(providers.providerForKey('com:x').id, 'com');
    assert.throws(() => providers.providerForKey('zzz:1'), /Unknown source/);
});

test('listSources lists every provider with a label, default first', () => {
    const s = providers.listSources();
    assert.deepStrictEqual(s.map(x => x.id), ['default', 'xxx', 'rox', 'com']);
    assert.ok(s.every(x => typeof x.label === 'string' && x.label.length > 0));
});
