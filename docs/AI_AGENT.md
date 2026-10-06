# NHDL: Guide for AI Agents

This file is written for AI agents asked to **deploy, manage, modify, or maintain** NHDL. It is short on purpose: follow the steps, run the commands, and check the expected output. Everything here has been checked against the source code.

In prose, the target website is called "certain site ( ͡° ͜ʖ ͡°)" and example URLs use `certain.site`. Keep that convention in any docs you write.

**Rules for agents working on the code itself** (git identity, changelog, branch, architecture patterns) are in [../AGENTS.md](../AGENTS.md). Read that too before you commit anything.

---

## 0. Never do these without the user's explicit approval

- Delete `data/`, the SQLite file, the Docker volume mounted at `/app/data`, or anything in the download folder.
- Run a **replace** import or a restore. They overwrite the whole database. A backup is taken automatically first; tell the user its filename.
- Commit or print secrets: `.env`, `NHDL_PASSWORD`, `NHENTAI_API_KEY`, `DATABASE_URL`.
- Change the git identity, or add AI attribution (`Co-Authored-By`, etc.) to commits or PRs.
- Start the engine against a large queue (mass download) on the user's behalf. Adding items is fine. Starting a large run is the user's call, because the target site rate-limits aggressively.
- Point `DOWNLOAD_DIR` at a path on an unmounted network share. NHDL protects against this, but don't create the folder by hand to "fix" it.

---

## 1. Deploy

### Requirements
- Node.js **22.13+** (uses the built-in `node:sqlite`). The Docker image uses `node:24-alpine`.
- `curl` on the PATH. The Docker image installs it; on Windows, Git for Windows' curl is preferred automatically.

### Local
```bash
npm install
npm --prefix webui install
npm run build:ui
npm start
```
On Windows, `start.bat` does all of this on first run.

### Docker
```bash
docker compose up -d --build
```
Before the first build, check in `docker-compose.yml`:
- `DOWNLOAD_DIR` points to the folder inside the container where galleries go, and the volume that provides it is mounted.
- `/app/data` is mapped to a persistent host folder. It holds the SQLite database and backups.
- The published port (example: `8098:8080`).

### Database mode
| Mode | How | Where data lives |
|---|---|---|
| SQLite (default) | leave `DATABASE_URL` empty | `data/nhdl.db` (or `NHDL_DB_PATH`) |
| PostgreSQL | set `DATABASE_URL=postgres://user:pass@host:5432/nhdl` in `.env`, and in compose uncomment `- DATABASE_URL=${DATABASE_URL}` | the Postgres database |

Postgres setup (database, least-privilege user, PG15+ schema grants) is in [POSTGRES.md](POSTGRES.md). On the first start with an **empty** Postgres database and an existing `data/nhdl.db`, NHDL:
1. writes `nhdl-backup-pre-migration-<ts>.json` to the backup folder,
2. copies all data to Postgres,
3. renames the SQLite file to `nhdl.db.migrated`.

If the backup fails, the migration is aborted and SQLite is left untouched. Tell the user to move the pre-migration backup somewhere safe, because backup rotation keeps only the newest N files.

### Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DOWNLOAD_DIR` | saved `downloadDir` setting, else `./Download` (Docker image: `/downloads`) | Download folder. The env var wins over the saved setting |
| `DATABASE_URL` | empty → SQLite | PostgreSQL connection string |
| `NHDL_DB_PATH` | `data/nhdl.db` | SQLite file |
| `NHDL_BACKUP_DIR` | `data/backups` | JSON backup folder |
| `NHDL_PASSWORD` | empty → no login | Enables the login gate |
| `NHENTAI_API_KEY` | empty | Enables fast archive downloads via the official API (can be set from the UI, which writes `.env`) |
| `NHDL_LEGACY_CONFIG` | `config.json` in repo root | One-time import of old `config.json` settings. Set to empty to disable (tests do this) |
| `TEST_DATABASE_URL` | empty → Postgres tests skipped | Postgres used **only** by `npm test`. Never point it at the real database |

Secrets belong in `.env` (template: `.env.example`). They are never stored in the database or returned by the API.

### Health check
```bash
curl -s http://localhost:8080/api/db/info
curl -s http://localhost:8080/api/status | head -c 300
```
Expected:
- `/api/db/info` returns JSON with `"type":"sqlite"` or `"type":"postgres"` and `"connected":true`. Postgres credentials are masked.
- `/api/status` returns JSON with `items`, `engineStatus` (e.g. `"IDLE"`), and `batchCount`.
- The startup log contains `NHDL Web Daemon aktif pada http://0.0.0.0:<PORT>` and `Database: SQLite (...)` or the Postgres equivalent.

If `NHDL_PASSWORD` is set, `/api/*` returns `401 {"error":"Unauthorized"}` until you log in (next section).

---

## 2. Manage

All endpoints are documented in [API.md](API.md). The most useful ones for an agent are below.

### Authentication (only when `NHDL_PASSWORD` is set)
```bash
curl -s -c cookies.txt -H "Content-Type: application/json" \
  -d '{"password":"<ask the user>"}' http://localhost:8080/api/login
# then add -b cookies.txt to every call
```
Never guess or brute-force the password. Ask the user.

### Queue
| Task | Call |
|---|---|
| Add galleries (keep existing queue) | `POST /api/queue/import` `{"text":"468614\nhttps://certain.site/g/123456/"}` |
| Export queue as list.txt | `GET /api/queue/export` |
| Pause / resume items | `POST /api/queue/pause` or `/resume` `{"ids":[468614,"b1:539224"]}` (`b1:` is a placeholder prefix, see below) |
| Remove from queue (files untouched) | `POST /api/queue/delete` `{"ids":[...]}` |
| Priority | `POST /api/queue/priority` `{"ids":[...],"action":"top"\|"up"\|"down"\|"bottom"}` |
| Engine | `POST /api/control` `{"action":"pause"\|"resume"\|"restart"}` |
| Retry one item now | `POST /api/retry` `{"galleryId":468614}` |

Gallery keys: site A is a plain number (`468614`); other sources (site B1, B2, C) use a prefixed string such as `b1:539224` or `c1:some-slug`, and every item/library entry carries a `source` field. The `b1:`/`c1:` prefixes here are placeholders: the real prefixes are the `id` values listed in `GET /api/config` -> `sources`, so read them from there instead of copying the examples literally. Unrecognised lines are skipped and counted in `ignored`.

`POST /api/queue` (without `/import`) **replaces** the whole queue with the given text. Prefer `/api/queue/import`.

Item statuses: `PENDING`, `ON_PROGRESS`, `DONE`, `SKIPPED` (already present, or permanently unavailable, e.g. 404), `ERROR` (retried automatically up to 5 times), `COOLDOWN` (rate-limited), `PAUSED` (paused by the circuit breaker; re-queued automatically on resume), and `STOPPED` (paused by the user; only resumes when asked).

### Logs
`GET /api/logs` (all activity), `GET /api/logs?galleryId=<id>&limit=<n>` (one gallery), and `GET /api/logs/download`.

### API key
Set it from *Settings* in the UI, or `POST /api/config` `{"apiKey":"..."}`. Check it with `POST /api/config/verify-key`. Never echo the key back to the user in full.

### Database: backup, export, import
| Task | Call |
|---|---|
| Info | `GET /api/db/info` |
| Backup now | `POST /api/db/backup` |
| List backups | `GET /api/db/backups` |
| Export (download JSON) | `GET /api/db/export` |
| Import | `POST /api/db/import` `{"mode":"merge"\|"replace","data":<export JSON>}` |
| Restore a backup | `POST /api/db/restore` `{"filename":"nhdl-backup-....json","mode":"replace"}` |

- Import and restore return **409 "Pause engine first"** while the engine is running or an item is `ON_PROGRESS`. Pause first (`POST /api/control {"action":"pause"}`), wait until nothing is `ON_PROGRESS`, then retry.
- Invalid files (wrong `format`/`version`, bad `gallery_id`, empty replace) are rejected with no changes.
- A `replace` import or restore writes `nhdl-backup-pre-import-<ts>.json` first; the response includes its name.
- Scheduled backups: settings `backupIntervalHours` (default 24, `0` = off) and `backupKeep` (default 7), editable in *Settings → Database*.

### Bad archives
```bash
npm run check:archives              # report .cbz/.zip that are not real zips
npm run check:archives -- --delete  # delete them (needs user approval) and print IDs to re-add
```
In Docker: `docker exec nhdl node scripts/find-bad-archives.js`.

---

## 3. Modify

### Map
| Path | What |
|---|---|
| `core/providers/` | Source registry and per-source providers (URL recognition, prefixed gallery keys, metadata, page URLs); see ARCHITECTURE section 2a |
| `core/engine.js` | Download engine: queue loop, rate limiting, circuit breaker, per-gallery stop, download-folder health watch |
| `core/nhentaiApi.js` | Official API client (metadata, archive download URL, archive download with zip validation) |
| `core/tracker.js` | Library: disk rescan via `.nhdl-id` markers, rename, compress, download-folder health check |
| `core/db.js` | Async DB facade. **All SQL goes through here.** Chooses the adapter from `DATABASE_URL` |
| `core/db/sqlite.js`, `core/db/postgres.js` | Adapters with the same interface; each has its own `MIGRATIONS` array |
| `core/db/backup.js`, `core/db/auto-migrate.js` | Backups/rotation/schedule, SQLite → Postgres migration |
| `server/index.js` | HTTP server: REST API, SSE `/api/events`, auth, static UI |
| `webui/src/lib/stores/app.svelte.js` | Frontend state: SSE client, queue Map, filters, selection |
| `webui/src/lib/api.js` | The only place the frontend calls `fetch` |
| `webui/src/lib/components/` | Svelte 5 components (runes only) |

Deeper detail: [ARCHITECTURE.md](ARCHITECTURE.md).

### How to add a feature
1. **State in the DB.** For a new column or table, add a migration to **both** `core/db/sqlite.js` and `core/db/postgres.js` (bump the version, keep them equivalent), and expose functions through `core/db.js`.
2. **Document the endpoint in [API.md](API.md) first**, then implement it in `server/index.js`.
3. **Push changes to the UI through SSE.** Emit on `dbEvents` from the DB layer. `server/index.js` forwards every field except `rawRow`. Handle the event in `app.svelte.js`. Never add polling, and never store state in new text/JSON files.
4. Frontend: Svelte 5 runes (`$state`, `$derived`, `$props`, `$effect`). No `$:` or `export let`, and all HTTP goes through `api.js`.

### Tests and build
```bash
npm test          # node:test; Postgres suite runs only with TEST_DATABASE_URL
npm run build:ui  # must finish without Svelte warnings
```
Tests use temporary databases (`NHDL_DB_PATH` and `NHDL_LEGACY_CONFIG=`) and stub all network calls. Keep it that way: tests must never contact the real site.

---

## 4. Maintain

### Upgrade
```bash
git pull
docker compose up -d --build   # or: npm install && npm run build:ui && npm start
```
Schema migrations run automatically at startup. Take a backup first (`POST /api/db/backup`) when the upgrade touches `core/db/`.

### Troubleshooting
| Symptom | Likely cause | What to do |
|---|---|---|
| Container exits with `Cannot find module 'pg'` | Image built without backend deps | Rebuild with the current `Dockerfile` (it runs `npm ci --omit=dev`) |
| Engine status `Download folder unavailable` / *"Download folder is empty while library has entries"* / *"More than 50% of library entries missing"* | Disk or share not mounted, or the wrong `DOWNLOAD_DIR` | Fix the mount or path. NHDL re-checks every 60s and resumes by itself. **Don't** create the folder manually over an unmounted mount point |
| Items in `COOLDOWN`, logs show 429 | Rate limited by the site | Wait. Backoff doubles from 5 min up to 60 min |
| Engine paused, items `PAUSED - Circuit breaker` | 3 consecutive 429s | Wait, then resume (`POST /api/control {"action":"resume"}`). Don't loop resumes |
| Archive downloads are tiny HTML files / `check:archives` finds bad files | Cloudflare challenge page saved as `.cbz` (fixed in current code) | Run `check:archives`, delete with approval, re-add the printed IDs |
| Timeouts / can't reach the site from a homelab | ISP DNS hijack | The code pins known Cloudflare IPs via `curl --resolve`. Check that `curl` exists in the container and outbound 443 works |
| Item stuck `ON_PROGRESS` after a crash | Unclean shutdown | Reset automatically on startup, or `POST /api/control {"action":"restart"}` |
| Item `ERROR` with retries ≥ 5 | Persistent failure | Read `GET /api/logs?galleryId=<id>`, then `POST /api/retry {"galleryId":<id>}` (resets retries) |
| `Failed to connect to PostgreSQL ... after 60s` | Wrong `DATABASE_URL`, network, or grants | Check host/network (compose `networks:`), credentials, and the PG15+ schema grants in [POSTGRES.md](POSTGRES.md) |
| `401 Unauthorized` on every API call | `NHDL_PASSWORD` is set | Log in first (section 2) |
| Import/restore returns `409` | Engine running | Pause, wait for no `ON_PROGRESS`, retry |
