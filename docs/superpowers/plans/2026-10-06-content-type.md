# Content Type (Comic / Manga) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Galeri dari site B1/B2/C dipetakan dari kategori situsnya ke tipe `comic`/`manga`/`other`, disimpan di folder per tipe, dan tipenya tampil serta bisa difilter di UI.

**Architecture:** Provider mengekstrak slug kategori; modul murni `core/providers/contentType.js` memetakan slug ke tipe. Engine memakai tipe untuk memilih folder (`<base>/<Tipe>/<Bahasa>/<Author>/<Judul>`), menyimpan tipe di kolom baru `queue.category` (migrasi v4) dan di `meta` library. UI membaca `category` dari item dan menambah badge + filter "Type".

**Tech Stack:** Node >= 22.13 (`node:test`, `node:sqlite`), `pg`, Svelte 5 + Vite. Tanpa dependensi baru.

**Spec:** `docs/superpowers/specs/2026-10-06-content-type-design.md`

## Global Constraints

- Tanpa dependensi runtime baru.
- Commit atas nama user (git config), TANPA trailer `Co-Authored-By` atau atribusi AI. Jalankan `npm test` sebelum commit; jangan commit bila gagal. Jangan `git add` `samples/` atau `webui/dist`; jangan sentuh `.gitignore`.
- Branch `rework`. Server user di port 8080 dan folder `data/` tidak boleh disentuh oleh tes/verifikasi; pakai server sementara di port lain dengan DB di folder temp OS.
- Setiap field/endpoint baru ditulis di `docs/API.md` dulu (Task 1).
- Di dokumen situs ditulis generik: site A (default), site B1/B2, site C; nama asli, domain, dan prefix asli hanya di kode/tes.
- Tipe konten: `ContentType = 'comic' | 'manga' | 'other'`; label dan nama folder `Comic`, `Manga`, `Other`.
- Pemetaan slug (huruf kecil) → tipe: `western`, `porn-comic`, `comic` → `comic`; `manga`, `doujinshi` → `manga`; slug valid lain → `other`; kosong/tidak valid → `null`. Slug valid: `^[a-z0-9][a-z0-9-]{0,40}$`.
- Nama folder tipe hanya dari label tetap; slug remote tidak pernah dipakai sebagai nama folder.
- Site A tidak berubah: tanpa tipe, folder lama, `category` selalu `null`.
- Library lama tidak dipindah otomatis.
- `QueueItem.category` / `LibraryItem.category`: `"comic" | "manga" | "other" | null`.
- Svelte 5 runes saja; id galeri di UI selalu string; UI menerima perubahan lewat SSE, tanpa polling.

## Review Focus

1. Slug kategori dari remote berisi karakter aneh/panjang/path (`../x`, `a/b`, 200 karakter, kosong): tidak pernah menjadi nama folder; hasilnya `null` (layout lama) atau `other`.
2. Halaman galeri tanpa tautan kategori atau request kategori site C gagal/403/timeout/JSON rusak: download tetap jalan tanpa tipe (layout lama), dengan peringatan di activity log; tidak melempar error.
3. Migrasi v4 pada DB v3 berisi data: tidak ada baris hilang, idempoten bila dijalankan ulang, kolom `category` nullable; export lalu import mempertahankan `category`.
4. Galeri yang sebagian sudah terunduh di layout lama lalu diproses ulang: tidak crash, tidak menumpuk arsip ganda di folder baru, pemeriksaan "sudah ada di library" tetap bekerja.
5. Fallback `findExistingOnDisk` (saat 429) menemukan galeri di layout bertipe.
6. Item tanpa `category` (site A, item lama, item yang belum diambil metadatanya) tidak menampilkan badge dan tidak masuk hitungan filter tipe.
7. Filter tipe digabung (AND) dengan filter status, sumber, batch, dan pencarian.

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `core/providers/contentType.js` (baru) | `mapCategoryToType`, `normalizeCategorySlug`, `typeFolderName`, `isContentType`, `TYPE_LABELS` |
| `core/providers/boards.js`, `core/providers/slugapi.js` | Ekstraksi slug kategori → `meta.category`, `meta.contentType` (+ `meta.categoryError` untuk site C) |
| `core/db/sqlite.js`, `core/db/postgres.js`, `core/db/common.js` | Migrasi v4, `category` di `updateQueueItem`/`formatQueueRow`/import-export |
| `core/engine.js` | Layout folder bertipe, simpan tipe ke queue + library meta, `findExistingOnDisk` bertipe |
| `server/index.js` | `category` di `/api/library` |
| `webui/src/lib/contentType.js` (baru) | Helper murni tipe (badge, filter, hitung) |
| `webui/src/lib/stores/app.svelte.js`, `VirtualQueueTable.svelte`, `SidebarFilter.svelte`, `LibraryModal.svelte` | Badge + filter "Type" |
| `test/contentType.test.js`, `test/providerCategory.test.js`, `test/contentType.db.test.js`, `test/contentType.engine.test.js`, `test/webuiContentType.test.js` (baru) | Tes |

---

### Task 1: Dokumentasi kontrak API (docs-first) dan koreksi spec

**Files:**
- Modify: `docs/API.md` (bagian `QueueItem`, `LibraryItem`)
- Modify: `docs/superpowers/specs/2026-10-06-content-type-design.md` (satu baris di bagian 8)

**Interfaces:**
- Produces: kontrak tertulis `QueueItem.category`, `LibraryItem.category`, dipakai Task 3–5.

- [ ] **Step 1: Tambah `category` ke contoh `QueueItem`**

Di `docs/API.md` bagian `### QueueItem`, tambahkan `"category": null` setelah baris `"source": "default"` pada contoh JSON, dan tambahkan bullet berikut setelah bullet `source`:

```markdown
- `category`: tipe konten `"comic" | "manga" | "other" | null`. Dipetakan dari kategori di situs asal (site B1/B2/C); `null` untuk site A, item lama, dan item yang metadatanya belum diambil. Disimpan di tabel `queue` (kolom `category`) dan ikut di event SSE `item`.
```

- [ ] **Step 2: Tambah `category` ke `LibraryItem`**

Di bawah tabel 3.5 (tempat catatan `LibraryItem.source` berada) tambahkan:

```markdown
`LibraryItem` juga memiliki field `category` (nilai yang sama seperti `QueueItem.category`, dibaca dari `meta` library; `null` bila tidak ada).
```

Dan di bagian yang menjelaskan layout penyimpanan (cari dengan `grep -n "Language\|<Author>" docs/API.md docs/ARCHITECTURE.md`; bila tidak ada di API.md cukup di ARCHITECTURE pada Task 6) tidak ada perubahan lain.

- [ ] **Step 3: Koreksi spec**

Di spec bagian 8 ganti kalimat `tampil bila ≥ 2 tipe hadir (pola yang sama dengan bagian "Source")` dengan `tampil bila minimal 1 tipe hadir (sama seperti bagian "Source")`.

- [ ] **Step 4: Commit**

```bash
git add docs/API.md docs/superpowers/specs/2026-10-06-content-type-design.md
git commit -m "docs(api): document content type category on queue and library items"
```

---

### Task 2: Modul tipe konten dan ekstraksi kategori di provider

**Files:**
- Create: `core/providers/contentType.js`
- Modify: `core/providers/boards.js` (fungsi `parseGallery`), `core/providers/slugapi.js` (`fetchMeta`)
- Test: `test/contentType.test.js`, `test/providerCategory.test.js`

**Interfaces:**
- Produces (`core/providers/contentType.js`):
  - `TYPE_LABELS: { comic: 'Comic', manga: 'Manga', other: 'Other' }`
  - `normalizeCategorySlug(raw) -> string | null`
  - `mapCategoryToType(raw) -> 'comic' | 'manga' | 'other' | null`
  - `typeFolderName(type) -> string | null`
  - `isContentType(v) -> boolean`
- Provider `fetchMeta` result gains `category: string | null` (slug mentah ter-normalisasi), `contentType: ContentType | null`, dan (hanya site C) `categoryError: string | null`.

- [ ] **Step 1: Tulis tes modul tipe yang gagal**

Buat `test/contentType.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const ct = require('../core/providers/contentType');

test('mapCategoryToType maps known slugs, case-insensitively', () => {
    for (const s of ['western', 'porn-comic', 'comic', 'Western', ' PORN-COMIC ']) {
        assert.strictEqual(ct.mapCategoryToType(s), 'comic', s);
    }
    for (const s of ['manga', 'doujinshi', 'MANGA']) {
        assert.strictEqual(ct.mapCategoryToType(s), 'manga', s);
    }
    for (const s of ['non-h', 'imageset', 'artistcg', 'misc', 'something-new']) {
        assert.strictEqual(ct.mapCategoryToType(s), 'other', s);
    }
});

test('mapCategoryToType returns null for empty or invalid slugs (never a path)', () => {
    const bad = [null, undefined, '', '   ', '../etc', 'a/b', 'a\\b', '-lead', 'has space', 'x'.repeat(60), '<b>', 42];
    for (const s of bad) {
        assert.strictEqual(ct.mapCategoryToType(s), null, JSON.stringify(s));
    }
    assert.strictEqual(ct.normalizeCategorySlug('Manga'), 'manga');
    assert.strictEqual(ct.normalizeCategorySlug('../x'), null);
});

test('typeFolderName only yields the fixed labels', () => {
    assert.strictEqual(ct.typeFolderName('comic'), 'Comic');
    assert.strictEqual(ct.typeFolderName('manga'), 'Manga');
    assert.strictEqual(ct.typeFolderName('other'), 'Other');
    assert.strictEqual(ct.typeFolderName(null), null);
    assert.strictEqual(ct.typeFolderName('../x'), null);
    assert.strictEqual(ct.isContentType('manga'), true);
    assert.strictEqual(ct.isContentType('doujinshi'), false);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/contentType.test.js`
Expected: FAIL (`Cannot find module '../core/providers/contentType'`).

- [ ] **Step 3: Implementasi `core/providers/contentType.js`**

```js
const TYPE_LABELS = { comic: 'Comic', manga: 'Manga', other: 'Other' };

const COMIC_SLUGS = new Set(['western', 'porn-comic', 'comic']);
const MANGA_SLUGS = new Set(['manga', 'doujinshi']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

function normalizeCategorySlug(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().toLowerCase();
    return SLUG.test(s) ? s : null;
}

function mapCategoryToType(raw) {
    const slug = normalizeCategorySlug(raw);
    if (!slug) return null;
    if (COMIC_SLUGS.has(slug)) return 'comic';
    if (MANGA_SLUGS.has(slug)) return 'manga';
    return 'other';
}

function isContentType(v) {
    return v === 'comic' || v === 'manga' || v === 'other';
}

// Folder names come only from this fixed table, never from remote text.
function typeFolderName(type) {
    return isContentType(type) ? TYPE_LABELS[type] : null;
}

module.exports = { TYPE_LABELS, normalizeCategorySlug, mapCategoryToType, isContentType, typeFolderName };
```

- [ ] **Step 4: Jalankan tes modul, pastikan lulus**

Run: `node --test test/contentType.test.js`
Expected: PASS.

- [ ] **Step 5: Tulis tes ekstraksi kategori provider yang gagal**

Buat `test/providerCategory.test.js`:

```js
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
```

- [ ] **Step 6: Jalankan, pastikan gagal**

Run: `node --test test/providerCategory.test.js`
Expected: FAIL (`meta.category` undefined).

- [ ] **Step 7: Implementasi di `core/providers/boards.js`**

Tambahkan impor di bagian atas file: `const { normalizeCategorySlug, mapCategoryToType } = require('./contentType');`. Tambahkan fungsi helper di dekat `taxonomy` (sebelum `createBoardsProvider`):

```js
// The gallery's own category tag link is single-quoted, like the other taxonomy links;
// navigation links on the page use double quotes and must not be picked up.
function categorySlug(html) {
    const m = html.match(/href='\/category\/([^'/]+)\/'/);
    return m ? normalizeCategorySlug(m[1]) : null;
}
```

Di `parseGallery`, tepat sebelum `return {`, tambahkan `const category = categorySlug(html);` dan tambahkan dua properti ke objek yang di-return (setelah `extraMeta: { tags, source: id },`):

```js
            category,
            contentType: mapCategoryToType(category),
```

- [ ] **Step 8: Implementasi di `core/providers/slugapi.js`**

Tambahkan impor: `const { normalizeCategorySlug, mapCategoryToType } = require('./contentType');`. Tambahkan helper di atas `createSlugApiProvider`:

```js
// Category lives only on the detail endpoint. Any failure here is non-fatal: the gallery
// still downloads, just without a content type.
async function fetchCategory(origin, slug, fetchText, headers) {
    try {
        const res = await fetchText(`${origin}/api/comics/${slug}`, headers);
        if (res.status !== 200) return { category: null, error: `category request returned status ${res.status}` };
        let data;
        try { data = JSON.parse(res.body); } catch (e) { return { category: null, error: 'category response is not JSON' }; }
        const raw = data && ((data.comic && data.comic.category && data.comic.category.slug) || (data.category && data.category.slug));
        const category = normalizeCategorySlug(raw);
        return category ? { category, error: null } : { category: null, error: 'category missing or invalid in response' };
    } catch (e) {
        return { category: null, error: `category request failed: ${e.message}` };
    }
}
```

Di `fetchMeta`, setelah blok `images.forEach(...)` dan sebelum `const rawTitle`, tambahkan `const cat = await fetchCategory(origin, slug, fetchText, imageHeaders());` dan tambahkan ke objek yang di-return (setelah `extraMeta: {...},`):

```js
                category: cat.category,
                contentType: mapCategoryToType(cat.category),
                categoryError: cat.error,
```

- [ ] **Step 9: Jalankan semua tes provider**

Run: `node --test test/contentType.test.js test/providerCategory.test.js test/providerFetch.test.js test/providers.test.js`
Expected: PASS. Catatan: tes site C lama di `test/providerFetch.test.js` memakai stub `fetchText` yang mencatat URL terakhir (`requested = url`) lalu menegaskan URL `/images`; request kategori tambahan menimpa nilai itu. Ubah HANYA stub itu agar mencatat URL pertama (`if (!requested) requested = url;`) dan biarkan asersinya; respons stub untuk request kategori tidak berisi kategori sehingga `categoryError` terisi dan `contentType` `null`, yang memang non-fatal. Jangan melemahkan tes lain.

- [ ] **Step 10: Commit**

```bash
git add core/providers test/contentType.test.js test/providerCategory.test.js
git commit -m "feat(providers): map site categories to comic/manga/other content types"
```

---

### Task 3: Migrasi v4 dan kolom `category` di queue

**Files:**
- Modify: `core/db/common.js` (`CURRENT_APP_SCHEMA_VERSION = 4`, `formatQueueRow`), `core/db/sqlite.js` (MIGRATIONS, `updateQueueItem`, `importData`), `core/db/postgres.js` (idem)
- Test: `test/contentType.db.test.js`; update `test/db.test.js` (hitungan migrasi/versi skema)

**Interfaces:**
- Consumes: Task 2 (`isContentType`).
- Produces: `updateQueueItem(id, { category: 'comic'|'manga'|'other'|null })`; `formatQueueRow(row).category: string|null`; export/import mempertahankan `category`.

- [ ] **Step 1: Tulis tes yang gagal**

Buat `test/contentType.db.test.js` (pola helper sama dengan `test/multiSource.db.test.js`):

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NHDL_LEGACY_CONFIG = '';
const dbMod = require('../core/db');

async function createTempDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-ct-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
    return {
        db, dbPath, tmpDir,
        async cleanup() {
            await dbMod.closeDb();
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        }
    };
}

test('queue category defaults to null and updateQueueItem sets/clears it; SSE-facing row exposes it', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 'xxx:5', url: 'u' }, ctx.db);
        assert.strictEqual(dbMod.formatQueueRow(await dbMod.getQueueItem('xxx:5', ctx.db)).category, null);

        const events = [];
        const onItem = (e) => events.push(e);
        dbMod.dbEvents.on('item', onItem);
        await dbMod.updateQueueItem('xxx:5', { category: 'manga' }, ctx.db);
        dbMod.dbEvents.off('item', onItem);
        assert.strictEqual(dbMod.formatQueueRow(await dbMod.getQueueItem('xxx:5', ctx.db)).category, 'manga');
        assert.ok(events.some(e => e.type === 'updated' && e.item.category === 'manga'), 'SSE item event carries category');

        await dbMod.updateQueueItem('xxx:5', { category: null }, ctx.db);
        assert.strictEqual(dbMod.formatQueueRow(await dbMod.getQueueItem('xxx:5', ctx.db)).category, null);
    } finally {
        await ctx.cleanup();
    }
});

test('exportData -> importData round-trip keeps category', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 'rox:9', url: 'u' }, ctx.db);
        await dbMod.updateQueueItem('rox:9', { category: 'comic' }, ctx.db);
        const payload = await dbMod.exportData(ctx.db);
        const exported = payload.tables.queue.find(r => String(r.gallery_id) === 'rox:9');
        assert.strictEqual(exported.category, 'comic');

        await dbMod.deleteQueueItem('rox:9', ctx.db);
        await dbMod.importData(payload, { mode: 'merge' }, ctx.db);
        assert.strictEqual(dbMod.formatQueueRow(await dbMod.getQueueItem('rox:9', ctx.db)).category, 'comic');
    } finally {
        await ctx.cleanup();
    }
});

test('migration v4 upgrades a v3 database in place, keeps rows, and is idempotent', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-mig4-test-'));
    const dbPath = path.join(tmpDir, 'v3.db');
    const old = new DatabaseSync(dbPath);
    old.exec(`
        CREATE TABLE queue (id INTEGER PRIMARY KEY, gallery_id TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT,
            status TEXT NOT NULL DEFAULT 'PENDING', batch INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
            pages_done INTEGER NOT NULL DEFAULT 0, pages_total INTEGER NOT NULL DEFAULT 0, error TEXT,
            retries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')), format TEXT);
        CREATE INDEX idx_queue_status ON queue(status);
        CREATE INDEX idx_queue_batch ON queue(batch);
        CREATE TABLE library (gallery_id TEXT PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL, pages INTEGER,
            format TEXT, language TEXT, artist TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')), meta TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), level TEXT NOT NULL,
            gallery_id INTEGER, message TEXT NOT NULL);
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version (version) VALUES (3);
        INSERT INTO queue (id, gallery_id, url, status, priority) VALUES (7, '468614', 'u1', 'DONE', 3);
        INSERT INTO queue (id, gallery_id, url, status) VALUES (9, 'xxx:5', 'u2', 'PENDING');
    `);
    old.close();
    try {
        const db = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
        assert.strictEqual(await dbMod.getSchemaVersion(db), 4);
        const cols = db.prepare(`PRAGMA table_info(queue)`).all().map(c => c.name);
        assert.ok(cols.includes('category'));
        const rows = await dbMod.getQueueItems({}, db);
        assert.deepStrictEqual(rows.map(r => [r.id, r.gallery_id, r.priority]), [[7, 468614, 3], [9, 'xxx:5', 0]]);
        assert.ok(rows.every(r => r.category === null));
        await dbMod.closeDb();
        const again = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
        assert.strictEqual(await dbMod.getSchemaVersion(again), 4);
        assert.strictEqual((await dbMod.getQueueItems({}, again)).length, 2);
    } finally {
        await dbMod.closeDb();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/contentType.db.test.js`
Expected: FAIL (`category` tidak ada; versi skema 3).

- [ ] **Step 3: Migrasi di SQLite**

Di `core/db/sqlite.js`, tambahkan elemen ke `MIGRATIONS` setelah versi 3:

```js
    ,{
        version: 4,
        up(db) {
            const cols = db.prepare(`PRAGMA table_info(queue)`).all().map(c => c.name);
            if (!cols.includes('category')) {
                db.exec(`ALTER TABLE queue ADD COLUMN category TEXT`);
            }
        }
    }
```

- [ ] **Step 4: Migrasi di PostgreSQL**

Di `core/db/postgres.js`, tambahkan elemen ke `MIGRATIONS` setelah versi 3:

```js
    ,{
        version: 4,
        async up(client) {
            await client.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS category TEXT;`);
        }
    }
```

- [ ] **Step 5: Versi aplikasi, `formatQueueRow`, `updateQueueItem`**

- `core/db/common.js`: ubah `const CURRENT_APP_SCHEMA_VERSION = 3;` menjadi `4`, dan tambahkan `category: r.category || null,` ke objek yang di-return `formatQueueRow` (setelah `format: r.format || null,`).
- `core/db/sqlite.js` dan `core/db/postgres.js`: di objek `map` pada `updateQueueItem` tambahkan `category: 'category'` (setelah `format: 'format'`). Perhatikan: kondisi `fields[key] !== undefined` sudah membolehkan `null` untuk menghapus nilai.

- [ ] **Step 6: Export/import mempertahankan `category`**

Di kedua adapter, cari penyisipan queue di `importData` (`grep -n "INSERT INTO queue" core/db/sqlite.js core/db/postgres.js`). Tambahkan kolom `category` ke daftar kolom dan nilai (`const category = isContentType(r.category) ? r.category : null;` di loop yang sama; impor `isContentType` dari `../providers/contentType`), termasuk ke klausa update/`ON CONFLICT` bila ada. `exportData` memakai `SELECT *` sehingga kolom baru ikut otomatis (periksa bahwa tidak ada daftar kolom eksplisit; bila ada, tambahkan `category`).

- [ ] **Step 7: Perbarui tes lama yang mengasumsikan versi 3**

Jalankan `grep -n "schema_version\|getSchemaVersion\|version, 3\|=== 3\|, 3)" test/*.js` dan ubah hanya angka versi skema/hitungan migrasi yang bergantung pada jumlah migrasi (3 → 4) di `test/db.test.js` (dan tes lain bila ada). Jangan ubah asersi lain.

- [ ] **Step 8: Jalankan tes**

Run: `node --test test/contentType.db.test.js test/db.test.js test/multiSource.db.test.js`
Expected: PASS. Lalu `npm test` sekali (timeout besar): PASS. (Suite PostgreSQL tidak bisa dijalankan tanpa `DATABASE_URL`; cocokkan logika PG dengan SQLite dengan membaca teliti.)

- [ ] **Step 9: Commit**

```bash
git add core/db test/contentType.db.test.js test/db.test.js
git commit -m "feat(db): schema v4 adds queue.category and carries it through export/import"
```

---

### Task 4: Engine — folder bertipe, penyimpanan tipe, library, dan server

**Files:**
- Modify: `core/engine.js` (impor; `findExistingOnDisk`; `processGallery`), `server/index.js` (`GET /api/library`)
- Test: `test/contentType.engine.test.js`

**Interfaces:**
- Consumes: Task 2 (`typeFolderName`, `isContentType`, `meta.contentType`, `meta.category`, `meta.categoryError`), Task 3 (`updateQueueItem(..., { category })`).
- Produces: galeri non-default dengan tipe disimpan di `<base>/<Tipe>/<Bahasa>/<Author>/<Judul>`; `queue.category` terisi; library `meta.contentType` + `meta.category` terisi; `/api/library` items punya `category`.

- [ ] **Step 1: Tulis tes yang gagal**

Buat `test/contentType.engine.test.js` berdasarkan pola `test/multiSource.engine.test.js` (baca file itu dulu; gunakan ulang gaya `startSite`/`setup`, tetapi salin helper yang diperlukan ke file baru agar tes mandiri):

```js
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
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/contentType.engine.test.js`
Expected: FAIL (tidak ada folder bertipe, `lib.meta.contentType` undefined, `findExistingOnDisk` tidak menemukan).

- [ ] **Step 3: Impor di `core/engine.js`**

Setelah baris `const { PAGE_EXTS } = require('./providers/boards');` tambahkan:

```js
const { typeFolderName, isContentType, TYPE_LABELS } = require('./providers/contentType');
```

- [ ] **Step 4: `findExistingOnDisk` menelusuri layout bertipe**

Di `findExistingOnDisk(cachedTitle, cachedAuthor)` (sekarang membaca `langDirs` dari `this.baseDownloadDir`), bungkus penelusuran yang ada dalam loop atas root: root pertama `this.baseDownloadDir`, lalu tiap folder tipe yang ada (`Object.values(TYPE_LABELS)` → `path.join(this.baseDownloadDir, label)`, hanya bila direktori). Ganti semua pemakaian `this.baseDownloadDir` di dalam penelusuran bahasa/author (mis. `fs.readdirSync(this.baseDownloadDir, ...)`, `path.join(this.baseDownloadDir, langDir.name)`) dengan variabel `root`. Kerangka hasil:

```js
        const roots = [this.baseDownloadDir];
        for (const label of Object.values(TYPE_LABELS)) {
            const p = path.join(this.baseDownloadDir, label);
            try { if (fs.statSync(p).isDirectory()) roots.push(p); } catch (e) {}
        }
        for (const root of roots) {
            let langDirs;
            try {
                langDirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
            } catch (e) { continue; }
            // ... isi loop lama, dengan `root` menggantikan `this.baseDownloadDir`
        }
        return null;
```

Pertahankan logika pencocokan yang ada persis (cocok judul/author, arsip lalu folder). Catatan: di root dasar, folder tipe (`Comic`, `Manga`, `Other`) akan terbaca sebagai "bahasa"; itu tidak berbahaya (author dir di dalamnya tidak cocok dengan author yang dicari) dan diabaikan.

- [ ] **Step 5: `processGallery` — simpan tipe dan pilih folder**

Setelah baris destrukturisasi `const { title, mediaId, numPages, pageExts, langStr, authorStr, extraMeta } = meta;` ganti `extraMeta` agar menjadi variabel turunan. Ubah baris itu menjadi:

```js
            const { title, mediaId, numPages, pageExts, langStr, authorStr } = meta;
            const contentType = (!provider.isDefault && isContentType(meta.contentType)) ? meta.contentType : null;
            const extraMeta = {
                ...(meta.extraMeta || {}),
                ...(contentType ? { contentType, category: meta.category || null } : {})
            };
            if (meta.categoryError) {
                await logActivity(`[CATEGORY] ID ${galleryId}: ${meta.categoryError} — continuing without a content type`);
            }
```

Setelah blok yang memanggil `updateQueueItem(galleryId, { pagesTotal: numPages })` (di dalam `if (!this.isGalleryDeleting(gid)) { ... }`) tambahkan di dalam blok yang sama:

```js
                if (contentType) await updateQueueItem(galleryId, { category: contentType });
```

Ganti baris `const parentDir = path.join(this.baseDownloadDir, sanitizedLang, sanitizedAuthor);` dengan:

```js
            const typeDir = typeFolderName(contentType);
            const parentDir = typeDir
                ? path.join(this.baseDownloadDir, typeDir, sanitizedLang, sanitizedAuthor)
                : path.join(this.baseDownloadDir, sanitizedLang, sanitizedAuthor);
```

(`extraMeta` yang baru dipakai oleh dua panggilan `saveToLibrary` dan oleh `tryApiArchiveDownload`; tidak perlu mengubah pemanggilnya. Library `meta` mewarisi `contentType`/`category` lewat `...extra.extraMeta` di `saveToLibrary`.)

- [ ] **Step 6: Server `/api/library`**

Di `server/index.js` pada pemetaan `items` untuk `GET /api/library`, tambahkan setelah `source: sourceOf(data.gallery_id),`:

```js
                    category: (data.meta && data.meta.contentType) || null,
```

- [ ] **Step 7: Jalankan tes**

Run: `node --test test/contentType.engine.test.js test/multiSource.engine.test.js`
Expected: PASS. Lalu `npm test` sekali (timeout besar): PASS.

- [ ] **Step 8: Commit**

```bash
git add core/engine.js server/index.js test/contentType.engine.test.js
git commit -m "feat(engine): store provider galleries under type folders and record content type"
```

---

### Task 5: UI — badge dan filter tipe

**Files:**
- Create: `webui/src/lib/contentType.js`, `test/webuiContentType.test.js`
- Modify: `webui/src/lib/stores/app.svelte.js`, `webui/src/lib/components/VirtualQueueTable.svelte`, `SidebarFilter.svelte`, `LibraryModal.svelte`

**Interfaces:**
- Consumes: respons API `item.category` (Task 1/3/4).
- Produces (`webui/src/lib/contentType.js`, ES module murni, tanpa rune):
  - `TYPE_ORDER = ['comic', 'manga', 'other']`
  - `typeLabel(type) -> 'Comic' | 'Manga' | 'Other' | ''`
  - `itemType(item) -> 'comic' | 'manga' | 'other' | null` (membaca `item.category`, selain tiga nilai itu → `null`)
  - `matchesTypeFilter(item, filter) -> boolean` (`'all'`/falsy lolos semua)
  - `countByType(items) -> Map<string, number>` (hanya item bertipe)
  - `typeBadgeClass(type) -> string` (kelas Tailwind inline untuk badge)

- [ ] **Step 1: Tulis tes yang gagal**

Buat `test/webuiContentType.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

async function load() {
    return await import('../webui/src/lib/contentType.js');
}

test('itemType accepts only the three known types', async () => {
    const t = await load();
    assert.strictEqual(t.itemType({ category: 'comic' }), 'comic');
    assert.strictEqual(t.itemType({ category: 'manga' }), 'manga');
    assert.strictEqual(t.itemType({ category: 'other' }), 'other');
    for (const bad of [{}, { category: null }, { category: 'doujinshi' }, { category: '' }, null, undefined]) {
        assert.strictEqual(t.itemType(bad), null, JSON.stringify(bad));
    }
});

test('typeLabel and typeBadgeClass', async () => {
    const t = await load();
    assert.strictEqual(t.typeLabel('comic'), 'Comic');
    assert.strictEqual(t.typeLabel('manga'), 'Manga');
    assert.strictEqual(t.typeLabel('other'), 'Other');
    assert.strictEqual(t.typeLabel(null), '');
    assert.ok(t.typeBadgeClass('manga').length > 0);
    assert.notStrictEqual(t.typeBadgeClass('manga'), t.typeBadgeClass('comic'));
});

test('matchesTypeFilter and countByType ignore untyped items', async () => {
    const t = await load();
    const items = [{ category: 'comic' }, { category: 'manga' }, { category: 'manga' }, { category: null }, {}];
    assert.strictEqual(items.filter(i => t.matchesTypeFilter(i, 'all')).length, 5);
    assert.strictEqual(items.filter(i => t.matchesTypeFilter(i, null)).length, 5);
    assert.strictEqual(items.filter(i => t.matchesTypeFilter(i, 'manga')).length, 2);
    assert.strictEqual(items.filter(i => t.matchesTypeFilter(i, 'other')).length, 0);
    const counts = t.countByType(items);
    assert.deepStrictEqual([...counts.entries()].sort(), [['comic', 1], ['manga', 2]]);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/webuiContentType.test.js`
Expected: FAIL (modul tidak ada).

- [ ] **Step 3: Implementasi `webui/src/lib/contentType.js`**

```js
// Pure helpers for the content type (comic / manga / other) shown in the queue and library.
export const TYPE_ORDER = ['comic', 'manga', 'other'];

const LABELS = { comic: 'Comic', manga: 'Manga', other: 'Other' };

const BADGE_CLASSES = {
  comic: 'bg-[#2a1f0a] text-[#fbbf24] border border-[#78350f]',
  manga: 'bg-[#1f1030] text-[#c4b5fd] border border-[#4c1d95]',
  other: 'bg-[#1a1a1a] text-[#9ca3af] border border-[#374151]'
};

export function typeLabel(type) {
  return LABELS[type] || '';
}

export function itemType(item) {
  const c = item && item.category;
  return TYPE_ORDER.includes(c) ? c : null;
}

export function matchesTypeFilter(item, filter) {
  if (!filter || filter === 'all') return true;
  return itemType(item) === filter;
}

export function countByType(items) {
  const counts = new Map();
  for (const item of items) {
    const t = itemType(item);
    if (t) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

export function typeBadgeClass(type) {
  return BADGE_CLASSES[type] || BADGE_CLASSES.other;
}
```

- [ ] **Step 4: Jalankan tes helper**

Run: `node --test test/webuiContentType.test.js`
Expected: PASS.

- [ ] **Step 5: Store**

Di `webui/src/lib/stores/app.svelte.js`: tambahkan impor `import { TYPE_ORDER, matchesTypeFilter, countByType } from '../contentType.js';`. Tambahkan state di dekat `sourceFilter`: `typeFilter = $state('all'); // 'all' | 'comic' | 'manga' | 'other'` dan method di dekat `setSourceFilter`:

```js
  setTypeFilter(id) {
    this.typeFilter = this.typeFilter === id ? 'all' : id;
  }
```

Di `filterCounts` (tempat `sources` dihitung) tambahkan sebelum `return`: `const typeCounts = countByType(this.items);` dan ke objek yang di-return tambahkan:

```js
      types: TYPE_ORDER.filter((id) => typeCounts.has(id)).map((id) => ({ id, count: typeCounts.get(id) }))
```

Di `filteredAndSortedItems`, di samping pembacaan `const srcf = this.sourceFilter;` tambahkan `const tf = this.typeFilter;` dan setelah baris `if (!matchesSourceFilter(item, srcf)) continue;` tambahkan `if (!matchesTypeFilter(item, tf)) continue;`.

- [ ] **Step 6: Badge di `VirtualQueueTable.svelte`**

Impor `import { itemType, typeLabel, typeBadgeClass } from '../contentType.js';`. Di blok `{#each visibleRows ...}` tambahkan `{@const ctype = itemType(item)}` di samping `{@const src = ...}`. Tepat setelah badge sumber (baik di sel judul mobile maupun desktop; keduanya sudah memiliki `<span ...>{sourceLabel(...)}</span>` tanpa kondisi), tambahkan:

```svelte
{#if ctype}<span class="inline-block align-middle leading-none px-1 py-0.5 rounded text-[9px] font-mono uppercase mr-1 {typeBadgeClass(ctype)}" title="Type: {typeLabel(ctype)}">{typeLabel(ctype)}</span>{/if}
```

Jangan ubah `ROW_HEIGHT`, grid, atau konstanta virtualisasi.

- [ ] **Step 7: Filter "Type" di `SidebarFilter.svelte`**

Impor `import { typeLabel } from '../contentType.js';` dan tambahkan di `<script>`:

```js
  const typeItems = $derived(counts.types.map((t) => ({ ...t, label: typeLabel(t.id) })));
```

Tepat setelah blok `{#if sourceItems.length > 0} ... {/if}` (bagian Source), tambahkan blok serupa:

```svelte
  {#if typeItems.length > 0}
    <div class="p-2 pt-0 flex flex-col gap-0.5">
      <div class="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold">
        Type
      </div>
      {#each typeItems as t (t.id)}
        {@const active = appStore.typeFilter === t.id}
        <button
          type="button"
          onclick={() => appStore.setTypeFilter(t.id)}
          class="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer {active
            ? 'bg-[var(--bg-selected-focus)] text-white font-semibold border border-[var(--accent)]/40'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white border border-transparent'}"
        >
          <span class="truncate">{t.label}</span>
          <span class="text-[11px] px-1.5 rounded font-mono {active ? 'bg-[var(--accent)] text-black font-bold' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'}">{t.count}</span>
        </button>
      {/each}
    </div>
  {/if}
```

- [ ] **Step 8: Library Manager**

Di `LibraryModal.svelte`: impor `import { itemType, typeLabel, typeBadgeClass } from '../contentType.js';`, tambah state `let libraryType = $state('all');`, tambahkan di predikat `filteredLibrary` (setelah pemeriksaan sumber) `if (libraryType !== 'all' && itemType(item) !== libraryType) return false;`, tambahkan `let libraryTypeOptions = $derived(['comic', 'manga', 'other'].filter(t => libraryItems.some(i => itemType(i) === t)));`, dan tepat setelah `<select>` sumber tambahkan:

```svelte
          {#if libraryTypeOptions.length > 0}
            <select bind:value={libraryType} class="bg-[var(--bg-elevated)] text-xs font-mono text-white border border-[var(--border-subtle)] rounded px-2 py-1">
              <option value="all">All types</option>
              {#each libraryTypeOptions as t (t)}
                <option value={t}>{typeLabel(t)}</option>
              {/each}
            </select>
          {/if}
```

Dan di baris judul, tepat setelah badge sumber, tambahkan `{#if itemType(item)}<span class="px-1 py-0.5 rounded text-[9px] font-mono uppercase shrink-0 {typeBadgeClass(itemType(item))}">{typeLabel(itemType(item))}</span>{/if}`.

- [ ] **Step 9: Build dan tes**

Run: `node --test test/webuiContentType.test.js test/webuiSources.test.js test/webuiQueueView.test.js`, lalu `npm --prefix webui run build` (tanpa peringatan Svelte), lalu `npm test` sekali (timeout besar).
Expected: semua PASS.

- [ ] **Step 10: Commit**

```bash
git add webui test/webuiContentType.test.js
git commit -m "feat(ui): show content type badge and add a Type filter to the queue and library"
```

---

### Task 6: Verifikasi kategori nyata, dokumentasi, dan penutup

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/CHANGELOG.md`, `docs/PLAN.md`, `docs/AI_AGENT.md` (hanya bila ada pernyataan yang menjadi keliru)

**Interfaces:**
- Consumes: semua task sebelumnya.

- [ ] **Step 1: Cek kategori nyata (hanya metadata, tanpa mengunduh halaman)**

Tulis skrip sekali pakai di folder temp OS (BUKAN di repo) yang memanggil `fetchMeta` provider asli memakai transport yang sama dengan engine, lalu cetak `category`, `contentType`, `categoryError`, `numPages`:

```js
// run from the repo root: node <temp>/probe-category.js
const providers = require('<repo>/core/providers');
const { fetchText } = require('<repo>/core/providers/http');
const { curlFetchText } = require('<repo>/core/providers/http');
const urls = [
  'https://nhentai.xxx/g/539224/',
  'https://hentairox.com/gallery/817456/',
  'https://nhentai.com/en/comic/amys-country-wrangle-porn-comic'
];
(async () => {
  for (const u of urls) {
    const r = providers.resolveInput(u);
    const f = r.provider.transport === 'curl' ? curlFetchText : fetchText;
    const m = await r.provider.fetchMeta(r.key, { fetchText: f });
    console.log(r.key, JSON.stringify({ category: m.category, contentType: m.contentType, categoryError: m.categoryError || null, pages: m.numPages }));
  }
})().catch(e => { console.error(e); process.exit(1); });
```

Gunakan jalur absolut repo pada `require`. Perkiraan yang masuk akal: site B2 `western` → `comic`; site C `porn-comic` → `comic`; site B1 sesuai tautan kategori di halamannya (mis. `manga` → `manga`). Laporkan hasil apa adanya; bila ada yang `null`, selidiki markup/response sebenarnya (jangan menebak) dan laporkan sebagai BLOCKED/DONE_WITH_CONCERNS beserta buktinya. Jangan menjalankan server pengguna di port 8080 dan jangan menulis ke `data/`.

- [ ] **Step 2: Dokumentasi (nama generik saja)**

- `docs/ARCHITECTURE.md`: tambahkan `core/providers/contentType.js` dan penjelasan tipe konten (pemetaan slug → tipe, layout folder `<base>/<Tipe>/<Bahasa>/<Author>/<Judul>`, site A tidak berubah, kolom `queue.category`, `meta.contentType` di library, `findExistingOnDisk` bertipe, skema v4).
- `docs/CHANGELOG.md`: entri teratas baru, aktor `AI (Claude Code, Sonnet 5.5)`, ringkas fitur dan hasil verifikasi (jangan menambah entri "Manual (...)").
- `docs/PLAN.md`: tambahkan kelompok tugas "Content type" dengan `[x]` dan baris Log.
- `docs/AI_AGENT.md`: periksa dengan `grep -n "Language\|Author\|folder" docs/AI_AGENT.md`; perbarui hanya bila ada pernyataan layout folder yang menjadi keliru.
- Grep baris yang ditambahkan di `docs/` (selain `docs/superpowers/`) untuk nama/domain/prefix asli: harus nol hasil.

- [ ] **Step 3: Jalankan seluruh suite dan commit**

Run: `npm test` (timeout besar). Expected: PASS.

```bash
git add docs
git commit -m "docs: record content type (comic/manga) in architecture, changelog, and plan"
```
