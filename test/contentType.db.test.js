const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NHDL_LEGACY_CONFIG = '';
const dbMod = require('../core/db');

async function createTempDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-ct-test-'));
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

test('queue category defaults to null and updateQueueItem sets/clears it; SSE-facing row exposes it', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 'xxx:5', url: 'u' }, ctx.db);
        assert.strictEqual(dbMod.formatQueueRow(await dbMod.getQueueItem('xxx:5', ctx.db)).category, null);

        const events = [];
        const onItem = (e) => events.push(e);
        dbMod.dbEvents.on('item', onItem);
        await dbMod.updateQueueItem('xxx:5', { category: 'manga' }, ctx.db);
        dbMod.dbEvents.off('item', onItem);
        assert.strictEqual(dbMod.formatQueueRow(await dbMod.getQueueItem('xxx:5', ctx.db)).category, 'manga');
        assert.ok(events.some(e => e.type === 'updated' && e.item.category === 'manga'), 'SSE item event carries category');

        await dbMod.updateQueueItem('xxx:5', { category: null }, ctx.db);
        assert.strictEqual(dbMod.formatQueueRow(await dbMod.getQueueItem('xxx:5', ctx.db)).category, null);
    } finally {
        await ctx.cleanup();
    }
});

test('exportData -> importData round-trip keeps category', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 'rox:9', url: 'u' }, ctx.db);
        await dbMod.updateQueueItem('rox:9', { category: 'comic' }, ctx.db);
        const payload = await dbMod.exportData(ctx.db);
        const exported = payload.tables.queue.find(r => String(r.gallery_id) === 'rox:9');
        assert.strictEqual(exported.category, 'comic');

        await dbMod.deleteQueueItem('rox:9', ctx.db);
        await dbMod.importData(payload, { mode: 'merge' }, ctx.db);
        assert.strictEqual(dbMod.formatQueueRow(await dbMod.getQueueItem('rox:9', ctx.db)).category, 'comic');
    } finally {
        await ctx.cleanup();
    }
});

test('migration v4 upgrades a v3 database in place, keeps rows, and is idempotent', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-mig4-test-'));
    const dbPath = path.join(tmpDir, 'v3.db');
    const old = new DatabaseSync(dbPath);
    old.exec(`
        CREATE TABLE queue (id INTEGER PRIMARY KEY, gallery_id TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT,
            status TEXT NOT NULL DEFAULT 'PENDING', batch INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
            pages_done INTEGER NOT NULL DEFAULT 0, pages_total INTEGER NOT NULL DEFAULT 0, error TEXT,
            retries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')), format TEXT);
        CREATE INDEX idx_queue_status ON queue(status);
        CREATE INDEX idx_queue_batch ON queue(batch);
        CREATE TABLE library (gallery_id TEXT PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL, pages INTEGER,
            format TEXT, language TEXT, artist TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')), meta TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), level TEXT NOT NULL,
            gallery_id INTEGER, message TEXT NOT NULL);
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version (version) VALUES (3);
        INSERT INTO queue (id, gallery_id, url, status, priority) VALUES (7, '468614', 'u1', 'DONE', 3);
        INSERT INTO queue (id, gallery_id, url, status) VALUES (9, 'xxx:5', 'u2', 'PENDING');
    `);
    old.close();
    try {
        const db = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
        assert.strictEqual(await dbMod.getSchemaVersion(db), 4);
        const cols = db.prepare(`PRAGMA table_info(queue)`).all().map(c => c.name);
        assert.ok(cols.includes('category'));
        const rows = await dbMod.getQueueItems({}, db);
        assert.deepStrictEqual(rows.map(r => [r.id, r.gallery_id, r.priority]), [[7, 468614, 3], [9, 'xxx:5', 0]]);
        assert.ok(rows.every(r => r.category === null));
        await dbMod.closeDb();
        const again = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
        assert.strictEqual(await dbMod.getSchemaVersion(again), 4);
        assert.strictEqual((await dbMod.getQueueItems({}, again)).length, 2);
    } finally {
        await dbMod.closeDb();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
});
