const test = require('node:test');
const assert = require('node:assert');

async function load() {
    return await import('../webui/src/lib/contentType.js');
}

test('itemType accepts only the three known types', async () => {
    const t = await load();
    assert.strictEqual(t.itemType({ category: 'comic' }), 'comic');
    assert.strictEqual(t.itemType({ category: 'manga' }), 'manga');
    assert.strictEqual(t.itemType({ category: 'other' }), 'other');
    for (const bad of [{}, { category: null }, { category: 'doujinshi' }, { category: '' }, null, undefined]) {
        assert.strictEqual(t.itemType(bad), null, JSON.stringify(bad));
    }
});

test('typeLabel and typeBadgeClass', async () => {
    const t = await load();
    assert.strictEqual(t.typeLabel('comic'), 'Comic');
    assert.strictEqual(t.typeLabel('manga'), 'Manga');
    assert.strictEqual(t.typeLabel('other'), 'Other');
    assert.strictEqual(t.typeLabel(null), '');
    assert.ok(t.typeBadgeClass('manga').length > 0);
    assert.notStrictEqual(t.typeBadgeClass('manga'), t.typeBadgeClass('comic'));
});

test('matchesTypeFilter and countByType ignore untyped items', async () => {
    const t = await load();
    const items = [{ category: 'comic' }, { category: 'manga' }, { category: 'manga' }, { category: null }, {}];
    assert.strictEqual(items.filter(i => t.matchesTypeFilter(i, 'all')).length, 5);
    assert.strictEqual(items.filter(i => t.matchesTypeFilter(i, null)).length, 5);
    assert.strictEqual(items.filter(i => t.matchesTypeFilter(i, 'manga')).length, 2);
    assert.strictEqual(items.filter(i => t.matchesTypeFilter(i, 'other')).length, 0);
    const counts = t.countByType(items);
    assert.deepStrictEqual([...counts.entries()].sort(), [['comic', 1], ['manga', 2]]);
});
