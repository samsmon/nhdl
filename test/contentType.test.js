const test = require('node:test');
const assert = require('node:assert');
const ct = require('../core/providers/contentType');

test('mapCategoryToType maps known slugs, case-insensitively', () => {
    for (const s of ['western', 'porn-comic', 'comic', 'Western', ' PORN-COMIC ']) {
        assert.strictEqual(ct.mapCategoryToType(s), 'comic', s);
    }
    for (const s of ['manga', 'doujinshi', 'MANGA']) {
        assert.strictEqual(ct.mapCategoryToType(s), 'manga', s);
    }
    for (const s of ['non-h', 'imageset', 'artistcg', 'misc', 'something-new']) {
        assert.strictEqual(ct.mapCategoryToType(s), 'other', s);
    }
});

test('mapCategoryToType returns null for empty or invalid slugs (never a path)', () => {
    const bad = [null, undefined, '', '   ', '../etc', 'a/b', 'a\\b', '-lead', 'has space', 'x'.repeat(60), '<b>', 42];
    for (const s of bad) {
        assert.strictEqual(ct.mapCategoryToType(s), null, JSON.stringify(s));
    }
    assert.strictEqual(ct.normalizeCategorySlug('Manga'), 'manga');
    assert.strictEqual(ct.normalizeCategorySlug('../x'), null);
});

test('typeFolderName only yields the fixed labels', () => {
    assert.strictEqual(ct.typeFolderName('comic'), 'Comic');
    assert.strictEqual(ct.typeFolderName('manga'), 'Manga');
    assert.strictEqual(ct.typeFolderName('other'), 'Other');
    assert.strictEqual(ct.typeFolderName(null), null);
    assert.strictEqual(ct.typeFolderName('../x'), null);
    assert.strictEqual(ct.isContentType('manga'), true);
    assert.strictEqual(ct.isContentType('doujinshi'), false);
});
