# Changelog

Catatan semua aktivitas di proyek ini, baik perubahan manual maupun oleh AI agent.
Entri terbaru di atas.

Format: `YYYY-MM-DD · Aktor · Fase` lalu daftar perubahan.
Aktor: `Manual (<nama>)` atau `AI (<agent/model>)`.

---

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Penyegaran dokumentasi
- Seluruh dokumentasi (`README.md` dan `docs/*.md`, kecuali `docs/superpowers/`) diaudit terhadap kode terkini dan diperbarui; tidak ada perubahan kode, test, atau konfigurasi.
- `README.md`: fitur multi-source (site B1/B2/C dalam satu antrian), folder bertipe (comic/manga/other), filter Status/Source/Type, chip hitung mundur cooldown, kolom "Ditambahkan", batch compress; format input (URL tanpa skema, kunci berprefix, `ignored`); tabel env var (`DOWNLOAD_DIR` hanya dibaca saat startup, `NHDL_LEGACY_CONFIG`); bagian Troubleshooting baru (folder unduhan tidak tersedia, error sertifikat = DNS ISP, 429); peta proyek menambah `core/providers/`.
- `docs/ARCHITECTURE.md`: struktur direktori dan jumlah baris diukur ulang (semua modul, 14 file test, komponen webui); bagian "File State" lama (`list.txt`/`library.json`/`config.json`) diganti penjelasan tabel DB skema v4 dan marker file; properti dan event engine dilengkapi (`gallery_stopped`, `download_dir_unavailable`, pengaman folder, nilai `getStatus()`, batas circuit breaker); tabel endpoint dilengkapi; peta frontend ditulis ulang untuk Svelte 5 + SSE (bukan `App.svelte` 1766 baris dengan polling); catatan rework diganti ringkasan prinsip arsitektur.
- `docs/API.md`: bentuk `LiveProgress` dikoreksi sesuai engine (dua bentuk: unduhan dan masa tunggu), `EngineStatus` dikoreksi (tidak ada `STOPPING`; ada `COOLDOWN`/`COOLDOWN_429`/teks alasan), field `detail` event `engine`, `category` di contoh event `item`, format `createdAt` per database, alias `stop`/`start` di `/api/control`, perilaku `success` di rescan, dan bentuk `LibraryItem`.
- `docs/AI_AGENT.md`: baris `DOWNLOAD_DIR` dikoreksi (pengaturan tersimpan tidak dibaca ulang saat startup), peta modul (`listParser.js`, helper UI), layout folder bertipe, serta baris troubleshooting baru (error sertifikat/DNS ISP untuk sumber lain, baris `ignored`, batas circuit breaker yang benar, pemulihan "Download folder unavailable" lewat Library Rescan).
- `docs/PLAN.md`: item `samples/` ditandai selesai (sudah masuk `.gitignore`), jumlah baris `App.svelte` dikoreksi, baris Log baru; item cek langsung ke situs asli tetap belum dicentang.
- `docs/CHANGELOG.md` dan `docs/PLAN.md`: nama berkas lama router CLI diganti redaksi generik (nama asli hanya boleh ada di kode).
- `docs/POSTGRES.md`: dicek terhadap adapter (pool 10, retry 2 detik/60 detik, migrasi v1–v4); tidak ada perubahan.
- Test suite: 123 lulus, 1 di-skip (live PostgreSQL), 0 gagal (124 test).

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Tipe konten (comic/manga/other)
- Modul baru `core/providers/contentType.js`: slug kategori situs dipetakan ke tipe (`western`/`porn-comic`/`comic` -> `comic`; `manga`/`doujinshi` -> `manga`; lainnya -> `other`). Provider site B1/B2/C mengekstrak kategori; kegagalan ekstraksi dicatat di `categoryError` tanpa menggagalkan unduhan.
- Skema v4: kolom `queue.category` (SQLite dan PostgreSQL), ikut export/import. Library menyimpan `meta.contentType`.
- Engine: galeri sumber berprefix disimpan di `<base>/<Tipe>/<Bahasa>/<Author>/<Judul>`; site A tidak berubah. `findExistingOnDisk` memindai folder dasar dan semua folder tipe.
- UI: badge tipe dan filter Type di antrian dan library; filter dengan tipe yang sudah tidak ada diabaikan, dan sidebar menutup saat tipe dipilih.
- Pengecekan langsung ke situs asli TIDAK dapat dijalankan (DNS sedang diblokir, sertifikat yang diterima bukan milik situs). Diganti pengecekan offline: parser asli dijalankan terhadap markup/JSON asli yang tersimpan, satu galeri per sumber. Hasil: site B1 -> kategori `manga` -> tipe `manga` (240 halaman, bahasa Japanese); site B2 -> `western` -> `comic` (51 halaman, English); site C -> `porn-comic` -> `comic` (17 gambar, tanpa `categoryError`; respons detail site C disuplai stub). Pengecekan langsung masih terbuka.
- Test suite: 122 lulus, 1 di-skip (live PostgreSQL), 0 gagal.

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Pembaruan tampilan antrian
- Filter sidebar "Queued" menjadi **Queue** dan kini mencakup `PENDING` dan `ON_PROGRESS` (item yang sedang diunduh tetap terlihat di antrian; "Downloading" hanya `ON_PROGRESS`, "Completed" tetap `DONE`/`SKIPPED`). Status bar tetap menghitung `PENDING` saja lewat `filterCounts.pending` supaya "Active" dan "Queued" tidak dihitung ganda.
- Baris `ON_PROGRESS` diberi penanda aksen biru di tepi kiri dan latar tipis.
- Chip hitung mundur kuning (mis. `⏱ 22s`) di sel Status: pada item `PENDING` pertama menurut urutan rank saat `COOLDOWN`/`BATCH_REST`, dan pada item berstatus `COOLDOWN` saat `RATE_LIMIT` 429 (format `m:ss`). Data dari `liveProgress` yang sudah ada lewat SSE; tidak ada perubahan server/API dan tidak ada polling.
- Kolom desktop baru **Ditambahkan** (`createdAt`, terakhir setelah Format, bisa diurutkan, tanggal tidak valid selalu di akhir). Waktu lokal `06 Okt 13:31`, tooltip `2026-10-06 13:31:45`; format SQLite (UTC tanpa zona) dan ISO PostgreSQL sama-sama diurai. Lebar kolom tersimpan digabung dengan default sehingga kolom baru selalu punya lebar.
- Helper murni baru `webui/src/lib/queueView.js` dengan tes `test/webuiQueueView.test.js` (ditulis lebih dulu).
- Badge sumber kini tampil untuk semua item (termasuk sumber default, label fallback situs default bila daftar sumber server belum dimuat) di antrian dan library; bagian "Source" sidebar tampil selama ada minimal satu sumber. Hanya UI, tanpa perubahan server/API.
- Test suite: 101 lulus, 1 di-skip (live PostgreSQL), 0 gagal.

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Transport curl untuk site C
- `core/providers/http.js`: `resolveCurlPath`, `curlFetchText`, dan `curlDownloadToFile` (system `curl` lewat `execFile` dengan array argumen; status HTTP dibaca lewat `-w`, unduhan ke `.part` lalu rename hanya untuk 200, error HTTP membawa `statusCode`). Ditambahkan tanpa mengubah ekspor lama.
- Provider punya field `transport`: `'curl'` untuk site C, `'node'` untuk site B1/B2 dan default. `fetchProviderMetadata` dan `downloadProviderPage` di engine memilih helper sesuai `transport`; logika fallback 404 per kandidat, placeholder, dan retry tidak berubah.
- Alasan: API gambar site C menjawab 403 (tantangan Cloudflare) untuk klien Node, sedangkan `curl` sistem dengan User-Agent/Referer yang sama mendapat 200. Tidak ada impersonasi, penyelesaian tantangan, atau trik DNS.
- Tes baru untuk helper curl, pemilihan transport, dan unduhan engine lewat curl dari server lokal. Tes langsung site C (antrian lewat API, SQLite sementara): 17/17 file (16 `.webp` + 1 `.jpg`, total byte sama dengan salinan referensi), tanpa `.part`, tanpa file < 2 KB, `pageExts` di library sama dengan file di disk, marker `.nhdl-id` berisi kunci berprefix, field `source` berisi prefix sumber.
- Test suite: 84 lulus, 1 di-skip (live PostgreSQL), 0 gagal.

## 2026-10-06 · AI (Claude Code, Sonnet 5.5) · Multi-source download
- **Lapisan provider (`core/providers/`)**: registry sumber unduhan dengan pengenalan URL/ID/kunci berprefix (`resolveInput`), provider default (certain site ( ͡° ͜ʖ ͡°)) plus tiga sumber baru: site B1 dan B2 (halaman galeri HTML, ekstensi per halaman) dan site C (slug + JSON API gambar). `http.js` menyediakan `fetchText` dan `downloadToFile` bersama.
- **Kunci galeri berprefix**: `gallery_id` kini kunci kanonik bertipe teks (`b1:...`, `b2:...`, `c1:...`; site A tetap angka polos). `toPublicId()` mengembalikan angka untuk site A dan string untuk sumber lain, sehingga API lama tetap kompatibel. `core/db/listParser.js` mengurai baris `list.txt` lewat registry; baris yang tidak dikenali dilewati dan dihitung di `ignored`.
- **Migrasi skema v3** di SQLite dan PostgreSQL: kolom `gallery_id` menjadi `TEXT` di `queue` dan `library`; export/import tetap membawa ID publik.
- **Engine**: galeri berprefix diunduh lewat provider (semua halaman yang diumumkan, tanpa filter), mendukung pause/resume per halaman, placeholder untuk halaman yang 404 di semua kandidat, ekstensi per halaman tercatat eksplisit saat resume, serta nama folder aman (tanpa `:`).
- **Field `source`** ditambahkan di `/api/status`, `/api/library`, dan event SSE `item`; kontrak dicatat di `docs/API.md`.
- **UI**: badge sumber di tabel antrian, sidebar, dan Library, plus filter sumber; seluruh webui memakai kunci string.
- **Tes langsung** terhadap tiga situs sungguhan (antrian lewat API, SQLite sementara): site B1 240/240 halaman dan site B2 51/51 halaman selesai tanpa file `.part`, tanpa file < 2 KB, ekstensi di library sama dengan file di disk, marker `.nhdl-id` berisi kunci berprefix, pause (72/240) lalu resume berlanjut sampai 240/240. Site C **gagal**: API-nya menjawab 403 (tantangan Cloudflare) untuk klien Node (`fetch`/`https`) sementara `curl` dengan header yang sama lolos; tidak dipatch di entri ini dan dicatat sebagai pekerjaan lanjutan di `docs/PLAN.md`.
- **Perbaikan hasil review akhir**: baris tanpa skema (`host/g/123/`) di-resolve ke provider yang benar dan host asing tidak lagi jatuh ke ID site A (dihitung `ignored`); 429/503 dari site B/C masuk ke cooldown/circuit breaker yang sama dengan site A; unduhan gambar memeriksa signature file (halaman blokir/tantangan HTML ditolak, bukan disimpan sebagai gambar); jumlah `ignored` tampil di log aktivitas dan toast; URL fallback per sumber saat `url` kosong (enqueue/import); nilai `load_server`/`load_dir`/`load_id` divalidasi sebelum membentuk URL; API site C tanpa gambar menjadi SKIPPED permanen; koreksi dokumen (`galleryId`, `stopping`, contoh `source`, catatan prefix asli di `docs/AI_AGENT.md`).
- Test suite: 96 lulus, 1 di-skip (live PostgreSQL), 0 gagal.

## 2026-10-06 · Manual (Maja) · Multi-source download
- Meminta dukungan unduhan dari beberapa sumber (tiga situs tambahan) dan menyediakan sampel manual untuk pembanding tes langsung.

## 2026-09-28 · AI (Claude Code, Opus 5.5) · Fase 8
- Tambah `docs/AI_AGENT.md` (bahasa Inggris) untuk AI agent: larangan tanpa izin user, deploy (lokal, Docker, SQLite vs PostgreSQL, auto-migrasi), tabel env var yang dicek ke kode, health check dengan output yang diharapkan, manage lewat API (antrian, prioritas, log, API key, backup/export/import/restore), peta modul dan pola fitur DB → REST → SSE, serta tabel troubleshooting per gejala.
- `README.md`: blok pemicu "If you are an AI agent" di paling atas.
- `AGENTS.md`: tautan ke `docs/AI_AGENT.md`, dan aturan arsitektur diperbarui untuk DB async + dua adapter (migrasi skema wajib di SQLite dan Postgres).
- Validasi: langkah deploy diikuti dari clone bersih (setup 17 detik), dan health check sesuai dokumen.

## 2026-09-28 · Manual (Maja) · Fase 8
- Meminta Fase 8 dikerjakan langsung oleh Claude Code.

## 2026-09-28 · AI (Claude Code, Opus 5.5) · Rilis
- **Fix container crash:** `Dockerfile` tidak menginstal dependency backend, padahal `core/db.js` selalu memuat `pg`, sehingga container gagal start ("Cannot find module 'pg'") bahkan di mode SQLite. Sekarang `npm ci --omit=dev` dijalankan di image, dan `.dockerignore` ditambahkan supaya `node_modules` lokal, `data/`, dan `.env` tidak ikut masuk image.
- `start.bat`: instal dependency backend otomatis kalau `pg` belum ada.
- `docker-compose.yml`: contoh `DATABASE_URL` diubah ke format daftar env (`- DATABASE_URL=${DATABASE_URL}`) yang benar, dengan nilai diambil dari `.env`.
- `README.md` ditulis ulang sesuai kondisi saat ini: dashboard qBittorrent/IDM, SSE, SQLite/PostgreSQL, backup/export/import, tabel env var, dan langkah Docker + Postgres.
- Merge `rework` ke `main` (fast-forward): Fase 5 (ditutup), Fase 6 (dibatalkan), dan Fase 7 (PostgreSQL + backup/export/import).
- Review Fase 7 sebelum merge: 40/41 test lulus (1 test Postgres live di-skip di mesin review); import tidak valid ditolak tanpa mengubah data; backup otomatis sebelum import replace; server bersih bisa start setelah `npm ci --omit=dev`.

## 2026-09-28 · Manual (Maja) · Rilis
- Meminta README diperbarui, lalu menyetujui merge Fase 7 ke `main`.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **Eksekusi Test Suite Live PostgreSQL Sungguhan (`test/db.test.js`, `docs/PLAN.md`)**:
  - Menjalankan instance PostgreSQL 18.6 lokal dan database uji `nhdl_test`.
  - Mengeksekusi suite pengujian penuh dengan konfigurasi `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/nhdl_test`.
  - Menguji migrasi skema langsung (v1 -> v2), enqueue antrian, update status `DONE`, penambahan entri library, ekspor data, pembersihan data, serta proteksi impor payload invalid.
  - Memvalidasi bahwa parser tipe OID 20 mengembalikan tipe `number` untuk `gallery_id`, `id`, dan `COUNT(*)` pada query live ke engine PostgreSQL sungguhan.
  - Hasil: Seluruh 41 test lulus tanpa ada yang di-skip maupun gagal (`41 pass, 0 fail, 0 skipped`).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **Registrasi Driver Parser Tipe OID 20 PostgreSQL (`core/db/postgres.js`, `test/db.test.js`)**:
  - Daftarkan parser kustom `pg.types.setTypeParser(20, v => parseInt(v, 10))` di `core/db/postgres.js`.
  - Mengonversi nilai PostgreSQL `int8` / `BIGSERIAL` / `BIGINT` / `COUNT(*)` menjadi tipe data JavaScript `Number` alih-alih `String`.
  - Mencegah inkonsistensi tipe data saat komparasi `item.gallery_id === 123` di backend dan frontend.
  - Tambahkan unit/integration test di `test/db.test.js` dan verifikasi bahwa parsing `COUNT(*)`, `gallery_id`, dan `id` bernilai `number` (40/40 test lulus).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **Hapus Event Reordered Kosong & Pancarkan Event Reloaded/Snapshot Baru Setelah Import/Restore (`core/db/sqlite.js`, `core/db/postgres.js`, `server/index.js`, `docs/API.md`, `webui/src/lib/stores/app.svelte.js`, `test/sse.test.js`)**:
  - Hapus pemancaran event `item` bertipe `reordered` dengan `items: []` pada akhir `importData()` di adapter SQLite dan PostgreSQL.
  - Ganti dengan pemancaran event `reloaded` dari `dbEvents` setiap kali operasi `importData` (maupun `restoreBackup`) sukses diselesaikan.
  - Di `server/index.js`, tangkap event `reloaded` dari `dbEvents` dan pancarkan event SSE `snapshot` serta `reloaded` berisi state antrian terbaru ke seluruh klien SSE aktif.
  - Di frontend store `webui/src/lib/stores/app.svelte.js`, tambahkan listener untuk event SSE `reloaded` yang memanggil `applySnapshot()` dan `refreshLibraryIndex()`, sehingga UI langsung sinkron tanpa perlu refresh halaman browser.
  - Perbarui dokumentasi event SSE pada `docs/API.md`.
  - Tambahkan unit/integration test di `test/sse.test.js` yang memverifikasi ketiadaan event `reordered` kosong serta diterimanya payload snapshot segar pada event SSE saat `importData` dijalankan (39/39 test lulus, build UI 0 warning).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **Backup Pre-Migration Otomatis pada Auto-Migrate SQLite ke Postgres (`core/db/auto-migrate.js`, `test/db.test.js`)**:
  - Sebelum data SQLite diimpor ke PostgreSQL via mode replace, sistem membuat file backup JSON `nhdl-backup-pre-migration-<ts>.json` di direktori folder backup aktif (`data/backups/` atau `NHDL_BACKUP_DIR`).
  - Jika pembuatan backup gagal, proses migrasi otomatis langsung dibatalkan (`return false`), data tidak diimpor ke PostgreSQL, dan file basis data SQLite asli tidak diubah namanya ke `.migrated`.
  - Mengembalikan properti `preMigrationBackup` pada hasil migrasi dan memangkas retensi backup lama via `rotateBackups()`.
  - Tambahkan unit/integration test di `test/db.test.js` yang memverifikasi pembuatan file backup pre-migration, validitas format JSON, serta pembatalan migrasi tanpa merusak/mengubah nama file SQLite ketika backup gagal (38/38 test lulus).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **Otomatisasi Backup & Penjadwalan Database (`core/db/backup.js`, `core/db.js`, `server/index.js`, `docs/API.md`, `webui/src/lib/components/FolderPickerModal.svelte`, `webui/src/lib/api.js`, `test/db.test.js`)**:
  - Konfigurasi jadwal backup otomatis via DB settings: `backupIntervalHours` (default 24 jam, 0 = dinonaktifkan), `backupKeep` (default 7 file retensi).
  - Simpan timestamp pencadangan terakhir di tabel `settings` (`lastBackupAt`) agar jadwal tidak reset setiap kali server/kontainer di-restart.
  - Scheduler aman dijalankan saat mesin engine sedang aktif (operasi baca database tidak mengganggu unduhan); bila terjadi kegagalan, sistem otomatis mengulang percobaan tiap 10 menit.
  - Dukung penentuan direktori folder backup kustom melalui environment variable `NHDL_BACKUP_DIR`.
  - Pemangkasan retensi backup (`rotateBackups`) otomatis mempertahankan `backupKeep` file backup terbaru dan menghapus file terlama.
  - Tambahkan kartu pengaturan "Scheduled Backups" di tab Database Web UI lengkap dengan input interval jam, kuota retensi, estimasi waktu backup berikutnya, dan lokasi folder backup aktif.
  - Tambahkan unit dan integration test di `test/db.test.js` untuk memverifikasi scheduling, rotasi, penolakan saat disabled (interval 0), override `NHDL_BACKUP_DIR`, serta endpoint API `/api/config` & `/api/db/info` (37/37 test lulus, build UI 0 warning).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **Backup Otomatis Pre-Import / Pre-Restore Mode Replace (`server/index.js`, `docs/API.md`, `webui/src/lib/components/FolderPickerModal.svelte`, `test/db.test.js`)**:
  - Implementasikan pembuatan backup otomatis `nhdl-backup-pre-import-<ts>.json` di `POST /api/db/import` dan `POST /api/db/restore` sebelum data dikosongkan pada mode `replace`.
  - Jika pembuatan backup gagal, proses import/restore dibatalkan dan server mengembalikan error 500.
  - Nama file backup (`preImportBackup`) disertakan pada respons JSON dan ditampilkan di notifikasi toast serta banner antarmuka modal Database.
  - Tambahkan unit/integration test di `test/db.test.js` untuk memverifikasi pembuatan file backup pre-import dan integritas datanya (36/36 test lulus, build UI 0 warning).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **Proteksi 409 Conflict Import/Restore Saat Engine Berjalan (`server/index.js`, `docs/API.md`, `webui/src/lib/api.js`, `webui/src/lib/components/FolderPickerModal.svelte`, `test/db.test.js`)**:
  - Dokumentasikan respon 409 pada `/api/db/import` dan `/api/db/restore` di `docs/API.md`.
  - Server menolak request import dan restore database dengan `409 Conflict` dan pesan `"Pause engine first"` (`needsPause: true`) bila `engine.isRunning` atau terdapat item antrian berstatus `ON_PROGRESS`.
  - UI Settings Database menampilkan banner peringatan interaktif dan menawarkan tombol "Pause Engine" langsung untuk menghentikan mesin pengunduh sebelum memulai proses impor/pemulihan database.
  - Tambahkan unit/integration test di `test/db.test.js` untuk memverifikasi penolakan 409 saat engine berjalan maupun ada item ON_PROGRESS (35/35 test lulus, build UI 0 warning).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **Validasi Ketat importData Sebelum Transaksi Database (`core/db.js`, `core/db/common.js`, `core/db/sqlite.js`, `core/db/postgres.js`, `test/db.test.js`)**:
  - Implementasikan `validateImportPayload()` di `core/db/common.js` yang dieksekusi sebelum membuka transaksi database di `core/db.js`, `core/db/sqlite.js`, dan `core/db/postgres.js`.
  - Tolak impor jika `payload.format !== "nhdl-export"`, `version` tidak dikenal (hanya versi 1), `tables` bukan objek, atau ada tabel yang bukan array.
  - Tolak jika `schemaVersion` (atau `schema_version`) payload lebih baru daripada schema versi aplikasi (`CURRENT_APP_SCHEMA_VERSION = 2`).
  - Validasi setiap baris pada tabel `queue` dan `library` memiliki `gallery_id` valid; bila ada satu baris tidak valid, tolak seluruh proses impor tanpa membuka transaksi.
  - Tolak impor mode `replace` jika file tidak berisi baris `queue` maupun `library` sama sekali, kecuali diberikan opsi eksplisit `{ allowEmpty: true }`.
  - Tambahkan properti `format: 'nhdl-export'` pada output `exportData()` di adapter SQLite dan PostgreSQL.
  - Tambahkan unit/integration test komprehensif di `test/db.test.js` yang memverifikasi data lama tetap utuh ketika import ditolak (34/34 test lulus).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **7.7 Docker Compose, Env Configuration & Cross-DB Tests (`docker-compose.yml`, `.env.example`, `core/db/postgres.js`, `test/db.test.js`)**:
  - Perbarui `docker-compose.yml` dengan contoh konfigurasi `DATABASE_URL` ke PostgreSQL terpusat (shared PostgreSQL), dokumentasi bahwa volume `data/` opsional saat memakai PostgreSQL (hanya diperlukan bila ingin menyimpan file backup JSON lokal di host), contoh koneksi network docker, serta memastikan kontainer tetap berjalan secara standalone dengan SQLite sebagai default.
  - Perbarui `.env.example` dengan dokumentasi variabel lingkungan `DATABASE_URL` dan `TEST_DATABASE_URL`.
  - Ekspor array `MIGRATIONS` pada `core/db/postgres.js` dan dukung `options.db` pada `importData`.
  - Tambahkan pengujian lintas database pada `test/db.test.js`:
    - Uji eksekusi migrasi skema PostgreSQL bertahap dari versi 1 ke versi 2 (memverifikasi pembuatan tabel, penambahan kolom, dan indeks).
    - Uji integritas ekspor SQLite ke impor PostgreSQL (memverifikasi struktur tabel `queue`, `library`, `settings`, `events`, parameterisasi query, dan transaksi).
    - Uji integrasi live PostgreSQL yang otomatis berjalan saat `TEST_DATABASE_URL` tersedia dan di-skip secara graceful saat tidak ada.
  - Seluruh test lulus (33 lulus, 1 skip graceful, 0 gagal) dan `npm run build:ui` selesai dengan 0 warning.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **7.6 Tab Database di Modal Settings Web UI (`webui/src/lib/components/FolderPickerModal.svelte`, `webui/src/lib/api.js`)**:
  - Tambahkan fungsi klien API di `webui/src/lib/api.js` untuk `/api/db/info`, `/api/db/backups`, `/api/db/backup`, `/api/db/restore`, `/api/db/backups/:name`, dan `/api/db/import`.
  - Tambahkan navigasi tab di modal Settings (`FolderPickerModal.svelte`): tab `General & Downloads` (format simpan, batch behavior, API key, penjelajah folder unduhan) dan tab `Database`.
  - Implementasikan tab `Database`:
    - Header info database aktif dengan badge status koneksi (`Connected` / `Disconnected`), tipe engine (SQLite / PostgreSQL), dan detail path file (SQLite) atau host:port/database dengan sensor kredensial (PostgreSQL).
    - Tombol aksi instan: `Export DB` (download langsung file JSON lintas database) dan `Backup Now` (pembuatan snapshot backup instan ke `data/backups/`).
    - Area `Import Database` dengan drop zone drag-and-drop / file picker untuk file JSON, selektor mode `Merge (Skip duplicates)` vs `Replace all data`, dialog peringatan bahaya overwrite data, serta checkbox konfirmasi keamanan sebelum eksekusi.
    - Daftar backup lokal di `data/backups/` dengan informasi nama file, ukuran, tanggal, tombol `Restore` (dengan konfirmasi keamanan), dan tombol `Delete`.
    - Integrasi penuh dengan notifikasi Toast (`appStore.showToast`), ARIA accessibility, dan Svelte 5 runes (`npm run build:ui` 0 warning, 31/31 test lulus).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **7.5 Migrasi Otomatis SQLite ke PostgreSQL pada Startup (`core/db/auto-migrate.js`, `core/db.js`)**:
  - Implementasikan modul deteksi dan migrasi otomatis `core/db/auto-migrate.js` saat NHDL berjalan dengan PostgreSQL (`DATABASE_URL`).
  - Bila instance PostgreSQL masih kosong (tabel `queue` dan `library` sama-sama memiliki 0 baris) dan file database lokal `data/nhdl.db` memiliki data, sistem otomatis mengekspor seluruh data SQLite (`queue`, `library`, `settings`, `events`) dan mengimpornya ke PostgreSQL menggunakan mode `replace` dalam satu transaksi.
  - Setelah migrasi berhasil, file SQLite lokal diubah namanya menjadi `data/nhdl.db.migrated` (beserta pembersihan file `-wal` dan `-shm` terkait), pesan log `[+] Migration complete...` ditampilkan di konsol, dan event audit dicatat di tabel `events`.
  - Tambahkan unit test di `test/db.test.js` untuk memvalidasi proses migrasi otomatis dan penggantian nama file (total 31/31 test lulus, `npm run build:ui` 0 warning).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **7.4 Database Export, Import, Backup & Restore (`core/db/backup.js`, `server/index.js`, `docs/API.md`)**:
  - Dokumentasikan kontrak endpoint `/api/db/info`, `/api/db/export`, `/api/db/import`, `/api/db/backup`, `/api/db/backups`, `/api/db/restore`, dan `/api/db/backups/:name` di `docs/API.md` terlebih dahulu sebelum implementasi.
  - Implementasikan fungsi ekspor dan impor database universal (`exportData`, `importData`) pada `core/db/sqlite.js` dan `core/db/postgres.js` dengan dukungan mode `replace` (mengosongkan tabel lalu menyalin ulang dalam satu transaksi) dan `merge` (`ON CONFLICT DO NOTHING`).
  - Buat modul manajemen backup `core/db/backup.js` dengan penyimpanan di `data/backups/nhdl-backup-*.json`, rotasi otomatis mempertahankan 7 file backup terbaru, pemulihan (*restore*), penghapusan, dan scheduler backup otomatis harian saat engine menganggur (*idle*).
  - Hubungkan seluruh endpoint REST di `server/index.js` dengan penanganan error yang andal dan pencatatan audit di tabel `events`.
  - Tambahkan 3 unit/integration test baru di `test/db.test.js` yang memverifikasi siklus penuh ekspor-impor, rotasi backup, restore data, dan seluruh endpoint HTTP (total 30/30 test lulus, `npm run build:ui` 0 warning).

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **7.3 Implementasi PostgreSQL Adapter, Retry Pool & Panduan `docs/POSTGRES.md`**:
  - Implementasikan seluruh dialek PostgreSQL di `core/db/postgres.js`: migrasi skema dengan tipe data `BIGINT`/`BIGSERIAL` untuk `id` dan `gallery_id`, `TIMESTAMPTZ` dengan default `now()`, parameter terkueri `$1, $2, ...`, `ON CONFLICT (gallery_id) DO NOTHING` / `DO UPDATE`, dan query `information_schema`.
  - Tambahkan mekanisme `connectWithRetry` pada connection pool `pg.Pool` (maks 10 koneksi) yang mencoba ulang setiap 2 detik hingga 60 detik jika PostgreSQL belum siap saat container menyala.
  - Tambahkan penyensoran kata sandi (`maskDatabaseUrl`) pada log startup daemon dan API info database agar kredensial tidak pernah terekspos.
  - Buat `docs/POSTGRES.md` berisi panduan SQL setup user dan database `nhdl` dengan hak akses minimal (*least privilege*) termasuk konfigurasi PostgreSQL 15+.
  - Perbarui peta arsitektur di `docs/ARCHITECTURE.md` untuk mencatat dependensi `pg` dan struktur adapter `core/db/`.
  - Seluruh test (27/27) lulus dan build UI selesai dengan 0 warning.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **7.2 Pemisahan Adapter Database (`core/db/sqlite.js` & `core/db/postgres.js`)**:
  - Pasang dependency runtime `pg` untuk koneksi PostgreSQL (satu-satunya pengecualian runtime backend).
  - Ekstrak implementasi SQLite ke `core/db/sqlite.js`, buat struktur adapter PostgreSQL di `core/db/postgres.js`, dan buat modul bersama `core/db/events.js` (EventEmitter) serta `core/db/common.js` (`normalizeGalleryId`, `formatQueueRow`, `maskDatabaseUrl`).
  - Ubah `core/db.js` menjadi dispatcher yang mendeteksi `DATABASE_URL` atau opsi eksplisit `initDb()`, mengekspor antarmuka konsisten untuk seluruh operasi antrian, pustaka, pengaturan, dan log aktivitas.
  - Seluruh test (27/27) lulus dan build UI selesai dengan 0 warning.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 7
- **7.1 Konversi API `core/db.js` menjadi Async**:
  - Konversi seluruh fungsi yang diekspor dari `core/db.js` agar mengembalikan Promise (`async`/`await`), termasuk fungsi pembacaan, penulisan, migrasi skema, import/export list text, helper settings, dan query events.
  - Sesuaikan seluruh modul pemanggil di `core/logger.js`, `core/tracker.js`, `core/engine.js`, `server/index.js`, dan `scripts/find-bad-archives.js` agar me-`await` pemanggilan DB secara konsisten tanpa ada unhandled rejection atau Promise menggantung.
  - Perbaiki query `hasActiveLibraryEntries` agar memeriksa kolom `format` pada tabel `library` (`format IS NULL OR format != 'skipped'`), perbaiki penutupan watcher drive pada `test/db.test.js`, dan hapus panggilan ganda `initDb()` di request handler `server/index.js`.
  - Seluruh test (27/27) lulus tanpa menggantung dan `npm run build:ui` selesai dengan 0 warning.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 5 & 6
- **TASK 0: Penutupan Fase 5 dan Pembatalan Fase 6 di `docs/PLAN.md`**:
  - Fase 5 ditandai selesai `[x]`: pengujian 5.000 item antrian hanya merender ±700 elemen DOM melalui virtual table, pergantian kembali ke filter "All" membutuhkan waktu 15ms, filter kategori 4–16ms, dan payload pembaruan SSE hanya ±250B per update vs ±245KB/detik polling `/api/status` di UI lama.
  - Fase 6 (Backend Go) dibatalkan `[-]`: bottleneck performa terbukti berada di rendering DOM dan polling frontend yang kini telah teratasi sepenuhnya; backend Node.js terbukti ringan, stabil, dan tidak menjadi kendala arsitektur.

## 2026-09-28 · AI (Claude Code, Opus 5.5) · Rilis
- Merge `rework` ke `main` (fast-forward): Fase 4 (layout qBittorrent/IDM, virtual table, pause/resume/delete/prioritas per item, panel detail, status bar) kini ada di `main`.
- Sebelum merge sudah direview: 27/27 test lulus; uji browser 5000 item (~700 elemen DOM, kembali ke filter "All" 15ms, scroll sampai item terakhir, tampilan mobile 375px); prioritas Up/Down/Top/Bottom di antrian 1000 item benar dan ter-update real-time lewat SSE.

## 2026-09-28 · Manual (Maja) · Rilis
- Menyetujui merge Fase 4 ke `main`.

## 2026-09-28 · AI (Antigravity, Gemini 3.8 Flash High) · Fase 4
- **Perbaikan bug payload event SSE `reordered` hilang di `onDbItem` (`server/index.js`, `test/sse.test.js`)**: ubah handler `onDbItem` di `server/index.js` agar meneruskan seluruh properti event ke payload SSE (`const { rawRow, ...payload } = evt;`) kecuali `rawRow` (data internal baris DB mentah). Sebelumnya, `onDbItem` hanya menyalin `item`, `galleryId`, `batch`, dan `removedIds`, sehingga field `items` pada event `reordered` terbuang dan urutan baris di UI tidak berubah sampai reload. Urutan tabel virtual kini langsung terurut ulang secara real-time di semua tab saat kolom `#` aktif sebagai sort dan seleksi tetap menempel ke item yang sama. Ditambahkan unit test level SSE di `test/sse.test.js` yang memverifikasi `POST /api/queue/priority` ("up" dan "top") memancarkan event `reordered` lengkap dengan `items` dan tanpa `rawRow` (total 27/27 test lulus, `npm run build:ui` 0 warning).
- **Perbaikan bug `updateQueuePriority()` pada antrian `> 500` item (`core/db.js`, `webui/src/lib/stores/app.svelte.js`, `docs/API.md`)**: hapus cabang `reordered.length > 500` yang sebelumnya hanya melakukan `priority ± 1` (menyebabkan item di tengah melompat ke `#1` atau `#1000` saat item lain berprioritas `0`). `up`/`down` kini selalu menukar posisi dengan tetangga langsung (`ORDER BY priority DESC, id ASC`, termasuk pergeseran blok multi-select dengan urutan internal tetap) untuk ukuran antrian berapa pun. Bila prioritas sudah menurun ketat (`isStrictlyDecreasing`), hanya baris yang bertukar posisi (2 baris untuk 1 item) yang di-update; bila ada duplikasi prioritas (mis. semua `0`), seluruh antrian dinormalisasi ke `total - idx` dalam satu transaksi `BEGIN IMMEDIATE` dengan satu prepared statement tanpa memanggil `updateQueueItem()` per baris, lalu memancarkan satu event SSE `item` bertipe `reordered` (`{ type: "reordered", items: [{ galleryId, priority }] }`) yang ditangani di `applyItemEvent()` store frontend (normalisasi 5.000 item selesai `< 200ms` dengan 1 event SSE, 26/26 test lulus).
- **Verifikasi Fase 4 (5.000 Item Status Campuran, Virtual DOM, Filter `< 50ms`, & 2-Tab SSE Sync)**: tambahkan test otomatis 5.000 item status campuran (`PENDING`, `ON_PROGRESS`, `DONE`, `SKIPPED`, `STOPPED`, `ERROR`) di `test/sse.test.js` dan verifikasi langsung di DOM Chrome headless: jumlah elemen DOM baris (`[role="row"][data-gallery-id]`) terjaga di `23` baris saat di ujung atas/bawah dan `34` baris di tengah scroll (bukan 5.000), waktu pindah filter instan `< 50ms` (`Downloading=6.2ms`, `Completed=5.3ms`, `Stopped=4.8ms`, `Failed=5.0ms`, kembali ke `All=6.0ms`), scroll penuh `0..159.588px` (`#800001..#805000`) tanpa baris kosong/berkedip, sinkronisasi 2 tab via SSE langsung tercermin (`pause=4.76ms`, `resume=5.63ms`, `delete=7.23ms`), serta endpoint fitur lama (`Library`, `Settings`, `Logs`, `folder picker`) berjalan normal (25/25 test lulus, `npm run build:ui` 0 warning).
- **B4–B7 (Panel Detail Bertab, Status Bar, GSAP & Layout Responsif)**: buat `DetailPanel.svelte` (3 tab `General`, `Pages` dengan HUD active page workers + progress grid per halaman, dan `Log` yang mengambil `GET /api/logs?galleryId=<id>`, tinggi panel resizable di `localStorage`, animasi collapse/expand GSAP, serta mode bottom sheet untuk layar `< 768px`), `StatusBar.svelte` (status engine + badge peringatan saat `Download folder unavailable`, counter `Active`/`Queued`/`Done`/`Failed`, total speed, dan status koneksi SSE), `Toast.svelte`, serta integrasikan seluruh layout qBittorrent/IDM di `webui/src/App.svelte` (`npm run build:ui` 0 warning).
- **B3 (Virtual Queue Table & Context Menu)**: buat `VirtualQueueTable.svelte` dengan virtualisasi kustom tanpa library eksternal (tinggi baris tetap `32px`, overscan `±10` baris), 10 kolom desktop (`#`, `Judul`, `ID`, `Status`, `Progress`, `Halaman`, `Speed`, `ETA`, `Batch`, `Format`) dan 3 kolom mobile `< 768px` (`Judul`, `Status`, `Progress`) tanpa scroll horizontal, sort klik header (`asc`/`desc`), lebar kolom resizable yang disimpan di `localStorage` (dengan `try/catch`), multi-select (`klik`, `Ctrl+klik`, `Shift+klik`, `Ctrl+A`), shortcut keyboard (`ArrowUp`, `ArrowDown`, `Delete`, `Space`), serta `ContextMenu.svelte` saat klik kanan.
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
- Hapus CLI: `cli/index.js` dan router lama di root project.
- `package.json`: `main` dan `npm start` diarahkan ke `server/index.js`; bin `nhdl` dan script `cli` dihapus.
- `start.bat` menjalankan `node server/index.js`.
- README: bagian CLI dihapus.
- Tambah `docs/PLAN.md` (rencana rework + status) dan `docs/CHANGELOG.md` ini.
- Tambah `AGENTS.md` (aturan logging untuk semua agent), dengan `GEMINI.md` dan `CLAUDE.md` merujuk ke sana.
- Pembagian kerja: rework UI dan kode dikerjakan user lewat Antigravity (Gemini 3.8 Flash High).

## 2026-09-27 · Manual (Maja) · —
- `git pull`: update `core/engine.js`, `core/tracker.js`, `core/utils.js` (b88919e).
- Memutuskan arah rework: UI ala qBittorrent/IDM, Svelte + GSAP, CLI dihapus, migrasi bertahap.
