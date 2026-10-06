const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NHDL_LEGACY_CONFIG = '';
const dbMod = require('../core/db');
const providers = require('../core/providers');
const { createBoardsProvider } = require('../core/providers/boards');
const DownloaderEngine = require('../core/engine');

// A JPEG/WEBP-looking payload larger than verifyImage's 2KB floor. verifyImage only checks size and
// a plausible header, so a RIFF/WEBP header + padding is enough.
function fakeWebp(size = 4096) {
    const b = Buffer.alloc(size, 1);
    b.write('RIFF', 0); b.writeUInt32LE(size - 8, 4); b.write('WEBP', 8); b.write('VP8 ', 12);
    return b;
}

const GALLERY_HTML = (pages, title = '[Tester] Local Gallery') => `<html><body>
<h1>${title}</h1>
<a href='/artist/tester/'></a><a href='/language/english/'></a><a href='/tag/one/'></a>
<input type="hidden" id="load_server" value="1" /><input type="hidden" id="load_dir" value="001" />
<input type="hidden" id="load_id" value="abcd" /><input type="hidden" id="load_pages" value="${pages}" />
</body></html>`;

async function startSite({ pages = 3, jpgPages = [2], missingPages = [], title } = {}) {
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push(req.url);
        if (req.url === '/g/777/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(GALLERY_HTML(pages, title)); }
        const m = req.url.match(/^\/img\/001\/abcd\/(\d+)\.(\w+)$/);
        if (m) {
            const n = Number(m[1]);
            const wantJpg = jpgPages.includes(n);
            const exists = !missingPages.includes(n) && ((m[2] === 'jpg') === wantJpg) && ['jpg', 'webp'].includes(m[2]);
            if (!exists) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('nf'); }
            res.writeHead(200, { 'Content-Type': 'image/webp' });
            return res.end(fakeWebp());
        }
        res.writeHead(404); res.end('nf');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { server, hits, origin: `http://127.0.0.1:${server.address().port}` };
}

async function setup(site, engineOpts = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-eng-test-'));
    const db = await dbMod.initDb(path.join(tmpDir, 't.db'), { legacyConfigPath: path.join(tmpDir, 'none.json') });
    const downloadDir = path.join(tmpDir, 'Download');
    fs.mkdirSync(downloadDir, { recursive: true });
    providers.registerProvider(createBoardsProvider({
        id: 'xxx', label: 'test-b1', origin: site.origin, hosts: ['127.0.0.1'], galleryPath: 'g',
        imageHost: () => `127.0.0.1:${site.server.address().port}`,
        imageBase: (host, dir, id, n, ext) => `${site.origin}/img/${dir}/${id}/${n}.${ext}`
    }));
    const engine = new DownloaderEngine({ baseDownloadDir: downloadDir, downloadFormat: 'folder', skipStartupJitter: true, ...engineOpts });
    return {
        db, engine, downloadDir, tmpDir,
        async cleanup() { await dbMod.closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
    };
}

test('processGallery downloads a prefixed gallery through its provider, probing extensions per page', async () => {
    const site = await startSite({ pages: 3, jpgPages: [2] });
    const ctx = await setup(site);
    try {
        await dbMod.enqueueGallery({ galleryId: 'xxx:777', url: `${site.origin}/g/777/` }, ctx.db);
        const result = await ctx.engine.processGallery('xxx:777');
        assert.strictEqual(result.status, 'SUCCESS');

        const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
        assert.ok(lib, 'library entry saved under the prefixed key');
        assert.strictEqual(lib.pages, 3);
        assert.deepStrictEqual(lib.pageExts, { 1: 'webp', 2: 'jpg', 3: 'webp' });
        const files = fs.readdirSync(lib.path).sort();
        assert.deepStrictEqual(files.filter(f => /^\d+\./.test(f)), ['1.webp', '2.jpg', '3.webp']);
        assert.ok(!files.some(f => f.endsWith('.part')), 'no partial files left');

        const q = dbMod.formatQueueRow(await dbMod.getQueueItem('xxx:777', ctx.db));
        assert.strictEqual(q.rawStatus, 'DONE');
        assert.strictEqual(q.source, 'xxx');
    } finally {
        site.server.close();
        await ctx.cleanup();
    }
});

test('a page whose every candidate extension 404s does not leave a bogus file and is retried (not saved)', async () => {
    const site = await startSite({ pages: 2, jpgPages: [], missingPages: [2] });
    const ctx = await setup(site);
    try {
        const candidates = [{ ext: 'webp', url: `${site.origin}/img/001/abcd/2.webp` }, { ext: 'jpg', url: `${site.origin}/img/001/abcd/2.jpg` }];
        const folder = fs.mkdtempSync(path.join(ctx.tmpDir, 'pg-'));
        await assert.rejects(
            ctx.engine.downloadProviderPage(providers.providerForKey('xxx:777'), candidates, folder, 2, () => {}),
            (e) => e.statusCode === 404
        );
        assert.deepStrictEqual(fs.readdirSync(folder), []);
    } finally {
        site.server.close();
        await ctx.cleanup();
    }
});

test('prefixed keys never become folder names (colon is invalid on Windows)', async () => {
        // sanitizeName never returns empty (falls back to 'untitled'), so the only reachable safeKeyName
    // site is the mkdir fallback: make the title folder be rejected by the filesystem (EINVAL).
    const site = await startSite({ pages: 1, jpgPages: [] });
    const ctx = await setup(site);
    const realMkdir = fs.mkdirSync;
    fs.mkdirSync = function (p, ...rest) {
        if (String(p).endsWith('Local Gallery')) { const e = new Error('EINVAL: invalid name'); e.code = 'EINVAL'; throw e; }
        return realMkdir.call(this, p, ...rest);
    };
    try {
        await dbMod.enqueueGallery({ galleryId: 'xxx:777', url: `${site.origin}/g/777/` }, ctx.db);
        await ctx.engine.processGallery('xxx:777');
        assert.ok(fs.existsSync(path.join(ctx.downloadDir, 'English', 'Tester', 'xxx_777')), 'folder named xxx_777 exists');
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => [e.name, ...(e.isDirectory() ? walk(path.join(d, e.name)) : [])]);
        assert.ok(!walk(ctx.downloadDir).some(n => n.includes(':')), 'no path segment contains a colon');
    } finally {
        fs.mkdirSync = realMkdir;
        site.server.close();
        await ctx.cleanup();
    }
});

test('stop flags work with prefixed keys', async () => {
    const site = await startSite();
    const ctx = await setup(site);
    try {
        ctx.engine.stopGallery('xxx:777', { deleteAfter: true });
        assert.strictEqual(ctx.engine.isGalleryStopping('xxx:777'), true);
        assert.strictEqual(ctx.engine.isGalleryDeleting('xxx:777'), true);
        ctx.engine.stopGallery(468614);
        assert.strictEqual(ctx.engine.isGalleryStopping('468614'), true);
        ctx.engine.clearGalleryStopFlags('xxx:777');
        assert.strictEqual(ctx.engine.isGalleryStopping('xxx:777'), false);
    } finally {
        site.server.close();
        await ctx.cleanup();
    }
});

test('rescanLibrary recognises prefixed and legacy markers', async () => {
    const site = await startSite();
    const ctx = await setup(site);
    try {
        const { rescanLibrary } = require('../core/tracker');
        for (const [name, key] of [['A', 'xxx:777'], ['B', '468614']]) {
            const d = path.join(ctx.downloadDir, 'English', 'Tester', name);
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, '1.webp'), fakeWebp());
            fs.writeFileSync(path.join(d, '.nhdl-id'), key);
        }
        const r = await rescanLibrary(ctx.downloadDir);
        assert.strictEqual(r.scanned, 2);
        assert.ok(await dbMod.getLibraryEntry('xxx:777', ctx.db));
        assert.ok(await dbMod.getLibraryEntry(468614, ctx.db));
    } finally {
        site.server.close();
        await ctx.cleanup();
    }
});

test('a page that 404s on every candidate becomes a blank placeholder png after the retry threshold', async () => {
    const site = await startSite({ pages: 2, jpgPages: [], missingPages: [2] });
    const ctx = await setup(site, { pageRetryBaseMs: 1 });
    try {
        await dbMod.enqueueGallery({ galleryId: 'xxx:777', url: `${site.origin}/g/777/` }, ctx.db);
        const result = await ctx.engine.processGallery('xxx:777');
        assert.strictEqual(result.status, 'SUCCESS');
        const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
        assert.strictEqual(lib.pageExts[2], 'png');
        assert.strictEqual(lib.pageExts[1], 'webp');
        const ph = path.join(lib.path, '2.png');
        assert.ok(fs.statSync(ph).size >= 2048, 'placeholder passes verifyImage size floor');
        const events = await dbMod.getEvents({}, ctx.db);
        assert.ok(JSON.stringify(events).includes('substituted with a blank image'), 'placeholder logged');
    } finally {
        site.server.close();
        await ctx.cleanup();
    }
});

test('resume records an explicit extension for every page, matching the files on disk', async () => {
    const site = await startSite({ pages: 3, jpgPages: [1] });
    const ctx = await setup(site);
    try {
        const folder = path.join(ctx.downloadDir, 'English', 'Tester', 'Local Gallery');
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, '3.webp'), fakeWebp());
        await dbMod.enqueueGallery({ galleryId: 'xxx:777', url: `${site.origin}/g/777/` }, ctx.db);
        const result = await ctx.engine.processGallery('xxx:777');
        assert.strictEqual(result.status, 'SUCCESS');
        const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
        assert.deepStrictEqual(lib.pageExts, { 1: 'jpg', 2: 'webp', 3: 'webp' });
        for (const [p, e] of Object.entries(lib.pageExts)) {
            assert.ok(fs.existsSync(path.join(lib.path, `${p}.${e}`)), `${p}.${e} exists`);
        }
    } finally {
        site.server.close();
        await ctx.cleanup();
    }
});

test('downloadProviderPage uses curl for a transport:curl provider and falls through 404 candidates', async () => {
    const site = await startSite({ pages: 2, jpgPages: [1] });
    const ctx = await setup(site);
    try {
        const provider = { id: 'xxx', transport: 'curl', imageHeaders: () => ({ Referer: `${site.origin}/` }) };
        const candidates = [{ ext: 'webp', url: `${site.origin}/img/001/abcd/1.webp` }, { ext: 'jpg', url: `${site.origin}/img/001/abcd/1.jpg` }];
        const folder = fs.mkdtempSync(path.join(ctx.tmpDir, 'pg-'));
        const res = await ctx.engine.downloadProviderPage(provider, candidates, folder, 1, () => {});
        assert.strictEqual(res.ext, 'jpg');
        assert.deepStrictEqual(fs.readdirSync(folder), ['1.jpg']);
        assert.strictEqual(fs.statSync(path.join(folder, '1.jpg')).size, 4096);
    } finally {
        site.server.close();
        await ctx.cleanup();
    }
});
