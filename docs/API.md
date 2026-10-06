# NHDL — Kontrak REST API & Event SSE

Dokumen ini menjadi kontrak resmi untuk seluruh komunikasi antara frontend (Svelte UI) dan backend (`server/index.js` maupun calon backend Go di Fase 6).
Setiap endpoint atau event baru **wajib** ditambahkan ke dokumen ini terlebih dahulu sebelum diimplementasikan di kode.

> **Catatan Dokumentasi:** Situs target disebut **"certain site ( ͡° ͜ʖ ͡°)"** dengan domain contoh `https://certain.site/g/<gallery_id>/`.

---

## 1. Tipe Data Utama

### `QueueItem`
Representasi item antrian yang dikirim melalui REST (`/api/status`) maupun SSE (`/api/events`):
```json
{
  "id": 1,
  "galleryId": 123456,
  "source": "default",
  "status": "PENDING",
  "rawStatus": "PENDING",
  "url": "https://certain.site/g/123456/ | [Artist] Title",
  "title": "[Artist] Title",
  "batch": 1,
  "priority": 0,
  "pagesDone": 0,
  "pagesTotal": 24,
  "error": null,
  "retries": 0,
  "format": "cbz",
  "createdAt": "2026-09-28 08:00:00",
  "updatedAt": "2026-09-28 08:01:00"
}
```
- Nilai `rawStatus`: `'PENDING'` | `'ON_PROGRESS'` | `'STOPPED'` | `'PAUSED'` | `'COOLDOWN'` | `'DONE'` | `'ERROR'` | `'SKIPPED'`
- Status `'STOPPED'` khusus untuk item yang di-pause secara manual oleh pengguna (tidak disentuh oleh `requeueFailedItems()` maupun pre-pass `_runBatchBody`). Status `'PAUSED'` digunakan oleh *circuit breaker* saat terkena batas 429 beruntun.
- Nilai `status`: sama dengan `rawStatus`, atau `"${rawStatus} - ${error}"` apabila kolom `error` terisi.
- `galleryId`: `number` untuk galeri site A (kunci angka polos, kompatibel dengan versi sebelumnya), `string` berprefix (`"<prefix>:<isi>"`) untuk site B1/B2/C. Contoh: `123456`, `"b1:539224"`, `"c1:some-slug"`. Nilai ini dipakai apa adanya pada `ids`/`galleryId` di endpoint lain.
- `source`: id sumber hasil turunan dari prefix `galleryId` (`"default"` bila tanpa prefix). Tidak disimpan di DB. Daftar sumber ada di `GET /api/config` → `sources`.

### `LiveProgress`
Representasi progress unduhan aktif (`engine.currentProgress`), atau `null` jika sedang tidak mengunduh:
```json
{
  "galleryId": "123456",
  "currentTaskNum": 1,
  "totalTasks": 10,
  "batchIndex": 1,
  "totalBatches": 2,
  "title": "[Artist] Title",
  "artist": "Artist",
  "language": "English",
  "totalPages": 24,
  "downloadedPages": 12,
  "pagePercentage": 50,
  "speedBps": 1548200,
  "etaSeconds": 8,
  "status": "Downloading",
  "cooldownRemain": 0,
  "errorDetails": null
}
```

### `EngineStatus`
String status mesin pengunduh: `'IDLE'` | `'RUNNING'` | `'PAUSED'` | `'STOPPING'` | `'Download folder unavailable'`.

---

## 2. Server-Sent Events (SSE) — `GET /api/events`

Membuka stream HTTP satu arah (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`) untuk menerima pembaruan state secara real-time tanpa polling.

### 2.1. `event: snapshot` & `event: reloaded`
Dikirim **segera setelah koneksi SSE terbuka** (`snapshot`), serta dipancarkan kembali ke seluruh klien SSE aktif setelah operasi impor atau pemulihan database selesai (`snapshot` dan `reloaded`). Berisi state penuh antrian saat itu sehingga antrian dan status library di UI langsung ter-update secara instan tanpa perlu memuat ulang halaman:
```
event: snapshot
data: {"items":[...],"batchCount":1,"engineStatus":"IDLE","liveProgress":null,"autoContinueBatches":true}
```

### 2.2. `event: item`
Dikirim setiap kali ada perubahan pada tabel `queue` di basis data (`core/db.js` `dbEvents`):
- **Penambahan atau pembaruan baris (`inserted` / `updated`)**:
  ```
  event: item
  data: {"type":"inserted","item":{"id":1,"galleryId":123456,"status":"PENDING","rawStatus":"PENDING","url":"https://certain.site/g/123456/","title":null,"batch":1,"priority":0,"pagesDone":0,"pagesTotal":0,"error":null,"retries":0,"format":null,"source":"default"},"batchCount":1}
  ```
- **Penghapusan satu baris (`deleted`)**:
  ```
  event: item
  data: {"type":"deleted","galleryId":123456,"batchCount":1}
  ```
- **Penghapusan satu batch (`batch_deleted`)**:
  ```
  event: item
  data: {"type":"batch_deleted","batch":2,"batchCount":1}
  ```
- **Pembersihan item selesai (`cleared`)**:
  ```
  event: item
  data: {"type":"cleared","removedIds":[123456,234567],"batchCount":1}
  ```
- **Perubahan urutan prioritas (`reordered`)**:
  Hanya dikirim jika terdapat perubahan prioritas nyata (`items` tidak pernah berupa array kosong):
  ```
  event: item
  data: {"type":"reordered","items":[{"galleryId":123456,"priority":501},{"galleryId":234567,"priority":500}],"batchCount":1}
  ```

### 2.3. `event: progress`
Dikirim saat halaman galeri selesai diunduh atau saat hitungan mundur jeda/cooldown berubah:
```
event: progress
data: {"liveProgress":{...},"engineStatus":"RUNNING"}
```

### 2.4. `event: engine`
Dikirim saat status mesin pengunduh atau konfigurasi berubah (`paused`, `resumed`, `stopped`, `restarted`, `batch_start`, `batch_complete`, `circuit_breaker`, `config_updated`, `download_dir_unavailable`):
```
event: engine
data: {"type":"paused","engineStatus":"PAUSED","liveProgress":null,"autoContinueBatches":true}
```

### 2.5. Heartbeat
Setiap 25 detik server mengirimkan komentar SSE `: ping\n\n` agar koneksi tidak diputus oleh reverse proxy.

---

## 3. Endpoint REST API

Semua endpoint di bawah `/api/*` (kecuali `/api/queue/export` dan `/api/logs/download`) mengembalikan `Content-Type: application/json`. Jika autentikasi diaktifkan (`NHDL_PASSWORD` di `.env`) dan session cookie `nhdl_session` tidak valid, server mengembalikan `401 Unauthorized` (`{"error":"Unauthorized"}`).

### 3.1. Autentikasi

| Method | Path | Body | Response (`200 OK`) | Keterangan |
|---|---|---|---|---|
| `POST` | `/api/login` | `{"password":"..."}` | `{"success":true}` | Mengatur cookie `HttpOnly` `nhdl_session`. Mengembalikan `401` jika password salah. |
| `POST` | `/api/logout` | — | `{"success":true}` | Menghapus session dan mengosongkan cookie `nhdl_session`. |

### 3.2. Status & Antrian (`queue`)

| Method | Path | Body | Response (`200 OK`) | Keterangan |
|---|---|---|---|---|
| `GET` | `/api/status` | — | `{"items": QueueItem[], "batchCount": number, "rawList": string, "errors": string, "liveProgress": LiveProgress\|null, "engineStatus": EngineStatus, "autoContinueBatches": boolean}` | Endpoint kompatibilitas untuk membaca snapshot status penuh. |
| `POST` | `/api/queue` | `{"text": string, "replace"?: boolean, "format"?: string}` atau `text/plain` | `{"success":true, "added": number, "updated": number, "duplicates": number, "ignored": number, "galleryIds": (number\|string)[], "total": number}` | Mengimpor daftar URL/ID (`# BATCH N FORMAT=...`). Default `replace = true` pada `/api/queue`. Setiap baris boleh berupa URL galeri dari site A, B1, B2, atau C, ID polos site A, atau kunci berprefix. Baris yang tidak dikenali dilewati dan dihitung di field `ignored` pada respons. |
| `POST` | `/api/queue/import` | `{"text": string, "replace"?: boolean, "format"?: string}` atau `text/plain` | `{"success":true, "added": number, "updated": number, "duplicates": number, "ignored": number, "galleryIds": (number\|string)[], "total": number}` | Mengimpor daftar `list.txt` (upload/paste). Default `replace = false` (menambahkan/memperbarui tanpa menghapus item lain). Setiap baris boleh berupa URL galeri dari site A, B1, B2, atau C, ID polos site A, atau kunci berprefix. Baris yang tidak dikenali dilewati dan dihitung di field `ignored` pada respons. |
| `GET` | `/api/queue/export` | — | `text/plain` (`attachment; filename="list.txt"`) | Mengekspor seluruh isi tabel `queue` ke format teks `# BATCH N`. |
| `POST` | `/api/queue/pause` | `{"ids": (number\|string)[]}` | `{"success":true, "paused": number, "stopping": (number|string)[]}` | Mengubah status item `PENDING`/`ERROR`/`COOLDOWN`/`PAUSED` menjadi `STOPPED`. Untuk item `ON_PROGRESS`, engine menghentikan unduhan galeri tersebut dengan aman di batas halaman berikutnya, menyimpan progres (`pages_done`), mengubah status menjadi `STOPPED` tanpa menghapus file/halaman yang sudah terunduh, lalu melanjutkan ke item berikutnya. |
| `POST` | `/api/queue/resume` | `{"ids": (number\|string)[]}` | `{"success":true, "resumed": number}` | Mengubah status item `STOPPED` (serta `ERROR`/`COOLDOWN`/`PAUSED`) menjadi `PENDING` (`error = null`) lalu memanggil `autoProcessQueue()`. |
| `POST` | `/api/queue/delete` | `{"ids": (number\|string)[]}` | `{"success":true, "deleted": number}` | Menghapus item dari tabel `queue` saja (file di disk dan tabel `library` tidak disentuh). Item yang sedang `ON_PROGRESS` dihentikan terlebih dahulu di batas halaman berikutnya seperti pada `/api/queue/pause`. |
| `POST` | `/api/queue/priority` | `{"ids": (number\|string)[], "action": "top" \| "up" \| "down" \| "bottom"}` | `{"success":true, "updated": number}` | Mengubah urutan prioritas (`ORDER BY priority DESC, id ASC`) untuk ukuran antrian berapa pun dalam satu transaksi SQLite dan memancarkan satu event SSE `item` (`type: "reordered"`). Bila nilai `priority` bertabrakan (mis. semua `0`), antrian dinormalisasi ke `total - index` terlebih dahulu. |

### 3.3. Kontrol Engine & Retry

| Method | Path | Body | Response (`200 OK`) | Keterangan |
|---|---|---|---|---|
| `POST` | `/api/control` | `{"action": "pause" \| "resume" \| "start" \| "stop" \| "restart"}` | `{"success":true, "engineStatus": EngineStatus}` | Mengendalikan siklus mesin pengunduh (`restart` juga mengembalikan baris `ON_PROGRESS` ke `PENDING`). |
| `POST` | `/api/retry` | `{"galleryId"?: number\|string}` | `{"success":true, "message":"Force retry triggered"}` | Melewati cooldown aktif; jika `galleryId` disertakan, mengubah status item tersebut kembali ke `PENDING` dan memicu antrian. |

### 3.4. Konfigurasi (`settings` & `.env`)

| Method | Path | Body | Response (`200 OK`) | Keterangan |
|---|---|---|---|---|
| `GET` | `/api/config` | — | `{"downloadDir": string, "downloadFormat": "folder"\|"cbz"\|"zip", "autoContinueBatches": boolean, "authRequired": boolean, "apiKeyConfigured": boolean, "apiKeyMasked": string, "backupIntervalHours": number, "backupKeep": number, "lastBackupAt": string\|null, "sources": {"id": string, "label": string}[]}` | Membaca pengaturan aktif dari tabel `settings` dan status API key dari `.env`. `sources`: daftar sumber yang dikenal server (urutan tampilan UI), dipakai untuk label badge dan filter kategori. |
| `POST` | `/api/config` | Salah satu dari: `{"downloadDir": string}`, `{"downloadFormat": "folder"\|"cbz"\|"zip"}`, `{"autoContinueBatches": boolean}`, `{"apiKey": string}`, `{"backupIntervalHours": number}`, atau `{"backupKeep": number}` | `{"success":true, ...}` | Menyimpan pengaturan ke tabel `settings` (atau `NHENTAI_API_KEY` ke `.env`). |
| `POST` | `/api/config/verify-key` | `{"apiKey"?: string}` | `{"valid": boolean, "user"?: object, "rateLimit"?: object, "error"?: string}` | Memverifikasi keabsahan API key ke API v2 certain site ( ͡° ͜ʖ ͡°). |

### 3.5. Library

| Method | Path | Body | Response (`200 OK`) | Keterangan |
|---|---|---|---|---|
| `GET` | `/api/library` | — | `{"items": LibraryItem[], "total": number}` | Mengambil daftar galeri di tabel `library` yang tidak berstatus `skipped`. |
| `POST` | `/api/library/rescan` | — | `{"success":true, "scanned": number, "relocated": number, "pruned": number, "unchanged": number, "aborted"?: boolean, "reason"?: string}` | Memindai ulang folder unduhan berdasarkan file marker `.nhdl-id` dan `.cbz.nhdl-id` (dibatalkan dengan `aborted: true` jika folder tidak sehat/tidak ter-mount). |
| `POST` | `/api/library/rename` | `{"id": string\|number, "newName": string}` | `{"success":true, "oldPath": string, "newPath": string, "newTitle": string}` | Mengubah nama folder/arsip di disk, memperbarui `ComicInfo.xml`, serta memperbarui tabel `library` dan `queue`. |
| `POST` | `/api/library/compress` | `{"id": string\|number, "ext"?: "cbz"\|"zip"}` | `{"success":true, "archivePath": string, "archiveExt": string, "skipped"?: boolean}` | Mengompres folder galeri menjadi arsip `.cbz`/`.zip` (`STORE` level 0) dan menghapus folder aslinya. |
| `POST` | `/api/library/batch-compress` | `{"ids": (string\|number)[], "ext"?: "cbz"\|"zip"}` | `{"success":true, "started":true, "total": number}` | Memulai job kompresi massal di latar belakang (`409 Conflict` jika job masih berjalan). |
| `GET` | `/api/library/compress-status` | — | `{"job": CompressJob\|null}` | Membaca progres job kompresi massal yang sedang/terakhir berjalan. |

`LibraryItem` memiliki field tambahan `source` (sama seperti `QueueItem.source`).

### 3.6. Log & Penjelajah Direktori

| Method | Path | Body | Response (`200 OK`) | Keterangan |
|---|---|---|---|---|
| `GET` | `/api/logs` | — | `{"log": string}` atau `{"ts": string, "level": string, "message": string}[]` (jika query `galleryId` diberikan) | Tanpa `galleryId`: mengambil string log aktivitas dari tabel `events`. Dengan `?galleryId=<id>&limit=<n>`: mengembalikan JSON array berisi baris dari tabel `events` untuk galeri tersebut (`[{ "ts", "level", "message" }]`). |
| `GET` | `/api/logs/download` | — | `text/plain` (`attachment; filename="nhdl-activity-<ts>.log"`) | Mengunduh log aktivitas sebagai file `.log`. |
| `GET` | `/api/fs/browse?path=<dir>` | — | `{"currentPath": string, "parentPath": string\|null, "drives": string[], "directories": {"name": string, "path": string}[]}` | Menjelajahi daftar direktori lokal untuk pemilih folder unduhan di UI. |

### 3.7. Database Management (Export, Import & Backup)

| Method | Path | Body | Response (`200 OK`) | Keterangan |
|---|---|---|---|---|
| `GET` | `/api/db/info` | — | `{"type": "sqlite" \| "postgres", "connected": boolean, "path"?: string, "host"?: string, "port"?: string, "database"?: string, "detail"?: string, "maskedUrl"?: string, "backupIntervalHours": number, "backupKeep": number, "lastBackupAt": string\|null, "backupDir": string}` | Menampilkan informasi database yang sedang aktif (jenis, status koneksi, path/host, tanpa password), konfigurasi backup terjadwal, dan path folder backup aktif. |
| `GET` | `/api/db/export` | — | `application/json` (`attachment; filename="nhdl-export-<YYYY-MM-DD-HHmmss>.json"`) | Mengunduh seluruh database (`queue`, `library`, `settings`, `events`, `schema_version`) dalam format JSON independen basis data. |
| `POST` | `/api/db/import` | `{"mode": "replace" \| "merge", "data": object}` | `{"success":true, "mode": "replace" \| "merge", "imported": {"queue": number, "library": number, "settings": number, "events": number}, "preImportBackup"?: string}` | Mengimpor data JSON dalam satu transaksi. Mode `replace` membuat backup otomatis `nhdl-backup-pre-import-<ts>.json` terlebih dahulu sebelum mengosongkan tabel (bila backup gagal, import dibatalkan). Mengembalikan `409 Conflict` (`{"success":false,"error":"Pause engine first","needsPause":true}`) bila `engine.isRunning` atau ada item `ON_PROGRESS`. |
| `POST` | `/api/db/backup` | `{}` | `{"success":true, "filename": string, "size": number, "createdAt": string}` | Membuat backup instan ke folder backup aktif (`data/backups/` atau `NHDL_BACKUP_DIR`) dan memangkas retensi sesuai `backupKeep` (default 7). |
| `GET` | `/api/db/backups` | — | `{"backups": [{"filename": string, "size": number, "createdAt": string}]}` | Mengambil daftar file backup yang tersimpan di direktori backup aktif (`data/backups/` atau `NHDL_BACKUP_DIR`). |
| `POST` | `/api/db/restore` | `{"filename": string, "mode"?: "replace" \| "merge"}` | `{"success":true, "filename": string, "restored": object, "preImportBackup"?: string}` | Memulihkan (*restore*) isi database dari file backup lokal tertentu (default mode `replace`). Dalam mode `replace`, backup otomatis `nhdl-backup-pre-import-<ts>.json` dibuat terlebih dahulu sebelum restore dijalankan. Mengembalikan `409 Conflict` (`{"success":false,"error":"Pause engine first","needsPause":true}`) bila `engine.isRunning` atau ada item `ON_PROGRESS`. |
| `DELETE` | `/api/db/backups/:name` | — | `{"success":true, "deleted": string}` | Menghapus file backup tertentu di folder backup aktif. |

