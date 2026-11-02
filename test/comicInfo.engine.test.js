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
const { execFileSync } = require('child_process');

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


async function download(format) {
    const site = await startSite({ pages: 3, jpgPages: [2] });
    const ctx = await setup(site, { downloadFormat: format });
    try {
        await dbMod.enqueueGallery({ galleryId: 'xxx:777', url: `${site.origin}/g/777/` }, ctx.db);
        const result = await ctx.engine.processGallery('xxx:777');
        assert.strictEqual(result.status, 'SUCCESS');
        const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
        assert.ok(lib, 'library entry saved');
        return { lib, cleanup: async () => { site.server.close(); await ctx.cleanup(); } };
    } catch (e) {
        site.server.close();
        await ctx.cleanup();
        throw e;
    }
}

function assertSidecars(xml, infoJson) {
    assert.match(xml, /<Tags>one<\/Tags>/, 'plain tag name, no "tag:" prefix');
    assert.doesNotMatch(xml, /tag: /);
    assert.match(xml, /<Penciller>Tester<\/Penciller>/);
    assert.match(xml, /<Writer>Tester<\/Writer>/);
    assert.match(xml, /<LanguageISO>en<\/LanguageISO>/);
    assert.match(xml, /<Web>[^<]+\/g\/777\/<\/Web>/);
    assert.doesNotMatch(xml, /<Title>/);
    const info = JSON.parse(infoJson).manga_info;
    assert.deepStrictEqual(info.tags, ['one']);
    assert.strictEqual(info.artist, 'Tester');
    assert.strictEqual(info.language, 'english');
}

test('a fresh folder download is tagged right away (ComicInfo.xml and info.json)', async () => {
    const { lib, cleanup } = await download('folder');
    try {
        assertSidecars(fs.readFileSync(path.join(lib.path, 'ComicInfo.xml'), 'utf-8'), fs.readFileSync(path.join(lib.path, 'info.json'), 'utf-8'));
    } finally { await cleanup(); }
});

test('a fresh cbz download carries both sidecars inside the archive', async () => {
    const { lib, cleanup } = await download('cbz');
    try {
        assert.ok(/\.cbz$/.test(lib.path), `expected a cbz, got ${lib.path}`);
        const script = [
            'import zipfile,sys,json',
            'z=zipfile.ZipFile(sys.argv[1])',
            'assert z.testzip() is None',
            'print(json.dumps({"names":sorted(z.namelist()),"xml":z.read("ComicInfo.xml").decode(),"info":z.read("info.json").decode()}))'
        ].join('\n');
        const out = JSON.parse(execFileSync('python', ['-I', '-c', script, lib.path]).toString());
        assert.ok(out.names.includes('ComicInfo.xml') && out.names.includes('info.json'), out.names.join(','));
        assertSidecars(out.xml, out.info);
    } finally { await cleanup(); }
});

test('metadata is written even when the gallery has no tags at the source', async () => {
    const site = await startSite({ pages: 2, title: '[Tester] Bare' });
    const ctx = await setup(site, { downloadFormat: 'folder' });
    try {
        site.server.removeAllListeners('request');
        site.server.on('request', (req, res) => {
            if (req.url === '/g/777/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(GALLERY_HTML(2, '[Tester] Bare').replace(/<a href='\/tag\/one\/'><\/a>/, '')); }
            const m = req.url.match(/^\/img\/001\/abcd\/(\d+)\.(\w+)$/);
            if (m && m[2] === 'webp') { res.writeHead(200, { 'Content-Type': 'image/webp' }); return res.end(fakeWebp()); }
            res.writeHead(404); res.end('nf');
        });
        await dbMod.enqueueGallery({ galleryId: 'xxx:777', url: `${site.origin}/g/777/` }, ctx.db);
        assert.strictEqual((await ctx.engine.processGallery('xxx:777')).status, 'SUCCESS');
        const lib = await dbMod.getLibraryEntry('xxx:777', ctx.db);
        const xml = fs.readFileSync(path.join(lib.path, 'ComicInfo.xml'), 'utf-8');
        assert.doesNotMatch(xml, /<Tags>/);
        assert.match(xml, /<Penciller>Tester<\/Penciller>/);
        assert.match(xml, /<Web>/);
    } finally { site.server.close(); await ctx.cleanup(); }
});
