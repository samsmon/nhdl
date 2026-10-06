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

function fakeWebp(size = 4096) {
    const b = Buffer.alloc(size, 1);
    b.write('RIFF', 0); b.writeUInt32LE(size - 8, 4); b.write('WEBP', 8); b.write('VP8 ', 12);
    return b;
}

const galleryHtml = (pages, category) => `<html><body>
<h1>[Tester] Typed Gallery</h1>
<a href='/artist/tester/'></a><a href='/language/english/'></a>
${category ? `<a class='tag' href='/category/${category}/'></a>` : ''}
<input type="hidden" id="load_server" value="1" /><input type="hidden" id="load_dir" value="001" />
<input type="hidden" id="load_id" value="abcd" /><input type="hidden" id="load_pages" value="${pages}" />
</body></html>`;

async function startSite(category) {
    const server = http.createServer((req, res) => {
        if (req.url === '/g/777/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(galleryHtml(2, category)); }
        const m = req.url.match(/^\/img\/001\/abcd\/(\d+)\.(\w+)$/);
        if (m && m[2] === 'webp') { res.writeHead(200, { 'Content-Type': 'image/webp' }); return res.end(fakeWebp()); }
        res.writeHead(404); res.end('nf');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function setup(site) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-cteng-test-'));
    const db = await dbMod.initDb(path.join(tmpDir, 't.db'), { legacyConfigPath: path.join(tmpDir, 'none.json') });
    const downloadDir = path.join(tmpDir, 'Download');
    fs.mkdirSync(downloadDir, { recursive: true });
    providers.registerProvider(createBoardsProvider({
        id: 'xxx', label: 'test-b1', origin: site.origin, hosts: ['127.0.0.1'], galleryPath: 'g',
        imageHost: () => '127.0.0.1',
        imageBase: (host, dir, id, n, ext) => `${site.origin}/img/${dir}/${id}/${n}.${ext}`
    }));
    const engine = new DownloaderEngine({ baseDownloadDir: downloadDir, downloadFormat: 'folder', skipStartupJitter: true });
    return { db, engine, downloadDir, tmpDir, async cleanup() { await dbMod.closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); } };
}

async function run(category) {
    const site = await startSite(category);
    const ctx = await setup(site);
    await dbMod.enqueueGallery({ galleryId: 'xxx:777', url: `${site.origin}/g/777/` }, ctx.db);
    const result = await ctx.engine.processGallery('xxx:777');
    return { site, ctx, result };
}

test('manga category: folder under Manga/<Language>/<Author>, queue.category and library meta set', async () => {
    const { site, ctx, result } = await run('manga');
    try {
        assert.strictEqual(result.status, 'SUCCESS');
        const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
        const rel = path.relative(ctx.downloadDir, lib.path).split(path.sep);
        assert.deepStrictEqual(rel.slice(0, 3), ['Manga', 'English', 'Tester']);
        assert.strictEqual(lib.meta.contentType, 'manga');
        assert.strictEqual(lib.meta.category, 'manga');
        const q = dbMod.formatQueueRow(await dbMod.getQueueItem('xxx:777', ctx.db));
        assert.strictEqual(q.category, 'manga');
    } finally { site.server.close(); await ctx.cleanup(); }
});

test('western category goes to Comic; unknown valid slug goes to Other', async () => {
    for (const [category, folder] of [['western', 'Comic'], ['artistcg', 'Other']]) {
        const { site, ctx } = await run(category);
        try {
            const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
            assert.strictEqual(path.relative(ctx.downloadDir, lib.path).split(path.sep)[0], folder, category);
        } finally { site.server.close(); await ctx.cleanup(); }
    }
});

test('no category: old layout (no type folder), queue.category stays null, download succeeds', async () => {
    const { site, ctx, result } = await run(null);
    try {
        assert.strictEqual(result.status, 'SUCCESS');
        const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
        assert.deepStrictEqual(path.relative(ctx.downloadDir, lib.path).split(path.sep).slice(0, 2), ['English', 'Tester']);
        assert.strictEqual(dbMod.formatQueueRow(await dbMod.getQueueItem('xxx:777', ctx.db)).category, null);
        assert.ok(!lib.meta.contentType);
    } finally { site.server.close(); await ctx.cleanup(); }
});

test('hostile category slug never becomes a path segment', async () => {
    const { site, ctx, result } = await run('..%2F..%2Fescape');
    try {
        assert.strictEqual(result.status, 'SUCCESS');
        const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
        const rel = path.relative(ctx.downloadDir, lib.path);
        assert.ok(!rel.startsWith('..'), rel);
        assert.ok(!rel.split(path.sep).some(s => /escape|%2f/i.test(s)), rel);
    } finally { site.server.close(); await ctx.cleanup(); }
});

test('findExistingOnDisk finds a gallery stored in the typed layout', async () => {
    const site = await startSite('manga');
    const ctx = await setup(site);
    try {
        const dir = path.join(ctx.downloadDir, 'Manga', 'English', 'Tester', 'Typed Gallery');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '1.webp'), fakeWebp());
        const found = ctx.engine.findExistingOnDisk('Typed Gallery', 'Tester');
        assert.ok(found, 'found in typed layout');
        assert.strictEqual(found.path, dir);
        const old = path.join(ctx.downloadDir, 'English', 'Tester', 'Old Style');
        fs.mkdirSync(old, { recursive: true });
        fs.writeFileSync(path.join(old, '1.webp'), fakeWebp());
        assert.strictEqual(ctx.engine.findExistingOnDisk('Old Style', 'Tester').path, old);
    } finally { site.server.close(); await ctx.cleanup(); }
});

test('GET /api/library item mapping exposes category from library meta', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.ok(/category:\s*\(data\.meta && data\.meta\.contentType\) \|\| null/.test(src), 'server maps category from meta.contentType');
});

test('existing typed archive is skipped and the library entry still records the content type', async () => {
    const site = await startSite('manga');
    const ctx = await setup(site);
    try {
        const dir = path.join(ctx.downloadDir, 'Manga', 'English', 'Tester');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'Typed Gallery.cbz'), Buffer.alloc(64, 1));
        await dbMod.enqueueGallery({ galleryId: 'xxx:777', url: `${site.origin}/g/777/` }, ctx.db);
        const result = await ctx.engine.processGallery('xxx:777');
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.skipReason, 'disk_after_metadata');
        const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
        assert.ok(lib, 'library entry saved');
        assert.strictEqual(lib.meta.contentType, 'manga');
    } finally { site.server.close(); await ctx.cleanup(); }
});
