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

test('core/tracker.js: rescanLibrary populates SQLite library table from .nhdl-id markers on disk', () => {
    const ctx = createTempDb();
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-dl-test-'));
    try {
        const { rescanLibrary } = require('../core/tracker');
        const folderGallery = path.join(dlDir, 'Japanese', 'Artist One', 'Sample Gallery');
        fs.mkdirSync(folderGallery, { recursive: true });
        fs.writeFileSync(path.join(folderGallery, '1.jpg'), Buffer.alloc(2048));
        fs.writeFileSync(path.join(folderGallery, '2.jpg'), Buffer.alloc(2048));
        fs.writeFileSync(path.join(folderGallery, '.nhdl-id'), '468614', 'utf-8');

        const archiveDir = path.join(dlDir, 'English', 'Artist Two');
        fs.mkdirSync(archiveDir, { recursive: true });
        const archivePath = path.join(archiveDir, 'Archived Title.cbz');
        fs.writeFileSync(archivePath, Buffer.from('PK\x03\x04'));
        fs.writeFileSync(archivePath + '.nhdl-id', '500123', 'utf-8');

        const result = rescanLibrary(dlDir);
        assert.strictEqual(result.scanned, 2);
        assert.strictEqual(result.relocated, 2);

        const lib1 = dbMod.getLibraryEntry(468614, ctx.db);
        assert.ok(lib1);
        assert.strictEqual(lib1.title, 'Sample Gallery');
        assert.strictEqual(lib1.artist, 'Artist One');
        assert.strictEqual(lib1.language, 'Japanese');
        assert.strictEqual(lib1.pages, 2);
        assert.strictEqual(lib1.format, 'folder');

        const lib2 = dbMod.getLibraryEntry(500123, ctx.db);
        assert.ok(lib2);
        assert.strictEqual(lib2.title, 'Archived Title');
        assert.strictEqual(lib2.artist, 'Artist Two');
        assert.strictEqual(lib2.language, 'English');
        assert.strictEqual(lib2.format, 'cbz');
    } finally {
        try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
        ctx.cleanup();
    }
});

test('Fase 1 E2E: add 1000 links, download several, restart mid-download -> state remains consistent', () => {
    const ctx = createTempDb();
    try {
        const lines = ['# BATCH 1 FORMAT=cbz'];
        for (let i = 1; i <= 1000; i++) {
            lines.push(`https://nhentai.net/g/${300000 + i}/ | Gallery Title ${i}`);
        }
        const importSummary = dbMod.importListText(lines.join('\n'), { replace: true }, ctx.db);
        assert.strictEqual(importSummary.added, 1000);
        assert.strictEqual(importSummary.total, 1000);

        // Simulate downloading first 5 items (DONE), 6th item interrupted mid-download (ON_PROGRESS at page 12/24), 7th item failed (ERROR)
        for (let i = 1; i <= 5; i++) {
            dbMod.updateQueueStatus(300000 + i, 'DONE', { pagesDone: 20, pagesTotal: 20 }, ctx.db);
        }
        dbMod.updateQueueStatus(300006, 'ON_PROGRESS', { pagesDone: 12, pagesTotal: 24 }, ctx.db);
        dbMod.updateQueueStatus(300007, 'ERROR', { error: 'Socket Timeout' }, ctx.db);

        // Simulate server restart mid-download: close DB, reopen same DB file, and run startup resetStuckQueueItems()
        dbMod.closeDb();
        const reopenedDb = dbMod.initDb(ctx.dbPath);
        const resetCount = dbMod.resetStuckQueueItems(reopenedDb);
        assert.strictEqual(resetCount, 1);

        const allRows = dbMod.getQueueItems({}, reopenedDb);
        assert.strictEqual(allRows.length, 1000);

        const doneRows = dbMod.getQueueItems({ status: 'DONE' }, reopenedDb);
        const pendingRows = dbMod.getQueueItems({ status: 'PENDING' }, reopenedDb);
        const errorRows = dbMod.getQueueItems({ status: 'ERROR' }, reopenedDb);

        assert.strictEqual(doneRows.length, 5);
        assert.strictEqual(errorRows.length, 1);
        assert.strictEqual(pendingRows.length, 994); // 993 untouched + 1 recovered from ON_PROGRESS

        // Next item to process after restart must be the recovered item (300006)
        const nextUp = dbMod.getNextPendingItem(reopenedDb);
        assert.strictEqual(nextUp.gallery_id, 300006);
        assert.strictEqual(nextUp.pages_done, 12);
        assert.strictEqual(nextUp.pages_total, 24);
    } finally {
        ctx.cleanup();
    }
});

test('BUG 1: requeueFailedItems resets ERROR/COOLDOWN/PAUSED with retries < maxRetries to PENDING, keeps retries >= 5 as ERROR, and leaves SKIPPED/DONE untouched', () => {
    const ctx = createTempDb();
    try {
        // 1. ERROR with retries = 1 -> should return to PENDING with error = null
        dbMod.enqueueGallery({ galleryId: 600001, status: 'ERROR', error: 'Socket Timeout', retries: 1 }, ctx.db);
        // 2. PAUSED (e.g. Circuit breaker) with retries = 0 -> should return to PENDING with error = null
        dbMod.enqueueGallery({ galleryId: 600002, status: 'PAUSED', error: 'Circuit breaker (too many 429s)', retries: 0 }, ctx.db);
        // 3. COOLDOWN with retries = 2 -> should return to PENDING with error = null
        dbMod.enqueueGallery({ galleryId: 600003, status: 'COOLDOWN', error: 'Rate limit', retries: 2 }, ctx.db);
        // 4. ERROR with retries = 5 (>= maxRetries default 5) -> must stay ERROR
        dbMod.enqueueGallery({ galleryId: 600004, status: 'ERROR', error: 'Broken Link', retries: 5 }, ctx.db);
        // 5. SKIPPED -> must stay SKIPPED
        dbMod.enqueueGallery({ galleryId: 600005, status: 'SKIPPED', error: '404 Not Found', retries: 0 }, ctx.db);
        // 6. DONE -> must stay DONE
        dbMod.enqueueGallery({ galleryId: 600006, status: 'DONE', pagesDone: 15, pagesTotal: 15, retries: 0 }, ctx.db);

        const count = dbMod.requeueFailedItems({ maxRetries: 5 }, ctx.db);
        assert.strictEqual(count, 3);

        const item1 = dbMod.getQueueItem(600001, ctx.db);
        assert.strictEqual(item1.status, 'PENDING');
        assert.strictEqual(item1.error, null);
        assert.strictEqual(item1.retries, 1);

        const item2 = dbMod.getQueueItem(600002, ctx.db);
        assert.strictEqual(item2.status, 'PENDING');
        assert.strictEqual(item2.error, null);

        const item3 = dbMod.getQueueItem(600003, ctx.db);
        assert.strictEqual(item3.status, 'PENDING');
        assert.strictEqual(item3.error, null);

        const item4 = dbMod.getQueueItem(600004, ctx.db);
        assert.strictEqual(item4.status, 'ERROR');
        assert.strictEqual(item4.error, 'Broken Link');
        assert.strictEqual(item4.retries, 5);

        const item5 = dbMod.getQueueItem(600005, ctx.db);
        assert.strictEqual(item5.status, 'SKIPPED');

        const item6 = dbMod.getQueueItem(600006, ctx.db);
        assert.strictEqual(item6.status, 'DONE');
    } finally {
        ctx.cleanup();
    }
});



