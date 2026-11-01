# Multi-source download (provider layer) — Design

Status: approved in chat (2026-10-06), awaiting written spec review.
Branch: `rework`.

> Repo documentation rule: real site names may exist only in code. In this document sites are written generically:
> **site A** (default, already exists), **site B1/B2** (two domains, same platform, numeric ID), **site C** (slug ID, has a JSON API).
> Real domains and prefixes are defined as constants in `core/providers/*.js`.

## 1. Goal

The user pastes a URL from site B1, B2, or C into the queue. The gallery is downloaded and added to the library like a site A gallery.

Success criteria:
- URLs from B1, B2, and C are accepted by `POST /api/queue`, downloaded, and added to the library.
- Output format (`folder`/`cbz`/`zip`), batch, pause/resume/retry, and SSE are unchanged.
- Old data (queue, library, `.nhdl-id` markers, exports) stays valid without rewriting.
- Local tests (SQLite) pass, and a live test with three sample URLs produces the same page count as the one announced by the site.

Out of scope: search, login, other sites, automatic filtering of non-comic pages.

## 2. Research findings (samples downloaded manually, without nhdl code)

| Site | Gallery URL | Image list | Image pattern |
|---|---|---|---|
| B1 | `/g/<id>/` | Hidden inputs in the HTML: `load_server`, `load_dir`, `load_id`, `load_pages`, `gallery_id` | `https://i{server}.<cdn-b1>/{dir}/{id}/{n}.{ext}` |
| B2 | `/gallery/<id>/` | Same HTML structure as B1 | `https://m{server}.<domain-b2>/{dir}/{id}/{n}.{ext}` |
| C | `/<lang>/comic/<slug>` | `GET /api/comics/<slug>/images` → `images[]` containing `page`, `source_url` | `https://<cdn-c>/.../images/<comic_id>/<n>.webp` |

Facts that affect the design:
- Image extensions are mixed per page on B1 (webp and jpg). A 404 on the wrong extension returns a small HTML (162 bytes), so the status code and signature must be checked.
- All images only need the site's `Referer` header. No login or Cloudflare challenge was seen.
- The announced page count may not match the real content: B1's last page (240) is 1280×173 (probably a banner); C returns 17 images for "16 pages" with the 17th image in JPEG format. Initial behavior: **download everything announced, without discarding anything**.
- From a network whose DNS blocks these domains, access must go through a DNS/VPN that is not blocked. The code must not work around DNS blocking.

## 3. Architecture

### 3.1 Provider interface (`core/providers/`)

```
match(input)              -> { key, provider } | null     // input: URL or raw ID
fetchGallery(key, ctx)    -> { title, author, lang, tags, numFavorites, uploadDate,
                               pages: [{ n, urls: [candidateUrl, ...] }] }
headers()                 -> { Referer, 'User-Agent' }
```

- `index.js`: the provider list and the `resolve(input)` function. A plain ID (number) without a prefix is routed to the default provider.
- `default.js` (site A): wraps the existing code (`nhentaiApi.js`, `fetchMetadata`, pinned CDN) without changing its behavior.
- `boards.js` (B1 and B2): one implementation, two domain configurations. Parses the hidden inputs from the HTML. For each page, `urls` holds the candidates `webp, jpg, png, gif`.
- `slugapi.js` (C): calls the JSON API, sorts `images` by `page`, `urls` holds one `source_url` per page.

### 3.2 Engine changes
`processGallery` calls `providers.resolve(key)` then uses that provider's `fetchGallery` and `headers()`. Unchanged: library check, 429 retry, circuit breaker, PNG placeholder, image verification, CBZ compression, SSE events. For site A, the API-archive path (`tryApiArchiveDownload`) stays specific to the default provider.

Per-page download: try the `urls` candidates in order until one returns 200 and passes `verifyImage`; the winning extension is saved in `pageExts`.

## 4. ID key

`gallery_id` becomes **TEXT**.

| Source | Key form | Example (generic) |
|---|---|---|
| Site A (default) | plain number, no prefix | `468614` |
| Site B1 | `<prefix-b1>:<id>` | `b1:539224` |
| Site B2 | `<prefix-b2>:<id>` | `b2:817456` |
| Site C | `<prefix-c>:<slug>` | `c1:some-slug` |

- An old ID without a prefix means site A, so old `.nhdl-id` markers, library, and queue need no rewriting.
- The prefix values are currently proposed as `xxx`, `rox`, `com` (constants in code, easy to change).
- `normalizeGalleryId` and `isValidGalleryId` (`core/db/common.js`) accept a plain number or `prefix:content` and return a canonical string. A plain number is still validated as a positive integer.
- Every place that compares or filters `Number(gallery_id)` / `parseInt(id)` is replaced with string comparison: `core/db/sqlite.js` and `core/db/postgres.js` (priority reorder, import replace, bulk pause/resume/delete, `logEvent`), `core/engine.js` (gallery stop/delete flags), `core/tracker.js` (marker reading in `rescanLibrary`), `server/index.js` (`activeGalleryId`), and `webui` (`rankById`, URL parser).
- API responses use `toPublicId`: `galleryId` is a number for plain-number keys (site A, compatible with old clients) and a string for prefixed keys. Raw DB rows follow the same rule.
- Folder names never use the raw key (the `:` character is invalid on Windows); the fallback uses `safeKeyName`.
- The `.nhdl-id` and `<archive>.nhdl-id` markers store the key string as is. `rescanLibrary` stops using `parseInt` to read their contents.
- Output file/folder names do not contain the raw key, so no `:` character enters a path (Windows).

## 5. Schema migration (v3, both adapters)

`CURRENT_APP_SCHEMA_VERSION` goes up from 2 to 3.

- **PostgreSQL** (`core/db/postgres.js`): `ALTER TABLE queue ALTER COLUMN gallery_id TYPE TEXT USING gallery_id::text` and the same for `library`, in a single migration transaction.
- **SQLite** (`core/db/sqlite.js`): a PK column type cannot be changed, so rebuild the `queue` and `library` tables (create a new table, copy with `CAST(gallery_id AS TEXT)`, drop the old one, rename, recreate indexes) in a single transaction.
- The `events` table is also migrated in PostgreSQL (`gallery_id` BIGINT → TEXT). In SQLite the `events.gallery_id` column keeps INTEGER affinity because SQLite stores non-numeric text (prefixed keys) as is.
- The `pg` driver keeps the type 20 (int8) → number parser for other BIGINT columns; the `gallery_id` column, now TEXT, is returned as a string then mapped through `toPublicId`.
- Export/import: the format stays `nhdl-export` v1; old payloads (numeric IDs) pass validation, new payloads may contain prefixed IDs.
- Rollback: back up the database (`data/nhdl.db` or a Postgres dump) before migrating. The migration is one-way, with no automatic downgrade.

## 6. API (documented in `docs/API.md` before implementation)

No new endpoints. Contract changes:
- `POST /api/queue`: `text` lines accept URLs from site B1, B2, C, and prefixed IDs. Unrecognized lines are rejected with a clear message (not silently skipped).
- `POST /api/retry` and any `GET` that accepts `galleryId`: the value is a string, and may be prefixed.
- SSE `item`/`progress` event payloads and the `/api/status` and `/api/library` responses: `galleryId` is a number for site A and a string for prefixed keys (per section 4), and every item has a derived `source` field (see 6b).
- `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/CHANGELOG.md` (actor `AI (Claude Code, Sonnet 5.5)`), and `docs/PLAN.md` are updated; real site names are not written in the documents.

## 6b. Source category in the list (UI)

Goal: the queue and library show clearly which site each item comes from.

- **Derived `source` field** on the `/api/status` and `/api/library` responses and the SSE `item` payload: the provider id value (`default`, `b1`, `b2`, `c1`), computed from the `gallery_id` prefix through `providers.resolve()`. Not stored in the DB, so there is no extra column or migration, and old IDs automatically become `default`.
- **Display label** (the site name shown to the user) comes from provider metadata (`label`), sent together with the source list through an existing response (e.g. `/api/config`), so the UI does not hardcode site names.
- **Queue**: a source badge on each row, plus a category filter (chips: `All` + one chip per existing source, with the item count) combined with the existing status and search filters. Per-batch grouping is unchanged.
- **Library**: the same source badge and filter in the Library Manager modal.
- Filtering runs client-side on SSE data already received (no new polling), per the repo rules.
- Tests: unit tests for the prefix → `source`/`label` mapping, and SSE/API tests confirming `source` is in the payload; the UI display is verified manually on a local dev server.

## 7. Error handling

| Case | Behavior |
|---|---|
| URL/ID not recognized | Line rejected at `POST /api/queue`, recorded in the event log |
| Gallery missing (404 / empty API) | `SKIPPED - <reason>` as today |
| All extension candidates fail for a page | Retry per the existing rules, then PNG placeholder + `placeholder_pages.log` |
| HTML response is a DNS/ISP block page or a challenge | Clear error (`ERROR - blocked or unexpected HTML`), not treated as an image |
| 429 / rate limit | Existing backoff and circuit breaker flow |

## 8. Testing

1. **Unit** (`node:test`): `match()` for each provider; hidden input parser with HTML fixtures from the manual download (no explicit content, only the relevant tag snippets); C's JSON parser; `normalizeGalleryId`/`isValidGalleryId` for plain and prefixed numbers.
2. **Migration**: a v2 DB containing numeric IDs migrates to v3 without data loss in SQLite and PostgreSQL; numeric IDs can still be looked up and retried; export then import stays consistent.
3. **Local E2E**: server with SQLite, `POST /api/queue` with three sample URLs, wait for `done`, then compare file count and integrity against `samples/probe/out/` (same page count, no files under 2 KB that are not placeholders).
4. `npm test` must be green before committing.

## 9. Open decisions (assumed defaults)

- Prefix values `xxx` / `rox` / `com`: assumed; can be changed through constants without affecting the design.
- Non-comic pages (banners, extra images): not filtered. An option to filter by ratio/size could be a follow-up feature.
