# Content type (Comic / Manga) — Design

Status: desain disetujui di chat (2026-10-06), menunggu review spec tertulis.
Branch: `rework`. Melanjutkan [multi-source download](2026-10-06-multi-source-download-design.md).

> Aturan dokumentasi repo: situs ditulis generik — **site A** (default, tidak berubah), **site B1/B2** (ID angka, kategori dibaca dari halaman), **site C** (ID slug, kategori dari API). Nama asli, domain, dan prefix asli hanya ada di kode.

## 1. Tujuan

Galeri dari site B1, B2, dan C punya **kategori** di situsnya. NHDL memetakannya ke tipe konten `comic` / `manga` / `other`, lalu:
- menyimpan hasil download di folder per tipe (`Download/<Tipe>/<Bahasa>/<Author>/<Judul>`), dan
- menampilkan tipe di UI (badge, filter sidebar, Library Manager).

Success criteria:
- Galeri baru dari site B1/B2/C masuk ke folder tipe yang benar; galeri `western`/komik barat masuk `Comic`, `manga` dan `doujinshi` masuk `Manga`.
- Antrean dan library memperlihatkan tipe per item dan bisa difilter per tipe.
- Data lama (antrean, library, marker `.nhdl-id`, file yang sudah terunduh) tetap valid; tidak ada file yang dipindah otomatis.
- Site A tidak berubah sama sekali (tanpa tipe, folder lama).

Di luar lingkup: memindahkan library yang sudah ada ke struktur baru, tipe untuk site A, kategori selain pemetaan di bawah sebagai tipe sendiri.

## 2. Temuan data (dicek langsung ke situs)

| Situs | Sumber kategori | Contoh |
|---|---|---|
| Site B1 | halaman galeri memuat tautan kategori bergaya `href='/category/<slug>/'` | `manga` |
| Site B2 | sama seperti B1 | `western`, `doujinshi` |
| Site C | endpoint detail `GET /api/comics/<slug>` mengembalikan `category: { name, slug }`; endpoint `/images` yang dipakai sekarang tidak memuatnya | `porn-comic`, `manga` |

Daftar kategori yang terlihat: doujinshi, manga, non-h, western, imageset, artistcg, misc, dan satu kategori komik khusus site C. Doujinshi adalah kategori terbesar di site C.

## 3. Model tipe

`ContentType = 'comic' | 'manga' | 'other'`. Label UI dan nama folder: `Comic`, `Manga`, `Other`.

Pemetaan slug kategori (huruf kecil) → tipe, satu fungsi `mapCategoryToType(slug)` di `core/providers/contentType.js`:

| Slug | Tipe |
|---|---|
| `western`, `porn-comic`, `comic` | `comic` |
| `manga`, `doujinshi` | `manga` |
| slug lain yang tidak kosong (non-h, imageset, artistcg, misc, dst.) | `other` |
| kosong / tidak ditemukan | `null` (tanpa tipe) |

Provider mengisi `meta.category` (slug mentah) dan `meta.contentType` (hasil pemetaan). Site A tidak mengisi keduanya.

## 4. Pengambilan kategori

- **Site B1/B2 (`boards.js`)**: baca slug kategori dari tautan `href='/category/<slug>/'` pada halaman galeri (pola kutip tunggal yang sama dengan taksonomi lain). Bila ada beberapa, ambil yang pertama bukan duplikat; bila tidak ada → `null`.
- **Site C (`slugapi.js`)**: setelah `/images` berhasil, ambil `GET /api/comics/<slug>` dan baca `category.slug`. Request ini memakai transport yang sama (curl). **Kegagalan request kategori tidak boleh menggagalkan download**: catat peringatan di activity log dan lanjut dengan `null`.
- Validasi: slug kategori dari remote hanya diterima bila cocok `^[a-z0-9][a-z0-9-]{0,40}$`; selain itu dianggap `null` (tidak pernah dipakai mentah sebagai nama folder — folder memakai label tipe tetap).

## 5. Penyimpanan folder

Di `core/engine.js` `processGallery`, untuk provider non-default dengan `contentType` tidak `null`:

`parentDir = <base>/<TypeLabel>/<Language>/<Author>` (sebelumnya `<base>/<Language>/<Author>`). Bila `contentType` `null`, atau provider default, layout lama dipakai.

Dampak yang sudah dicek:
- `deriveLineageFromPath` (artist = parent, language = grandparent) tetap benar karena level tipe berada di atas bahasa.
- `rescanLibrary` memakai `MAX_DEPTH = 6` dan marker; kedalaman baru (`base/Tipe/Bahasa/Author/Judul` = 4) masih di dalam batas.
- `findExistingOnDisk` (fallback saat 429) saat ini menelusuri dua level (`Bahasa/Author`); diperluas agar juga menelusuri `Tipe/Bahasa/Author`.
- Galeri yang sebagian sudah terunduh di layout lama akan mulai ulang di layout baru (halaman diunduh ulang); ini diterima dan dicatat di dokumentasi.

## 6. Database (migrasi v4, kedua adapter)

- `ALTER TABLE queue ADD COLUMN category TEXT` (nullable) — menyimpan `contentType` hasil pemetaan (`comic`/`manga`/`other`), bukan slug mentah.
- SQLite: tambah kolom hanya bila belum ada (cek `PRAGMA table_info`); PostgreSQL: `ADD COLUMN IF NOT EXISTS`. Idempoten; `CURRENT_APP_SCHEMA_VERSION` naik ke 4; export/import tetap kompatibel (kolom baru opsional).
- `library`: `contentType` dan `category` disimpan di JSON `meta` yang sudah ada (tanpa kolom baru).
- Fungsi `updateQueueItem` menerima field `category`; `formatQueueRow` mengeluarkan `category` (string atau `null`). Event SSE `item` otomatis membawanya karena memakai `formatQueueRow`.

## 7. API (didokumentasikan di `docs/API.md` sebelum implementasi)

- `QueueItem.category`: `"comic" | "manga" | "other" | null`. `null` untuk site A dan untuk item yang metadatanya belum diambil.
- `LibraryItem.category`: nilai yang sama, dari `meta`.
- Tidak ada endpoint baru.

## 8. UI

- Badge tipe (`Comic` / `Manga` / `Other`) di baris list, di samping badge sumber; item tanpa tipe tidak punya badge.
- Sidebar: bagian **"Type"** berisi chip filter `Comic`/`Manga`/`Other` dengan hitungan, tampil bila ≥ 2 tipe hadir (pola yang sama dengan bagian "Source"). Filter tipe digabung (AND) dengan filter status, sumber, batch, dan pencarian.
- Library Manager: badge tipe dan dropdown filter tipe di samping filter sumber.
- Helper murni di `webui/src/lib/sources.js` (atau `contentType.js` di webui) dengan tes `node:test`.
- Item yang masih menunggu belum punya tipe sampai metadatanya diambil saat gilirannya tiba (batasan yang diterima).

## 9. Penanganan error

| Kasus | Perilaku |
|---|---|
| Kategori tidak ditemukan / tidak valid | `contentType = null`, layout folder lama, tidak ada error |
| Request kategori site C gagal | peringatan di activity log, `contentType = null`, download tetap lanjut |
| Slug kategori tidak dikenal | tipe `other` |

## 10. Pengujian

1. `mapCategoryToType`: tabel pemetaan lengkap, huruf besar, slug kosong, slug tidak valid.
2. Parser kategori boards (fixture HTML) dan site C (fixture JSON; kegagalan request kategori tidak menggagalkan `fetchMeta`).
3. Engine: galeri uji dengan kategori `manga` dan `western` masuk ke `Manga/...` dan `Comic/...`; tanpa kategori memakai layout lama; site A tidak berubah; `findExistingOnDisk` menemukan di layout dengan tipe.
4. Migrasi v4: DB v3 berisi data → v4 tanpa kehilangan baris, idempoten, kolom `category` nullable; `formatQueueRow` mengeluarkan `category`.
5. `rescanLibrary` mengenali marker di `Tipe/Bahasa/Author/Judul`.
6. Helper UI + build web UI; `npm test` hijau.

## 11. Keputusan yang diambil

- Doujinshi dipetakan ke `manga` (keputusan user).
- Site A tetap tanpa tipe dan folder lama (usulan, tidak ditolak user).
- Library yang sudah ada tidak dipindah otomatis.
