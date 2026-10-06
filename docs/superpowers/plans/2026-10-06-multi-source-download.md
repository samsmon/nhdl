# Multi-Source Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Antrean NHDL bisa menerima dan mendownload galeri dari tiga situs tambahan (dua situs ber-ID angka dengan platform sama, satu situs ber-ID slug dengan API JSON), dan list menampilkan kategori sumber tiap item.

**Architecture:** Lapisan provider kecil (`core/providers/`) mengenali URL/ID, membangun kunci berprefix (`xxx:539224`, `com:<slug>`), dan mengambil metadata + daftar URL gambar per halaman. `gallery_id` di DB menjadi TEXT (migrasi v3, kedua adapter); ID lama tanpa prefix tetap berarti situs default, sehingga data lama dan API publik untuk situs default tidak berubah (`galleryId` tetap number untuk situs default, string untuk situs lain). Engine memakai provider hanya untuk metadata dan URL gambar; alur lain (library, retry, kompres, SSE) dipakai bersama.

**Tech Stack:** Node >= 22.13 (`node:test`, `node:sqlite`), `pg`, Svelte 5 + Vite (webui). Tanpa dependensi baru.

**Spec:** `docs/superpowers/specs/2026-10-06-multi-source-download-design.md`

## Global Constraints

- Tanpa dependensi runtime baru; hanya `pg` yang sudah ada.
- Commit **atas nama user** (`git config user.name/email`), tanpa trailer `Co-Authored-By` atau atribusi AI di pesan commit. Jalankan `npm test` sebelum commit; jangan commit kalau gagal.
- Kerja di branch `rework`.
- Setiap endpoint/field/event baru ditulis di `docs/API.md` **dulu**, baru diimplementasikan (Task 1).
- Di dokumen (`docs/*`, termasuk dokumen ini) situs ditulis generik: **site A** (default), **site B1/B2** (ID angka), **site C** (slug). Nama asli, domain, dan prefix hanya ada di kode dan test.
- State tetap di DB lewat `core/db.js`; migrasi skema di **kedua** adapter (`core/db/sqlite.js`, `core/db/postgres.js`); UI menerima perubahan lewat SSE, bukan polling.
- Kode tidak boleh menembus blokir DNS/ISP (tidak ada `--resolve`/IP pin untuk provider baru). Provider baru memakai DNS sistem biasa.
- Prefix kunci (konstanta di kode): site B1 = `xxx`, site B2 = `rox`, site C = `com`.
- Kunci kanonik: angka polos `^[1-9]\d*$` (site A) atau `<prefix>:<isi>`; isi site B = angka > 0, isi site C = slug `^[a-z0-9][a-z0-9-]*$` (huruf kecil).
- ID di respons API/SSE: **number** bila kunci angka polos, **string** bila berprefix (helper `toPublicId`).
- Jangan commit isi `samples/`.

## Review Focus

1. Satu baris URL site B/C yang juga memuat angka 5–7 digit di slug/judul tidak boleh salah dikenali sebagai ID site A (regex fallback lama `\b\d{5,7}\b`): URL `.../g/539224/` harus jadi kunci `xxx:539224`, bukan `539224`.
2. Kunci berprefix mengandung `:` yang tidak valid sebagai nama folder di Windows: nama folder fallback dan marker tidak boleh memakai kunci mentah.
3. Semua tempat yang dulu membandingkan `Number(gallery_id)` (reorder prioritas, import replace, bulk pause/delete) tidak boleh menghasilkan `NaN` untuk kunci berprefix.
4. Halaman yang diumumkan situs tetapi 404 pada semua ekstensi kandidat harus berakhir sebagai retry/error terukur, bukan loop tak berujung atau file HTML tersimpan sebagai gambar.
5. Respons HTML halaman blokir/tantangan (bukan galeri) harus jadi error jelas, bukan metadata kosong.
6. Migrasi v3 harus idempoten pada DB yang sudah v3 dan tidak menghilangkan baris/urutan antrean (`id`, `priority`, `created_at`) pada DB v2 berisi ID angka.
7. Rescan library harus mengenali marker `.nhdl-id` berisi kunci berprefix, dan tetap mengenali marker angka lama.

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `core/providers/index.js` (baru) | Registry provider, `resolveInput`, `canonicalKey`, `providerForKey`, `sourceOf`, `toPublicId`, `listSources`, `registerProvider` |
| `core/providers/default.js` (baru) | Definisi site A (pengenal URL/ID saja; metadata tetap via `engine.fetchMetadata`) |
| `core/providers/boards.js` (baru) | Pabrik provider site B1/B2: parser HTML + URL gambar |
| `core/providers/slugapi.js` (baru) | Provider site C: API JSON `/api/comics/<slug>/images` |
| `core/providers/http.js` (baru) | `fetchText`, `downloadToFile` (http/https, redirect, `.part`, tanpa IP pin) |
| `core/db/listParser.js` (baru) | `parseListText` bersama untuk kedua adapter |
| `core/db/common.js` | `normalizeGalleryId`/`isValidGalleryId` baru, `toPublicId`, `formatQueueRow` + `source` |
| `core/db/sqlite.js`, `core/db/postgres.js` | Migrasi v3, penggantian `Number(gallery_id)`, `parseListText` bersama |
| `core/engine.js` | Stop-flag berbasis string, jalur provider di `processGallery`, `downloadProviderPage` |
| `core/tracker.js` | Rescan marker memakai `canonicalKey` |
| `server/index.js` | `source` di `/api/library`, `sources` di `/api/config`, `activeGalleryId` string |
| `webui/src/lib/sources.js` (baru) | Helper murni sumber (badge, filter, hitung) |
| `webui/src/lib/stores/app.svelte.js`, `QueueItem.svelte`, `SidebarFilter.svelte`, `LibraryModal.svelte` | Badge + filter sumber |
| `test/providers.test.js`, `test/providerFetch.test.js`, `test/multiSource.db.test.js`, `test/multiSource.engine.test.js`, `test/webuiSources.test.js` (baru) | Tes |

---

### Task 1: Dokumentasi kontrak API (docs-first)

**Files:**
- Modify: `docs/API.md` (bagian 1 `QueueItem`, 3.2 antrean, 3.3 retry, 3.4 config, 3.5 library)

**Interfaces:**
- Produces: kontrak tertulis yang diikuti Task 6–8 (`QueueItem.source`, `LibraryItem.source`, `GET /api/config` → `sources`, format `galleryId`).

- [ ] **Step 1: Ubah contoh `QueueItem` dan catatannya**

Di `docs/API.md` bagian `### QueueItem`, tambahkan field `"source": "default"` setelah `"galleryId": 123456` dan tambahkan bullet berikut sesudah bullet `Nilai status`:

```markdown
- `galleryId`: `number` untuk galeri site A (kunci angka polos, kompatibel dengan versi sebelumnya), `string` berprefix (`"<prefix>:<isi>"`) untuk site B1/B2/C. Contoh: `123456`, `"b1:539224"`, `"c1:some-slug"`. Nilai ini dipakai apa adanya pada `ids`/`galleryId` di endpoint lain.
- `source`: id sumber hasil turunan dari prefix `galleryId` (`"default"` bila tanpa prefix). Tidak disimpan di DB. Daftar sumber ada di `GET /api/config` → `sources`.
```

- [ ] **Step 2: Ubah baris `POST /api/queue`, `/api/queue/import`, pause/resume/delete/priority, `/api/retry`**

Pada tabel 3.2 dan 3.3 ganti tipe `number[]` menjadi `(number\|string)[]` untuk `ids`, dan `number[]` menjadi `(number\|string)[]` untuk `galleryIds`. Tambahkan ke kolom Keterangan `POST /api/queue` dan `/api/queue/import`:

```markdown
Setiap baris boleh berupa URL galeri dari site A, B1, B2, atau C, ID polos site A, atau kunci berprefix. Baris yang tidak dikenali dilewati dan dihitung di field `ignored` pada respons.
```

Dan ubah respons keduanya menjadi `{"success":true, "added": number, "updated": number, "duplicates": number, "ignored": number, "galleryIds": (number|string)[], "total": number}`.

- [ ] **Step 3: Ubah `GET /api/config` dan library**

Di tabel 3.4 baris `GET /api/config` tambahkan `"sources": {"id": string, "label": string}[]` ke respons, dengan keterangan: `Daftar sumber yang dikenal server (urutan tampilan UI), dipakai untuk label badge dan filter kategori.` Di tabel 3.5 baris `GET /api/library` ubah respons menjadi `{"items": LibraryItem[], "total": number}` dan tambahkan di bawah tabel:

```markdown
`LibraryItem` memiliki field tambahan `source` (sama seperti `QueueItem.source`).
```

- [ ] **Step 4: Commit**

```bash
git add docs/API.md
git commit -m "docs(api): document multi-source galleryId format, source field, and config sources"
```

---

### Task 2: Registry provider dan kunci kanonik

**Files:**
- Create: `core/providers/default.js`, `core/providers/boards.js` (hanya bagian pengenal URL/ID dulu), `core/providers/slugapi.js` (idem), `core/providers/index.js`
- Test: `test/providers.test.js`

**Interfaces:**
- Produces (`core/providers/index.js`):
  - `resolveInput(text: string) -> { provider, key: string, url: string } | null` — `text` adalah satu URL, ID polos, atau kunci berprefix.
  - `canonicalKey(input: string|number) -> string | null`
  - `providerForKey(key: string|number) -> provider` (default bila tanpa prefix; melempar `Error` bila prefix tak dikenal)
  - `sourceOf(key) -> string` (id provider; `'default'` bila tanpa prefix atau prefix tak dikenal)
  - `toPublicId(key) -> number | string`
  - `listSources() -> { id: string, label: string }[]`
  - `registerProvider(provider) -> void` (dipakai tes dan perluasan)
  - `PROVIDERS: provider[]` (array hidup)
  - Bentuk provider: `{ id, label, prefix, isDefault, urlPatterns: RegExp[], parseBody(body) -> string|null, makeKey(body) -> string|null, buildUrl(key) -> string }` (+ `fetchMeta`, `imageHeaders` di Task 5).

- [ ] **Step 1: Tulis tes yang gagal**

Buat `test/providers.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const providers = require('../core/providers');

test('resolveInput: site A URL, bare id, and certain.site alias map to the default provider', () => {
    for (const input of ['https://nhentai.net/g/468614/', 'https://certain.site/g/468614', '468614', '0468614']) {
        const r = providers.resolveInput(input);
        assert.ok(r, input);
        assert.strictEqual(r.key, '468614');
        assert.strictEqual(r.provider.id, 'default');
        assert.strictEqual(r.url, 'https://nhentai.net/g/468614/');
    }
});

test('resolveInput: site B1/B2 URLs become prefixed keys and are NOT mistaken for site A ids', () => {
    const a = providers.resolveInput('https://nhentai.xxx/g/539224/');
    assert.strictEqual(a.key, 'xxx:539224');
    assert.strictEqual(a.provider.id, 'xxx');
    assert.strictEqual(a.url, 'https://nhentai.xxx/g/539224/');
    const b = providers.resolveInput('https://hentairox.com/gallery/817456/');
    assert.strictEqual(b.key, 'rox:817456');
    assert.strictEqual(b.url, 'https://hentairox.com/gallery/817456/');
});

test('resolveInput: site C URL becomes a lowercase slug key, with or without language segment', () => {
    for (const input of [
        'https://nhentai.com/en/comic/Amys-Country-Wrangle-Porn-Comic',
        'https://nhentai.com/comic/amys-country-wrangle-porn-comic/'
    ]) {
        const r = providers.resolveInput(input);
        assert.strictEqual(r.key, 'com:amys-country-wrangle-porn-comic');
        assert.strictEqual(r.provider.id, 'com');
        assert.strictEqual(r.url, 'https://nhentai.com/en/comic/amys-country-wrangle-porn-comic');
    }
});

test('resolveInput: prefixed keys round-trip and garbage is rejected', () => {
    assert.strictEqual(providers.resolveInput('xxx:539224').key, 'xxx:539224');
    assert.strictEqual(providers.resolveInput('com:some-slug').key, 'com:some-slug');
    for (const bad of ['', 'abc', 'xxx:abc', 'xxx:0', 'com:Not A Slug', 'zzz:123', 'https://example.org/g/1/', '-5', '0']) {
        assert.strictEqual(providers.resolveInput(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
});

test('canonicalKey accepts numbers and numeric strings, rejects non-positive and junk', () => {
    assert.strictEqual(providers.canonicalKey(468614), '468614');
    assert.strictEqual(providers.canonicalKey(' 468614 '), '468614');
    assert.strictEqual(providers.canonicalKey('rox:12'), 'rox:12');
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '12abc', 'rox:', 'rox:-1']) {
        assert.strictEqual(providers.canonicalKey(bad), null, String(bad));
    }
});

test('sourceOf / toPublicId / providerForKey', () => {
    assert.strictEqual(providers.sourceOf('468614'), 'default');
    assert.strictEqual(providers.sourceOf(468614), 'default');
    assert.strictEqual(providers.sourceOf('rox:12'), 'rox');
    assert.strictEqual(providers.sourceOf('zzz:12'), 'default');
    assert.strictEqual(providers.toPublicId('468614'), 468614);
    assert.strictEqual(providers.toPublicId('xxx:1'), 'xxx:1');
    assert.strictEqual(providers.providerForKey('com:x').id, 'com');
    assert.throws(() => providers.providerForKey('zzz:1'), /Unknown source/);
});

test('listSources lists every provider with a label, default first', () => {
    const s = providers.listSources();
    assert.deepStrictEqual(s.map(x => x.id), ['default', 'xxx', 'rox', 'com']);
    assert.ok(s.every(x => typeof x.label === 'string' && x.label.length > 0));
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test test/providers.test.js`
Expected: FAIL (`Cannot find module '../core/providers'`).

- [ ] **Step 3: Implementasi provider default**

Buat `core/providers/default.js`:

```js
const POSITIVE_INT = /^\d+$/;

function parseBody(body) {
    const s = String(body ?? '').trim();
    if (!POSITIVE_INT.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

module.exports = {
    id: 'default',
    label: 'nhentai.net',
    prefix: null,
    isDefault: true,
    urlPatterns: [/^https?:\/\/(?:www\.)?(?:nhentai\.net|certain\.site)\/g\/(\d+)/i],
    parseBody,
    makeKey: parseBody,
    buildUrl: (key) => `https://nhentai.net/g/${key}/`
};
```

- [ ] **Step 4: Implementasi pabrik provider site B (bagian pengenal)**

Buat `core/providers/boards.js`:

```js
function createBoardsProvider(cfg) {
    const { id, label, origin, galleryPath, hosts } = cfg;
    const hostPattern = hosts.map(h => h.replace(/\./g, '\\.')).join('|');

    function parseBody(body) {
        const s = String(body ?? '').trim();
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
    }

    return {
        id,
        label,
        prefix: id,
        isDefault: false,
        origin,
        urlPatterns: [new RegExp(`^https?:\\/\\/(?:www\\.)?(?:${hostPattern})\\/${galleryPath}\\/(\\d+)`, 'i')],
        parseBody,
        makeKey(body) {
            const n = parseBody(body);
            return n ? `${id}:${n}` : null;
        },
        buildUrl(key) {
            return `${origin}/${galleryPath}/${key.slice(id.length + 1)}/`;
        },
        cfg
    };
}

module.exports = { createBoardsProvider };
```

- [ ] **Step 5: Implementasi provider site C (bagian pengenal)**

Buat `core/providers/slugapi.js`:

```js
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function createSlugApiProvider(cfg) {
    const { id, label, origin, hosts } = cfg;
    const hostPattern = hosts.map(h => h.replace(/\./g, '\\.')).join('|');

    function parseBody(body) {
        const s = String(body ?? '').trim().toLowerCase();
        return SLUG.test(s) ? s : null;
    }

    return {
        id,
        label,
        prefix: id,
        isDefault: false,
        origin,
        urlPatterns: [new RegExp(`^https?:\\/\\/(?:www\\.)?(?:${hostPattern})\\/(?:[a-z]{2}\\/)?comic\\/([A-Za-z0-9-]+)`, 'i')],
        parseBody,
        makeKey(body) {
            const slug = parseBody(body);
            return slug ? `${id}:${slug}` : null;
        },
        buildUrl(key) {
            return `${origin}/en/comic/${key.slice(id.length + 1)}`;
        },
        cfg
    };
}

module.exports = { createSlugApiProvider };
```

- [ ] **Step 6: Implementasi registry**

Buat `core/providers/index.js`:

```js
const defaultProvider = require('./default');
const { createBoardsProvider } = require('./boards');
const { createSlugApiProvider } = require('./slugapi');

const PROVIDERS = [
    defaultProvider,
    createBoardsProvider({
        id: 'xxx',
        label: 'nhentai.xxx',
        origin: 'https://nhentai.xxx',
        hosts: ['nhentai.xxx'],
        galleryPath: 'g',
        imageHost: (server) => `i${server}.nhentaimg.com`
    }),
    createBoardsProvider({
        id: 'rox',
        label: 'hentairox.com',
        origin: 'https://hentairox.com',
        hosts: ['hentairox.com'],
        galleryPath: 'gallery',
        imageHost: (server) => `m${server}.hentairox.com`
    }),
    createSlugApiProvider({
        id: 'com',
        label: 'nhentai.com',
        origin: 'https://nhentai.com',
        hosts: ['nhentai.com']
    })
];

function registerProvider(provider) {
    const i = PROVIDERS.findIndex(p => p.id === provider.id);
    if (i === -1) PROVIDERS.push(provider);
    else PROVIDERS[i] = provider;
}

function byPrefix(prefix) {
    return PROVIDERS.find(p => p.prefix === prefix) || null;
}

function resolveInput(text) {
    const s = String(text ?? '').trim();
    if (!s) return null;

    const prefixed = s.match(/^([a-z][a-z0-9]*):(.+)$/i);
    if (prefixed && !/^https?$/i.test(prefixed[1])) {
        const provider = byPrefix(prefixed[1].toLowerCase());
        if (!provider) return null;
        const key = provider.makeKey(prefixed[2]);
        return key ? { provider, key, url: provider.buildUrl(key) } : null;
    }

    for (const provider of PROVIDERS) {
        for (const re of provider.urlPatterns) {
            const m = s.match(re);
            if (m) {
                const key = provider.makeKey(m[1]);
                return key ? { provider, key, url: provider.buildUrl(key) } : null;
            }
        }
    }

    const key = defaultProvider.makeKey(s);
    return key ? { provider: defaultProvider, key, url: defaultProvider.buildUrl(key) } : null;
}

function canonicalKey(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'number') {
        if (!Number.isInteger(input)) return null;
        return defaultProvider.makeKey(String(input));
    }
    const s = String(input).trim();
    if (/^https?:\/\//i.test(s)) return null;
    const r = resolveInput(s);
    return r ? r.key : null;
}

function providerForKey(key) {
    const s = String(key);
    const i = s.indexOf(':');
    if (i === -1) return defaultProvider;
    const provider = byPrefix(s.slice(0, i));
    if (!provider) throw new Error(`Unknown source in gallery key: ${s}`);
    return provider;
}

function sourceOf(key) {
    try { return providerForKey(key).id; } catch (e) { return 'default'; }
}

function toPublicId(key) {
    const s = String(key);
    return /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : s;
}

function listSources() {
    return PROVIDERS.map(p => ({ id: p.id, label: p.label }));
}

module.exports = {
    PROVIDERS,
    defaultProvider,
    registerProvider,
    resolveInput,
    canonicalKey,
    providerForKey,
    sourceOf,
    toPublicId,
    listSources
};
```

- [ ] **Step 7: Jalankan tes, pastikan lulus**

Run: `node --test test/providers.test.js`
Expected: PASS (semua test hijau). Catatan: `'0468614'` menghasilkan kunci `468614` karena `Number('0468614')` = 468614; `'0'` dan `'-5'` ditolak.

- [ ] **Step 8: Commit**

```bash
git add core/providers test/providers.test.js
git commit -m "feat(providers): add provider registry and canonical gallery keys"
```

---

### Task 3: ID helper di lapisan DB, parser list bersama, field `source`

**Files:**
- Create: `core/db/listParser.js`
- Modify: `core/db/common.js:1-30,47-51` (`normalizeGalleryId`, `isValidGalleryId`, `formatQueueRow`), re-export `toPublicId`
- Modify: `core/db/sqlite.js:637-682`, `core/db/postgres.js:694-740` (hapus `parseListText` lokal, pakai bersama)
- Test: `test/multiSource.db.test.js` (dibuat di sini, diperluas di Task 4)

**Interfaces:**
- Consumes: Task 2 (`canonicalKey`, `resolveInput`, `toPublicId`, `sourceOf`, `defaultProvider`).
- Produces:
  - `common.normalizeGalleryId(v) -> string` (kunci kanonik; melempar `Invalid gallery_id: <v>` bila tidak valid)
  - `common.isValidGalleryId(v) -> boolean`
  - `common.toPublicId` (re-export)
  - `formatQueueRow(r)` menambah `source` dan mengeluarkan `galleryId: toPublicId(r.gallery_id)`
  - `listParser.parseListText(text, defaultFormat) -> { galleryId: number|string, url: string, title: string|null, batch: number, format: string|null }[]`
  - `listParser.parseListTextDetailed(text, defaultFormat) -> { items: (same shape as above)[], ignored: number }`
  - `common.publicRow(row) -> row` dengan `gallery_id` lewat `toPublicId` (dipakai Task 4 untuk baris mentah DB)

- [ ] **Step 1: Tulis tes yang gagal**

Buat `test/multiSource.db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const common = require('../core/db/common');
const { parseListText, parseListTextDetailed } = require('../core/db/listParser');

test('normalizeGalleryId returns canonical string keys and throws on junk', () => {
    assert.strictEqual(common.normalizeGalleryId(468614), '468614');
    assert.strictEqual(common.normalizeGalleryId('468614'), '468614');
    assert.strictEqual(common.normalizeGalleryId('xxx:539224'), 'xxx:539224');
    assert.throws(() => common.normalizeGalleryId('nope'), /Invalid gallery_id/);
    assert.throws(() => common.normalizeGalleryId(0), /Invalid gallery_id/);
    assert.strictEqual(common.isValidGalleryId('com:some-slug'), true);
    assert.strictEqual(common.isValidGalleryId('com:'), false);
});

test('formatQueueRow exposes toPublicId galleryId and derived source', () => {
    const legacy = common.formatQueueRow({ id: 1, gallery_id: '468614', url: 'u', status: 'PENDING' });
    assert.strictEqual(legacy.galleryId, 468614);
    assert.strictEqual(legacy.source, 'default');
    const prefixed = common.formatQueueRow({ id: 2, gallery_id: 'rox:817456', url: 'u', status: 'PENDING' });
    assert.strictEqual(prefixed.galleryId, 'rox:817456');
    assert.strictEqual(prefixed.source, 'rox');
});

test('parseListText: site B URL is not mistaken for a site A id (fallback regex ordering)', () => {
    const items = parseListText([
        'https://nhentai.xxx/g/539224/',
        'https://hentairox.com/gallery/817456/ | Some Title',
        'https://nhentai.com/en/comic/amys-country-wrangle-porn-comic',
        'https://nhentai.net/g/468614/',
        '123456',
        'com:another-slug'
    ].join('\n'));
    assert.deepStrictEqual(items.map(i => i.galleryId), [
        'xxx:539224', 'rox:817456', 'com:amys-country-wrangle-porn-comic', 468614, 123456, 'com:another-slug'
    ]);
    assert.strictEqual(items[1].title, 'Some Title');
    assert.strictEqual(items[0].url, 'https://nhentai.xxx/g/539224/');
});

test('parseListText: keeps batches/formats, dedupes, and counts ignored lines', () => {
    const { items, ignored } = parseListTextDetailed([
        '# BATCH 2 FORMAT=zip',
        'xxx:1',
        'xxx:1',
        'https://example.org/whatever',
        '# a comment',
        '999999'
    ].join('\n'), 'cbz');
    assert.deepStrictEqual(items.map(i => [i.galleryId, i.batch, i.format]), [['xxx:1', 2, 'zip'], [999999, 2, 'zip']]);
    assert.strictEqual(ignored, 1);
});

test('parseListText: legacy loose formats still work (id with trailing text, id anywhere via 5-7 digits)', () => {
    const items = parseListText('468614 | Title\nsee gallery 1234567 here');
    assert.deepStrictEqual(items.map(i => i.galleryId), [468614, 1234567]);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test test/multiSource.db.test.js`
Expected: FAIL (`Cannot find module '../core/db/listParser'`).

- [ ] **Step 3: Buat parser list bersama**

Buat `core/db/listParser.js`:

```js
const { resolveInput, defaultProvider, toPublicId } = require('../providers');

const LEGACY_PATTERNS = [
    /(?:(?:nhentai\.net|certain\.site)\/g\/|^)\s*(\d+)\b/i,
    /\b(\d{5,7})\b/
];

function resolveLine(head, line) {
    const direct = resolveInput(head);
    if (direct) return direct;
    // Legacy loose formats are site A only, and only for lines that do not look like a
    // URL of some other host (otherwise "https://other/g/539224/" would match \b\d{5,7}\b).
    if (/^https?:\/\//i.test(head)) return null;
    for (const re of LEGACY_PATTERNS) {
        const m = line.match(re);
        if (!m) continue;
        const key = defaultProvider.makeKey(m[1]);
        if (key) return { provider: defaultProvider, key, url: defaultProvider.buildUrl(key) };
    }
    return null;
}

function parseListTextDetailed(text, defaultFormat = null) {
    const lines = String(text || '').split(/\r?\n/);
    let currentBatch = 1;
    let currentFormat = defaultFormat;
    const items = [];
    const seen = new Set();
    let ignored = 0;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const batchMatch = line.match(/^#\s*BATCH\s+(\d+)(?:\s+FORMAT=(\w+))?/i);
        if (batchMatch) {
            currentBatch = parseInt(batchMatch[1], 10);
            currentFormat = batchMatch[2] ? batchMatch[2].toLowerCase() : defaultFormat;
            continue;
        }
        if (line.startsWith('#')) continue;

        const pipeIdx = line.indexOf('|');
        const head = (pipeIdx === -1 ? line : line.slice(0, pipeIdx)).trim();
        const resolved = resolveLine(head, line);
        if (!resolved) { ignored++; continue; }
        if (seen.has(resolved.key)) continue;
        seen.add(resolved.key);

        let title = null;
        if (pipeIdx !== -1) {
            const afterPipe = line.slice(pipeIdx + 1).trim();
            if (afterPipe) title = afterPipe;
        }

        items.push({
            galleryId: toPublicId(resolved.key),
            url: resolved.url,
            title,
            batch: currentBatch,
            format: currentFormat
        });
    }

    return { items, ignored };
}

function parseListText(text, defaultFormat = null) {
    return parseListTextDetailed(text, defaultFormat).items;
}

module.exports = { parseListText, parseListTextDetailed };
```

- [ ] **Step 4: Ganti `normalizeGalleryId`, `isValidGalleryId`, `formatQueueRow` di `core/db/common.js`**

Ganti bagian atas file (fungsi `normalizeGalleryId` dan `formatQueueRow`) dengan:

```js
const { canonicalKey, toPublicId, sourceOf } = require('../providers');

function normalizeGalleryId(galleryId) {
    const key = canonicalKey(galleryId);
    if (!key) {
        throw new Error(`Invalid gallery_id: ${galleryId}`);
    }
    return key;
}

function formatQueueRow(r) {
    if (!r) return null;
    const displayStatus = r.error ? `${r.status} - ${r.error}` : r.status;
    const displayUrl = r.title ? `${r.url} | ${r.title}` : r.url;
    return {
        id: r.id,
        galleryId: toPublicId(r.gallery_id),
        source: sourceOf(r.gallery_id),
        status: displayStatus,
        rawStatus: r.status,
        url: displayUrl,
        title: r.title,
        batch: r.batch || 1,
        priority: r.priority || 0,
        pagesDone: r.pages_done || 0,
        pagesTotal: r.pages_total || 0,
        error: r.error || null,
        retries: r.retries || 0,
        format: r.format || null,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
    };
}
```

Ganti `isValidGalleryId` menjadi:

```js
function isValidGalleryId(rawId) {
    return canonicalKey(rawId) !== null;
}
```

Tambahkan fungsi berikut tepat sesudah `formatQueueRow` (dipakai Task 4 agar baris mentah dari DB tetap memberi `gallery_id` number untuk site A, seperti sebelum migrasi):

```js
function publicRow(row) {
    return row ? { ...row, gallery_id: toPublicId(row.gallery_id) } : row;
}
```

Tambahkan `toPublicId` dan `publicRow` ke `module.exports` di akhir file.

- [ ] **Step 5: Pakai parser bersama di kedua adapter**

Di `core/db/sqlite.js` hapus fungsi `parseListText` (baris 637–682) dan tambahkan di bagian require atas:

```js
const { parseListText } = require('./listParser');
```

Lakukan hal yang sama di `core/db/postgres.js` (hapus fungsi `parseListText` di baris 694–740). Pastikan `parseListText` tetap ada di `module.exports` kedua adapter (nama sama, kini merujuk fungsi impor).

- [ ] **Step 6: Jalankan tes baru dan seluruh suite**

Run: `node --test test/multiSource.db.test.js`
Expected: PASS.

Run: `npm test`
Expected: Suite lama mungkin gagal di tempat yang membandingkan `gallery_id` dari DB (kini string setelah Task 4) — di Task ini DB belum diubah, jadi seluruh suite harus tetap PASS. Jika ada yang gagal, perbaiki sebelum lanjut.

- [ ] **Step 7: Commit**

```bash
git add core/db test/multiSource.db.test.js
git commit -m "feat(db): canonical string gallery keys, shared list parser, and derived source field"
```

---

### Task 4: Migrasi skema v3 dan adaptasi adapter DB

**Files:**
- Modify: `core/db/common.js:45` (`CURRENT_APP_SCHEMA_VERSION = 3`)
- Modify: `core/db/sqlite.js` (migrasi, penggantian `Number(...gallery_id)`, `logEvent`, `parseLibraryRow`, ID yang dikembalikan)
- Modify: `core/db/postgres.js` (migrasi, penggantian serupa, parser tipe)
- Test: `test/multiSource.db.test.js` (tambahan)

**Interfaces:**
- Consumes: Task 3 (`normalizeGalleryId`, `toPublicId`, `canonicalKey`).
- Produces: DB v3 dengan `queue.gallery_id`, `library.gallery_id` TEXT (SQLite: rebuild; PG: `ALTER ... TYPE TEXT`), `events.gallery_id` TEXT di PG. Fungsi adapter menerima ID angka atau berprefix dan mengembalikan ID lewat `toPublicId`.

- [ ] **Step 1: Tulis tes yang gagal**

Tambahkan di akhir `test/multiSource.db.test.js` (dan tambahkan `const fs = require('fs'); const os = require('os'); const path = require('path'); process.env.NHDL_LEGACY_CONFIG = ''; const dbMod = require('../core/db');` di bagian atas file, sebelum `const common`):

```js
async function createTempDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-ms-test-'));
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

test('queue accepts prefixed keys and keeps legacy numeric ids numeric on output', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.enqueueGallery({ galleryId: 468614, url: 'https://nhentai.net/g/468614/' }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 'xxx:539224', url: 'https://nhentai.xxx/g/539224/' }, ctx.db);
        await dbMod.enqueueGallery({ galleryId: 'com:amys-country-wrangle-porn-comic', url: 'https://nhentai.com/en/comic/amys-country-wrangle-porn-comic' }, ctx.db);

        const rows = await dbMod.getQueueItems({}, ctx.db);
        assert.deepStrictEqual(rows.map(r => r.gallery_id), [468614, 'xxx:539224', 'com:amys-country-wrangle-porn-comic']);
        assert.deepStrictEqual(rows.map(r => common.formatQueueRow(r).source), ['default', 'xxx', 'com']);

        const one = await dbMod.getQueueItem('xxx:539224', ctx.db);
        assert.strictEqual(one.gallery_id, 'xxx:539224');
        const legacy = await dbMod.getQueueItem('468614', ctx.db);
        assert.strictEqual(legacy.gallery_id, 468614);

        await assert.rejects(
            dbMod.enqueueGallery({ galleryId: 'xxx:539224', url: 'x' }, ctx.db),
            /UNIQUE constraint failed: queue\.gallery_id/i
        );
    } finally {
        await ctx.cleanup();
    }
});

test('priority reorder, bulk pause/resume/delete work for prefixed keys (no NaN comparisons)', async () => {
    const ctx = await createTempDb();
    try {
        for (const id of ['xxx:1', 'rox:2', 'com:three', 4]) {
            await dbMod.enqueueGallery({ galleryId: id, url: `u/${id}` }, ctx.db);
        }
        const r1 = await dbMod.updateQueuePriority(['com:three'], 'top', ctx.db);
        assert.ok(r1.updated >= 1);
        const next = await dbMod.getNextPendingItem(ctx.db);
        assert.strictEqual(next.gallery_id, 'com:three');

        const paused = await dbMod.pauseQueueItems(['rox:2', 4, 'bogus'], ctx.db);
        assert.strictEqual(paused.paused, 2);
        const resumed = await dbMod.resumeQueueItems(['rox:2'], ctx.db);
        assert.deepStrictEqual(resumed.resumedIds, ['rox:2']);
        const del = await dbMod.deleteQueueItems(['xxx:1', 4], ctx.db);
        assert.strictEqual(del.deleted, 2);
        const left = await dbMod.getQueueItems({}, ctx.db);
        assert.deepStrictEqual(left.map(r => r.gallery_id).sort(), ['com:three', 'rox:2']);
    } finally {
        await ctx.cleanup();
    }
});

test('importListText replace keeps prefixed rows listed and removes the rest', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.importListText('xxx:1\nrox:2\n111111', { replace: false }, ctx.db);
        const summary = await dbMod.importListText('rox:2\ncom:new-one\nhttps://example.org/nope', { replace: true }, ctx.db);
        assert.strictEqual(summary.ignored, 1);
        assert.deepStrictEqual(summary.galleryIds, ['rox:2', 'com:new-one']);
        const rows = await dbMod.getQueueItems({}, ctx.db);
        assert.deepStrictEqual(rows.map(r => r.gallery_id).sort(), ['com:new-one', 'rox:2']);
    } finally {
        await ctx.cleanup();
    }
});

test('library upsert/get/delete with prefixed keys; ids come back through toPublicId', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.upsertLibraryEntry({ galleryId: 'rox:817456', title: 'T', path: ctx.tmpDir, pages: 51, format: 'folder', language: 'English', artist: 'A' }, ctx.db);
        await dbMod.upsertLibraryEntry({ galleryId: 468614, title: 'L', path: ctx.tmpDir, pages: 1, format: 'folder' }, ctx.db);
        const e = await dbMod.getLibraryEntry('rox:817456', ctx.db);
        assert.strictEqual(e.gallery_id, 'rox:817456');
        assert.strictEqual(e.id, 'rox:817456');
        const l = await dbMod.getLibraryEntry(468614, ctx.db);
        assert.strictEqual(l.gallery_id, 468614);
        assert.strictEqual(l.id, '468614');
        const all = await dbMod.getAllLibraryEntries(ctx.db);
        assert.strictEqual(all.length, 2);
        await dbMod.deleteLibraryEntry('rox:817456', ctx.db);
        assert.strictEqual(await dbMod.getLibraryEntry('rox:817456', ctx.db), null);
    } finally {
        await ctx.cleanup();
    }
});

test('events accept prefixed gallery ids and filter by them', async () => {
    const ctx = await createTempDb();
    try {
        await dbMod.logEvent({ level: 'info', galleryId: 'xxx:5', message: 'prefixed' }, ctx.db);
        await dbMod.logEvent({ level: 'info', galleryId: 5, message: 'numeric' }, ctx.db);
        const rows = await dbMod.getEvents({ galleryId: 'xxx:5' }, ctx.db);
        assert.deepStrictEqual(rows.map(r => r.message), ['prefixed']);
    } finally {
        await ctx.cleanup();
    }
});

test('migration v3 upgrades a v2 database in place: ids stay, order/priority kept, rerun is a no-op', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-mig-test-'));
    const dbPath = path.join(tmpDir, 'old.db');
    const old = new DatabaseSync(dbPath);
    old.exec(`
        CREATE TABLE queue (id INTEGER PRIMARY KEY, gallery_id INTEGER NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT,
            status TEXT NOT NULL DEFAULT 'PENDING', batch INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
            pages_done INTEGER NOT NULL DEFAULT 0, pages_total INTEGER NOT NULL DEFAULT 0, error TEXT,
            retries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')), format TEXT);
        CREATE INDEX idx_queue_status ON queue(status);
        CREATE INDEX idx_queue_batch ON queue(batch);
        CREATE TABLE library (gallery_id INTEGER PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL, pages INTEGER,
            format TEXT, language TEXT, artist TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')), meta TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), level TEXT NOT NULL,
            gallery_id INTEGER, message TEXT NOT NULL);
        CREATE INDEX idx_events_gallery ON events(gallery_id);
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version (version) VALUES (2);
        INSERT INTO queue (id, gallery_id, url, status, priority, batch) VALUES (7, 468614, 'https://nhentai.net/g/468614/', 'DONE', 3, 2);
        INSERT INTO queue (id, gallery_id, url, status, priority) VALUES (9, 123456, 'https://nhentai.net/g/123456/', 'PENDING', 5);
        INSERT INTO library (gallery_id, title, path, pages, format) VALUES (468614, 'Old', 'C:/x', 10, 'folder');
    `);
    old.close();

    try {
        const db = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
        assert.strictEqual(await dbMod.getSchemaVersion(db), 3);

        const cols = Object.fromEntries(db.prepare(`PRAGMA table_info(queue)`).all().map(c => [c.name, c.type]));
        assert.strictEqual(cols.gallery_id, 'TEXT');
        assert.strictEqual(db.prepare(`PRAGMA table_info(library)`).all().find(c => c.name === 'gallery_id').type, 'TEXT');

        const rows = await dbMod.getQueueItems({}, db);
        const byGid = Object.fromEntries(rows.map(r => [r.gallery_id, r]));
        assert.strictEqual(byGid[468614].id, 7);
        assert.strictEqual(byGid[468614].priority, 3);
        assert.strictEqual(byGid[468614].batch, 2);
        assert.strictEqual(byGid[123456].priority, 5);
        assert.strictEqual((await dbMod.getLibraryEntry(468614, db)).title, 'Old');

        const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='queue'`).all().map(r => r.name);
        assert.ok(idx.includes('idx_queue_status') && idx.includes('idx_queue_batch'));

        await dbMod.closeDb();
        const again = await dbMod.initDb(dbPath, { legacyConfigPath: path.join(tmpDir, 'none.json') });
        assert.strictEqual(await dbMod.getSchemaVersion(again), 3);
        assert.strictEqual((await dbMod.getQueueItems({}, again)).length, 2);
    } finally {
        await dbMod.closeDb();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test test/multiSource.db.test.js`
Expected: FAIL (versi skema masih 2, `gallery_id` masih INTEGER; kunci berprefix ditolak/`NaN`).

- [ ] **Step 3: Tambahkan migrasi v3 di SQLite**

Di `core/db/sqlite.js`, tambahkan elemen ke array `MIGRATIONS` (setelah versi 2):

```js
    ,{
        version: 3,
        up(db) {
            const queueType = db.prepare(`PRAGMA table_info(queue)`).all().find(c => c.name === 'gallery_id');
            if (queueType && String(queueType.type).toUpperCase() !== 'TEXT') {
                db.exec(`
                    ALTER TABLE queue RENAME TO queue_v2;
                    DROP INDEX IF EXISTS idx_queue_status;
                    DROP INDEX IF EXISTS idx_queue_batch;
                    CREATE TABLE queue (
                      id           INTEGER PRIMARY KEY,
                      gallery_id   TEXT    NOT NULL UNIQUE,
                      url          TEXT    NOT NULL,
                      title        TEXT,
                      status       TEXT    NOT NULL DEFAULT 'PENDING',
                      batch        INTEGER NOT NULL DEFAULT 1,
                      priority     INTEGER NOT NULL DEFAULT 0,
                      pages_done   INTEGER NOT NULL DEFAULT 0,
                      pages_total  INTEGER NOT NULL DEFAULT 0,
                      error        TEXT,
                      retries      INTEGER NOT NULL DEFAULT 0,
                      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                      format       TEXT
                    );
                    INSERT INTO queue (id, gallery_id, url, title, status, batch, priority, pages_done, pages_total, error, retries, created_at, updated_at, format)
                      SELECT id, CAST(gallery_id AS TEXT), url, title, status, batch, priority, pages_done, pages_total, error, retries, created_at, updated_at, format
                      FROM queue_v2;
                    DROP TABLE queue_v2;
                    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
                    CREATE INDEX IF NOT EXISTS idx_queue_batch  ON queue(batch);
                `);
            }

            const libType = db.prepare(`PRAGMA table_info(library)`).all().find(c => c.name === 'gallery_id');
            if (libType && String(libType.type).toUpperCase() !== 'TEXT') {
                db.exec(`
                    ALTER TABLE library RENAME TO library_v2;
                    CREATE TABLE library (
                      gallery_id   TEXT PRIMARY KEY,
                      title        TEXT NOT NULL,
                      path         TEXT NOT NULL,
                      pages        INTEGER,
                      format       TEXT,
                      language     TEXT,
                      artist       TEXT,
                      added_at     TEXT NOT NULL DEFAULT (datetime('now')),
                      meta         TEXT
                    );
                    INSERT INTO library (gallery_id, title, path, pages, format, language, artist, added_at, meta)
                      SELECT CAST(gallery_id AS TEXT), title, path, pages, format, language, artist, added_at, meta
                      FROM library_v2;
                    DROP TABLE library_v2;
                `);
            }
            // events.gallery_id keeps INTEGER affinity on purpose: SQLite stores non-numeric
            // text (prefixed keys) as TEXT in such a column, and numeric keys stay INTEGER.
        }
    }
```

(Letakkan koma dengan benar; elemen sebelumnya berakhir `}` lalu `,` di depan elemen baru sudah ditulis di atas.) Catatan: `ALTER TABLE ... RENAME` pada SQLite modern ikut memindahkan indeks bernama lama ke tabel yang di-rename, itulah sebabnya indeks lama di-`DROP` sebelum tabel baru dibuat.

- [ ] **Step 4: Naikkan versi skema aplikasi**

Di `core/db/common.js` ubah `const CURRENT_APP_SCHEMA_VERSION = 2;` menjadi `3`.

- [ ] **Step 5: Tambahkan migrasi v3 di PostgreSQL**

Di `core/db/postgres.js`, tambahkan elemen ke `MIGRATIONS` setelah versi 2:

```js
    ,{
        version: 3,
        async up(client) {
            await client.query(`
                ALTER TABLE queue   ALTER COLUMN gallery_id TYPE TEXT USING gallery_id::text;
                ALTER TABLE library ALTER COLUMN gallery_id TYPE TEXT USING gallery_id::text;
                ALTER TABLE events  ALTER COLUMN gallery_id TYPE TEXT USING gallery_id::text;
            `);
        }
    }
```

- [ ] **Step 6: Ganti perbandingan numerik di `core/db/sqlite.js`**

Terapkan aturan berikut di seluruh `core/db/sqlite.js` (cari dengan `grep -n "Number(.*gallery_id" core/db/sqlite.js`):

1. Perbandingan/keanggotaan himpunan: `targetSet.has(Number(X.gallery_id))` → `targetSet.has(String(X.gallery_id))`. Berlaku di `updateQueuePriority` (baris ±497, 513, 516, 524, 527, 537, 545, 567, 577), dan `keepSet.has(Number(r.gallery_id))` di `importListText` → `keepSet.has(String(r.gallery_id))`.
2. Nilai gallery id lokal yang dipakai sebagai argumen fungsi DB (`const gid = Number(selectedRows[i].gallery_id)` dan sejenisnya) → `const gid = String(...)`.
3. `importListText`: biarkan `const galleryIds = parsedItems.map(i => i.galleryId);` apa adanya (isinya sudah ID publik, dikembalikan di ringkasan), tetapi ganti `const keepSet = new Set(galleryIds);` menjadi `const keepSet = new Set(galleryIds.map(g => normalizeGalleryId(g)));` agar cocok dengan perbandingan `String(r.gallery_id)`. Tambahkan `ignored` ke ringkasan: ubah impor di bagian atas ke `const { parseListTextDetailed } = require('./listParser');`, ganti `const parsedItems = parseListText(text, defaultFormat);` di `importListText` dengan

```js
    const { items: parsedItems, ignored } = parseListTextDetailed(text, defaultFormat);
```

   dan ubah return akhir menjadi `return { added, updated, duplicates, ignored, galleryIds, total: parsedItems.length };`. (`parseListText` tetap di-export modul adapter lewat `const { parseListText, parseListTextDetailed } = require('./listParser');` — pakai satu baris impor yang memuat keduanya.)
8. Baris mentah antrean: bungkus hasil `getQueueItem`, `getNextPendingItem`, dan `getQueueItems` dengan `publicRow` dari `./common` (impor `publicRow`), mis. `return publicRow(active.prepare(...).get(id) || null);` dan `return active.prepare(sql).all(...params).map(publicRow);`. Dengan begitu `row.gallery_id` untuk site A tetap number (seperti sebelum migrasi), dan `engine.js` yang memakai `String(row.gallery_id)` tetap benar.
4. Daftar ID yang dikembalikan ke pemanggil (`stoppingIds`, `resumedIds`, `removedIds` di `deleteQueueBatch`/`clearCompletedQueue`): bungkus dengan `toPublicId(...)` — misalnya `stoppingIds.push(toPublicId(gid));` pada `pauseQueueItems` dan `deleteQueueItems`, `resumedIds.push(toPublicId(gid));`, dan `const removedIds = rows.map(r => toPublicId(r.gallery_id));`. Tambahkan `toPublicId` ke impor dari `./common`.
5. `parseLibraryRow`: ubah `gallery_id: row.gallery_id,` menjadi `gallery_id: toPublicId(row.gallery_id),` (field `id: String(row.gallery_id)` tetap).
6. `logEvent`: ganti

```js
    const gid = galleryId !== null && galleryId !== undefined && String(galleryId).trim() !== ''
        ? parseInt(String(galleryId), 10) || null
        : null;
```

   dengan

```js
    const gid = galleryId !== null && galleryId !== undefined && String(galleryId).trim() !== ''
        ? (canonicalKey(galleryId) || null)
        : null;
```

   dan tambahkan `const { canonicalKey } = require('../providers');` di bagian atas. Untuk kunci angka polos, SQLite mengonversi `'5'` ke INTEGER 5 karena afinitas kolom, jadi perilaku lama terjaga.
7. Pastikan `getEvents` tetap memakai `normalizeGalleryId(options.galleryId)` (sudah demikian).

- [ ] **Step 7: Terapkan aturan yang sama di `core/db/postgres.js`**

Gunakan aturan 1–7 di Step 6 pada `core/db/postgres.js` (grep `grep -n "Number(.*gallery_id" core/db/postgres.js`; baris ±555–632, 682, 760, 919, 1065, 1081, 1093, 1102). Perbedaan khusus PG:

- Hapus baris `pg.types.setTypeParser(20, v => parseInt(v, 10));`? **Jangan hapus**: kolom lain (`id BIGSERIAL`, hitungan) masih BIGINT dan baris-baris pemetaan `Number(r.id)` tetap bergantung padanya.
- Pemetaan baris: `gallery_id: Number(row.gallery_id)` (baris ±919, ±1081, ±1093) → `gallery_id: toPublicId(row.gallery_id)`; `gallery_id: r.gallery_id ? Number(r.gallery_id) : null` (±1065, ±1102) → `gallery_id: r.gallery_id ? toPublicId(r.gallery_id) : null`.
- `logEvent` di PG (baris ±1020): ganti `parseInt(String(galleryId), 10) || null` dengan `(canonicalKey(galleryId) || null)`; kolom events kini TEXT sehingga nilai dikirim sebagai string.

- [ ] **Step 8: Jalankan tes baru**

Run: `node --test test/multiSource.db.test.js`
Expected: PASS.

- [ ] **Step 9: Jalankan seluruh suite dan perbaiki regresi**

Run: `npm test`
Expected: PASS. Jika ada tes lama yang gagal karena perbandingan tipe, penyebabnya salah satu dari: (a) keluaran fungsi adapter yang belum dibungkus `toPublicId` (perbaiki di adapter, bukan di tes); (b) pemanggil di `core/tracker.js`/`core/engine.js` yang masih memakai `parseInt` (ditangani di Task 6 — jika gagal karena itu, catat dan lanjut ke Task 6 sebelum commit, jangan ubah tes). Suite PostgreSQL (`test/db.test.js` varian PG, bila `DATABASE_URL` diisi) harus dijalankan juga: `DATABASE_URL=<url uji> npm test`.

- [ ] **Step 10: Commit**

```bash
git add core/db test/multiSource.db.test.js
git commit -m "feat(db): schema v3 with TEXT gallery_id and prefixed-key aware adapters"
```

---

### Task 5: Pengambilan metadata dan URL gambar per provider

**Files:**
- Create: `core/providers/http.js`
- Modify: `core/providers/boards.js` (tambah `fetchMeta`, `imageHeaders`), `core/providers/slugapi.js` (idem), `core/providers/default.js` (tambah `imageHeaders`)
- Test: `test/providerFetch.test.js`

**Interfaces:**
- Consumes: Task 2 (bentuk provider).
- Produces:
  - `http.fetchText(url: string, headers?: object, timeoutMs?: number) -> Promise<{ status: number, body: string }>` (ikut redirect maks 3x).
  - `http.downloadToFile(url, destPath, headers?, onProgress?(received, total), timeoutMs?) -> Promise<void>`; menolak dengan `Error` ber-properti `statusCode` bila status bukan 200; menulis ke `<dest>.part` lalu rename.
  - `provider.imageHeaders() -> { 'User-Agent', Referer }`
  - `provider.fetchMeta(key, { fetchText }) -> Promise<Meta>` untuk site B dan C, dengan `Meta = { title, numPages, ext, pageExts, langStr, authorStr, extraMeta, pageUrls(n) -> { ext: string, url: string }[] }`.
  - Error 404: `Error` dengan `permanent = true` dan pesan diawali `404`.
  - Konstanta `PAGE_EXTS = ['webp', 'jpg', 'png', 'gif']` diekspor dari `boards.js`.

- [ ] **Step 1: Tulis tes yang gagal**

Buat `test/providerFetch.test.js`:

```js
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
        id: 712070, title: 'Amy\u2019s Country Wrangle porn comic', slug: 'amys-country-wrangle-porn-comic', pages: 2,
        description: 'Read it. Amy\u2019s Country Wrangle porn comic is a 2-page porn comic by Aarokira. Genres: A, B.',
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
    assert.strictEqual(meta.title, 'Amy\u2019s Country Wrangle');
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
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test test/providerFetch.test.js`
Expected: FAIL (`Cannot find module '../core/providers/http'`).

- [ ] **Step 3: Implementasi `core/providers/http.js`**

```js
const http = require('http');
const https = require('https');
const fs = require('fs');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function open(url, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, {
            headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', ...headers }
        }, resolve);
        req.setTimeout(timeoutMs, () => { req.destroy(new Error('Socket Timeout')); });
        req.on('error', reject);
    });
}

async function openFollowing(url, headers, timeoutMs, maxRedirects = 3) {
    let current = url;
    for (let i = 0; i <= maxRedirects; i++) {
        const res = await open(current, headers, timeoutMs);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            current = new URL(res.headers.location, current).toString();
            continue;
        }
        return res;
    }
    throw new Error('Too many redirects');
}

async function fetchText(url, headers = {}, timeoutMs = 20000) {
    const res = await openFollowing(url, headers, timeoutMs);
    const chunks = [];
    await new Promise((resolve, reject) => {
        res.on('data', c => chunks.push(c));
        res.on('end', resolve);
        res.on('error', reject);
    });
    return { status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') };
}

async function downloadToFile(url, destPath, headers = {}, onProgress = null, timeoutMs = 30000) {
    const res = await openFollowing(url, headers, timeoutMs);
    if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`Status Code: ${res.statusCode}`);
        err.statusCode = res.statusCode;
        throw err;
    }
    const total = parseInt(res.headers['content-length'], 10) || 0;
    let received = 0;
    if (onProgress) onProgress(0, total);
    const partPath = `${destPath}.part`;

    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(partPath);
        const fail = (err) => {
            out.destroy();
            try { fs.unlinkSync(partPath); } catch (e) {}
            reject(err);
        };
        res.on('data', chunk => {
            received += chunk.length;
            if (onProgress) onProgress(received, total);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('Connection aborted')));
        out.on('error', fail);
        out.on('finish', resolve);
        res.pipe(out);
    });

    fs.renameSync(partPath, destPath);
}

module.exports = { fetchText, downloadToFile, USER_AGENT };
```

- [ ] **Step 4: `imageHeaders` untuk provider default**

Di `core/providers/default.js` tambahkan properti ke objek yang diekspor:

```js
    imageHeaders: () => ({ Referer: 'https://nhentai.net/' })
```

- [ ] **Step 5: Lengkapi `core/providers/boards.js`**

Ganti seluruh isi file dengan:

```js
const PAGE_EXTS = ['webp', 'jpg', 'png', 'gif'];
const NON_LANGUAGE_FLAGS = new Set(['translated', 'rewritten', 'speechless', 'text-cleaned']);

function decodeEntities(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'");
}

function cleanTitle(raw) {
    const text = decodeEntities(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const stripped = text
        .replace(/^(?:\s*(?:\([^)]*\)|\[[^\]]*\]))+\s*/, '')
        .replace(/(?:\s*\[[^\]]*\])+\s*$/, '')
        .trim();
    return stripped || text;
}

function titleCaseSlug(slug) {
    return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function hiddenValue(html, name) {
    const m = html.match(new RegExp(`id="${name}"\\s+value="([^"]*)"`));
    return m ? m[1] : null;
}

function taxonomy(html, kind) {
    const out = [];
    const re = new RegExp(`href='/${kind}/([^'/]+)/'`, 'g');
    let m;
    while ((m = re.exec(html)) !== null) {
        if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
}

function createBoardsProvider(cfg) {
    const { id, label, origin, galleryPath, hosts, imageHost } = cfg;
    const hostPattern = hosts.map(h => h.replace(/\./g, '\\.')).join('|');

    function parseBody(body) {
        const s = String(body ?? '').trim();
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
    }

    function imageHeaders() {
        return { Referer: `${origin}/` };
    }

    function parseGallery(key, html) {
        const server = hiddenValue(html, 'load_server');
        const dir = hiddenValue(html, 'load_dir');
        const loadId = hiddenValue(html, 'load_id');
        const pages = parseInt(hiddenValue(html, 'load_pages'), 10);
        if (!server || !dir || !loadId || !Number.isFinite(pages) || pages <= 0) {
            throw new Error('Gallery page is blocked or unexpected page layout (no page data found)');
        }

        const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        const title = h1 ? cleanTitle(h1[1]) : '';

        const artists = taxonomy(html, 'artist');
        const groups = taxonomy(html, 'group');
        const authorSlug = artists[0] || groups[0] || null;
        const languages = taxonomy(html, 'language').filter(l => !NON_LANGUAGE_FLAGS.has(l));
        const tags = taxonomy(html, 'tag').map(slug => ({ name: slug.replace(/-/g, ' ') }));
        const host = imageHost(server);

        return {
            title: title || `Gallery ${key.slice(id.length + 1)}`,
            numPages: pages,
            ext: PAGE_EXTS[0],
            pageExts: {},
            langStr: languages[0] ? titleCaseSlug(languages[0]) : 'Unknown',
            authorStr: authorSlug ? titleCaseSlug(authorSlug) : 'Other',
            extraMeta: { tags, source: id },
            pageUrls(n) {
                return PAGE_EXTS.map(ext => ({ ext, url: `https://${host}/${dir}/${loadId}/${n}.${ext}` }));
            }
        };
    }

    return {
        id,
        label,
        prefix: id,
        isDefault: false,
        origin,
        urlPatterns: [new RegExp(`^https?:\\/\\/(?:www\\.)?(?:${hostPattern})\\/${galleryPath}\\/(\\d+)`, 'i')],
        parseBody,
        makeKey(body) {
            const n = parseBody(body);
            return n ? `${id}:${n}` : null;
        },
        buildUrl(key) {
            return `${origin}/${galleryPath}/${key.slice(id.length + 1)}/`;
        },
        imageHeaders,
        async fetchMeta(key, { fetchText }) {
            const url = this.buildUrl(key);
            const res = await fetchText(url, imageHeaders());
            if (res.status === 404) {
                const e = new Error('404 - gallery not found / already removed');
                e.permanent = true;
                throw e;
            }
            if (res.status !== 200) throw new Error(`Gallery page returned status ${res.status}`);
            return parseGallery(key, res.body);
        },
        cfg
    };
}

module.exports = { createBoardsProvider, PAGE_EXTS };
```

- [ ] **Step 6: Lengkapi `core/providers/slugapi.js`**

Ganti seluruh isi file dengan:

```js
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function extOf(url) {
    const m = String(url).match(/\.(webp|jpe?g|png|gif)(?:\?|$)/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

function createSlugApiProvider(cfg) {
    const { id, label, origin, hosts } = cfg;
    const hostPattern = hosts.map(h => h.replace(/\./g, '\\.')).join('|');

    function parseBody(body) {
        const s = String(body ?? '').trim().toLowerCase();
        return SLUG.test(s) ? s : null;
    }

    function imageHeaders() {
        return { Referer: `${origin}/` };
    }

    return {
        id,
        label,
        prefix: id,
        isDefault: false,
        origin,
        urlPatterns: [new RegExp(`^https?:\\/\\/(?:www\\.)?(?:${hostPattern})\\/(?:[a-z]{2}\\/)?comic\\/([A-Za-z0-9-]+)`, 'i')],
        parseBody,
        makeKey(body) {
            const slug = parseBody(body);
            return slug ? `${id}:${slug}` : null;
        },
        buildUrl(key) {
            return `${origin}/en/comic/${key.slice(id.length + 1)}`;
        },
        imageHeaders,
        async fetchMeta(key, { fetchText }) {
            const slug = key.slice(id.length + 1);
            const res = await fetchText(`${origin}/api/comics/${slug}/images`, imageHeaders());
            if (res.status === 404) {
                const e = new Error('404 - comic not found / already removed');
                e.permanent = true;
                throw e;
            }
            if (res.status !== 200) throw new Error(`Comic API returned status ${res.status}`);

            let data;
            try { data = JSON.parse(res.body); } catch (e) { data = null; }
            if (!data || !data.comic || !Array.isArray(data.images) || data.images.length === 0) {
                throw new Error('Unexpected response from comic API (blocked page or changed format)');
            }

            const images = [...data.images].sort((a, b) => a.page - b.page);
            const pageExts = {};
            const urlsByPage = new Map();
            images.forEach((img, i) => {
                const n = i + 1;
                pageExts[n] = extOf(img.source_url);
                urlsByPage.set(n, img.source_url);
            });

            const rawTitle = String(data.comic.title || '').replace(/\s+porn comic$/i, '').trim();
            const authorMatch = String(data.comic.description || '').match(/\bporn comic by ([^.]+?)\./i);
            const tags = (data.comic.tags || []).map(t => ({ name: t.slug }));

            return {
                title: rawTitle || slug,
                numPages: images.length,
                ext: pageExts[1],
                pageExts,
                langStr: 'English',
                authorStr: authorMatch ? authorMatch[1].trim() : 'Other',
                extraMeta: { tags, source: id, uploadDate: data.comic.uploaded_at || null },
                pageUrls(n) {
                    const url = urlsByPage.get(n);
                    return url ? [{ ext: pageExts[n], url }] : [];
                }
            };
        },
        cfg
    };
}

module.exports = { createSlugApiProvider };
```

- [ ] **Step 7: Jalankan tes**

Run: `node --test test/providerFetch.test.js test/providers.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add core/providers test/providerFetch.test.js
git commit -m "feat(providers): fetch metadata and page URLs for the board-style and slug-API sources"
```

---

### Task 6: Integrasi engine, tracker, dan server

**Files:**
- Modify: `core/engine.js` (impor; `stopGallery`/`cancelStopGallery`/`isGalleryStopping`/`isGalleryDeleting`/`clearGalleryStopFlags` baris 88–118; `processGallery` baris 602–976; metode baru `fetchProviderMetadata`, `downloadProviderPage`)
- Modify: `core/tracker.js:224-225,275-276` (rescan)
- Modify: `server/index.js:452-453,514-515` (`activeGalleryId`), `server/index.js:367-383` (`/api/library` + `source`), handler `GET /api/config` (field `sources`), handler `/api/queue` (field `ignored` sudah dari ringkasan `importListText`)
- Test: `test/multiSource.engine.test.js`

**Interfaces:**
- Consumes: Task 2 (`providerForKey`, `registerProvider`, `toPublicId`, `canonicalKey`, `sourceOf`, `listSources`), Task 5 (`fetchText`, `downloadToFile`, `provider.fetchMeta`, `provider.imageHeaders`, `meta.pageUrls`, `PAGE_EXTS`).
- Produces: `engine.processGallery(key)` bekerja untuk kunci berprefix; `engine.downloadProviderPage(provider, candidates, folderPath, page, onProgress) -> Promise<{ path, ext }>`; `engine.fetchProviderMetadata(provider, key) -> Promise<Meta>`; `safeKeyName(key) -> string` (lokal di `engine.js`: ganti karakter di luar `[A-Za-z0-9._-]` dengan `_`).

- [ ] **Step 1: Tulis tes yang gagal**

Buat `test/multiSource.engine.test.js`:

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

// A JPEG/WEBP-looking payload larger than verifyImage's 2KB floor. verifyImage only checks size and
// a plausible header, so a RIFF/WEBP header + padding is enough.
function fakeWebp(size = 4096) {
    const b = Buffer.alloc(size, 1);
    b.write('RIFF', 0); b.writeUInt32LE(size - 8, 4); b.write('WEBP', 8); b.write('VP8 ', 12);
    return b;
}

const GALLERY_HTML = (pages) => `<html><body>
<h1>[Tester] Local Gallery</h1>
<a href='/artist/tester/'></a><a href='/language/english/'></a><a href='/tag/one/'></a>
<input type="hidden" id="load_server" value="1" /><input type="hidden" id="load_dir" value="001" />
<input type="hidden" id="load_id" value="abcd" /><input type="hidden" id="load_pages" value="${pages}" />
</body></html>`;

async function startSite({ pages = 3, jpgPages = [2], missingPages = [] } = {}) {
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push(req.url);
        if (req.url === '/g/777/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(GALLERY_HTML(pages)); }
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

async function setup(site) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-eng-test-'));
    const db = await dbMod.initDb(path.join(tmpDir, 't.db'), { legacyConfigPath: path.join(tmpDir, 'none.json') });
    const downloadDir = path.join(tmpDir, 'Download');
    fs.mkdirSync(downloadDir, { recursive: true });
    providers.registerProvider(createBoardsProvider({
        id: 'xxx', label: 'test-b1', origin: site.origin, hosts: ['127.0.0.1'], galleryPath: 'g',
        imageHost: () => `127.0.0.1:${site.server.address().port}`,
        imageBase: (host, dir, id, n, ext) => `${site.origin}/img/${dir}/${id}/${n}.${ext}`
    }));
    const engine = new DownloaderEngine({ baseDownloadDir: downloadDir, downloadFormat: 'folder', skipStartupJitter: true });
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
    const site = await startSite({ pages: 1, jpgPages: [] });
    const ctx = await setup(site);
    try {
        await dbMod.enqueueGallery({ galleryId: 'xxx:777', url: `${site.origin}/g/777/` }, ctx.db);
        await ctx.engine.processGallery('xxx:777');
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => [e.name, ...(e.isDirectory() ? walk(path.join(d, e.name)) : [])]);
        assert.ok(!walk(ctx.downloadDir).some(n => n.includes(':')), 'no path segment contains a colon');
    } finally {
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
```

Catatan untuk implementer: tes memakai opsi `imageBase` pada `createBoardsProvider` agar URL gambar menunjuk server lokal HTTP. Tambahkan dukungan opsi itu di Step 3 (di bawah) — **opsi opsional ini murni agar provider dapat diuji; bila `imageBase` tidak diberikan, perilaku produksi tidak berubah**.

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test test/multiSource.engine.test.js`
Expected: FAIL (`engine.downloadProviderPage is not a function` dan sejenisnya).

- [ ] **Step 3: Dukungan `imageBase` opsional di provider site B**

Di `core/providers/boards.js`, ubah destrukturisasi `const { id, label, origin, galleryPath, hosts, imageHost } = cfg;` menjadi `const { id, label, origin, galleryPath, hosts, imageHost, imageBase } = cfg;` dan ganti isi `pageUrls(n)` di `parseGallery` dengan:

```js
            pageUrls(n) {
                return PAGE_EXTS.map(ext => ({
                    ext,
                    url: imageBase
                        ? imageBase(host, dir, loadId, n, ext)
                        : `https://${host}/${dir}/${loadId}/${n}.${ext}`
                }));
            }
```

Juga, `buildUrl` memakai `origin` (HTTP lokal di tes) sehingga `fetchMeta` memanggil server uji; tidak ada perubahan lain.

- [ ] **Step 4: Stop-flag berbasis string di `core/engine.js`**

Ganti baris 88–118 (lima metode stop-flag) dengan:

```js
    stopGallery(galleryId, options = {}) {
        const gid = String(galleryId);
        this.stoppingGalleries.add(gid);
        if (options.deleteAfter) {
            this.deletingGalleries.add(gid);
        }
    }

    cancelStopGallery(galleryId) {
        const gid = String(galleryId);
        this.stoppingGalleries.delete(gid);
        this.deletingGalleries.delete(gid);
    }

    isGalleryStopping(galleryId) {
        return this.stoppingGalleries.has(String(galleryId));
    }

    isGalleryDeleting(galleryId) {
        return this.deletingGalleries.has(String(galleryId));
    }

    clearGalleryStopFlags(galleryId) {
        const gid = String(galleryId);
        this.stoppingGalleries.delete(gid);
        this.deletingGalleries.delete(gid);
    }
```

Di `processGallery` ganti `const gid = parseInt(String(galleryId), 10);` (baris 603) dengan `const gid = String(galleryId);` dan `this.emit('gallery_stopped', { galleryId: gid, ...` (baris ±850) dengan `this.emit('gallery_stopped', { galleryId: toPublicId(gid), ...`.

- [ ] **Step 5: Impor dan helper di bagian atas `core/engine.js`**

Setelah baris `const { fetchGalleryMetadata, requestDownloadUrl, downloadArchiveFile } = require('./nhentaiApi');` tambahkan:

```js
const providers = require('./providers');
const { toPublicId } = providers;
const { fetchText, downloadToFile } = require('./providers/http');
const { PAGE_EXTS } = require('./providers/boards');

// Gallery keys can contain ":" (invalid in Windows paths); never use them raw as folder names.
function safeKeyName(key) {
    return String(key).replace(/[^A-Za-z0-9._-]+/g, '_');
}
```

- [ ] **Step 6: Metode baru di kelas `DownloaderEngine`**

Tambahkan dua metode tepat sebelum `async tryApiArchiveDownload(...)`:

```js
    async fetchProviderMetadata(provider, galleryId) {
        const meta = await provider.fetchMeta(String(galleryId), { fetchText });
        return meta;
    }

    // Tries each candidate URL for a page in order. A 404 means "wrong extension" and moves on to
    // the next candidate; any other failure is a real error and bubbles up so the normal per-page
    // retry/backoff handles it. When every candidate 404s, the last 404 is thrown.
    async downloadProviderPage(provider, candidates, folderPath, page, onProgress) {
        let lastErr = null;
        for (const candidate of candidates) {
            const dest = path.join(folderPath, `${page}.${candidate.ext}`);
            try {
                await downloadToFile(candidate.url, dest, provider.imageHeaders(), onProgress);
                return { path: dest, ext: candidate.ext };
            } catch (err) {
                if (err.statusCode === 404) { lastErr = err; continue; }
                throw err;
            }
        }
        throw lastErr || new Error(`No candidate URL for page ${page}`);
    }
```

- [ ] **Step 7: Metadata lewat provider di `processGallery`**

Ganti baris 642 (`const meta = await this.fetchMetadata(galleryId);`) dengan:

```js
            const provider = providers.providerForKey(galleryId);
            const meta = provider.isDefault
                ? await this.fetchMetadata(galleryId)
                : await this.fetchProviderMetadata(provider, galleryId);
```

Ganti baris 675 dan 676 (destrukturisasi `meta` dan `extFor`) dengan:

```js
            const { title, mediaId, numPages, pageExts, langStr, authorStr, extraMeta } = meta;
            let ext = meta.ext;
            const extFor = (page) => pageExts[page] || ext;
```

Ganti baris 679 (`const sanitizedTitle = sanitizeName(title) || galleryId;`) dengan:

```js
            const sanitizedTitle = sanitizeName(title) || safeKeyName(galleryId);
```

Ganti kondisi API-archive (baris 716) `if (apiKey && (targetFormat === 'cbz' ...` dengan `if (provider.isDefault && apiKey && (targetFormat === 'cbz' || targetFormat === 'zip') && !this.isGalleryStopping(gid)) {` (sisa blok tidak berubah).

Ganti baris 733 (`folderPath = path.join(parentDir, galleryId.toString());`) dengan:

```js
                        folderPath = path.join(parentDir, safeKeyName(galleryId));
```

- [ ] **Step 8: Cek halaman yang sudah ada (resume) untuk provider non-default**

Ganti loop baris 745–753 dengan:

```js
            for (let j = 1; j <= numPages; j++) {
                let checkPath = path.join(folderPath, `${j}.${extFor(j)}`);
                if (!provider.isDefault && !verifyImage(checkPath)) {
                    const hit = PAGE_EXTS.find(e => verifyImage(path.join(folderPath, `${j}.${e}`)));
                    if (hit) {
                        pageExts[j] = hit;
                        checkPath = path.join(folderPath, `${j}.${hit}`);
                    }
                }
                if (verifyImage(checkPath)) {
                    completed++;
                } else {
                    if (fs.existsSync(checkPath)) fs.unlinkSync(checkPath);
                    pendingPages.push(j);
                }
            }
```

- [ ] **Step 9: Unduh halaman lewat provider**

Ganti baris 872–876 (`const currentPage = pendingPages.shift();` sampai `const imageUrl = ...`) dengan:

```js
                        const currentPage = pendingPages.shift();
                        const pageExt = extFor(currentPage);
                        let destPath = path.join(folderPath, `${currentPage}.${pageExt}`);
                        const dynamicHost = this.getRandomImageHost();
                        const candidates = provider.isDefault ? null : meta.pageUrls(currentPage);
                        const imageUrl = provider.isDefault
                            ? `https://${dynamicHost}/galleries/${mediaId}/${currentPage}.${pageExt}`
                            : (candidates[0] ? candidates[0].url : `${provider.origin}/page/${currentPage}`);
```

Ganti baris 891–897 (`sleep(startDelay)` sampai `.then(async () => {`) dengan:

```js
                        const onPageProgress = (received, total) => {
                            pageEntry.bytesReceived = received;
                            pageEntry.totalBytes = total;
                            lastByteAt = Date.now();
                        };
                        sleep(startDelay)
                            .then(() => {
                                if (provider.isDefault) {
                                    return this.downloadImage(imageUrl, destPath, dynamicHost, onPageProgress);
                                }
                                return this.downloadProviderPage(provider, candidates, folderPath, currentPage, onPageProgress)
                                    .then((saved) => {
                                        destPath = saved.path;
                                        pageExts[currentPage] = saved.ext;
                                        if (currentPage === 1) ext = saved.ext;
                                    });
                            })
                            .then(async () => {
```

(Seluruh blok `.then(async () => {` setelahnya, termasuk `verifyImage(destPath)`, tidak diubah — `destPath` kini `let` dan sudah menunjuk file hasil unduhan.)

- [ ] **Step 10: Rescan marker di `core/tracker.js`**

Tambahkan di bagian atas `core/tracker.js` (bersama require lain): `const { canonicalKey } = require('./providers');`. Di dua tempat (baris ±224–225 dan ±275–276) ganti:

```js
                const id = parseInt(rawId, 10);
                if (Number.isFinite(id) && id > 0) {
```

dengan:

```js
                const id = canonicalKey(rawId);
                if (id) {
```

- [ ] **Step 11: Server**

Di `server/index.js`:

1. Pada dua tempat (baris ±452 dan ±514) ganti

```js
                            const gid = parseInt(String(id), 10);
                            if (Number.isFinite(gid) && engine.activeGalleryId === gid) {
```

dengan

```js
                            const gid = String(id);
                            if (engine.activeGalleryId === gid) {
```

2. Di handler `GET /api/library` (baris ±370) tambahkan field ke objek hasil `map`: `source: sourceOf(data.gallery_id),` dan impor di bagian atas file: `const { sourceOf, listSources } = require('../core/providers');`.
3. Di handler `GET /api/config` (baris ±597) tambahkan `sources: listSources(),` ke objek JSON yang di-return.

- [ ] **Step 12: Jalankan tes**

Run: `node --test test/multiSource.engine.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS (seluruh suite, termasuk db.test.js/sse.test.js). Jika ada tes SSE/API yang mengasumsikan `galleryId` number untuk item site A, itu tetap number lewat `toPublicId`.

- [ ] **Step 13: Commit**

```bash
git add core server test/multiSource.engine.test.js
git commit -m "feat(engine): download prefixed galleries through providers; string-safe stop flags, rescan, and server hooks"
```

---

### Task 7: UI — badge sumber dan filter kategori

**Files:**
- Create: `webui/src/lib/sources.js`, `test/webuiSources.test.js`
- Modify: `webui/src/lib/stores/app.svelte.js` (`extractGalleryId`, `parseItemUrl`, `rankById`, `filterCounts`, `filteredAndSortedItems`, state `sourceFilter`/`sources`, `setSourceFilter`, pemuatan `sources` dari config)
- Modify: `webui/src/lib/components/QueueItem.svelte`, `SidebarFilter.svelte`, `LibraryModal.svelte`

**Interfaces:**
- Consumes: respons API Task 1/6 (`item.source`, `LibraryItem.source`, `config.sources`).
- Produces (`webui/src/lib/sources.js`, ES module murni, tanpa rune):
  - `sourceOfKey(key) -> string`
  - `itemSource(item) -> string` (`item.source` bila ada, selain itu dari `item.galleryId ?? item.id`)
  - `matchesSourceFilter(item, filter) -> boolean`
  - `countBySource(items) -> Map<string, number>`
  - `sourceLabel(id, sources) -> string`
  - `shortKey(key) -> string` (bagian setelah `:` untuk kunci berprefix; kunci angka dikembalikan apa adanya)
  - `urlKey(rawUrl) -> string | null` (mengenali URL galeri keempat jenis situs → kunci berprefix/angka; dipakai `extractGalleryId`/`parseItemUrl`)

- [ ] **Step 1: Tulis tes yang gagal**

Buat `test/webuiSources.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

async function load() {
    return await import('../webui/src/lib/sources.js');
}

test('sourceOfKey / itemSource / shortKey', async () => {
    const s = await load();
    assert.strictEqual(s.sourceOfKey(468614), 'default');
    assert.strictEqual(s.sourceOfKey('xxx:539224'), 'xxx');
    assert.strictEqual(s.itemSource({ source: 'rox', galleryId: 1 }), 'rox');
    assert.strictEqual(s.itemSource({ galleryId: 'com:abc' }), 'com');
    assert.strictEqual(s.itemSource({ id: '77' }), 'default');
    assert.strictEqual(s.shortKey('com:amys-country'), 'amys-country');
    assert.strictEqual(s.shortKey(468614), '468614');
});

test('matchesSourceFilter and countBySource', async () => {
    const s = await load();
    const items = [{ galleryId: 1 }, { galleryId: 'xxx:1' }, { galleryId: 'xxx:2' }, { galleryId: 'com:z', source: 'com' }];
    assert.strictEqual(items.filter(i => s.matchesSourceFilter(i, 'all')).length, 4);
    assert.strictEqual(items.filter(i => s.matchesSourceFilter(i, null)).length, 4);
    assert.strictEqual(items.filter(i => s.matchesSourceFilter(i, 'xxx')).length, 2);
    const counts = s.countBySource(items);
    assert.deepStrictEqual([...counts.entries()].sort(), [['com', 1], ['default', 1], ['xxx', 2]]);
});

test('sourceLabel falls back to id', async () => {
    const s = await load();
    assert.strictEqual(s.sourceLabel('xxx', [{ id: 'xxx', label: 'Site' }]), 'Site');
    assert.strictEqual(s.sourceLabel('zzz', []), 'zzz');
});

test('urlKey recognises all four URL shapes and ids', async () => {
    const s = await load();
    assert.strictEqual(s.urlKey('https://nhentai.net/g/468614/'), '468614');
    assert.strictEqual(s.urlKey('https://nhentai.xxx/g/539224/'), 'xxx:539224');
    assert.strictEqual(s.urlKey('https://hentairox.com/gallery/817456/'), 'rox:817456');
    assert.strictEqual(s.urlKey('https://nhentai.com/en/comic/Some-Slug'), 'com:some-slug');
    assert.strictEqual(s.urlKey('xxx:5'), 'xxx:5');
    assert.strictEqual(s.urlKey('123456'), '123456');
    assert.strictEqual(s.urlKey('https://example.org/'), null);
});
```

- [ ] **Step 2: Jalankan tes, pastikan gagal**

Run: `node --test test/webuiSources.test.js`
Expected: FAIL (module tidak ditemukan).

- [ ] **Step 3: Implementasi `webui/src/lib/sources.js`**

```js
// Pure helpers shared by the queue/library UI. Prefixes mirror core/providers (kept in sync
// by test/webuiSources.test.js and the server-provided `sources` list for labels).
const KNOWN_PREFIXES = ['xxx', 'rox', 'com'];

export function sourceOfKey(key) {
  const s = String(key ?? '');
  const i = s.indexOf(':');
  if (i > 0 && KNOWN_PREFIXES.includes(s.slice(0, i))) return s.slice(0, i);
  return 'default';
}

export function itemSource(item) {
  if (!item) return 'default';
  if (item.source) return item.source;
  return sourceOfKey(item.galleryId ?? item.id);
}

export function matchesSourceFilter(item, filter) {
  if (!filter || filter === 'all') return true;
  return itemSource(item) === filter;
}

export function countBySource(items) {
  const counts = new Map();
  for (const item of items) {
    const id = itemSource(item);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

export function sourceLabel(id, sources) {
  const found = (sources || []).find((s) => s.id === id);
  return found ? found.label : id;
}

export function shortKey(key) {
  const s = String(key ?? '');
  const i = s.indexOf(':');
  return i > 0 ? s.slice(i + 1) : s;
}

export function urlKey(raw) {
  const s = String(raw ?? '').trim();
  let m = s.match(/^(xxx|rox|com):(.+)$/i);
  if (m) return `${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
  m = s.match(/^https?:\/\/(?:www\.)?nhentai\.xxx\/g\/(\d+)/i);
  if (m) return `xxx:${Number(m[1])}`;
  m = s.match(/^https?:\/\/(?:www\.)?hentairox\.com\/gallery\/(\d+)/i);
  if (m) return `rox:${Number(m[1])}`;
  m = s.match(/^https?:\/\/(?:www\.)?nhentai\.com\/(?:[a-z]{2}\/)?comic\/([A-Za-z0-9-]+)/i);
  if (m) return `com:${m[1].toLowerCase()}`;
  m = s.match(/^https?:\/\/(?:www\.)?(?:nhentai\.net|certain\.site)\/g\/(\d+)/i);
  if (m) return String(Number(m[1]));
  if (/^\d+$/.test(s)) return String(Number(s));
  return null;
}
```

- [ ] **Step 4: Jalankan tes**

Run: `node --test test/webuiSources.test.js`
Expected: PASS.

- [ ] **Step 5: Store — parsing URL dan perbaikan kunci `rankById`**

Di `webui/src/lib/stores/app.svelte.js` tambahkan impor di bagian atas: `import { urlKey, matchesSourceFilter, countBySource } from '../sources.js';`.

Ganti `extractGalleryId` (baris 28–36) dengan:

```js
export function extractGalleryId(str) {
  if (!str) return null;
  return urlKey(str);
}
```

Ganti `parseItemUrl` (baris 38–45) dengan:

```js
export function parseItemUrl(urlStr) {
  const parts = String(urlStr || '').split(' | ');
  const rawUrl = parts[0].trim();
  const title = parts.length > 1 ? parts.slice(1).join(' | ').trim() : null;
  const id = urlKey(rawUrl) || rawUrl;
  return { rawUrl, id, title };
}
```

Di `buildRawListFromMap` (baris 21) ganti fallback `https://nhentai.net/g/${row.galleryId}/` dengan `String(row.galleryId)` agar kunci berprefix tetap valid saat dibaca server (`String(row.url || '').split(' | ')[0].trim() || String(row.galleryId)`).

Di `rankById` ganti `map.set(Number(copy[i].galleryId), i + 1);` dengan `map.set(String(copy[i].galleryId), i + 1);` lalu cari semua pemakai `rankById` dengan `grep -rn "rankById" webui/src` dan ubah kunci pencarian dari `Number(...)` menjadi `String(...)` (mis. `ranks.get(Number(item.galleryId))` → `ranks.get(String(item.galleryId))`).

- [ ] **Step 6: Store — state, hitungan, dan filter sumber**

Tambahkan state di class store dekat `batchFilter` (baris 109):

```js
  sourceFilter = $state('all'); // 'all' | provider id
  sources = $state([]); // [{ id, label }] from GET /api/config
```

Tambahkan method dekat `setBatchFilter` (baris ±417):

```js
  setSourceFilter(id) {
    this.sourceFilter = this.sourceFilter === id ? 'all' : id;
  }
```

Di `filterCounts` (baris 151) tambahkan sebelum `return`: `const sourceCounts = countBySource(this.items);` dan ke objek yang di-return tambahkan:

```js
      sources: Array.from(sourceCounts.entries()).map(([id, count]) => ({ id, count }))
```

Di `filteredAndSortedItems` (baris ±213) tambahkan `const srcf = this.sourceFilter;` dan setelah baris `if (bf !== null && ...) continue;` tambahkan:

```js
      if (!matchesSourceFilter(item, srcf)) continue;
```

Cari fungsi yang memuat config dari server: `grep -n "fetchConfig\|getConfig\|downloadFormat =" webui/src/lib/stores/app.svelte.js webui/src/lib/api.js`. Pada kode yang menetapkan field config dari respons `/api/config` (tempat `this.downloadFormat` diisi), tambahkan satu baris `this.sources = Array.isArray(cfg.sources) ? cfg.sources : [];` (gunakan nama variabel respons yang dipakai di fungsi tersebut).

- [ ] **Step 7: Badge di `QueueItem.svelte`**

Di `<script>` tambahkan impor `import { itemSource, sourceLabel, shortKey } from '../sources.js';` dan di antara deklarasi `$derived`:

```js
  let src = $derived(itemSource(item));
  let srcLabel = $derived(sourceLabel(src, appStore.sources));
```

(`appStore` sudah diimpor di file ini; jika belum, tambahkan `import { appStore } from '../stores/app.svelte.js';`.) Pada baris 101 ganti `<span class="text-[#888] text-[10px] shrink-0">#{parsed.id}</span>` dengan:

```svelte
        {#if src !== 'default'}
          <span class="px-1 py-0.5 rounded text-[9px] font-mono uppercase bg-[#1e293b] text-[#7dd3fc] border border-[#334155] shrink-0" title={srcLabel}>{srcLabel}</span>
        {/if}
        <span class="text-[#888] text-[10px] shrink-0">#{shortKey(parsed.id)}</span>
```

- [ ] **Step 8: Filter kategori di `SidebarFilter.svelte`**

Tambahkan impor `import { sourceLabel } from '../sources.js';` dan `Globe` ke impor lucide (`Globe,`). Tambahkan di `<script>`:

```js
  const sourceItems = $derived(
    counts.sources.map((s) => ({ ...s, label: sourceLabel(s.id, appStore.sources) }))
  );
```

Sisipkan blok berikut di antara penutup `</div>` Status Filters (sebelum `<div class="h-px ...">` pertama, baris ±82) :

```svelte
  {#if sourceItems.length > 1}
    <div class="p-2 pt-0 flex flex-col gap-0.5">
      <div class="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold">
        Source
      </div>
      {#each sourceItems as s (s.id)}
        {@const active = appStore.sourceFilter === s.id}
        <button
          type="button"
          onclick={() => appStore.setSourceFilter(s.id)}
          class="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer {active
            ? 'bg-[var(--bg-selected-focus)] text-white font-semibold border border-[var(--accent)]/40'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white border border-transparent'}"
        >
          <div class="flex items-center gap-2 truncate">
            <Globe class="w-3.5 h-3.5 shrink-0 text-[#7dd3fc]" />
            <span class="truncate">{s.label}</span>
          </div>
          <span class="text-[11px] px-1.5 rounded font-mono {active ? 'bg-[var(--accent)] text-black font-bold' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'}">{s.count}</span>
        </button>
      {/each}
    </div>
  {/if}
```

- [ ] **Step 9: Badge dan filter di `LibraryModal.svelte`**

Tambahkan impor `import { itemSource, sourceLabel } from '../sources.js';`, state `let librarySource = $state('all');`, dan ubah `filteredLibrary` (baris 37–47) menjadi:

```js
  let filteredLibrary = $derived(
    libraryItems.filter(item => {
      if (librarySource !== 'all' && itemSource(item) !== librarySource) return false;
      if (!librarySearch.trim()) return true;
      const q = librarySearch.toLowerCase();
      return (
        item.id.toLowerCase().includes(q) ||
        item.title?.toLowerCase().includes(q) ||
        item.artist?.toLowerCase().includes(q)
      );
    })
  );

  let librarySourceOptions = $derived(
    Array.from(new Set(libraryItems.map(itemSource))).map(id => ({ id, label: sourceLabel(id, appStore.sources) }))
  );
```

Tepat setelah elemen `<input ... bind:value={librarySearch} ...>` (baris ±284) tambahkan:

```svelte
          {#if librarySourceOptions.length > 1}
            <select bind:value={librarySource} class="bg-[var(--bg-elevated)] text-xs font-mono text-white border border-[var(--border-subtle)] rounded px-2 py-1">
              <option value="all">All sources</option>
              {#each librarySourceOptions as opt (opt.id)}
                <option value={opt.id}>{opt.label}</option>
              {/each}
            </select>
          {/if}
```

Dan pada baris judul (baris ±435) ganti `<span class="text-white truncate" title={item.title}>{item.title}</span>` dengan:

```svelte
                    {#if itemSource(item) !== 'default'}
                      <span class="px-1 py-0.5 rounded text-[9px] font-mono uppercase bg-[#1e293b] text-[#7dd3fc] border border-[#334155] shrink-0">{sourceLabel(itemSource(item), appStore.sources)}</span>
                    {/if}
                    <span class="text-white truncate" title={item.title}>{item.title}</span>
```

- [ ] **Step 10: Build UI dan tes**

Run: `npm --prefix webui run build`
Expected: build sukses tanpa error Svelte/Vite.

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Verifikasi manual di dev server lokal**

Run (terminal terpisah): `npm start`, buka `http://localhost:8080`, tempel dua URL dari dua sumber berbeda lewat dialog Add, lalu pastikan: (a) badge sumber muncul pada baris antrean item non-default, (b) section "Source" muncul di sidebar saat ada ≥ 2 sumber, dan klik memfilter list, (c) Library Manager menampilkan badge dan dropdown sumber. Catat hasil di balasan.

- [ ] **Step 12: Commit**

```bash
git add webui test/webuiSources.test.js
git commit -m "feat(ui): show source badge and source filter in queue sidebar and library"
```

---

### Task 8: Tes langsung, dokumentasi, dan penutup

**Files:**
- Modify: `docs/CHANGELOG.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/AI_AGENT.md` (hanya jika membahas format ID/URL), `.gitignore` (tambah `samples/` setelah dikonfirmasi user)

**Interfaces:**
- Consumes: semua task sebelumnya.

- [ ] **Step 1: Tes langsung dengan server lokal (SQLite, jaringan yang bisa menjangkau situs)**

Pastikan DNS/VPN mesin tidak memblokir tiga domain. Jalankan di terminal terpisah: `NHDL_DB_PATH=./data/live-test.db DOWNLOAD_DIR=./samples/live PORT=8099 npm start`. Lalu:

```bash
curl -s -X POST http://localhost:8099/api/queue -H 'Content-Type: application/json' -d '{"text":"https://nhentai.xxx/g/539224/\nhttps://hentairox.com/gallery/817456/\nhttps://nhentai.com/en/comic/amys-country-wrangle-porn-comic","format":"folder"}'
```

Expected: `{"success":true,...,"galleryIds":["xxx:539224","rox:817456","com:amys-country-wrangle-porn-comic"],...}`. Tunggu hingga `GET /api/status` memperlihatkan ketiganya `DONE` (`curl -s http://localhost:8099/api/status`). Catatan: galeri `xxx:539224` berisi 240 halaman, sehingga unduhan penuh memakan waktu; boleh dihentikan setelah beberapa halaman via `POST /api/queue/pause` untuk uji resume, lalu `resume`.

- [ ] **Step 2: Verifikasi hasil tes langsung**

Run: `ls samples/live` dan hitung berkas per galeri; bandingkan dengan sampel manual di `samples/probe/out/` (hentairox 51 file, nhentai.com 17 file, nhentai.xxx sesuai halaman yang selesai). Pastikan: tidak ada berkas `.part`, tidak ada berkas < 2 KB selain placeholder yang tercatat di `placeholder_pages.log`, dan tidak ada nama folder berisi `:`. Hentikan server, hapus `data/live-test.db` dan `samples/live`.

- [ ] **Step 3: Perbarui dokumentasi**

- `docs/CHANGELOG.md`: tambah entri teratas dengan aktor `AI (Claude Code, Sonnet 5.5)` memuat: lapisan provider, kunci berprefix, migrasi skema v3, field `source`, badge/filter sumber.
- `docs/PLAN.md`: tambah fase/tugas "Multi-source download" dan centang `[x]` task yang selesai, isi tabel Log.
- `docs/ARCHITECTURE.md`: tambah bagian `core/providers/` pada struktur direktori dan jelaskan format kunci `gallery_id`, provider interface, dan `source`; perbaiki bagian yang menyebut `gallery_id` sebagai angka. Gunakan penamaan generik (site A/B1/B2/C).
- Periksa `docs/AI_AGENT.md` dengan `grep -n "gallery\|ID\|/g/" docs/AI_AGENT.md`; perbarui hanya bila ada pernyataan yang menjadi keliru.

- [ ] **Step 4: Ringkasan yang harus ditanyakan ke user**

Tanyakan apakah `samples/` boleh ditambahkan ke `.gitignore`; jika ya, tambahkan baris `samples/` dan sertakan di commit.

- [ ] **Step 5: Jalankan seluruh suite dan commit**

Run: `npm test`
Expected: PASS.

```bash
git add docs .gitignore
git commit -m "docs: record multi-source download in changelog, plan, and architecture"
```
