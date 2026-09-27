# NHDL — aturan untuk semua AI agent (Claude Code, Antigravity/Gemini, dll.)

## Dokumentasi & pencatatan
- Rencana rework dan status task ada di `docs/PLAN.md`. Perbarui checklist (`[ ]`/`[~]`/`[x]`) dan tabel Log setiap menyelesaikan task.
- Catat setiap perubahan di `docs/CHANGELOG.md` (entri terbaru di atas, aktor `AI (<agent/model>)`, mis. `AI (Antigravity, Gemini 3.8 Flash High)`).
- Kalau menemukan perubahan manual dari user yang belum tercatat (lihat `git log`), tambahkan entri dengan aktor `Manual (<nama>)`.
- Di dokumentasi, sebut situs targetnya "certain site ( ͡° ͜ʖ ͡°)" dan domain contohnya `certain.site`. Nama asli hanya boleh ada di kode.

## Git
- Commit dan push **wajib atas nama user** (identitas dari `git config user.name` / `user.email`). Jangan ubah identitas git, jangan pakai author lain, dan jangan tambahkan trailer `Co-Authored-By` atau atribusi AI apa pun di pesan commit maupun deskripsi PR.
- Pekerjaan rework (Fase 1 dst.) dilakukan di branch `rework`. `main` hanya menerima perubahan yang sudah stabil.
- Jalankan `npm test` sebelum commit (setelah test tersedia di Fase 1). Jangan commit kalau test gagal.

## Arsitektur
- Tidak ada CLI; satu-satunya entry point adalah `server/index.js`.
- Semua state (antrian, library, config, log) ada di SQLite (`data/nhdl.db`) lewat `core/db.js`. Jangan menyimpan state di file teks/JSON baru. Pengecualian: secret tetap di `.env`.
- Pola untuk setiap fitur baru (mis. Pause/Resume per item):
  1. State disimpan di tabel DB (kolom/tabel baru lewat migrasi skema di `core/db.js`).
  2. Perubahan dilakukan lewat endpoint REST yang tercatat di `docs/API.md`.
  3. UI menerima perubahan lewat event SSE (`/api/events`), **bukan** polling.
- Setiap endpoint atau event baru wajib ditambahkan ke `docs/API.md` dulu, baru diimplementasikan.
