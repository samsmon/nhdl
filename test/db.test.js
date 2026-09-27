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

test('BUG 2: re-importing DONE item whose file is missing resets to PENDING and prunes stale library entry, while valid DONE and permanent SKIPPED remain unchanged', () => {
    const ctx = createTempDb();
    const tempDir = path.dirname(ctx.dbPath);
    const validFilePath = path.join(tempDir, 'valid-archive.cbz');
    fs.writeFileSync(validFilePath, Buffer.from('PK\x03\x04dummy-cbz-data'));
    const missingFilePath = path.join(tempDir, 'deleted-archive.cbz');

    try {
        // Case 1: Row is DONE, library entry points to missing file on disk
        dbMod.upsertLibraryEntry({
            galleryId: 700001,
            title: 'Missing Archive Gallery',
            format: 'cbz',
            path: missingFilePath,
            pages: 24
        }, ctx.db);
        dbMod.enqueueGallery({
            galleryId: 700001,
            title: 'Missing Archive Gallery',
            status: 'DONE',
            pagesDone: 24,
            pagesTotal: 24
        }, ctx.db);

        // Case 2: Row is DONE, library entry points to valid existing file on disk
        dbMod.upsertLibraryEntry({
            galleryId: 700002,
            title: 'Valid Archive Gallery',
            format: 'cbz',
            path: validFilePath,
            pages: 18
        }, ctx.db);
        dbMod.enqueueGallery({
            galleryId: 700002,
            title: 'Valid Archive Gallery',
            status: 'DONE',
            pagesDone: 18,
            pagesTotal: 18
        }, ctx.db);

        // Case 3: Row is SKIPPED with permanent skip in library (404 Not Found)
        dbMod.upsertLibraryEntry({
            galleryId: 700003,
            title: 'Skipped 404 Gallery',
            format: 'skipped',
            path: '',
            skipped: true,
            reason: '404 Not Found'
        }, ctx.db);
        dbMod.enqueueGallery({
            galleryId: 700003,
            title: 'Skipped 404 Gallery',
            status: 'SKIPPED',
            error: '404 Not Found'
        }, ctx.db);

        // Re-import all three IDs
        const listText = [
            'https://nhentai.net/g/700001/',
            'https://nhentai.net/g/700002/',
            'https://nhentai.net/g/700003/'
        ].join('\n');
        dbMod.importListText(listText, { replace: false }, ctx.db);

        // Case 1 must be reset to PENDING, pages_done = 0, error = null, and stale library entry deleted
        const row1 = dbMod.getQueueItem(700001, ctx.db);
        assert.strictEqual(row1.status, 'PENDING');
        assert.strictEqual(row1.pages_done, 0);
        assert.strictEqual(row1.error, null);
        assert.strictEqual(dbMod.getLibraryEntry(700001, ctx.db), null);

        // Case 2 must stay DONE and keep its library entry
        const row2 = dbMod.getQueueItem(700002, ctx.db);
        assert.strictEqual(row2.status, 'DONE');
        assert.strictEqual(row2.pages_done, 18);
        assert.ok(dbMod.getLibraryEntry(700002, ctx.db));

        // Case 3 (permanent skip 404) must stay SKIPPED and keep its skipped library entry
        const row3 = dbMod.getQueueItem(700003, ctx.db);
        assert.strictEqual(row3.status, 'SKIPPED');
        const lib3 = dbMod.getLibraryEntry(700003, ctx.db);
        assert.ok(lib3 && lib3.skipped);
    } finally {
        ctx.cleanup();
    }
});

test('BUG 3: migrates downloadDir, downloadFormat, and autoContinueBatches from legacy config.json when settings table is empty without overwriting existing settings or modifying config.json', () => {
    const ctx = createTempDb();
    const tempDir = path.dirname(ctx.dbPath);
    const configPath = path.join(tempDir, 'config.json');
    const originalConfigContent = JSON.stringify({
        downloadDir: 'D:\\Manga\\NHDL_Custom',
        downloadFormat: 'folder',
        autoContinueBatches: false
    }, null, 2);
    fs.writeFileSync(configPath, originalConfigContent, 'utf-8');

    try {
        // 1. Settings table is empty + config.json exists -> should copy settings and log event
        const migrated = dbMod.migrateLegacyConfigJson(configPath, ctx.db);
        assert.strictEqual(migrated, true);
        assert.strictEqual(dbMod.getSetting('downloadDir', null, ctx.db), 'D:\\Manga\\NHDL_Custom');
        assert.strictEqual(dbMod.getSetting('downloadFormat', null, ctx.db), 'folder');
        assert.strictEqual(dbMod.getSetting('autoContinueBatches', null, ctx.db), false);

        // Verify event logged in events table
        const events = dbMod.getEvents({ limit: 10 }, ctx.db);
        assert.ok(events.some(e => e.message === 'Migrated settings from config.json'));

        // Verify config.json is untouched
        assert.strictEqual(fs.readFileSync(configPath, 'utf-8'), originalConfigContent);

        // 2. Settings already populated -> subsequent migration with different config.json must NOT overwrite
        const newConfigPath = path.join(tempDir, 'config2.json');
        fs.writeFileSync(newConfigPath, JSON.stringify({
            downloadDir: 'E:\\OtherDir',
            downloadFormat: 'zip',
            autoContinueBatches: true
        }), 'utf-8');

        const migratedAgain = dbMod.migrateLegacyConfigJson(newConfigPath, ctx.db);
        assert.strictEqual(migratedAgain, false);
        assert.strictEqual(dbMod.getSetting('downloadDir', null, ctx.db), 'D:\\Manga\\NHDL_Custom');
        assert.strictEqual(dbMod.getSetting('downloadFormat', null, ctx.db), 'folder');
        assert.strictEqual(dbMod.getSetting('autoContinueBatches', null, ctx.db), false);
    } finally {
        ctx.cleanup();
    }
});

test('A1: unmounted/unhealthy download folder aborts rescan and _runBatchBody without deleting library entries or resetting DONE items', async () => {
    const ctx = createTempDb();
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-a1-dl-'));
    const trackerMod = require('../core/tracker');
    const DownloaderEngine = require('../core/engine');

    try {
        // Create 20 valid archive files + markers in dlDir and register in library & queue as DONE
        const paths = [];
        for (let i = 1; i <= 20; i++) {
            const gid = 800000 + i;
            const cbzPath = path.join(dlDir, `Gallery_${gid}.cbz`);
            fs.writeFileSync(cbzPath, Buffer.from('PK\x03\x04valid-cbz-content'));
            fs.writeFileSync(`${cbzPath}.nhdl-id`, String(gid), 'utf-8');
            paths.push({ gid, cbzPath });

            dbMod.upsertLibraryEntry({
                galleryId: gid,
                title: `Gallery ${gid}`,
                format: 'cbz',
                path: cbzPath,
                pages: 10
            }, ctx.db);
            dbMod.enqueueGallery({
                galleryId: gid,
                title: `Gallery ${gid}`,
                status: 'DONE',
                pagesDone: 10,
                pagesTotal: 10
            }, ctx.db);
        }

        // Case 1: Download folder does not exist at all (unmounted drive)
        const nonExistentDir = path.join(os.tmpdir(), 'nhdl-unmounted-disk-' + Date.now());
        assert.strictEqual(trackerMod.isDownloadDirHealthy(nonExistentDir), false);
        const rescanUnmounted = trackerMod.rescanLibrary(nonExistentDir);
        assert.strictEqual(rescanUnmounted.aborted, true);
        assert.strictEqual(rescanUnmounted.pruned, 0);
        assert.strictEqual(dbMod.getAllLibraryEntries(ctx.db).length, 20);

        const eng = new DownloaderEngine({ baseDownloadDir: nonExistentDir, skipStartupJitter: true });
        await eng.runBatch();
        assert.strictEqual(eng.getStatus(), 'Download folder unavailable');
        // No DONE items should have been reset to PENDING
        assert.strictEqual(dbMod.getQueueItems({ status: 'DONE' }, ctx.db).length, 20);
        assert.strictEqual(dbMod.getQueueItems({ status: 'PENDING' }, ctx.db).length, 0);

        // Case 2: 60% of files (12 out of 20) are missing -> rescan must abort and keep all 20 library entries
        for (let i = 0; i < 12; i++) {
            fs.unlinkSync(paths[i].cbzPath);
            fs.unlinkSync(`${paths[i].cbzPath}.nhdl-id`);
        }
        assert.strictEqual(trackerMod.isDownloadDirHealthy(dlDir), false);
        const rescan60Missing = trackerMod.rescanLibrary(dlDir);
        assert.strictEqual(rescan60Missing.aborted, true);
        assert.strictEqual(rescan60Missing.pruned, 0);
        assert.strictEqual(dbMod.getAllLibraryEntries(ctx.db).length, 20);

        // Restore 11 of the 12 deleted files so only 1 out of 20 (5%) is missing
        for (let i = 1; i < 12; i++) {
            fs.writeFileSync(paths[i].cbzPath, Buffer.from('PK\x03\x04valid-cbz-content'));
            fs.writeFileSync(`${paths[i].cbzPath}.nhdl-id`, String(paths[i].gid), 'utf-8');
        }

        // Case 3: 1 out of 20 files missing (5% <= 50%) -> healthy, normal rescan prunes the 1 missing entry
        assert.strictEqual(trackerMod.isDownloadDirHealthy(dlDir), true);
        const rescan1Missing = trackerMod.rescanLibrary(dlDir);
        assert.strictEqual(Boolean(rescan1Missing.aborted), false);
        assert.strictEqual(rescan1Missing.pruned, 1);
        assert.strictEqual(dbMod.getAllLibraryEntries(ctx.db).length, 19);
    } finally {
        try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
        ctx.cleanup();
    }
});






