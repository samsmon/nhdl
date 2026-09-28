# NHDL (Batch Downloader for a certain site ( ͡° ͜ʖ ͡°))

> **If you are an AI agent:** read [docs/AI_AGENT.md](docs/AI_AGENT.md) before deploying, managing, modifying, or maintaining this project.

A self-hosted download manager for galleries from a certain site ( ͡° ͜ʖ ͡°). It runs as a web daemon with a real-time dashboard styled like qBittorrent/IDM, keeps its state in SQLite or a central PostgreSQL server, and is built to run unattended on a homelab or NAS.

---

## Features

- **qBittorrent/IDM-style dashboard**: status sidebar with live counts, a virtualized queue table that stays smooth at 5,000+ items, multi-select (Ctrl/Shift), keyboard shortcuts, context menu, and a detail panel (General / Pages / Log).
- **Real-time updates over SSE**: every change is pushed to all open tabs as a small delta, with no polling.
- **Per-item control**: pause/resume, delete from queue (files on disk are never touched), and priority (top / up / down / bottom).
- **Database**: SQLite by default (zero config), or a central PostgreSQL server via `DATABASE_URL`. An existing SQLite database is migrated to PostgreSQL automatically on first start, with a backup taken first.
- **Backup, export & import** from *Settings → Database*: scheduled JSON backups with retention, validated imports (merge or replace), and an automatic backup before every replace.
- **Resilient downloading**: official API archive download when an API key is set, with a fallback to page-by-page CDN download. Includes smart delays, 429 backoff with a circuit breaker, Cloudflare/ISP DNS workarounds, and byte-level page verification with auto-resume.
- **Safe on network storage**: if the download folder is missing or not mounted yet, NHDL refuses to touch the library and recovers automatically once the disk is back.
- **Library**: rescan from disk markers, rename, and compress folders to `.cbz`/`.zip`.

---

## Quick start (local)

Requirements: **Node.js 22.13+** (the built-in `node:sqlite` module is used).

```bash
npm install
npm --prefix webui install
npm run build:ui
npm start
```

Open `http://localhost:8080`. On Windows, `start.bat` does the same, installing dependencies and building the UI automatically on first run.

---

## Docker / homelab

```bash
docker compose up -d --build
```

Adjust `docker-compose.yml` first:

- `DOWNLOAD_DIR` and the volume mounts: where galleries are saved (NAS/CIFS mounts work).
- `/app/data` volume: SQLite database and JSON backups. Keep it, so data survives rebuilds.
- Published port (the example maps `8098:8080`).

### Using a central PostgreSQL server

1. Create the database and a least-privilege user, following [docs/POSTGRES.md](docs/POSTGRES.md).
2. Put `DATABASE_URL=postgres://nhdl:<password>@<host>:5432/nhdl` in `.env` next to `docker-compose.yml`. Never commit it.
3. Uncomment the `DATABASE_URL` line (and the network section if Postgres runs in another compose project) in `docker-compose.yml`, then rebuild.

On the first start with an empty PostgreSQL database, NHDL writes a backup of the local SQLite data to `data/backups/`, copies everything to PostgreSQL, and renames the SQLite file to `nhdl.db.migrated`.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port of the web daemon |
| `DOWNLOAD_DIR` | saved setting, else `./Download` | Where galleries are downloaded |
| `DATABASE_URL` | *(empty → SQLite)* | PostgreSQL connection string |
| `NHDL_DB_PATH` | `data/nhdl.db` | SQLite database file |
| `NHDL_BACKUP_DIR` | `data/backups` | Where JSON backups are written |
| `NHDL_PASSWORD` | *(empty → no login)* | Enables the login screen |
| `NHENTAI_API_KEY` | *(empty)* | API key for fast archive downloads (can also be set in *Settings*) |
| `TEST_DATABASE_URL` | *(empty → skipped)* | PostgreSQL database used only by `npm test` |

Secrets (`NHDL_PASSWORD`, `NHENTAI_API_KEY`, `DATABASE_URL`) live in `.env` (see `.env.example`) and are never stored in the database or sent to the UI.

---

## Adding galleries

Use **Add** in the toolbar (paste links, or upload a `list.txt`). Accepted formats, one per line:

- Gallery ID: `468614`
- URL: `https://certain.site/g/468614/`
- Markdown/OneTab exports: `[Title](https://certain.site/g/468614/)`
- `# BATCH N FORMAT=cbz` starts a new batch; other lines starting with `#` are ignored.

The whole queue can be exported back to `list.txt` at any time.

Downloads are organized as `<DOWNLOAD_DIR>/<Language>/<Artist>/<Title>` (a folder of pages, or a `.cbz`/`.zip`).

---

## Maintenance

```bash
npm test                  # test suite (Postgres tests run when TEST_DATABASE_URL is set)
npm run check:archives    # find .cbz/.zip files that are not real archives (add -- --delete to remove them)
```

---

## Project layout

```text
core/            download engine, library tracker, logger
core/db/         SQLite + PostgreSQL adapters, backup, auto-migration
server/          HTTP daemon: REST API, SSE stream, static UI
webui/           Svelte 5 dashboard (built into webui/dist)
scripts/         maintenance scripts
test/            node:test suites
docs/            architecture, API contract, Postgres guide, plan, changelog
```

Further reading: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/API.md](docs/API.md), [docs/POSTGRES.md](docs/POSTGRES.md). Contributors should start with [AGENTS.md](AGENTS.md); AI agents with [docs/AI_AGENT.md](docs/AI_AGENT.md).

---

## Disclaimer

This project is intended for educational, personal archiving, and interoperability purposes. Users are responsible for complying with the target service's terms of use and local regulations.
