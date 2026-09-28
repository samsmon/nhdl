# Setup PostgreSQL untuk NHDL

Panduan ini menjelaskan cara menyiapkan database PostgreSQL terpusat (shared Postgres) untuk NHDL dengan prinsip hak akses minimal (*least privilege*).

---

## 1. Pembuatan User & Database di PostgreSQL

Jalankan perintah SQL berikut sebagai user `postgres` (superuser):

```sql
-- 1. Buat user khusus aplikasi NHDL
CREATE USER nhdl WITH PASSWORD 'ganti_dengan_password_aman';

-- 2. Buat database khusus dengan pemilik user nhdl
CREATE DATABASE nhdl OWNER nhdl;

-- 3. Berikan hak akses penuh atas database nhdl
GRANT ALL PRIVILEGES ON DATABASE nhdl TO nhdl;
```

### Khusus PostgreSQL 15 ke Atas
Mulai PostgreSQL 15, hak pembuatan objek di schema `public` dicabut secara default dari user non-pemilik. Jalankan perintah ini setelah terhubung ke database `nhdl`:

```sql
\c nhdl

-- Berikan hak pada schema public ke user nhdl
GRANT ALL ON SCHEMA public TO nhdl;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO nhdl;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO nhdl;
```

> [!TIP]
> Jangan pernah mencampur tabel NHDL ke dalam database aplikasi lain. Selalu gunakan database khusus `nhdl` agar proses backup, restore, dan migrasi terisolasi dengan aman.

---

## 2. Konfigurasi Environment (`.env` / Docker)

Atur variabel lingkungan `DATABASE_URL` di file `.env` atau konfigurasi container NHDL:

```env
DATABASE_URL=postgres://nhdl:ganti_dengan_password_aman@postgres-host:5432/nhdl
```

Jika `DATABASE_URL` tidak diisi atau kosong, NHDL secara otomatis akan kembali menggunakan SQLite lokal (`data/nhdl.db`).

---

## 3. Perilaku Koneksi & Startup

- **Connection Pool**: NHDL menggunakan `pg.Pool` dengan kapasitas maksimal 10 koneksi bersama (*pooled connections*).
- **Startup Retry**: Jika container NHDL menyala bersamaan dengan container PostgreSQL dan database belum siap menerima koneksi, NHDL akan mencoba ulang (*retry*) setiap 2 detik hingga batas waktu 60 detik sebelum memberikan pesan kegagalan.
- **Keamanan Kredensial**:
  - `DATABASE_URL` yang tercatat di log startup akan disamarkan (`postgres://nhdl:***@host:5432/nhdl`).
  - Nilai password tidak pernah disimpan di tabel `settings` dan tidak pernah dikirimkan ke Web UI maupun endpoint API.
- **Migrasi Otomatis**: Tabel `queue`, `library`, `settings`, `events`, dan `schema_version` serta indeks terkait akan otomatis dibuat saat pertama kali aplikasi tersambung ke PostgreSQL.
