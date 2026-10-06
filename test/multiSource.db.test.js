const test = require('node:test');
const assert = require('node:assert');
const common = require('../core/db/common');
const { parseListText, parseListTextDetailed } = require('../core/db/listParser');

test('normalizeGalleryId returns canonical string keys and throws on junk', () => {
    assert.strictEqual(common.normalizeGalleryId(468614), '468614');
    assert.strictEqual(common.normalizeGalleryId('468614'), '468614');
    assert.strictEqual(common.normalizeGalleryId('xxx:539224'), 'xxx:539224');
    assert.throws(() => common.normalizeGalleryId('nope'), /Invalid gallery_id/);
    assert.throws(() => common.normalizeGalleryId(0), /Invalid gallery_id/);
    assert.strictEqual(common.isValidGalleryId('com:some-slug'), true);
    assert.strictEqual(common.isValidGalleryId('com:'), false);
});

test('formatQueueRow exposes toPublicId galleryId and derived source', () => {
    const legacy = common.formatQueueRow({ id: 1, gallery_id: '468614', url: 'u', status: 'PENDING' });
    assert.strictEqual(legacy.galleryId, 468614);
    assert.strictEqual(legacy.source, 'default');
    const prefixed = common.formatQueueRow({ id: 2, gallery_id: 'rox:817456', url: 'u', status: 'PENDING' });
    assert.strictEqual(prefixed.galleryId, 'rox:817456');
    assert.strictEqual(prefixed.source, 'rox');
});

test('parseListText: site B URL is not mistaken for a site A id (fallback regex ordering)', () => {
    const items = parseListText([
        'https://nhentai.xxx/g/539224/',
        'https://hentairox.com/gallery/817456/ | Some Title',
        'https://nhentai.com/en/comic/amys-country-wrangle-porn-comic',
        'https://nhentai.net/g/468614/',
        '123456',
        'com:another-slug'
    ].join('\n'));
    assert.deepStrictEqual(items.map(i => i.galleryId), [
        'xxx:539224', 'rox:817456', 'com:amys-country-wrangle-porn-comic', 468614, 123456, 'com:another-slug'
    ]);
    assert.strictEqual(items[1].title, 'Some Title');
    assert.strictEqual(items[0].url, 'https://nhentai.xxx/g/539224/');
});

test('parseListText: keeps batches/formats, dedupes, and counts ignored lines', () => {
    const { items, ignored } = parseListTextDetailed([
        '# BATCH 2 FORMAT=zip',
        'xxx:1',
        'xxx:1',
        'https://example.org/whatever',
        '# a comment',
        '999999'
    ].join('\n'), 'cbz');
    assert.deepStrictEqual(items.map(i => [i.galleryId, i.batch, i.format]), [['xxx:1', 2, 'zip'], [999999, 2, 'zip']]);
    assert.strictEqual(ignored, 1);
});

test('parseListText: legacy loose formats still work (id with trailing text, id anywhere via 5-7 digits)', () => {
    const items = parseListText('468614 | Title\nsee gallery 1234567 here');
    assert.deepStrictEqual(items.map(i => i.galleryId), [468614, 1234567]);
});
