const test = require('node:test');
const assert = require('node:assert');

async function load() {
    return await import('../webui/src/lib/sources.js');
}

test('sourceOfKey / itemSource / shortKey', async () => {
    const s = await load();
    assert.strictEqual(s.sourceOfKey(468614), 'default');
    assert.strictEqual(s.sourceOfKey('xxx:539224'), 'xxx');
    assert.strictEqual(s.itemSource({ source: 'rox', galleryId: 1 }), 'rox');
    assert.strictEqual(s.itemSource({ galleryId: 'com:abc' }), 'com');
    assert.strictEqual(s.itemSource({ id: '77' }), 'default');
    assert.strictEqual(s.shortKey('com:amys-country'), 'amys-country');
    assert.strictEqual(s.shortKey(468614), '468614');
});

test('matchesSourceFilter and countBySource', async () => {
    const s = await load();
    const items = [{ galleryId: 1 }, { galleryId: 'xxx:1' }, { galleryId: 'xxx:2' }, { galleryId: 'com:z', source: 'com' }];
    assert.strictEqual(items.filter(i => s.matchesSourceFilter(i, 'all')).length, 4);
    assert.strictEqual(items.filter(i => s.matchesSourceFilter(i, null)).length, 4);
    assert.strictEqual(items.filter(i => s.matchesSourceFilter(i, 'xxx')).length, 2);
    const counts = s.countBySource(items);
    assert.deepStrictEqual([...counts.entries()].sort(), [['com', 1], ['default', 1], ['xxx', 2]]);
});

test('sourceLabel falls back to id', async () => {
    const s = await load();
    assert.strictEqual(s.sourceLabel('xxx', [{ id: 'xxx', label: 'Site' }]), 'Site');
    assert.strictEqual(s.sourceLabel('zzz', []), 'zzz');
    assert.strictEqual(s.sourceLabel('default', []), 'nhentai.net');
    assert.strictEqual(s.sourceLabel('default', undefined), 'nhentai.net');
    assert.strictEqual(s.sourceLabel('default', [{ id: 'default', label: 'Server Label' }]), 'Server Label');
});

test('urlKey recognises all four URL shapes and ids', async () => {
    const s = await load();
    assert.strictEqual(s.urlKey('https://nhentai.net/g/468614/'), '468614');
    assert.strictEqual(s.urlKey('https://nhentai.xxx/g/539224/'), 'xxx:539224');
    assert.strictEqual(s.urlKey('https://hentairox.com/gallery/817456/'), 'rox:817456');
    assert.strictEqual(s.urlKey('https://nhentai.com/en/comic/Some-Slug'), 'com:some-slug');
    assert.strictEqual(s.urlKey('xxx:5'), 'xxx:5');
    assert.strictEqual(s.urlKey('123456'), '123456');
    assert.strictEqual(s.urlKey('https://example.org/'), null);
});
