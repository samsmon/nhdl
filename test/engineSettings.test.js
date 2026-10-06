const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NHDL_LEGACY_CONFIG = '';
const dbMod = require('../core/db');
const DownloaderEngine = require('../core/engine');

async function createTempDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-engset-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
    return {
        db,
        tmpDir,
        async cleanup() {
            await dbMod.closeDb();
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        }
    };
}

async function withEnvDownloadDir(value, fn) {
    const prev = process.env.DOWNLOAD_DIR;
    if (value === undefined) delete process.env.DOWNLOAD_DIR;
    else process.env.DOWNLOAD_DIR = value;
    try {
        return await fn();
    } finally {
        if (prev === undefined) delete process.env.DOWNLOAD_DIR;
        else process.env.DOWNLOAD_DIR = prev;
    }
}

function newEngine(opts = {}) {
    return new DownloaderEngine({ skipStartupJitter: true, healthCheckIntervalMs: 60000, ...opts });
}

test('applySavedSettings: applies saved downloadDir, downloadFormat, autoContinueBatches', async () => {
    const ctx = await createTempDb();
    const savedDir = path.join(ctx.tmpDir, 'saved-dl');
    const bootDir = path.join(ctx.tmpDir, 'boot-dl');
    try {
        await dbMod.setSetting('downloadDir', savedDir);
        await dbMod.setSetting('downloadFormat', 'zip');
        await dbMod.setSetting('autoContinueBatches', false);
        await withEnvDownloadDir(undefined, async () => {
            const eng = newEngine({ baseDownloadDir: bootDir });
            await eng.applySavedSettings();
            assert.strictEqual(eng.baseDownloadDir, path.resolve(savedDir));
            assert.strictEqual(eng.downloadFormat, 'zip');
            assert.strictEqual(eng.autoContinueBatches, false);
            assert.strictEqual(fs.existsSync(savedDir), true, 'empty library: missing saved dir is created');
            assert.strictEqual(eng.getStatus(), 'IDLE');
        });
    } finally {
        await ctx.cleanup();
    }
});

test('applySavedSettings: DOWNLOAD_DIR env wins over saved downloadDir, other settings still apply', async () => {
    const ctx = await createTempDb();
    const savedDir = path.join(ctx.tmpDir, 'saved-dl');
    const envDir = path.join(ctx.tmpDir, 'env-dl');
    try {
        await dbMod.setSetting('downloadDir', savedDir);
        await dbMod.setSetting('downloadFormat', 'folder');
        await withEnvDownloadDir(envDir, async () => {
            const eng = newEngine();
            assert.strictEqual(eng.baseDownloadDir, envDir);
            await eng.applySavedSettings();
            assert.strictEqual(eng.baseDownloadDir, envDir);
            assert.strictEqual(fs.existsSync(savedDir), false, 'saved dir must not be created');
            assert.strictEqual(eng.downloadFormat, 'folder');
        });
    } finally {
        await ctx.cleanup();
    }
});

test('applySavedSettings: ignores invalid saved values and keeps defaults', async () => {
    const ctx = await createTempDb();
    const bootDir = path.join(ctx.tmpDir, 'boot-dl');
    try {
        await dbMod.setSetting('downloadDir', 12345);
        await dbMod.setSetting('downloadFormat', 'rar');
        await dbMod.setSetting('autoContinueBatches', 'yes');
        await withEnvDownloadDir(undefined, async () => {
            const eng = newEngine({ baseDownloadDir: bootDir });
            await eng.applySavedSettings();
            assert.strictEqual(eng.baseDownloadDir, bootDir);
            assert.strictEqual(eng.downloadFormat, 'cbz');
            assert.strictEqual(eng.autoContinueBatches, true);
        });
        await dbMod.setSetting('downloadDir', '   ');
        await withEnvDownloadDir(undefined, async () => {
            const eng = newEngine({ baseDownloadDir: bootDir });
            await eng.applySavedSettings();
            assert.strictEqual(eng.baseDownloadDir, bootDir);
        });
    } finally {
        await ctx.cleanup();
    }
});

test('applySavedSettings: missing saved dir with library entries is NOT created and engine reports unavailable', async () => {
    const ctx = await createTempDb();
    const missingDir = path.join(ctx.tmpDir, 'unmounted-dl');
    const bootDir = path.join(ctx.tmpDir, 'boot-dl');
    let eng = null;
    try {
        await dbMod.upsertLibraryEntry({
            galleryId: 920001,
            title: 'Existing',
            artist: 'A',
            path: path.join(missingDir, 'A', 'Book'),
            pages: 5,
            skipped: false
        }, ctx.db);
        await dbMod.setSetting('downloadDir', missingDir);
        await withEnvDownloadDir(undefined, async () => {
            eng = newEngine({ baseDownloadDir: bootDir });
            await eng.applySavedSettings();
            assert.strictEqual(eng.baseDownloadDir, path.resolve(missingDir));
            assert.strictEqual(fs.existsSync(missingDir), false, 'must not mkdir over unmounted path');
            assert.strictEqual(eng.getStatus(), 'Download folder unavailable');
        });
    } finally {
        if (eng) eng.stopDownloadDirWatch();
        await ctx.cleanup();
    }
});

test('applySavedSettings: nothing saved leaves defaults unchanged', async () => {
    const ctx = await createTempDb();
    const bootDir = path.join(ctx.tmpDir, 'boot-dl');
    try {
        await withEnvDownloadDir(undefined, async () => {
            const eng = newEngine({ baseDownloadDir: bootDir });
            await eng.applySavedSettings();
            assert.strictEqual(eng.baseDownloadDir, bootDir);
            assert.strictEqual(eng.downloadFormat, 'cbz');
            assert.strictEqual(eng.autoContinueBatches, true);
            assert.strictEqual(eng.getStatus(), 'IDLE');
        });
    } finally {
        await ctx.cleanup();
    }
});
