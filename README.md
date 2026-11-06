<div align="center" id="top">

# NHDL

### Self-Hosted Multi-Source Gallery Download Manager & Library Automator

A high-concurrency, self-hosted batch download manager and metadata tagger for digital gallery archives. Features a qBittorrent/IDM-style virtualized UI, real-time SSE streaming, dual SQLite/PostgreSQL storage, and automatic unmounted NAS safeguards.

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg?style=flat-square&logo=node.js&logoColor=white)](#tech-stack)
[![Database](https://img.shields.io/badge/Database-SQLite%20%7C%20PostgreSQL-336791.svg?style=flat-square&logo=postgresql&logoColor=white)](#tech-stack)
[![Real-time](https://img.shields.io/badge/Real--time-Server--Sent%20Events-FF6C37.svg?style=flat-square)](#download-pipeline--architecture)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg?style=flat-square&logo=docker&logoColor=white)](#docker--homelab-deployment)
[![Metadata](https://img.shields.io/badge/Metadata-ComicInfo.xml%20%2B%20info.json-brightgreen.svg?style=flat-square)](#key-features)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

[Quick start](#quick-start-local) · [Architecture](#download-pipeline--architecture) · [Features](#key-features) · [Docker & homelab](#docker--homelab-deployment) · [Troubleshooting](#troubleshooting)

</div>

---

> Built for homelab operators and media collectors: an unattended, resilient queue daemon that ingests multi-source gallery links, embeds ComicInfo/info.json metadata, and protects network storage mounts from overflow.

---

## Download Pipeline & Architecture

NHDL operates as an asynchronous, stateful queue manager with automated error mitigation and metadata enrichment:

```mermaid
flowchart TD
    subgraph Ingest[" 1. Ingestion & Input Normalizer "]
        Links["Source Links / IDs / list.txt / OneTab"]
        Norm["Ingestion Queue & Normalizer<br/>(Default site + B1, B2, C extra sources)"]
    end

    subgraph Safety[" 2. Storage & Mount Watchdog "]
        Canary["Storage & Mount Watchdog<br/>(NAS .mounted canary validation)"]
    end

    subgraph Engine[" 3. Download Engine & Concurrency "]
        Queue["Priority Task Queue<br/>(Per-item priority, pause, resume)"]
        Fetch["Download Strategy Controller<br/>(API Archive extraction / CDN page-by-page)"]
        Breaker["Anti-Ban & Rate-Limit Guard<br/>(Smart delay pacing & 429 circuit breaker)"]
    end

    subgraph Packaging[" 4. Tagging & Packaging "]
        Tagger["Metadata Engine<br/>(ComicInfo.xml & info.json injection)"]
        Packer["Archive Packager<br/>(Folder of pages / .cbz / .zip compression)"]
    end

    subgraph Storage[" 5. Persistence Layer "]
        DB[("Dual Storage Engine<br/>(SQLite nhdl.db / Central PostgreSQL)")]
        Disk[("Target Storage / NAS Share<br/>(/downloads: Type / Language / Artist / Title)")]
    end

    subgraph UI[" 6. Telemetry & User Interface "]
        SSE["Server-Sent Events Stream<br/>(Real-time delta push without polling)"]
        Grid["Virtualized Web Dashboard<br/>(qBittorrent/IDM grid, 5,000+ items smooth)"]
    end

    Links --> Norm
    Norm --> Canary
    Canary -->|Mount verified| Queue
    Canary -.->|Mount missing| Breaker
    Queue --> Fetch
    Fetch --> Breaker
    Fetch --> Tagger
    Tagger --> Packer
    Packer --> Disk
    Queue <--> DB
    Queue --> SSE
    SSE --> Grid
```

---

## Key Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>Download Engine & Storage Protection</h4>
      <ul>
        <li><strong>Multi-Source Queuing</strong>: Default site plus B1, B2, and C extra sources managed in a single, unified concurrent queue.</li>
        <li><strong>Dual Download Strategies</strong>: Official API archive extraction with automatic fallback to concurrent page-by-page CDN fetching.</li>
        <li><strong>Anti-Ban & Rate-Limiting</strong>: Adaptive request pacing, exponential 429 backoff cooldowns, and automatic circuit breakers.</li>
        <li><strong>NAS Safety Guard</strong>: Actively detects missing or unmounted storage shares, halting operations immediately to prevent local disk overflow.</li>
        <li><strong>Library Automator</strong>: Background filesystem rescan, bulk <code>.cbz</code>/<code>.zip</code> compression, and metadata injection (<code>ComicInfo.xml</code>, <code>info.json</code>).</li>
      </ul>
    </td>
    <td width="50%" valign="top">
      <h4>User Experience & Telemetry</h4>
      <ul>
        <li><strong>Virtualized Dashboard</strong>: Desktop-class qBittorrent/IDM interface rendering 5,000+ items smoothly without DOM lag.</li>
        <li><strong>Real-Time SSE Streaming</strong>: Instant Server-Sent Events push delta updates across all open browser tabs without polling.</li>
        <li><strong>Deep Multi-Level Filtering</strong>: Instant slicing by Status (pending, downloading, completed), Source, and Content Type (Comic, Manga, Other).</li>
        <li><strong>Per-Item Priority Controls</strong>: Interactive pause, resume, top/bottom queue reordering, and cooldown countdown chips.</li>
        <li><strong>Flexible Database</strong>: Zero-config embedded SQLite with automated migration and backup to central PostgreSQL.</li>
        <li><strong>Automated Backups</strong>: Scheduled automated JSON database backups with retention policies and pre-restore safeties.</li>
      </ul>
    </td>
  </tr>
</table>

### Supported Ingestion Formats

Add items via the **Add** toolbar modal or upload a `list.txt`:

| Format | Example Syntax | Ingestion Behavior |
|---|---|---|
| **Gallery ID** | `468614` | Ingests from default site |
| **Direct URL** | `https://certain.site/g/468614/` | Automatically maps to matching provider |
| **Prefixed Key** | `b1:539224`, `b2:817456`, `c1:slug` | Targets specific extra provider source |
| **Markdown / OneTab** | `[Title](https://certain.site/g/468614/)` | Extracts URL and cleans markdown titles |
| **Batch Header** | `# BATCH 1 FORMAT=cbz` | Sets output format (`cbz`, `zip`, `folder`) for upcoming items |

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Runtime** | Node.js 22.13+ | Modern JavaScript runtime using native `node:sqlite` |
| **Backend Daemon** | Express / Native HTTP | REST API endpoints, SSE stream dispatcher, and queue daemon |
| **State & Storage** | SQLite (`node:sqlite`) & PostgreSQL (`pg`) | Dual storage engine with automatic backup and migration |
| **Transport** | Server-Sent Events (SSE) | Unidirectional real-time queue delta delivery |
| **Frontend UI** | Svelte 5 & Vite | High-density virtualized grid dashboard |
| **Archive Packaging** | Adm-Zip & Custom XML Serializer | Packaging to `.cbz`/`.zip` with `ComicInfo.xml` and `info.json` tagging |
| **Containerization** | Docker Alpine | Lightweight container footprint for homelab/NAS deployment |

---

## Quick Start (Local)

### Prerequisites

- **Node.js 22.13+** (required for built-in `node:sqlite`)
- **npm** (bundled with Node.js)

### Installation & Execution

```bash
# Clone repository
git clone https://github.com/samsmon/nhdl.git
cd nhdl

# Install backend dependencies
npm install

# Install UI dependencies and build frontend assets
npm --prefix webui install
npm run build:ui

# Start the daemon
npm start
```

Open `http://localhost:8080` in your browser.

> [!TIP]
> **Windows Launch Helper**: Execute `start.bat` on Windows. It validates requirements, automatically installs dependencies and builds UI assets on first run, and launches the server.

---

## Docker & Homelab Deployment

Deploy NHDL on Docker, Proxmox LXC, or NAS systems (TrueNAS, Unraid, Synology):

```yaml
services:
  nhdl:
    build: .
    container_name: nhdl
    restart: unless-stopped
    ports:
      - "8098:8080"
    environment:
      - TZ=Asia/Jakarta
      - DOWNLOAD_DIR=/downloads
      # Optional: centralized PostgreSQL connection
      # - DATABASE_URL=postgres://nhdl:secret@postgres.homelab.local:5432/nhdl
    volumes:
      # Gallery destination storage (bind mount or NFS/SMB share)
      - /mnt/storage/manga:/downloads
      # Persistent application state (SQLite database and JSON backups)
      - /mnt/storage/appdata/nhdl:/app/data
```

Start the container stack:
```bash
docker compose up -d
```

### Central PostgreSQL Setup

1. Provision a database and dedicated role following [docs/POSTGRES.md](docs/POSTGRES.md).
2. Set `DATABASE_URL=postgres://nhdl:<password>@<host>:5432/nhdl` in `.env` (never commit passwords).
3. Restart or rebuild the container. On first boot, NHDL writes a local backup to `data/backups/`, migrates all records to PostgreSQL, and renames the local database to `nhdl.db.migrated`.

---

## Configuration Reference

Configure NHDL via environment variables or a `.env` file in the project root:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port for web daemon and UI |
| `DOWNLOAD_DIR` | `./Download` (Docker: `/downloads`) | Destination directory for downloaded galleries |
| `DATABASE_URL` | *(empty &rarr; SQLite)* | Central PostgreSQL connection string |
| `NHDL_DB_PATH` | `data/nhdl.db` | Path to local SQLite database file |
| `NHDL_BACKUP_DIR` | `data/backups` | Target directory for automated JSON backups |
| `NHDL_PASSWORD` | *(empty &rarr; disabled)* | Optional authentication password for web UI |
| `NHENTAI_API_KEY` | *(empty)* | API key enabling official high-speed archive downloads |
| `NHDL_LEGACY_CONFIG` | `config.json` | Path for one-time legacy configuration migration |
| `TEST_DATABASE_URL` | *(empty &rarr; skipped)* | Isolated PostgreSQL database used solely by `npm test` |

> [!IMPORTANT]
> Keep credentials (`NHDL_PASSWORD`, `NHENTAI_API_KEY`, `DATABASE_URL`) in `.env`. They are never persisted in the database or exposed to the client browser.

---

## Troubleshooting & Diagnostics

| Problem | Root Cause | Resolution |
|---|---|---|
| `Download folder unavailable` | Storage share unmounted, missing, or empty while library has entries | Remount NAS/storage share. NHDL monitors status every 60s and recovers automatically once disk returns. Do not create directories over unmounted points. |
| `429 Too Many Requests` | Upstream provider rate-limits due to high request density | NHDL triggers exponential backoff (5, 10, 20 min) and cooldown chips. Wait for cooldown expiration or manually resume via toolbar. |
| Certificate Errors / Block Pages | ISP DNS filtering or tampering with target domains | Configure DNS-over-HTTPS or forward container DNS over TCP (see `nhdl-dns` CoreDNS configuration in `docker-compose.yml`). |
| Library Disk Inconsistencies | Archives renamed, added, or deleted outside NHDL | Open **Library &rarr; Rescan** in the web dashboard to synchronize disk markers with the persistence store. |

---

## Modular Documentation Index

| Document | Description |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Deep architectural overview, state machines, and concurrency lifecycles |
| [`docs/API.md`](docs/API.md) | Comprehensive REST API contract and SSE event streaming specs |
| [`docs/POSTGRES.md`](docs/POSTGRES.md) | PostgreSQL deployment guide, permissions, and migration verification |
| [`docs/AI_AGENT.md`](docs/AI_AGENT.md) | Autonomous agent operational guidelines, rules of engagement, and architecture map |
| [`docker-compose.yml`](docker-compose.yml) | Production Docker stack with CoreDNS TCP forwarder and volume configuration |
| [`list.txt.example`](list.txt.example) | Example syntax and batch headers for bulk gallery importation |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Historical version tracking and recent enhancements |

---

<div align="center">

Released under the [MIT License](LICENSE). Built for unattended, resilient media archiving.

[Back to top](#top)

</div>
