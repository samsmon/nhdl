const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NHDL_LEGACY_CONFIG = '';
const dbMod = require('../core/db');
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

async function createTempDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-ms-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
    return {
        db, dbPath, tmpDir,
        async cleanup() {
            await dbMod.closeDb();
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        }
    };
}

test('queue accepts prefixed keys and keeps legacy numeric ids numeric on output', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 468614, url: 'https://nhentai.net/g/468614/' }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 'xxx:539224', url: 'https://nhentai.xxx/g/539224/' }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 'com:amys-country-wrangle-porn-comic', url: 'https://nhentai.com/en/comic/amys-country-wrangle-porn-comic' }, ctx.db);

        const rows = await dbMod.getQueueItems({}, ctx.db);
        assert.deepStrictEqual(rows.map(r => r.gallery_id), [468614, 'xxx:539224', 'com:amys-country-wrangle-porn-comic']);
        assert.deepStrictEqual(rows.map(r => common.formatQueueRow(r).source), ['default', 'xxx', 'com']);

        const one = await dbMod.getQueueItem('xxx:539224', ctx.db);
        assert.strictEqual(one.gallery_id, 'xxx:539224');
        const legacy = await dbMod.getQueueItem('468614', ctx.db);
        assert.strictEqual(legacy.gallery_id, 468614);

        await assert.rejects(
            dbMod.enqueueGallery({ galleryId: 'xxx:539224', url: 'x' }, ctx.db),
            /UNIQUE constraint failed: queue\.gallery_id/i
        );
    } finally {
        await ctx.cleanup();
    }
});

test('priority reorder, bulk pause/resume/delete work for prefixed keys (no NaN comparisons)', async () => {
    const ctx = await createTempDb();
    try {
        for (const id of ['xxx:1', 'rox:2', 'com:three', 4]) {
            await dbMod.enqueueGallery({ galleryId: id, url: `u/${id}` }, ctx.db);
        }
        const r1 = await dbMod.updateQueuePriority(['com:three'], 'top', ctx.db);
        assert.ok(r1.updated >= 1);
        const next = await dbMod.getNextPendingItem(ctx.db);
        assert.strictEqual(next.gallery_id, 'com:three');

        const paused = await dbMod.pauseQueueItems(['rox:2', 4, 'bogus'], ctx.db);
        assert.strictEqual(paused.paused, 2);
        const resumed = await dbMod.resumeQueueItems(['rox:2'], ctx.db);
        assert.deepStrictEqual(resumed.resumedIds, ['rox:2']);
        const del = await dbMod.deleteQueueItems(['xxx:1', 4], ctx.db);
        assert.strictEqual(del.deleted, 2);
        const left = await dbMod.getQueueItems({}, ctx.db);
        assert.deepStrictEqual(left.map(r => r.gallery_id).sort(), ['com:three', 'rox:2']);
    } finally {
        await ctx.cleanup();
    }
});

test('importListText replace keeps prefixed rows listed and removes the rest', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.importListText('xxx:1\nrox:2\n111111', { replace: false }, ctx.db);
        const summary = await dbMod.importListText('rox:2\ncom:new-one\nhttps://example.org/nope', { replace: true }, ctx.db);
        assert.strictEqual(summary.ignored, 1);
        assert.deepStrictEqual(summary.galleryIds, ['rox:2', 'com:new-one']);
        const rows = await dbMod.getQueueItems({}, ctx.db);
        assert.deepStrictEqual(rows.map(r => r.gallery_id).sort(), ['com:new-one', 'rox:2']);
    } finally {
        await ctx.cleanup();
    }
});

test('library upsert/get/delete with prefixed keys; ids come back through toPublicId', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.upsertLibraryEntry({ galleryId: 'rox:817456', title: 'T', path: ctx.tmpDir, pages: 51, format: 'folder', language: 'English', artist: 'A' }, ctx.db);
        await dbMod.upsertLibraryEntry({ galleryId: 468614, title: 'L', path: ctx.tmpDir, pages: 1, format: 'folder' }, ctx.db);
        const e = await dbMod.getLibraryEntry('rox:817456', ctx.db);
        assert.strictEqual(e.gallery_id, 'rox:817456');
        assert.strictEqual(e.id, 'rox:817456');
        const l = await dbMod.getLibraryEntry(468614, ctx.db);
        assert.strictEqual(l.gallery_id, 468614);
        assert.strictEqual(l.id, '468614');
        const all = await dbMod.getAllLibraryEntries(ctx.db);
        assert.strictEqual(all.length, 2);
        await dbMod.deleteLibraryEntry('rox:817456', ctx.db);
        assert.strictEqual(await dbMod.getLibraryEntry('rox:817456', ctx.db), null);
    } finally {
        await ctx.cleanup();
    }
});

test('events accept prefixed gallery ids and filter by them', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.logEvent({ level: 'info', galleryId: 'xxx:5', message: 'prefixed' }, ctx.db);
        await dbMod.logEvent({ level: 'info', galleryId: 5, message: 'numeric' }, ctx.db);
        const rows = await dbMod.getEvents({ galleryId: 'xxx:5' }, ctx.db);
        assert.deepStrictEqual(rows.map(r => r.message), ['prefixed']);
    } finally {
        await ctx.cleanup();
    }
});

test('migration v3 upgrades a v2 database in place: ids stay, order/priority kept, rerun is a no-op', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-mig-test-'));
    const dbPath = path.join(tmpDir, 'old.db');
    const old = new DatabaseSync(dbPath);
    old.exec(`
        CREATE TABLE queue (id INTEGER PRIMARY KEY, gallery_id INTEGER NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT,
            status TEXT NOT NULL DEFAULT 'PENDING', batch INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
            pages_done INTEGER NOT NULL DEFAULT 0, pages_total INTEGER NOT NULL DEFAULT 0, error TEXT,
            retries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')), format TEXT);
        CREATE INDEX idx_queue_status ON queue(status);
        CREATE INDEX idx_queue_batch ON queue(batch);
        CREATE TABLE library (gallery_id INTEGER PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL, pages INTEGER,
            format TEXT, language TEXT, artist TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')), meta TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), level TEXT NOT NULL,
            gallery_id INTEGER, message TEXT NOT NULL);
        CREATE INDEX idx_events_gallery ON events(gallery_id);
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version (version) VALUES (2);
        INSERT INTO queue (id, gallery_id, url, status, priority, batch) VALUES (7, 468614, 'https://nhentai.net/g/468614/', 'DONE', 3, 2);
        INSERT INTO queue (id, gallery_id, url, status, priority) VALUES (9, 123456, 'https://nhentai.net/g/123456/', 'PENDING', 5);
        INSERT INTO library (gallery_id, title, path, pages, format) VALUES (468614, 'Old', 'C:/x', 10, 'folder');
    `);
    old.close();

    try {
        const db = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
        assert.strictEqual(await dbMod.getSchemaVersion(db), 3);

        const cols = Object.fromEntries(db.prepare(`PRAGMA table_info(queue)`).all().map(c => [c.name, c.type]));
        assert.strictEqual(cols.gallery_id, 'TEXT');
        assert.strictEqual(db.prepare(`PRAGMA table_info(library)`).all().find(c => c.name === 'gallery_id').type, 'TEXT');

        const rows = await dbMod.getQueueItems({}, db);
        const byGid = Object.fromEntries(rows.map(r => [r.gallery_id, r]));
        assert.strictEqual(byGid[468614].id, 7);
        assert.strictEqual(byGid[468614].priority, 3);
        assert.strictEqual(byGid[468614].batch, 2);
        assert.strictEqual(byGid[123456].priority, 5);
        assert.strictEqual((await dbMod.getLibraryEntry(468614, db)).title, 'Old');

        const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='queue'`).all().map(r => r.name);
        assert.ok(idx.includes('idx_queue_status') && idx.includes('idx_queue_batch'));

        await dbMod.closeDb();
        const again = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
        assert.strictEqual(await dbMod.getSchemaVersion(again), 3);
        assert.strictEqual((await dbMod.getQueueItems({}, again)).length, 2);
    } finally {
        await dbMod.closeDb();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
});

test('exportData emits numeric ids as numbers and prefixed ids as strings', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 101, url: 'u/101' }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 'xxx:5', url: 'u/xxx5' }, ctx.db);
        await dbMod.upsertLibraryEntry({ galleryId: 101, title: 'T', path: ctx.tmpDir, pages: 1, format: 'folder' }, ctx.db);
        await dbMod.upsertLibraryEntry({ galleryId: 'xxx:5', title: 'X', path: ctx.tmpDir, pages: 1, format: 'folder' }, ctx.db);
        const exp = await dbMod.exportData(ctx.db);
        assert.ok(exp.tables.queue.some(r => r.gallery_id === 101));
        assert.ok(exp.tables.queue.some(r => r.gallery_id === 'xxx:5'));
        assert.ok(exp.tables.library.some(r => r.gallery_id === 101));
        assert.ok(exp.tables.library.some(r => r.gallery_id === 'xxx:5'));
    } finally {
        await ctx.cleanup();
    }
});
