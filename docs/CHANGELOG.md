# Changelog

A record of all activity in this project, both manual changes and those made by AI agents.
Newest entries on top.

Format: `YYYY-MM-DD · Actor · Phase` followed by a list of changes.
Actor: `Manual (<name>)` or `AI (<agent/model>)`.

---

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Verification: real PostgreSQL and live metadata check
- The PostgreSQL adapter was run for the first time on a temporary PostgreSQL 18 server (localhost, dedicated port, removed afterwards): the live suite `test/db.test.js` passed 32/32, the whole `npm test` with `TEST_DATABASE_URL` passed 129/129, and an extra check of the schema v2 → v4 DB upgrade (`gallery_id` type becomes TEXT, `category` column, rows/priority preserved, numeric IDs stay numeric in the API, prefixed keys, import/export with `category`, idempotent `initDb`) passed. No adapter defects were found.
- Small note: `importData` in merge mode inserts events without dedup, so repeated imports duplicate event rows (not changed yet; may be intentional).
- Metadata check against the real sites (DNS now active): site B1 → manga category (manga type), site B2 → western (comic), site C → porn-comic (comic) via the curl transport with no `categoryError`. A real download from site B1 was saved to `Download/Comic/<Language>/<Author>/` with `contentType` in the library meta.

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Fix: saved settings applied on startup
- Bug: `downloadDir`, `downloadFormat`, and `autoContinueBatches` saved via `POST /api/config` into the `settings` table were never read when the server started, so after a restart they went back to `DOWNLOAD_DIR`/`./Download`, `cbz`, and `true`.
- `core/engine.js`: new method `applySavedSettings()` reads the three settings once the DB is ready. Folder priority: `DOWNLOAD_DIR` > `settings.downloadDir` > `./Download`. Invalid values (wrong type, unknown format) are ignored. It uses the same `setDownloadDir` path (`setStateDir`/`setLogDir`, folder not created if the library has entries, status `Download folder unavailable`); `setDownloadDir` gets an `{ persist: false }` option.
- `server/index.js`: `applySavedSettings()` is called when the server starts listening, before the library rescan, automatic backup, and queue auto-processing.
- New test `test/engineSettings.test.js` (5 tests: apply, env wins, invalid values, missing folder + non-empty library, no settings). Real boot check (temporary port, temporary DB and folder): settings survive a restart, and `DOWNLOAD_DIR` wins over saved settings.
- Documentation: the `DOWNLOAD_DIR` row in `README.md` and `docs/AI_AGENT.md`, plus `docs/ARCHITECTURE.md`, corrected to the new behavior.

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Documentation refresh
- All documentation (`README.md` and `docs/*.md`, except `docs/superpowers/`) was audited against the current code and updated; no changes to code, tests, or configuration.
- `README.md`: multi-source feature (site B1/B2/C in one queue), typed folders (comic/manga/other), Status/Source/Type filters, cooldown countdown chip, "Added" column, batch compress; input formats (URL without scheme, prefixed keys, `ignored`); env var table (`DOWNLOAD_DIR` only read at startup, `NHDL_LEGACY_CONFIG`); new Troubleshooting section (download folder unavailable, certificate error = ISP DNS, 429); project map adds `core/providers/`.
- `docs/ARCHITECTURE.md`: directory structure and line counts re-measured (all modules, 14 test files, webui components); the old "File State" section (`list.txt`/`library.json`/`config.json`) replaced by a description of the schema v4 DB tables and marker files; engine properties and events completed (`gallery_stopped`, `download_dir_unavailable`, folder guard, `getStatus()` values, circuit breaker limits); endpoint table completed; frontend map rewritten for Svelte 5 + SSE (not the 1766-line `App.svelte` with polling); the rework notes replaced by a summary of architecture principles.
- `docs/API.md`: the `LiveProgress` shape corrected to match the engine (two shapes: download and wait), `EngineStatus` corrected (no `STOPPING`; there are `COOLDOWN`/`COOLDOWN_429`/reason text), the `detail` field of the `engine` event, `category` in the `item` event example, the `createdAt` format per database, `stop`/`start` aliases on `/api/control`, `success` behavior on rescan, and the `LibraryItem` shape.
- `docs/AI_AGENT.md`: the `DOWNLOAD_DIR` row corrected (saved settings are not re-read on startup), module map (`listParser.js`, UI helpers), typed folder layout, and new troubleshooting rows (certificate/ISP DNS errors for other sources, `ignored` rows, correct circuit breaker limits, recovery from "Download folder unavailable" via Library Rescan).
- `docs/PLAN.md`: the `samples/` item marked done (already in `.gitignore`), `App.svelte` line count corrected, new Log row; the live check against the real sites item remains unchecked.
- `docs/CHANGELOG.md` and `docs/PLAN.md`: the old file name of the CLI router replaced with generic wording (the real name may only appear in code).
- `docs/POSTGRES.md`: checked against the adapter (pool 10, retry 2 seconds/60 seconds, migrations v1–v4); no changes.
- Test suite: 123 passed, 1 skipped (live PostgreSQL), 0 failed (124 tests).

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Content type (comic/manga/other)
- New module `core/providers/contentType.js`: site category slugs are mapped to a type (`western`/`porn-comic`/`comic` -> `comic`; `manga`/`doujinshi` -> `manga`; anything else -> `other`). The site B1/B2/C providers extract the category; extraction failures are recorded in `categoryError` without failing the download.
- Schema v4: `queue.category` column (SQLite and PostgreSQL), included in export/import. The library stores `meta.contentType`.
- Engine: prefixed-source galleries are stored in `<base>/<Type>/<Language>/<Author>/<Title>`; site A is unchanged. `findExistingOnDisk` scans the base folder and all type folders.
- UI: type badge and Type filter in the queue and library; a filter with a type that no longer exists is ignored, and the sidebar closes when a type is selected.
- A live check against the real sites could NOT be run (DNS was blocked, the certificate received did not belong to the site). Replaced by an offline check: the real parser was run against stored real markup/JSON, one gallery per source. Result: site B1 -> category `manga` -> type `manga` (240 pages, Japanese); site B2 -> `western` -> `comic` (51 pages, English); site C -> `porn-comic` -> `comic` (17 images, no `categoryError`; the site C detail response was supplied by a stub). The live check is still open.
- Test suite: 122 passed, 1 skipped (live PostgreSQL), 0 failed.

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Queue view update
- The sidebar filter "Queued" becomes **Queue** and now covers `PENDING` and `ON_PROGRESS` (items being downloaded stay visible in the queue; "Downloading" is only `ON_PROGRESS`, "Completed" is still `DONE`/`SKIPPED`). The status bar still counts only `PENDING` via `filterCounts.pending` so "Active" and "Queued" are not double counted.
- `ON_PROGRESS` rows get a blue accent marker on the left edge and a faint background.
- A yellow countdown chip (e.g. `⏱ 22s`) in the Status cell: on the first `PENDING` item in rank order during `COOLDOWN`/`BATCH_REST`, and on items with status `COOLDOWN` during a `RATE_LIMIT` 429 (format `m:ss`). Data comes from the existing `liveProgress` over SSE; no server/API changes and no polling.
- New desktop column **Added** (`createdAt`, last after Format, sortable, invalid dates always at the end). Local time `06 Oct 13:31`, tooltip `2026-10-06 13:31:45`; the SQLite format (UTC without zone) and PostgreSQL ISO are both parsed. Saved column widths are merged with the defaults so the new column always has a width.
- New pure helper `webui/src/lib/queueView.js` with test `test/webuiQueueView.test.js` (written first).
- The source badge now shows for all items (including the default source, with a fallback label for the default site if the server's source list is not loaded yet) in the queue and library; the sidebar "Source" section shows as long as there is at least one source. UI only, no server/API changes.
- Test suite: 101 passed, 1 skipped (live PostgreSQL), 0 failed.

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · curl transport for site C
- `core/providers/http.js`: `resolveCurlPath`, `curlFetchText`, and `curlDownloadToFile` (system `curl` via `execFile` with an argument array; HTTP status read via `-w`, download to `.part` then rename only on 200, HTTP errors carry `statusCode`). Added without changing the existing exports.
- Providers have a `transport` field: `'curl'` for site C, `'node'` for site B1/B2 and the default. `fetchProviderMetadata` and `downloadProviderPage` in the engine pick the helper according to `transport`; the per-candidate 404 fallback logic, placeholders, and retry are unchanged.
- Reason: the site C image API answers 403 (Cloudflare challenge) for the Node client, while the system `curl` with the same User-Agent/Referer gets 200. No impersonation, challenge solving, or DNS tricks.
- New tests for the curl helpers, transport selection, and engine downloads via curl from a local server. Live site C test (queue via API, temporary SQLite): 17/17 files (16 `.webp` + 1 `.jpg`, total bytes equal to the reference copy), no `.part`, no files < 2 KB, `pageExts` in the library equal to the files on disk, `.nhdl-id` marker contains the prefixed key, `source` field contains the source prefix.
- Test suite: 84 passed, 1 skipped (live PostgreSQL), 0 failed.

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Multi-source download
- **Provider layer (`core/providers/`)**: a registry of download sources with recognition of URLs/IDs/prefixed keys (`resolveInput`), the default provider (certain site ( ͡° ͜ʖ ͡°)) plus three new sources: site B1 and B2 (HTML gallery pages, per-page extension) and site C (slug + image JSON API). `http.js` provides the shared `fetchText` and `downloadToFile`.
- **Prefixed gallery keys**: `gallery_id` is now a canonical text key (`b1:...`, `b2:...`, `c1:...`; site A stays a plain number). `toPublicId()` returns a number for site A and a string for other sources, so the old API stays compatible. `core/db/listParser.js` parses `list.txt` lines through the registry; unrecognized lines are skipped and counted in `ignored`.
- **Schema migration v3** in SQLite and PostgreSQL: the `gallery_id` column becomes `TEXT` in `queue` and `library`; export/import still carry the public ID.
- **Engine**: prefixed galleries are downloaded through the provider (all announced pages, no filter), supporting per-page pause/resume, placeholders for pages that 404 on all candidates, per-page extensions recorded explicitly on resume, and safe folder names (no `:`).
- **`source` field** added to `/api/status`, `/api/library`, and the SSE `item` event; the contract is recorded in `docs/API.md`.
- **UI**: source badge in the queue table, sidebar, and Library, plus a source filter; the whole webui uses string keys.
- **Live tests** against three real sites (queue via API, temporary SQLite): site B1 240/240 pages and site B2 51/51 pages completed with no `.part` files, no files < 2 KB, extensions in the library equal to the files on disk, `.nhdl-id` marker containing the prefixed key, pause (72/240) then resume continuing to 240/240. Site C **failed**: its API answered 403 (Cloudflare challenge) for the Node client (`fetch`/`https`) while `curl` with the same headers passed; not patched in this entry and recorded as follow-up work in `docs/PLAN.md`.
- **Fixes from the final review**: schemeless lines (`host/g/123/`) are resolved to the right provider and foreign hosts no longer fall back to a site A ID (counted as `ignored`); 429/503 from site B/C go into the same cooldown/circuit breaker as site A; image downloads check the file signature (HTML block/challenge pages are rejected instead of being saved as images); the `ignored` count appears in the activity log and toast; per-source fallback URL when `url` is empty (enqueue/import); `load_server`/`load_dir`/`load_id` values are validated before building the URL; a site C API response with no images becomes a permanent SKIPPED; doc corrections (`galleryId`, `stopping`, `source` example, note on the original prefix in `docs/AI_AGENT.md`).
- Test suite: 96 passed, 1 skipped (live PostgreSQL), 0 failed.

## 2026-10-06 · Manual (Maja) · Multi-source download
- Requested download support from several sources (three additional sites) and provided manual samples as a comparison for the live tests.

## 2026-09-28 · AI (Claude Code, Opus 5.5) · Phase 8
- Added `docs/AI_AGENT.md` (in English) for AI agents: prohibitions without user permission, deploy (local, Docker, SQLite vs PostgreSQL, auto-migration), an env var table checked against the code, health checks with expected output, management via the API (queue, priority, logs, API key, backup/export/import/restore), module map and the DB → REST → SSE feature pattern, and a troubleshooting table per symptom.
- `README.md`: an "If you are an AI agent" trigger block at the very top.
- `AGENTS.md`: link to `docs/AI_AGENT.md`, and the architecture rules updated for async DB + two adapters (schema migration required in both SQLite and Postgres).
- Validation: the deploy steps were followed from a clean clone (setup 17 seconds), and the health check matches the doc.

## 2026-09-28 · Manual (Maja) · Phase 8
- Asked for Phase 8 to be done directly by Claude Code.

## 2026-09-28 · AI (Claude Code, Opus 5.5) · Release
- **Fix container crash:** the `Dockerfile` did not install backend dependencies even though `core/db.js` always loads `pg`, so the container failed to start ("Cannot find module 'pg'") even in SQLite mode. Now `npm ci --omit=dev` runs in the image, and `.dockerignore` was added so the local `node_modules`, `data/`, and `.env` do not end up in the image.
- `start.bat`: automatically installs backend dependencies if `pg` is missing.
- `docker-compose.yml`: the `DATABASE_URL` example changed to the correct env list format (`- DATABASE_URL=${DATABASE_URL}`), with the value taken from `.env`.
- `README.md` rewritten to match the current state: qBittorrent/IDM dashboard, SSE, SQLite/PostgreSQL, backup/export/import, env var table, and Docker + Postgres steps.
- Merge `rework` into `main` (fast-forward): Phase 5 (closed), Phase 6 (cancelled), and Phase 7 (PostgreSQL + backup/export/import).
- Phase 7 review before merge: 40/41 tests passed (1 live Postgres test skipped on the review machine); invalid imports are rejected without changing data; automatic backup before import replace; a clean server can start after `npm ci --omit=dev`.

## 2026-09-28 · Manual (Maja) · Release
- Asked for the README to be updated, then approved the Phase 7 merge into `main`.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **Running the real live PostgreSQL test suite (`test/db.test.js`, `docs/PLAN.md`)**:
  - Ran a local PostgreSQL 18.6 instance and the `nhdl_test` test database.
  - Ran the full test suite with the config `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/nhdl_test`.
  - Tested live schema migration (v1 -> v2), queue enqueue, `DONE` status update, library entry addition, data export, data cleanup, and protection against invalid import payloads.
  - Validated that the OID 20 type parser returns the `number` type for `gallery_id`, `id`, and `COUNT(*)` in live queries against a real PostgreSQL engine.
  - Result: all 41 tests passed with none skipped or failed (`41 pass, 0 fail, 0 skipped`).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **Registering the PostgreSQL OID 20 type parser driver (`core/db/postgres.js`, `test/db.test.js`)**:
  - Registered the custom parser `pg.types.setTypeParser(20, v => parseInt(v, 10))` in `core/db/postgres.js`.
  - Converts PostgreSQL `int8` / `BIGSERIAL` / `BIGINT` / `COUNT(*)` values into the JavaScript `Number` type instead of `String`.
  - Prevents data type inconsistencies when comparing `item.gallery_id === 123` in the backend and frontend.
  - Added unit/integration tests in `test/db.test.js` and verified that parsing of `COUNT(*)`, `gallery_id`, and `id` yields `number` (40/40 tests passed).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **Remove empty Reordered event & emit new Reloaded/Snapshot event after Import/Restore (`core/db/sqlite.js`, `core/db/postgres.js`, `server/index.js`, `docs/API.md`, `webui/src/lib/stores/app.svelte.js`, `test/sse.test.js`)**:
  - Removed the emission of the `item` event of type `reordered` with `items: []` at the end of `importData()` in the SQLite and PostgreSQL adapters.
  - Replaced with emitting a `reloaded` event from `dbEvents` whenever an `importData` operation (or `restoreBackup`) completes successfully.
  - In `server/index.js`, catch the `reloaded` event from `dbEvents` and emit the SSE `snapshot` and `reloaded` events carrying the latest queue state to all active SSE clients.
  - In the frontend store `webui/src/lib/stores/app.svelte.js`, added a listener for the SSE `reloaded` event that calls `applySnapshot()` and `refreshLibraryIndex()`, so the UI syncs immediately without a browser page refresh.
  - Updated the SSE event documentation in `docs/API.md`.
  - Added unit/integration tests in `test/sse.test.js` verifying that no empty `reordered` event occurs and that a fresh snapshot payload is received on the SSE event when `importData` runs (39/39 tests passed, UI build 0 warnings).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **Automatic pre-migration backup on SQLite to Postgres auto-migrate (`core/db/auto-migrate.js`, `test/db.test.js`)**:
  - Before SQLite data is imported into PostgreSQL in replace mode, the system creates a JSON backup file `nhdl-backup-pre-migration-<ts>.json` in the active backup folder (`data/backups/` or `NHDL_BACKUP_DIR`).
  - If creating the backup fails, the automatic migration is aborted immediately (`return false`), data is not imported into PostgreSQL, and the original SQLite database file is not renamed to `.migrated`.
  - Returns the `preMigrationBackup` property in the migration result and prunes old backups via `rotateBackups()`.
  - Added unit/integration tests in `test/db.test.js` verifying creation of the pre-migration backup file, JSON format validity, and migration cancellation without damaging or renaming the SQLite file when the backup fails (38/38 tests passed).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **Database backup automation & scheduling (`core/db/backup.js`, `core/db.js`, `server/index.js`, `docs/API.md`, `webui/src/lib/components/FolderPickerModal.svelte`, `webui/src/lib/api.js`, `test/db.test.js`)**:
  - Automatic backup schedule configuration via DB settings: `backupIntervalHours` (default 24 hours, 0 = disabled), `backupKeep` (default 7 retained files).
  - Store the last backup timestamp in the `settings` table (`lastBackupAt`) so the schedule does not reset every time the server/container restarts.
  - The scheduler is safe to run while the engine is active (database reads do not interfere with downloads); on failure, the system retries every 10 minutes.
  - Support a custom backup folder through the environment variable `NHDL_BACKUP_DIR`.
  - Backup retention pruning (`rotateBackups`) automatically keeps the newest `backupKeep` backup files and deletes the oldest.
  - Added a "Scheduled Backups" settings card in the Web UI Database tab, with an interval-hours input, retention quota, estimate of the next backup time, and the active backup folder location.
  - Added unit and integration tests in `test/db.test.js` to verify scheduling, rotation, rejection when disabled (interval 0), the `NHDL_BACKUP_DIR` override, and the API endpoints `/api/config` & `/api/db/info` (37/37 tests passed, UI build 0 warnings).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **Automatic pre-import / pre-restore backup in Replace mode (`server/index.js`, `docs/API.md`, `webui/src/lib/components/FolderPickerModal.svelte`, `test/db.test.js`)**:
  - Implemented automatic creation of `nhdl-backup-pre-import-<ts>.json` in `POST /api/db/import` and `POST /api/db/restore` before data is cleared in `replace` mode.
  - If creating the backup fails, the import/restore is cancelled and the server returns a 500 error.
  - The backup file name (`preImportBackup`) is included in the JSON response and shown in the toast notification and the Database modal banner.
  - Added unit/integration tests in `test/db.test.js` to verify creation of the pre-import backup file and the integrity of its data (36/36 tests passed, UI build 0 warnings).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **409 Conflict protection for Import/Restore while the engine is running (`server/index.js`, `docs/API.md`, `webui/src/lib/api.js`, `webui/src/lib/components/FolderPickerModal.svelte`, `test/db.test.js`)**:
  - Documented the 409 response on `/api/db/import` and `/api/db/restore` in `docs/API.md`.
  - The server rejects database import and restore requests with `409 Conflict` and the message `"Pause engine first"` (`needsPause: true`) if `engine.isRunning` or there are queue items with status `ON_PROGRESS`.
  - The Settings Database UI shows an interactive warning banner and offers a "Pause Engine" button directly to stop the download engine before starting a database import/restore.
  - Added unit/integration tests in `test/db.test.js` to verify the 409 rejection both when the engine is running and when there are ON_PROGRESS items (35/35 tests passed, UI build 0 warnings).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **Strict importData validation before the database transaction (`core/db.js`, `core/db/common.js`, `core/db/sqlite.js`, `core/db/postgres.js`, `test/db.test.js`)**:
  - Implemented `validateImportPayload()` in `core/db/common.js`, executed before opening the database transaction in `core/db.js`, `core/db/sqlite.js`, and `core/db/postgres.js`.
  - Reject the import if `payload.format !== "nhdl-export"`, `version` is unknown (only version 1), `tables` is not an object, or any table is not an array.
  - Reject if the payload's `schemaVersion` (or `schema_version`) is newer than the app's schema version (`CURRENT_APP_SCHEMA_VERSION = 2`).
  - Validate that every row in the `queue` and `library` tables has a valid `gallery_id`; if any row is invalid, reject the whole import without opening a transaction.
  - Reject `replace` mode import if the file contains no `queue` or `library` rows at all, unless the explicit option `{ allowEmpty: true }` is given.
  - Added the property `format: 'nhdl-export'` to the `exportData()` output in the SQLite and PostgreSQL adapters.
  - Added comprehensive unit/integration tests in `test/db.test.js` verifying that old data stays intact when an import is rejected (34/34 tests passed).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **7.7 Docker Compose, Env Configuration & Cross-DB Tests (`docker-compose.yml`, `.env.example`, `core/db/postgres.js`, `test/db.test.js`)**:
  - Updated `docker-compose.yml` with an example `DATABASE_URL` configuration to a central (shared) PostgreSQL, documentation that the `data/` volume is optional when using PostgreSQL (only needed to keep local JSON backup files on the host), an example docker network connection, and ensuring the container still runs standalone with SQLite as the default.
  - Updated `.env.example` with documentation of the environment variables `DATABASE_URL` and `TEST_DATABASE_URL`.
  - Exported the `MIGRATIONS` array in `core/db/postgres.js` and supported `options.db` in `importData`.
  - Added cross-database tests to `test/db.test.js`:
    - Test stepwise PostgreSQL schema migration from version 1 to version 2 (verifying table creation, column additions, and indexes).
    - Test integrity of SQLite export to PostgreSQL import (verifying the structure of the `queue`, `library`, `settings`, `events` tables, query parameterization, and transactions).
    - Live PostgreSQL integration test that runs automatically when `TEST_DATABASE_URL` is available and is skipped gracefully when absent.
  - All tests passed (33 passed, 1 graceful skip, 0 failed) and `npm run build:ui` finished with 0 warnings.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **7.6 Database tab in the Web UI Settings modal (`webui/src/lib/components/FolderPickerModal.svelte`, `webui/src/lib/api.js`)**:
  - Added API client functions in `webui/src/lib/api.js` for `/api/db/info`, `/api/db/backups`, `/api/db/backup`, `/api/db/restore`, `/api/db/backups/:name`, and `/api/db/import`.
  - Added tab navigation in the Settings modal (`FolderPickerModal.svelte`): the `General & Downloads` tab (save format, batch behavior, API key, download folder browser) and the `Database` tab.
  - Implemented the `Database` tab:
    - A header with info on the active database, with a connection status badge (`Connected` / `Disconnected`), engine type (SQLite / PostgreSQL), and details of the file path (SQLite) or host:port/database with credentials masked (PostgreSQL).
    - Instant action buttons: `Export DB` (direct download of a cross-database JSON file) and `Backup Now` (instant backup snapshot into `data/backups/`).
    - An `Import Database` area with a drag-and-drop / file picker drop zone for JSON files, a mode selector `Merge (Skip duplicates)` vs `Replace all data`, a data-overwrite danger warning dialog, and a safety confirmation checkbox before execution.
    - A list of local backups in `data/backups/` showing file name, size, date, a `Restore` button (with safety confirmation), and a `Delete` button.
    - Full integration with Toast notifications (`appStore.showToast`), ARIA accessibility, and Svelte 5 runes (`npm run build:ui` 0 warnings, 31/31 tests passed).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **7.5 Automatic SQLite to PostgreSQL migration on startup (`core/db/auto-migrate.js`, `core/db.js`)**:
  - Implemented the automatic detection and migration module `core/db/auto-migrate.js` for when NHDL runs with PostgreSQL (`DATABASE_URL`).
  - If the PostgreSQL instance is still empty (the `queue` and `library` tables both have 0 rows) and the local database file `data/nhdl.db` has data, the system automatically exports all SQLite data (`queue`, `library`, `settings`, `events`) and imports it into PostgreSQL using `replace` mode in a single transaction.
  - After a successful migration, the local SQLite file is renamed to `data/nhdl.db.migrated` (and the related `-wal` and `-shm` files are cleaned up), the log message `[+] Migration complete...` is shown in the console, and an audit event is recorded in the `events` table.
  - Added unit tests in `test/db.test.js` to validate the automatic migration process and file renaming (31/31 tests total passed, `npm run build:ui` 0 warnings).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **7.4 Database Export, Import, Backup & Restore (`core/db/backup.js`, `server/index.js`, `docs/API.md`)**:
  - Documented the endpoint contract for `/api/db/info`, `/api/db/export`, `/api/db/import`, `/api/db/backup`, `/api/db/backups`, `/api/db/restore`, and `/api/db/backups/:name` in `docs/API.md` before implementation.
  - Implemented universal database export and import functions (`exportData`, `importData`) in `core/db/sqlite.js` and `core/db/postgres.js`, supporting `replace` mode (empties the tables then copies them back in a single transaction) and `merge` (`ON CONFLICT DO NOTHING`).
  - Created the backup management module `core/db/backup.js` storing backups at `data/backups/nhdl-backup-*.json`, with automatic rotation keeping the 7 newest backup files, restore, deletion, and a daily automatic backup scheduler when the engine is idle.
  - Wired all REST endpoints in `server/index.js` with reliable error handling and audit logging in the `events` table.
  - Added 3 new unit/integration tests in `test/db.test.js` verifying the full export-import cycle, backup rotation, data restore, and all HTTP endpoints (30/30 tests total passed, `npm run build:ui` 0 warnings).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **7.3 PostgreSQL Adapter implementation, Retry Pool & `docs/POSTGRES.md` guide**:
  - Implemented the whole PostgreSQL dialect in `core/db/postgres.js`: schema migration with `BIGINT`/`BIGSERIAL` data types for `id` and `gallery_id`, `TIMESTAMPTZ` with default `now()`, parameterized queries `$1, $2, ...`, `ON CONFLICT (gallery_id) DO NOTHING` / `DO UPDATE`, and `information_schema` queries.
  - Added a `connectWithRetry` mechanism on the `pg.Pool` connection pool (max 10 connections) that retries every 2 seconds for up to 60 seconds if PostgreSQL is not ready when the container starts.
  - Added password masking (`maskDatabaseUrl`) in the daemon startup log and the database info API so credentials are never exposed.
  - Created `docs/POSTGRES.md` with an SQL guide for setting up the `nhdl` user and database with least privilege, including PostgreSQL 15+ configuration.
  - Updated the architecture map in `docs/ARCHITECTURE.md` to record the `pg` dependency and the `core/db/` adapter structure.
  - All tests (27/27) passed and the UI build finished with 0 warnings.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **7.2 Splitting the database adapters (`core/db/sqlite.js` & `core/db/postgres.js`)**:
  - Installed the runtime dependency `pg` for PostgreSQL connections (the only backend runtime exception).
  - Extracted the SQLite implementation into `core/db/sqlite.js`, created the PostgreSQL adapter structure in `core/db/postgres.js`, and created the shared modules `core/db/events.js` (EventEmitter) and `core/db/common.js` (`normalizeGalleryId`, `formatQueueRow`, `maskDatabaseUrl`).
  - Turned `core/db.js` into a dispatcher that detects `DATABASE_URL` or an explicit `initDb()` option, exporting a consistent interface for all queue, library, settings, and activity log operations.
  - All tests (27/27) passed and the UI build finished with 0 warnings.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 7
- **7.1 Converting the `core/db.js` API to Async**:
  - Converted all functions exported from `core/db.js` to return Promises (`async`/`await`), including read functions, write functions, schema migrations, list text import/export, settings helpers, and event queries.
  - Adjusted all calling modules in `core/logger.js`, `core/tracker.js`, `core/engine.js`, `server/index.js`, and `scripts/find-bad-archives.js` to `await` DB calls consistently, with no unhandled rejections or dangling Promises.
  - Fixed the `hasActiveLibraryEntries` query to check the `format` column in the `library` table (`format IS NULL OR format != 'skipped'`), fixed the drive watcher shutdown in `test/db.test.js`, and removed the duplicate `initDb()` call in the `server/index.js` request handler.
  - All tests (27/27) passed without hanging and `npm run build:ui` finished with 0 warnings.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 5 & 6
- **TASK 0: Closing Phase 5 and cancelling Phase 6 in `docs/PLAN.md`**:
  - Phase 5 marked done `[x]`: testing a 5,000-item queue renders only ±700 DOM elements through the virtual table, switching back to the "All" filter takes 15ms, category filters 4–16ms, and the SSE update payload is only ±250B per update vs ±245KB/second of `/api/status` polling in the old UI.
  - Phase 6 (Go backend) cancelled `[-]`: the performance bottleneck proved to be in DOM rendering and frontend polling, which are now fully resolved; the Node.js backend proved lightweight, stable, and not an architectural constraint.

## 2026-09-28 · AI (Claude Code, Opus 5.5) · Release
- Merge `rework` into `main` (fast-forward): Phase 4 (qBittorrent/IDM layout, virtual table, per-item pause/resume/delete/priority, detail panel, status bar) is now in `main`.
- Reviewed before the merge: 27/27 tests passed; 5000-item browser test (~700 DOM elements, return to the "All" filter 15ms, scroll to the last item, 375px mobile view); Up/Down/Top/Bottom priority in a 1000-item queue is correct and updated in real time over SSE.

## 2026-09-28 · Manual (Maja) · Release
- Approved the Phase 4 merge into `main`.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 4
- **Fix for the bug where the `reordered` SSE event payload went missing in `onDbItem` (`server/index.js`, `test/sse.test.js`)**: changed the `onDbItem` handler in `server/index.js` to forward all event properties to the SSE payload (`const { rawRow, ...payload } = evt;`) except `rawRow` (internal raw DB row data). Previously, `onDbItem` only copied `item`, `galleryId`, `batch`, and `removedIds`, so the `items` field of the `reordered` event was dropped and the row order in the UI did not change until a reload. The virtual table order now re-sorts in real time across all tabs when the `#` column is the active sort, and the selection stays attached to the same item. Added an SSE-level unit test in `test/sse.test.js` verifying that `POST /api/queue/priority` ("up" and "top") emits a `reordered` event complete with `items` and without `rawRow` (27/27 tests total passed, `npm run build:ui` 0 warnings).
- **Fix for the `updateQueuePriority()` bug on queues of `> 500` items (`core/db.js`, `webui/src/lib/stores/app.svelte.js`, `docs/API.md`)**: removed the `reordered.length > 500` branch that only did `priority ± 1` (causing items in the middle to jump to `#1` or `#1000` when other items had priority `0`). `up`/`down` now always swap position with the direct neighbor (`ORDER BY priority DESC, id ASC`, including shifting a multi-select block with its internal order preserved) for any queue size. When priorities are already strictly decreasing (`isStrictlyDecreasing`), only the rows that swapped position (2 rows for 1 item) are updated; if there are duplicate priorities (e.g. all `0`), the whole queue is normalized to `total - idx` in a single `BEGIN IMMEDIATE` transaction with one prepared statement without calling `updateQueueItem()` per row, then emits a single SSE `item` event of type `reordered` (`{ type: "reordered", items: [{ galleryId, priority }] }`) handled in `applyItemEvent()` of the frontend store (normalizing 5,000 items finishes in `< 200ms` with 1 SSE event, 26/26 tests passed).
- **Phase 4 verification (5,000 mixed-status items, Virtual DOM, filter `< 50ms`, & 2-tab SSE sync)**: added an automated test with 5,000 mixed-status items (`PENDING`, `ON_PROGRESS`, `DONE`, `SKIPPED`, `STOPPED`, `ERROR`) in `test/sse.test.js` and verified directly in headless Chrome DOM: the number of row DOM elements (`[role="row"][data-gallery-id]`) stays at `23` rows at the top/bottom and `34` rows mid-scroll (not 5,000), filter switch time is instant `< 50ms` (`Downloading=6.2ms`, `Completed=5.3ms`, `Stopped=4.8ms`, `Failed=5.0ms`, back to `All=6.0ms`), full scroll `0..159.588px` (`#800001..#805000`) with no empty/flickering rows, 2-tab sync via SSE reflected immediately (`pause=4.76ms`, `resume=5.63ms`, `delete=7.23ms`), and the old feature endpoints (`Library`, `Settings`, `Logs`, `folder picker`) work normally (25/25 tests passed, `npm run build:ui` 0 warnings).
- **B4–B7 (Tabbed Detail Panel, Status Bar, GSAP & Responsive Layout)**: created `DetailPanel.svelte` (3 tabs `General`, `Pages` with an active page workers HUD + per-page progress grid, and `Log` fetching `GET /api/logs?galleryId=<id>`, panel height resizable and stored in `localStorage`, GSAP collapse/expand animation, and bottom sheet mode for screens `< 768px`), `StatusBar.svelte` (engine status + warning badge on `Download folder unavailable`, `Active`/`Queued`/`Done`/`Failed` counters, total speed, and SSE connection status), `Toast.svelte`, and integrated the whole qBittorrent/IDM layout in `webui/src/App.svelte` (`npm run build:ui` 0 warnings).
- **B3 (Virtual Queue Table & Context Menu)**: created `VirtualQueueTable.svelte` with custom virtualization without external libraries (fixed row height `32px`, overscan `±10` rows), 10 desktop columns (`#`, `Title`, `ID`, `Status`, `Progress`, `Pages`, `Speed`, `ETA`, `Batch`, `Format`) and 3 mobile columns `< 768px` (`Title`, `Status`, `Progress`) with no horizontal scroll, click-header sort (`asc`/`desc`), resizable column widths stored in `localStorage` (with `try/catch`), multi-select (`click`, `Ctrl+click`, `Shift+click`, `Ctrl+A`), keyboard shortcuts (`ArrowUp`, `ArrowDown`, `Delete`, `Space`), and `ContextMenu.svelte` on right-click.
- **B1 & B2 (Toolbar, Add Dialog, Delete Confirm & Sidebar Filter)**: defined a dark theme based on CSS variables in `webui/src/app.css`, added the API functions `pauseQueueItems`, `resumeQueueItems`, `deleteQueueItems`, `setQueuePriority`, and `fetchGalleryLogs` in `webui/src/lib/api.js`, extended the store `webui/src/lib/stores/app.svelte.js` with single-pass real-time filter counters (`All`, `Downloading`, `Queued`, `Completed`, `Stopped`, `Failed`, and the `Batch` list), `#` priority ranking, sort, and multi-select, and created the components `Toolbar.svelte`, `AddDialog.svelte`, `DeleteConfirmDialog.svelte`, and `SidebarFilter.svelte`.
- **A (Backend: Queue Item Control & Per-Gallery Log)**: documented in `docs/API.md` and implemented the `STOPPED` status (untouched by `requeueFailedItems()` and the `_runBatchBody` pre-pass), safe stopping of `ON_PROGRESS` items at the next page boundary without deleting already downloaded files (`stopGallery` in `core/engine.js`), the endpoints `POST /api/queue/pause`, `POST /api/queue/resume`, `POST /api/queue/delete` (only deletes `queue` rows, disk files and the `library` table stay intact), `POST /api/queue/priority` (`top`/`up`/`down`/`bottom`), and `GET /api/logs?galleryId=<id>&limit=<n>` (returns a JSON array `[{ ts, level, message }]` from the `events` table). Updated the design decision in `docs/PLAN.md` (client-side virtual table without server paging) and added 4 new tests in `test/db.test.js` and `test/sse.test.js` (24/24 tests passed).

## 2026-09-28 · AI (Claude Code, Opus 5.5) · Release
- Merge `rework` into `main` (fast-forward): Phase 1 (SQLite), Phase 2 (SSE + download folder guard), and Phase 3 (Svelte 5 frontend foundation) are now in `main`.
- Reviewed before the merge: 20/20 tests passed, a 1000-item UI test in the browser (real-time SSE in two tabs, no polling), and the late-mounted disk scenario recovers automatically without data loss.

## 2026-09-28 · Manual (Maja) · Release
- Tested `rework` on a laptop, then approved the merge into `main`.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 2 (A1 Regression Fix)
- **Fix for the `downloadDirUnavailable` auto-recovery bug (`core/engine.js`)**: separated the boolean flag `this.downloadDirUnavailable` from the text `this.statusReason` so the recovery watcher keeps running when `markDownloadDirUnavailable(reason)` is called with a specific reason from `rescanLibrary()` (e.g. `"Download folder is empty while library has entries"` or `"More than 50% of library entries missing"`). When the folder is detected healthy, `checkDownloadDirRecovery()` first reruns `rescanLibrary(this.baseDownloadDir)` and only clears the flag/status and runs `requeueFailedItems()` + `runBatch()` if the rescan was not `aborted` (20/20 tests total passed).
- **A1 regression fix (new `DOWNLOAD_DIR` & 60-second auto-recovery)**: if the `library` table has no active entries yet (other than `skipped`), the download folder is created automatically (`fs.mkdirSync(..., { recursive: true })`) in the `DownloaderEngine` constructor, `_runBatchBody` (`core/engine.js`), and `rescanLibrary` (`core/tracker.js`) so a fresh install with a custom `DOWNLOAD_DIR` runs right away. If `library` already has active entries and the folder is not mounted/unhealthy, the folder is still not created (`Download folder unavailable`) and the automatic check timer every 60 seconds (`healthCheckIntervalMs`) restores the status, records an event in the `events` table, and runs the queue again (`runBatch`) once the disk is mounted.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 3
- **B3 (Queue list render optimization & 1,000 item + 2-tab SSE verification)**: removed `animate:flip` on queue item/batch lists (kept only in `hud.activePages` max 3 items), computed `filteredItems` once per batch via `$derived`, skipped DOM node creation for `collapsed` batches, added `content-visibility: auto; contain-intrinsic-size: auto none auto 36px;` on queue item rows, and debounced `rawList` regeneration (80ms) when receiving bursts of SSE `item` events. Added benchmark & 2-tab SSE verification tests in `test/sse.test.js` (`1000 items import=86.6ms`, `2-tab snapshot=10.7ms`, `2-tab delta sync=19.9ms`, update event size `250B` vs `245.034B` for `/api/status` polling on `main`, a 99.9% payload reduction per update, 18/18 tests total passed, `npm run build:ui` without warnings).
- **B2 (Split `App.svelte` into Svelte 5 runes components)**: split `webui/src/App.svelte` (from 1,767 lines to 94 lines) into 10 modular components in `webui/src/lib/components/` (`Header.svelte`, `HudPanel.svelte`, `QueuePanel.svelte`, `BatchGroup.svelte`, `QueueItem.svelte`, `RightSidebar.svelte`, `FolderPickerModal.svelte`, `DeleteBatchModal.svelte`, `LibraryModal.svelte`, `LogsModal.svelte`), all using Svelte 5 runes (`$state`, `$derived`, `$props`, `$effect`) and `webui/src/lib/api.js` with no direct `fetch()` calls.
- **B1 (`webui/src/lib/api.js` & `webui/src/lib/stores/app.svelte.js`)**: created a centralized HTTP client `webui/src/lib/api.js` for all endpoints in `docs/API.md` and a reactive store `webui/src/lib/stores/app.svelte.js` based on Svelte 5 runes (`$state`, `$derived`, `SvelteMap` per `galleryId`) and an SSE client `EventSource('/api/events')` with exponential reconnect backoff (1s, 2s, 5s, max 10s), connection status, and a 3-second `/api/status` polling fallback.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 2 (Review Fixes A1–A3)
- **A3 (`_runBatchBody` pre-pass unit tests)**: added `_runBatchBody` integration tests (with `skipStartupJitter: true`, a temporary DB, and a `processGallery` stub) in `test/db.test.js` verifying that `DONE` items with no file on disk go back to `PENDING`, `DONE` items with a valid file stay `DONE`, and `ERROR` items with `retries < 5` are reprocessed (17/17 tests total passed).
- **A2 (`config.json` isolation in tests)**: added support for the option `{ legacyConfigPath }` in `initDb(dbPath, options)` and the environment variable `NHDL_LEGACY_CONFIG` in `core/db.js` so temporary databases in `test/` do not read the developer machine's `config.json`.
- **A1 (`isDownloadDirHealthy` & unmounted drive protection)**: added `isDownloadDirHealthy(dir)` in `core/tracker.js` to ensure the download folder exists, is readable, and is not empty when `library` has entries, and to abort `rescanLibrary()` (`aborted: true`) if >50% of at least 10 `library` entries are missing on disk. Skip the `DONE→PENDING` pre-pass in `_runBatchBody` (`core/engine.js`) and stop the run with status `'Download folder unavailable'` + SSE event `download_dir_unavailable` if the folder is unhealthy.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 1 (Review Fixes)
- **BUG 1 (`requeueFailedItems`)**: added `requeueFailedItems({ maxRetries = 5 })` in `core/db.js` to return `ERROR`, `COOLDOWN`, and `PAUSED` rows with `retries < maxRetries` to `PENDING` (`error = NULL`), called at the start of `_runBatchBody` (`core/engine.js`), the global `/api/retry`, and the `resume`/`start`/`restart` actions in `/api/control` (`server/index.js`). Per-item `/api/retry` now also resets `retries = 0`.
- **BUG 2 (`importListText` & `_runBatchBody` stale `DONE`)**: return `DONE` or `SKIPPED` rows (other than permanent skips `entry.skipped`) to `PENDING` (`pages_done = 0, error = NULL`) and delete stale `library` entries (`deleteLibraryEntry`) if the file on disk was deleted, in both `importListText` and the `_runBatchBody` pre-pass.
- **BUG 3 (`migrateLegacyConfigJson`)**: added a one-time migration on `initDb()` in `core/db.js` that copies `downloadDir`, `downloadFormat`, and `autoContinueBatches` from the old `config.json` to the `settings` table if the `settings` table is still empty (without deleting/changing `config.json`), and records `"Migrated settings from config.json"` in the `events` table.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 2
- `server/index.js` & `test/sse.test.js`: implemented the SSE endpoint `GET /api/events` (initial `snapshot` + real-time `item`, `progress`, `engine` deltas and the `: ping` heartbeat), kept `GET /api/status` for compatibility, and added SSE unit tests (`test/sse.test.js`, 12/12 tests total passed).
- `core/db.js`: added the `formatQueueRow()` helper and ensured all `queue` table mutations (`enqueueGallery`, `updateQueueItem`, `deleteQueueItem`, `deleteQueueBatch`, `clearCompletedQueue`, `resetStuckQueueItems`, `importListText`) emit structured delta events on `dbEvents`.
- Created `docs/API.md` with the complete specification of all REST API endpoints (`/api/login`, `/api/logout`, `/api/status`, `/api/queue`, `/api/queue/import`, `/api/queue/export`, `/api/control`, `/api/retry`, `/api/config`, `/api/config/verify-key`, `/api/library/*`, `/api/logs/*`, `/api/fs/browse`) and the SSE stream format `GET /api/events` (`snapshot`, `item`, `progress`, `engine`).

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Plan (Phase 8)
- `docs/PLAN.md`: added Phase 8 "README for AI agents" (`docs/AI_AGENT.md` covering deploy/manage/modify/maintain, a trigger block in `README.md`, link from `AGENTS.md`).

## 2026-09-27 · Manual (Maja) · Plan (Phase 8)
- Asked for a README for AI agents covering deploy, manage, modify, and maintain, with an "if you're an AI agent" trigger in the main README.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Plan
- `docs/PLAN.md`: added Phase 7 "Central PostgreSQL + backup/export/import" (choose DB via `DATABASE_URL`, SQLite/Postgres adapters, `core/db.js` API becomes async, endpoints + Settings → Database menu, cross-DB tests).

## 2026-09-27 · Manual (Maja) · Plan
- Asked for central PostgreSQL integration (shared Postgres on the server) so data is not lost on rebuild, plus database backup and export/import features in the Settings menu.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 1
- Cleaned up the old state files (`list_status.txt`, `progress.json`, `library.json`, `config.json`, `activity.log`, `error.log`), added `data/` to `.gitignore`, and mounted the `/app/data` volume in `docker-compose.yml` and the `Dockerfile`.
- Added an integration test with 1,000 links + a simulated server restart mid-download (`ON_PROGRESS → PENDING`, `DONE`/`ERROR` stay consistent) in `test/db.test.js` (10/10 tests total passed).
- `server/index.js`: moved all endpoints (`/api/status`, `/api/queue`, `/api/library`, `/api/retry`, `/api/control`) to SQLite queries (`core/db.js`), added the endpoints `POST /api/queue/import` and `GET /api/queue/export` for `list.txt` import/export, and ran `resetStuckQueueItems()` (`ON_PROGRESS → PENDING`) at startup.
- `core/engine.js` & `scripts/find-bad-archives.js`: moved configuration storage (`downloadDir`, `downloadFormat`, `autoContinueBatches`) from `config.json` to the SQLite `settings` table. Changed `runBatch()`/`processGallery()` to take the next queue item from the `queue` table (`getNextPendingItem()`, ordered `priority DESC, id ASC`) and update status and `pages_done`/`pages_total` per row directly in SQLite.
- `core/tracker.js`: replaced reading/writing `list_status.txt` and `library.json` with the SQLite `queue` and `library` tables (`core/db.js`). Updated `rescanLibrary()` so it can refill the `library` table automatically from the `.nhdl-id` and `.cbz.nhdl-id` marker files in the download folder.
- `core/logger.js`: replaced storage of `activity.log` and `error.log` with the SQLite `events` table (with a retention limit of the last 10,000 rows and automatic extraction of `level` and `gallery_id`).
- Added `core/db.js` using the built-in `node:sqlite` module (`WAL` mode, `schema_version`-based migrations, query functions for `queue`, `library`, `settings`, `events`, `resetStuckQueueItems()`, and `importListText`/`exportListText`).
- Added `test/db.test.js` (`node:test`) to test schema migration, the `UNIQUE(gallery_id)` constraint, the status cycle `PENDING → ON_PROGRESS → DONE/ERROR`, reset on startup, and `list.txt` import/export with a temporary DB.
- `Dockerfile`: raised both stages (`builder` and production) from `node:20-alpine` to `node:24-alpine` for built-in `node:sqlite` support.
- `package.json`: added `"engines": { "node": ">=22.13" }`.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Docs
- Synced `docs/ARCHITECTURE.md` and `AGENTS.md` with the latest changes on the `rework` branch (`scripts/find-bad-archives.js`, `test/nhentaiApi.test.js`, `isZipFile` validation in `core/nhentaiApi.js`, and the latest git/documentation rules).

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Bugfix
- **Fix for API downloads producing anomalous files (<100KB).** Cause: requests to the archive host (`i1..i4`) were sent without a User-Agent, so Cloudflare replied with an HTML challenge page (403, ±13KB), and the code saved it as `.cbz` because the HTTP status and file contents were not checked.
- `core/nhentaiApi.js` → `downloadArchiveFile`: send a browser User-Agent, reject responses other than HTTP 200, and validate the zip signature (`PK\x03\x04`). If it fails, the file is deleted and the engine falls back to per-page download.
- Added `test/nhentaiApi.test.js` (`node:test`) and the script `npm test`.
- Added `scripts/find-bad-archives.js` (`npm run check:archives`, supports `--delete`) to detect and clean up corrupt `.cbz`/`.zip` (HTML challenge) in the download folder along with their `.nhdl-id` markers (2171deb).
- Verified against the real API: before the fix 13KB HTML, after the fix real CBZ of 16MB and 50MB.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Phase 0 (continued)
- `core/utils.js`: raw control characters in the `sanitizeName` regex replaced with escapes (`\x00-\x1f`, `\uXXXX`); output verified identical. Git now reads this file as text.
- Deleted `webui/src/lib/Counter.svelte`.
- `start.bat`: auto-build the Web UI if `webui/dist` does not exist.
- `docs/PLAN.md`: added `node:test` tests, reset of `ON_PROGRESS` on startup, `docs/API.md` before Phase 2.
- `AGENTS.md`: git rules (commit/push as the user, no AI attribution, work on the `rework` branch) and the DB → REST → SSE feature pattern.
- Created the `rework` branch.

## 2026-09-27 · Manual (Maja) · —
- Approved all recommendations; set the rule that commits and pushes must be made as the user.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Docs
- The site name in all documentation was changed to "certain site ( ͡° ͜ʖ ͡°)"; the example domain became `certain.site` (README, `docs/ARCHITECTURE.md`, `list.txt.example`, `package.json` description).
- Code identifiers (`nhentaiApi.js`, `NHENTAI_API_KEY`, domains inside code) were deliberately left unchanged.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Phase 0
- Studied the entire codebase (`server/`, `core/`, `webui/`) and created `docs/ARCHITECTURE.md` with a complete architecture map, `DownloaderEngine` flow, REST API contract, state/marker file formats, and the structure of `App.svelte` (1766 lines) so later sessions do not need to re-read the source code.
- `AGENTS.md`: added a reference to `docs/ARCHITECTURE.md`.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Plan
- `docs/PLAN.md`: added Phase 1 "Move all data to SQLite" (decisions, table schema `queue`/`library`/`settings`/`events`, old file mapping, tasks). The SSE, frontend, layout, benchmark, and Go phases shift to Phases 2–6.

## 2026-09-27 · Manual (Maja) · Plan
- Decided that all data (links, status, progress, library, config, logs) is stored in SQLite, not text files. Old data is not migrated.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Phase 0
- Removed the CLI: `cli/index.js` and the old router in the project root.
- `package.json`: `main` and `npm start` pointed to `server/index.js`; the `nhdl` bin and `cli` script removed.
- `start.bat` runs `node server/index.js`.
- README: CLI section removed.
- Added `docs/PLAN.md` (rework plan + status) and this `docs/CHANGELOG.md`.
- Added `AGENTS.md` (logging rules for all agents), with `GEMINI.md` and `CLAUDE.md` referring to it.
- Division of work: UI and code rework is done by the user through Antigravity (Gemini 3.8 Flash High).

## 2026-09-27 · Manual (Maja) · —
- `git pull`: updated `core/engine.js`, `core/tracker.js`, `core/utils.js` (b88919e).
- Decided the rework direction: qBittorrent/IDM-style UI, Svelte + GSAP, CLI removed, gradual migration.
