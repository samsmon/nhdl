# NHDL — REST API & SSE Event Contract

This document is the official contract for all communication between the frontend (Svelte UI) and the backend (`server/index.js` and the planned Go backend in Phase 6).
Every new endpoint or event **must** be added to this document first, before it is implemented in code.

> **Documentation note:** The target site is referred to as **"certain site ( ͡° ͜ʖ ͡°)"** with the example domain `https://certain.site/g/<gallery_id>/`.

---

## 1. Core Data Types

### `QueueItem`
Representation of a queue item sent over REST (`/api/status`) and SSE (`/api/events`):
```json
{
  "id": 1,
  "galleryId": 123456,
  "source": "default",
  "category": null,
  "status": "PENDING",
  "rawStatus": "PENDING",
  "url": "https://certain.site/g/123456/ | [Artist] Title",
  "title": "[Artist] Title",
  "batch": 1,
  "priority": 0,
  "pagesDone": 0,
  "pagesTotal": 24,
  "error": null,
  "retries": 0,
  "format": "cbz",
  "createdAt": "2026-09-28 08:00:00",
  "updatedAt": "2026-09-28 08:01:00"
}
```
- `rawStatus` values: `'PENDING'` | `'ON_PROGRESS'` | `'STOPPED'` | `'PAUSED'` | `'COOLDOWN'` | `'DONE'` | `'ERROR'` | `'SKIPPED'`
- Status `'STOPPED'` is reserved for items the user paused manually (untouched by `requeueFailedItems()` and the `_runBatchBody` pre-pass). Status `'PAUSED'` is used by the *circuit breaker* when consecutive 429 limits are hit.
- `status` values: same as `rawStatus`, or `"${rawStatus} - ${error}"` when the `error` column is set.
- `galleryId`: a `number` for site A galleries (plain numeric key, compatible with earlier versions), a prefixed `string` (`"<prefix>:<content>"`) for site B1/B2/C. Examples: `123456`, `"b1:539224"`, `"c1:some-slug"`. This value is used as-is in `ids`/`galleryId` on other endpoints.
- `source`: source id derived from the `galleryId` prefix (`"default"` when there is no prefix). Not stored in the DB. The list of sources is in `GET /api/config` → `sources`.
- `createdAt` / `updatedAt`: time strings. SQLite: UTC without a zone (`"2026-09-28 08:00:00"`); PostgreSQL: ISO 8601 (`"2026-09-28T08:00:00.000Z"`). The UI parses both.
- `category`: content type `"comic" | "manga" | "other" | null`. Mapped from the category on the origin site (site B1/B2/C); `null` for site A, old items, and items whose metadata has not been fetched yet. Stored in the `queue` table (`category` column) and included in the SSE `item` event.

### `LiveProgress`
Representation of the active progress (`engine.currentProgress`), or `null` if there is none. It has two shapes.

Gallery download (`live: true`):
```json
{
  "galleryId": 123456,
  "title": "[Artist] Title",
  "percent": 50,
  "completed": 12,
  "total": 24,
  "taskNum": 1,
  "totalTasks": 10,
  "activePages": [
    { "page": 13, "url": "...", "bytesReceived": 51200, "totalBytes": 204800, "percent": 25, "attempt": 1, "lastError": null }
  ],
  "speedKBps": 1512,
  "stalled": false,
  "stalledSeconds": 0,
  "live": true
}
```

Waiting period (`type`: `"COOLDOWN"` anti-ban pause between galleries, `"BATCH_REST"` rest between batches, `"RATE_LIMIT"` 429 cooldown; `remaining` and `total` in seconds):
```json
{
  "type": "COOLDOWN",
  "title": "Smart Delay Cooldown (Anti-Ban)",
  "message": "Next in queue in: 12s",
  "percent": 40,
  "remaining": 12,
  "total": 20,
  "taskNum": 3,
  "totalTasks": 10
}
```
The UI uses the second shape for the countdown chip in the queue table (see ARCHITECTURE section 2a).

### `EngineStatus`
Status string of the download engine: `'IDLE'` | `'RUNNING'` | `'PAUSED'` | `'COOLDOWN'` (anti-ban pause / batch rest) | `'COOLDOWN_429'` (rate limit) | a reason text when the download folder is unhealthy (default `'Download folder unavailable'`; other reasons, e.g. `Download folder is empty while library has entries`).

---

## 2. Server-Sent Events (SSE) — `GET /api/events`

Opens a one-way HTTP stream (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`) to receive real-time state updates without polling.

### 2.1. `event: snapshot` & `event: reloaded`
Sent **immediately after the SSE connection opens** (`snapshot`), and re-emitted to all active SSE clients after an import or database restore finishes (`snapshot` and `reloaded`). Contains the full queue state at that moment so the queue and library status in the UI update instantly without reloading the page:
```
event: snapshot
data: {"items":[...],"batchCount":1,"engineStatus":"IDLE","liveProgress":null,"autoContinueBatches":true}
```

### 2.2. `event: item`
Sent whenever the `queue` table in the database changes (`core/db.js` `dbEvents`):
- **Row added or updated (`inserted` / `updated`)**:
  ```
  event: item
  data: {"type":"inserted","item":{"id":1,"galleryId":123456,"status":"PENDING","rawStatus":"PENDING","url":"https://certain.site/g/123456/","title":null,"batch":1,"priority":0,"pagesDone":0,"pagesTotal":0,"error":null,"retries":0,"format":null,"source":"default","category":null},"batchCount":1}
  ```
- **Single row deleted (`deleted`)**:
  ```
  event: item
  data: {"type":"deleted","galleryId":123456,"batchCount":1}
  ```
- **Whole batch deleted (`batch_deleted`)**:
  ```
  event: item
  data: {"type":"batch_deleted","batch":2,"batchCount":1}
  ```
- **Completed items cleared (`cleared`)**:
  ```
  event: item
  data: {"type":"cleared","removedIds":[123456,234567],"batchCount":1}
  ```
- **Priority order changed (`reordered`)**:
  Only sent when there is an actual priority change (`items` is never an empty array):
  ```
  event: item
  data: {"type":"reordered","items":[{"galleryId":123456,"priority":501},{"galleryId":234567,"priority":500}],"batchCount":1}
  ```

### 2.3. `event: progress`
Sent when a gallery page finishes downloading or when the pause/cooldown countdown changes:
```
event: progress
data: {"liveProgress":{...},"engineStatus":"RUNNING"}
```

### 2.4. `event: engine`
Sent when the download engine status or configuration changes; `detail` holds the engine event payload (or `null`) (`paused`, `resumed`, `stopped`, `restarted`, `batch_start`, `batch_complete`, `circuit_breaker`, `config_updated`, `download_dir_unavailable`):
```
event: engine
data: {"type":"paused","engineStatus":"PAUSED","liveProgress":null,"autoContinueBatches":true,"detail":null}
```

### 2.5. Heartbeat
Every 25 seconds the server sends the SSE comment `: ping\n\n` so the connection is not dropped by a reverse proxy.

---

## 3. REST API Endpoints

All endpoints under `/api/*` (except `/api/queue/export` and `/api/logs/download`) return `Content-Type: application/json`. If authentication is enabled (`NHDL_PASSWORD` in `.env`) and the `nhdl_session` session cookie is invalid, the server returns `401 Unauthorized` (`{"error":"Unauthorized"}`).

### 3.1. Authentication

| Method | Path | Body | Response (`200 OK`) | Notes |
|---|---|---|---|---|
| `POST` | `/api/login` | `{"password":"..."}` | `{"success":true}` | Sets the `HttpOnly` cookie `nhdl_session`. Returns `401` if the password is wrong. |
| `POST` | `/api/logout` | — | `{"success":true}` | Deletes the session and clears the `nhdl_session` cookie. |

### 3.2. Status & Queue (`queue`)

| Method | Path | Body | Response (`200 OK`) | Notes |
|---|---|---|---|---|
| `GET` | `/api/status` | — | `{"items": QueueItem[], "batchCount": number, "rawList": string, "errors": string, "liveProgress": LiveProgress\|null, "engineStatus": EngineStatus, "autoContinueBatches": boolean}` | Compatibility endpoint for reading the full status snapshot. |
| `POST` | `/api/queue` | `{"text": string, "replace"?: boolean, "format"?: string}` or `text/plain` | `{"success":true, "added": number, "updated": number, "duplicates": number, "ignored": number, "galleryIds": (number\|string)[], "total": number}` | Imports a list of URLs/IDs (`# BATCH N FORMAT=...`). Default `replace = true` on `/api/queue`. Each line may be a gallery URL from site A, B1, B2, or C, a plain site A ID, or a prefixed key. Unrecognized lines are skipped and counted in the `ignored` field of the response. |
| `POST` | `/api/queue/import` | `{"text": string, "replace"?: boolean, "format"?: string}` or `text/plain` | `{"success":true, "added": number, "updated": number, "duplicates": number, "ignored": number, "galleryIds": (number\|string)[], "total": number}` | Imports a `list.txt` list (upload/paste). Default `replace = false` (adds/updates without removing other items). Each line may be a gallery URL from site A, B1, B2, or C, a plain site A ID, or a prefixed key. Unrecognized lines are skipped and counted in the `ignored` field of the response. |
| `GET` | `/api/queue/export` | — | `text/plain` (`attachment; filename="list.txt"`) | Exports the entire `queue` table to the `# BATCH N` text format. |
| `POST` | `/api/queue/pause` | `{"ids": (number\|string)[]}` | `{"success":true, "paused": number, "stopping": (number|string)[]}` | Changes the status of `PENDING`/`ERROR`/`COOLDOWN`/`PAUSED` items to `STOPPED`. For `ON_PROGRESS` items, the engine safely stops that gallery's download at the next page boundary, saves progress (`pages_done`), sets the status to `STOPPED` without deleting files/pages already downloaded, then moves on to the next item. |
| `POST` | `/api/queue/resume` | `{"ids": (number\|string)[]}` | `{"success":true, "resumed": number}` | Changes the status of `STOPPED` items (and `ERROR`/`COOLDOWN`/`PAUSED`) to `PENDING` (`error = null`), then calls `autoProcessQueue()`. |
| `POST` | `/api/queue/delete` | `{"ids": (number\|string)[]}` | `{"success":true, "deleted": number}` | Deletes items from the `queue` table only (files on disk and the `library` table are untouched). Items currently `ON_PROGRESS` are stopped first at the next page boundary, as in `/api/queue/pause`. |
| `POST` | `/api/queue/priority` | `{"ids": (number\|string)[], "action": "top" \| "up" \| "down" \| "bottom"}` | `{"success":true, "updated": number}` | Changes the priority order (`ORDER BY priority DESC, id ASC`) for any queue size in a single SQLite transaction and emits one SSE `item` event (`type: "reordered"`). If `priority` values collide (e.g. all `0`), the queue is first normalized to `total - index`. |

### 3.3. Engine Control & Retry

| Method | Path | Body | Response (`200 OK`) | Notes |
|---|---|---|---|---|
| `POST` | `/api/control` | `{"action": "pause" \| "resume" \| "start" \| "stop" \| "restart"}` | `{"success":true, "engineStatus": EngineStatus}` | Controls the download engine cycle. `stop` is equivalent to `pause` and `start` to `resume`. `resume`/`start` requeue failed items that still have retry quota; `restart` also returns `ON_PROGRESS` rows to `PENDING`. |
| `POST` | `/api/retry` | `{"galleryId"?: number\|string}` | `{"success":true, "message":"Force retry triggered"}` | Skips the active cooldown; if `galleryId` is included, sets that item's status back to `PENDING` and triggers the queue. |

### 3.4. Configuration (`settings` & `.env`)

| Method | Path | Body | Response (`200 OK`) | Notes |
|---|---|---|---|---|
| `GET` | `/api/config` | — | `{"downloadDir": string, "downloadFormat": "folder"\|"cbz"\|"zip", "autoContinueBatches": boolean, "authRequired": boolean, "apiKeyConfigured": boolean, "apiKeyMasked": string, "backupIntervalHours": number, "backupKeep": number, "lastBackupAt": string\|null, "sources": {"id": string, "label": string}[]}` | Reads the active settings from the `settings` table and the API key status from `.env`. `sources`: the list of sources known to the server (UI display order), used for badge labels and category filters. |
| `POST` | `/api/config` | One of: `{"downloadDir": string}`, `{"downloadFormat": "folder"\|"cbz"\|"zip"}`, `{"autoContinueBatches": boolean}`, `{"apiKey": string}`, `{"backupIntervalHours": number}`, or `{"backupKeep": number}` | `{"success":true, ...}` | Saves the setting to the `settings` table (or `NHENTAI_API_KEY` to `.env`). |
| `POST` | `/api/config/verify-key` | `{"apiKey"?: string}` | `{"valid": boolean, "user"?: object, "rateLimit"?: object, "error"?: string}` | Verifies the API key against the certain site ( ͡° ͜ʖ ͡°) API v2. |

### 3.5. Library

| Method | Path | Body | Response (`200 OK`) | Notes |
|---|---|---|---|---|
| `GET` | `/api/library` | — | `{"items": LibraryItem[], "total": number}` | Fetches the list of galleries in the `library` table that are not `skipped`. |
| `POST` | `/api/library/rescan` | — | `{"success":true, "scanned": number, "relocated": number, "pruned": number, "unchanged": number, "aborted"?: boolean, "reason"?: string}` | Rescans the download folder based on `.nhdl-id` and `.cbz.nhdl-id` marker files (aborted with `aborted: true` and `success: false` if the folder is unhealthy/not mounted; a successful rescan clears the `Download folder unavailable` status). |
| `POST` | `/api/library/rename` | `{"id": string\|number, "newName": string}` | `{"success":true, "oldPath": string, "newPath": string, "newTitle": string}` | Renames the folder/archive on disk, updates `ComicInfo.xml`, and updates the `library` and `queue` tables. |
| `POST` | `/api/library/compress` | `{"id": string\|number, "ext"?: "cbz"\|"zip"}` | `{"success":true, "archivePath": string, "archiveExt": string, "skipped"?: boolean}` | Compresses a gallery folder into a `.cbz`/`.zip` archive (`STORE` level 0) and deletes the original folder. |
| `POST` | `/api/library/batch-compress` | `{"ids": (string\|number)[], "ext"?: "cbz"\|"zip"}` | `{"success":true, "started":true, "total": number}` | Starts a bulk compression job in the background (`409 Conflict` if a job is still running). |
| `GET` | `/api/library/compress-status` | — | `{"job": CompressJob\|null}` | Reads the progress of the bulk compression job that is running or ran most recently. |

`LibraryItem`:
```json
{ "id": "123456", "source": "default", "category": null, "title": "Title", "author": "Artist", "lang": "English", "pages": 24, "folder": "/downloads/English/Artist/Title.cbz", "downloadedAt": "2026-09-28 08:00:00", "legacy": false, "archived": true, "archiveExt": "cbz" }
```
- `id`: canonical key as a string (`"123456"`, `"b1:539224"`).
- `source`: same as `QueueItem.source`.
- `category`: same value as `QueueItem.category` (read from the library's `meta.contentType`; `null` if absent).

### 3.6. Logs & Directory Browser

| Method | Path | Body | Response (`200 OK`) | Notes |
|---|---|---|---|---|
| `GET` | `/api/logs` | — | `{"log": string}` or `{"ts": string, "level": string, "message": string}[]` (if the `galleryId` query is given) | Without `galleryId`: fetches the activity log string from the `events` table. With `?galleryId=<id>&limit=<n>`: returns a JSON array of rows from the `events` table for that gallery (`[{ "ts", "level", "message" }]`). |
| `GET` | `/api/logs/download` | — | `text/plain` (`attachment; filename="nhdl-activity-<ts>.log"`) | Downloads the activity log as a `.log` file. |
| `GET` | `/api/fs/browse?path=<dir>` | — | `{"currentPath": string, "parentPath": string\|null, "drives": string[], "directories": {"name": string, "path": string}[]}` | Browses the local directory listing for the download folder picker in the UI. |

### 3.7. Database Management (Export, Import & Backup)

| Method | Path | Body | Response (`200 OK`) | Notes |
|---|---|---|---|---|
| `GET` | `/api/db/info` | — | `{"type": "sqlite" \| "postgres", "connected": boolean, "path"?: string, "host"?: string, "port"?: string, "database"?: string, "detail"?: string, "maskedUrl"?: string, "backupIntervalHours": number, "backupKeep": number, "lastBackupAt": string\|null, "backupDir": string}` | Shows information about the active database (type, connection status, path/host, no password), the scheduled backup configuration, and the active backup folder path. |
| `GET` | `/api/db/export` | — | `application/json` (`attachment; filename="nhdl-export-<YYYY-MM-DD-HHmmss>.json"`) | Downloads the entire database (`queue`, `library`, `settings`, `events`, `schema_version`) as database-independent JSON. |
| `POST` | `/api/db/import` | `{"mode": "replace" \| "merge", "data": object}` | `{"success":true, "mode": "replace" \| "merge", "imported": {"queue": number, "library": number, "settings": number, "events": number}, "preImportBackup"?: string}` | Imports JSON data in a single transaction. `replace` mode first creates an automatic backup `nhdl-backup-pre-import-<ts>.json` before emptying the tables (if the backup fails, the import is aborted). Returns `409 Conflict` (`{"success":false,"error":"Pause engine first","needsPause":true}`) if `engine.isRunning` or any item is `ON_PROGRESS`. |
| `POST` | `/api/db/backup` | `{}` | `{"success":true, "filename": string, "size": number, "createdAt": string}` | Creates an instant backup in the active backup folder (`data/backups/` or `NHDL_BACKUP_DIR`) and prunes retention according to `backupKeep` (default 7). |
| `GET` | `/api/db/backups` | — | `{"backups": [{"filename": string, "size": number, "createdAt": string}]}` | Fetches the list of backup files stored in the active backup directory (`data/backups/` or `NHDL_BACKUP_DIR`). |
| `POST` | `/api/db/restore` | `{"filename": string, "mode"?: "replace" \| "merge"}` | `{"success":true, "filename": string, "restored": object, "preImportBackup"?: string}` | Restores the database contents from a specific local backup file (default mode `replace`). In `replace` mode, an automatic backup `nhdl-backup-pre-import-<ts>.json` is first created before the restore runs. Returns `409 Conflict` (`{"success":false,"error":"Pause engine first","needsPause":true}`) if `engine.isRunning` or any item is `ON_PROGRESS`. |
| `DELETE` | `/api/db/backups/:name` | — | `{"success":true, "deleted": string}` | Deletes a specific backup file in the active backup folder. |

