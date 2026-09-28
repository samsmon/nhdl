# Changelog

Catatan semua aktivitas di proyek ini, baik perubahan manual maupun oleh AI agent.
Entri terbaru di atas.

Format: `YYYY-MM-DD · Aktor · Fase` lalu daftar perubahan.
Aktor: `Manual (<nama>)` atau `AI (<agent/model>)`.

---

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 4
- **B1 & B2 (Toolbar, Add Dialog, Delete Confirm & Sidebar Filter)**: definisikan tema gelap berbasis CSS variables di `webui/src/app.css`, tambahkan fungsi API `pauseQueueItems`, `resumeQueueItems`, `deleteQueueItems`, `setQueuePriority`, dan `fetchGalleryLogs` di `webui/src/lib/api.js`, perluas store `webui/src/lib/stores/app.svelte.js` dengan counter filter real-time satu pass (`All`, `Downloading`, `Queued`, `Completed`, `Stopped`, `Failed`, dan daftar `Batch`), peringkat prioritas `#`, sort, dan multi-select, serta buat komponen `Toolbar.svelte`, `AddDialog.svelte`, `DeleteConfirmDialog.svelte`, dan `SidebarFilter.svelte`.
- **A (Backend — Kontrol Item Antrian & Log per Galeri)**: dokumentasikan di `docs/API.md` dan implementasikan status `STOPPED` (tidak disentuh oleh `requeueFailedItems()` maupun pre-pass `_runBatchBody`), penghentian aman item `ON_PROGRESS` di batas halaman berikutnya tanpa menghapus file yang sudah terunduh (`stopGallery` di `core/engine.js`), endpoint `POST /api/queue/pause`, `POST /api/queue/resume`, `POST /api/queue/delete` (hanya menghapus baris `queue`, file disk dan tabel `library` tetap utuh), `POST /api/queue/priority` (`top`/`up`/`down`/`bottom`), serta `GET /api/logs?galleryId=<id>&limit=<n>` (mengembalikan JSON array `[{ ts, level, message }]` dari tabel `events`). Perbarui keputusan desain di `docs/PLAN.md` (virtual table di sisi client tanpa paging dari server) dan tambahkan 4 test baru di `test/db.test.js` serta `test/sse.test.js` (24/24 test lulus).

## 2026-09-28 · AI (Claude Code, Opus 5.5) · Rilis
- Merge `rework` ke `main` (fast-forward): Fase 1 (SQLite), Fase 2 (SSE + pengaman folder download), dan Fase 3 (fondasi frontend Svelte 5) kini ada di `main`.
- Sebelum merge sudah direview: 20/20 test lulus, uji UI 1000 item di browser (SSE real-time di dua tab, tanpa polling), dan skenario disk terlambat ter-mount pulih otomatis tanpa kehilangan data.

## 2026-09-28 · Manual (Maja) · Rilis
- Menguji `rework` di laptop, lalu menyetujui merge ke `main`.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 2 (A1 Regression Fix)
- **Perbaikan bug auto-recovery `downloadDirUnavailable` (`core/engine.js`)**: pisahkan flag boolean `this.downloadDirUnavailable` dari teks `this.statusReason` sehingga watcher pemulihan tetap berjalan saat `markDownloadDirUnavailable(reason)` dipanggil dengan alasan spesifik dari `rescanLibrary()` (mis. `"Download folder is empty while library has entries"` atau `"More than 50% of library entries missing"`). Saat folder terdeteksi sehat, `checkDownloadDirRecovery()` menjalankan ulang `rescanLibrary(this.baseDownloadDir)` terlebih dahulu dan hanya menghapus flag/status serta menjalankan `requeueFailedItems()` + `runBatch()` apabila rescan tidak `aborted` (total 20/20 test lulus).
- **Perbaikan regresi A1 (`DOWNLOAD_DIR` baru & auto-recovery 60 detik)**: bila tabel `library` belum memiliki entri aktif (selain `skipped`), buat folder download otomatis (`fs.mkdirSync(..., { recursive: true })`) di constructor `DownloaderEngine`, `_runBatchBody` (`core/engine.js`), maupun `rescanLibrary` (`core/tracker.js`) sehingga instalasi baru dengan `DOWNLOAD_DIR` kustom langsung berjalan. Bila `library` sudah memiliki entri aktif dan folder belum ter-mount/tidak sehat, folder tetap tidak dibuat (`Download folder unavailable`) dan timer pengecekan otomatis setiap 60 detik (`healthCheckIntervalMs`) akan memulihkan status, mencatat event di tabel `events`, serta menjalankan antrian kembali (`runBatch`) begitu disk ter-mount.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 3
- **B3 (Optimasi render daftar antrian & Verifikasi 1.000 item + 2-tab SSE)**: hapus `animate:flip` pada daftar item/batch antrian (hanya dipertahankan di `hud.activePages` maks 3 item), hitung `filteredItems` satu kali per batch via `$derived`, lewati pembuatan DOM node pada batch yang sedang `collapsed`, tambahkan `content-visibility: auto; contain-intrinsic-size: auto none auto 36px;` pada baris item antrian, dan debounce regenerasi `rawList` (80ms) saat menerima burst event SSE `item`. Tambahkan test benchmark & verifikasi 2-tab SSE di `test/sse.test.js` (`1000 items import=86.6ms`, `2-tab snapshot=10.7ms`, `2-tab delta sync=19.9ms`, ukuran event update `250B` vs `245.034B` pada polling `/api/status` di `main` — pengurangan 99,9% payload per update, total 18/18 test lulus, `npm run build:ui` tanpa warning).
- **B2 (Pecah `App.svelte` ke komponen Svelte 5 runes)**: pecah `webui/src/App.svelte` (dari 1.767 baris menjadi 94 baris) ke dalam 10 komponen modular di `webui/src/lib/components/` (`Header.svelte`, `HudPanel.svelte`, `QueuePanel.svelte`, `BatchGroup.svelte`, `QueueItem.svelte`, `RightSidebar.svelte`, `FolderPickerModal.svelte`, `DeleteBatchModal.svelte`, `LibraryModal.svelte`, `LogsModal.svelte`) yang seluruhnya memakai Svelte 5 runes (`$state`, `$derived`, `$props`, `$effect`) dan `webui/src/lib/api.js` tanpa pemanggilan `fetch()` langsung.
- **B1 (`webui/src/lib/api.js` & `webui/src/lib/stores/app.svelte.js`)**: buat HTTP client terpusat `webui/src/lib/api.js` untuk seluruh endpoint di `docs/API.md` dan reactive store `webui/src/lib/stores/app.svelte.js` berbasis Svelte 5 runes (`$state`, `$derived`, `SvelteMap` per `galleryId`) serta klien SSE `EventSource('/api/events')` dengan exponential reconnect backoff (1s, 2s, 5s, maks 10s), status koneksi, dan fallback polling `/api/status` 3 detik.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 2 (Review Fixes A1–A3)
- **A3 (Unit test pre-pass `_runBatchBody`)**: tambahkan test integrasi `_runBatchBody` (dengan `skipStartupJitter: true`, DB sementara, dan stub `processGallery`) di `test/db.test.js` yang memverifikasi item `DONE` tanpa file di disk kembali ke `PENDING`, item `DONE` dengan file valid tetap `DONE`, serta item `ERROR` dengan `retries < 5` diproses ulang (total 17/17 test lulus).
- **A2 (Isolasi `config.json` pada test)**: tambahkan dukungan opsi `{ legacyConfigPath }` pada `initDb(dbPath, options)` dan variabel environment `NHDL_LEGACY_CONFIG` di `core/db.js` agar database sementara pada `test/` tidak membaca `config.json` milik mesin developer.
- **A1 (`isDownloadDirHealthy` & proteksi unmounted drive)**: tambahkan `isDownloadDirHealthy(dir)` di `core/tracker.js` untuk memastikan folder download ada, dapat dibaca, tidak kosong saat `library` memiliki entri, serta membatalkan `rescanLibrary()` (`aborted: true`) bila >50% dari minimal 10 entri `library` hilang di disk. Lewati pre-pass `DONE→PENDING` di `_runBatchBody` (`core/engine.js`) dan hentikan run dengan status `'Download folder unavailable'` + event SSE `download_dir_unavailable` bila folder tidak sehat.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 1 (Review Fixes)
- **BUG 1 (`requeueFailedItems`)**: tambahkan `requeueFailedItems({ maxRetries = 5 })` di `core/db.js` untuk mengembalikan baris `ERROR`, `COOLDOWN`, dan `PAUSED` dengan `retries < maxRetries` ke `PENDING` (`error = NULL`), dipanggil di awal `_runBatchBody` (`core/engine.js`), `/api/retry` global, dan aksi `resume`/`start`/`restart` di `/api/control` (`server/index.js`). Per-item `/api/retry` kini juga mereset `retries = 0`.
- **BUG 2 (`importListText` & `_runBatchBody` stale `DONE`)**: kembalikan baris `DONE` atau `SKIPPED` (selain skip permanen `entry.skipped`) ke `PENDING` (`pages_done = 0, error = NULL`) serta hapus entri `library` basi (`deleteLibraryEntry`) apabila file di disk sudah dihapus saat `importListText` maupun pre-pass `_runBatchBody`.
- **BUG 3 (`migrateLegacyConfigJson`)**: tambahkan migrasi satu kali saat `initDb()` di `core/db.js` yang menyalin `downloadDir`, `downloadFormat`, dan `autoContinueBatches` dari `config.json` lama ke tabel `settings` bila tabel `settings` masih kosong (tanpa menghapus/mengubah `config.json`), serta mencatat `"Migrated settings from config.json"` di tabel `events`.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 2
- `server/index.js` & `test/sse.test.js`: implementasikan endpoint SSE `GET /api/events` (`snapshot` awal + delta real-time `item`, `progress`, `engine` serta heartbeat `: ping`), pertahankan `GET /api/status` untuk kompatibilitas, dan tambahkan unit test SSE (`test/sse.test.js`, total 12/12 test lulus).
- `core/db.js`: tambahkan helper `formatQueueRow()` dan pastikan seluruh mutasi tabel `queue` (`enqueueGallery`, `updateQueueItem`, `deleteQueueItem`, `deleteQueueBatch`, `clearCompletedQueue`, `resetStuckQueueItems`, `importListText`) meng-emit event delta terstruktur pada `dbEvents`.
- Buat `docs/API.md` berisi spesifikasi lengkap seluruh endpoint REST API (`/api/login`, `/api/logout`, `/api/status`, `/api/queue`, `/api/queue/import`, `/api/queue/export`, `/api/control`, `/api/retry`, `/api/config`, `/api/config/verify-key`, `/api/library/*`, `/api/logs/*`, `/api/fs/browse`) serta format stream SSE `GET /api/events` (`snapshot`, `item`, `progress`, `engine`).

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Plan (Fase 8)
- `docs/PLAN.md`: tambah Fase 8 "README khusus AI agent" (`docs/AI_AGENT.md` berisi deploy/manage/modify/maintain, blok pemicu di `README.md`, tautan dari `AGENTS.md`).

## 2026-09-27 · Manual (Maja) · Plan (Fase 8)
- Meminta README khusus AI agent untuk deploy, manage, modify, dan maintain, dengan pemicu "if you're an AI agent" di README utama.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Plan
- `docs/PLAN.md`: tambah Fase 7 "PostgreSQL terpusat + backup/export/import" (pilih DB lewat `DATABASE_URL`, adapter SQLite/Postgres, API `core/db.js` jadi async, endpoint + menu Settings → Database, test lintas DB).

## 2026-09-27 · Manual (Maja) · Plan
- Meminta integrasi PostgreSQL terpusat (shared Postgres di server) supaya data tidak hilang saat rebuild, plus fitur backup dan export/import database di menu Settings.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 1
- Bersihkan file state lama (`list_status.txt`, `progress.json`, `library.json`, `config.json`, `activity.log`, `error.log`), tambahkan `data/` ke `.gitignore`, dan mount volume `/app/data` di `docker-compose.yml` serta `Dockerfile`.
- Tambah test integrasi 1.000 link + simulasi restart server di tengah download (`ON_PROGRESS → PENDING`, `DONE`/`ERROR` tetap konsisten) di `test/db.test.js` (total 10/10 test lulus).
- `server/index.js`: pindahkan seluruh endpoint (`/api/status`, `/api/queue`, `/api/library`, `/api/retry`, `/api/control`) ke query SQLite (`core/db.js`), tambahkan endpoint `POST /api/queue/import` dan `GET /api/queue/export` untuk import/export `list.txt`, serta jalankan `resetStuckQueueItems()` (`ON_PROGRESS → PENDING`) saat startup.
- `core/engine.js` & `scripts/find-bad-archives.js`: pindahkan penyimpanan konfigurasi (`downloadDir`, `downloadFormat`, `autoContinueBatches`) dari `config.json` ke tabel SQLite `settings`. Ubah `runBatch()`/`processGallery()` agar mengambil item antrian berikutnya dari tabel `queue` (`getNextPendingItem()`, urut `priority DESC, id ASC`) dan memperbarui status serta `pages_done`/`pages_total` per baris langsung di SQLite.
- `core/tracker.js`: ganti baca/tulis `list_status.txt` dan `library.json` dengan tabel SQLite `queue` dan `library` (`core/db.js`). Perbarui `rescanLibrary()` agar dapat mengisi ulang tabel `library` secara otomatis dari file marker `.nhdl-id` dan `.cbz.nhdl-id` di folder download.
- `core/logger.js`: ganti penyimpanan `activity.log` dan `error.log` ke tabel SQLite `events` (dengan batas retensi 10.000 baris terakhir dan ekstraksi otomatis `level` serta `gallery_id`).
- Tambah `core/db.js` menggunakan modul bawaan `node:sqlite` (`WAL` mode, migrasi berbasis `schema_version`, fungsi query `queue`, `library`, `settings`, `events`, `resetStuckQueueItems()`, serta `importListText`/`exportListText`).
- Tambah `test/db.test.js` (`node:test`) untuk menguji migrasi skema, constraint `UNIQUE(gallery_id)`, siklus status `PENDING → ON_PROGRESS → DONE/ERROR`, reset saat startup, dan import/export `list.txt` dengan DB sementara.
- `Dockerfile`: naikkan kedua stage (`builder` dan production) dari `node:20-alpine` ke `node:24-alpine` untuk dukungan bawaan `node:sqlite`.
- `package.json`: tambahkan `"engines": { "node": ">=22.13" }`.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Docs
- Sinkronisasi `docs/ARCHITECTURE.md` dan `AGENTS.md` dengan perubahan terbaru di branch `rework` (`scripts/find-bad-archives.js`, `test/nhentaiApi.test.js`, validasi `isZipFile` di `core/nhentaiApi.js`, serta aturan git/dokumentasi terbaru).

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Bugfix
- **Fix download via API menghasilkan file anomali (<100KB).** Penyebab: request ke host archive (`i1..i4`) dikirim tanpa User-Agent, sehingga Cloudflare membalas halaman challenge HTML (403, ±13KB), dan kode menyimpannya sebagai `.cbz` karena status HTTP dan isi file tidak dicek.
- `core/nhentaiApi.js` → `downloadArchiveFile`: kirim User-Agent browser, tolak response selain HTTP 200, dan validasi signature zip (`PK\x03\x04`). Kalau gagal, file dihapus dan engine fallback ke download per halaman.
- Tambah `test/nhentaiApi.test.js` (`node:test`) dan script `npm test`.
- Tambah `scripts/find-bad-archives.js` (`npm run check:archives`, mendukung `--delete`) untuk mendeteksi dan membersihkan `.cbz`/`.zip` korup (HTML challenge) di folder download beserta marker `.nhdl-id`-nya (2171deb).
- Diverifikasi ke API asli: sebelum fix 13KB HTML, sesudah fix CBZ asli 16MB dan 50MB.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Fase 0 (lanjutan)
- `core/utils.js`: karakter kontrol mentah di regex `sanitizeName` diganti escape (`\x00-\x1f`, `\uXXXX`); output diverifikasi identik. Git kini membaca file ini sebagai teks.
- Hapus `webui/src/lib/Counter.svelte`.
- `start.bat`: auto-build Web UI kalau `webui/dist` belum ada.
- `docs/PLAN.md`: tambah test `node:test`, reset `ON_PROGRESS` saat startup, `docs/API.md` sebelum Fase 2.
- `AGENTS.md`: aturan git (commit/push atas nama user, tanpa atribusi AI, kerja di branch `rework`) dan pola fitur DB → REST → SSE.
- Buat branch `rework`.

## 2026-09-27 · Manual (Maja) · —
- Menyetujui semua rekomendasi; menetapkan aturan bahwa commit dan push wajib atas nama user.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Docs
- Nama situs di semua dokumentasi diganti menjadi "certain site ( ͡° ͜ʖ ͡°)"; domain contoh menjadi `certain.site` (README, `docs/ARCHITECTURE.md`, `list.txt.example`, deskripsi `package.json`).
- Identifier kode (`nhentaiApi.js`, `NHENTAI_API_KEY`, domain di dalam kode) sengaja tidak diubah.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 0
- Pelajari seluruh codebase (`server/`, `core/`, `webui/`) dan buat `docs/ARCHITECTURE.md` berisi peta arsitektur lengkap, alur `DownloaderEngine`, kontrak REST API, format state/marker file, dan struktur `App.svelte` (1766 baris) agar sesi berikutnya tidak perlu membaca ulang source code.
- `AGENTS.md`: tambahkan rujukan ke `docs/ARCHITECTURE.md`.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Plan
- `docs/PLAN.md`: tambah Fase 1 "Pindah semua data ke SQLite" (keputusan, skema tabel `queue`/`library`/`settings`/`events`, pemetaan file lama, task). Fase SSE, frontend, layout, benchmark, dan Go bergeser menjadi Fase 2–6.

## 2026-09-27 · Manual (Maja) · Plan
- Memutuskan semua data (link, status, progress, library, config, log) disimpan di SQLite, bukan file teks. Data lama tidak dimigrasi.

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Fase 0
- Hapus CLI: `cli/index.js` dan router `nhentai-dl.js`.
- `package.json`: `main` dan `npm start` diarahkan ke `server/index.js`; bin `nhdl` dan script `cli` dihapus.
- `start.bat` menjalankan `node server/index.js`.
- README: bagian CLI dihapus.
- Tambah `docs/PLAN.md` (rencana rework + status) dan `docs/CHANGELOG.md` ini.
- Tambah `AGENTS.md` (aturan logging untuk semua agent), dengan `GEMINI.md` dan `CLAUDE.md` merujuk ke sana.
- Pembagian kerja: rework UI dan kode dikerjakan user lewat Antigravity (Gemini 3.8 Flash High).

## 2026-09-27 · Manual (Maja) · —
- `git pull`: update `core/engine.js`, `core/tracker.js`, `core/utils.js` (b88919e).
- Memutuskan arah rework: UI ala qBittorrent/IDM, Svelte + GSAP, CLI dihapus, migrasi bertahap.
