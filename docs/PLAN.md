# NHDL Rework Plan

Goal: keep the UI smooth when handling 1000+ queue items, with a qBittorrent/IDM-style layout.
The Go backend is only built if the Phase 5 benchmark shows a bottleneck in the backend.

Status: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` cancelled

## Initial diagnosis (2026-09-27)

Lag with 1000 items comes mainly from the frontend:
- All rows are rendered at once (no virtualization).
- Polling `/api/status` every second triggers recomputation of `activeBatchNum → batches → visibleBatches`
  for the whole list, even when no item status changed.
- `filterItems()` is called twice per batch; `animate:flip` re-measures all rows.
- `App.svelte` is monolithic (~1766 lines).

Backend: `/api/status` reads and parses `list_status.txt` from disk on every request,
then sends the whole list even when nothing changed.

## Phase 0 — Preparation
- [x] Remove the CLI (`cli/` and the old router at the root); the entry point becomes `server/index.js`
- [x] Create this plan document + `docs/CHANGELOG.md` + `AGENTS.md` (logging rules for all agents)
- [x] `core/utils.js`: raw control characters in the `sanitizeName` regex replaced with escapes (git previously treated this file as binary)
- [x] Remove `webui/src/lib/Counter.svelte` (leftover Vite template)
- [x] `start.bat`: build the Web UI automatically if `webui/dist` does not exist
- [x] Create the `rework` branch for Phase 1 onward; `main` stays stable for use

## Phase 1 — Move all data to SQLite
Goal: remove text/JSON file-based state (source of fs write bugs, duplicates, and per-second re-parsing).

Decisions:
- Use the built-in `node:sqlite` module (still zero dependency). Do not use `better-sqlite3` (native build, problematic on alpine).
- DB file: `data/nhdl.db`, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`.
- `.env` (API key) **stays as a file**, not moved into the DB.
- `list.txt` is only for import/export, not for storing state.
- No migration of old data. The `library` table is repopulated through a download folder rescan (marker files, see `core/tracker.js`).

Initial schema:
```sql
CREATE TABLE queue (
  id           INTEGER PRIMARY KEY,
  gallery_id   INTEGER NOT NULL UNIQUE,
  url          TEXT    NOT NULL,
  title        TEXT,
  status       TEXT    NOT NULL DEFAULT 'PENDING', -- PENDING | ON_PROGRESS | DONE | ERROR | COOLDOWN | PAUSED | SKIPPED
  batch        INTEGER NOT NULL DEFAULT 1,
  priority     INTEGER NOT NULL DEFAULT 0,
  pages_done   INTEGER NOT NULL DEFAULT 0,
  pages_total  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  retries      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_queue_status ON queue(status);
CREATE INDEX idx_queue_batch  ON queue(batch);

CREATE TABLE library (
  gallery_id   INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  path         TEXT NOT NULL,
  pages        INTEGER,
  format       TEXT,                -- folder | cbz | zip
  language     TEXT,
  artist       TEXT,
  added_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- JSON-encoded
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  level       TEXT NOT NULL,       -- info | warn | error
  gallery_id  INTEGER,
  message     TEXT NOT NULL
);
CREATE INDEX idx_events_gallery ON events(gallery_id);

CREATE TABLE schema_version (version INTEGER NOT NULL);
```

Old file → table mapping:
| Old file | Table |
|---|---|
| `list.txt`, `list_status.txt`, `progress.json` | `queue` |
| `library.json` | `library` |
| `config.json` | `settings` |
| `activity.log`, `error.log` | `events` |

Tasks:
- [x] Raise the Docker base image to `node:24-alpine` (Dockerfile, both stages) and set `engines.node >= 22.13` in `package.json`
- [x] `core/db.js`: open the DB, run schema migrations (based on `schema_version`), export query functions (not raw SQL everywhere)
- [x] `core/tracker.js`: replace reading/writing `list_status.txt` and `library.json` with the `queue` and `library` tables
- [x] `core/engine.js`: fetch the next item from `queue` (status `PENDING`, ordered `priority DESC, id`), update status/progress per row; remove `progress.json`
- [x] Config: `config.json` → `settings`
- [x] Logger: `activity.log`/`error.log` → `events` (capped, e.g. keep the last 10k rows)
- [x] `server/index.js`: endpoints use DB queries; add `list.txt` import (upload/paste) and export
- [x] Rescan the download folder to populate `library`
- [x] Remove old code and files: `list_status.txt`, `progress.json`, `library.json`, `config.json`, `.txt` logs; add `data/` to `.gitignore` and a volume in `docker-compose.yml`
- [x] On startup, items with status `ON_PROGRESS` are returned to `PENDING` (a server that dies mid-download must not leave items stuck)
- [x] Test with the built-in `node:test` (`npm test`, no dependencies) in `test/`: `core/db.js` (schema migration, UNIQUE gallery_id), the `PENDING → ON_PROGRESS → DONE/ERROR` flow, reset on startup, `list.txt` import/export. Use a temporary DB, not `data/nhdl.db`
- [x] Manual test: add 1000 links, download a few, restart the server mid-download → status stays consistent
- [x] Phase 1 review fixes: (1) `requeueFailedItems()` to retry `ERROR`/`COOLDOWN`/`PAUSED` items with `retries < maxRetries`; (2) return `DONE`/`SKIPPED` items to `PENDING` + delete stale `library` entries when the file is already gone from disk during `importListText` or `_runBatchBody`; (3) one-time automatic migration from the old `config.json` to the `settings` table when `settings` is still empty

## Phase 2 — Backend: push deltas, not polling
- [x] Write `docs/API.md` first: all REST endpoints (method, path, body, response) and the SSE event format. The frontend (Phases 3–4) and the Go backend (Phase 6) must follow this contract
- [x] Every `queue` row change is emitted as an event from `core/db.js`
- [x] SSE endpoint `/api/events`: initial snapshot + delta events (`item`, `progress`, `engine`)
- [x] `/api/status` stays for compatibility until the frontend moves over
- [x] Tests for the SSE endpoint: initial snapshot + delta event after an `UPDATE` on `queue`
- [x] **A1 (Review)**: Safeguard for an unmounted download folder (`isDownloadDirHealthy(dir)`, abort `rescanLibrary()` if the folder is missing/empty or >50% of ≥10 entries are gone, skip the `DONE→PENDING` pre-pass in `_runBatchBody`, set the `downloadDirUnavailable` flag + `statusReason` text + SSE event; create the folder automatically when `library` is empty + auto-recovery every 60 seconds via `rescanLibrary()` once the disk is mounted again)
- [x] **A2 (Review)**: Isolate `initDb()` from the real `config.json` during tests (`legacyConfigPath` / `NHDL_LEGACY_CONFIG`)
- [x] **A3 (Review)**: Unit tests for the `_runBatchBody` pre-pass (`DONE` without a file → `PENDING`, valid `DONE` stays `DONE`, `ERROR` with `retries < 5` is processed again)

## Phase 3 — Frontend foundation
- [x] Migrate to Svelte 5 (runes `$state`, `$derived`, `$props`, `$effect`, no `$:` or `export let`)
- [x] Split `App.svelte` into components (`webui/src/lib/components/*.svelte`, `App.svelte` about 90 lines) + store (`webui/src/lib/stores/app.svelte.js`, `webui/src/lib/api.js`)
- [x] Replace polling with an SSE client (`EventSource('/api/events')` + reconnect backoff + 3s polling fallback)
- [x] **B3 (List optimization & Phase 3 verification)**: remove `animate:flip` from queue items/batches, compute `filteredItems` once per batch in `$derived`, prevent DOM rendering on `collapsed` batches, apply `content-visibility: auto`, and verify 1,000 items + real-time 2-tab sync via SSE (`import=86.6ms`, `2-tab snapshot=10.7ms`, `2-tab delta sync=19.9ms`, update payload `250B` vs `245KB` for `/api/status` on `main`)

## Phase 4 — qBittorrent/IDM layout
Phase 4 design decisions:
- **Client-side virtual table** (the plan for "data paged from the server" is dropped): the store already keeps all items in a `SvelteMap` per `galleryId`, synced with SSE delta events (`item`, `progress`, `engine`), so filtering, sorting, multi-select, and SSE updates are much simpler and instant (`< 50ms`) on the client without the load of paging requests to the server.
- Virtualization is written in-house (fixed row height `32px`, overscan `±10` rows) with no extra library.

Tasks:
- [x] **A (Backend)**: Status `STOPPED` & endpoints `POST /api/queue/pause`, `POST /api/queue/resume`, `POST /api/queue/delete`, `POST /api/queue/priority`, plus `GET /api/logs?galleryId=<id>&limit=<n>` + unit tests
- [x] **B1 & B2 (Toolbar & Sidebar Filter)**: Toolbar (Add dialog, Resume, Pause, Delete confirmation, Priority top/up/down/bottom, Start/Pause engine, Library, Settings, Logs) + real-time Sidebar filter (All, Downloading, Queued, Completed, Stopped, Failed, Batch list) + search box
- [x] **B3 (Virtual Table)**: Virtual table (`#`, Title, ID, Status, Progress, Pages, Speed, ETA, Batch, Format; sortable, resizable columns in `localStorage`, multi-select click/Ctrl/Shift/Ctrl+A, keyboard Up/Down/Delete/Space, right-click context menu)
- [x] **B4–B7 (Detail Panel, Status Bar, GSAP & Responsive)**: Tabbed detail panel (General / Pages / Log from the `events` table), Status bar (engine status including the `Download folder unavailable` warning, counters, speed, SSE connection), GSAP only for dialogs/context menu/toast/panel, and a responsive layout `< 768px` (drawer & bottom sheet)
- [x] **Phase 4 verification**: Test 5000 items with mixed statuses (`NHDL_DB_PATH`), table row DOM count (`23–34` rows, not 5000), render & filter-switch time `< 50ms` (`4.8ms–6.2ms`), scroll `0..159588px` without flicker, real-time 2-tab sync (`pause=4.8ms`, `resume=5.6ms`, `delete=7.2ms`), and make sure all old features still work (25/25 tests passed)

## Phase 5 — Benchmark
- [x] Measure FPS/CPU with 1000 and 5000 items, before vs after: 5000 items ~700 DOM elements (only visible rows rendered via the virtual table), back to the "All" filter 15ms, category filter 4–16ms, SSE payload ~250B per update vs ~245KB/second polling `/api/status` in the old UI
- [x] Decide whether Phase 6 is needed: Cancelled; the bottleneck was proven to be on the frontend side and is fully resolved through Svelte 5 runes + virtual table + SSE deltas; the Node backend is very light and not a constraint

## Phase 6 — (Optional) Go backend
- [-] Cancelled: the bottleneck turned out to be in the frontend and is resolved; the Node backend is not a problem, the SQLite schema & SSE events are already efficient

## Phase 7 — Centralized PostgreSQL + backup/export/import
Goal: on the server, data is stored in a centralized PostgreSQL (the shared Postgres used by all containers), so rebuilding a container does not delete data. SQLite stays the default for local use.

Decisions:
- Choose the database via env: `DATABASE_URL=postgres://user:pass@host:5432/nhdl` → PostgreSQL; empty → SQLite `data/nhdl.db`.
- The `pg` driver (the only backend runtime dependency, an exception to the zero-dependency rule).
- Use a dedicated `nhdl` schema/database in the shared Postgres, do not mix tables with other applications. Document the SQL to create the user + database with minimal privileges.
- `DATABASE_URL` contains a password → goes in `.env`/container env, not the `settings` table, and is never sent to the UI.
- The export format is **independent of the DB type** (JSON containing all tables + `schema_version`), so data can be moved SQLite ⇄ PostgreSQL through export/import.

Tasks:
- [x] Change the `core/db.js` API to async (all functions return a Promise) and update callers in `core/` and `server/`. SQLite stays behind it. **This is the biggest step because `node:sqlite` is synchronous while `pg` is async**
- [x] Split the adapters: `core/db/sqlite.js` and `core/db/postgres.js` with the same interface; `core/db.js` chooses based on `DATABASE_URL`
- [x] PostgreSQL schema and migration version: `datetime('now')` → `now()`/`timestamptz`, `INTEGER PRIMARY KEY` → `bigserial`/`identity`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, `PRAGMA table_info` → `information_schema`
- [x] Connection: pool, retry when Postgres is not ready at container start, a clear error message if `DATABASE_URL` is wrong
- [x] Endpoints (document in `docs/API.md` first): `GET /api/db/export` (JSON download), `POST /api/db/import` (JSON upload; *replace* or *merge* mode, in a single transaction), `POST /api/db/backup` + `GET /api/db/backups` (scheduled/manual backup to the `data/backups/` folder, keep the last N)
- [x] Automatic SQLite to PostgreSQL migration on startup when Postgres is still empty and `data/nhdl.db` is found (import the data then rename it to `nhdl.db.migrated`)
- [x] UI Settings → Database menu: DB type info + connection status (no password), Export button, Import (with confirmation and a replace/merge choice), Backup now, backup list + restore
- [x] `docker-compose.yml`: example `DATABASE_URL` to the shared Postgres (external network), drop the need for the `data/` volume in Postgres mode (except the backup folder)
- [x] Tests: the same `db` suite runs against SQLite and PostgreSQL (Postgres via `TEST_DATABASE_URL`, skipped if absent); export → import test produces identical data; import into the other DB type (SQLite → Postgres)
- [ ] Manual test on the server: rebuild the container → queue and library remain

## Phase 8 — README for AI agents
Goal: an AI agent (belonging to any user of this repo) can deploy, manage, modify, and maintain NHDL without reading all the source code.

Decisions:
- New file `docs/AI_AGENT.md`, written for agents to read: concise, made of steps and commands that can be run directly, no marketing narrative.
- Split with existing files: `AGENTS.md` = working rules when **developing** this repo (git, changelog, architecture patterns); `docs/AI_AGENT.md` = guide to **operating** the application (deploy, manage, maintain). `AGENTS.md` links to `docs/AI_AGENT.md` rather than duplicating its content.
- The main `README.md` gets a trigger block at the very top, e.g.:
  > **If you are an AI agent:** read [docs/AI_AGENT.md](docs/AI_AGENT.md) before deploying, managing, modifying, or maintaining this project.

Tasks:
- [x] **Deploy**: prerequisites (Node ≥ 22.13 / Docker), local (`start.bat`, `npm start`), Docker Compose, SQLite vs PostgreSQL mode (`DATABASE_URL`), full list of env vars with defaults, ports, and how to verify the server is healthy (endpoint + expected output)
- [x] **Manage**: how to add to the queue (UI, API, `list.txt` import), pause/resume, read logs (`events`), check and change the API key, database backup/export/import, `npm run check:archives`
- [x] **Modify**: short module map (links to `docs/ARCHITECTURE.md` and `docs/API.md`), the new-feature pattern DB → REST → SSE, how to add a schema migration, how to run tests
- [x] **Maintain**: version upgrade (pull, rebuild, automatic migration), symptom-based troubleshooting (Cloudflare challenge/403, ISP-blocked DNS, items stuck `ON_PROGRESS`, 429 rate limit, DB cannot connect), and things an agent **must not** do (delete `data/`/the DB volume, commit secrets, change git identity)
- [x] Trigger block in `README.md` + link from `AGENTS.md`
- [x] Validation: ask a new agent (clean session) to deploy and operate NHDL using only `README.md`; note the parts that confused it and fix the docs — run from a clean clone following `docs/AI_AGENT.md`: `npm install` + UI build 17 seconds, server start, `/api/db/info` and `/api/status` matched the documented output. Not yet tested by a new agent session

## Multi-source download
Goal: besides certain site ( ͡° ͜ʖ ͡°) (site A), NHDL can download from site B1, B2, and C through a single queue. Specification: `docs/superpowers/specs/2026-10-06-multi-source-download-design.md`.

Tasks:
- [x] API contract: prefixed `galleryId` format, the `source` field, and handling of unrecognized lines documented in `docs/API.md`
- [x] Provider registry (`core/providers/`) and prefixed canonical keys
- [x] Shared list parser (`core/db/listParser.js`) and schema v3 migration (`gallery_id` TEXT) in SQLite and PostgreSQL
- [x] Metadata and page URL providers: site B1/B2 (HTML) and site C (JSON API; real site C downloads via the curl transport, see the task below)
- [x] Engine: download prefixed galleries through the provider, pause/resume, rescan, and server hooks
- [x] UI: source badge and source filter in the queue, sidebar, and Library
- [x] Live tests: site B1 (240 pages, pause/resume) and site B2 (51 pages) passed
- [x] Site C: the image API answered 403 (Cloudflare challenge) for the Node client; solved with the system `curl` transport (`transport: 'curl'` in the provider), live test 17/17 images passed
- [x] Final review fixes: scheme-less URL resolution, provider 429/503 to backoff, image signature check, `ignored` display, per-source fallback URL, remote value validation, empty API = SKIPPED
- [x] Queue UI: "Queue" filter (PENDING + ON_PROGRESS), active row marker, cooldown chip, "Added" column
- [x] `samples/` (the user's manual samples) added to `.gitignore`; never committed

## Content type (comic/manga/other)
- [x] Category -> type mapping (`core/providers/contentType.js`) and category extraction in the B1/B2/C providers
- [x] Schema v4 `queue.category` + export/import
- [x] Typed folders in the engine and typed `findExistingOnDisk`, `meta.contentType` in the library
- [x] UI: type badge and Type filter
- [x] Offline parser verification against stored real markup (B1 manga, B2 western -> comic, C porn-comic -> comic)
- [x] live metadata check against the real sites (2026-10-06: site B1 manga, site B2 western -> comic, site C porn-comic -> comic, plus a real typed download under the Comic folder)
- [x] PostgreSQL adapter run against a real server (PG 18, throwaway instance): live suite 32/32 and 129/129 with the live env var, plus a v2 -> v4 upgrade check

## Log
| Date | Phase | Notes |
|---|---|---|
| 2026-09-27 | 0 | CLI removed, README/package.json/start.bat adjusted, plan created |
| 2026-09-27 | 1 | Decided: all data moves to SQLite (`node:sqlite`); schema added, other phases shift by +1 |
| 2026-09-27 | 0 | `docs/ARCHITECTURE.md` created & linked in `AGENTS.md` as the complete cross-session codebase reference |
| 2026-09-27 | 0 | Phase 0 done: `utils.js` fix, Counter removed, `start.bat` auto-build, `rework` branch. Plan: add tests, startup reset, `docs/API.md`, feature patterns |
| 2026-09-27 | 7 | Add Phase 7: centralized PostgreSQL (via `DATABASE_URL`) + backup/export/import in Settings |
| 2026-09-27 | 1 | Phase 1 done: full migration to SQLite (`core/db.js`, `queue`, `library`, `settings`, `events`), marker rescan, startup `ON_PROGRESS` reset, and 10/10 tests passed |
| 2026-09-27 | 8 | Add Phase 8: README for AI agents (`docs/AI_AGENT.md`) + trigger in the main README |
| 2026-09-27 | 2 | Phase 2 done: `docs/API.md` contract, SSE endpoint `GET /api/events` (`snapshot` + `item`/`progress`/`engine` deltas), and SSE tests passed (12/12) |
| 2026-09-27 | 1 | Fixed 3 regression bugs from the Phase 1 review (`requeueFailedItems`, reset `DONE` without a file + delete stale `library`, `config.json` migration to `settings`) + 3 new tests passed (15/15) |
| 2026-09-27 | 2 | Part A review fixes done: A1 (`isDownloadDirHealthy` + unmounted drive protection), A2 (`legacyConfigPath` isolation), A3 (unit tests for the `_runBatchBody` pre-pass) — 17/17 tests passed |
| 2026-09-27 | 3 | Phase 3 done: refactored `webui/` to Svelte 5 runes + `SvelteMap` store + SSE client (`/api/events`), split `App.svelte` into 10 components, optimized the 1,000-item list (SSE delta `250B` vs `/api/status` `245KB`, 2-tab sync `19.9ms`) — 18/18 tests passed |
| 2026-09-28 | 2 | A1 regression fix: create `DOWNLOAD_DIR` automatically when `library` is empty, keep protection when `library` has entries, and add an automatic recheck every 60 seconds while `Download folder unavailable` — 19/19 tests passed |
| 2026-09-28 | 2 | Auto-recovery bug fix: separate the boolean flag `downloadDirUnavailable` from the `statusReason` text and run `rescanLibrary()` on recovery so specific reasons (`empty folder` / `>50% missing`) still trigger auto-recovery — 20/20 tests passed |
| 2026-09-28 | 4 | **A (Backend)** done: `STOPPED` status (immune to `requeueFailedItems` & the pre-pass), safe stop at the page boundary for `ON_PROGRESS`, endpoints `/api/queue/pause`, `/api/queue/resume`, `/api/queue/delete`, `/api/queue/priority`, plus `/api/logs?galleryId=<id>&limit=<n>` — 24/24 tests passed |
| 2026-09-28 | 4 | **B1 & B2 (Toolbar & Sidebar Filter)** done: `Toolbar.svelte`, `AddDialog.svelte` (paste/upload `list.txt`/choose format), `DeleteConfirmDialog.svelte`, `SidebarFilter.svelte` (real-time counters & Batch list), and dark theme CSS variables in `app.css` |
| 2026-09-28 | 4 | **B3 (Virtual Table)** done: `VirtualQueueTable.svelte` (fixed `32px` rows, overscan `±10` rows, 10 sortable & resizable columns in `localStorage`, multi-select click/Ctrl/Shift/Ctrl+A, Up/Down/Delete/Space keyboard navigation, `< 768px` mode with 3 columns) + `ContextMenu.svelte` |
| 2026-09-28 | 4 | **B4–B7 (Detail Panel, Status Bar, GSAP & Responsive)** done: `DetailPanel.svelte` (3 tabs General/Pages/Log from `/api/logs?galleryId=`, resizable height in `localStorage`, GSAP collapse, `< 768px` bottom sheet), `StatusBar.svelte` (engine status + `Download folder unavailable` warning, counters, speed, SSE), `Toast.svelte`, and full integration in `App.svelte` (`npm run build:ui` 0 warnings) |
| 2026-09-28 | 4 | **Phase 4 verification** done: tested 5,000 items with mixed statuses (`PENDING`, `ON_PROGRESS`, `DONE`, `SKIPPED`, `STOPPED`, `ERROR`) in Chrome DOM + `test/sse.test.js` — row DOM element count only `23–34` rows (not 5,000), filter switch `4.8ms–6.2ms` (`< 50ms`), scroll `0..159,588px` smooth with no blank rows, real-time 2-tab SSE sync (`pause=4.76ms`, `resume=5.63ms`, `delete=7.23ms`), 25/25 tests passed |
| 2026-09-28 | 4 | Fixed the `updateQueuePriority` bug for queues `> 500` items: removed the 500 limit, swap neighbor priorities directly (`ORDER BY priority DESC, id ASC`) or normalize `total - idx` in 1 prepared-statement transaction, emit 1 SSE `reordered` event (`5,000 items < 200ms`), and handle it in the frontend store — 26/26 tests passed |
| 2026-09-28 | 4 | Fixed the SSE `reordered` event losing data (`server/index.js` `onDbItem`): forward all event fields to the SSE payload except `rawRow`, make sure the table re-sorts immediately when the `#` column is active and the selection stays attached to the same item, and tested at the SSE level in `test/sse.test.js` (27/27 tests passed) |
| 2026-09-28 | 5 & 6 | TASK 0: Phase 5 marked [x] done (5000 items ~700 DOM elements, back to the "All" filter 15ms, filter 4–16ms, SSE payload ~250B vs ~245KB/s). Phase 6 (Go) cancelled [-] because the frontend bottleneck is resolved and the Node backend is not a problem |
| 2026-09-28 | 7 | 7.1: Converted the whole `core/db.js` API to Promise/async, updated all callers in `core/` (`engine.js`, `tracker.js`, `logger.js`), `server/index.js`, scripts, and tests — 27/27 tests passed, `npm run build:ui` 0 warnings |
| 2026-09-28 | 7 | 7.2: Split the database adapters `core/db/sqlite.js` and `core/db/postgres.js`, dispatch in `core/db.js` based on `DATABASE_URL`, installed `pg` — 27/27 tests passed, `npm run build:ui` 0 warnings |
| 2026-09-28 | 7 | 7.3: Implemented the PostgreSQL adapter (`core/db/postgres.js`), 60-second pool retry, SQL dialect (`BIGSERIAL`, `TIMESTAMPTZ`, `now()`), credential masking in the startup log, and a minimal-privilege guide in `docs/POSTGRES.md` — 27/27 tests passed, `npm run build:ui` 0 warnings |
| 2026-09-28 | 7 | 7.4: Documented the contract in `docs/API.md`, implemented cross-database JSON export/import (`exportData`, `importData`), 7-file backup rotation in `data/backups/`, daily auto-backup when idle, and `/api/db/*` endpoints (`info`, `export`, `import`, `backup`, `backups`, `restore`, `delete`) — 30/30 tests passed, `npm run build:ui` 0 warnings |
| 2026-09-28 | 7 | 7.5: Automatic SQLite to PostgreSQL migration on startup when Postgres is empty and a local SQLite file is found, data transferred via replace mode then SQLite renamed to .migrated — 31/31 tests passed, `npm run build:ui` 0 warnings |
| 2026-09-28 | 7 | 7.6: Database tab in the Settings UI (DB info & connection status badge, Export JSON button, file dropzone & replace/merge import mode with safety confirmation, instant Backup trigger, and a local backup list with Restore & Delete actions) — 31/31 tests passed, npm run build:ui 0 warnings |
| 2026-09-28 | 7 | 7.7: Updated docker-compose.yml & .env.example (DATABASE_URL example, external network, explanation of the optional data/ volume) and cross-database tests (running schema migration v1->v2, SQLite export -> PostgreSQL import with data integrity verification, and the live Postgres suite via TEST_DATABASE_URL) — 33/33 tests passed, npm run build:ui 0 warnings |
| 2026-09-28 | 7 | Strict importData validation: reject invalid format/version/tables, check schemaVersion, validate gallery_id on each queue/library row, and protect against an empty replace without allowEmpty — 34/34 tests passed |
| 2026-09-28 | 7 | 409 protection on import/restore while the engine is running or any item is ON_PROGRESS, Pause Engine button in the UI, docs/API.md contract — 35/35 tests passed |
| 2026-09-28 | 7 | Automatic pre-import backup nhdl-backup-pre-import-<ts>.json before import/restore in replace mode, abort if the backup fails, shown in the response and UI — 36/36 tests passed |
| 2026-09-28 | 7 | Backup automation: scheduling via DB settings (backupIntervalHours, backupKeep, lastBackupAt), old file rotation, NHDL_BACKUP_DIR directory override, retry every 10m on failure, UI for schedule configuration and next backup estimate — 37/37 tests passed |
| 2026-09-28 | 7 | Auto-migrate backup: write a JSON backup from SQLite to the backup folder before the Postgres import, abort the migration and do not rename SQLite if the backup fails — 38/38 tests passed |
| 2026-09-28 | 7 | Empty reordered event removed, new reloaded/snapshot event emitted via SSE after a successful import/restore, UI store updates automatically — 39/39 tests passed |
| 2026-09-28 | 7 | pg driver type parser: registered an OID 20 parser (BIGINT/BIGSERIAL/COUNT(*)) so results are number instead of string — 40/40 tests passed |
| 2026-09-28 | 7 | Ran the live test suite against a real PostgreSQL (TEST_DATABASE_URL): schema migration, enqueue, done, library, export/import, invalid format protection, and number type verification — 41/41 tests passed (0 fail, 0 skip) |
| 2026-09-28 | 8 | Phase 8 done: `docs/AI_AGENT.md` (deploy/manage/modify/maintain, env vars checked against the code, troubleshooting, prohibitions for agents), trigger block in the README, link in AGENTS.md; validated from a clean clone |
| 2026-10-06 | Multi-source | Multi-source download: provider layer, prefixed keys, schema v3, `source`, UI badge/filter. Live tests site B1 (240/240 + pause/resume) and site B2 (51/51) passed; site C 403 for the Node client (open). 79 passed, 1 skipped, 0 failed |
| 2026-10-06 | Multi-source | Curl transport for site C (`curlFetchText`/`curlDownloadToFile`, `transport` field on the provider). Live test site C 17/17 passed. 84 passed, 1 skipped, 0 failed |
| 2026-10-06 | Multi-source | Final review fixes (scheme-less URLs, provider 429/503 to cooldown, image signature, `ignored` in log/toast, per-source fallback URL, remote value validation, empty API = SKIPPED). 96 passed, 1 skipped, 0 failed |
| 2026-10-06 | Multi-source | Queue display update (Queue filter = PENDING + ON_PROGRESS, active row marker, cooldown chip, Added column; UI only). 101 passed, 1 skipped, 0 failed |
| 2026-10-06 | Content type | Content type comic/manga/other: category mapping, schema v4, typed folders, UI badge/filter. Live check against the sites could not be run (DNS blocked); replaced by an offline parser check on stored real markup. 122 passed, 1 skipped, 0 failed |
| 2026-10-06 | Docs | Refreshed all documentation (README, API, ARCHITECTURE, AI_AGENT, PLAN, CHANGELOG) against the current code. 123 passed, 1 skipped, 0 failed (124 tests) |
