# Multi-source download (provider layer) — Design

Status: disetujui di chat (2026-10-06), menunggu review spec tertulis.
Branch: `rework`.

> Aturan dokumentasi repo: nama situs asli hanya boleh ada di kode. Di dokumen ini situs ditulis generik:
> **site A** (default, sudah ada), **site B1/B2** (dua domain, platform sama, ID angka), **site C** (ID berupa slug, punya API JSON).
> Domain dan prefix asli didefinisikan sebagai konstanta di `core/providers/*.js`.

## 1. Tujuan

Pengguna menempelkan URL dari site B1, B2, atau C ke antrean. Galeri didownload dan masuk library seperti galeri site A.

Success criteria:
- URL dari B1, B2, dan C diterima oleh `POST /api/queue`, didownload, dan masuk library.
- Format keluaran (`folder`/`cbz`/`zip`), batch, pause/resume/retry, dan SSE tidak berubah.
- Data lama (antrean, library, marker `.nhdl-id`, export) tetap valid tanpa penulisan ulang.
- Tes lokal (SQLite) lolos, dan tes langsung dengan tiga URL contoh menghasilkan jumlah halaman yang sama dengan yang diumumkan situs.

Di luar lingkup: pencarian, login, situs lain, filter otomatis halaman non-komik.

## 2. Temuan riset (sampel diunduh manual, tanpa kode nhdl)

| Situs | URL galeri | Daftar gambar | Pola gambar |
|---|---|---|---|
| B1 | `/g/<id>/` | Input hidden di HTML: `load_server`, `load_dir`, `load_id`, `load_pages`, `gallery_id` | `https://i{server}.<cdn-b1>/{dir}/{id}/{n}.{ext}` |
| B2 | `/gallery/<id>/` | Struktur HTML sama dengan B1 | `https://m{server}.<domain-b2>/{dir}/{id}/{n}.{ext}` |
| C | `/<lang>/comic/<slug>` | `GET /api/comics/<slug>/images` → `images[]` berisi `page`, `source_url` | `https://<cdn-c>/.../images/<comic_id>/<n>.webp` |

Fakta yang memengaruhi desain:
- Ekstensi gambar campur per halaman di B1 (webp dan jpg). Halaman 404 pada ekstensi salah mengembalikan HTML kecil (162 byte), jadi harus dicek kode status dan signature.
- Semua gambar hanya butuh header `Referer` situsnya. Tidak ada login atau tantangan Cloudflare yang terlihat.
- Jumlah halaman yang diumumkan bisa tidak sama dengan isi nyata: B1 halaman terakhir (240) berukuran 1280×173 (kemungkinan banner); C mengembalikan 17 gambar untuk "16 halaman" dengan gambar ke-17 berformat JPEG. Perilaku awal: **download semua yang diumumkan, tanpa membuang apa pun**.
- Dari jaringan yang DNS-nya memblokir domain ini, akses harus lewat DNS/VPN yang tidak terblokir. Kode tidak boleh mengakali blokir DNS.

## 3. Arsitektur

### 3.1 Antarmuka provider (`core/providers/`)

```
match(input)              -> { key, provider } | null     // input: URL atau ID mentah
fetchGallery(key, ctx)    -> { title, author, lang, tags, numFavorites, uploadDate,
                               pages: [{ n, urls: [candidateUrl, ...] }] }
headers()                 -> { Referer, 'User-Agent' }
```

- `index.js`: daftar provider dan fungsi `resolve(input)`. ID polos (angka) tanpa prefix diarahkan ke provider default.
- `default.js` (site A): membungkus kode yang sudah ada (`nhentaiApi.js`, `fetchMetadata`, CDN pinned) tanpa mengubah perilakunya.
- `boards.js` (B1 dan B2): satu implementasi, dua konfigurasi domain. Parse input hidden dari HTML. Untuk tiap halaman, `urls` berisi kandidat `webp, jpg, png, gif`.
- `slugapi.js` (C): panggil API JSON, urutkan `images` menurut `page`, `urls` berisi satu `source_url` per halaman.

### 3.2 Perubahan di engine
`processGallery` memanggil `providers.resolve(key)` lalu memakai `fetchGallery` dan `headers()` dari provider tersebut. Yang tidak berubah: cek library, retry 429, circuit breaker, placeholder PNG, verifikasi gambar, kompres CBZ, event SSE. Untuk site A, jalur API-archive (`tryApiArchiveDownload`) tetap khusus provider default.

Download per halaman: coba kandidat `urls` berurutan sampai ada yang berstatus 200 dan lolos `verifyImage`; ekstensi yang menang disimpan di `pageExts`.

## 4. Kunci ID

`gallery_id` menjadi **TEXT**.

| Sumber | Bentuk kunci | Contoh (generik) |
|---|---|---|
| Site A (default) | angka polos, tanpa prefix | `468614` |
| Site B1 | `<prefix-b1>:<id>` | `b1:539224` |
| Site B2 | `<prefix-b2>:<id>` | `b2:817456` |
| Site C | `<prefix-c>:<slug>` | `c1:some-slug` |

- ID lama tanpa prefix berarti site A, jadi marker `.nhdl-id`, library, dan antrean lama tidak perlu ditulis ulang.
- Nilai prefix saat ini diusulkan `xxx`, `rox`, `com` (konstanta di kode, mudah diganti).
- `normalizeGalleryId` dan `isValidGalleryId` (`core/db/common.js`) menerima angka polos atau `prefix:isi` dan mengembalikan string kanonik. Angka polos tetap divalidasi sebagai bilangan bulat positif.
- Semua tempat yang membandingkan atau menyaring `Number(gallery_id)` / `parseInt(id)` diganti perbandingan string: `core/db/sqlite.js` dan `core/db/postgres.js` (reorder prioritas, import replace, bulk pause/resume/delete, `logEvent`), `core/engine.js` (flag stop/hapus galeri), `core/tracker.js` (baca marker di `rescanLibrary`), `server/index.js` (`activeGalleryId`), dan `webui` (`rankById`, parser URL).
- Respons API memakai `toPublicId`: `galleryId` bertipe number untuk kunci angka polos (site A, kompatibel dengan klien lama) dan string untuk kunci berprefix. Baris mentah dari DB mengikuti aturan yang sama.
- Nama folder tidak pernah memakai kunci mentah (karakter `:` tidak valid di Windows); fallback memakai `safeKeyName`.
- Marker `.nhdl-id` dan `<archive>.nhdl-id` menyimpan string kunci apa adanya. `rescanLibrary` berhenti memakai `parseInt` untuk membaca isinya.
- Nama file/folder keluaran tidak memuat kunci mentah, jadi tidak ada karakter `:` yang masuk ke path (Windows).

## 5. Migrasi skema (v3, kedua adapter)

`CURRENT_APP_SCHEMA_VERSION` naik dari 2 ke 3.

- **PostgreSQL** (`core/db/postgres.js`): `ALTER TABLE queue ALTER COLUMN gallery_id TYPE TEXT USING gallery_id::text` dan hal yang sama untuk `library`, dalam satu transaksi migrasi.
- **SQLite** (`core/db/sqlite.js`): tipe kolom PK tidak bisa diubah, jadi bangun ulang tabel `queue` dan `library` (buat tabel baru, salin dengan `CAST(gallery_id AS TEXT)`, hapus lama, ganti nama, buat ulang indeks) dalam satu transaksi.
- Tabel `events` ikut dimigrasi di PostgreSQL (`gallery_id` BIGINT → TEXT). Di SQLite kolom `events.gallery_id` tetap berafinitas INTEGER karena SQLite menyimpan teks non-numerik (kunci berprefix) apa adanya.
- Driver `pg` mempertahankan parser tipe 20 (int8) → number untuk kolom BIGINT lain; kolom `gallery_id` yang kini TEXT dikembalikan sebagai string lalu dipetakan lewat `toPublicId`.
- Export/import: format tetap `nhdl-export` v1; payload lama (ID angka) lolos validasi, payload baru boleh memuat ID berprefix.
- Rollback: backup database (`data/nhdl.db` atau dump Postgres) sebelum migrasi. Migrasi satu arah, tidak ada downgrade otomatis.

## 6. API (didokumentasikan di `docs/API.md` sebelum implementasi)

Tidak ada endpoint baru. Perubahan kontrak:
- `POST /api/queue`: baris `text` menerima URL dari site B1, B2, C, dan ID berprefix. Baris tak dikenal ditolak dengan pesan jelas (bukan diam-diam dilewati).
- `POST /api/retry` dan `GET` yang menerima `galleryId`: nilai berupa string, boleh berprefix.
- Payload event SSE `item`/`progress` dan respons `/api/status`, `/api/library`: `galleryId` bertipe number untuk site A dan string untuk kunci berprefix (sesuai bagian 4), dan setiap item punya field turunan `source` (lihat 6b).
- `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/CHANGELOG.md` (aktor `AI (Claude Code, Sonnet 5.5)`), dan `docs/PLAN.md` diperbarui; nama situs asli tidak ditulis di dokumen.

## 6b. Kategori sumber di list (UI)

Tujuan: di antrean dan library terlihat jelas tiap item berasal dari situs mana.

- **Field turunan `source`** pada respons `/api/status`, `/api/library`, dan payload SSE `item`: nilai id provider (`default`, `b1`, `b2`, `c1`), dihitung dari prefix `gallery_id` lewat `providers.resolve()`. Tidak disimpan di DB, jadi tidak ada kolom atau migrasi tambahan, dan ID lama otomatis jadi `default`.
- **Label tampilan** (nama situs untuk pengguna) berasal dari metadata provider (`label`), dikirim bersama daftar sumber lewat respons yang sudah ada (mis. `/api/config`), supaya UI tidak menulis nama situs sendiri.
- **Antrean**: badge sumber di setiap baris, plus filter kategori (chip: `Semua` + satu chip per sumber yang ada, lengkap dengan jumlah item) yang digabung dengan filter status dan pencarian yang sudah ada. Pengelompokan per batch tidak berubah.
- **Library**: badge dan filter sumber yang sama di modal Library Manager.
- Filter berjalan di sisi klien dari data SSE yang sudah masuk (tanpa polling baru), sesuai aturan repo.
- Tes: unit untuk pemetaan prefix → `source`/`label`, dan tes SSE/API yang memastikan `source` ada di payload; tampilan UI diverifikasi manual di dev server lokal.

## 7. Penanganan error

| Kasus | Perilaku |
|---|---|
| URL/ID tak dikenali | Baris ditolak saat `POST /api/queue`, dicatat di event log |
| Galeri tak ada (404 / API kosong) | `SKIPPED - <alasan>` seperti sekarang |
| Semua kandidat ekstensi gagal untuk satu halaman | Retry sesuai aturan yang ada, lalu placeholder PNG + `placeholder_pages.log` |
| Respons HTML berupa halaman blokir DNS/ISP atau tantangan | Error jelas (`ERROR - blocked or unexpected HTML`), tidak dianggap gambar |
| 429 / rate limit | Alur backoff dan circuit breaker yang ada |

## 8. Pengujian

1. **Unit** (`node:test`): `match()` tiap provider; parser input hidden dengan fixture HTML hasil unduhan manual (tanpa konten eksplisit, hanya potongan tag yang relevan); parser JSON C; `normalizeGalleryId`/`isValidGalleryId` untuk angka polos dan berprefix.
2. **Migrasi**: DB v2 berisi ID angka dimigrasi ke v3 tanpa data hilang di SQLite dan PostgreSQL; ID angka tetap bisa dicari dan di-retry; export lalu import tetap konsisten.
3. **E2E lokal**: server dengan SQLite, `POST /api/queue` memuat tiga URL contoh, menunggu `done`, lalu bandingkan jumlah dan keutuhan file dengan `samples/probe/out/` (jumlah halaman sama, tanpa file di bawah 2 KB yang bukan placeholder).
4. `npm test` harus hijau sebelum commit.

## 9. Keputusan terbuka (default yang diasumsikan)

- Nilai prefix `xxx` / `rox` / `com`: diasumsikan; bisa diganti lewat konstanta tanpa memengaruhi desain.
- Halaman non-komik (banner, gambar ekstra): tidak difilter. Opsi filter berdasarkan rasio/ukuran bisa menjadi fitur lanjutan.
