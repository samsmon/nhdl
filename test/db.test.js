const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbMod = require('../core/db');

function createTempDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-db-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = dbMod.initDb(dbPath);
    return {
        db,
        dbPath,
        cleanup() {
            dbMod.closeDb();
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        }
    };
}

test('core/db.js: schema migration initializes tables, WAL mode, and schema_version', () => {
    const ctx = createTempDb();
    try {
        assert.ok(dbMod.getSchemaVersion(ctx.db) >= 1, 'schema_version should be >= 1');

        const tables = ctx.db.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
        ).all().map(r => r.name);

        for (const expected of ['events', 'library', 'queue', 'schema_version', 'settings']) {
            assert.ok(tables.includes(expected), `table ${expected} should exist`);
        }

        const journalMode = ctx.db.prepare(`PRAGMA journal_mode`).get();
        assert.strictEqual(String(journalMode.journal_mode).toLowerCase(), 'wal');
    } finally {
        ctx.cleanup();
    }
});

test('core/db.js: enforces UNIQUE(gallery_id) on queue table', () => {
    const ctx = createTempDb();
    try {
        dbMod.enqueueGallery({ galleryId: 468614, url: 'https://nhentai.net/g/468614/' }, ctx.db);
        assert.throws(() => {
            dbMod.enqueueGallery({ galleryId: 468614, url: 'https://nhentai.net/g/468614/' }, ctx.db);
        }, /UNIQUE constraint failed: queue\.gallery_id/i);
    } finally {
        ctx.cleanup();
    }
});

test('core/db.js: queue lifecycle PENDING -> ON_PROGRESS -> DONE/ERROR and priority ordering', () => {
    const ctx = createTempDb();
    try {
        dbMod.enqueueGallery({ galleryId: 100001, priority: 0, batch: 1 }, ctx.db);
        dbMod.enqueueGallery({ galleryId: 100002, priority: 10, batch: 1 }, ctx.db);

        // Highest priority should be picked first
        const next1 = dbMod.getNextPendingItem(ctx.db);
        assert.ok(next1);
        assert.strictEqual(next1.gallery_id, 100002);

        // Transition to ON_PROGRESS -> DONE
        dbMod.updateQueueStatus(100002, 'ON_PROGRESS', { pagesDone: 5, pagesTotal: 20, title: 'Test Title' }, ctx.db);
        const inProg = dbMod.getQueueItem(100002, ctx.db);
        assert.strictEqual(inProg.status, 'ON_PROGRESS');
        assert.strictEqual(inProg.pages_done, 5);
        assert.strictEqual(inProg.pages_total, 20);

        dbMod.updateQueueStatus(100002, 'DONE', { pagesDone: 20 }, ctx.db);
        assert.strictEqual(dbMod.getQueueItem(100002, ctx.db).status, 'DONE');

        // Next pending should now be 100001 -> ON_PROGRESS -> ERROR (retries incremented)
        const next2 = dbMod.getNextPendingItem(ctx.db);
        assert.ok(next2);
        assert.strictEqual(next2.gallery_id, 100001);

        dbMod.updateQueueStatus(100001, 'ON_PROGRESS', {}, ctx.db);
        dbMod.updateQueueStatus(100001, 'ERROR', { error: '404 Not Found' }, ctx.db);
        const failed = dbMod.getQueueItem(100001, ctx.db);
        assert.strictEqual(failed.status, 'ERROR');
        assert.strictEqual(failed.error, '404 Not Found');
        assert.strictEqual(failed.retries, 1);
    } finally {
        ctx.cleanup();
    }
});

test('core/db.js: resetStuckQueueItems resets ON_PROGRESS items back to PENDING at startup', () => {
    const ctx = createTempDb();
    try {
        dbMod.enqueueGallery({ galleryId: 200001, status: 'ON_PROGRESS' }, ctx.db);
        dbMod.enqueueGallery({ galleryId: 200002, status: 'DONE' }, ctx.db);
        dbMod.enqueueGallery({ galleryId: 200003, status: 'ERROR', error: 'Network error' }, ctx.db);

        const count = dbMod.resetStuckQueueItems(ctx.db);
        assert.strictEqual(count, 1);
        assert.strictEqual(dbMod.getQueueItem(200001, ctx.db).status, 'PENDING');
        assert.strictEqual(dbMod.getQueueItem(200002, ctx.db).status, 'DONE');
        assert.strictEqual(dbMod.getQueueItem(200003, ctx.db).status, 'ERROR');
    } finally {
        ctx.cleanup();
    }
});

test('core/db.js: importListText and exportListText preserve batches, formats, titles, and dedupe', () => {
    const ctx = createTempDb();
    try {
        const sampleList = [
            '# BATCH 1 FORMAT=cbz',
            'https://nhentai.net/g/468614/ | Author A - First Gallery',
            '468615',
            '# Duplicate below should be ignored:',
            'https://nhentai.net/g/468614/',
            '# BATCH 2 FORMAT=folder',
            'https://nhentai.net/g/500123/ | Second Batch Gallery'
        ].join('\n');

        const summary = dbMod.importListText(sampleList, {}, ctx.db);
        assert.strictEqual(summary.added, 3);
        assert.strictEqual(summary.total, 3);

        const rows = dbMod.getQueueItems({}, ctx.db);
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[0].gallery_id, 468614);
        assert.strictEqual(rows[0].batch, 1);
        assert.strictEqual(rows[0].format, 'cbz');
        assert.strictEqual(rows[0].title, 'Author A - First Gallery');

        assert.strictEqual(rows[2].gallery_id, 500123);
        assert.strictEqual(rows[2].batch, 2);
        assert.strictEqual(rows[2].format, 'folder');

        const exported = dbMod.exportListText(ctx.db);
        assert.ok(exported.includes('# BATCH 1 FORMAT=cbz'));
        assert.ok(exported.includes('https://nhentai.net/g/468614/ | Author A - First Gallery'));
        assert.ok(exported.includes('# BATCH 2 FORMAT=folder'));
        assert.ok(exported.includes('https://nhentai.net/g/500123/ | Second Batch Gallery'));
    } finally {
        ctx.cleanup();
    }
});

test('core/db.js: settings and events helpers work and cap event rows', () => {
    const ctx = createTempDb();
    try {
        dbMod.setSetting('downloadFormat', 'cbz', ctx.db);
        dbMod.setSetting('autoContinueBatches', false, ctx.db);
        assert.strictEqual(dbMod.getSetting('downloadFormat', 'folder', ctx.db), 'cbz');
        assert.strictEqual(dbMod.getSetting('autoContinueBatches', true, ctx.db), false);

        for (let i = 1; i <= 5; i++) {
            dbMod.logEvent({ level: 'info', galleryId: 468614, message: `msg ${i}`, maxRows: 3 }, ctx.db);
        }
        const events = dbMod.getEvents({}, ctx.db);
        assert.strictEqual(events.length, 3);
        assert.strictEqual(events[0].message, 'msg 3');
        assert.strictEqual(events[2].message, 'msg 5');
    } finally {
        ctx.cleanup();
    }
});
