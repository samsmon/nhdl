# NHDL — Architecture & Codebase Reference

Dokumen ini adalah peta teknis lengkap codebase NHDL agar AI agent di sesi baru **tidak perlu membaca ulang ribuan baris source code** (`core/engine.js`, `server/index.js`, `webui/src/lib/stores/app.svelte.js`, dll.) dari awal. Jumlah baris di bawah adalah hasil `wc -l` pada saat dokumen ini diperbarui, jadi anggap sebagai perkiraan.

---

## 1. Struktur Direktori & Ukuran Modul

```text
nhdl/
├── server/
│   └── index.js                 (1132 baris) — HTTP server, auth gate, REST API, SSE, batch compress job, static file server
├── core/
│   ├── db.js                     (326 baris) — Database facade & dispatcher (SQLite / PostgreSQL via DATABASE_URL), semua fungsi async
│   ├── db/
│   │   ├── common.js             (131 baris) — normalizeGalleryId (kunci kanonik), formatQueueRow/publicRow (`toPublicId`), maskDatabaseUrl, validasi import, CURRENT_APP_SCHEMA_VERSION (4)
│   │   ├── listParser.js          (83 baris) — parseListText / parseListTextDetailed: baris list.txt (URL, ID polos, kunci berprefix) -> kunci kanonik via provider registry, menghitung `ignored`
│   │   ├── events.js               (7 baris) — Shared EventEmitter (dbEvents)
│   │   ├── sqlite.js            (1249 baris) — SQLite adapter (`node:sqlite`, `data/nhdl.db`, WAL), array `MIGRATIONS` v1–v4
│   │   ├── postgres.js          (1271 baris) — PostgreSQL adapter (`pg.Pool`, retry koneksi, BIGSERIAL, TIMESTAMPTZ), array `MIGRATIONS` v1–v4
│   │   ├── backup.js             (209 baris) — Backup JSON manual/terjadwal, rotasi, restore, folder backup (`NHDL_BACKUP_DIR`)
│   │   └── auto-migrate.js       (107 baris) — Migrasi otomatis SQLite -> PostgreSQL saat Postgres masih kosong
│   ├── providers/                           — Lapisan multi-source (satu file per jenis sumber)
│   │   ├── index.js              (111 baris) — Registry: `resolveInput`, `canonicalKey`, `toPublicId`, `sourceOf`, `providerForKey`, `listSources`, `registerProvider`
│   │   ├── default.js             (21 baris) — Provider site A (certain site ( ͡° ͜ʖ ͡°)): kunci angka polos, jalur API/CDN lama di engine
│   │   ├── contentType.js         (30 baris) — Tipe konten: `mapCategoryToType(slug)` (slug kategori situs -> `comic`/`manga`/`other`), `typeFolderName`, `isContentType`
│   │   ├── boards.js             (144 baris) — Pabrik provider site B1/B2 (halaman HTML galeri + daftar halaman ber-ekstensi per halaman)
│   │   ├── slugapi.js            (116 baris) — Pabrik provider site C (slug galeri + JSON API gambar)
│   │   └── http.js               (201 baris) — `fetchText` & `downloadToFile` bersama (User-Agent, redirect, file `.part` atomik; sebelum rename, `.part` harus diawali signature gambar webp/jpeg/png/gif, kalau tidak dianggap halaman blokir HTML dan ditolak tanpa `statusCode`) plus `curlFetchText` & `curlDownloadToFile` (system `curl` lewat `execFile`)
│   ├── engine.js               (1377 baris) — DownloaderEngine (EventEmitter): loop antrian, metadata fetch, API/CDN/provider download, 429 backoff + circuit breaker, pengaman folder download
│   ├── tracker.js               (622 baris) — Library & antrian di atas DB: `rescanLibrary` (`.nhdl-id` / `.cbz.nhdl-id`), `isDownloadDirHealthy`, rename, kompresi CBZ/ZIP
│   ├── utils.js                 (232 baris) — sanitizeName (escaped control chars), getDynamicDelay, verifyImage, blank PNG, atomicWriteFileSync
│   ├── nhentaiApi.js            (187 baris) — certain site ( ͡° ͜ʖ ͡°) API v2 wrapper via curl + Cloudflare IP bypass + Zip magic-byte check (PK\x03\x04)
│   ├── zip.js                   (100 baris) — Zero-dependency Store-only ZIP/CBZ binary builder (PKWARE spec)
│   ├── auth.js                   (66 baris) — In-memory session token (30d TTL) + timingSafeEqual password check (NHDL_PASSWORD)
│   ├── env.js                    (62 baris) — Zero-dependency .env parser & updater (saveEnvValue)
│   └── logger.js                 (83 baris) — Audit & error logger ke tabel `events` (retensi 10.000 baris)
├── scripts/
│   └── find-bad-archives.js     (122 baris) — `npm run check:archives` (deteksi & `--delete` file .cbz/.zip korup/HTML challenge + cetak daftar ID)
├── test/                                    — Suite `node:test` (`npm test`), 14 file; jaringan selalu di-stub
│   ├── db.test.js              (2168 baris) — `core/db.js`, migrasi, import/export, backup, `rescanLibrary`, pre-pass engine, 1000-link restart consistency; suite live PostgreSQL (di-skip tanpa `TEST_DATABASE_URL`)
│   ├── sse.test.js              (840 baris) — SSE snapshot/delta, 5000-item, endpoint API
│   ├── nhentaiApi.test.js        (51 baris) — `downloadArchiveFile` User-Agent & validasi signature zip
│   ├── multiSource.db.test.js   (292 baris) — kunci berprefix, parser list, migrasi v3, export/import
│   ├── multiSource.engine.test.js (264 baris) — unduhan galeri berprefix lewat provider (server lokal)
│   ├── providers.test.js         (69 baris) — registry/resolveInput
│   ├── providerFetch.test.js    (384 baris) — `fetchMeta`/`pageUrls` per provider, helper `http.js` (Node & curl), 429/503
│   ├── providerCategory.test.js (101 baris) — ekstraksi kategori di provider B1/B2/C
│   ├── contentType.test.js       (34 baris) — pemetaan kategori -> tipe
│   ├── contentType.db.test.js   (100 baris) — skema v4 `queue.category`, export/import
│   ├── contentType.engine.test.js (143 baris) — folder bertipe & `findExistingOnDisk`
│   ├── webuiSources.test.js      (47 baris) — helper `webui/src/lib/sources.js`
│   ├── webuiQueueView.test.js    (90 baris) — helper `webui/src/lib/queueView.js`
│   └── webuiContentType.test.js  (47 baris) — helper `webui/src/lib/contentType.js`
├── webui/
│   ├── package.json                         — Svelte 5.57, Vite 8.3, Tailwind 4.3, GSAP 3.15, lucide-svelte
│   └── src/
│       ├── App.svelte             (90 baris) — Layout utama qBittorrent/IDM (Toolbar, SidebarFilter, VirtualQueueTable, DetailPanel, StatusBar + modal)
│       ├── main.js, app.css                 — Entry Vite dan tema (CSS variables)
│       └── lib/
│           ├── api.js            (280 baris) — Satu-satunya tempat `fetch` ke backend
│           ├── sources.js         (58 baris) — Helper murni: sumber item, filter/hitung per sumber, label badge
│           ├── queueView.js       (56 baris) — Helper murni: definisi filter "Queue", `nextPendingId`, chip cooldown, kolom "Ditambahkan"
│           ├── contentType.js     (43 baris) — Helper murni: label/badge/filter tipe konten
│           ├── stores/app.svelte.js (925 baris) — Store reaktif (runes): klien SSE, `SvelteMap` queue, filter, seleksi, config
│           └── components/                  — 19 komponen Svelte 5 (lihat bagian 5)
└── docs/
    ├── PLAN.md                              — Roadmap rework (Fase 0–8) + multi-source + tipe konten
    ├── CHANGELOG.md                         — Riwayat perubahan (Manual & AI)
    ├── ARCHITECTURE.md                      — Dokumen referensi teknis ini
    ├── API.md                               — Kontrak endpoint REST & event SSE
    ├── AI_AGENT.md                          — Panduan deploy/kelola/modifikasi/rawat untuk AI agent
    ├── POSTGRES.md                          — Panduan konfigurasi PostgreSQL terpusat
    └── superpowers/                         — Spec & plan historis (tidak diubah)
```

Di luar kode: `Dockerfile` (multi-stage, `node:24-alpine`, `curl` terpasang, port 8080), `docker-compose.yml`, `.env.example`, `start.bat`, `list.txt.example`. `.gitignore` mengabaikan `node_modules/`, `webui/dist/`, `data/`, `Download/`, `.env`, `samples/` (sampel manual lokal), dan sisa file state lama.

---

## 2. State & Format Data

Semua state ada di database (`core/db.js`): SQLite `data/nhdl.db` (atau `NHDL_DB_PATH`) secara default, PostgreSQL bila `DATABASE_URL` terisi. Satu-satunya state di luar DB adalah secret di `.env` dan file marker di folder unduhan. Folder unduhan (`engine.baseDownloadDir`) hanya berisi hasil unduhan.

### Tabel (versi skema saat ini: **4**)

| Tabel | Kolom utama |
|---|---|
| `queue` | `id`, `gallery_id` (TEXT, UNIQUE; kunci kanonik), `url`, `title`, `status`, `batch`, `priority`, `pages_done`, `pages_total`, `error`, `retries`, `created_at`, `updated_at`, `format` (v2), `category` (v4; tipe konten `comic`/`manga`/`other` atau NULL) |
| `library` | `gallery_id` (TEXT, PK), `title`, `path` (folder atau file arsip), `pages`, `format`, `language`, `artist`, `added_at`, `meta` (v2; JSON teks: `ext`, `pageExts`, `tags`, `contentType`, dst.; untuk galeri yang di-skip permanen: `{ "skipped": true, "reason": ..., "skippedAt": ... }`) |
| `settings` | `key`, `value` (JSON teks): `downloadDir`, `downloadFormat`, `autoContinueBatches`, `backupIntervalHours`, `backupKeep`, `lastBackupAt` |
| `events` | `id`, `ts`, `level`, `gallery_id`, `message` (log aktivitas & error, dipangkas ke 10.000 baris) |
| `schema_version` | `version` |

Migrasi: v1 skema awal, v2 kolom `queue.format` dan `library.meta`, v3 `gallery_id` menjadi `TEXT`, v4 `queue.category`. Migrasi ada di array `MIGRATIONS` pada **kedua** adapter dan dijalankan otomatis saat startup. Status item `queue`: `PENDING`, `ON_PROGRESS`, `STOPPED` (pause manual), `PAUSED` (circuit breaker), `COOLDOWN`, `DONE`, `ERROR`, `SKIPPED`.

### Marker file & `.env`

- **`.nhdl-id`** (di dalam folder galeri) dan **`<Arsip>.cbz.nhdl-id`** (di samping arsip): berisi kunci kanonik galeri (angka polos untuk site A, `<prefix>:...` untuk sumber lain). Dipakai `rescanLibrary()` (`MAX_DEPTH = 6`) untuk melacak folder/arsip yang dipindah manual oleh user dan untuk mem-prune entri yang sudah dihapus dari disk.
- **`.env`**: `NHDL_PASSWORD`, `NHENTAI_API_KEY`, `DATABASE_URL`, `PORT`, dst. Tidak pernah disimpan di DB atau dikirim ke UI.
- **`config.json` lama** (root project): hanya dibaca satu kali oleh `migrateLegacyConfigJson` bila tabel `settings` kosong (dimatikan dengan `NHDL_LEGACY_CONFIG=`). File state teks lama (`list_status.txt`, `library.json`, `progress.json`, `activity.log`, `error.log`) tidak dipakai lagi; `list.txt` hanya format import/export (`# BATCH N FORMAT=cbz`).
- **Folder unduhan**: `DOWNLOAD_DIR` bila di-set, kalau tidak `./Download` (Docker: `/downloads`). Pilihan folder di Settings diterapkan langsung dan disimpan ke `settings.downloadDir`, tetapi saat startup engine hanya membaca `DOWNLOAD_DIR`/default (konstruktor `DownloaderEngine`; tidak ada pembacaan balik dari `settings`).

### 2a. Kunci Galeri (`gallery_id`), Provider, dan `source`

- **Kunci kanonik** disimpan sebagai `TEXT` di tabel `queue` dan `library` (skema v3). Site A memakai angka polos sebagai teks (`"468614"`); sumber lain memakai `"<prefix>:<isi>"` (mis. `b1:539224`, `b2:817456`, `c1:some-slug`). Prefix nyata hanya ada di `core/providers/index.js`.
- **`toPublicId(key)`** (`core/providers/index.js`): kunci angka polos dikembalikan sebagai `number` (kompatibel dengan klien/API lama), kunci berprefix tetap `string`. Dipakai oleh `formatQueueRow`/`publicRow` sehingga API, SSE, dan export JSON selalu memuat nilai publik; `canonicalKey()` membalikkannya untuk input.
- **`source`**: field turunan (`sourceOf(key)`) berisi id provider (`"default"` untuk site A / kunci angka polos, prefix provider untuk sumber lain). Tidak ada kolom DB khusus; dihitung saat baris diformat. Diekspos di `/api/status`, `/api/library`, dan event SSE `item`. UI memakainya untuk badge dan filter sumber (`webui/src/lib/sources.js`).
- **Tampilan antrian di webui** (`webui/src/lib/queueView.js`, helper murni): filter sidebar "Queue" (id `queued`) mencakup `PENDING` + `ON_PROGRESS`; `filterCounts.queued` memakai definisi yang sama, sedangkan `filterCounts.pending` (hanya `PENDING`) dipakai status bar. Store menurunkan `nextPendingId` (item `PENDING` pertama menurut urutan rank) dan `cooldown` (dari `liveProgress`: `COOLDOWN`/`BATCH_REST` menjadi chip di `nextPendingId`, `RATE_LIMIT` menjadi chip di item berstatus `COOLDOWN`). Kolom "Ditambahkan" membaca `createdAt` (SQLite: UTC tanpa zona; PostgreSQL: ISO). Semua perubahan lewat SSE yang sudah ada.
- **Interface provider** (objek di registry): `id`, `label`, `prefix`, `isDefault`, `transport` (`'node'` atau `'curl'`), `origin`, `urlPatterns` (regex URL galeri, grup 1 = isi kunci), `makeKey(body)`, `buildUrl(key)`, `imageHeaders()`, `fetchMeta(key, { fetchText })` -> `{ title, numPages, ext, pageExts, langStr, authorStr, extraMeta, pageUrls(n) }` dengan `pageUrls(n)` mengembalikan kandidat `[{ ext, url }]` per halaman. Galeri berprefix diunduh engine lewat provider (halaman per halaman, tanpa filter: semua halaman yang diumumkan diunduh); site A tetap lewat jalur API/CDN lama. `transport: 'curl'` (site C) membuat engine memakai `curlFetchText`/`curlDownloadToFile` di `core/providers/http.js`: CDN site C menyajikan halaman tantangan ke stack HTTP Node tetapi tidak ke `curl` sistem (site A memakai `curl` karena alasan yang sama). Kontrak error sama dengan helper Node (HTTP non-200 -> `err.statusCode`; kegagalan jaringan/timeout -> Error tanpa `statusCode`), jadi fallback 404 per kandidat tetap berlaku. Hanya `curl` biasa: argumen array tanpa shell, DNS normal, tanpa impersonasi atau penyelesaian tantangan.
- **Parsing input**: `core/db/listParser.js` memanggil `resolveInput()`; baris yang tidak dikenali dilewati dan dihitung di `ignored`.
- **Migrasi skema v3**: kolom `gallery_id` berubah dari `INTEGER`/`BIGINT` ke `TEXT` di kedua adapter; baris lama dikonversi ke teks angka tanpa kehilangan data. Export/import tetap membawa `gallery_id` publik (angka untuk site A).
- **Tipe konten (comic/manga/other)**: provider B1/B2/C mengambil slug kategori situs (`extraMeta`/`meta.category`; kategori yang tidak ditemukan dicatat di `categoryError`, hanya peringatan log `[CATEGORY]` tanpa menggagalkan unduhan) dan `core/providers/contentType.js` memetakannya: `western`, `porn-comic`, `comic` -> `comic`; `manga`, `doujinshi` -> `manga`; slug lain yang valid -> `other`; tidak ada/tidak valid -> `null`. Nama folder tipe hanya dari tabel tetap (`Comic`/`Manga`/`Other`), tidak pernah dari teks remote. Layout folder sumber berprefix: `<base>/<Tipe>/<Bahasa>/<Author>/<Judul>`; site A tidak berubah (`<base>/<Bahasa>/<Author>/<Judul>`). Tipe disimpan di `queue.category` (kolom `TEXT` nullable; berisi tipe, bukan slug mentah) dan `library.meta.contentType`; keduanya ikut export/import. `findExistingOnDisk` (fallback 429 yang berjalan sebelum metadata ada, jadi tanpa input tipe) memindai folder dasar dan semua folder tipe (`Comic`/`Manga`/`Other`) yang ada. Salinan lengkap galeri provider yang tersimpan di layout LAMA tanpa baris library diunduh ulang ke layout bertipe (baris library yang cocok berdasarkan id tetap menghentikan unduhan). UI menampilkan badge tipe dan filter **Type** di antrian dan library (filter yang tipenya sudah tidak ada diabaikan).
- **Migrasi skema v4**: menambah kolom `queue.category TEXT` di kedua adapter; baris lama bernilai `NULL`; export/import membawa `category`.
- **Nama folder**: bila judul kosong, nama folder diturunkan dari kunci lewat `safeKeyName()` (`core/engine.js`) agar tanda `:` tidak pernah muncul di path (tidak valid di Windows).

---

## 3. Core Engine (`core/engine.js` — `DownloaderEngine`)

Turunan `EventEmitter`. Mengelola antrian, anti-rate-limit, dan pengunduhan.

### Properti Utama
- `baseDownloadDir`: Folder output (site A: `<base>/<Language>/<Author>/<Title>`; sumber berprefix: `<base>/<Tipe>/<Language>/<Author>/<Title>`). Diisi dari opsi konstruktor, `DOWNLOAD_DIR`, atau `<repo>/Download`.
- `downloadFormat`: `'cbz'` (default) | `'zip'` | `'folder'`.
- `autoContinueBatches`: `boolean` (default `true`).
- `batchSize`: `50` galeri sebelum istirahat batch (`batchRestMinutes`: `5` menit).
- `concurrency`: `3` halaman paralel per galeri.
- `isRunning`, `isPaused`, `isStopped`, `forceRetry`: Flags kontrol eksekusi.
- `currentProgress`: Snapshot progress aktif (dibaca `/api/status` dan dipush lewat SSE `progress`).
- `downloadDirUnavailable` + `statusReason`: pengaman folder download. Bila folder hilang/tidak ter-mount (`isDownloadDirHealthy` gagal), `getStatus()` mengembalikan teks alasan (mis. `Download folder unavailable`) alih-alih `IDLE`/`RUNNING`, run dibatalkan, dan timer pengecekan (`healthCheckIntervalMs`, default 60 detik) menjalankan `checkDownloadDirRecovery()` sampai folder sehat lagi. Folder dianggap tidak sehat bila tidak ada, bukan direktori, kosong padahal `library` punya entri aktif, atau >50% dari ≥10 entri library hilang dari disk. Pemulihan manual: perbaiki mount/`DOWNLOAD_DIR`, lalu jalankan **Library → Rescan** (`POST /api/library/rescan`); rescan yang sukses menghapus flag. Mulai ulang server juga menjalankan rescan startup.
- `getStatus()`: `'IDLE'` | `'RUNNING'` | `'PAUSED'` | `'COOLDOWN'` (jeda anti-ban/istirahat batch) | `'COOLDOWN_429'` (rate limit) | teks `statusReason` saat folder tidak tersedia.
- `consecutiveRateLimits`, `circuitBreakerTripped`: State proteksi 429. Cooldown 5m -> 10m -> 20m (dobel tiap hit, maks 60 menit); hit ke-4 berturut-turut men-trip circuit breaker dan engine otomatis `pause()`. Berlaku sama untuk 429/503 dari sumber non-default.

### Event yang Di-emit oleh `DownloaderEngine`
| Event | Payload | Keterangan |
|---|---|---|
| `'batch_start'` | `{ total, pending, skipped }` | Saat `runBatch()` dimulai |
| `'progress'` | `currentProgress` (`{ galleryId, title, percent, completed, total, taskNum, totalTasks, activePages, speedKBps, stalled, stalledSeconds, live: true }`) | Heartbeat tiap 1 detik atau saat halaman selesai |
| `'cooldown'` | `currentProgress` (`{ type: 'COOLDOWN' \| 'BATCH_REST' \| 'RATE_LIMIT', title, message, percent, remaining, total, taskNum, totalTasks }`) | Detak tiap 1 detik selama masa tunggu |
| `'done'` | `{ galleryId, title, pages, currentTaskNum, totalTasks }` | Satu galeri selesai diunduh (via API, CDN, atau provider) |
| `'skipped'` | `{ galleryId, title, currentTaskNum, totalTasks, reason }` | Galeri dilewati (ada di library / disk / 404) |
| `'gallery_stopped'` | `{ galleryId, pagesDone, pagesTotal, deleted }` | Galeri `ON_PROGRESS` dihentikan di batas halaman (pause/delete per item) |
| `'error'` | `{ galleryId, error, currentTaskNum, totalTasks }` | Galeri gagal (`server/index.js` memasang listener agar tidak crash) |
| `'rate_limit'` | `{ galleryId, waitSeconds, consecutiveRateLimits }` | Saat terkena HTTP 429 |
| `'circuit_breaker'` | `{ galleryId, consecutiveRateLimits }` | Setelah 3 cooldown berturut-turut, hit ke-4 men-trip (engine otomatis `pause()`) |
| `'batch_complete'` | `{ processed }` | Saat `runBatch()` selesai |
| `'download_dir_unavailable'` | `{ reason, downloadDir }` | Folder download tidak sehat |
| `'paused'` / `'resumed'` / `'stopped'` / `'restarted'` / `'retry_triggered'` / `'config_updated'` | Objek opsional | Perubahan state engine |

`server/index.js` meneruskan ke SSE `engine`: `paused`, `resumed`, `stopped`, `restarted`, `batch_start`, `batch_complete`, `circuit_breaker`, `config_updated`, `download_dir_unavailable`, ditambah `progress` dan `cooldown` ke SSE `progress`.

### Alur `processGallery(galleryId)` — jalur site A; galeri berprefix memakai jalur provider (lihat 2a)
1. Set status `ON_PROGRESS` di tabel `queue`.
2. Cek tabel `library`: jika valid di disk (`verifyImage` >= 2KB untuk tiap halaman atau file `.cbz`/`.zip` ada), langsung return `SKIPPED - Already in Library` (0 request jaringan).
3. Panggil `fetchMetadata(galleryId)`:
   - **API-first** (`core/nhentaiApi.js` -> `GET /api/v2/galleries/<id>` via `curl --resolve certain.site:443:104.26.4.188`). Menggunakan `title.pretty` untuk nama file.
   - **Fallback HTML scrape** (`fetchMetadataViaHtml`) jika API gagal.
   - Jika `RATE_LIMIT` (429; untuk provider non-default, status 429/503 dari `fetchMeta` dipetakan ke `RATE_LIMIT` oleh `fetchProviderMetadata`), cek dulu cache judul + `findExistingOnDisk()` untuk menghindari cooldown 5 menit jika file sebenarnya sudah ada di disk.
4. Cek apakah sudah ada archive/folder di `parentDir` (`<base>/<Lang>/<Author>/`).
5. **Fast-path API Archive Download** (`tryApiArchiveDownload`): jika `NHENTAI_API_KEY` diset dan format target `cbz`/`zip`, minta presigned download URL dari API v2. Jika gagal, fallback ke per-page CDN.
6. **Per-page CDN Download**:
   - Unduh paralel (`concurrency = 3`) dari `i1..i4.certain.site` (dipin ke IP `104.26.4.188`).
   - Jika sebuah halaman gagal verifikasi (`< 2KB`) sebanyak 5x berturut-turut dan ukurannya `< 1536` byte (placeholder blokir CDN), substitusi dengan PNG putih valid menggunakan `writeBlankPlaceholderImage()` dan catat ke tabel `events`.
   - Setelah semua halaman selesai, simpan ke tabel `library`, tulis `.nhdl-id`, dan panggil `maybeCompress()` jika format batch adalah `cbz`/`zip`.

Galeri berprefix: `fetchProviderMetadata` memilih transport (`node` atau `curl`) sesuai provider, `downloadProviderPage` mencoba kandidat URL per halaman (404 di satu kandidat lanjut ke berikutnya), lalu jalur simpan/library/marker sama seperti di atas dengan folder bertipe (lihat 2a).

---

## 4. Kontrak REST API & SSE (`server/index.js` & `docs/API.md`)

Port default: `8080`. Spesifikasi lengkap request/response dan payload SSE ada di [`docs/API.md`](API.md); tabel di bawah hanya peta ringkas.

| Method | Endpoint | Fungsi |
|---|---|---|
| `GET` | `/api/events` | Stream SSE: `snapshot` awal, lalu delta `item` (`dbEvents`), `progress`, `engine`, dan `reloaded` setelah import/restore |
| `POST` | `/api/login`, `/api/logout` | Sesi (cookie `nhdl_session`, HttpOnly, 30 hari) bila `NHDL_PASSWORD` diset |
| `GET` | `/api/status` | Endpoint kompatibilitas: `{ items, batchCount, rawList, errors, liveProgress, engineStatus, autoContinueBatches }` |
| `POST` | `/api/queue`, `/api/queue/import` | Impor teks list; `/api/queue` mengganti seluruh antrian, `/import` menambah. Mengembalikan `added`, `updated`, `duplicates`, `ignored`, `galleryIds`, `total` |
| `GET` | `/api/queue/export` | Ekspor antrian sebagai `list.txt` |
| `POST` | `/api/queue/pause`, `/resume`, `/delete`, `/priority` | Kontrol per item (`ids`), prioritas `top`/`up`/`down`/`bottom` |
| `POST` | `/api/control` | `{ action: 'pause' \| 'stop' \| 'resume' \| 'start' \| 'restart' }` (`stop` = `pause`, `start` = `resume`) |
| `POST` | `/api/retry` | `{ galleryId? }`: lewati cooldown; dengan `galleryId`, kembalikan item itu ke `PENDING` |
| `GET` / `POST` | `/api/config`, `/api/config/verify-key` | Pengaturan (`downloadDir`, `downloadFormat`, `autoContinueBatches`, `apiKey`, jadwal backup) dan daftar `sources` |
| `GET` | `/api/library` | Entri library (`source`, `category`, dst.) |
| `POST` | `/api/library/rescan`, `/rename`, `/compress`, `/batch-compress` | Rescan marker, rename, kompresi satu/banyak galeri (job latar belakang) |
| `GET` | `/api/library/compress-status` | `{ job }` progres batch compress |
| `GET` | `/api/logs`, `/api/logs/download` | Log aktivitas (`?galleryId=&limit=` untuk satu galeri) dan unduhan `.log` |
| `GET` | `/api/fs/browse?path=...` | Penjelajah direktori untuk pemilih folder |
| `GET` / `POST` / `DELETE` | `/api/db/info`, `/export`, `/import`, `/backup`, `/backups`, `/restore`, `/backups/:name` | Manajemen database (info, export/import JSON, backup, restore) |

---

## 5. Peta Frontend (`webui/src`)

Svelte 5 (runes: `$state`, `$derived`, `$props`, `$effect`; tanpa `$:`/`export let`). Seluruh HTTP lewat `lib/api.js`; seluruh state lewat `lib/stores/app.svelte.js` (`appStore`).

- **`App.svelte`** (90 baris): merakit `Toolbar`, `SidebarFilter`, `VirtualQueueTable`, `DetailPanel`, `StatusBar`, dialog (`AddDialog`, `DeleteConfirmDialog`), dan modal (`FolderPickerModal` = Settings, `LibraryModal`, `LogsModal`), serta `Toast`. Saat mount memanggil `appStore.loadConfig()` dan `appStore.connectSSE()`.
- **Store** (`app.svelte.js`): `SvelteMap` item per `galleryId` (kunci string), klien `EventSource('/api/events')` dengan reconnect berbackoff dan fallback polling 3 detik (`sseStatus: 'polling'`), `applySnapshot`/`applyItemEvent`/`applyProgressEvent`/`applyEngineEvent`, filter status/tipe/sumber/batch, sort, seleksi (klik/Ctrl/Shift/Ctrl+A), dan turunan `nextPendingId` + `cooldown` dari `queueView.js`. `appStore.sources` berasal dari `GET /api/config` -> `sources`.
- **Toolbar**: Add (paste/upload `list.txt`), Resume, Pause, Delete, prioritas, Skip Cooldown & Force Retry, Start/Pause dan Restart engine, Library, Settings, Logs, Logout (bila login aktif).
- **SidebarFilter**: filter status (All, Downloading, **Queue** = `PENDING` + `ON_PROGRESS`, Completed, Stopped, Failed), bagian **Source** (muncul bila ada ≥1 sumber), bagian **Type** (hanya tipe yang ada; filter yang tipenya sudah tidak ada diabaikan), dan daftar Batch.
- **VirtualQueueTable**: virtualisasi sendiri (baris `32px`, overscan `±10`), kolom `#`, Judul, ID, Status, Progress, Halaman, Speed, ETA, Batch, Format, **Ditambahkan** (`createdAt`); sortable, resizable (lebar di `localStorage`), badge sumber dan badge tipe di baris, penanda aksen biru untuk `ON_PROGRESS`, chip hitung mundur cooldown di sel Status, context menu klik kanan. Mode `< 768px`: 3 kolom.
- **DetailPanel**: tab General / Pages / Log (`/api/logs?galleryId=`). **StatusBar**: status engine (termasuk peringatan folder tidak tersedia), counter, speed, status SSE.
- **LibraryModal**: daftar library dengan filter sumber/tipe, rescan, rename inline, kompresi satu/banyak galeri (polling `compress-status`).
- **FolderPickerModal** (Settings): tab General (folder unduhan, format, auto-continue batch, API key) dan tab Database (info, export/import, backup, restore, jadwal backup).
- **Helper murni** di `lib/` (diuji di `test/webui*.test.js`): `sources.js`, `queueView.js`, `contentType.js`.
- **Komponen sisa yang tidak diimpor `App.svelte`**: `Header`, `HudPanel`, `QueuePanel`, `BatchGroup`, `QueueItem`, `RightSidebar`, `DeleteBatchModal` (tidak dirujuk dari tree aktif).

---

## 6. Prinsip Arsitektur & Riwayat Rework (`docs/PLAN.md`)

1. **Semua state di DB** (`queue`, `library`, `settings`, `events`, `schema_version`); `.env` tetap di file untuk secret; `list.txt` hanya import/export.
2. **Perubahan mengalir DB -> SSE**: setiap mutasi baris `queue` meng-emit `dbEvents`, `/api/events` meneruskannya sebagai delta ke UI. Tidak ada polling (kecuali fallback saat SSE tidak tersedia).
3. **Dua adapter database**: `core/db.js` memilih `core/db/postgres.js` bila `DATABASE_URL` terisi (driver `pg` adalah satu-satunya dependensi runtime backend; pengecualian aturan zero-dependency), atau `core/db/sqlite.js` (default). Skema dan migrasi kompatibel; `gallery_id` bertipe `TEXT` di keduanya sejak v3, `created_at`/`updated_at` memakai `TIMESTAMPTZ`/`now()` di PostgreSQL, pool maks 10 koneksi dengan retry startup 60 detik. Hak akses minimal dicatat di `docs/POSTGRES.md`.
4. **Multi-source lewat provider** (`core/providers/`): sumber baru = satu provider terdaftar di registry; engine tidak perlu tahu detail situs.
5. **Rework Fase 0–8** (CLI dihapus, SQLite, SSE, Svelte 5 + virtual table, PostgreSQL + backup/export/import, panduan AI agent) selesai; Fase 6 (backend Go) dibatalkan. Detail dan log ada di `docs/PLAN.md`.
