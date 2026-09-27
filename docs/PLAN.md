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
- [ ] `core/engine.js`: ambil item berikutnya dari `queue` (status `PENDING`, urut `priority DESC, id`), update status/progress per baris; hapus `progress.json`
- [ ] Config: `config.json` → `settings`
- [x] Logger: `activity.log`/`error.log` → `events` (batasi, mis. simpan 10k baris terakhir)
- [ ] `server/index.js`: endpoint pakai query DB; tambah import `list.txt` (upload/paste) dan export
- [x] Rescan folder download untuk mengisi `library`
- [ ] Hapus kode dan file lama: `list_status.txt`, `progress.json`, `library.json`, `config.json`, log `.txt`; tambah `data/` ke `.gitignore` dan volume di `docker-compose.yml`
- [ ] Saat startup, item berstatus `ON_PROGRESS` dikembalikan ke `PENDING` (server mati di tengah download tidak boleh meninggalkan item stuck)
- [x] Test dengan `node:test` bawaan (`npm test`, tanpa dependency) di `test/`: `core/db.js` (migrasi skema, UNIQUE gallery_id), alur `PENDING → ON_PROGRESS → DONE/ERROR`, reset saat startup, import/export `list.txt`. Pakai DB sementara, jangan `data/nhdl.db`
- [ ] Uji manual: tambah 1000 link, download beberapa, restart server di tengah download → status tetap konsisten

## Fase 2 — Backend: push delta, bukan polling
- [ ] Tulis `docs/API.md` dulu: semua endpoint REST (method, path, body, response) dan format event SSE. Frontend (Fase 3–4) dan backend Go (Fase 6) wajib mengikuti kontrak ini
- [ ] Setiap perubahan baris `queue` di-emit sebagai event dari `core/db.js`
- [ ] Endpoint SSE `/api/events`: snapshot awal + event delta (`item`, `progress`, `engine`)
- [ ] `/api/status` tetap ada untuk kompatibilitas sampai frontend pindah
- [ ] Test untuk endpoint SSE: snapshot awal + event delta setelah `UPDATE` di `queue`

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

## Log
| Tanggal | Fase | Catatan |
|---|---|---|
| 2026-09-27 | 0 | CLI dihapus, README/package.json/start.bat disesuaikan, plan dibuat |
| 2026-09-27 | 1 | Diputuskan: semua data pindah ke SQLite (`node:sqlite`); skema ditambahkan, fase lain bergeser +1 |
| 2026-09-27 | 0 | `docs/ARCHITECTURE.md` dibuat & ditautkan di `AGENTS.md` sebagai referensi lengkap codebase lintas sesi |
| 2026-09-27 | 0 | Fase 0 selesai: fix `utils.js`, hapus Counter, `start.bat` auto-build, branch `rework`. Plan: tambah test, reset startup, `docs/API.md`, pola fitur |
