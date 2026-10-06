# NHDL (Batch Downloader for a certain site ( ͡° ͜ʖ ͡°))

> **If you are an AI agent:** read [docs/AI_AGENT.md](docs/AI_AGENT.md) before deploying, managing, modifying, or maintaining this project.

A self-hosted download manager for galleries from a certain site ( ͡° ͜ʖ ͡°), plus three additional sources (site B1, B2 and C) in the same queue. It runs as a web daemon with a real-time dashboard styled like qBittorrent/IDM, keeps its state in SQLite or a central PostgreSQL server, and is built to run unattended on a homelab or NAS.

---

## Features

- **Multiple sources in one queue**: the default site (certain site) plus site B1, B2 and C. Paste a gallery URL, a plain ID (default site) or a prefixed key such as `b1:539224`; unrecognised lines are skipped and reported as `ignored`. Each item shows a source badge.
- **Content type folders**: galleries from the extra sources are classified as comic, manga or other from the site's category, shown as a Type badge, and saved under `<Type>/<Language>/<Author>/<Title>`.
- **qBittorrent/IDM-style dashboard**: sidebar filters by status (the **Queue** filter is pending + downloading), **Source** and **Type** with live counts, a virtualized queue table that stays smooth at 5,000+ items (sortable columns including the date added), a cooldown countdown chip on the next item, multi-select (Ctrl/Shift), keyboard shortcuts, context menu, and a detail panel (General / Pages / Log).
- **Real-time updates over SSE**: every change is pushed to all open tabs as a small delta, with no polling.
- **Per-item control**: pause/resume, delete from queue (files on disk are never touched), and priority (top / up / down / bottom).
- **Database**: SQLite by default (zero config), or a central PostgreSQL server via `DATABASE_URL`. An existing SQLite database is migrated to PostgreSQL automatically on first start, with a backup taken first.
- **Backup, export & import** from *Settings → Database*: scheduled JSON backups with retention, validated imports (merge or replace), and an automatic backup before every replace.
- **Resilient downloading**: official API archive download when an API key is set, with a fallback to page-by-page CDN download. Includes smart delays, 429 backoff with a circuit breaker, Cloudflare/ISP DNS workarounds, and byte-level page verification with auto-resume.
- **Safe on network storage**: if the download folder is missing or not mounted yet, NHDL refuses to touch the library and recovers automatically once the disk is back.
- **Library**: rescan from disk markers, rename, and compress folders to `.cbz`/`.zip` (one at a time or as a background batch job), with source and type filters.

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
| `DOWNLOAD_DIR` | `./Download` (Docker image: `/downloads`) | Where galleries are downloaded. Precedence at startup: `DOWNLOAD_DIR` > folder saved in *Settings* > `./Download`; the saved folder, format and auto-continue are restored after a restart |
| `DATABASE_URL` | *(empty → SQLite)* | PostgreSQL connection string |
| `NHDL_DB_PATH` | `data/nhdl.db` | SQLite database file |
| `NHDL_BACKUP_DIR` | `data/backups` | Where JSON backups are written |
| `NHDL_PASSWORD` | *(empty → no login)* | Enables the login screen |
| `NHENTAI_API_KEY` | *(empty)* | API key for fast archive downloads (can also be set in *Settings*) |
| `NHDL_LEGACY_CONFIG` | `config.json` in the repo root | One-time import of an old `config.json`; set it empty to disable |
| `TEST_DATABASE_URL` | *(empty → skipped)* | PostgreSQL database used only by `npm test` |

Secrets (`NHDL_PASSWORD`, `NHENTAI_API_KEY`, `DATABASE_URL`) live in `.env` (see `.env.example`) and are never stored in the database or sent to the UI.

---

## Adding galleries

Use **Add** in the toolbar (paste links, or upload a `list.txt`). Accepted formats, one per line:

- Gallery ID (default site): `468614`
- URL: `https://certain.site/g/468614/` (URLs of the other sources work the same way; the scheme can be omitted, e.g. `host.example/g/123/`)
- Prefixed key for the other sources: `b1:539224`, `b2:817456`, `c1:some-slug` (the real prefixes are listed in `GET /api/config` under `sources`)
- Markdown/OneTab exports: `[Title](https://certain.site/g/468614/)`
- `# BATCH N FORMAT=cbz` starts a new batch; other lines starting with `#` are ignored.

Lines that match no source are skipped and counted as `ignored`. The whole queue can be exported back to `list.txt` at any time.

Downloads from the default site are organized as `<DOWNLOAD_DIR>/<Language>/<Artist>/<Title>`; downloads from the other sources as `<DOWNLOAD_DIR>/<Type>/<Language>/<Artist>/<Title>` with `<Type>` = `Comic`, `Manga` or `Other` (a folder of pages, or a `.cbz`/`.zip`).

---

## Troubleshooting

- **Status `Download folder unavailable`**: the download folder is missing, empty while the library has entries, or more than half of the library entries are gone from disk (typically an unmounted NAS share). NHDL touches nothing and re-checks every 60 seconds. Fix the mount, or run *Library -> Rescan*, to recover. Do not create the folder by hand over an unmounted mount point.
- **Certificate errors (e.g. `self-signed certificate`) or block pages from a source**: usually the ISP DNS blocking the site. Change the DNS resolver or use a VPN; NHDL does not work around it.
- **429 / cooldown**: the site rate-limits. NHDL backs off (5, 10, 20 minutes) and pauses itself after repeated hits; resume from the toolbar later.

---

## Maintenance

```bash
npm test                  # node:test suite (the live PostgreSQL test runs only when TEST_DATABASE_URL is set)
npm run check:archives    # find .cbz/.zip files that are not real archives (add -- --delete to remove them)
```

---

## Project layout

```text
core/            download engine, library tracker, logger
core/providers/ source registry and per-source providers (default, boards, slug API), content type, HTTP helpers
core/db/         SQLite + PostgreSQL adapters, backup, auto-migration, list parser
server/          HTTP daemon: REST API, SSE stream, static UI
webui/           Svelte 5 dashboard (built into webui/dist)
scripts/         maintenance scripts
test/            node:test suites
docs/            architecture, API contract, AI agent guide, Postgres guide, plan, changelog
```

Further reading: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/API.md](docs/API.md), [docs/POSTGRES.md](docs/POSTGRES.md), [docs/PLAN.md](docs/PLAN.md), [docs/CHANGELOG.md](docs/CHANGELOG.md). Contributors should start with [AGENTS.md](AGENTS.md); AI agents with [docs/AI_AGENT.md](docs/AI_AGENT.md).

---

## Disclaimer

This project is intended for educational, personal archiving, and interoperability purposes. Users are responsible for complying with the target service's terms of use and local regulations.
