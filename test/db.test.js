const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NHDL_LEGACY_CONFIG = '';
const dbMod = require('../core/db');

async function createTempDb(options = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-db-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const legacyConfigPath = options.legacyConfigPath !== undefined
        ? options.legacyConfigPath
        : path.join(tmpDir, 'nonexistent-config.json');
    const db = await dbMod.initDb(dbPath, { legacyConfigPath });
    return {
        db,
        dbPath,
        async cleanup() {
            await dbMod.closeDb();
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        }
    };
}

test('core/db.js: schema migration initializes tables, WAL mode, and schema_version', async () => {
    const ctx = await createTempDb();
    try {
        assert.ok((await dbMod.getSchemaVersion(ctx.db)) >= 1, 'schema_version should be >= 1');

        const tables = ctx.db.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
        ).all().map(r => r.name);

        for (const expected of ['events', 'library', 'queue', 'schema_version', 'settings']) {
            assert.ok(tables.includes(expected), `table ${expected} should exist`);
        }

        const journalMode = ctx.db.prepare(`PRAGMA journal_mode`).get();
        assert.strictEqual(String(journalMode.journal_mode).toLowerCase(), 'wal');
    } finally {
        await ctx.cleanup();
    }
});

test('core/db.js: enforces UNIQUE(gallery_id) on queue table', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 468614, url: 'https://nhentai.net/g/468614/' }, ctx.db);
        await assert.rejects(async () => {
            await dbMod.enqueueGallery({ galleryId: 468614, url: 'https://nhentai.net/g/468614/' }, ctx.db);
        }, /UNIQUE constraint failed: queue\.gallery_id/i);
    } finally {
        await ctx.cleanup();
    }
});

test('core/db.js: queue lifecycle PENDING -> ON_PROGRESS -> DONE/ERROR and priority ordering', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 100001, priority: 0, batch: 1 }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 100002, priority: 10, batch: 1 }, ctx.db);

        // Highest priority should be picked first
        const next1 = await dbMod.getNextPendingItem(ctx.db);
        assert.ok(next1);
        assert.strictEqual(next1.gallery_id, 100002);

        // Transition to ON_PROGRESS -> DONE
        await dbMod.updateQueueStatus(100002, 'ON_PROGRESS', { pagesDone: 5, pagesTotal: 20, title: 'Test Title' }, ctx.db);
        const inProg = await dbMod.getQueueItem(100002, ctx.db);
        assert.strictEqual(inProg.status, 'ON_PROGRESS');
        assert.strictEqual(inProg.pages_done, 5);
        assert.strictEqual(inProg.pages_total, 20);

        await dbMod.updateQueueStatus(100002, 'DONE', { pagesDone: 20 }, ctx.db);
        assert.strictEqual((await dbMod.getQueueItem(100002, ctx.db)).status, 'DONE');

        // Next pending should now be 100001 -> ON_PROGRESS -> ERROR (retries incremented)
        const next2 = await dbMod.getNextPendingItem(ctx.db);
        assert.ok(next2);
        assert.strictEqual(next2.gallery_id, 100001);

        await dbMod.updateQueueStatus(100001, 'ON_PROGRESS', {}, ctx.db);
        await dbMod.updateQueueStatus(100001, 'ERROR', { error: '404 Not Found' }, ctx.db);
        const failed = await dbMod.getQueueItem(100001, ctx.db);
        assert.strictEqual(failed.status, 'ERROR');
        assert.strictEqual(failed.error, '404 Not Found');
        assert.strictEqual(failed.retries, 1);
    } finally {
        await ctx.cleanup();
    }
});

test('core/db.js: resetStuckQueueItems resets ON_PROGRESS items back to PENDING at startup', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 200001, status: 'ON_PROGRESS' }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 200002, status: 'DONE' }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 200003, status: 'ERROR', error: 'Network error' }, ctx.db);

        const count = await dbMod.resetStuckQueueItems(ctx.db);
        assert.strictEqual(count, 1);
        assert.strictEqual((await dbMod.getQueueItem(200001, ctx.db)).status, 'PENDING');
        assert.strictEqual((await dbMod.getQueueItem(200002, ctx.db)).status, 'DONE');
        assert.strictEqual((await dbMod.getQueueItem(200003, ctx.db)).status, 'ERROR');
    } finally {
        await ctx.cleanup();
    }
});

test('core/db.js: importListText and exportListText preserve batches, formats, titles, and dedupe', async () => {
    const ctx = await createTempDb();
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

        const summary = await dbMod.importListText(sampleList, {}, ctx.db);
        assert.strictEqual(summary.added, 3);
        assert.strictEqual(summary.total, 3);

        const rows = await dbMod.getQueueItems({}, ctx.db);
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[0].gallery_id, 468614);
        assert.strictEqual(rows[0].batch, 1);
        assert.strictEqual(rows[0].format, 'cbz');
        assert.strictEqual(rows[0].title, 'Author A - First Gallery');

        assert.strictEqual(rows[2].gallery_id, 500123);
        assert.strictEqual(rows[2].batch, 2);
        assert.strictEqual(rows[2].format, 'folder');

        const exported = await dbMod.exportListText(ctx.db);
        assert.ok(exported.includes('# BATCH 1 FORMAT=cbz'));
        assert.ok(exported.includes('https://nhentai.net/g/468614/ | Author A - First Gallery'));
        assert.ok(exported.includes('# BATCH 2 FORMAT=folder'));
        assert.ok(exported.includes('https://nhentai.net/g/500123/ | Second Batch Gallery'));
    } finally {
        await ctx.cleanup();
    }
});

test('core/db.js: settings and events helpers work and cap event rows', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.setSetting('downloadFormat', 'cbz', ctx.db);
        await dbMod.setSetting('autoContinueBatches', false, ctx.db);
        assert.strictEqual(await dbMod.getSetting('downloadFormat', 'folder', ctx.db), 'cbz');
        assert.strictEqual(await dbMod.getSetting('autoContinueBatches', true, ctx.db), false);

        for (let i = 1; i <= 5; i++) {
            await dbMod.logEvent({ level: 'info', galleryId: 468614, message: `msg ${i}`, maxRows: 3 }, ctx.db);
        }
        const events = await dbMod.getEvents({}, ctx.db);
        assert.strictEqual(events.length, 3);
        assert.strictEqual(events[0].message, 'msg 3');
        assert.strictEqual(events[2].message, 'msg 5');
    } finally {
        await ctx.cleanup();
    }
});

test('core/tracker.js: rescanLibrary populates SQLite library table from .nhdl-id markers on disk', async () => {
    const ctx = await createTempDb();
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

        const result = await rescanLibrary(dlDir);
        assert.strictEqual(result.scanned, 2);
        assert.strictEqual(result.relocated, 2);

        const lib1 = await dbMod.getLibraryEntry(468614, ctx.db);
        assert.ok(lib1);
        assert.strictEqual(lib1.title, 'Sample Gallery');
        assert.strictEqual(lib1.artist, 'Artist One');
        assert.strictEqual(lib1.language, 'Japanese');
        assert.strictEqual(lib1.pages, 2);
        assert.strictEqual(lib1.format, 'folder');

        const lib2 = await dbMod.getLibraryEntry(500123, ctx.db);
        assert.ok(lib2);
        assert.strictEqual(lib2.title, 'Archived Title');
        assert.strictEqual(lib2.artist, 'Artist Two');
        assert.strictEqual(lib2.language, 'English');
        assert.strictEqual(lib2.format, 'cbz');
    } finally {
        try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
        await ctx.cleanup();
    }
});

test('Fase 1 E2E: add 1000 links, download several, restart mid-download -> state remains consistent', async () => {
    const ctx = await createTempDb();
    try {
        const lines = ['# BATCH 1 FORMAT=cbz'];
        for (let i = 1; i <= 1000; i++) {
            lines.push(`https://nhentai.net/g/${300000 + i}/ | Gallery Title ${i}`);
        }
        const importSummary = await dbMod.importListText(lines.join('\n'), { replace: true }, ctx.db);
        assert.strictEqual(importSummary.added, 1000);
        assert.strictEqual(importSummary.total, 1000);

        // Simulate downloading first 5 items (DONE), 6th item interrupted mid-download (ON_PROGRESS at page 12/24), 7th item failed (ERROR)
        for (let i = 1; i <= 5; i++) {
            await dbMod.updateQueueStatus(300000 + i, 'DONE', { pagesDone: 20, pagesTotal: 20 }, ctx.db);
        }
        await dbMod.updateQueueStatus(300006, 'ON_PROGRESS', { pagesDone: 12, pagesTotal: 24 }, ctx.db);
        await dbMod.updateQueueStatus(300007, 'ERROR', { error: 'Socket Timeout' }, ctx.db);

        // Simulate server restart mid-download: close DB, reopen same DB file, and run startup resetStuckQueueItems()
        await dbMod.closeDb();
        const reopenedDb = await dbMod.initDb(ctx.dbPath);
        const resetCount = await dbMod.resetStuckQueueItems(reopenedDb);
        assert.strictEqual(resetCount, 1);

        const allRows = await dbMod.getQueueItems({}, reopenedDb);
        assert.strictEqual(allRows.length, 1000);

        const doneRows = await dbMod.getQueueItems({ status: 'DONE' }, reopenedDb);
        const pendingRows = await dbMod.getQueueItems({ status: 'PENDING' }, reopenedDb);
        const errorRows = await dbMod.getQueueItems({ status: 'ERROR' }, reopenedDb);

        assert.strictEqual(doneRows.length, 5);
        assert.strictEqual(errorRows.length, 1);
        assert.strictEqual(pendingRows.length, 994); // 993 untouched + 1 recovered from ON_PROGRESS

        // Next item to process after restart must be the recovered item (300006)
        const nextUp = await dbMod.getNextPendingItem(reopenedDb);
        assert.strictEqual(nextUp.gallery_id, 300006);
        assert.strictEqual(nextUp.pages_done, 12);
        assert.strictEqual(nextUp.pages_total, 24);
    } finally {
        await ctx.cleanup();
    }
});

test('BUG 1: requeueFailedItems resets ERROR/COOLDOWN/PAUSED with retries < maxRetries to PENDING, keeps retries >= 5 as ERROR, and leaves SKIPPED/DONE untouched', async () => {
    const ctx = await createTempDb();
    try {
        // 1. ERROR with retries = 1 -> should return to PENDING with error = null
        await dbMod.enqueueGallery({ galleryId: 600001, status: 'ERROR', error: 'Socket Timeout', retries: 1 }, ctx.db);
        // 2. PAUSED (e.g. Circuit breaker) with retries = 0 -> should return to PENDING with error = null
        await dbMod.enqueueGallery({ galleryId: 600002, status: 'PAUSED', error: 'Circuit breaker (too many 429s)', retries: 0 }, ctx.db);
        // 3. COOLDOWN with retries = 2 -> should return to PENDING with error = null
        await dbMod.enqueueGallery({ galleryId: 600003, status: 'COOLDOWN', error: 'Rate limit', retries: 2 }, ctx.db);
        // 4. ERROR with retries = 5 (>= maxRetries default 5) -> must stay ERROR
        await dbMod.enqueueGallery({ galleryId: 600004, status: 'ERROR', error: 'Broken Link', retries: 5 }, ctx.db);
        // 5. SKIPPED -> must stay SKIPPED
        await dbMod.enqueueGallery({ galleryId: 600005, status: 'SKIPPED', error: '404 Not Found', retries: 0 }, ctx.db);
        // 6. DONE -> must stay DONE
        await dbMod.enqueueGallery({ galleryId: 600006, status: 'DONE', pagesDone: 15, pagesTotal: 15, retries: 0 }, ctx.db);

        const count = await dbMod.requeueFailedItems({ maxRetries: 5 }, ctx.db);
        assert.strictEqual(count, 3);

        const item1 = await dbMod.getQueueItem(600001, ctx.db);
        assert.strictEqual(item1.status, 'PENDING');
        assert.strictEqual(item1.error, null);
        assert.strictEqual(item1.retries, 1);

        const item2 = await dbMod.getQueueItem(600002, ctx.db);
        assert.strictEqual(item2.status, 'PENDING');
        assert.strictEqual(item2.error, null);

        const item3 = await dbMod.getQueueItem(600003, ctx.db);
        assert.strictEqual(item3.status, 'PENDING');
        assert.strictEqual(item3.error, null);

        const item4 = await dbMod.getQueueItem(600004, ctx.db);
        assert.strictEqual(item4.status, 'ERROR');
        assert.strictEqual(item4.error, 'Broken Link');
        assert.strictEqual(item4.retries, 5);

        const item5 = await dbMod.getQueueItem(600005, ctx.db);
        assert.strictEqual(item5.status, 'SKIPPED');

        const item6 = await dbMod.getQueueItem(600006, ctx.db);
        assert.strictEqual(item6.status, 'DONE');
    } finally {
        await ctx.cleanup();
    }
});

test('BUG 2: re-importing DONE item whose file is missing resets to PENDING and prunes stale library entry, while valid DONE and permanent SKIPPED remain unchanged', async () => {
    const ctx = await createTempDb();
    const tempDir = path.dirname(ctx.dbPath);
    const validFilePath = path.join(tempDir, 'valid-archive.cbz');
    fs.writeFileSync(validFilePath, Buffer.from('PK\x03\x04dummy-cbz-data'));
    const missingFilePath = path.join(tempDir, 'deleted-archive.cbz');

    try {
        // Case 1: Row is DONE, library entry points to missing file on disk
        await dbMod.upsertLibraryEntry({
            galleryId: 700001,
            title: 'Missing Archive Gallery',
            format: 'cbz',
            path: missingFilePath,
            pages: 24
        }, ctx.db);
        await dbMod.enqueueGallery({
            galleryId: 700001,
            title: 'Missing Archive Gallery',
            status: 'DONE',
            pagesDone: 24,
            pagesTotal: 24
        }, ctx.db);

        // Case 2: Row is DONE, library entry points to valid existing file on disk
        await dbMod.upsertLibraryEntry({
            galleryId: 700002,
            title: 'Valid Archive Gallery',
            format: 'cbz',
            path: validFilePath,
            pages: 18
        }, ctx.db);
        await dbMod.enqueueGallery({
            galleryId: 700002,
            title: 'Valid Archive Gallery',
            status: 'DONE',
            pagesDone: 18,
            pagesTotal: 18
        }, ctx.db);

        // Case 3: Row is SKIPPED with permanent skip in library (404 Not Found)
        await dbMod.upsertLibraryEntry({
            galleryId: 700003,
            title: 'Skipped 404 Gallery',
            format: 'skipped',
            path: '',
            skipped: true,
            reason: '404 Not Found'
        }, ctx.db);
        await dbMod.enqueueGallery({
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
        await dbMod.importListText(listText, { replace: false }, ctx.db);

        // Case 1 must be reset to PENDING, pages_done = 0, error = null, and stale library entry deleted
        const row1 = await dbMod.getQueueItem(700001, ctx.db);
        assert.strictEqual(row1.status, 'PENDING');
        assert.strictEqual(row1.pages_done, 0);
        assert.strictEqual(row1.error, null);
        assert.strictEqual(await dbMod.getLibraryEntry(700001, ctx.db), null);

        // Case 2 must stay DONE and keep its library entry
        const row2 = await dbMod.getQueueItem(700002, ctx.db);
        assert.strictEqual(row2.status, 'DONE');
        assert.strictEqual(row2.pages_done, 18);
        assert.ok(await dbMod.getLibraryEntry(700002, ctx.db));

        // Case 3 (permanent skip 404) must stay SKIPPED and keep its skipped library entry
        const row3 = await dbMod.getQueueItem(700003, ctx.db);
        assert.strictEqual(row3.status, 'SKIPPED');
        const lib3 = await dbMod.getLibraryEntry(700003, ctx.db);
        assert.ok(lib3 && lib3.skipped);
    } finally {
        await ctx.cleanup();
    }
});

test('BUG 3: migrates downloadDir, downloadFormat, and autoContinueBatches from legacy config.json when settings table is empty without overwriting existing settings or modifying config.json', async () => {
    const ctx = await createTempDb();
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
        const migrated = await dbMod.migrateLegacyConfigJson(configPath, ctx.db);
        assert.strictEqual(migrated, true);
        assert.strictEqual(await dbMod.getSetting('downloadDir', null, ctx.db), 'D:\\Manga\\NHDL_Custom');
        assert.strictEqual(await dbMod.getSetting('downloadFormat', null, ctx.db), 'folder');
        assert.strictEqual(await dbMod.getSetting('autoContinueBatches', null, ctx.db), false);

        // Verify event logged in events table
        const events = await dbMod.getEvents({ limit: 10 }, ctx.db);
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

        const migratedAgain = await dbMod.migrateLegacyConfigJson(newConfigPath, ctx.db);
        assert.strictEqual(migratedAgain, false);
        assert.strictEqual(await dbMod.getSetting('downloadDir', null, ctx.db), 'D:\\Manga\\NHDL_Custom');
        assert.strictEqual(await dbMod.getSetting('downloadFormat', null, ctx.db), 'folder');
        assert.strictEqual(await dbMod.getSetting('autoContinueBatches', null, ctx.db), false);
    } finally {
        await ctx.cleanup();
    }
});

test('A1: unmounted/unhealthy download folder aborts rescan and _runBatchBody without deleting library entries or resetting DONE items', async () => {
    const ctx = await createTempDb();
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

            await dbMod.upsertLibraryEntry({
                galleryId: gid,
                title: `Gallery ${gid}`,
                format: 'cbz',
                path: cbzPath,
                pages: 10
            }, ctx.db);
            await dbMod.enqueueGallery({
                galleryId: gid,
                title: `Gallery ${gid}`,
                status: 'DONE',
                pagesDone: 10,
                pagesTotal: 10
            }, ctx.db);
        }

        // Case 1: Download folder does not exist at all (unmounted drive)
        const nonExistentDir = path.join(os.tmpdir(), 'nhdl-unmounted-disk-' + Date.now());
        assert.strictEqual(await trackerMod.isDownloadDirHealthy(nonExistentDir), false);
        const rescanUnmounted = await trackerMod.rescanLibrary(nonExistentDir);
        assert.strictEqual(rescanUnmounted.aborted, true);
        assert.strictEqual(rescanUnmounted.pruned, 0);
        assert.strictEqual((await dbMod.getAllLibraryEntries(ctx.db)).length, 20);

        const eng = new DownloaderEngine({ baseDownloadDir: nonExistentDir, skipStartupJitter: true });
        await eng.runBatch();
        assert.strictEqual(eng.getStatus(), 'Download folder unavailable');
        // No DONE items should have been reset to PENDING
        assert.strictEqual((await dbMod.getQueueItems({ status: 'DONE' }, ctx.db)).length, 20);
        assert.strictEqual((await dbMod.getQueueItems({ status: 'PENDING' }, ctx.db)).length, 0);

        // Case 2: 60% of files (12 out of 20) are missing -> rescan must abort and keep all 20 library entries
        for (let i = 0; i < 12; i++) {
            fs.unlinkSync(paths[i].cbzPath);
            fs.unlinkSync(`${paths[i].cbzPath}.nhdl-id`);
        }
        assert.strictEqual(await trackerMod.isDownloadDirHealthy(dlDir), false);
        const rescan60Missing = await trackerMod.rescanLibrary(dlDir);
        assert.strictEqual(rescan60Missing.aborted, true);
        assert.strictEqual(rescan60Missing.pruned, 0);
        assert.strictEqual((await dbMod.getAllLibraryEntries(ctx.db)).length, 20);

        // Restore 11 of the 12 deleted files so only 1 out of 20 (5%) is missing
        for (let i = 1; i < 12; i++) {
            fs.writeFileSync(paths[i].cbzPath, Buffer.from('PK\x03\x04valid-cbz-content'));
            fs.writeFileSync(`${paths[i].cbzPath}.nhdl-id`, String(paths[i].gid), 'utf-8');
        }

        // Case 3: 1 out of 20 files missing (5% <= 50%) -> healthy, normal rescan prunes the 1 missing entry
        assert.strictEqual(await trackerMod.isDownloadDirHealthy(dlDir), true);
        const rescan1Missing = await trackerMod.rescanLibrary(dlDir);
        assert.strictEqual(Boolean(rescan1Missing.aborted), false);
        assert.strictEqual(rescan1Missing.pruned, 1);
        assert.strictEqual((await dbMod.getAllLibraryEntries(ctx.db)).length, 19);
    } finally {
        try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
        await ctx.cleanup();
    }
});

test('A3: _runBatchBody pre-pass resets DONE with missing file to PENDING, keeps valid DONE untouched, and re-processes ERROR with retries < 5', async () => {
    const ctx = await createTempDb();
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-a3-dl-'));
    const DownloaderEngine = require('../core/engine');

    try {
        const validCbz = path.join(dlDir, 'Valid_900002.cbz');
        fs.writeFileSync(validCbz, Buffer.from('PK\x03\x04valid-cbz-data'));
        const missingCbz = path.join(dlDir, 'Missing_900001.cbz');

        // 1. 900001: DONE in queue, but library file is missing on disk -> should become PENDING & be processed
        await dbMod.upsertLibraryEntry({
            galleryId: 900001,
            title: 'Missing File Gallery',
            format: 'cbz',
            path: missingCbz,
            pages: 12
        }, ctx.db);
        await dbMod.enqueueGallery({
            galleryId: 900001,
            title: 'Missing File Gallery',
            status: 'DONE',
            pagesDone: 12,
            pagesTotal: 12
        }, ctx.db);

        // 2. 900002: DONE in queue, and library file exists on disk -> must stay DONE and not be re-downloaded
        await dbMod.upsertLibraryEntry({
            galleryId: 900002,
            title: 'Valid File Gallery',
            format: 'cbz',
            path: validCbz,
            pages: 16
        }, ctx.db);
        await dbMod.enqueueGallery({
            galleryId: 900002,
            title: 'Valid File Gallery',
            status: 'DONE',
            pagesDone: 16,
            pagesTotal: 16
        }, ctx.db);

        // 3. 900003: ERROR with retries = 2 (< 5) -> must be re-queued to PENDING and processed
        await dbMod.enqueueGallery({
            galleryId: 900003,
            title: 'Transient Error Gallery',
            status: 'ERROR',
            error: 'Network timeout',
            retries: 2
        }, ctx.db);

        // 4. 900004: ERROR with retries = 5 (>= 5) -> must remain ERROR and NOT be processed
        await dbMod.enqueueGallery({
            galleryId: 900004,
            title: 'Permanent Error Gallery',
            status: 'ERROR',
            error: 'Max retries reached',
            retries: 5
        }, ctx.db);

        const eng = new DownloaderEngine({ baseDownloadDir: dlDir, skipStartupJitter: true });
        const processedIds = [];
        const statusDuringProcess = {};

        eng.processGallery = async (galleryId) => {
            const numId = Number(galleryId);
            const rowBefore = await dbMod.getQueueItem(numId, ctx.db);
            statusDuringProcess[numId] = rowBefore.status;
            processedIds.push(numId);
            await dbMod.updateQueueStatus(numId, 'DONE', { pagesDone: 10, pagesTotal: 10 }, ctx.db);
            return { status: 'SUCCESS', numPages: 10, skipped: false };
        };

        await eng._runBatchBody();

        // Both 900001 (missing DONE) and 900003 (ERROR retries < 5) must have been reset to PENDING and processed
        assert.deepStrictEqual(processedIds, [900001, 900003]);
        assert.strictEqual(statusDuringProcess[900001], 'PENDING');
        assert.strictEqual(statusDuringProcess[900003], 'PENDING');

        // Stale library entry for 900001 was pruned by pre-pass
        assert.strictEqual(await dbMod.getLibraryEntry(900001, ctx.db), null);
        // Valid library entry for 900002 remains intact and status stays DONE
        assert.ok(await dbMod.getLibraryEntry(900002, ctx.db));
        assert.strictEqual((await dbMod.getQueueItem(900002, ctx.db)).status, 'DONE');
        // 900004 (retries = 5) remains ERROR
        assert.strictEqual((await dbMod.getQueueItem(900004, ctx.db)).status, 'ERROR');
    } finally {
        try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
        await ctx.cleanup();
    }
});

test('A1 regression fix: empty library creates missing DOWNLOAD_DIR and processes queue; non-empty library does NOT create missing folder and auto-recovers when mounted', async () => {
    const ctx = await createTempDb();
    const DownloaderEngine = require('../core/engine');
    const freshMissingDir = path.join(path.dirname(ctx.dbPath), 'fresh-custom-dl');
    const mountedLaterDir = path.join(path.dirname(ctx.dbPath), 'mounted-later-dl');

    let engFresh = null;
    let engUnmounted = null;
    try {
        // Scenario 1: Empty library + missing DOWNLOAD_DIR -> folder is created and item is processed
        assert.strictEqual(fs.existsSync(freshMissingDir), false);
        await dbMod.enqueueGallery({ galleryId: 910001, status: 'PENDING', batch: 1 }, ctx.db);

        engFresh = new DownloaderEngine({
            baseDownloadDir: freshMissingDir,
            skipStartupJitter: true
        });
        assert.strictEqual(fs.existsSync(freshMissingDir), true, 'Constructor must create missing DOWNLOAD_DIR when library is empty');

        // Even if deleted right before _runBatchBody, _runBatchBody creates it when library has no active entries
        fs.rmSync(freshMissingDir, { recursive: true, force: true });
        assert.strictEqual(fs.existsSync(freshMissingDir), false);

        const processedFresh = [];
        engFresh.processGallery = async (galleryId) => {
            const numId = Number(galleryId);
            processedFresh.push(numId);
            const savedFile = path.join(freshMissingDir, `${numId}.cbz`);
            fs.writeFileSync(savedFile, 'cbz');
            await dbMod.upsertLibraryEntry({
                galleryId: numId,
                title: 'Fresh Downloaded Item',
                path: savedFile,
                pages: 8,
                skipped: false
            }, ctx.db);
            await dbMod.updateQueueStatus(numId, 'DONE', { pagesDone: 8, pagesTotal: 8 }, ctx.db);
            return { status: 'SUCCESS', numPages: 8, skipped: false };
        };

        await engFresh._runBatchBody();
        assert.strictEqual(fs.existsSync(freshMissingDir), true, '_runBatchBody must create missing DOWNLOAD_DIR when library is empty');
        assert.deepStrictEqual(processedFresh, [910001]);
        assert.strictEqual((await dbMod.getQueueItem(910001, ctx.db)).status, 'DONE');
        assert.strictEqual(engFresh.getStatus(), 'IDLE');

        // Scenario 2: Library has active entry + folder does NOT exist -> folder is NOT created, status is "Download folder unavailable"
        const existingItemPath = path.join(mountedLaterDir, 'Artist', '(C99) [Artist] Book');
        await dbMod.upsertLibraryEntry({
            galleryId: 910002,
            title: 'Existing Library Item',
            artist: 'Artist',
            path: existingItemPath,
            pages: 15,
            skipped: false
        }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 910003, status: 'PENDING', batch: 1 }, ctx.db);

        assert.strictEqual(fs.existsSync(mountedLaterDir), false);
        engUnmounted = new DownloaderEngine({
            baseDownloadDir: mountedLaterDir,
            skipStartupJitter: true,
            healthCheckIntervalMs: 30
        });
        // Must NOT create mountedLaterDir when library has active entries, and status is immediately unavailable!
        assert.strictEqual(fs.existsSync(mountedLaterDir), false);
        assert.strictEqual(engUnmounted.getStatus(), 'Download folder unavailable');

        const processedMounted = [];
        engUnmounted.processGallery = async (galleryId) => {
            const numId = Number(galleryId);
            processedMounted.push(numId);
            await dbMod.updateQueueStatus(numId, 'DONE', { pagesDone: 12, pagesTotal: 12 }, ctx.db);
            return { status: 'SUCCESS', numPages: 12, skipped: false };
        };

        await engUnmounted.runBatch();
        assert.strictEqual(fs.existsSync(mountedLaterDir), false, 'Must NOT mkdir over unmounted path when library has entries');
        assert.strictEqual(engUnmounted.getStatus(), 'Download folder unavailable');
        assert.strictEqual((await dbMod.getQueueItem(910003, ctx.db)).status, 'PENDING');

        // Scenario 3: Disk mounts a moment later -> automatic health check clears statusReason, logs event, and processes queue
        fs.mkdirSync(existingItemPath, { recursive: true });
        fs.writeFileSync(path.join(existingItemPath, '1.jpg'), 'img');

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for automatic download folder recovery')), 2000);
            const poll = setInterval(async () => {
                const item910003 = await dbMod.getQueueItem(910003, ctx.db);
                if (item910003 && item910003.status === 'DONE' && engUnmounted.getStatus() === 'IDLE') {
                    clearInterval(poll);
                    clearTimeout(timeout);
                    resolve();
                }
            }, 15);
        });

        assert.strictEqual(engUnmounted.statusReason, null);
        assert.strictEqual(engUnmounted.getStatus(), 'IDLE');
        assert.deepStrictEqual(processedMounted, [910003]);
        assert.strictEqual((await dbMod.getQueueItem(910003, ctx.db)).status, 'DONE');

        const events = await dbMod.getEvents({ limit: 20 }, ctx.db);
        assert.ok(
            events.some(e => e.message && e.message.includes('Download folder recovered')),
            'Expected recovery event in events table'
        );
        engUnmounted.stopDownloadDirWatch();
    } finally {
        try { engFresh?.stopDownloadDirWatch?.(); } catch (e) {}
        try { engUnmounted?.stopDownloadDirWatch?.(); } catch (e) {}
        try { fs.rmSync(freshMissingDir, { recursive: true, force: true }); } catch (e) {}
        try { fs.rmSync(mountedLaterDir, { recursive: true, force: true }); } catch (e) {}
        await ctx.cleanup();
    }
});

test('Auto-recovery with downloadDirUnavailable flag: recovers from empty folder and >50% missing reasons without losing library entries or resetting DONE items', async () => {
    const ctx = await createTempDb();
    const DownloaderEngine = require('../core/engine');
    const { rescanLibrary } = require('../core/tracker');
    const mntDir = path.join(path.dirname(ctx.dbPath), 'mnt');
    fs.mkdirSync(mntDir, { recursive: true });

    try {
        // Seed 12 library entries (.cbz) and 12 DONE queue items pointing inside mntDir (while mntDir is currently empty)
        const cbzPaths = [];
        for (let i = 1; i <= 12; i++) {
            const gid = 920000 + i;
            const p = path.join(mntDir, `Gallery_${gid}.cbz`);
            cbzPaths.push({ gid, path: p });
            await dbMod.upsertLibraryEntry({
                galleryId: gid,
                title: `Gallery ${gid}`,
                format: 'cbz',
                path: p,
                pages: 20,
                skipped: false
            }, ctx.db);
            await dbMod.enqueueGallery({
                galleryId: gid,
                status: 'DONE',
                pagesDone: 20,
                pagesTotal: 20,
                batch: 1
            }, ctx.db);
        }

        const eng = new DownloaderEngine({
            baseDownloadDir: mntDir,
            skipStartupJitter: true,
            healthCheckIntervalMs: 25
        });

        // 1. Folder exists but is empty while library has 12 entries -> rescanLibrary aborts with specific reason
        const rescanEmpty = await rescanLibrary(mntDir);
        assert.strictEqual(rescanEmpty.aborted, true);
        assert.strictEqual(rescanEmpty.reason, 'Download folder is empty while library has entries');
        eng.markDownloadDirUnavailable(rescanEmpty.reason);

        // Wait several watcher ticks while folder is still empty
        await new Promise(r => setTimeout(r, 90));

        // Must remain unavailable and watcher must NOT have stopped on tick 1!
        assert.strictEqual(eng.downloadDirUnavailable, true);
        assert.strictEqual(eng.getStatus(), 'Download folder is empty while library has entries');
        assert.notStrictEqual(eng._downloadDirWatchTimer, null, 'Watcher timer must keep running while folder is empty');
        assert.strictEqual((await dbMod.getAllLibraryEntries(ctx.db)).length, 12, 'No library entry should be deleted while disk is unmounted');
        assert.strictEqual((await dbMod.getQueueItems({ status: 'DONE' }, ctx.db)).length, 12, 'No DONE queue item should be reset to PENDING');

        // 2. Write only 5 of 12 files (7/12 = 58.3% still missing, >50% threshold)
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(cbzPaths[i].path, 'PK\x03\x04cbz');
            fs.writeFileSync(`${cbzPaths[i].path}.nhdl-id`, String(cbzPaths[i].gid));
        }

        const rescanPartial = await rescanLibrary(mntDir);
        assert.strictEqual(rescanPartial.aborted, true);
        assert.ok(rescanPartial.reason.includes('More than 50% of library entries missing'));
        eng.markDownloadDirUnavailable(rescanPartial.reason);

        await new Promise(r => setTimeout(r, 90));
        assert.strictEqual(eng.downloadDirUnavailable, true);
        assert.ok(eng.getStatus().includes('More than 50% of library entries missing'));
        assert.notStrictEqual(eng._downloadDirWatchTimer, null, 'Watcher timer must keep running when >50% files are missing');
        assert.strictEqual((await dbMod.getAllLibraryEntries(ctx.db)).length, 12);
        assert.strictEqual((await dbMod.getQueueItems({ status: 'DONE' }, ctx.db)).length, 12);

        // 3. Restore the remaining 7 files and enqueue 1 PENDING item to verify auto-run on recovery
        await dbMod.enqueueGallery({ galleryId: 920099, status: 'PENDING', batch: 1 }, ctx.db);
        const processedAfterRecovery = [];
        eng.processGallery = async (galleryId) => {
            const numId = Number(galleryId);
            processedAfterRecovery.push(numId);
            const p = path.join(mntDir, `Gallery_${numId}.cbz`);
            fs.writeFileSync(p, 'PK\x03\x04cbz');
            fs.writeFileSync(`${p}.nhdl-id`, String(numId));
            await dbMod.upsertLibraryEntry({ galleryId: numId, title: `Gallery ${numId}`, format: 'cbz', path: p, pages: 10 }, ctx.db);
            await dbMod.updateQueueStatus(numId, 'DONE', { pagesDone: 10, pagesTotal: 10 }, ctx.db);
            return { status: 'SUCCESS', numPages: 10, skipped: false };
        };

        for (let i = 5; i < 12; i++) {
            fs.writeFileSync(cbzPaths[i].path, 'PK\x03\x04cbz');
            fs.writeFileSync(`${cbzPaths[i].path}.nhdl-id`, String(cbzPaths[i].gid));
        }

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for recovery from >50% missing')), 2000);
            const check = setInterval(async () => {
                const q99 = await dbMod.getQueueItem(920099, ctx.db);
                if (!eng.downloadDirUnavailable && eng._downloadDirWatchTimer === null && q99 && q99.status === 'DONE' && !eng.isRunning) {
                    clearInterval(check);
                    clearTimeout(timeout);
                    resolve();
                }
            }, 15);
        });

        assert.strictEqual(eng.downloadDirUnavailable, false);
        assert.strictEqual(eng.statusReason, null);
        assert.strictEqual(eng._downloadDirWatchTimer, null);
        assert.strictEqual(eng.getStatus(), 'IDLE');
        assert.deepStrictEqual(processedAfterRecovery, [920099]);
        assert.strictEqual((await dbMod.getAllLibraryEntries(ctx.db)).length, 13);
        assert.strictEqual((await dbMod.getQueueItems({ status: 'DONE' }, ctx.db)).length, 13);
    } finally {
        try { fs.rmSync(mntDir, { recursive: true, force: true }); } catch (e) {}
        await ctx.cleanup();
    }
});

test('Fase 4 A1: STOPPED items are not touched by requeueFailedItems() or _runBatchBody pre-pass, and resume transitions STOPPED -> PENDING', async () => {
    const ctx = await createTempDb();
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-f4-a1-'));
    const DownloaderEngine = require('../core/engine');

    try {
        await dbMod.enqueueGallery({ galleryId: 930001, status: 'PENDING', batch: 1 }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 930002, status: 'ERROR', error: 'Temp fail', retries: 1, batch: 1 }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 930003, status: 'PAUSED', error: 'Circuit breaker', retries: 2, batch: 1 }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 930004, status: 'PENDING', batch: 1 }, ctx.db);

        // Pause 930001, 930002, 930003 manually -> status becomes STOPPED
        const pauseRes = await dbMod.pauseQueueItems([930001, 930002, 930003], ctx.db);
        assert.strictEqual(pauseRes.paused, 3);
        assert.strictEqual((await dbMod.getQueueItem(930001, ctx.db)).status, 'STOPPED');
        assert.strictEqual((await dbMod.getQueueItem(930002, ctx.db)).status, 'STOPPED');
        assert.strictEqual((await dbMod.getQueueItem(930003, ctx.db)).status, 'STOPPED');

        // Calling requeueFailedItems() must NOT touch STOPPED items
        const requeued = await dbMod.requeueFailedItems({ maxRetries: 5 }, ctx.db);
        assert.strictEqual(requeued, 0);
        assert.strictEqual((await dbMod.getQueueItem(930001, ctx.db)).status, 'STOPPED');
        assert.strictEqual((await dbMod.getQueueItem(930002, ctx.db)).status, 'STOPPED');
        assert.strictEqual((await dbMod.getQueueItem(930003, ctx.db)).status, 'STOPPED');

        // Running _runBatchBody pre-pass must NOT touch STOPPED items; only 930004 (PENDING) is processed
        const eng = new DownloaderEngine({ baseDownloadDir: dlDir, skipStartupJitter: true });
        const processedIds = [];
        eng.processGallery = async (galleryId) => {
            const numId = Number(galleryId);
            processedIds.push(numId);
            await dbMod.updateQueueStatus(numId, 'DONE', { pagesDone: 5, pagesTotal: 5 }, ctx.db);
            return { status: 'SUCCESS', numPages: 5, skipped: false };
        };

        await eng._runBatchBody();
        assert.deepStrictEqual(processedIds, [930004]);
        assert.strictEqual((await dbMod.getQueueItem(930001, ctx.db)).status, 'STOPPED');
        assert.strictEqual((await dbMod.getQueueItem(930002, ctx.db)).status, 'STOPPED');
        assert.strictEqual((await dbMod.getQueueItem(930003, ctx.db)).status, 'STOPPED');
        assert.strictEqual((await dbMod.getQueueItem(930004, ctx.db)).status, 'DONE');

        // Resuming 930001 transitions STOPPED -> PENDING and clears error
        const resumeRes = await dbMod.resumeQueueItems([930001, 930002], ctx.db);
        assert.strictEqual(resumeRes.resumed, 2);
        assert.strictEqual((await dbMod.getQueueItem(930001, ctx.db)).status, 'PENDING');
        assert.strictEqual((await dbMod.getQueueItem(930002, ctx.db)).status, 'PENDING');
        assert.strictEqual((await dbMod.getQueueItem(930002, ctx.db)).error, null);
        assert.strictEqual((await dbMod.getQueueItem(930003, ctx.db)).status, 'STOPPED');
    } finally {
        try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
        await ctx.cleanup();
    }
});

test('Fase 4 A1 & A2: pausing an ON_PROGRESS gallery stops safely at the next page boundary, keeps downloaded files, sets STOPPED, and continues to next item; delete removes from queue without touching disk/library', async () => {
    const ctx = await createTempDb();
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-f4-page-boundary-'));
    const DownloaderEngine = require('../core/engine');

    try {
        await dbMod.enqueueGallery({ galleryId: 940001, status: 'PENDING', batch: 1 }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 940002, status: 'PENDING', batch: 1 }, ctx.db);

        const eng = new DownloaderEngine({
            baseDownloadDir: dlDir,
            downloadFormat: 'folder',
            concurrency: 1,
            skipStartupJitter: true
        });

        // Stub fetchMetadata (0 network requests)
        eng.fetchMetadata = async (galleryId) => ({
            title: `Stub_Gallery_${galleryId}`,
            mediaId: String(galleryId),
            numPages: 5,
            ext: 'jpg',
            pageExts: { 1: 'jpg', 2: 'jpg', 3: 'jpg', 4: 'jpg', 5: 'jpg' },
            langStr: 'English',
            authorStr: 'StubAuthor',
            extraMeta: {}
        });

        const downloadedPagesByGallery = { 940001: [], 940002: [] };

        // Stub downloadImage: write a valid >2KB JPEG buffer so verifyImage(destPath) returns true.
        // When gallery 940001 finishes downloading page 2, trigger pauseQueueItems([940001]) + eng.stopGallery(940001)!
        eng.downloadImage = async (_url, destPath, _host, onProgress) => {
            const m = destPath.match(/Stub_Gallery_(\d+)[\\/](\d+)\.jpg$/);
            const gid = m ? Number(m[1]) : 0;
            const pageNum = m ? Number(m[2]) : 0;

            const fakeJpg = Buffer.alloc(3072, 0xff);
            fs.writeFileSync(destPath, fakeJpg);
            if (onProgress) onProgress(fakeJpg.length, fakeJpg.length);
            downloadedPagesByGallery[gid].push(pageNum);

            if (gid === 940001 && pageNum === 2) {
                await dbMod.pauseQueueItems([940001], ctx.db);
                eng.stopGallery(940001);
            }
        };

        await eng.runBatch();

        // 1. Gallery 940001 stopped right after page 2 (did NOT download pages 3, 4, 5)
        assert.deepStrictEqual(downloadedPagesByGallery[940001], [1, 2]);
        const row1 = await dbMod.getQueueItem(940001, ctx.db);
        assert.strictEqual(row1.status, 'STOPPED');
        assert.strictEqual(row1.pages_done, 2);
        assert.strictEqual(row1.pages_total, 5);

        // Downloaded page files 1.jpg and 2.jpg on disk must NOT be deleted
        const folder940001 = path.join(dlDir, 'English', 'StubAuthor', 'Stub_Gallery_940001');
        assert.strictEqual(fs.existsSync(path.join(folder940001, '1.jpg')), true);
        assert.strictEqual(fs.existsSync(path.join(folder940001, '2.jpg')), true);
        assert.strictEqual(fs.existsSync(path.join(folder940001, '3.jpg')), false);

        // 2. Engine continued to gallery 940002 and downloaded all 5 pages to completion
        assert.deepStrictEqual(downloadedPagesByGallery[940002], [1, 2, 3, 4, 5]);
        const row2 = await dbMod.getQueueItem(940002, ctx.db);
        assert.strictEqual(row2.status, 'DONE');
        assert.strictEqual(row2.pages_done, 5);
        const lib2 = await dbMod.getLibraryEntry(940002, ctx.db);
        assert.ok(lib2, '940002 must be in library table');

        // 3. Delete 940001 and 940002 from queue -> queue rows removed, but disk files and library table untouched!
        const delRes = await dbMod.deleteQueueItems([940001, 940002], ctx.db);
        assert.strictEqual(delRes.deleted, 2);
        assert.strictEqual(await dbMod.getQueueItem(940001, ctx.db), null);
        assert.strictEqual(await dbMod.getQueueItem(940002, ctx.db), null);
        assert.strictEqual(fs.existsSync(path.join(folder940001, '1.jpg')), true, 'Delete must not remove partial files on disk');
        assert.strictEqual(fs.existsSync(path.join(folder940001, '2.jpg')), true, 'Delete must not remove partial files on disk');
        const folder940002 = path.join(dlDir, 'English', 'StubAuthor', 'Stub_Gallery_940002');
        assert.strictEqual(fs.existsSync(path.join(folder940002, '5.jpg')), true, 'Delete must not remove completed files on disk');
        assert.ok(await dbMod.getLibraryEntry(940002, ctx.db), 'Delete must not remove entry from library table');
    } finally {
        try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
        await ctx.cleanup();
    }
});

test('Fase 4 A3: updateQueuePriority (top, up, down, bottom) matches getNextPendingItem() order', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 950001, status: 'PENDING', batch: 1 }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 950002, status: 'PENDING', batch: 1 }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 950003, status: 'PENDING', batch: 1 }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 950004, status: 'PENDING', batch: 1 }, ctx.db);

        // Initial order: 950001, 950002, 950003, 950004
        assert.strictEqual((await dbMod.getNextPendingItem(ctx.db)).gallery_id, 950001);

        // Move 950003 to "top" -> 950003 becomes first
        await dbMod.updateQueuePriority([950003], 'top', ctx.db);
        assert.strictEqual((await dbMod.getNextPendingItem(ctx.db)).gallery_id, 950003);

        // Move 950003 "down" by 1 step -> order becomes 950001, 950003, 950002, 950004
        await dbMod.updateQueuePriority([950003], 'down', ctx.db);
        assert.strictEqual((await dbMod.getNextPendingItem(ctx.db)).gallery_id, 950001);

        // Move 950004 "up" by 3 steps (or 2 steps then 1 step) to reach the top
        await dbMod.updateQueuePriority([950004], 'up', ctx.db); // above 950002
        await dbMod.updateQueuePriority([950004], 'up', ctx.db); // above 950003
        await dbMod.updateQueuePriority([950004], 'up', ctx.db); // above 950001
        assert.strictEqual((await dbMod.getNextPendingItem(ctx.db)).gallery_id, 950004);

        // Move 950004 to "bottom" -> 950001 is back at the top
        await dbMod.updateQueuePriority([950004], 'bottom', ctx.db);
        assert.strictEqual((await dbMod.getNextPendingItem(ctx.db)).gallery_id, 950001);
    } finally {
        await ctx.cleanup();
    }
});

test('updateQueuePriority > 500 items: 1000-item #500 up/down/top/bottom, multi-select 3 items up, and 5000-item normalization < 200ms with 1 SSE event', async () => {
    const ctx = await createTempDb();
    try {
        const getOrderedGalleryIds = () =>
            ctx.db
                .prepare('SELECT gallery_id FROM queue ORDER BY priority DESC, id ASC')
                .all()
                .map((r) => Number(r.gallery_id));

        // 1. Seed 1000 items with priority 0 (gallery_id 960001 .. 961000)
        ctx.db.exec('BEGIN IMMEDIATE');
        const ins1000 = ctx.db.prepare(
            `INSERT INTO queue (gallery_id, url, status, priority, batch) VALUES (?, ?, 'PENDING', 0, 1)`
        );
        for (let i = 1; i <= 1000; i++) {
            const gid = 960000 + i;
            ins1000.run(gid, `https://certain.site/g/${gid}/`);
        }
        ctx.db.exec('COMMIT');

        const item500 = 960500; // 1-based #500 (0-based index 499)
        assert.strictEqual(getOrderedGalleryIds()[499], item500);

        // #500 -> up -> #499 (0-based index 498)
        await dbMod.updateQueuePriority([item500], 'up', ctx.db);
        let ordered = getOrderedGalleryIds();
        assert.strictEqual(ordered.indexOf(item500) + 1, 499, 'Expected #500 up to land at #499, not #1');
        assert.strictEqual(ordered.indexOf(960499) + 1, 500, 'Expected former #499 neighbor to swap to #500');

        // From #499 -> down 2x -> #500 then #501 (and verify subsequent single-item swap only updates 2 rows)
        const emittedEvents = [];
        const onItem = (evt) => emittedEvents.push(evt);
        dbMod.dbEvents.on('item', onItem);
        try {
            await dbMod.updateQueuePriority([item500], 'down', ctx.db);
            assert.strictEqual(getOrderedGalleryIds().indexOf(item500) + 1, 500);
            assert.strictEqual(emittedEvents.length, 1);
            assert.strictEqual(emittedEvents[0].type, 'reordered');
            assert.strictEqual(emittedEvents[0].items.length, 2, 'Subsequent 1-item down should only update 2 swapped rows');

            await dbMod.updateQueuePriority([item500], 'down', ctx.db);
            assert.strictEqual(getOrderedGalleryIds().indexOf(item500) + 1, 501, 'Expected down 2x to land at #501, not #1000');
        } finally {
            dbMod.dbEvents.off('item', onItem);
        }

        // #501 -> top -> #1 (and matches getNextPendingItem)
        await dbMod.updateQueuePriority([item500], 'top', ctx.db);
        assert.strictEqual(getOrderedGalleryIds().indexOf(item500) + 1, 1);
        assert.strictEqual((await dbMod.getNextPendingItem(ctx.db)).gallery_id, item500);

        // #1 -> bottom -> #1000
        await dbMod.updateQueuePriority([item500], 'bottom', ctx.db);
        assert.strictEqual(getOrderedGalleryIds().indexOf(item500) + 1, 1000);

        // 2. Multi-select 3 consecutive items in the middle (#500, #501, #502 in current order) -> up -> #499, #500, #501 preserving internal order
        ordered = getOrderedGalleryIds();
        const neighborAbove = ordered[498]; // #499
        const block3 = [ordered[499], ordered[500], ordered[501]]; // #500, #501, #502
        await dbMod.updateQueuePriority(block3, 'up', ctx.db);
        ordered = getOrderedGalleryIds();
        assert.deepStrictEqual(
            [ordered[498], ordered[499], ordered[500]],
            block3,
            '3 consecutive selected items must move up 1 position and keep internal order'
        );
        assert.strictEqual(ordered[501], neighborAbove, 'The neighbor originally at #499 must now be at #502');

        // 3. 5000 items with priority 0: normalization < 200ms and emits exactly 1 SSE event
        ctx.db.exec('DELETE FROM queue');
        ctx.db.exec('BEGIN IMMEDIATE');
        const ins5000 = ctx.db.prepare(
            `INSERT INTO queue (gallery_id, url, status, priority, batch) VALUES (?, ?, 'PENDING', 0, 1)`
        );
        for (let i = 1; i <= 5000; i++) {
            const gid = 970000 + i;
            ins5000.run(gid, `https://certain.site/g/${gid}/`);
        }
        ctx.db.exec('COMMIT');

        const sse5000 = [];
        const onItem5000 = (evt) => sse5000.push(evt);
        dbMod.dbEvents.on('item', onItem5000);
        try {
            const t0 = performance.now();
            await dbMod.updateQueuePriority([972500], 'up', ctx.db);
            const elapsedMs = performance.now() - t0;

            assert.ok(elapsedMs < 200, `Expected 5000-item normalization < 200ms, got ${elapsedMs.toFixed(2)}ms`);
            assert.strictEqual(sse5000.length, 1, `Expected exactly 1 SSE event, got ${sse5000.length}`);
            assert.strictEqual(sse5000[0].type, 'reordered');
            assert.strictEqual(getOrderedGalleryIds().indexOf(972500) + 1, 2499);
        } finally {
            dbMod.dbEvents.off('item', onItem5000);
        }
    } finally {
        await ctx.cleanup();
    }
});

test('Fase 7.4: exportData and importData preserves all tables and supports replace and merge modes', async () => {
    const ctx1 = await createTempDb();
    let exported = null;

    try {
        // 1. Seed data in ctx1
        await dbMod.enqueueGallery({ galleryId: 740001, title: 'Item 1', status: 'PENDING', batch: 1 }, ctx1.db);
        await dbMod.enqueueGallery({ galleryId: 740002, title: 'Item 2', status: 'DONE', batch: 2, pagesDone: 10, pagesTotal: 10 }, ctx1.db);
        await dbMod.upsertLibraryEntry({ galleryId: 740002, title: 'Item 2 Lib', path: '/dummy/path', pages: 10, format: 'cbz' }, ctx1.db);
        await dbMod.setSetting('testKey', { foo: 'bar', n: 42 }, ctx1.db);
        await dbMod.logEvent({ level: 'info', message: 'Test event 7.4' }, ctx1.db);

        // 2. Export from ctx1
        exported = await dbMod.exportData(ctx1.db);
        assert.strictEqual(exported.version, 1);
        assert.strictEqual(exported.db_type, 'sqlite');
        assert.ok(exported.schema_version >= 2);
        assert.strictEqual(exported.tables.queue.length, 2);
        assert.strictEqual(exported.tables.library.length, 1);
        assert.ok(exported.tables.settings.some(s => s.key === 'testKey'));
        assert.ok(exported.tables.events.some(e => e.message === 'Test event 7.4'));
    } finally {
        await ctx1.cleanup();
    }

    const ctx2 = await createTempDb();
    try {
        // 3. Import into empty ctx2 with mode 'replace'
        const importRes = await dbMod.importData(exported, { mode: 'replace' }, ctx2.db);
        assert.strictEqual(importRes.success, true);
        assert.strictEqual(importRes.mode, 'replace');
        assert.strictEqual(importRes.imported.queue, 2);
        assert.strictEqual(importRes.imported.library, 1);

        const qItems = await dbMod.getQueueItems({}, ctx2.db);
        assert.strictEqual(qItems.length, 2);
        assert.strictEqual(Number(qItems[0].gallery_id), 740001);

        const libEntry = await dbMod.getLibraryEntry(740002, ctx2.db);
        assert.ok(libEntry);
        assert.strictEqual(libEntry.title, 'Item 2 Lib');

        const settingVal = await dbMod.getSetting('testKey', null, ctx2.db);
        assert.deepStrictEqual(settingVal, { foo: 'bar', n: 42 });

        // 4. Test mode 'merge'
        await dbMod.enqueueGallery({ galleryId: 740003, title: 'Item 3 in ctx2', status: 'PENDING', batch: 3 }, ctx2.db);
        const mergeRes = await dbMod.importData(exported, { mode: 'merge' }, ctx2.db);
        assert.strictEqual(mergeRes.success, true);
        assert.strictEqual(mergeRes.mode, 'merge');

        const qItemsMerged = await dbMod.getQueueItems({}, ctx2.db);
        assert.strictEqual(qItemsMerged.length, 3, 'Merge mode must retain existing item 740003 and not delete it');
    } finally {
        await ctx2.cleanup();
    }
});

test('Fase 7.4: backup management (createBackup, listBackups, restoreBackup, deleteBackup, 7-backup rotation)', async () => {
    const ctx = await createTempDb();
    const createdFiles = [];

    try {
        await dbMod.enqueueGallery({ galleryId: 750001, title: 'Backup Test Item' }, ctx.db);
        await dbMod.setSetting('backupConfig', 'valid', ctx.db);

        // Create 8 backups to test rotation (keep 7)
        for (let i = 1; i <= 8; i++) {
            const name = `nhdl-backup-test-rot-${String(i).padStart(2, '0')}.json`;
            const b = await dbMod.createBackup(ctx.db, name);
            createdFiles.push(b.filename);
            await new Promise(r => setTimeout(r, 15));
        }

        const backups = dbMod.listBackups();
        const testBackups = backups.filter(b => b.filename.startsWith('nhdl-backup-test-rot-'));
        assert.strictEqual(testBackups.length, 7, 'Rotation must keep at most 7 latest backups');
        assert.strictEqual(testBackups[0].filename, 'nhdl-backup-test-rot-08.json');

        // Modify DB and restore from backup 08
        await dbMod.deleteQueueItem(750001, ctx.db);
        assert.strictEqual(await dbMod.getQueueItem(750001, ctx.db), null);

        const restoreRes = await dbMod.restoreBackup('nhdl-backup-test-rot-08.json', 'replace', ctx.db);
        assert.strictEqual(restoreRes.success, true);
        const restoredItem = await dbMod.getQueueItem(750001, ctx.db);
        assert.ok(restoredItem);
        assert.strictEqual(restoredItem.title, 'Backup Test Item');

        // Delete a backup
        const delRes = dbMod.deleteBackup('nhdl-backup-test-rot-08.json');
        assert.strictEqual(delRes.success, true);
        const afterDelete = dbMod.listBackups().filter(b => b.filename === 'nhdl-backup-test-rot-08.json');
        assert.strictEqual(afterDelete.length, 0);
    } finally {
        // Clean up any test backups created
        for (const f of createdFiles) {
            try { dbMod.deleteBackup(f); } catch (e) {}
        }
        await ctx.cleanup();
    }
});

test('Fase 7.4: HTTP endpoints /api/db/* (info, export, backup, backups, restore, delete, import)', async () => {
    const http = require('node:http');
    const { createRequestHandler } = require('../server/index');
    const ctx = await createTempDb();
    const srv = http.createServer(createRequestHandler());

    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    const testBackupFiles = [];

    const request = (method, urlPath, body = null, headers = {}) => {
        return new Promise((resolve, reject) => {
            const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method, headers }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk.toString(); });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch (e) {}
                    resolve({ statusCode: res.statusCode, headers: res.headers, raw: data, json });
                });
            });
            req.on('error', reject);
            if (body) {
                req.write(typeof body === 'string' ? body : JSON.stringify(body));
            }
            req.end();
        });
    };

    try {
        await dbMod.enqueueGallery({ galleryId: 760001, title: 'Endpoint Test Item' });

        // 1. GET /api/db/info
        const infoRes = await request('GET', '/api/db/info');
        assert.strictEqual(infoRes.statusCode, 200);
        assert.ok(infoRes.json.type === 'sqlite' || infoRes.json.type === 'postgres');
        assert.strictEqual(typeof infoRes.json.connected, 'boolean');

        // 2. GET /api/db/export
        const expRes = await request('GET', '/api/db/export');
        assert.strictEqual(expRes.statusCode, 200);
        assert.match(expRes.headers['content-disposition'], /nhdl-export-.*\.json/);
        assert.ok(expRes.json.tables.queue.some(q => Number(q.gallery_id) === 760001));

        // 3. POST /api/db/backup
        const bName = 'nhdl-backup-test-api.json';
        testBackupFiles.push(bName);
        const bkRes = await request('POST', '/api/db/backup', JSON.stringify({ name: bName }), { 'Content-Type': 'application/json' });
        assert.strictEqual(bkRes.statusCode, 200);
        assert.strictEqual(bkRes.json.success, true);
        assert.strictEqual(bkRes.json.filename, bName);

        // 4. GET /api/db/backups
        const bksRes = await request('GET', '/api/db/backups');
        assert.strictEqual(bksRes.statusCode, 200);
        assert.ok(bksRes.json.backups.some(b => b.filename === bName));

        // 5. POST /api/db/restore
        const restRes = await request('POST', '/api/db/restore', JSON.stringify({ filename: bName, mode: 'replace' }), { 'Content-Type': 'application/json' });
        assert.strictEqual(restRes.statusCode, 200);
        assert.strictEqual(restRes.json.success, true);

        // 6. DELETE /api/db/backups/:name
        const delRes = await request('DELETE', `/api/db/backups/${bName}`);
        assert.strictEqual(delRes.statusCode, 200);
        assert.strictEqual(delRes.json.success, true);

        // 7. POST /api/db/import
        const impRes = await request('POST', '/api/db/import', JSON.stringify({
            mode: 'merge',
            data: expRes.json
        }), { 'Content-Type': 'application/json' });
        assert.strictEqual(impRes.statusCode, 200);
        assert.strictEqual(impRes.json.success, true);
    } finally {
        for (const f of testBackupFiles) {
            try { dbMod.deleteBackup(f); } catch (e) {}
        }
        await new Promise(r => srv.close(r));
        await ctx.cleanup();
    }
});

test('Fase 7.5: autoMigrateSqliteToPostgres transfers data when Postgres is empty and renames SQLite to .migrated', async () => {
    const ctx = await createTempDb();
    const tempDir = path.dirname(ctx.dbPath);
    const mockSqlitePath = path.join(tempDir, 'source-test.db');

    try {
        // Seed a standalone SQLite db file
        const { DatabaseSync } = require('node:sqlite');
        const sDb = new DatabaseSync(mockSqlitePath);
        sDb.exec(`
            CREATE TABLE schema_version (version INTEGER NOT NULL);
            INSERT INTO schema_version (version) VALUES (2);
            CREATE TABLE queue (
                id INTEGER PRIMARY KEY,
                gallery_id INTEGER NOT NULL UNIQUE,
                url TEXT NOT NULL,
                title TEXT,
                status TEXT NOT NULL DEFAULT 'PENDING',
                batch INTEGER NOT NULL DEFAULT 1,
                priority INTEGER NOT NULL DEFAULT 0,
                pages_done INTEGER NOT NULL DEFAULT 0,
                pages_total INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                retries INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                format TEXT
            );
            CREATE TABLE library (
                gallery_id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                path TEXT NOT NULL,
                pages INTEGER,
                format TEXT,
                language TEXT,
                artist TEXT,
                added_at TEXT NOT NULL DEFAULT (datetime('now')),
                meta TEXT
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, level TEXT NOT NULL, gallery_id INTEGER, message TEXT NOT NULL);

            INSERT INTO queue (gallery_id, url, title, status) VALUES (770001, 'https://certain.site/g/770001/', 'Migrated Title', 'PENDING');
            INSERT INTO library (gallery_id, title, path) VALUES (770001, 'Migrated Lib Title', '/tmp/path');
        `);
        sDb.close();

        // 1. Mock empty Postgres pool
        let importedPayload = null;
        let importedOptions = null;
        const postgresAdapter = require('../core/db/postgres');
        const origImportData = postgresAdapter.importData;
        postgresAdapter.importData = async (data, opts) => {
            importedPayload = data;
            importedOptions = opts;
            return {
                success: true,
                imported: { queue: data.tables.queue.length, library: data.tables.library.length, settings: 0, events: 0 }
            };
        };

        const mockPoolEmpty = {
            async query(sql) {
                if (sql.includes('FROM queue') || sql.includes('FROM library')) {
                    return { rows: [{ cnt: 0 }] };
                }
                return { rows: [] };
            }
        };

        try {
            const res = await dbMod.autoMigrateSqliteToPostgres(mockPoolEmpty, { sqlitePath: mockSqlitePath });
            assert.ok(res.migrated);
            assert.strictEqual(res.imported.queue, 1);
            assert.strictEqual(res.imported.library, 1);
            assert.strictEqual(importedOptions.mode, 'replace');
            assert.strictEqual(fs.existsSync(mockSqlitePath), false, 'Original SQLite file must have been renamed');
            assert.strictEqual(fs.existsSync(`${mockSqlitePath}.migrated`), true, 'SQLite file must exist as .migrated');

            // 2. Call again on same path: file no longer exists, returns false
            const res2 = await dbMod.autoMigrateSqliteToPostgres(mockPoolEmpty, { sqlitePath: mockSqlitePath });
            assert.strictEqual(res2, false);

            // 3. Test non-empty Postgres: returns false
            const mockPoolNonEmpty = {
                async query(sql) {
                    if (sql.includes('FROM queue')) return { rows: [{ cnt: 5 }] };
                    return { rows: [{ cnt: 0 }] };
                }
            };
            fs.writeFileSync(mockSqlitePath, 'dummy');
            const res3 = await dbMod.autoMigrateSqliteToPostgres(mockPoolNonEmpty, { sqlitePath: mockSqlitePath });
            assert.strictEqual(res3, false, 'Must not migrate if Postgres is non-empty');
        } finally {
            postgresAdapter.importData = origImportData;
        }
    } finally {
        try { fs.unlinkSync(mockSqlitePath); } catch (e) {}
        try { fs.unlinkSync(`${mockSqlitePath}.migrated`); } catch (e) {}
        await ctx.cleanup();
    }
});

test('Fase 7.7: PostgreSQL schema migrations version 1 to latest execute in order', async () => {
    const postgresAdapter = require('../core/db/postgres');
    assert.ok(Array.isArray(postgresAdapter.MIGRATIONS), 'MIGRATIONS array must exist');
    assert.strictEqual(postgresAdapter.MIGRATIONS.length, 2, 'Must have 2 migrations defined');

    // Test migration v1 query execution
    const executedV1 = [];
    const mockClientV1 = {
        async query(sql, params) {
            executedV1.push({ sql, params });
            return { rows: [] };
        }
    };
    await postgresAdapter.MIGRATIONS[0].up(mockClientV1);
    assert.ok(executedV1.some(e => e.sql.includes('CREATE TABLE IF NOT EXISTS queue')));
    assert.ok(executedV1.some(e => e.sql.includes('CREATE TABLE IF NOT EXISTS library')));
    assert.ok(executedV1.some(e => e.sql.includes('CREATE TABLE IF NOT EXISTS settings')));
    assert.ok(executedV1.some(e => e.sql.includes('CREATE TABLE IF NOT EXISTS events')));

    // Test migration v2 query execution
    const executedV2 = [];
    const mockClientV2 = {
        async query(sql, params) {
            executedV2.push({ sql, params });
            return { rows: [] };
        }
    };
    await postgresAdapter.MIGRATIONS[1].up(mockClientV2);
    assert.ok(executedV2.some(e => e.sql.includes('ALTER TABLE queue ADD COLUMN IF NOT EXISTS format TEXT')));
    assert.ok(executedV2.some(e => e.sql.includes('ALTER TABLE library ADD COLUMN IF NOT EXISTS meta TEXT')));
    assert.ok(executedV2.some(e => e.sql.includes('CREATE INDEX IF NOT EXISTS idx_queue_priority')));

    // Test runMigrations from version 0
    let currentVersionInDb = 0;
    const history = [];
    const mockDb = {
        async query(sql, params) {
            history.push({ sql, params });
            if (sql.includes('information_schema.tables')) {
                return { rows: [{ exists: true }] };
            }
            if (sql.includes('SELECT MAX(version)')) {
                return { rows: [{ v: currentVersionInDb }] };
            }
            if (sql.includes('INSERT INTO schema_version')) {
                currentVersionInDb = params[0];
                return { rows: [] };
            }
            return { rows: [] };
        }
    };

    const finalVer = await postgresAdapter.runMigrations(mockDb);
    assert.strictEqual(finalVer, 2, 'Final schema version must be 2');
    assert.strictEqual(currentVersionInDb, 2, 'schema_version table must record version 2');
});

test('Fase 7.7: Cross-database export SQLite -> import PostgreSQL verifies data integrity', async () => {
    const sqliteAdapter = require('../core/db/sqlite');
    const postgresAdapter = require('../core/db/postgres');

    const ctx = await createTempDb();
    try {
        // 1. Populate SQLite database with rich dataset
        await dbMod.enqueueGallery({ galleryId: 101, url: 'https://certain.site/g/101/', title: 'Manga One', batch: 1, priority: 10 }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 102, url: 'https://certain.site/g/102/', title: 'Manga Two', batch: 2, priority: 5, format: 'cbz' }, ctx.db);
        await dbMod.updateQueueStatus(101, 'DONE', null, ctx.db);

        await dbMod.upsertLibraryEntry({
            galleryId: 101,
            title: 'Manga One',
            folder: '/downloads/101',
            pages: 24,
            format: 'cbz',
            language: 'english',
            artist: 'Artist One'
        }, ctx.db);

        await dbMod.setSetting('downloadDir', '/custom/downloads', ctx.db);
        await dbMod.logEvent({ level: 'INFO', message: 'Test event from SQLite', galleryId: 101 }, ctx.db);

        // 2. Export SQLite database
        const exported = await sqliteAdapter.exportData(ctx.db);
        assert.strictEqual(exported.schema_version, 2);
        assert.strictEqual(exported.tables.queue.length, 2);
        assert.strictEqual(exported.tables.library.length, 1);
        assert.ok(exported.tables.settings.some(s => s.key === 'downloadDir'));
        assert.ok(exported.tables.events.some(e => e.message === 'Test event from SQLite'));

        // 3. Import into simulated PostgreSQL adapter
        const pgExecuted = [];
        const mockPgClient = {
            async query(sql, params) {
                pgExecuted.push({ sql, params });
                if (sql.includes('MAX(batch)')) {
                    return { rows: [{ max_batch: 2 }], rowCount: 1 };
                }
                return { rows: [], rowCount: 1 };
            }
        };

        const result = await postgresAdapter.importData(exported, { mode: 'replace' }, mockPgClient);
        assert.ok(result.success);
        assert.strictEqual(result.mode, 'replace');
        assert.strictEqual(result.imported.queue, 2);
        assert.strictEqual(result.imported.library, 1);

        // Verify PostgreSQL queries: TRUNCATE in replace mode, parameterized INSERT
        assert.ok(pgExecuted.some(e => e.sql.includes('BEGIN')));
        assert.ok(pgExecuted.some(e => e.sql.includes('TRUNCATE TABLE')));
        assert.ok(pgExecuted.some(e => e.sql.includes('INSERT INTO queue')));
        assert.ok(pgExecuted.some(e => e.sql.includes('INSERT INTO library')));
        assert.ok(pgExecuted.some(e => e.sql.includes('INSERT INTO settings')));
        assert.ok(pgExecuted.some(e => e.sql.includes('INSERT INTO events')));
        assert.ok(pgExecuted.some(e => e.sql.includes('COMMIT')));

        // Verify values passed into PostgreSQL parameterized inserts
        const queueInserts = pgExecuted.filter(e => e.sql.includes('INSERT INTO queue'));
        assert.strictEqual(queueInserts.length, 2);
        const item1 = queueInserts.find(q => q.params.includes(101));
        assert.ok(item1);
        assert.strictEqual(item1.params[1], 'https://certain.site/g/101/');
        assert.strictEqual(item1.params[2], 'Manga One');

        const libInserts = pgExecuted.filter(e => e.sql.includes('INSERT INTO library'));
        assert.strictEqual(libInserts.length, 1);
        assert.strictEqual(libInserts[0].params[0], 101);
        assert.strictEqual(libInserts[0].params[6], 'Artist One');
    } finally {
        await ctx.cleanup();
    }
});

test('Fase 7.7: PostgreSQL live test suite against real server (skipped if TEST_DATABASE_URL not set)', {
    skip: !process.env.TEST_DATABASE_URL
}, async () => {
    const postgresAdapter = require('../core/db/postgres');
    const testUrl = process.env.TEST_DATABASE_URL;
    const pool = await postgresAdapter.initDb(testUrl, { timeoutMs: 5000 });

    try {
        const ver = await postgresAdapter.getSchemaVersion(pool);
        assert.ok(ver >= 2, 'Live Postgres schema version must be >= 2');

        const gid = 999901;
        await postgresAdapter.enqueueGallery({ galleryId: gid, url: `https://certain.site/g/${gid}/`, title: 'Live Postgres Test' }, pool);
        const item = await postgresAdapter.getQueueItem(gid, pool);
        assert.ok(item);
        assert.strictEqual(Number(item.galleryId), gid);
        assert.strictEqual(item.status, 'PENDING');

        await postgresAdapter.updateQueueStatus(gid, 'DONE', null, pool);
        const doneItem = await postgresAdapter.getQueueItem(gid, pool);
        assert.strictEqual(doneItem.status, 'DONE');

        await postgresAdapter.upsertLibraryEntry({
            galleryId: gid,
            title: 'Live Postgres Test',
            folder: `/downloads/${gid}`,
            pages: 10,
            format: 'cbz'
        }, pool);
        const libItem = await postgresAdapter.getLibraryEntry(gid, pool);
        assert.ok(libItem);
        assert.strictEqual(Number(libItem.galleryId), gid);

        const pgExport = await postgresAdapter.exportData(pool);
        assert.ok(pgExport.tables.queue.some(q => Number(q.gallery_id) === gid));
        assert.ok(pgExport.tables.library.some(l => Number(l.gallery_id) === gid));

        await postgresAdapter.deleteQueueItem(gid, pool);
        await postgresAdapter.deleteLibraryEntry(gid, pool);

        // Validation test on live Postgres
        await postgresAdapter.enqueueGallery({ galleryId: 999902, url: `https://certain.site/g/999902/`, title: 'Postgres Validation Test' }, pool);
        await assert.rejects(async () => {
            await postgresAdapter.importData({ hello: 'x' }, { mode: 'replace' }, pool);
        }, /Invalid import format/);

        // Verify data intact
        const item902 = await postgresAdapter.getQueueItem(999902, pool);
        assert.ok(item902);
        assert.strictEqual(Number(item902.galleryId), 999902);
        await postgresAdapter.deleteQueueItem(999902, pool);
    } finally {
        await postgresAdapter.closeDb();
    }
});

test('Point 1: importData rejects invalid payloads, unknown versions, corrupted rows, and empty replace without allowEmpty', async () => {
    const ctx = await createTempDb();
    try {
        // Seed 5 queue items and 2 library entries
        for (let i = 1; i <= 5; i++) {
            await dbMod.enqueueGallery({
                galleryId: 10000 + i,
                url: `https://certain.site/g/${10000 + i}/`,
                title: `Item ${i}`,
                status: 'PENDING'
            }, ctx.db);
        }
        await dbMod.upsertLibraryEntry({
            galleryId: 10001,
            title: 'Library 1',
            path: '/downloads/10001',
            pages: 20
        }, ctx.db);
        await dbMod.upsertLibraryEntry({
            galleryId: 10002,
            title: 'Library 2',
            path: '/downloads/10002',
            pages: 15
        }, ctx.db);

        const verifyDataIntact = async () => {
            const queueItems = await dbMod.getQueueItems({}, ctx.db);
            const libEntries = await dbMod.getAllLibraryEntries(ctx.db);
            assert.strictEqual(queueItems.length, 5, 'Queue items must remain intact');
            assert.strictEqual(libEntries.length, 2, 'Library entries must remain intact');
        };

        await verifyDataIntact();

        // 1. Asal-asalan payload ({ hello: "x" })
        await assert.rejects(async () => {
            await dbMod.importData({ hello: 'x' }, { mode: 'replace' }, ctx.db);
        }, /Invalid import format/);
        await verifyDataIntact();

        // 2. Wrong format string
        await assert.rejects(async () => {
            await dbMod.importData({ format: 'wrong-format', version: 1, tables: {} }, { mode: 'replace' }, ctx.db);
        }, /expected "nhdl-export"/);
        await verifyDataIntact();

        // 3. Unknown export version
        await assert.rejects(async () => {
            await dbMod.importData({ format: 'nhdl-export', version: 999, tables: {} }, { mode: 'replace' }, ctx.db);
        }, /Unknown export version: 999/);
        await verifyDataIntact();

        // 4. Newer schemaVersion than application
        await assert.rejects(async () => {
            await dbMod.importData({ format: 'nhdl-export', version: 1, schemaVersion: 999, tables: { queue: [] } }, { mode: 'replace' }, ctx.db);
        }, /is newer than application schema version/);
        await verifyDataIntact();

        // 5. tables property not an object
        await assert.rejects(async () => {
            await dbMod.importData({ format: 'nhdl-export', version: 1, tables: 'string' }, { mode: 'replace' }, ctx.db);
        }, /"tables" property must be an object/);
        await verifyDataIntact();

        // 6. Table in tables is not an array
        await assert.rejects(async () => {
            await dbMod.importData({ format: 'nhdl-export', version: 1, tables: { queue: 'not-an-array' } }, { mode: 'replace' }, ctx.db);
        }, /Table "queue" in import payload must be an array/);
        await verifyDataIntact();

        // 7. Corrupted queue row (invalid gallery_id)
        await assert.rejects(async () => {
            await dbMod.importData({
                format: 'nhdl-export',
                version: 1,
                tables: {
                    queue: [
                        { gallery_id: 10001, url: 'https://certain.site/g/10001/' },
                        { gallery_id: 'invalid-id-xyz', url: 'https://certain.site/g/bad/' }
                    ]
                }
            }, { mode: 'replace' }, ctx.db);
        }, /Invalid or missing gallery_id in queue row/);
        await verifyDataIntact();

        // 8. Corrupted library row (missing gallery_id)
        await assert.rejects(async () => {
            await dbMod.importData({
                format: 'nhdl-export',
                version: 1,
                tables: {
                    library: [
                        { title: 'No gallery id' }
                    ]
                }
            }, { mode: 'replace' }, ctx.db);
        }, /Invalid or missing gallery_id in library row/);
        await verifyDataIntact();

        // 9. Replace mode with empty queue & library without allowEmpty
        await assert.rejects(async () => {
            await dbMod.importData({
                format: 'nhdl-export',
                version: 1,
                tables: { queue: [], library: [] }
            }, { mode: 'replace' }, ctx.db);
        }, /contains no queue or library items for replace mode/);
        await verifyDataIntact();

        // 10. Replace mode with empty queue & library WITH allowEmpty: true
        const emptyResult = await dbMod.importData({
            format: 'nhdl-export',
            version: 1,
            tables: { queue: [], library: [] }
        }, { mode: 'replace', allowEmpty: true }, ctx.db);
        assert.strictEqual(emptyResult.success, true);
        const finalQueue = await dbMod.getQueueItems({}, ctx.db);
        const finalLib = await dbMod.getAllLibraryEntries(ctx.db);
        assert.strictEqual(finalQueue.length, 0);
        assert.strictEqual(finalLib.length, 0);
    } finally {
        await ctx.cleanup();
    }
});


