# PostgreSQL setup for NHDL

This guide explains how to prepare a central (shared) PostgreSQL database for NHDL following the *least privilege* principle.

---

## 1. Creating the user & database in PostgreSQL

Run the following SQL as the `postgres` user (superuser):

```sql
-- 1. Create a dedicated user for the NHDL app
CREATE USER nhdl WITH PASSWORD 'ganti_dengan_password_aman';

-- 2. Create a dedicated database owned by the nhdl user
CREATE DATABASE nhdl OWNER nhdl;

-- 3. Grant full privileges on the nhdl database
GRANT ALL PRIVILEGES ON DATABASE nhdl TO nhdl;
```

### PostgreSQL 15 and later
Starting with PostgreSQL 15, the privilege to create objects in the `public` schema is revoked by default from non-owner users. Run this after connecting to the `nhdl` database:

```sql
\c nhdl

-- Grant privileges on the public schema to the nhdl user
GRANT ALL ON SCHEMA public TO nhdl;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO nhdl;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO nhdl;
```

> [!TIP]
> Never mix NHDL tables into another application's database. Always use the dedicated `nhdl` database so backup, restore, and migration stay safely isolated.

---

## 2. Environment configuration (`.env` / Docker)

Set the `DATABASE_URL` environment variable in the `.env` file or the NHDL container configuration:

```env
DATABASE_URL=postgres://nhdl:ganti_dengan_password_aman@postgres-host:5432/nhdl
```

If `DATABASE_URL` is unset or empty, NHDL automatically falls back to the local SQLite database (`data/nhdl.db`).

---

## 3. Connection & startup behavior

- **Connection Pool**: NHDL uses `pg.Pool` with a maximum of 10 shared (*pooled*) connections.
- **Startup Retry**: If the NHDL container starts at the same time as the PostgreSQL container and the database is not yet ready to accept connections, NHDL retries every 2 seconds for up to 60 seconds before reporting a failure.
- **Credential safety**:
  - The `DATABASE_URL` written to the startup log is masked (`postgres://nhdl:***@host:5432/nhdl`).
  - The password value is never stored in the `settings` table and never sent to the Web UI or API endpoints.
- **Automatic migration**: The `queue`, `library`, `settings`, `events`, and `schema_version` tables and their indexes are created automatically the first time the app connects to PostgreSQL.
