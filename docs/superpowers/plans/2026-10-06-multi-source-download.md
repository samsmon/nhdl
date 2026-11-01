# Multi-Source Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The NHDL queue can accept and download galleries from three additional sites (two numeric-ID sites on the same platform, one slug-ID site with a JSON API), and the list shows the source category of each item.

**Architecture:** A small provider layer (`core/providers/`) recognizes URLs/IDs, builds prefixed keys (`xxx:539224`, `com:<slug>`), and fetches metadata + the image URL list per page. `gallery_id` in the DB becomes TEXT (migration v3, both adapters); old IDs without a prefix still mean the default site, so old data and the public API for the default site are unchanged (`galleryId` stays a number for the default site, a string for other sites). The engine uses the provider only for metadata and image URLs; the other flows (library, retry, compression, SSE) are shared.

**Tech Stack:** Node >= 22.13 (`node:test`, `node:sqlite`), `pg`, Svelte 5 + Vite (webui). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-multi-source-download-design.md`

## Global Constraints

- No new runtime dependencies; only the existing `pg`.
- Commit **under the user's name** (`git config user.name/email`), without a `Co-Authored-By` trailer or AI attribution in the commit message. Run `npm test` before committing; do not commit if it fails.
- Work on the `rework` branch.
- Every new endpoint/field/event is written in `docs/API.md` **first**, then implemented (Task 1).
- In documents (`docs/*`, including this one) sites are written generically: **site A** (default), **site B1/B2** (numeric ID), **site C** (slug). Real names, domains, and prefixes exist only in code and tests.
- State stays in the DB through `core/db.js`; schema migrations in **both** adapters (`core/db/sqlite.js`, `core/db/postgres.js`); the UI receives changes via SSE, not polling.
- The code must not bypass DNS/ISP blocking (no `--resolve`/IP pin for new providers). New providers use the normal system DNS.
- Key prefixes (constants in code): site B1 = `xxx`, site B2 = `rox`, site C = `com`.
- Canonical key: plain number `^[1-9]\d*$` (site A) or `<prefix>:<content>`; site B content = number > 0, site C content = slug `^[a-z0-9][a-z0-9-]*$` (lowercase).
- ID in API/SSE responses: **number** if the key is a plain number, **string** if prefixed (helper `toPublicId`).
- Do not commit the contents of `samples/`.

## Review Focus

1. A site B/C URL line that also contains a 5–7 digit number in the slug/title must not be mistaken for a site A ID (old fallback regex `\b\d{5,7}\b`): the URL `.../g/539224/` must become the key `xxx:539224`, not `539224`.
2. A prefixed key contains `:`, which is invalid in a folder name on Windows: the fallback folder name and the marker must not use the raw key.
3. Every place that used to compare `Number(gallery_id)` (priority reorder, import replace, bulk pause/delete) must not produce `NaN` for prefixed keys.
4. A page announced by the site but 404 on all candidate extensions must end as a bounded retry/error, not an endless loop or an HTML file saved as an image.
5. A block/challenge HTML page response (not a gallery) must become a clear error, not empty metadata.
6. Migration v3 must be idempotent on a DB that is already v3 and must not lose queue rows/order (`id`, `priority`, `created_at`) on a v2 DB containing numeric IDs.
7. Library rescan must recognize `.nhdl-id` markers containing prefixed keys, and still recognize old numeric markers.

---

## File Structure

| File | Responsibility |
|---|---|
| `core/providers/index.js` (new) | Provider registry, `resolveInput`, `canonicalKey`, `providerForKey`, `sourceOf`, `toPublicId`, `listSources`, `registerProvider` |
| `core/providers/default.js` (new) | Site A definition (URL/ID recognizer only; metadata still via `engine.fetchMetadata`) |
| `core/providers/boards.js` (new) | Site B1/B2 provider factory: HTML parser + image URLs |
| `core/providers/slugapi.js` (new) | Site C provider: JSON API `/api/comics/<slug>/images` |
| `core/providers/http.js` (new) | `fetchText`, `downloadToFile` (http/https, redirect, `.part`, no IP pin) |
| `core/db/listParser.js` (new) | Shared `parseListText` for both adapters |
| `core/db/common.js` | New `normalizeGalleryId`/`isValidGalleryId`, `toPublicId`, `formatQueueRow` + `source` |
| `core/db/sqlite.js`, `core/db/postgres.js` | Migration v3, replacement of `Number(gallery_id)`, shared `parseListText` |
| `core/engine.js` | String-based stop flags, provider path in `processGallery`, `downloadProviderPage` |
| `core/tracker.js` | Marker rescan uses `canonicalKey` |
| `server/index.js` | `source` in `/api/library`, `sources` in `/api/config`, string `activeGalleryId` |
| `webui/src/lib/sources.js` (new) | Pure source helpers (badge, filter, count) |
| `webui/src/lib/stores/app.svelte.js`, `QueueItem.svelte`, `SidebarFilter.svelte`, `LibraryModal.svelte` | Source badge + filter |
| `test/providers.test.js`, `test/providerFetch.test.js`, `test/multiSource.db.test.js`, `test/multiSource.engine.test.js`, `test/webuiSources.test.js` (new) | Tests |

---

### Task 1: API contract documentation (docs-first)

**Files:**
- Modify: `docs/API.md` (section 1 `QueueItem`, 3.2 queue, 3.3 retry, 3.4 config, 3.5 library)

**Interfaces:**
- Produces: the written contract followed by Tasks 6–8 (`QueueItem.source`, `LibraryItem.source`, `GET /api/config` → `sources`, `galleryId` format).

- [ ] **Step 1: Update the `QueueItem` example and its notes**

In `docs/API.md` section `### QueueItem`, add the field `"source": "default"` after `"galleryId": 123456` and add the following bullets after the `Status values` bullet:

```markdown
- `galleryId`: `number` for site A galleries (plain-number key, compatible with earlier versions), prefixed `string` (`"<prefix>:<content>"`) for site B1/B2/C. Examples: `123456`, `"b1:539224"`, `"c1:some-slug"`. This value is used as is for `ids`/`galleryId` in other endpoints.
- `source`: source id derived from the `galleryId` prefix (`"default"` if there is no prefix). Not stored in the DB. The source list is in `GET /api/config` → `sources`.
```

- [ ] **Step 2: Update the rows `POST /api/queue`, `/api/queue/import`, pause/resume/delete/priority, `/api/retry`**

In tables 3.2 and 3.3 change the type `number[]` to `(number\|string)[]` for `ids`, and `number[]` to `(number\|string)[]` for `galleryIds`. Add to the Notes column of `POST /api/queue` and `/api/queue/import`:

```markdown
Each line may be a gallery URL from site A, B1, B2, or C, a plain site A ID, or a prefixed key. Unrecognized lines are skipped and counted in the `ignored` field of the response.
```

And change both responses to `{"success":true, "added": number, "updated": number, "duplicates": number, "ignored": number, "galleryIds": (number|string)[], "total": number}`.

- [ ] **Step 3: Update `GET /api/config` and library**

In table 3.4 on the `GET /api/config` row add `"sources": {"id": string, "label": string}[]` to the response, with the note: `List of sources known to the server (UI display order), used for badge labels and category filters.` In table 3.5 on the `GET /api/library` row change the response to `{"items": LibraryItem[], "total": number}` and add below the table:

```markdown
`LibraryItem` has an additional field `source` (same as `QueueItem.source`).
```

- [ ] **Step 4: Commit**

```bash
git add docs/API.md
git commit -m "docs(api): document multi-source galleryId format, source field, and config sources"
```

---

### Task 2: Provider registry and canonical key

**Files:**
- Create: `core/providers/default.js`, `core/providers/boards.js` (URL/ID recognizer part only for now), `core/providers/slugapi.js` (same), `core/providers/index.js`
- Test: `test/providers.test.js`

**Interfaces:**
- Produces (`core/providers/index.js`):
  - `resolveInput(text: string) -> { provider, key: string, url: string } | null` — `text` is a single URL, plain ID, or prefixed key.
  - `canonicalKey(input: string|number) -> string | null`
  - `providerForKey(key: string|number) -> provider` (default if no prefix; throws `Error` if the prefix is unknown)
  - `sourceOf(key) -> string` (provider id; `'default'` if no prefix or unknown prefix)
  - `toPublicId(key) -> number | string`
  - `listSources() -> { id: string, label: string }[]`
  - `registerProvider(provider) -> void` (used by tests and extension)
  - `PROVIDERS: provider[]` (live array)
  - Provider shape: `{ id, label, prefix, isDefault, urlPatterns: RegExp[], parseBody(body) -> string|null, makeKey(body) -> string|null, buildUrl(key) -> string }` (+ `fetchMeta`, `imageHeaders` in Task 5).

- [ ] **Step 1: Write the failing test**

Create `test/providers.test.js`:

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

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test test/providers.test.js`
Expected: FAIL (`Cannot find module '../core/providers'`).

- [ ] **Step 3: Implement the default provider**

Create `core/providers/default.js`:

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

- [ ] **Step 4: Implement the site B provider factory (recognizer part)**

Create `core/providers/boards.js`:

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

- [ ] **Step 5: Implement the site C provider (recognizer part)**

Create `core/providers/slugapi.js`:

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

- [ ] **Step 6: Implement the registry**

Create `core/providers/index.js`:

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

- [ ] **Step 7: Run the test, confirm it passes**

Run: `node --test test/providers.test.js`
Expected: PASS (all tests green). Note: `'0468614'` produces the key `468614` because `Number('0468614')` = 468614; `'0'` and `'-5'` are rejected.

- [ ] **Step 8: Commit**

```bash
git add core/providers test/providers.test.js
git commit -m "feat(providers): add provider registry and canonical gallery keys"
```

---

### Task 3: ID helper in the DB layer, shared list parser, `source` field

**Files:**
- Create: `core/db/listParser.js`
- Modify: `core/db/common.js:1-30,47-51` (`normalizeGalleryId`, `isValidGalleryId`, `formatQueueRow`), re-export `toPublicId`
- Modify: `core/db/sqlite.js:637-682`, `core/db/postgres.js:694-740` (remove the local `parseListText`, use the shared one)
- Test: `test/multiSource.db.test.js` (created here, extended in Task 4)

**Interfaces:**
- Consumes: Task 2 (`canonicalKey`, `resolveInput`, `toPublicId`, `sourceOf`, `defaultProvider`).
- Produces:
  - `common.normalizeGalleryId(v) -> string` (canonical key; throws `Invalid gallery_id: <v>` if invalid)
  - `common.isValidGalleryId(v) -> boolean`
  - `common.toPublicId` (re-export)
  - `formatQueueRow(r)` adds `source` and emits `galleryId: toPublicId(r.gallery_id)`
  - `listParser.parseListText(text, defaultFormat) -> { galleryId: number|string, url: string, title: string|null, batch: number, format: string|null }[]`
  - `listParser.parseListTextDetailed(text, defaultFormat) -> { items: (same shape as above)[], ignored: number }`
  - `common.publicRow(row) -> row` with `gallery_id` passed through `toPublicId` (used by Task 4 for raw DB rows)

- [ ] **Step 1: Write the failing test**

Create `test/multiSource.db.test.js`:

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

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test test/multiSource.db.test.js`
Expected: FAIL (`Cannot find module '../core/db/listParser'`).

- [ ] **Step 3: Create the shared list parser**

Create `core/db/listParser.js`:

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

- [ ] **Step 4: Replace `normalizeGalleryId`, `isValidGalleryId`, `formatQueueRow` in `core/db/common.js`**

Replace the top of the file (the `normalizeGalleryId` and `formatQueueRow` functions) with:

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

Replace `isValidGalleryId` with:

```js
function isValidGalleryId(rawId) {
    return canonicalKey(rawId) !== null;
}
```

Add the following function right after `formatQueueRow` (used by Task 4 so raw rows from the DB still give a number `gallery_id` for site A, as before the migration):

```js
function publicRow(row) {
    return row ? { ...row, gallery_id: toPublicId(row.gallery_id) } : row;
}
```

Add `toPublicId` and `publicRow` to `module.exports` at the end of the file.

- [ ] **Step 5: Use the shared parser in both adapters**

In `core/db/sqlite.js` remove the `parseListText` function (lines 637–682) and add to the require section at the top:

```js
const { parseListText } = require('./listParser');
```

Do the same in `core/db/postgres.js` (remove the `parseListText` function at lines 694–740). Make sure `parseListText` is still in `module.exports` of both adapters (same name, now referring to the imported function).

- [ ] **Step 6: Run the new tests and the whole suite**

Run: `node --test test/multiSource.db.test.js`
Expected: PASS.

Run: `npm test`
Expected: The old suite might fail where it compares `gallery_id` from the DB (now a string after Task 4) — in this Task the DB is not changed yet, so the whole suite must still PASS. If anything fails, fix it before continuing.

- [ ] **Step 7: Commit**

```bash
git add core/db test/multiSource.db.test.js
git commit -m "feat(db): canonical string gallery keys, shared list parser, and derived source field"
```

---

### Task 4: Schema migration v3 and DB adapter adaptation

**Files:**
- Modify: `core/db/common.js:45` (`CURRENT_APP_SCHEMA_VERSION = 3`)
- Modify: `core/db/sqlite.js` (migration, replacement of `Number(...gallery_id)`, `logEvent`, `parseLibraryRow`, returned IDs)
- Modify: `core/db/postgres.js` (migration, similar replacements, type parser)
- Test: `test/multiSource.db.test.js` (additions)

**Interfaces:**
- Consumes: Task 3 (`normalizeGalleryId`, `toPublicId`, `canonicalKey`).
- Produces: DB v3 with `queue.gallery_id`, `library.gallery_id` TEXT (SQLite: rebuild; PG: `ALTER ... TYPE TEXT`), `events.gallery_id` TEXT in PG. Adapter functions accept numeric or prefixed IDs and return IDs through `toPublicId`.

- [ ] **Step 1: Write the failing test**

Add at the end of `test/multiSource.db.test.js` (and add `const fs = require('fs'); const os = require('os'); const path = require('path'); process.env.NHDL_LEGACY_CONFIG = ''; const dbMod = require('../core/db');` at the top of the file, before `const common`):

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

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test test/multiSource.db.test.js`
Expected: FAIL (schema version is still 2, `gallery_id` is still INTEGER; prefixed keys rejected/`NaN`).

- [ ] **Step 3: Add migration v3 in SQLite**

In `core/db/sqlite.js`, add an element to the `MIGRATIONS` array (after version 2):

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

(Place the comma correctly; the previous element ends with `}` and the `,` before the new element is already written above.) Note: `ALTER TABLE ... RENAME` in modern SQLite also moves indexes named after the old table to the renamed table, which is why the old indexes are `DROP`ped before the new table is created.

- [ ] **Step 4: Bump the application schema version**

In `core/db/common.js` change `const CURRENT_APP_SCHEMA_VERSION = 2;` to `3`.

- [ ] **Step 5: Add migration v3 in PostgreSQL**

In `core/db/postgres.js`, add an element to `MIGRATIONS` after version 2:

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

- [ ] **Step 6: Replace numeric comparisons in `core/db/sqlite.js`**

Apply the following rules throughout `core/db/sqlite.js` (find with `grep -n "Number(.*gallery_id" core/db/sqlite.js`):

1. Comparison/set membership: `targetSet.has(Number(X.gallery_id))` → `targetSet.has(String(X.gallery_id))`. Applies in `updateQueuePriority` (lines ±497, 513, 516, 524, 527, 537, 545, 567, 577), and `keepSet.has(Number(r.gallery_id))` in `importListText` → `keepSet.has(String(r.gallery_id))`.
2. Local gallery id values used as DB function arguments (`const gid = Number(selectedRows[i].gallery_id)` and similar) → `const gid = String(...)`.
3. `importListText`: leave `const galleryIds = parsedItems.map(i => i.galleryId);` as is (it already holds public IDs, returned in the summary), but change `const keepSet = new Set(galleryIds);` to `const keepSet = new Set(galleryIds.map(g => normalizeGalleryId(g)));` so it matches the `String(r.gallery_id)` comparison. Add `ignored` to the summary: change the import at the top to `const { parseListTextDetailed } = require('./listParser');`, replace `const parsedItems = parseListText(text, defaultFormat);` in `importListText` with

```js
    const { items: parsedItems, ignored } = parseListTextDetailed(text, defaultFormat);
```

   and change the final return to `return { added, updated, duplicates, ignored, galleryIds, total: parsedItems.length };`. (`parseListText` stays exported by the adapter module through `const { parseListText, parseListTextDetailed } = require('./listParser');` — use a single import line that has both.)
8. Raw queue rows: wrap the results of `getQueueItem`, `getNextPendingItem`, and `getQueueItems` with `publicRow` from `./common` (import `publicRow`), e.g. `return publicRow(active.prepare(...).get(id) || null);` and `return active.prepare(sql).all(...params).map(publicRow);`. This way `row.gallery_id` for site A stays a number (as before the migration), and `engine.js`, which uses `String(row.gallery_id)`, stays correct.
4. ID lists returned to callers (`stoppingIds`, `resumedIds`, `removedIds` in `deleteQueueBatch`/`clearCompletedQueue`): wrap with `toPublicId(...)` — for example `stoppingIds.push(toPublicId(gid));` in `pauseQueueItems` and `deleteQueueItems`, `resumedIds.push(toPublicId(gid));`, and `const removedIds = rows.map(r => toPublicId(r.gallery_id));`. Add `toPublicId` to the import from `./common`.
5. `parseLibraryRow`: change `gallery_id: row.gallery_id,` to `gallery_id: toPublicId(row.gallery_id),` (the `id: String(row.gallery_id)` field stays).
6. `logEvent`: replace

```js
    const gid = galleryId !== null && galleryId !== undefined && String(galleryId).trim() !== ''
        ? parseInt(String(galleryId), 10) || null
        : null;
```

   with

```js
    const gid = galleryId !== null && galleryId !== undefined && String(galleryId).trim() !== ''
        ? (canonicalKey(galleryId) || null)
        : null;
```

   and add `const { canonicalKey } = require('../providers');` at the top. For plain-number keys, SQLite converts `'5'` to INTEGER 5 because of the column affinity, so the old behavior is preserved.
7. Make sure `getEvents` still uses `normalizeGalleryId(options.galleryId)` (it already does).

- [ ] **Step 7: Apply the same rules in `core/db/postgres.js`**

Apply rules 1–7 of Step 6 to `core/db/postgres.js` (grep `grep -n "Number(.*gallery_id" core/db/postgres.js`; lines ±555–632, 682, 760, 919, 1065, 1081, 1093, 1102). PG-specific differences:

- Remove the line `pg.types.setTypeParser(20, v => parseInt(v, 10));`? **Do not remove it**: other columns (`id BIGSERIAL`, counts) are still BIGINT and the `Number(r.id)` mapping lines still depend on it.
- Row mapping: `gallery_id: Number(row.gallery_id)` (lines ±919, ±1081, ±1093) → `gallery_id: toPublicId(row.gallery_id)`; `gallery_id: r.gallery_id ? Number(r.gallery_id) : null` (±1065, ±1102) → `gallery_id: r.gallery_id ? toPublicId(r.gallery_id) : null`.
- `logEvent` in PG (line ±1020): replace `parseInt(String(galleryId), 10) || null` with `(canonicalKey(galleryId) || null)`; the events column is now TEXT so the value is sent as a string.

- [ ] **Step 8: Run the new tests**

Run: `node --test test/multiSource.db.test.js`
Expected: PASS.

- [ ] **Step 9: Run the whole suite and fix regressions**

Run: `npm test`
Expected: PASS. If an old test fails because of a type comparison, the cause is one of: (a) an adapter function output not yet wrapped with `toPublicId` (fix it in the adapter, not in the test); (b) a caller in `core/tracker.js`/`core/engine.js` that still uses `parseInt` (handled in Task 6 — if it fails because of that, note it and continue to Task 6 before committing, do not change the test). The PostgreSQL suite (`test/db.test.js` PG variant, when `DATABASE_URL` is set) must also be run: `DATABASE_URL=<test url> npm test`.

- [ ] **Step 10: Commit**

```bash
git add core/db test/multiSource.db.test.js
git commit -m "feat(db): schema v3 with TEXT gallery_id and prefixed-key aware adapters"
```

---

### Task 5: Metadata and image URL fetching per provider

**Files:**
- Create: `core/providers/http.js`
- Modify: `core/providers/boards.js` (add `fetchMeta`, `imageHeaders`), `core/providers/slugapi.js` (same), `core/providers/default.js` (add `imageHeaders`)
- Test: `test/providerFetch.test.js`

**Interfaces:**
- Consumes: Task 2 (provider shape).
- Produces:
  - `http.fetchText(url: string, headers?: object, timeoutMs?: number) -> Promise<{ status: number, body: string }>` (follows redirects, max 3).
  - `http.downloadToFile(url, destPath, headers?, onProgress?(received, total), timeoutMs?) -> Promise<void>`; rejects with an `Error` with a `statusCode` property if the status is not 200; writes to `<dest>.part` then renames.
  - `provider.imageHeaders() -> { 'User-Agent', Referer }`
  - `provider.fetchMeta(key, { fetchText }) -> Promise<Meta>` for site B and C, with `Meta = { title, numPages, ext, pageExts, langStr, authorStr, extraMeta, pageUrls(n) -> { ext: string, url: string }[] }`.
  - 404 error: `Error` with `permanent = true` and a message starting with `404`.
  - The constant `PAGE_EXTS = ['webp', 'jpg', 'png', 'gif']` is exported from `boards.js`.

- [ ] **Step 1: Write the failing test**

Create `test/providerFetch.test.js`:

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

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test test/providerFetch.test.js`
Expected: FAIL (`Cannot find module '../core/providers/http'`).

- [ ] **Step 3: Implement `core/providers/http.js`**

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

- [ ] **Step 4: `imageHeaders` for the default provider**

In `core/providers/default.js` add the property to the exported object:

```js
    imageHeaders: () => ({ Referer: 'https://nhentai.net/' })
```

- [ ] **Step 5: Complete `core/providers/boards.js`**

Replace the entire file contents with:

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

- [ ] **Step 6: Complete `core/providers/slugapi.js`**

Replace the entire file contents with:

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

- [ ] **Step 7: Run the tests**

Run: `node --test test/providerFetch.test.js test/providers.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add core/providers test/providerFetch.test.js
git commit -m "feat(providers): fetch metadata and page URLs for the board-style and slug-API sources"
```

---

### Task 6: Engine, tracker, and server integration

**Files:**
- Modify: `core/engine.js` (imports; `stopGallery`/`cancelStopGallery`/`isGalleryStopping`/`isGalleryDeleting`/`clearGalleryStopFlags` lines 88–118; `processGallery` lines 602–976; new methods `fetchProviderMetadata`, `downloadProviderPage`)
- Modify: `core/tracker.js:224-225,275-276` (rescan)
- Modify: `server/index.js:452-453,514-515` (`activeGalleryId`), `server/index.js:367-383` (`/api/library` + `source`), handler `GET /api/config` (field `sources`), handler `/api/queue` (the `ignored` field already comes from the `importListText` summary)
- Test: `test/multiSource.engine.test.js`

**Interfaces:**
- Consumes: Task 2 (`providerForKey`, `registerProvider`, `toPublicId`, `canonicalKey`, `sourceOf`, `listSources`), Task 5 (`fetchText`, `downloadToFile`, `provider.fetchMeta`, `provider.imageHeaders`, `meta.pageUrls`, `PAGE_EXTS`).
- Produces: `engine.processGallery(key)` works for prefixed keys; `engine.downloadProviderPage(provider, candidates, folderPath, page, onProgress) -> Promise<{ path, ext }>`; `engine.fetchProviderMetadata(provider, key) -> Promise<Meta>`; `safeKeyName(key) -> string` (local to `engine.js`: replaces characters outside `[A-Za-z0-9._-]` with `_`).

- [ ] **Step 1: Write the failing test**

Create `test/multiSource.engine.test.js`:

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

Note for the implementer: the test uses the `imageBase` option on `createBoardsProvider` so image URLs point to a local HTTP server. Add support for that option in Step 3 (below) — **this optional option exists purely so the provider can be tested; when `imageBase` is not given, production behavior does not change**.

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test test/multiSource.engine.test.js`
Expected: FAIL (`engine.downloadProviderPage is not a function` and similar).

- [ ] **Step 3: Optional `imageBase` support in the site B provider**

In `core/providers/boards.js`, change the destructuring `const { id, label, origin, galleryPath, hosts, imageHost } = cfg;` to `const { id, label, origin, galleryPath, hosts, imageHost, imageBase } = cfg;` and replace the body of `pageUrls(n)` in `parseGallery` with:

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

Also, `buildUrl` uses `origin` (local HTTP in the test) so `fetchMeta` calls the test server; no other changes.

- [ ] **Step 4: String-based stop flags in `core/engine.js`**

Replace lines 88–118 (the five stop-flag methods) with:

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

In `processGallery` replace `const gid = parseInt(String(galleryId), 10);` (line 603) with `const gid = String(galleryId);` and `this.emit('gallery_stopped', { galleryId: gid, ...` (line ±850) with `this.emit('gallery_stopped', { galleryId: toPublicId(gid), ...`.

- [ ] **Step 5: Imports and helpers at the top of `core/engine.js`**

After the line `const { fetchGalleryMetadata, requestDownloadUrl, downloadArchiveFile } = require('./nhentaiApi');` add:

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

- [ ] **Step 6: New methods in the `DownloaderEngine` class**

Add two methods right before `async tryApiArchiveDownload(...)`:

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

- [ ] **Step 7: Metadata through the provider in `processGallery`**

Replace line 642 (`const meta = await this.fetchMetadata(galleryId);`) with:

```js
            const provider = providers.providerForKey(galleryId);
            const meta = provider.isDefault
                ? await this.fetchMetadata(galleryId)
                : await this.fetchProviderMetadata(provider, galleryId);
```

Replace lines 675 and 676 (the destructuring of `meta` and `extFor`) with:

```js
            const { title, mediaId, numPages, pageExts, langStr, authorStr, extraMeta } = meta;
            let ext = meta.ext;
            const extFor = (page) => pageExts[page] || ext;
```

Replace line 679 (`const sanitizedTitle = sanitizeName(title) || galleryId;`) with:

```js
            const sanitizedTitle = sanitizeName(title) || safeKeyName(galleryId);
```

Replace the API-archive condition (line 716) `if (apiKey && (targetFormat === 'cbz' ...` with `if (provider.isDefault && apiKey && (targetFormat === 'cbz' || targetFormat === 'zip') && !this.isGalleryStopping(gid)) {` (the rest of the block is unchanged).

Replace line 733 (`folderPath = path.join(parentDir, galleryId.toString());`) with:

```js
                        folderPath = path.join(parentDir, safeKeyName(galleryId));
```

- [ ] **Step 8: Check existing pages (resume) for non-default providers**

Replace the loop at lines 745–753 with:

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

- [ ] **Step 9: Download pages through the provider**

Replace lines 872–876 (`const currentPage = pendingPages.shift();` through `const imageUrl = ...`) with:

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

Replace lines 891–897 (`sleep(startDelay)` through `.then(async () => {`) with:

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

(The entire `.then(async () => {` block after it, including `verifyImage(destPath)`, is unchanged — `destPath` is now `let` and already points to the downloaded file.)

- [ ] **Step 10: Marker rescan in `core/tracker.js`**

Add at the top of `core/tracker.js` (with the other requires): `const { canonicalKey } = require('./providers');`. In two places (lines ±224–225 and ±275–276) replace:

```js
                const id = parseInt(rawId, 10);
                if (Number.isFinite(id) && id > 0) {
```

with:

```js
                const id = canonicalKey(rawId);
                if (id) {
```

- [ ] **Step 11: Server**

In `server/index.js`:

1. In two places (lines ±452 and ±514) replace

```js
                            const gid = parseInt(String(id), 10);
                            if (Number.isFinite(gid) && engine.activeGalleryId === gid) {
```

with

```js
                            const gid = String(id);
                            if (engine.activeGalleryId === gid) {
```

2. In the `GET /api/library` handler (line ±370) add a field to the `map` result object: `source: sourceOf(data.gallery_id),` and import at the top of the file: `const { sourceOf, listSources } = require('../core/providers');`.
3. In the `GET /api/config` handler (line ±597) add `sources: listSources(),` to the returned JSON object.

- [ ] **Step 12: Run the tests**

Run: `node --test test/multiSource.engine.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS (the whole suite, including db.test.js/sse.test.js). If any SSE/API test assumes `galleryId` is a number for site A items, it stays a number through `toPublicId`.

- [ ] **Step 13: Commit**

```bash
git add core server test/multiSource.engine.test.js
git commit -m "feat(engine): download prefixed galleries through providers; string-safe stop flags, rescan, and server hooks"
```

---

### Task 7: UI — source badge and category filter

**Files:**
- Create: `webui/src/lib/sources.js`, `test/webuiSources.test.js`
- Modify: `webui/src/lib/stores/app.svelte.js` (`extractGalleryId`, `parseItemUrl`, `rankById`, `filterCounts`, `filteredAndSortedItems`, state `sourceFilter`/`sources`, `setSourceFilter`, loading `sources` from config)
- Modify: `webui/src/lib/components/QueueItem.svelte`, `SidebarFilter.svelte`, `LibraryModal.svelte`

**Interfaces:**
- Consumes: API responses from Tasks 1/6 (`item.source`, `LibraryItem.source`, `config.sources`).
- Produces (`webui/src/lib/sources.js`, pure ES module, no runes):
  - `sourceOfKey(key) -> string`
  - `itemSource(item) -> string` (`item.source` if present, otherwise from `item.galleryId ?? item.id`)
  - `matchesSourceFilter(item, filter) -> boolean`
  - `countBySource(items) -> Map<string, number>`
  - `sourceLabel(id, sources) -> string`
  - `shortKey(key) -> string` (the part after `:` for prefixed keys; numeric keys are returned as is)
  - `urlKey(rawUrl) -> string | null` (recognizes gallery URLs of all four site kinds → prefixed/numeric key; used by `extractGalleryId`/`parseItemUrl`)

- [ ] **Step 1: Write the failing test**

Create `test/webuiSources.test.js`:

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

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test test/webuiSources.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `webui/src/lib/sources.js`**

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

- [ ] **Step 4: Run the tests**

Run: `node --test test/webuiSources.test.js`
Expected: PASS.

- [ ] **Step 5: Store — URL parsing and `rankById` key fix**

In `webui/src/lib/stores/app.svelte.js` add the import at the top: `import { urlKey, matchesSourceFilter, countBySource } from '../sources.js';`.

Replace `extractGalleryId` (lines 28–36) with:

```js
export function extractGalleryId(str) {
  if (!str) return null;
  return urlKey(str);
}
```

Replace `parseItemUrl` (lines 38–45) with:

```js
export function parseItemUrl(urlStr) {
  const parts = String(urlStr || '').split(' | ');
  const rawUrl = parts[0].trim();
  const title = parts.length > 1 ? parts.slice(1).join(' | ').trim() : null;
  const id = urlKey(rawUrl) || rawUrl;
  return { rawUrl, id, title };
}
```

In `buildRawListFromMap` (line 21) replace the fallback `https://nhentai.net/g/${row.galleryId}/` with `String(row.galleryId)` so prefixed keys stay valid when read by the server (`String(row.url || '').split(' | ')[0].trim() || String(row.galleryId)`).

In `rankById` replace `map.set(Number(copy[i].galleryId), i + 1);` with `map.set(String(copy[i].galleryId), i + 1);` then find all users of `rankById` with `grep -rn "rankById" webui/src` and change the lookup key from `Number(...)` to `String(...)` (e.g. `ranks.get(Number(item.galleryId))` → `ranks.get(String(item.galleryId))`).

- [ ] **Step 6: Store — state, counts, and source filter**

Add state in the store class near `batchFilter` (line 109):

```js
  sourceFilter = $state('all'); // 'all' | provider id
  sources = $state([]); // [{ id, label }] from GET /api/config
```

Add a method near `setBatchFilter` (line ±417):

```js
  setSourceFilter(id) {
    this.sourceFilter = this.sourceFilter === id ? 'all' : id;
  }
```

In `filterCounts` (line 151) add before `return`: `const sourceCounts = countBySource(this.items);` and add to the returned object:

```js
      sources: Array.from(sourceCounts.entries()).map(([id, count]) => ({ id, count }))
```

In `filteredAndSortedItems` (line ±213) add `const srcf = this.sourceFilter;` and after the line `if (bf !== null && ...) continue;` add:

```js
      if (!matchesSourceFilter(item, srcf)) continue;
```

Find the function that loads config from the server: `grep -n "fetchConfig\|getConfig\|downloadFormat =" webui/src/lib/stores/app.svelte.js webui/src/lib/api.js`. In the code that sets config fields from the `/api/config` response (where `this.downloadFormat` is filled), add one line `this.sources = Array.isArray(cfg.sources) ? cfg.sources : [];` (use the response variable name used in that function).

- [ ] **Step 7: Badge in `QueueItem.svelte`**

In `<script>` add the import `import { itemSource, sourceLabel, shortKey } from '../sources.js';` and among the `$derived` declarations:

```js
  let src = $derived(itemSource(item));
  let srcLabel = $derived(sourceLabel(src, appStore.sources));
```

(`appStore` is already imported in this file; if not, add `import { appStore } from '../stores/app.svelte.js';`.) On line 101 replace `<span class="text-[#888] text-[10px] shrink-0">#{parsed.id}</span>` with:

```svelte
        {#if src !== 'default'}
          <span class="px-1 py-0.5 rounded text-[9px] font-mono uppercase bg-[#1e293b] text-[#7dd3fc] border border-[#334155] shrink-0" title={srcLabel}>{srcLabel}</span>
        {/if}
        <span class="text-[#888] text-[10px] shrink-0">#{shortKey(parsed.id)}</span>
```

- [ ] **Step 8: Category filter in `SidebarFilter.svelte`**

Add the import `import { sourceLabel } from '../sources.js';` and `Globe` to the lucide import (`Globe,`). Add in `<script>`:

```js
  const sourceItems = $derived(
    counts.sources.map((s) => ({ ...s, label: sourceLabel(s.id, appStore.sources) }))
  );
```

Insert the following block between the closing `</div>` of Status Filters (before the first `<div class="h-px ...">`, line ±82):

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

- [ ] **Step 9: Badge and filter in `LibraryModal.svelte`**

Add the import `import { itemSource, sourceLabel } from '../sources.js';`, state `let librarySource = $state('all');`, and change `filteredLibrary` (lines 37–47) to:

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

Right after the `<input ... bind:value={librarySearch} ...>` element (line ±284) add:

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

And in the title row (line ±435) replace `<span class="text-white truncate" title={item.title}>{item.title}</span>` with:

```svelte
                    {#if itemSource(item) !== 'default'}
                      <span class="px-1 py-0.5 rounded text-[9px] font-mono uppercase bg-[#1e293b] text-[#7dd3fc] border border-[#334155] shrink-0">{sourceLabel(itemSource(item), appStore.sources)}</span>
                    {/if}
                    <span class="text-white truncate" title={item.title}>{item.title}</span>
```

- [ ] **Step 10: Build the UI and test**

Run: `npm --prefix webui run build`
Expected: build succeeds without Svelte/Vite errors.

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Manual verification on a local dev server**

Run (separate terminal): `npm start`, open `http://localhost:8080`, paste two URLs from two different sources through the Add dialog, then confirm: (a) the source badge appears on the queue rows of non-default items, (b) the "Source" section appears in the sidebar when there are ≥ 2 sources, and clicking it filters the list, (c) the Library Manager shows the badge and the source dropdown. Record the results in the reply.

- [ ] **Step 12: Commit**

```bash
git add webui test/webuiSources.test.js
git commit -m "feat(ui): show source badge and source filter in queue sidebar and library"
```

---

### Task 8: Live test, documentation, and wrap-up

**Files:**
- Modify: `docs/CHANGELOG.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/AI_AGENT.md` (only if it covers the ID/URL format), `.gitignore` (add `samples/` after the user confirms)

**Interfaces:**
- Consumes: all previous tasks.

- [ ] **Step 1: Live test with a local server (SQLite, a network that can reach the sites)**

Make sure the machine's DNS/VPN does not block the three domains. Run in a separate terminal: `NHDL_DB_PATH=./data/live-test.db DOWNLOAD_DIR=./samples/live PORT=8099 npm start`. Then:

```bash
curl -s -X POST http://localhost:8099/api/queue -H 'Content-Type: application/json' -d '{"text":"https://nhentai.xxx/g/539224/\nhttps://hentairox.com/gallery/817456/\nhttps://nhentai.com/en/comic/amys-country-wrangle-porn-comic","format":"folder"}'
```

Expected: `{"success":true,...,"galleryIds":["xxx:539224","rox:817456","com:amys-country-wrangle-porn-comic"],...}`. Wait until `GET /api/status` shows all three as `DONE` (`curl -s http://localhost:8099/api/status`). Note: gallery `xxx:539224` has 240 pages, so a full download takes a while; it may be stopped after a few pages via `POST /api/queue/pause` to test resume, then `resume`.

- [ ] **Step 2: Verify the live test results**

Run: `ls samples/live` and count files per gallery; compare with the manual samples in `samples/probe/out/` (hentairox 51 files, nhentai.com 17 files, nhentai.xxx per the pages completed). Make sure: there are no `.part` files, no files < 2 KB other than placeholders recorded in `placeholder_pages.log`, and no folder name containing `:`. Stop the server, delete `data/live-test.db` and `samples/live`.

- [ ] **Step 3: Update documentation**

- `docs/CHANGELOG.md`: add a top entry with actor `AI (Claude Code, Sonnet 5.5)` covering: provider layer, prefixed keys, schema migration v3, `source` field, source badge/filter.
- `docs/PLAN.md`: add a "Multi-source download" phase/task and tick `[x]` the completed tasks, fill in the Log table.
- `docs/ARCHITECTURE.md`: add a `core/providers/` section to the directory structure and explain the `gallery_id` key format, the provider interface, and `source`; fix sections that describe `gallery_id` as a number. Use generic naming (site A/B1/B2/C).
- Check `docs/AI_AGENT.md` with `grep -n "gallery\|ID\|/g/" docs/AI_AGENT.md`; update only if a statement becomes wrong.

- [ ] **Step 4: Summary to ask the user**

Ask whether `samples/` may be added to `.gitignore`; if yes, add the line `samples/` and include it in the commit.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add docs .gitignore
git commit -m "docs: record multi-source download in changelog, plan, and architecture"
```
