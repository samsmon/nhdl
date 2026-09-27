# NHDL Rework Plan

Tujuan: UI tetap mulus saat menangani 1000+ item antrian, dengan layout ala qBittorrent/IDM.
Backend Go hanya dikerjakan jika benchmark Fase 5 menunjukkan bottleneck di backend.

Status: `[ ]` belum · `[~]` dikerjakan · `[x]` selesai · `[-]` dibatalkan

## Diagnosis awal (2026-09-27)

Lag saat 1000 item terutama berasal dari frontend:
- Semua baris dirender sekaligus (tanpa virtualisasi).
- Poll `/api/status` tiap 1 detik memicu hitung ulang `activeBatchNum → batches → visibleBatches`
  untuk seluruh list, walaupun status item tidak berubah.
- `filterItems()` dipanggil dua kali per batch; `animate:flip` mengukur ulang semua baris.
- `App.svelte` monolitik (±1766 baris).

Backend: `/api/status` membaca dan mem-parse `list_status.txt` dari disk tiap request,
lalu mengirim seluruh list walaupun tidak ada perubahan.

## Fase 0 — Persiapan
- [x] Hapus CLI (`cli/`, `nhentai-dl.js`); entry point menjadi `server/index.js`
- [x] Buat dokumen plan ini + `docs/CHANGELOG.md` + `AGENTS.md` (aturan logging untuk semua agent)
- [x] `core/utils.js`: karakter kontrol mentah di regex `sanitizeName` diganti escape (git sebelumnya menganggap file ini binary)
- [x] Hapus `webui/src/lib/Counter.svelte` (sisa template Vite)
- [x] `start.bat`: build Web UI otomatis kalau `webui/dist` belum ada
- [x] Buat branch `rework` untuk Fase 1 dst.; `main` tetap stabil untuk dipakai

## Fase 1 — Pindah semua data ke SQLite
Tujuan: hapus state berbasis file teks/JSON (sumber bug fs write, duplikat, dan parse ulang tiap detik).

Keputusan:
- Pakai modul bawaan `node:sqlite` (tetap zero dependency). Jangan pakai `better-sqlite3` (native build, bermasalah di alpine).
- File DB: `data/nhdl.db`, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`.
- `.env` (API key) **tetap di file**, tidak masuk DB.
- `list.txt` hanya untuk import/export, bukan penyimpan state.
- Tidak ada migrasi data lama. Tabel `library` diisi ulang lewat rescan folder download (marker file, lihat `core/tracker.js`).

Skema awal:
```sql
CREATE TABLE queue (
  id           INTEGER PRIMARY KEY,
  gallery_id   INTEGER NOT NULL UNIQUE,
  url          TEXT    NOT NULL,
  title        TEXT,
  status       TEXT    NOT NULL DEFAULT 'PENDING', -- PENDING | ON_PROGRESS | DONE | ERROR | COOLDOWN | PAUSED | SKIPPED
  batch        INTEGER NOT NULL DEFAULT 1,
  priority     INTEGER NOT NULL DEFAULT 0,
  pages_done   INTEGER NOT NULL DEFAULT 0,
  pages_total  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  retries      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_queue_status ON queue(status);
CREATE INDEX idx_queue_batch  ON queue(batch);

CREATE TABLE library (
  gallery_id   INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  path         TEXT NOT NULL,
  pages        INTEGER,
  format       TEXT,                -- folder | cbz | zip
  language     TEXT,
  artist       TEXT,
  added_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- JSON-encoded
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  level       TEXT NOT NULL,       -- info | warn | error
  gallery_id  INTEGER,
  message     TEXT NOT NULL
);
CREATE INDEX idx_events_gallery ON events(gallery_id);

CREATE TABLE schema_version (version INTEGER NOT NULL);
```

Pemetaan file lama → tabel:
| File lama | Tabel |
|---|---|
| `list.txt`, `list_status.txt`, `progress.json` | `queue` |
| `library.json` | `library` |
| `config.json` | `settings` |
| `activity.log`, `error.log` | `events` |

Task:
- [x] Naikkan Docker base image ke `node:24-alpine` (Dockerfile, kedua stage) dan set `engines.node >= 22.13` di `package.json`
- [x] `core/db.js`: buka DB, jalankan migrasi skema (berbasis `schema_version`), ekspor fungsi query (bukan SQL mentah di mana-mana)
- [x] `core/tracker.js`: ganti baca/tulis `list_status.txt` dan `library.json` dengan tabel `queue` dan `library`
- [x] `core/engine.js`: ambil item berikutnya dari `queue` (status `PENDING`, urut `priority DESC, id`), update status/progress per baris; hapus `progress.json`
- [x] Config: `config.json` → `settings`
- [x] Logger: `activity.log`/`error.log` → `events` (batasi, mis. simpan 10k baris terakhir)
- [x] `server/index.js`: endpoint pakai query DB; tambah import `list.txt` (upload/paste) dan export
- [x] Rescan folder download untuk mengisi `library`
- [x] Hapus kode dan file lama: `list_status.txt`, `progress.json`, `library.json`, `config.json`, log `.txt`; tambah `data/` ke `.gitignore` dan volume di `docker-compose.yml`
- [x] Saat startup, item berstatus `ON_PROGRESS` dikembalikan ke `PENDING` (server mati di tengah download tidak boleh meninggalkan item stuck)
- [x] Test dengan `node:test` bawaan (`npm test`, tanpa dependency) di `test/`: `core/db.js` (migrasi skema, UNIQUE gallery_id), alur `PENDING → ON_PROGRESS → DONE/ERROR`, reset saat startup, import/export `list.txt`. Pakai DB sementara, jangan `data/nhdl.db`
- [x] Uji manual: tambah 1000 link, download beberapa, restart server di tengah download → status tetap konsisten
- [x] Perbaikan review Fase 1: (1) `requeueFailedItems()` untuk mencoba ulang item `ERROR`/`COOLDOWN`/`PAUSED` dengan `retries < maxRetries`; (2) kembalikan item `DONE`/`SKIPPED` ke `PENDING` + hapus entry `library` basi bila file sudah hilang di disk saat `importListText` atau `_runBatchBody`; (3) migrasi otomatis satu kali dari `config.json` lama ke tabel `settings` bila `settings` masih kosong

## Fase 2 — Backend: push delta, bukan polling
- [x] Tulis `docs/API.md` dulu: semua endpoint REST (method, path, body, response) dan format event SSE. Frontend (Fase 3–4) dan backend Go (Fase 6) wajib mengikuti kontrak ini
- [x] Setiap perubahan baris `queue` di-emit sebagai event dari `core/db.js`
- [x] Endpoint SSE `/api/events`: snapshot awal + event delta (`item`, `progress`, `engine`)
- [x] `/api/status` tetap ada untuk kompatibilitas sampai frontend pindah
- [x] Test untuk endpoint SSE: snapshot awal + event delta setelah `UPDATE` di `queue`
- [x] **A1 (Review)**: Pengaman folder download tidak ter-mount (`isDownloadDirHealthy(dir)`, batalkan `rescanLibrary()` bila folder tidak ada/kosong atau >50% dari ≥10 entri hilang, lewati pre-pass `DONE→PENDING` di `_runBatchBody`, set status `Download folder unavailable` + SSE event)
- [ ] **A2 (Review)**: Isolasi `initDb()` dari `config.json` asli saat test (`legacyConfigPath` / `NHDL_LEGACY_CONFIG`)
- [ ] **A3 (Review)**: Unit test pre-pass `_runBatchBody` (`DONE` tanpa file → `PENDING`, `DONE` valid tetap `DONE`, `ERROR` `retries < 5` diproses ulang)

## Fase 3 — Fondasi frontend
- [ ] Migrasi ke Svelte 5 (runes)
- [ ] Pecah `App.svelte` menjadi komponen + store
- [ ] Ganti polling dengan klien SSE

## Fase 4 — Layout qBittorrent/IDM
- [ ] Sidebar filter (All / Downloading / Completed / Failed / Paused)
- [ ] Virtual table (kolom: judul, ID, progress, halaman, speed, ETA, status; sortable), data di-page dari server
- [ ] Panel detail bertab (General / Pages / Log dari tabel `events`)
- [ ] Toolbar (Add, Pause, Resume, Delete, Prioritas) + status bar
- [ ] GSAP hanya untuk panel, dialog, dan toast

## Fase 5 — Benchmark
- [ ] Ukur FPS/CPU dengan 1000 dan 5000 item, sebelum vs sesudah
- [ ] Putuskan perlu Fase 6 atau tidak

## Fase 6 — (Opsional) Backend Go
- [ ] Go dengan skema SQLite dan kontrak API yang sama, UI di-embed via `embed.FS`

## Fase 7 — PostgreSQL terpusat + backup/export/import
Tujuan: di server, data disimpan di PostgreSQL terpusat (shared Postgres yang dipakai semua container), jadi rebuild container tidak menghapus data. SQLite tetap jadi default untuk pemakaian lokal.

Keputusan:
- Pilih database lewat env: `DATABASE_URL=postgres://user:pass@host:5432/nhdl` → PostgreSQL; kosong → SQLite `data/nhdl.db`.
- Driver `pg` (satu-satunya dependency runtime backend, pengecualian dari aturan zero-dependency).
- Pakai schema/database khusus `nhdl` di shared Postgres, jangan campur tabel dengan aplikasi lain. Dokumentasikan SQL untuk membuat user + database dengan hak minimal.
- `DATABASE_URL` berisi password → masuk `.env`/env container, bukan tabel `settings`, dan tidak pernah dikirim ke UI.
- Format export **tidak bergantung jenis DB** (JSON berisi semua tabel + `schema_version`), supaya data bisa dipindah SQLite ⇄ PostgreSQL lewat export/import.

Task:
- [ ] Ubah API `core/db.js` menjadi async (semua fungsi mengembalikan Promise) dan sesuaikan pemanggil di `core/` dan `server/`. SQLite tetap di belakangnya. **Ini langkah terbesar karena `node:sqlite` sinkron sedangkan `pg` async**
- [ ] Pisahkan adapter: `core/db/sqlite.js` dan `core/db/postgres.js` dengan antarmuka yang sama; `core/db.js` memilih berdasarkan `DATABASE_URL`
- [ ] Skema dan migrasi versi PostgreSQL: `datetime('now')` → `now()`/`timestamptz`, `INTEGER PRIMARY KEY` → `bigserial`/`identity`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, `PRAGMA table_info` → `information_schema`
- [ ] Koneksi: pool, retry saat Postgres belum siap waktu container start, pesan error yang jelas kalau `DATABASE_URL` salah
- [ ] Endpoint (catat dulu di `docs/API.md`): `GET /api/db/export` (download JSON), `POST /api/db/import` (upload JSON; mode *replace* atau *merge*, dalam satu transaksi), `POST /api/db/backup` + `GET /api/db/backups` (backup terjadwal/manual ke folder `data/backups/`, simpan N terakhir)
- [ ] UI menu Settings → Database: info jenis DB + status koneksi (tanpa password), tombol Export, Import (dengan konfirmasi dan pilihan replace/merge), Backup sekarang, daftar backup + restore
- [ ] `docker-compose.yml`: contoh `DATABASE_URL` ke shared Postgres (network eksternal), hapus kebutuhan volume `data/` untuk mode Postgres (kecuali folder backup)
- [ ] Test: suite `db` yang sama dijalankan ke SQLite dan PostgreSQL (Postgres lewat `TEST_DATABASE_URL`, di-skip kalau tidak ada); test export → import menghasilkan data identik; import ke DB jenis lain (SQLite → Postgres)
- [ ] Uji manual di server: rebuild container → antrian dan library tetap ada

## Fase 8 — README khusus AI agent
Tujuan: AI agent (milik user mana pun yang memakai repo ini) bisa deploy, mengelola, memodifikasi, dan merawat NHDL tanpa harus membaca seluruh source code.

Keputusan:
- File baru `docs/AI_AGENT.md`, ditulis untuk dibaca agent: ringkas, berupa langkah dan perintah yang bisa langsung dijalankan, tanpa narasi pemasaran.
- Pembagian dengan file yang sudah ada: `AGENTS.md` = aturan kerja saat **mengembangkan** repo ini (git, changelog, pola arsitektur); `docs/AI_AGENT.md` = panduan **mengoperasikan** aplikasi (deploy, kelola, maintain). `AGENTS.md` menautkan ke `docs/AI_AGENT.md`, bukan menduplikasi isinya.
- `README.md` utama diberi blok pemicu di bagian paling atas, mis.:
  > **If you are an AI agent:** read [docs/AI_AGENT.md](docs/AI_AGENT.md) before deploying, managing, modifying, or maintaining this project.

Task:
- [ ] **Deploy**: prasyarat (Node ≥ 22.13 / Docker), lokal (`start.bat`, `npm start`), Docker Compose, mode SQLite vs PostgreSQL (`DATABASE_URL`), daftar lengkap env var beserta default, port, dan cara verifikasi server sehat (endpoint + output yang diharapkan)
- [ ] **Manage**: cara menambah antrian (UI, API, import `list.txt`), pause/resume, membaca log (`events`), cek dan ganti API key, backup/export/import database, `npm run check:archives`
- [ ] **Modify**: peta modul singkat (tautan ke `docs/ARCHITECTURE.md` dan `docs/API.md`), pola fitur baru DB → REST → SSE, cara menambah migrasi skema, cara menjalankan test
- [ ] **Maintain**: upgrade versi (pull, rebuild, migrasi otomatis), troubleshooting berdasarkan gejala (Cloudflare challenge/403, DNS ISP diblokir, item stuck `ON_PROGRESS`, rate limit 429, DB tidak bisa connect), dan hal yang **tidak boleh** dilakukan agent (menghapus `data/`/volume DB, commit secret, mengubah identitas git)
- [ ] Blok pemicu di `README.md` + tautan dari `AGENTS.md`
- [ ] Validasi: minta agent baru (sesi bersih) mendeploy dan mengoperasikan NHDL hanya berbekal `README.md`; catat bagian yang membuatnya bingung lalu perbaiki dokumennya

## Log
| Tanggal | Fase | Catatan |
|---|---|---|
| 2026-09-27 | 0 | CLI dihapus, README/package.json/start.bat disesuaikan, plan dibuat |
| 2026-09-27 | 1 | Diputuskan: semua data pindah ke SQLite (`node:sqlite`); skema ditambahkan, fase lain bergeser +1 |
| 2026-09-27 | 0 | `docs/ARCHITECTURE.md` dibuat & ditautkan di `AGENTS.md` sebagai referensi lengkap codebase lintas sesi |
| 2026-09-27 | 0 | Fase 0 selesai: fix `utils.js`, hapus Counter, `start.bat` auto-build, branch `rework`. Plan: tambah test, reset startup, `docs/API.md`, pola fitur |
| 2026-09-27 | 7 | Tambah Fase 7: PostgreSQL terpusat (via `DATABASE_URL`) + backup/export/import di Settings |
| 2026-09-27 | 1 | Fase 1 selesai: migrasi penuh ke SQLite (`core/db.js`, `queue`, `library`, `settings`, `events`), rescan marker, startup reset `ON_PROGRESS`, dan 10/10 test lulus |
| 2026-09-27 | 8 | Tambah Fase 8: README khusus AI agent (`docs/AI_AGENT.md`) + pemicu di README utama |
| 2026-09-27 | 2 | Fase 2 selesai: kontrak `docs/API.md`, endpoint SSE `GET /api/events` (`snapshot` + delta `item`/`progress`/`engine`), dan test SSE lulus (12/12) |
| 2026-09-27 | 1 | Perbaikan 3 bug regresi review Fase 1 (`requeueFailedItems`, reset `DONE` tanpa file + hapus `library` basi, migrasi `config.json` ke `settings`) + 3 test baru lulus (15/15) |
