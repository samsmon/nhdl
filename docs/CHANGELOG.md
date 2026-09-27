# Changelog

Catatan semua aktivitas di proyek ini, baik perubahan manual maupun oleh AI agent.
Entri terbaru di atas.

Format: `YYYY-MM-DD · Aktor · Fase` lalu daftar perubahan.
Aktor: `Manual (<nama>)` atau `AI (<agent/model>)`.

---

## 2026-09-27 · AI (Claude Code, Opus 5.5) · Plan
- `docs/PLAN.md`: tambah Fase 7 "PostgreSQL terpusat + backup/export/import" (pilih DB lewat `DATABASE_URL`, adapter SQLite/Postgres, API `core/db.js` jadi async, endpoint + menu Settings → Database, test lintas DB).

## 2026-09-27 · Manual (Maja) · Plan
- Meminta integrasi PostgreSQL terpusat (shared Postgres di server) supaya data tidak hilang saat rebuild, plus fitur backup dan export/import database di menu Settings.

## 2026-09-27 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 1
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
