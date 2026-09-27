# NHDL — Architecture & Codebase Reference

Dokumen ini adalah peta teknis lengkap codebase NHDL agar AI agent di sesi baru **tidak perlu membaca ulang ribuan baris source code** (`core/engine.js`, `server/index.js`, `webui/src/App.svelte`, dll.) dari awal.

---

## 1. Struktur Direktori & Ukuran Modul

```text
nhdl/
├── server/
│   └── index.js          (676 baris) — HTTP server, Auth gate, REST API, Batch compress job, Static file server
├── core/
│   ├── engine.js        (1067 baris) — DownloaderEngine (EventEmitter), metadata fetch, CDN/API download, 429 backoff
│   ├── tracker.js        (612 baris) — library.json, list.txt <-> list_status.txt sync, rescan (.nhdl-id), rename, CBZ compress
│   ├── utils.js          (233 baris) — sanitizeName, getDynamicDelay, verifyImage, blank PNG generator, atomicWriteFileSync
│   ├── nhentaiApi.js     (166 baris) — certain site ( ͡° ͜ʖ ͡°) API v2 wrapper via curl + Cloudflare IP bypass (104.26.4.188)
│   ├── zip.js            (101 baris) — Zero-dependency Store-only ZIP/CBZ binary builder (PKWARE spec)
│   ├── auth.js            (67 baris) — In-memory session token (30d TTL) + timingSafeEqual password check (NHDL_PASSWORD)
│   ├── env.js             (63 baris) — Zero-dependency .env parser & updater (saveEnvValue)
│   └── logger.js          (46 baris) — Rotating activity.log (max 5000 baris)
├── webui/
│   ├── package.json                  — Svelte 5.57, Vite 8.3, Tailwind 4.3, GSAP 3.15, lucide-svelte
│   └── src/
│       └── App.svelte   (1766 baris) — Monolitik UI dashboard (masih menggunakan sintaks Svelte 4 `$:` & `let`)
└── docs/
    ├── PLAN.md                       — Roadmap rework (Fase 0–5)
    ├── CHANGELOG.md                  — Riwayat perubahan (Manual & AI)
    └── ARCHITECTURE.md               — Dokumen referensi teknis ini
```

---

## 2. File State & Format Data (Disimpan di `engine.baseDownloadDir`)

Semua file state diletakkan di dalam direktori download (`setStateDir(baseDownloadDir)` dan `setLogDir(baseDownloadDir)`) agar persisten saat container Docker di-rebuild:

1. **`list.txt`** (Input Queue):
   - Berisi daftar target per baris: URL (`https://certain.site/g/468614/`), ID (`468614`), atau format ter-enrich setelah metadata diambil:
     `https://certain.site/g/468614/ | Author Name - Gallery Pretty Title`
   - Mendukung marker batch & format per-batch:
     `# BATCH 2 FORMAT=cbz` (format: `folder` | `cbz` | `zip`).
2. **`list_status.txt`** (Tracker Queue):
   - Hasil sinkronisasi `syncListTracker(listPath)` dari `list.txt`.
   - Format baris item: `[<STATUS>] <isi_baris_list.txt>`
   - Nilai `<STATUS>`:
     - `PENDING`
     - `ON_PROGRESS`
     - `DONE`
     - `SKIPPED - Already in Library` / `SKIPPED - Files Complete` / `SKIPPED - Found on disk...` / `SKIPPED - <404 reason>`
     - `COOLDOWN - CLOUDFLARE 429`
     - `PAUSED - Circuit breaker (too many 429s)`
     - `ERROR - <message>`
   - Baris `# BATCH <N> ...` ikut disalin ke `list_status.txt`.
3. **`library.json`** (Persistent Index):
   - Key: `<galleryId>` (string).
   - Value (normal/archive):
     ```json
     {
       "title": "Pretty Title",
       "folder": "C:\\...\\Download\\Japanese\\Author\\Pretty Title.cbz",
       "pages": 24,
       "ext": "jpg",
       "pageExts": { "1": "jpg", "2": "webp" },
       "author": "Author Name",
       "lang": "Japanese",
       "downloadedAt": "2026-09-27T...",
       "archived": true,
       "archiveExt": "cbz",
       "meta": { "tags": [], "numFavorites": 123, "uploadDate": 1700000000 }
     }
     ```
   - Value (permanently skipped / 404):
     `{ "skipped": true, "reason": "404...", "skippedAt": "..." }`
4. **`.nhdl-id` & `<Archive>.cbz.nhdl-id`** (Marker Files):
   - Berisi string `galleryId`. Digunakan oleh `rescanLibrary()` (`MAX_DEPTH = 6`) untuk melacak folder/archive yang dipindah manual oleh user atau mem-prune entry yang sudah dihapus dari disk.
5. **`config.json`** (di root project):
   - Menyimpan `{ "downloadDir": "...", "downloadFormat": "cbz" | "folder", "autoContinueBatches": true }`.
6. **`error.log`** (max 200 baris), **`placeholder_pages.log`**, **`activity.log`** (max 5000 baris).

---

## 3. Core Engine (`core/engine.js` — `DownloaderEngine`)

Turunan `EventEmitter`. Mengelola antrian, anti-rate-limit, dan pengunduhan.

### Properti Utama
- `baseDownloadDir`: Folder output (`<base>/<Language>/<Author>/<Title>`).
- `downloadFormat`: `'cbz'` (default) | `'folder'`.
- `autoContinueBatches`: `boolean` (default `true`).
- `batchSize`: `50` galeri sebelum istirahat batch (`batchRestMinutes`: `5` menit).
- `concurrency`: `3` halaman paralel per galeri.
- `isRunning`, `isPaused`, `isStopped`, `forceRetry`: Flags kontrol eksekusi.
- `currentProgress`: Objek snapshot progress aktif yang saat ini dibaca oleh `/api/status` (dan nantinya dipush lewat SSE `/api/events`).
- `consecutiveRateLimits`, `circuitBreakerTripped`: State proteksi 429 (maks 3x 429 berturut-turut dengan backoff eksponensial 5m -> 10m -> 20m, lalu trip circuit breaker & auto-pause).

### Event yang Di-emit oleh `DownloaderEngine`
| Event | Payload | Keterangan |
|---|---|---|
| `'batch_start'` | `{ total, pending, skipped }` | Saat `runBatch()` dimulai |
| `'progress'` | `currentProgress` (`{ galleryId, title, percent, completed, total, taskNum, totalTasks, activePages, speedKBps, stalled, stalledSeconds, live: true }`) | Heartbeat tiap 1 detik atau saat halaman selesai |
| `'cooldown'` | `currentProgress` (`{ type: 'COOLDOWN' \| 'BATCH_REST' \| 'RATE_LIMIT', title, message, percent, remaining, total, taskNum, totalTasks }`) | Detak tiap 1 detik selama masa tunggu |
| `'done'` | `{ galleryId, title, pages, currentTaskNum, totalTasks }` | Satu galeri selesai diunduh (via API atau CDN) |
| `'skipped'` | `{ galleryId, title, currentTaskNum, totalTasks, reason }` | Galeri dilewati (ada di library / disk / 404) |
| `'error'` | `{ galleryId, error, currentTaskNum, totalTasks }` | Galeri gagal (memiliki listener di `server/index.js` L30 agar tidak crash) |
| `'rate_limit'` | `{ galleryId, waitSeconds, consecutiveRateLimits }` | Saat terkena HTTP 429 |
| `'circuit_breaker'` | `{ galleryId, consecutiveRateLimits }` | Saat >3x 429 berturut-turut (engine otomatis `pause()`) |
| `'batch_complete'` | `{ processed }` | Saat `runBatch()` selesai |
| `'paused'` / `'resumed'` / `'stopped'` / `'restarted'` / `'retry_triggered'` / `'config_updated'` | Objek opsional | Perubahan state engine |

### Alur `processGallery(galleryId)` (L505–L836)
1. Set status `ON_PROGRESS` di `list_status.txt`.
2. Cek `library.json`: jika valid di disk (`verifyImage` >= 2KB untuk tiap halaman atau file `.cbz`/`.zip` ada), langsung return `SKIPPED - Already in Library` (0 request jaringan).
3. Panggil `fetchMetadata(galleryId)`:
   - **API-first** (`core/nhentaiApi.js` -> `GET /api/v2/galleries/<id>` via `curl --resolve certain.site:443:104.26.4.188`). Menggunakan `title.pretty` untuk nama file.
   - **Fallback HTML scrape** (`fetchMetadataViaHtml`) jika API gagal.
   - Jika `RATE_LIMIT` (429), cek dulu `getCachedDisplayName()` di `list.txt` + `findExistingOnDisk()` untuk menghindari cooldown 5 menit jika file sebenarnya sudah ada di disk.
4. Cek apakah sudah ada archive/folder di `parentDir` (`<base>/<Lang>/<Author>/`).
5. **Fast-path API Archive Download** (`tryApiArchiveDownload` L464): jika `NHENTAI_API_KEY` diset dan format target `cbz`/`zip`, minta presigned download URL dari API v2. Jika gagal, fallback ke per-page CDN.
6. **Per-page CDN Download** (L681–L833):
   - Unduh paralel (`concurrency = 3`) dari `i1..i4.certain.site` (dipin ke IP `104.26.4.188`).
   - Jika sebuah halaman gagal verifikasi (`< 2KB`) sebanyak 5x berturut-turut dan ukurannya `< 1536` byte (placeholder blokir CDN), substitusi dengan PNG putih valid menggunakan `writeBlankPlaceholderImage()` dan catat di `placeholder_pages.log`.
   - Setelah semua halaman selesai, simpan ke `library.json`, tulis `.nhdl-id`, dan panggil `maybeCompress()` jika format batch adalah `cbz`/`zip`.

---

## 4. Kontrak REST API (`server/index.js`)

Port default: `8080`. Semua response berformat JSON (kecuali `/api/logs/download` dan halaman login HTML).

| Method | Endpoint | Fungsi & Payload |
|---|---|---|
| `POST` | `/api/login` | `{ password }` -> Set cookie `nhdl_session` (HttpOnly, 30 hari) |
| `POST` | `/api/logout` | Hapus sesi & cookie |
| `GET` | `/api/status` | Baca `list.txt`, `list_status.txt`, `error.log` dari disk + `engine.currentProgress` & `engine.getStatus()`. Return `{ items, batchCount, rawList, errors, liveProgress, engineStatus, autoContinueBatches }` |
| `POST` | `/api/queue` | `{ text }` -> Tulis `list.txt`, panggil `syncListTracker()`, auto-start `engine.runBatch()` jika idle |
| `POST` | `/api/control` | `{ action: 'start' \| 'pause' \| 'resume' \| 'restart' }` -> Kontrol `engine` |
| `POST` | `/api/retry` | `{ galleryId? }` -> `engine.triggerForceRetry()`, jika ada `galleryId` set `PENDING` & `autoProcessQueue()` |
| `GET` | `/api/config` | Return `{ downloadDir, downloadFormat, autoContinueBatches, authRequired, apiKeyConfigured, apiKeyMasked }` |
| `POST` | `/api/config` | Update salah satu dari `{ downloadDir, downloadFormat, autoContinueBatches, apiKey }` |
| `POST` | `/api/config/verify-key` | `{ apiKey? }` -> Verifikasi key ke `/api/v2/user` |
| `GET` | `/api/library` | Return `{ items: [...], total }` dari `library.json` (diurutkan `downloadedAt` terbaru) |
| `POST` | `/api/library/rescan` | Jalankan `rescanLibrary(engine.baseDownloadDir)` -> `{ scanned, relocated, unchanged, pruned }` |
| `POST` | `/api/library/rename` | `{ id, newName }` -> `renameLibraryEntry()` (ubah nama folder/archive + update `library.json` & `list.txt`) |
| `POST` | `/api/library/compress` | `{ id, ext: 'cbz'\|'zip' }` -> `compressLibraryEntry()` untuk 1 galeri |
| `POST` | `/api/library/batch-compress` | `{ ids: [...], ext }` -> Mulai background job `compressJob` di server |
| `GET` | `/api/library/compress-status` | Return `{ job: compressJob }` untuk polling progress konversi batch |
| `GET` | `/api/fs/browse?path=...` | Return `{ currentPath, parentPath, drives, directories }` untuk modal folder picker |
| `GET` | `/api/logs` | Return `{ log }` (`activity.log`) |
| `GET` | `/api/logs/download` | Unduh file `activity.log` sebagai attachment `text/plain` |

---

## 5. Peta Frontend (`webui/src/App.svelte` — 1766 Baris)

Saat ini masih berupa 1 komponen monolitik dengan sintaks Svelte 4 (`let`, `$:`):
- **L1–L111**: State queue (`items`, `rawList`, `engineStatus`, `liveProgress`), pencarian/filter (`queueSearch`, `queueFilter`), dan blok reaktif `$:` (`doneCount`, `hud`, `activeBatchNum`, `batches`, `visibleBatches`).
- **L112–L343**: State & fungsi Folder Picker, Library Modal (`libraryItems`, batch compress polling 500ms, rescan, inline rename, single compress).
- **L344–L378**: `fetchStatus()` — dipanggil tiap **1000ms** (`setInterval` di `onMount` L504). Memakai `lastItemsSignature` (`items.map(i => i.url + i.status).join('\n')`) untuk mencegah assign ulang `items` jika status tidak berubah, namun reaktivitas turunan tetap berat saat list ribuan item.
- **L379–L502**: Config, API key verification, dan Activity Logs.
- **L518–L733**: Manipulasi teks `rawList` (`appendToList`, `saveList`, `clearCompleted`, `requestDeleteBatch`, `deleteItem`).
- **L811–L1035**: Template Header & Download Progress HUD (termasuk kartu progress per-halaman aktif).
- **L1038–L1302**: Grid 2 Kolom:
  - Kiri (`L1040–L1218`): Execution Queue (accordion per Batch, `animate:flip`, filter, tombol retry/delete per baris).
  - Kanan (`L1220–L1301`): Target Insert textarea + pemilih format batch, editor raw `list.txt`, dan panel System Faults (`errors`).
- **L1306–L1751**: 4 Modal (Folder Picker + Settings `L1306`, Delete Batch Confirm `L1476`, Library Manager `L1512`, Activity Logs `L1715`).

---

## 6. Catatan Penting untuk Rework (`docs/PLAN.md` Fase 1–6)

1. **Fase 1 — Pindah Semua Data ke SQLite (`node:sqlite`, Zero Dependency)**:
   - Menggantikan seluruh state file teks/JSON (`list.txt`, `list_status.txt`, `progress.json`, `library.json`, `config.json`, `activity.log`, `error.log`) dengan database SQLite tunggal `data/nhdl.db` (`PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`).
   - `.env` (`NHENTAI_API_KEY`, `NHDL_PASSWORD`) **tetap di file `.env`**.
   - `list.txt` hanya dipakai sebagai fitur **import/export**, bukan state aktif.
   - Tabel di `core/db.js`:
     - `queue` (menggantikan `list.txt` + `list_status.txt` + `progress.json`)
     - `library` (diisi ulang melalui `rescanLibrary()` menggunakan file marker `.nhdl-id` / `.cbz.nhdl-id` yang sudah ada di tiap folder/archive)
     - `settings` (menggantikan `config.json`)
     - `events` (menggantikan `activity.log` & `error.log`)
     - `schema_version`
2. **Fase 2 — Backend Push Delta (SSE `/api/events`)**:
   - Setiap mutasi baris `queue` di `core/db.js` meng-emit event.
   - Endpoint `/api/events` mengirim snapshot awal + delta (`item`, `progress`, `engine`).
3. **Fase 3 & 4 — Frontend Svelte 5 Runes + Layout qBittorrent/IDM**:
   - `webui/package.json` **sudah menggunakan Svelte `^5.57.0`**, siap dimigrasikan ke Runes (`$state`, `$derived`, `$effect`), dipecah menjadi komponen + store, dengan virtual table (sortable, paginated dari server) dan panel detail bertab (`General` / `Pages` / `Log` dari tabel `events`).

