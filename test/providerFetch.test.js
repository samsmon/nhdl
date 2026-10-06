const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchText, downloadToFile } = require('../core/providers/http');
const { createBoardsProvider, PAGE_EXTS } = require('../core/providers/boards');
const { createSlugApiProvider } = require('../core/providers/slugapi');

const BOARD_HTML = `<!doctype html><html><head><title>x &raquo; site</title></head><body>
<h1>(Comic) [Eda] Some Title &amp; More [DL]</h1>
<a href="/language/english/">nav</a>
<a class='tag btn' href='/artist/eda/'> <span class='item_name'>eda</span></a>
<a class='tag btn' href='/language/translated/'></a><a class='tag btn' href='/language/japanese/'></a>
<a class='tag btn' href='/tag/big-breasts/'></a><a class='tag btn' href='/tag/blowjob/'></a>
<input type="hidden" name="load_server" id="load_server" value="4" />
<input type="hidden" name="load_dir" id="load_dir" value="016" />
<input type="hidden" name="gallery_id" id="gallery_id" value="539224" />
<input type="hidden" name="load_id" id="load_id" value="vgtjw9nz2i" />
<input type="hidden" name="load_pages" id="load_pages" value="3" />
</body></html>`;

const BLOCK_HTML = '<html><head><title>Safesurf Source - Some ISP</title></head><body>blocked</body></html>';

function boards() {
    return createBoardsProvider({
        id: 'xxx', label: 'b1', origin: 'https://b1.example', hosts: ['b1.example'], galleryPath: 'g',
        imageHost: (server) => `i${server}.img.example`
    });
}

test('boards.fetchMeta parses title, artist, language, page count and builds candidate URLs', async () => {
    const meta = await boards().fetchMeta('xxx:539224', { fetchText: async () => ({ status: 200, body: BOARD_HTML }) });
    assert.strictEqual(meta.title, 'Some Title & More');
    assert.strictEqual(meta.authorStr, 'Eda');
    assert.strictEqual(meta.langStr, 'Japanese');
    assert.strictEqual(meta.numPages, 3);
    assert.deepStrictEqual(meta.extraMeta.tags.map(t => t.name), ['big breasts', 'blowjob']);
    const urls = meta.pageUrls(2);
    assert.deepStrictEqual(urls.map(u => u.ext), PAGE_EXTS);
    assert.strictEqual(urls[0].url, 'https://i4.img.example/016/vgtjw9nz2i/2.webp');
    assert.strictEqual(urls[1].url, 'https://i4.img.example/016/vgtjw9nz2i/2.jpg');
});

test('boards.fetchMeta turns a blocked/unexpected page into a clear error, and 404 into a permanent one', async () => {
    await assert.rejects(
        boards().fetchMeta('xxx:1', { fetchText: async () => ({ status: 200, body: BLOCK_HTML }) }),
        /blocked or unexpected page/i
    );
    await assert.rejects(
        boards().fetchMeta('xxx:1', { fetchText: async () => ({ status: 404, body: 'nf' }) }),
        (e) => e.permanent === true && /^404/.test(e.message)
    );
});

const SLUG_JSON = JSON.stringify({
    comic: {
        id: 712070, title: 'Amy’s Country Wrangle porn comic', slug: 'amys-country-wrangle-porn-comic', pages: 2,
        description: 'Read it. Amy’s Country Wrangle porn comic is a 2-page porn comic by Aarokira. Genres: A, B.',
        tags: [{ slug: 'ahegao' }, { slug: 'western' }]
    },
    images: [
        { page: 2, source_url: 'https://cdn.example/images/712070/2.webp' },
        { page: 1, source_url: 'https://cdn.example/images/712070/1.webp' },
        { page: 3, source_url: 'https://cdn.example/images/712070/3.jpg' }
    ]
});

function slug() {
    return createSlugApiProvider({ id: 'com', label: 'c', origin: 'https://c.example', hosts: ['c.example'] });
}

test('slugapi.fetchMeta uses all returned images (sorted by page), strips title suffix, reads author', async () => {
    let requested = null;
    const meta = await slug().fetchMeta('com:amys-country-wrangle-porn-comic', {
        fetchText: async (url) => { requested = url; return { status: 200, body: SLUG_JSON }; }
    });
    assert.strictEqual(requested, 'https://c.example/api/comics/amys-country-wrangle-porn-comic/images');
    assert.strictEqual(meta.title, 'Amy’s Country Wrangle');
    assert.strictEqual(meta.authorStr, 'Aarokira');
    assert.strictEqual(meta.langStr, 'English');
    assert.strictEqual(meta.numPages, 3);
    assert.deepStrictEqual(meta.pageExts, { 1: 'webp', 2: 'webp', 3: 'jpg' });
    assert.strictEqual(meta.ext, 'webp');
    assert.deepStrictEqual(meta.pageUrls(3), [{ ext: 'jpg', url: 'https://cdn.example/images/712070/3.jpg' }]);
    assert.deepStrictEqual(meta.extraMeta.tags.map(t => t.name), ['ahegao', 'western']);
});

test('slugapi.fetchMeta: 404 is permanent and JSON without comic is rejected', async () => {
    await assert.rejects(
        slug().fetchMeta('com:nope', { fetchText: async () => ({ status: 404, body: '<html>Not Found</html>' }) }),
        (e) => e.permanent === true
    );
    await assert.rejects(
        slug().fetchMeta('com:nope', { fetchText: async () => ({ status: 200, body: '<html>not json</html>' }) }),
        /unexpected response/i
    );
});

function startServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('fetchText follows redirects and sends given headers', async () => {
    let seenReferer = null;
    const server = await startServer((req, res) => {
        if (req.url === '/a') { res.writeHead(302, { Location: '/b' }); return res.end(); }
        seenReferer = req.headers.referer;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello');
    });
    try {
        const r = await fetchText(`http://127.0.0.1:${server.address().port}/a`, { Referer: 'https://ref.example/' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body, 'hello');
        assert.strictEqual(seenReferer, 'https://ref.example/');
    } finally { server.close(); }
});

test('downloadToFile writes the file, reports progress, rejects non-200 with statusCode and leaves no partial file', async () => {
    const payload = Buffer.alloc(5000, 7);
    const server = await startServer((req, res) => {
        if (req.url === '/missing') { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('nf'); }
        res.writeHead(200, { 'Content-Length': payload.length });
        res.end(payload);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-dl-test-'));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        let last = 0;
        await downloadToFile(`${base}/ok`, path.join(dir, 'a.webp'), {}, (received) => { last = received; });
        assert.strictEqual(fs.statSync(path.join(dir, 'a.webp')).size, 5000);
        assert.strictEqual(last, 5000);
        await assert.rejects(
            downloadToFile(`${base}/missing`, path.join(dir, 'b.webp')),
            (e) => e.statusCode === 404
        );
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.webp']);
    } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('downloadToFile rejects and cleans up .part when body is truncated', async () => {
    const server = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Length': 5000 });
        res.write(Buffer.alloc(1000, 7));
        res.destroy();
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-dl-test-'));
    try {
        await assert.rejects(
            downloadToFile(`http://127.0.0.1:${server.address().port}/`, path.join(dir, 'f.webp')),
            (e) => /aborted|hang up|destroyed/.test(e.message)
        );
        assert.deepStrictEqual(fs.readdirSync(dir), []);
    } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('downloadToFile rejects with Timeout and leaves no files when server never responds', async () => {
    const server = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Length': 1000 });
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-dl-test-'));
    try {
        await assert.rejects(
            downloadToFile(`http://127.0.0.1:${server.address().port}/`, path.join(dir, 'g.webp'), {}, null, 150),
            (e) => /Timeout/.test(e.message)
        );
        assert.deepStrictEqual(fs.readdirSync(dir), []);
    } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fetchText rejects with Too many redirects when server redirects forever', async () => {
    const server = await startServer((req, res) => {
        res.writeHead(302, { Location: '/' });
        res.end();
    });
    try {
        await assert.rejects(
            fetchText(`http://127.0.0.1:${server.address().port}/`),
            /Too many redirects/
        );
    } finally { server.close(); }
});
