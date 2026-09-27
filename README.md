# NHDL (Batch Downloader for a certain site ( ͡° ͜ʖ ͡°))

A high-performance, modular Node.js tool designed to download and archive galleries efficiently and reliably. Features human-like smart delays, Cloudflare SNI bypass, ISP DNS unblocking, concurrent image downloads, byte-level file integrity verification, and a persistent library tracker.

It runs as a web daemon (`server/`) serving a REST API and a Svelte dashboard (`webui/`) with live progress and cooldown tracking. Ideal for local use, Docker, NAS, and remote homelab setups.

---

## Features

- **Modular Architecture**: Core engine (`core/`) decoupled from the web daemon (`server/`).
- **Bypass ISP DNS Hijacking**: Maps all target domains directly to Cloudflare edge IPs, avoiding local DNS redirection (e.g. Internet Positif).
- **Cloudflare WAF Mitigation & Smart Delays**: Intelligent randomized delay algorithm based on page count and history to avoid HTTP 429 rate limits.
- **Library Tracker (`library.json`)**: Persistent indexing of all downloaded titles, folder locations, and page counts. Skips network requests instantly if files already exist on disk.
- **Auto-Resume & Integrity Verification**: Verifies downloaded files down to the byte level (>2KB) and re-queues corrupted or incomplete images automatically.
- **Live Progress & Cooldown Tracking**: Live updates of current download progress, total pages, elapsed percentage, and smart delay cooldown timers.
- **Zero Runtime Dependencies for Backend**: Both `core/` and `server/` use native Node.js APIs without requiring third-party runtime packages.

---

## Architecture

```text
nhdl/
├── core/
│   ├── engine.js       # DownloaderEngine (EventEmitter, network sockets, concurrency)
│   ├── tracker.js      # Library indexer (library.json) and list tracker (list_status.txt)
│   └── utils.js        # File verification, name sanitization, delay calculations
│
├── server/
│   └── index.js        # Web App daemon, REST API, and static asset server (0 dependencies)
│
├── webui/              # Svelte + Vite + Tailwind CSS frontend dashboard
│   ├── src/
│   └── dist/           # Production compiled frontend bundle
│
├── Dockerfile          # Multi-stage container build
└── docker-compose.yml  # Homelab deployment template
```

---

## Usage

The Web App edition runs an HTTP server on port 8080 serving a real-time Svelte dashboard.

### 1. Running Locally
Ensure the frontend is compiled:
```bash
npm run build:ui
```
Start the web daemon:
```bash
node server/index.js
# Or using npm
npm start
```
Open your browser at:
`http://localhost:8080`

### 2. Docker & Homelab Deployment
A multi-stage `Dockerfile` is included that builds the Svelte UI and packages the zero-dependency Node.js backend.

1. Configure `docker-compose.yml` to map your desired download directory or CIFS/SMB NAS mount.
2. Build and start the container:
```bash
docker-compose up -d --build
```
3. Access the dashboard from your browser or via Tailscale IP on port 8080.

---

## Input Formats

The `list.txt` file accepts multiple formats interchangeably:
- Raw gallery ID: `468614`
- Full URL: `https://certain.site/g/468614/`
- Markdown or OneTab exports: `[Title](https://certain.site/g/468614/)`
- Comments: Lines starting with `#` are ignored.

---

## Folder Structure

Downloaded galleries are categorized into structured directories based on metadata:
```text
Download/
├── Japanese/
│   ├── Author Name/
│   │   └── Gallery Title/
│   │       ├── 1.jpg
│   │       ├── 2.jpg
```

---

## Disclaimer

This project is intended for educational, personal archiving, and interoperability purposes. Users are responsible for complying with the target service's terms of use and local regulations.
