const test = require('node:test');
const assert = require('node:assert');
const { createBoardsProvider } = require('../core/providers/boards');
const { createSlugApiProvider } = require('../core/providers/slugapi');

function boardHtml(extra) {
    return `<html><body><h1>[A] Title</h1>
<a href="/category/western/">nav</a>
${extra}
<input type="hidden" id="load_server" value="4" /><input type="hidden" id="load_dir" value="016" />
<input type="hidden" id="load_id" value="abcd" /><input type="hidden" id="load_pages" value="3" />
</body></html>`;
}

function boards() {
    return createBoardsProvider({
        id: 'xxx', label: 'b1', origin: 'https://b1.example', hosts: ['b1.example'], galleryPath: 'g',
        imageHost: (s) => `i${s}.img.example`
    });
}

const fetchHtml = (html) => async () => ({ status: 200, body: html });

test('boards: category slug comes from the gallery tag link (single-quoted), not the navigation link', async () => {
    const meta = await boards().fetchMeta('xxx:1', { fetchText: fetchHtml(boardHtml(`<a class='tag' href='/category/manga/'></a>`)) });
    assert.strictEqual(meta.category, 'manga');
    assert.strictEqual(meta.contentType, 'manga');
    assert.strictEqual(meta.categoryError, null);
});

test('boards: western maps to comic; unknown valid slug maps to other', async () => {
    const m1 = await boards().fetchMeta('xxx:1', { fetchText: fetchHtml(boardHtml(`<a href='/category/western/'></a>`)) });
    assert.strictEqual(m1.contentType, 'comic');
    const m2 = await boards().fetchMeta('xxx:1', { fetchText: fetchHtml(boardHtml(`<a href='/category/artistcg/'></a>`)) });
    assert.strictEqual(m2.contentType, 'other');
});

test('boards: no category link, or an invalid slug, gives null and does not fail the fetch', async () => {
    const none = await boards().fetchMeta('xxx:1', { fetchText: fetchHtml(boardHtml('')) });
    assert.strictEqual(none.category, null);
    assert.strictEqual(none.contentType, null);
    assert.ok(typeof none.categoryError === 'string' && none.categoryError.length > 0);
    const bad = await boards().fetchMeta('xxx:1', { fetchText: fetchHtml(boardHtml(`<a href='/category/..%2Fx/'></a>`)) });
    assert.strictEqual(bad.contentType, null);
});

const IMAGES_JSON = JSON.stringify({
    comic: { id: 1, title: 'T porn comic', slug: 'some-slug', description: 'a porn comic by Aarokira.', tags: [] },
    images: [{ page: 1, source_url: 'https://cdn.example/images/1/1.webp' }]
});

function slug() {
    return createSlugApiProvider({ id: 'com', label: 'c', origin: 'https://c.example', hosts: ['c.example'] });
}

function router(routes) {
    const calls = [];
    const fn = async (url) => {
        calls.push(url);
        for (const [suffix, res] of Object.entries(routes)) {
            if (url.endsWith(suffix)) return typeof res === 'function' ? res() : res;
        }
        return { status: 404, body: 'nf' };
    };
    fn.calls = calls;
    return fn;
}

test('slugapi: category slug comes from the detail endpoint (top-level or under comic)', async () => {
    const f1 = router({
        '/api/comics/some-slug/images': { status: 200, body: IMAGES_JSON },
        '/api/comics/some-slug': { status: 200, body: JSON.stringify({ category: { name: 'Manga', slug: 'manga' } }) }
    });
    const m1 = await slug().fetchMeta('com:some-slug', { fetchText: f1 });
    assert.strictEqual(m1.category, 'manga');
    assert.strictEqual(m1.contentType, 'manga');
    assert.strictEqual(m1.categoryError, null);

    const f2 = router({
        '/api/comics/some-slug/images': { status: 200, body: IMAGES_JSON },
        '/api/comics/some-slug': { status: 200, body: JSON.stringify({ comic: { category: { slug: 'porn-comic' } } }) }
    });
    const m2 = await slug().fetchMeta('com:some-slug', { fetchText: f2 });
    assert.strictEqual(m2.contentType, 'comic');
});

test('slugapi: a failing, blocked, or malformed category request never fails the download metadata', async () => {
    const cases = {
        'http 403': { status: 403, body: '<html>Just a moment</html>' },
        'bad json': { status: 200, body: '<html>not json</html>' },
        'no category': { status: 200, body: JSON.stringify({ comic: {} }) },
        'throws': () => { throw new Error('socket hang up'); }
    };
    for (const [name, detail] of Object.entries(cases)) {
        const f = router({ '/api/comics/some-slug/images': { status: 200, body: IMAGES_JSON }, '/api/comics/some-slug': detail });
        const m = await slug().fetchMeta('com:some-slug', { fetchText: f });
        assert.strictEqual(m.numPages, 1, name);
        assert.strictEqual(m.contentType, null, name);
        assert.ok(typeof m.categoryError === 'string' && m.categoryError.length > 0, `${name}: categoryError set`);
    }
});
