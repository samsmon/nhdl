# Content Type (Comic / Manga) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Galleries from site B1/B2/C are mapped from their site category to the `comic`/`manga`/`other` type, stored in a per-type folder, and the type is shown and filterable in the UI.

**Architecture:** The provider extracts the category slug; the pure module `core/providers/contentType.js` maps the slug to a type. The engine uses the type to choose the folder (`<base>/<Type>/<Language>/<Author>/<Title>`), stores the type in the new `queue.category` column (migration v4) and in the library `meta`. The UI reads `category` from the item and adds a badge + "Type" filter.

**Tech Stack:** Node >= 22.13 (`node:test`, `node:sqlite`), `pg`, Svelte 5 + Vite. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-content-type-design.md`

## Global Constraints

- No new runtime dependencies.
- Commit under the user's name (git config), WITHOUT a `Co-Authored-By` trailer or AI attribution. Run `npm test` before committing; do not commit if it fails. Do not `git add` `samples/` or `webui/dist`; do not touch `.gitignore`.
- Branch `rework`. The user's server on port 8080 and the `data/` folder must not be touched by tests/verification; use a temporary server on another port with the DB in an OS temp folder.
- Every new field/endpoint is written in `docs/API.md` first (Task 1).
- Documents write sites generically: site A (default), site B1/B2, site C; real names, domains, and prefixes only in code/tests.
- Content type: `ContentType = 'comic' | 'manga' | 'other'`; labels and folder names `Comic`, `Manga`, `Other`.
- Slug (lowercase) → type mapping: `western`, `porn-comic`, `comic` → `comic`; `manga`, `doujinshi` → `manga`; other valid slugs → `other`; empty/invalid → `null`. Valid slug: `^[a-z0-9][a-z0-9-]{0,40}$`.
- The type folder name comes only from the fixed label; a remote slug is never used as a folder name.
- Site A is unchanged: no type, old folder, `category` always `null`.
- The existing library is not moved automatically.
- `QueueItem.category` / `LibraryItem.category`: `"comic" | "manga" | "other" | null`.
- Svelte 5 runes only; gallery ids in the UI are always strings; the UI receives changes via SSE, no polling.

## Review Focus

1. A remote category slug containing odd/long/path characters (`../x`, `a/b`, 200 characters, empty): never becomes a folder name; the result is `null` (old layout) or `other`.
2. A gallery page without a category link, or a failed/403/timed-out/broken-JSON site C category request: the download still runs without a type (old layout), with a warning in the activity log; no error is thrown.
3. Migration v4 on a v3 DB with data: no rows lost, idempotent when re-run, `category` column nullable; export then import keeps `category`.
4. A gallery partly downloaded in the old layout and then reprocessed: no crash, no duplicate archives piling up in the new folder, the "already in library" check still works.
5. The `findExistingOnDisk` fallback (on 429) finds the gallery in the typed layout.
6. Items without `category` (site A, old items, items whose metadata has not been fetched) show no badge and are not counted in the type filter.
7. The type filter is combined (AND) with the status, source, batch, and search filters.

---

## File Structure

| File | Responsibility |
|---|---|
| `core/providers/contentType.js` (new) | `mapCategoryToType`, `normalizeCategorySlug`, `typeFolderName`, `isContentType`, `TYPE_LABELS` |
| `core/providers/boards.js`, `core/providers/slugapi.js` | Category slug extraction → `meta.category`, `meta.contentType` (+ `meta.categoryError` for site C) |
| `core/db/sqlite.js`, `core/db/postgres.js`, `core/db/common.js` | Migration v4, `category` in `updateQueueItem`/`formatQueueRow`/import-export |
| `core/engine.js` | Typed folder layout, store type in queue + library meta, typed `findExistingOnDisk` |
| `server/index.js` | `category` in `/api/library` |
| `webui/src/lib/contentType.js` (new) | Pure type helpers (badge, filter, count) |
| `webui/src/lib/stores/app.svelte.js`, `VirtualQueueTable.svelte`, `SidebarFilter.svelte`, `LibraryModal.svelte` | "Type" badge + filter |
| `test/contentType.test.js`, `test/providerCategory.test.js`, `test/contentType.db.test.js`, `test/contentType.engine.test.js`, `test/webuiContentType.test.js` (new) | Tests |

---

### Task 1: API contract documentation (docs-first) and spec correction

**Files:**
- Modify: `docs/API.md` (sections `QueueItem`, `LibraryItem`)
- Modify: `docs/superpowers/specs/2026-10-06-content-type-design.md` (one line in section 8)

**Interfaces:**
- Produces: the written contract `QueueItem.category`, `LibraryItem.category`, used by Tasks 3–5.

- [ ] **Step 1: Add `category` to the `QueueItem` example**

In `docs/API.md` section `### QueueItem`, add `"category": null` after the `"source": "default"` line in the JSON example, and add the following bullet after the `source` bullet:

```markdown
- `category`: content type `"comic" | "manga" | "other" | null`. Mapped from the category on the origin site (site B1/B2/C); `null` for site A, old items, and items whose metadata has not been fetched. Stored in the `queue` table (`category` column) and included in the SSE `item` event.
```

- [ ] **Step 2: Add `category` to `LibraryItem`**

Below table 3.5 (where the `LibraryItem.source` note is) add:

```markdown
`LibraryItem` also has a `category` field (the same value as `QueueItem.category`, read from the library `meta`; `null` if absent).
```

And in the section describing the storage layout (find it with `grep -n "Language\|<Author>" docs/API.md docs/ARCHITECTURE.md`; if it is not in API.md, doing it in ARCHITECTURE in Task 6 is enough) there are no other changes.

- [ ] **Step 3: Correct the spec**

In spec section 8 replace the sentence `shown when ≥ 2 types are present (same pattern as the "Source" section)` with `shown when at least 1 type is present (same as the "Source" section)`.

- [ ] **Step 4: Commit**

```bash
git add docs/API.md docs/superpowers/specs/2026-10-06-content-type-design.md
git commit -m "docs(api): document content type category on queue and library items"
```

---

### Task 2: Content type module and category extraction in providers

**Files:**
- Create: `core/providers/contentType.js`
- Modify: `core/providers/boards.js` (function `parseGallery`), `core/providers/slugapi.js` (`fetchMeta`)
- Test: `test/contentType.test.js`, `test/providerCategory.test.js`

**Interfaces:**
- Produces (`core/providers/contentType.js`):
  - `TYPE_LABELS: { comic: 'Comic', manga: 'Manga', other: 'Other' }`
  - `normalizeCategorySlug(raw) -> string | null`
  - `mapCategoryToType(raw) -> 'comic' | 'manga' | 'other' | null`
  - `typeFolderName(type) -> string | null`
  - `isContentType(v) -> boolean`
- Provider `fetchMeta` result gains `category: string | null` (normalized raw slug), `contentType: ContentType | null`, and (site C only) `categoryError: string | null`.

- [ ] **Step 1: Write the failing type module test**

Create `test/contentType.test.js`:

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

- [ ] **Step 2: Run, confirm it fails**

Run: `node --test test/contentType.test.js`
Expected: FAIL (`Cannot find module '../core/providers/contentType'`).

- [ ] **Step 3: Implement `core/providers/contentType.js`**

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

- [ ] **Step 4: Run the module tests, confirm they pass**

Run: `node --test test/contentType.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing provider category extraction test**

Create `test/providerCategory.test.js`:

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

- [ ] **Step 6: Run, confirm it fails**

Run: `node --test test/providerCategory.test.js`
Expected: FAIL (`meta.category` undefined).

- [ ] **Step 7: Implement in `core/providers/boards.js`**

Add the import at the top of the file: `const { normalizeCategorySlug, mapCategoryToType } = require('./contentType');`. Add a helper function near `taxonomy` (before `createBoardsProvider`):

```js
// The gallery's own category tag link is single-quoted, like the other taxonomy links;
// navigation links on the page use double quotes and must not be picked up.
function categorySlug(html) {
    const m = html.match(/href='\/category\/([^'/]+)\/'/);
    return m ? normalizeCategorySlug(m[1]) : null;
}
```

In `parseGallery`, right before `return {`, add `const category = categorySlug(html);` and add two properties to the returned object (after `extraMeta: { tags, source: id },`):

```js
            category,
            contentType: mapCategoryToType(category),
```

- [ ] **Step 8: Implement in `core/providers/slugapi.js`**

Add the import: `const { normalizeCategorySlug, mapCategoryToType } = require('./contentType');`. Add a helper above `createSlugApiProvider`:

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

In `fetchMeta`, after the `images.forEach(...)` block and before `const rawTitle`, add `const cat = await fetchCategory(origin, slug, fetchText, imageHeaders());` and add to the returned object (after `extraMeta: {...},`):

```js
                category: cat.category,
                contentType: mapCategoryToType(cat.category),
                categoryError: cat.error,
```

- [ ] **Step 9: Run all provider tests**

Run: `node --test test/contentType.test.js test/providerCategory.test.js test/providerFetch.test.js test/providers.test.js`
Expected: PASS. Note: the old site C test in `test/providerFetch.test.js` uses a `fetchText` stub that records the last URL (`requested = url`) and then asserts the `/images` URL; the extra category request overwrites that value. Change ONLY that stub so it records the first URL (`if (!requested) requested = url;`) and leave its assertions; the stub response for the category request has no category, so `categoryError` is set and `contentType` is `null`, which is non-fatal by design. Do not weaken other tests.

- [ ] **Step 10: Commit**

```bash
git add core/providers test/contentType.test.js test/providerCategory.test.js
git commit -m "feat(providers): map site categories to comic/manga/other content types"
```

---

### Task 3: Migration v4 and the `category` column in queue

**Files:**
- Modify: `core/db/common.js` (`CURRENT_APP_SCHEMA_VERSION = 4`, `formatQueueRow`), `core/db/sqlite.js` (MIGRATIONS, `updateQueueItem`, `importData`), `core/db/postgres.js` (same)
- Test: `test/contentType.db.test.js`; update `test/db.test.js` (migration count/schema version)

**Interfaces:**
- Consumes: Task 2 (`isContentType`).
- Produces: `updateQueueItem(id, { category: 'comic'|'manga'|'other'|null })`; `formatQueueRow(row).category: string|null`; export/import keeps `category`.

- [ ] **Step 1: Write the failing test**

Create `test/contentType.db.test.js` (same helper pattern as `test/multiSource.db.test.js`):

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

- [ ] **Step 2: Run, confirm it fails**

Run: `node --test test/contentType.db.test.js`
Expected: FAIL (`category` missing; schema version 3).

- [ ] **Step 3: Migration in SQLite**

In `core/db/sqlite.js`, add an element to `MIGRATIONS` after version 3:

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

- [ ] **Step 4: Migration in PostgreSQL**

In `core/db/postgres.js`, add an element to `MIGRATIONS` after version 3:

```js
    ,{
        version: 4,
        async up(client) {
            await client.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS category TEXT;`);
        }
    }
```

- [ ] **Step 5: App version, `formatQueueRow`, `updateQueueItem`**

- `core/db/common.js`: change `const CURRENT_APP_SCHEMA_VERSION = 3;` to `4`, and add `category: r.category || null,` to the object returned by `formatQueueRow` (after `format: r.format || null,`).
- `core/db/sqlite.js` and `core/db/postgres.js`: in the `map` object in `updateQueueItem` add `category: 'category'` (after `format: 'format'`). Note: the `fields[key] !== undefined` condition already allows `null` to clear the value.

- [ ] **Step 6: Export/import keeps `category`**

In both adapters, find the queue insert in `importData` (`grep -n "INSERT INTO queue" core/db/sqlite.js core/db/postgres.js`). Add the `category` column to the column list and values (`const category = isContentType(r.category) ? r.category : null;` in the same loop; import `isContentType` from `../providers/contentType`), including in the update/`ON CONFLICT` clause if there is one. `exportData` uses `SELECT *` so the new column is included automatically (check that there is no explicit column list; if there is, add `category`).

- [ ] **Step 7: Update old tests that assume version 3**

Run `grep -n "schema_version\|getSchemaVersion\|version, 3\|=== 3\|, 3)" test/*.js` and change only the schema version numbers/migration counts that depend on the number of migrations (3 → 4) in `test/db.test.js` (and other tests if any). Do not change other assertions.

- [ ] **Step 8: Run the tests**

Run: `node --test test/contentType.db.test.js test/db.test.js test/multiSource.db.test.js`
Expected: PASS. Then `npm test` once (large timeout): PASS. (The PostgreSQL suite cannot run without `DATABASE_URL`; match the PG logic to SQLite by reading carefully.)

- [ ] **Step 9: Commit**

```bash
git add core/db test/contentType.db.test.js test/db.test.js
git commit -m "feat(db): schema v4 adds queue.category and carries it through export/import"
```

---

### Task 4: Engine — typed folder, type storage, library, and server

**Files:**
- Modify: `core/engine.js` (imports; `findExistingOnDisk`; `processGallery`), `server/index.js` (`GET /api/library`)
- Test: `test/contentType.engine.test.js`

**Interfaces:**
- Consumes: Task 2 (`typeFolderName`, `isContentType`, `meta.contentType`, `meta.category`, `meta.categoryError`), Task 3 (`updateQueueItem(..., { category })`).
- Produces: non-default galleries with a type are stored in `<base>/<Type>/<Language>/<Author>/<Title>`; `queue.category` is filled; library `meta.contentType` + `meta.category` are filled; `/api/library` items have `category`.

- [ ] **Step 1: Write the failing test**

Create `test/contentType.engine.test.js` based on the pattern in `test/multiSource.engine.test.js` (read that file first; reuse the `startSite`/`setup` style, but copy the needed helpers into the new file so the test is self-contained):

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

- [ ] **Step 2: Run, confirm it fails**

Run: `node --test test/contentType.engine.test.js`
Expected: FAIL (no typed folder, `lib.meta.contentType` undefined, `findExistingOnDisk` finds nothing).

- [ ] **Step 3: Imports in `core/engine.js`**

After the line `const { PAGE_EXTS } = require('./providers/boards');` add:

```js
const { typeFolderName, isContentType, TYPE_LABELS } = require('./providers/contentType');
```

- [ ] **Step 4: `findExistingOnDisk` walks the typed layout**

In `findExistingOnDisk(cachedTitle, cachedAuthor)` (which currently reads `langDirs` from `this.baseDownloadDir`), wrap the existing traversal in a loop over roots: the first root is `this.baseDownloadDir`, then each existing type folder (`Object.values(TYPE_LABELS)` → `path.join(this.baseDownloadDir, label)`, only if it is a directory). Replace every use of `this.baseDownloadDir` inside the language/author traversal (e.g. `fs.readdirSync(this.baseDownloadDir, ...)`, `path.join(this.baseDownloadDir, langDir.name)`) with the `root` variable. Resulting skeleton:

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
            // ... body of the old loop, with `root` replacing `this.baseDownloadDir`
        }
        return null;
```

Keep the existing matching logic exactly (match title/author, archive then folder). Note: at the base root, the type folders (`Comic`, `Manga`, `Other`) will be read as "languages"; that is harmless (the author dirs inside them do not match the author being searched) and is ignored.

- [ ] **Step 5: `processGallery` — store the type and choose the folder**

After the destructuring line `const { title, mediaId, numPages, pageExts, langStr, authorStr, extraMeta } = meta;` make `extraMeta` a derived variable. Change that line to:

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

After the block that calls `updateQueueItem(galleryId, { pagesTotal: numPages })` (inside `if (!this.isGalleryDeleting(gid)) { ... }`) add inside the same block:

```js
                if (contentType) await updateQueueItem(galleryId, { category: contentType });
```

Replace the line `const parentDir = path.join(this.baseDownloadDir, sanitizedLang, sanitizedAuthor);` with:

```js
            const typeDir = typeFolderName(contentType);
            const parentDir = typeDir
                ? path.join(this.baseDownloadDir, typeDir, sanitizedLang, sanitizedAuthor)
                : path.join(this.baseDownloadDir, sanitizedLang, sanitizedAuthor);
```

(The new `extraMeta` is used by the two `saveToLibrary` calls and by `tryApiArchiveDownload`; their callers need no change. The library `meta` inherits `contentType`/`category` through `...extra.extraMeta` in `saveToLibrary`.)

- [ ] **Step 6: Server `/api/library`**

In `server/index.js`, in the `items` mapping for `GET /api/library`, add after `source: sourceOf(data.gallery_id),`:

```js
                    category: (data.meta && data.meta.contentType) || null,
```

- [ ] **Step 7: Run the tests**

Run: `node --test test/contentType.engine.test.js test/multiSource.engine.test.js`
Expected: PASS. Then `npm test` once (large timeout): PASS.

- [ ] **Step 8: Commit**

```bash
git add core/engine.js server/index.js test/contentType.engine.test.js
git commit -m "feat(engine): store provider galleries under type folders and record content type"
```

---

### Task 5: UI — type badge and filter

**Files:**
- Create: `webui/src/lib/contentType.js`, `test/webuiContentType.test.js`
- Modify: `webui/src/lib/stores/app.svelte.js`, `webui/src/lib/components/VirtualQueueTable.svelte`, `SidebarFilter.svelte`, `LibraryModal.svelte`

**Interfaces:**
- Consumes: API response `item.category` (Tasks 1/3/4).
- Produces (`webui/src/lib/contentType.js`, pure ES module, no runes):
  - `TYPE_ORDER = ['comic', 'manga', 'other']`
  - `typeLabel(type) -> 'Comic' | 'Manga' | 'Other' | ''`
  - `itemType(item) -> 'comic' | 'manga' | 'other' | null` (reads `item.category`; anything other than the three values → `null`)
  - `matchesTypeFilter(item, filter) -> boolean` (`'all'`/falsy passes everything)
  - `countByType(items) -> Map<string, number>` (typed items only)
  - `typeBadgeClass(type) -> string` (inline Tailwind classes for the badge)

- [ ] **Step 1: Write the failing test**

Create `test/webuiContentType.test.js`:

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

- [ ] **Step 2: Run, confirm it fails**

Run: `node --test test/webuiContentType.test.js`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `webui/src/lib/contentType.js`**

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

- [ ] **Step 4: Run the helper tests**

Run: `node --test test/webuiContentType.test.js`
Expected: PASS.

- [ ] **Step 5: Store**

In `webui/src/lib/stores/app.svelte.js`: add the import `import { TYPE_ORDER, matchesTypeFilter, countByType } from '../contentType.js';`. Add state near `sourceFilter`: `typeFilter = $state('all'); // 'all' | 'comic' | 'manga' | 'other'` and a method near `setSourceFilter`:

```js
  setTypeFilter(id) {
    this.typeFilter = this.typeFilter === id ? 'all' : id;
  }
```

In `filterCounts` (where `sources` is computed) add before `return`: `const typeCounts = countByType(this.items);` and add to the returned object:

```js
      types: TYPE_ORDER.filter((id) => typeCounts.has(id)).map((id) => ({ id, count: typeCounts.get(id) }))
```

In `filteredAndSortedItems`, next to the `const srcf = this.sourceFilter;` read, add `const tf = this.typeFilter;` and after the line `if (!matchesSourceFilter(item, srcf)) continue;` add `if (!matchesTypeFilter(item, tf)) continue;`.

- [ ] **Step 6: Badge in `VirtualQueueTable.svelte`**

Import `import { itemType, typeLabel, typeBadgeClass } from '../contentType.js';`. In the `{#each visibleRows ...}` block add `{@const ctype = itemType(item)}` next to `{@const src = ...}`. Right after the source badge (in both the mobile and desktop title cells; both already have an unconditional `<span ...>{sourceLabel(...)}</span>`), add:

```svelte
{#if ctype}<span class="inline-block align-middle leading-none px-1 py-0.5 rounded text-[9px] font-mono uppercase mr-1 {typeBadgeClass(ctype)}" title="Type: {typeLabel(ctype)}">{typeLabel(ctype)}</span>{/if}
```

Do not change `ROW_HEIGHT`, the grid, or the virtualization constants.

- [ ] **Step 7: "Type" filter in `SidebarFilter.svelte`**

Import `import { typeLabel } from '../contentType.js';` and add in `<script>`:

```js
  const typeItems = $derived(counts.types.map((t) => ({ ...t, label: typeLabel(t.id) })));
```

Right after the `{#if sourceItems.length > 0} ... {/if}` block (the Source section), add a similar block:

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

In `LibraryModal.svelte`: import `import { itemType, typeLabel, typeBadgeClass } from '../contentType.js';`, add state `let libraryType = $state('all');`, add to the `filteredLibrary` predicate (after the source check) `if (libraryType !== 'all' && itemType(item) !== libraryType) return false;`, add `let libraryTypeOptions = $derived(['comic', 'manga', 'other'].filter(t => libraryItems.some(i => itemType(i) === t)));`, and right after the source `<select>` add:

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

And in the title row, right after the source badge, add `{#if itemType(item)}<span class="px-1 py-0.5 rounded text-[9px] font-mono uppercase shrink-0 {typeBadgeClass(itemType(item))}">{typeLabel(itemType(item))}</span>{/if}`.

- [ ] **Step 9: Build and test**

Run: `node --test test/webuiContentType.test.js test/webuiSources.test.js test/webuiQueueView.test.js`, then `npm --prefix webui run build` (no Svelte warnings), then `npm test` once (large timeout).
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add webui test/webuiContentType.test.js
git commit -m "feat(ui): show content type badge and add a Type filter to the queue and library"
```

---

### Task 6: Real category verification, documentation, and wrap-up

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/CHANGELOG.md`, `docs/PLAN.md`, `docs/AI_AGENT.md` (only if a statement becomes wrong)

**Interfaces:**
- Consumes: all previous tasks.

- [ ] **Step 1: Check real categories (metadata only, without downloading pages)**

Write a throwaway script in the OS temp folder (NOT in the repo) that calls the real providers' `fetchMeta` using the same transport as the engine, then prints `category`, `contentType`, `categoryError`, `numPages`:

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

Use absolute repo paths in `require`. Reasonable expectations: site B2 `western` → `comic`; site C `porn-comic` → `comic`; site B1 per the category link on its page (e.g. `manga` → `manga`). Report the results as they are; if any is `null`, investigate the actual markup/response (do not guess) and report it as BLOCKED/DONE_WITH_CONCERNS with the evidence. Do not run the user's server on port 8080 and do not write to `data/`.

- [ ] **Step 2: Documentation (generic names only)**

- `docs/ARCHITECTURE.md`: add `core/providers/contentType.js` and an explanation of the content type (slug → type mapping, folder layout `<base>/<Type>/<Language>/<Author>/<Title>`, site A unchanged, the `queue.category` column, `meta.contentType` in the library, typed `findExistingOnDisk`, schema v4).
- `docs/CHANGELOG.md`: new top entry, actor `AI (Claude Code, Sonnet 5.5)`, summarize the feature and verification results (do not add a "Manual (...)" entry).
- `docs/PLAN.md`: add a "Content type" task group with `[x]` and a Log line.
- `docs/AI_AGENT.md`: check with `grep -n "Language\|Author\|folder" docs/AI_AGENT.md`; update only if a folder layout statement becomes wrong.
- Grep the lines added in `docs/` (other than `docs/superpowers/`) for real names/domains/prefixes: there must be zero results.

- [ ] **Step 3: Run the whole suite and commit**

Run: `npm test` (large timeout). Expected: PASS.

```bash
git add docs
git commit -m "docs: record content type (comic/manga) in architecture, changelog, and plan"
```
