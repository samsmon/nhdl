# NHDL — Architecture & Codebase Reference

This document is the complete technical map of the NHDL codebase so AI agents in a new session **do not need to re-read thousands of lines of source code** (`core/engine.js`, `server/index.js`, `webui/src/lib/stores/app.svelte.js`, etc.) from scratch. The line counts below come from `wc -l` at the time this document was updated, so treat them as approximate.

---

## 1. Directory Structure & Module Sizes

```text
nhdl/
├── server/
│   └── index.js                 (1132 lines) — HTTP server, auth gate, REST API, SSE, batch compress job, static file server
├── core/
│   ├── db.js                     (326 lines) — Database facade & dispatcher (SQLite / PostgreSQL via DATABASE_URL), all functions async
│   ├── db/
│   │   ├── common.js             (131 lines) — normalizeGalleryId (canonical key), formatQueueRow/publicRow (`toPublicId`), maskDatabaseUrl, import validation, CURRENT_APP_SCHEMA_VERSION (4)
│   │   ├── listParser.js          (83 lines) — parseListText / parseListTextDetailed: list.txt lines (URL, plain ID, prefixed key) -> canonical key via the provider registry, counts `ignored`
│   │   ├── events.js               (7 lines) — Shared EventEmitter (dbEvents)
│   │   ├── sqlite.js            (1249 lines) — SQLite adapter (`node:sqlite`, `data/nhdl.db`, WAL), `MIGRATIONS` array v1–v4
│   │   ├── postgres.js          (1271 lines) — PostgreSQL adapter (`pg.Pool`, connection retry, BIGSERIAL, TIMESTAMPTZ), `MIGRATIONS` array v1–v4
│   │   ├── backup.js             (209 lines) — Manual/scheduled JSON backup, rotation, restore, backup folder (`NHDL_BACKUP_DIR`)
│   │   └── auto-migrate.js       (107 lines) — Automatic SQLite -> PostgreSQL migration when Postgres is still empty
│   ├── providers/                           — Multi-source layer (one file per source type)
│   │   ├── index.js              (111 lines) — Registry: `resolveInput`, `canonicalKey`, `toPublicId`, `sourceOf`, `providerForKey`, `listSources`, `registerProvider`
│   │   ├── default.js             (21 lines) — Site A provider (certain site ( ͡° ͜ʖ ͡°)): plain numeric key, legacy API/CDN path in the engine
│   │   ├── contentType.js         (30 lines) — Content type: `mapCategoryToType(slug)` (site category slug -> `comic`/`manga`/`other`), `typeFolderName`, `isContentType`
│   │   ├── boards.js             (144 lines) — Site B1/B2 provider factory (gallery HTML page + per-page list with extensions)
│   │   ├── slugapi.js            (116 lines) — Site C provider factory (gallery slug + image JSON API)
│   │   └── http.js               (201 lines) — Shared `fetchText` & `downloadToFile` (User-Agent, redirects, atomic `.part` file; before rename, the `.part` must start with a webp/jpeg/png/gif image signature, otherwise it is treated as an HTML block page and rejected without a `statusCode`) plus `curlFetchText` & `curlDownloadToFile` (system `curl` via `execFile`)
│   ├── engine.js               (1377 lines) — DownloaderEngine (EventEmitter): queue loop, metadata fetch, API/CDN/provider download, 429 backoff + circuit breaker, download folder safeguard
│   ├── tracker.js               (622 lines) — Library & queue on top of the DB: `rescanLibrary` (`.nhdl-id` / `.cbz.nhdl-id`), `isDownloadDirHealthy`, rename, CBZ/ZIP compression
│   ├── utils.js                 (232 lines) — sanitizeName (escaped control chars), getDynamicDelay, verifyImage, blank PNG, atomicWriteFileSync
│   ├── nhentaiApi.js            (187 lines) — certain site ( ͡° ͜ʖ ͡°) API v2 wrapper via curl + Cloudflare IP bypass + Zip magic-byte check (PK\x03\x04)
│   ├── zip.js                   (100 lines) — Zero-dependency Store-only ZIP/CBZ binary builder (PKWARE spec)
│   ├── auth.js                   (66 lines) — In-memory session token (30d TTL) + timingSafeEqual password check (NHDL_PASSWORD)
│   ├── env.js                    (62 lines) — Zero-dependency .env parser & updater (saveEnvValue)
│   └── logger.js                 (83 lines) — Audit & error logger to the `events` table (10,000-row retention)
├── scripts/
│   └── find-bad-archives.js     (122 lines) — `npm run check:archives` (detects & `--delete`s corrupt/HTML challenge .cbz/.zip files + prints the ID list)
├── test/                                    — `node:test` suite (`npm test`), 14 files; network is always stubbed
│   ├── db.test.js              (2168 lines) — `core/db.js`, migrations, import/export, backup, `rescanLibrary`, engine pre-pass, 1000-link restart consistency; live PostgreSQL suite (skipped without `TEST_DATABASE_URL`)
│   ├── sse.test.js              (840 lines) — SSE snapshot/delta, 5000-item, API endpoints
│   ├── nhentaiApi.test.js        (51 lines) — `downloadArchiveFile` User-Agent & zip signature validation
│   ├── multiSource.db.test.js   (292 lines) — prefixed keys, list parser, v3 migration, export/import
│   ├── multiSource.engine.test.js (264 lines) — prefixed gallery download via provider (local server)
│   ├── providers.test.js         (69 lines) — registry/resolveInput
│   ├── providerFetch.test.js    (384 lines) — per-provider `fetchMeta`/`pageUrls`, `http.js` helpers (Node & curl), 429/503
│   ├── providerCategory.test.js (101 lines) — category extraction in the B1/B2/C providers
│   ├── contentType.test.js       (34 lines) — category -> type mapping
│   ├── contentType.db.test.js   (100 lines) — schema v4 `queue.category`, export/import
│   ├── contentType.engine.test.js (143 lines) — typed folders & `findExistingOnDisk`
│   ├── webuiSources.test.js      (47 lines) — `webui/src/lib/sources.js` helper
│   ├── webuiQueueView.test.js    (90 lines) — `webui/src/lib/queueView.js` helper
│   └── webuiContentType.test.js  (47 lines) — `webui/src/lib/contentType.js` helper
├── webui/
│   ├── package.json                         — Svelte 5.57, Vite 8.3, Tailwind 4.3, GSAP 3.15, lucide-svelte
│   └── src/
│       ├── App.svelte             (90 lines) — Main qBittorrent/IDM layout (Toolbar, SidebarFilter, VirtualQueueTable, DetailPanel, StatusBar + modals)
│       ├── main.js, app.css                 — Vite entry and theme (CSS variables)
│       └── lib/
│           ├── api.js            (280 lines) — The only place that calls `fetch` to the backend
│           ├── sources.js         (58 lines) — Pure helpers: item source, per-source filter/count, badge label
│           ├── queueView.js       (56 lines) — Pure helpers: "Queue" filter definition, `nextPendingId`, cooldown chip, "Added" column
│           ├── contentType.js     (43 lines) — Pure helpers: content type label/badge/filter
│           ├── stores/app.svelte.js (925 lines) — Reactive store (runes): SSE client, queue `SvelteMap`, filters, selection, config
│           └── components/                  — 19 Svelte 5 components (see section 5)
└── docs/
    ├── PLAN.md                              — Rework roadmap (Phases 0–8) + multi-source + content type
    ├── CHANGELOG.md                         — Change history (Manual & AI)
    ├── ARCHITECTURE.md                      — This technical reference document
    ├── API.md                               — REST endpoint & SSE event contract
    ├── AI_AGENT.md                          — Deploy/manage/modify/maintain guide for AI agents
    ├── POSTGRES.md                          — Centralized PostgreSQL configuration guide
    └── superpowers/                         — Historical specs & plans (unchanged)
```

Outside the code: `Dockerfile` (multi-stage, `node:24-alpine`, `curl` installed, port 8080), `docker-compose.yml`, `.env.example`, `start.bat`, `list.txt.example`. `.gitignore` ignores `node_modules/`, `webui/dist/`, `data/`, `Download/`, `.env`, `samples/` (local manual samples), and leftover old state files.

---

## 2. State & Data Formats

All state lives in the database (`core/db.js`): SQLite `data/nhdl.db` (or `NHDL_DB_PATH`) by default, PostgreSQL when `DATABASE_URL` is set. The only state outside the DB is the secrets in `.env` and the marker files in the download folder. The download folder (`engine.baseDownloadDir`) contains only downloaded output.

### Tables (current schema version: **4**)

| Table | Main columns |
|---|---|
| `queue` | `id`, `gallery_id` (TEXT, UNIQUE; canonical key), `url`, `title`, `status`, `batch`, `priority`, `pages_done`, `pages_total`, `error`, `retries`, `created_at`, `updated_at`, `format` (v2), `category` (v4; content type `comic`/`manga`/`other` or NULL) |
| `library` | `gallery_id` (TEXT, PK), `title`, `path` (folder or archive file), `pages`, `format`, `language`, `artist`, `added_at`, `meta` (v2; JSON text: `ext`, `pageExts`, `tags`, `contentType`, etc.; for permanently skipped galleries: `{ "skipped": true, "reason": ..., "skippedAt": ... }`) |
| `settings` | `key`, `value` (JSON text): `downloadDir`, `downloadFormat`, `autoContinueBatches`, `backupIntervalHours`, `backupKeep`, `lastBackupAt` |
| `events` | `id`, `ts`, `level`, `gallery_id`, `message` (activity & error log, trimmed to 10,000 rows) |
| `schema_version` | `version` |

Migrations: v1 initial schema, v2 the `queue.format` and `library.meta` columns, v3 `gallery_id` becomes `TEXT`, v4 `queue.category`. Migrations live in the `MIGRATIONS` array in **both** adapters and run automatically on startup. `queue` item statuses: `PENDING`, `ON_PROGRESS`, `STOPPED` (manual pause), `PAUSED` (circuit breaker), `COOLDOWN`, `DONE`, `ERROR`, `SKIPPED`.

### Marker files & `.env`

- **`.nhdl-id`** (inside the gallery folder) and **`<Archive>.cbz.nhdl-id`** (next to the archive): contain the gallery's canonical key (plain number for site A, `<prefix>:...` for other sources). Used by `rescanLibrary()` (`MAX_DEPTH = 6`) to track folders/archives the user moved manually and to prune entries already deleted from disk.
- **`.env`**: `NHDL_PASSWORD`, `NHENTAI_API_KEY`, `DATABASE_URL`, `PORT`, etc. Never stored in the DB or sent to the UI.
- **Old `config.json`** (project root): read only once by `migrateLegacyConfigJson` when the `settings` table is empty (disabled with `NHDL_LEGACY_CONFIG=`). Old text state files (`list_status.txt`, `library.json`, `progress.json`, `activity.log`, `error.log`) are no longer used; `list.txt` is only an import/export format (`# BATCH N FORMAT=cbz`).
- **Download folder**: `DOWNLOAD_DIR` if set, otherwise `./Download` (Docker: `/downloads`). The folder choice in Settings is applied immediately and saved to `settings.downloadDir`. On startup, `engine.applySavedSettings()` (called in `server/index.js` after the DB is ready and before rescan/backup/auto-processing the queue) reads `downloadDir`, `downloadFormat`, and `autoContinueBatches` from `settings`; folder priority: `DOWNLOAD_DIR` > `settings.downloadDir` > `./Download`. Invalid saved values are ignored, and the folder safeguard still applies (the folder is not created if the library has entries; status `Download folder unavailable`).

### 2a. Gallery Key (`gallery_id`), Provider, and `source`

- **Canonical key** is stored as `TEXT` in the `queue` and `library` tables (schema v3). Site A uses a plain number as text (`"468614"`); other sources use `"<prefix>:<content>"` (e.g. `b1:539224`, `b2:817456`, `c1:some-slug`). The real prefixes exist only in `core/providers/index.js`.
- **`toPublicId(key)`** (`core/providers/index.js`): a plain numeric key is returned as a `number` (compatible with old clients/API), a prefixed key stays a `string`. Used by `formatQueueRow`/`publicRow` so the API, SSE, and JSON export always carry the public value; `canonicalKey()` reverses it for input.
- **`source`**: derived field (`sourceOf(key)`) holding the provider id (`"default"` for site A / plain numeric key, the provider prefix for other sources). There is no dedicated DB column; it is computed when the row is formatted. Exposed in `/api/status`, `/api/library`, and the SSE `item` event. The UI uses it for source badges and filters (`webui/src/lib/sources.js`).
- **Queue view in the webui** (`webui/src/lib/queueView.js`, pure helpers): the "Queue" sidebar filter (id `queued`) covers `PENDING` + `ON_PROGRESS`; `filterCounts.queued` uses the same definition, while `filterCounts.pending` (`PENDING` only) is used by the status bar. The store derives `nextPendingId` (the first `PENDING` item by rank order) and `cooldown` (from `liveProgress`: `COOLDOWN`/`BATCH_REST` become a chip on `nextPendingId`, `RATE_LIMIT` becomes a chip on items with status `COOLDOWN`). The "Added" column reads `createdAt` (SQLite: UTC without a zone; PostgreSQL: ISO). All changes go through the existing SSE.
- **Provider interface** (object in the registry): `id`, `label`, `prefix`, `isDefault`, `transport` (`'node'` or `'curl'`), `origin`, `urlPatterns` (gallery URL regexes, group 1 = key content), `makeKey(body)`, `buildUrl(key)`, `imageHeaders()`, `fetchMeta(key, { fetchText })` -> `{ title, numPages, ext, pageExts, langStr, authorStr, extraMeta, pageUrls(n) }` with `pageUrls(n)` returning candidates `[{ ext, url }]` per page. Prefixed galleries are downloaded by the engine through the provider (page by page, no filter: all announced pages are downloaded); site A still uses the legacy API/CDN path. `transport: 'curl'` (site C) makes the engine use `curlFetchText`/`curlDownloadToFile` in `core/providers/http.js`: site C's CDN serves a challenge page to Node's HTTP stack but not to the system `curl` (site A uses `curl` for the same reason). The error contract is the same as the Node helpers (non-200 HTTP -> `err.statusCode`; network failure/timeout -> Error without `statusCode`), so the per-candidate 404 fallback still applies. Plain `curl` only: array arguments without a shell, normal DNS, no impersonation or challenge solving.
- **Input parsing**: `core/db/listParser.js` calls `resolveInput()`; unrecognized lines are skipped and counted in `ignored`.
- **Schema v3 migration**: the `gallery_id` column changes from `INTEGER`/`BIGINT` to `TEXT` in both adapters; old rows are converted to numeric text without data loss. Export/import still carries the public `gallery_id` (a number for site A).
- **Content type (comic/manga/other)**: the B1/B2/C providers fetch the site's category slug (`extraMeta`/`meta.category`; categories that cannot be found are recorded in `categoryError`, only a `[CATEGORY]` log warning without failing the download) and `core/providers/contentType.js` maps it: `western`, `porn-comic`, `comic` -> `comic`; `manga`, `doujinshi` -> `manga`; other valid slugs -> `other`; missing/invalid -> `null`. The type folder name comes only from a fixed table (`Comic`/`Manga`/`Other`), never from remote text. Prefixed source folder layout: `<base>/<Type>/<Language>/<Author>/<Title>`; site A is unchanged (`<base>/<Language>/<Author>/<Title>`). The type is stored in `queue.category` (nullable `TEXT` column; holds the type, not the raw slug) and `library.meta.contentType`; both are included in export/import. `findExistingOnDisk` (the 429 fallback that runs before metadata exists, so without type input) scans the base folder and all existing type folders (`Comic`/`Manga`/`Other`). A complete copy of a provider gallery stored in the OLD layout without a library row is downloaded again into the typed layout (a library row matching by id still stops the download). The UI shows a type badge and a **Type** filter in the queue and library (filters whose type no longer exists are ignored).
- **Schema v4 migration**: adds the `queue.category TEXT` column in both adapters; old rows are `NULL`; export/import carries `category`.
- **Folder name**: if the title is empty, the folder name is derived from the key via `safeKeyName()` (`core/engine.js`) so a `:` never appears in the path (invalid on Windows).

---

## 3. Core Engine (`core/engine.js` — `DownloaderEngine`)

Extends `EventEmitter`. Manages the queue, anti-rate-limit, and downloading.

### Main Properties
- `baseDownloadDir`: Output folder (site A: `<base>/<Language>/<Author>/<Title>`; prefixed sources: `<base>/<Type>/<Language>/<Author>/<Title>`). Filled from the constructor options, `DOWNLOAD_DIR`, or `<repo>/Download`, then overridden by `settings.downloadDir` through `applySavedSettings()` on startup (unless `DOWNLOAD_DIR` is set).
- `downloadFormat`: `'cbz'` (default) | `'zip'` | `'folder'`.
- `autoContinueBatches`: `boolean` (default `true`).
- `batchSize`: `50` galleries before a batch rest (`batchRestMinutes`: `5` minutes).
- `concurrency`: `3` parallel pages per gallery.
- `isRunning`, `isPaused`, `isStopped`, `forceRetry`: Execution control flags.
- `currentProgress`: Active progress snapshot (read by `/api/status` and pushed via SSE `progress`).
- `downloadDirUnavailable` + `statusReason`: download folder safeguard. When the folder is missing/not mounted (`isDownloadDirHealthy` fails), `getStatus()` returns the reason text (e.g. `Download folder unavailable`) instead of `IDLE`/`RUNNING`, the run is aborted, and a check timer (`healthCheckIntervalMs`, default 60 seconds) runs `checkDownloadDirRecovery()` until the folder is healthy again. The folder is considered unhealthy if it does not exist, is not a directory, is empty while `library` has active entries, or >50% of ≥10 library entries are missing from disk. Manual recovery: fix the mount/`DOWNLOAD_DIR`, then run **Library → Rescan** (`POST /api/library/rescan`); a successful rescan clears the flag. Restarting the server also runs a startup rescan.
- `getStatus()`: `'IDLE'` | `'RUNNING'` | `'PAUSED'` | `'COOLDOWN'` (anti-ban pause/batch rest) | `'COOLDOWN_429'` (rate limit) | the `statusReason` text when the folder is unavailable.
- `consecutiveRateLimits`, `circuitBreakerTripped`: 429 protection state. Cooldown 5m -> 10m -> 20m (doubling on each hit, max 60 minutes); the 4th consecutive hit trips the circuit breaker and the engine automatically `pause()`s. Applies the same to 429/503 from non-default sources.

### Events Emitted by `DownloaderEngine`
| Event | Payload | Notes |
|---|---|---|
| `'batch_start'` | `{ total, pending, skipped }` | When `runBatch()` starts |
| `'progress'` | `currentProgress` (`{ galleryId, title, percent, completed, total, taskNum, totalTasks, activePages, speedKBps, stalled, stalledSeconds, live: true }`) | Heartbeat every 1 second or when a page finishes |
| `'cooldown'` | `currentProgress` (`{ type: 'COOLDOWN' \| 'BATCH_REST' \| 'RATE_LIMIT', title, message, percent, remaining, total, taskNum, totalTasks }`) | Tick every 1 second during the wait |
| `'done'` | `{ galleryId, title, pages, currentTaskNum, totalTasks }` | One gallery finished downloading (via API, CDN, or provider) |
| `'skipped'` | `{ galleryId, title, currentTaskNum, totalTasks, reason }` | Gallery skipped (in library / on disk / 404) |
| `'gallery_stopped'` | `{ galleryId, pagesDone, pagesTotal, deleted }` | An `ON_PROGRESS` gallery stopped at a page boundary (per-item pause/delete) |
| `'error'` | `{ galleryId, error, currentTaskNum, totalTasks }` | Gallery failed (`server/index.js` attaches a listener so it does not crash) |
| `'rate_limit'` | `{ galleryId, waitSeconds, consecutiveRateLimits }` | When HTTP 429 is hit |
| `'circuit_breaker'` | `{ galleryId, consecutiveRateLimits }` | After 3 consecutive cooldowns, the 4th hit trips it (engine automatically `pause()`s) |
| `'batch_complete'` | `{ processed }` | When `runBatch()` finishes |
| `'download_dir_unavailable'` | `{ reason, downloadDir }` | Download folder is unhealthy |
| `'paused'` / `'resumed'` / `'stopped'` / `'restarted'` / `'retry_triggered'` / `'config_updated'` | Optional object | Engine state changes |

`server/index.js` forwards these to SSE `engine`: `paused`, `resumed`, `stopped`, `restarted`, `batch_start`, `batch_complete`, `circuit_breaker`, `config_updated`, `download_dir_unavailable`, plus `progress` and `cooldown` to SSE `progress`.

### `processGallery(galleryId)` Flow — site A path; prefixed galleries use the provider path (see 2a)
1. Set status `ON_PROGRESS` in the `queue` table.
2. Check the `library` table: if valid on disk (`verifyImage` >= 2KB for each page or the `.cbz`/`.zip` file exists), return `SKIPPED - Already in Library` immediately (0 network requests).
3. Call `fetchMetadata(galleryId)`:
   - **API-first** (`core/nhentaiApi.js` -> `GET /api/v2/galleries/<id>` via `curl --resolve certain.site:443:104.26.4.188`). Uses `title.pretty` for the file name.
   - **HTML scrape fallback** (`fetchMetadataViaHtml`) if the API fails.
   - If `RATE_LIMIT` (429; for non-default providers, 429/503 status from `fetchMeta` is mapped to `RATE_LIMIT` by `fetchProviderMetadata`), first check the title cache + `findExistingOnDisk()` to avoid the 5-minute cooldown if the file actually already exists on disk.
4. Check whether an archive/folder already exists in `parentDir` (`<base>/<Lang>/<Author>/`).
5. **API Archive Download fast path** (`tryApiArchiveDownload`): if `NHENTAI_API_KEY` is set and the target format is `cbz`/`zip`, request a presigned download URL from API v2. If it fails, fall back to per-page CDN.
6. **Per-page CDN Download**:
   - Parallel download (`concurrency = 3`) from `i1..i4.certain.site` (pinned to IP `104.26.4.188`).
   - If a page fails verification (`< 2KB`) 5 times in a row and its size is `< 1536` bytes (CDN block placeholder), substitute a valid white PNG using `writeBlankPlaceholderImage()` and log it to the `events` table.
   - After all pages finish, save to the `library` table, write `.nhdl-id`, and call `maybeCompress()` if the batch format is `cbz`/`zip`.

Prefixed galleries: `fetchProviderMetadata` picks the transport (`node` or `curl`) per provider, `downloadProviderPage` tries the URL candidates per page (a 404 on one candidate moves on to the next), then the save/library/marker path is the same as above with a typed folder (see 2a).

---

## 4. REST API & SSE Contract (`server/index.js` & `docs/API.md`)

Default port: `8080`. The full request/response specification and SSE payloads are in [`docs/API.md`](API.md); the table below is only a short map.

| Method | Endpoint | Function |
|---|---|---|
| `GET` | `/api/events` | SSE stream: initial `snapshot`, then `item` deltas (`dbEvents`), `progress`, `engine`, and `reloaded` after import/restore |
| `POST` | `/api/login`, `/api/logout` | Session (cookie `nhdl_session`, HttpOnly, 30 days) when `NHDL_PASSWORD` is set |
| `GET` | `/api/status` | Compatibility endpoint: `{ items, batchCount, rawList, errors, liveProgress, engineStatus, autoContinueBatches }` |
| `POST` | `/api/queue`, `/api/queue/import` | Import list text; `/api/queue` replaces the whole queue, `/import` adds. Returns `added`, `updated`, `duplicates`, `ignored`, `galleryIds`, `total` |
| `GET` | `/api/queue/export` | Export the queue as `list.txt` |
| `POST` | `/api/queue/pause`, `/resume`, `/delete`, `/priority` | Per-item control (`ids`), priority `top`/`up`/`down`/`bottom` |
| `POST` | `/api/control` | `{ action: 'pause' \| 'stop' \| 'resume' \| 'start' \| 'restart' }` (`stop` = `pause`, `start` = `resume`) |
| `POST` | `/api/retry` | `{ galleryId? }`: skip cooldown; with `galleryId`, return that item to `PENDING` |
| `GET` / `POST` | `/api/config`, `/api/config/verify-key` | Settings (`downloadDir`, `downloadFormat`, `autoContinueBatches`, `apiKey`, backup schedule) and the `sources` list |
| `GET` | `/api/library` | Library entries (`source`, `category`, etc.) |
| `POST` | `/api/library/rescan`, `/rename`, `/compress`, `/batch-compress` | Marker rescan, rename, compress one/many galleries (background job) |
| `GET` | `/api/library/compress-status` | `{ job }` batch compress progress |
| `GET` | `/api/logs`, `/api/logs/download` | Activity log (`?galleryId=&limit=` for one gallery) and `.log` download |
| `GET` | `/api/fs/browse?path=...` | Directory browser for the folder picker |
| `GET` / `POST` / `DELETE` | `/api/db/info`, `/export`, `/import`, `/backup`, `/backups`, `/restore`, `/backups/:name` | Database management (info, JSON export/import, backup, restore) |

---

## 5. Frontend Map (`webui/src`)

Svelte 5 (runes: `$state`, `$derived`, `$props`, `$effect`; no `$:`/`export let`). All HTTP goes through `lib/api.js`; all state goes through `lib/stores/app.svelte.js` (`appStore`).

- **`App.svelte`** (90 lines): assembles `Toolbar`, `SidebarFilter`, `VirtualQueueTable`, `DetailPanel`, `StatusBar`, dialogs (`AddDialog`, `DeleteConfirmDialog`), and modals (`FolderPickerModal` = Settings, `LibraryModal`, `LogsModal`), plus `Toast`. On mount it calls `appStore.loadConfig()` and `appStore.connectSSE()`.
- **Store** (`app.svelte.js`): `SvelteMap` of items per `galleryId` (string key), `EventSource('/api/events')` client with backoff reconnect and a 3-second polling fallback (`sseStatus: 'polling'`), `applySnapshot`/`applyItemEvent`/`applyProgressEvent`/`applyEngineEvent`, status/type/source/batch filters, sort, selection (click/Ctrl/Shift/Ctrl+A), and derived `nextPendingId` + `cooldown` from `queueView.js`. `appStore.sources` comes from `GET /api/config` -> `sources`.
- **Toolbar**: Add (paste/upload `list.txt`), Resume, Pause, Delete, priority, Skip Cooldown & Force Retry, Start/Pause and Restart engine, Library, Settings, Logs, Logout (when login is active).
- **SidebarFilter**: status filters (All, Downloading, **Queue** = `PENDING` + `ON_PROGRESS`, Completed, Stopped, Failed), a **Source** section (appears if there is ≥1 source), a **Type** section (only existing types; filters whose type no longer exists are ignored), and the Batch list.
- **VirtualQueueTable**: in-house virtualization (`32px` rows, overscan `±10`), columns `#`, Title, ID, Status, Progress, Pages, Speed, ETA, Batch, Format, **Added** (`createdAt`); sortable, resizable (widths in `localStorage`), source badge and type badge on rows, blue accent marker for `ON_PROGRESS`, cooldown countdown chip in the Status cell, right-click context menu. `< 768px` mode: 3 columns.
- **DetailPanel**: General / Pages / Log tabs (`/api/logs?galleryId=`). **StatusBar**: engine status (including the folder-unavailable warning), counters, speed, SSE status.
- **LibraryModal**: library list with source/type filters, rescan, inline rename, compress one/many galleries (polling `compress-status`).
- **FolderPickerModal** (Settings): General tab (download folder, format, auto-continue batch, API key) and Database tab (info, export/import, backup, restore, backup schedule).
- **Pure helpers** in `lib/` (tested in `test/webui*.test.js`): `sources.js`, `queueView.js`, `contentType.js`.
- **Leftover components not imported by `App.svelte`**: `Header`, `HudPanel`, `QueuePanel`, `BatchGroup`, `QueueItem`, `RightSidebar`, `DeleteBatchModal` (not referenced from the active tree).

---

## 6. Architecture Principles & Rework History (`docs/PLAN.md`)

1. **All state in the DB** (`queue`, `library`, `settings`, `events`, `schema_version`); `.env` stays a file for secrets; `list.txt` is only import/export.
2. **Changes flow DB -> SSE**: every `queue` row mutation emits `dbEvents`, and `/api/events` forwards it as a delta to the UI. No polling (except the fallback when SSE is unavailable).
3. **Two database adapters**: `core/db.js` picks `core/db/postgres.js` when `DATABASE_URL` is set (the `pg` driver is the only backend runtime dependency; an exception to the zero-dependency rule), or `core/db/sqlite.js` (default). Schema and migrations are compatible; `gallery_id` is `TEXT` in both since v3, `created_at`/`updated_at` use `TIMESTAMPTZ`/`now()` in PostgreSQL, pool max 10 connections with a 60-second startup retry. Minimal privileges are documented in `docs/POSTGRES.md`.
4. **Multi-source through providers** (`core/providers/`): a new source = one provider registered in the registry; the engine does not need to know site details.
5. **Rework Phases 0–8** (CLI removed, SQLite, SSE, Svelte 5 + virtual table, PostgreSQL + backup/export/import, AI agent guide) are done; Phase 6 (Go backend) was cancelled. Details and log are in `docs/PLAN.md`.
