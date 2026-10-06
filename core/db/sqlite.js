const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { dbEvents } = require('./events');
const { urlForKey, normalizeGalleryId, toPublicId, publicRow, formatQueueRow, validateImportPayload, CURRENT_APP_SCHEMA_VERSION } = require('./common');
const { parseListText, parseListTextDetailed } = require('./listParser');
const { canonicalKey } = require('../providers');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_DB_PATH = process.env.NHDL_DB_PATH || path.join(ROOT_DIR, 'data', 'nhdl.db');

let activeDb = null;
let activeDbPath = null;

const MIGRATIONS = [
    {
        version: 1,
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS queue (
                  id           INTEGER PRIMARY KEY,
                  gallery_id   INTEGER NOT NULL UNIQUE,
                  url          TEXT    NOT NULL,
                  title        TEXT,
                  status       TEXT    NOT NULL DEFAULT 'PENDING',
                  batch        INTEGER NOT NULL DEFAULT 1,
                  priority     INTEGER NOT NULL DEFAULT 0,
                  pages_done   INTEGER NOT NULL DEFAULT 0,
                  pages_total  INTEGER NOT NULL DEFAULT 0,
                  error        TEXT,
                  retries      INTEGER NOT NULL DEFAULT 0,
                  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
                CREATE INDEX IF NOT EXISTS idx_queue_batch  ON queue(batch);

                CREATE TABLE IF NOT EXISTS library (
                  gallery_id   INTEGER PRIMARY KEY,
                  title        TEXT NOT NULL,
                  path         TEXT NOT NULL,
                  pages        INTEGER,
                  format       TEXT,
                  language     TEXT,
                  artist       TEXT,
                  added_at     TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS settings (
                  key   TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS events (
                  id          INTEGER PRIMARY KEY,
                  ts          TEXT NOT NULL DEFAULT (datetime('now')),
                  level       TEXT NOT NULL,
                  gallery_id  INTEGER,
                  message     TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_events_gallery ON events(gallery_id);

                CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
            `);
        }
    },
    {
        version: 2,
        up(db) {
            const queueCols = db.prepare(`PRAGMA table_info(queue)`).all().map(c => c.name);
            if (!queueCols.includes('format')) {
                db.exec(`ALTER TABLE queue ADD COLUMN format TEXT`);
            }
            const libCols = db.prepare(`PRAGMA table_info(library)`).all().map(c => c.name);
            if (!libCols.includes('meta')) {
                db.exec(`ALTER TABLE library ADD COLUMN meta TEXT`);
            }
        }
    }
    // NOTE: gallery_id must always be bound as the canonical string from normalizeGalleryId;
    // node:sqlite binds JS numbers as REAL, which would store '202.0' in a TEXT column.
    ,{
        version: 3,
        up(db) {
            const queueType = db.prepare(`PRAGMA table_info(queue)`).all().find(c => c.name === 'gallery_id');
            if (queueType && String(queueType.type).toUpperCase() !== 'TEXT') {
                db.exec(`
                    ALTER TABLE queue RENAME TO queue_v2;
                    DROP INDEX IF EXISTS idx_queue_status;
                    DROP INDEX IF EXISTS idx_queue_batch;
                    CREATE TABLE queue (
                      id           INTEGER PRIMARY KEY,
                      gallery_id   TEXT    NOT NULL UNIQUE,
                      url          TEXT    NOT NULL,
                      title        TEXT,
                      status       TEXT    NOT NULL DEFAULT 'PENDING',
                      batch        INTEGER NOT NULL DEFAULT 1,
                      priority     INTEGER NOT NULL DEFAULT 0,
                      pages_done   INTEGER NOT NULL DEFAULT 0,
                      pages_total  INTEGER NOT NULL DEFAULT 0,
                      error        TEXT,
                      retries      INTEGER NOT NULL DEFAULT 0,
                      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                      format       TEXT
                    );
                    INSERT INTO queue (id, gallery_id, url, title, status, batch, priority, pages_done, pages_total, error, retries, created_at, updated_at, format)
                      SELECT id, CAST(gallery_id AS TEXT), url, title, status, batch, priority, pages_done, pages_total, error, retries, created_at, updated_at, format
                      FROM queue_v2;
                    DROP TABLE queue_v2;
                    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
                    CREATE INDEX IF NOT EXISTS idx_queue_batch  ON queue(batch);
                `);
            }

            const libType = db.prepare(`PRAGMA table_info(library)`).all().find(c => c.name === 'gallery_id');
            if (libType && String(libType.type).toUpperCase() !== 'TEXT') {
                db.exec(`
                    ALTER TABLE library RENAME TO library_v2;
                    CREATE TABLE library (
                      gallery_id   TEXT PRIMARY KEY,
                      title        TEXT NOT NULL,
                      path         TEXT NOT NULL,
                      pages        INTEGER,
                      format       TEXT,
                      language     TEXT,
                      artist       TEXT,
                      added_at     TEXT NOT NULL DEFAULT (datetime('now')),
                      meta         TEXT
                    );
                    INSERT INTO library (gallery_id, title, path, pages, format, language, artist, added_at, meta)
                      SELECT CAST(gallery_id AS TEXT), title, path, pages, format, language, artist, added_at, meta
                      FROM library_v2;
                    DROP TABLE library_v2;
                `);
            }
            // events.gallery_id keeps INTEGER affinity on purpose: SQLite stores non-numeric
            // text (prefixed keys) as TEXT in such a column, and numeric keys stay INTEGER.
        }
    }
];

async function getSchemaVersion(db = null) {
    const active = db || await getDb();
    const tableExists = active.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`
    ).get();
    if (!tableExists) return 0;
    const row = active.prepare(`SELECT MAX(version) AS v FROM schema_version`).get();
    return row && typeof row.v === 'number' ? row.v : 0;
}

async function runMigrations(db = null) {
    const active = db || await getDb();
    active.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`);
    let currentVersion = await getSchemaVersion(active);

    for (const migration of MIGRATIONS) {
        if (migration.version > currentVersion) {
            active.exec('BEGIN');
            try {
                migration.up(active);
                active.prepare(`DELETE FROM schema_version`).run();
                active.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(migration.version);
                active.exec('COMMIT');
                currentVersion = migration.version;
            } catch (err) {
                active.exec('ROLLBACK');
                throw err;
            }
        }
    }
    return currentVersion;
}

async function initDb(dbPath = DEFAULT_DB_PATH, options = {}) {
    if (activeDb && activeDbPath === dbPath && options.legacyConfigPath === undefined) {
        return activeDb;
    }
    if (activeDb) {
        try { activeDb.close(); } catch (e) {}
        activeDb = null;
    }

    if (dbPath !== ':memory:') {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=WAL;`);
    db.exec(`PRAGMA foreign_keys=ON;`);
    await runMigrations(db);

    const legacyConfigPath = options.legacyConfigPath !== undefined
        ? options.legacyConfigPath
        : (process.env.NHDL_LEGACY_CONFIG !== undefined
            ? process.env.NHDL_LEGACY_CONFIG
            : path.join(ROOT_DIR, 'config.json'));
    if (legacyConfigPath) {
        await migrateLegacyConfigJson(legacyConfigPath, db);
    }

    activeDb = db;
    activeDbPath = dbPath;
    return db;
}

async function getDb() {
    if (!activeDb) {
        return await initDb(DEFAULT_DB_PATH);
    }
    return activeDb;
}

async function closeDb() {
    if (activeDb) {
        try { activeDb.close(); } catch (e) {}
        activeDb = null;
        activeDbPath = null;
    }
}

function getDbInfo() {
    return {
        type: 'sqlite',
        connected: !!activeDb,
        path: activeDbPath || DEFAULT_DB_PATH
    };
}

async function resetStuckQueueItems(db = null) {
    const active = db || await getDb();
    const stuckRows = active.prepare(`SELECT gallery_id FROM queue WHERE status = 'ON_PROGRESS'`).all();
    const stmt = active.prepare(`
        UPDATE queue
        SET status = 'PENDING', updated_at = datetime('now')
        WHERE status = 'ON_PROGRESS'
    `);
    const res = stmt.run();
    if (res.changes > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        for (const r of stuckRows) {
            const updated = await getQueueItem(r.gallery_id, active);
            if (updated) {
                dbEvents.emit('item', {
                    type: 'updated',
                    item: formatQueueRow(updated),
                    rawRow: updated,
                    batchCount
                });
            }
        }
    }
    return Number(res.changes || 0);
}

async function requeueFailedItems(options = {}, db = null) {
    const active = db || await getDb();
    const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 5;
    const targetRows = active.prepare(`
        SELECT gallery_id FROM queue
        WHERE status IN ('ERROR', 'COOLDOWN', 'PAUSED')
          AND COALESCE(retries, 0) < ?
    `).all(maxRetries);

    const stmt = active.prepare(`
        UPDATE queue
        SET status = 'PENDING', error = NULL, updated_at = datetime('now')
        WHERE status IN ('ERROR', 'COOLDOWN', 'PAUSED')
          AND COALESCE(retries, 0) < ?
    `);
    const res = stmt.run(maxRetries);
    if (res.changes > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        for (const r of targetRows) {
            const updated = await getQueueItem(r.gallery_id, active);
            if (updated) {
                dbEvents.emit('item', {
                    type: 'updated',
                    item: formatQueueRow(updated),
                    rawRow: updated,
                    batchCount
                });
            }
        }
    }
    return Number(res.changes || 0);
}

async function enqueueGallery(item, db = null) {
    const active = db || await getDb();
    const galleryId = normalizeGalleryId(item.galleryId ?? item.gallery_id);
    const url = item.url || urlForKey(galleryId);
    const title = item.title ?? null;
    const status = item.status || 'PENDING';
    const batch = Number.isFinite(item.batch) ? item.batch : 1;
    const priority = Number.isFinite(item.priority) ? item.priority : 0;
    const pagesDone = Number.isFinite(item.pagesDone ?? item.pages_done) ? (item.pagesDone ?? item.pages_done) : 0;
    const pagesTotal = Number.isFinite(item.pagesTotal ?? item.pages_total) ? (item.pagesTotal ?? item.pages_total) : 0;
    const error = item.error ?? null;
    const retries = Number.isFinite(item.retries) ? item.retries : 0;
    const format = item.format ?? null;

    const stmt = active.prepare(`
        INSERT INTO queue (
            gallery_id, url, title, status, batch, priority,
            pages_done, pages_total, error, retries, format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        galleryId, url, title, status, batch, priority,
        pagesDone, pagesTotal, error, retries, format
    );
    const row = await getQueueItem(galleryId, active);
    const batchCount = Math.max(1, await getMaxBatch(active));
    dbEvents.emit('item', {
        type: 'inserted',
        item: formatQueueRow(row),
        rawRow: row,
        batchCount
    });
    return row;
}

async function getQueueItem(galleryId, db = null) {
    const active = db || await getDb();
    const id = normalizeGalleryId(galleryId);
    return publicRow(active.prepare(`SELECT * FROM queue WHERE gallery_id = ?`).get(id) || null);
}

async function getNextPendingItem(db = null) {
    const active = db || await getDb();
    return publicRow(active.prepare(`
        SELECT * FROM queue
        WHERE status = 'PENDING'
        ORDER BY priority DESC, id ASC
        LIMIT 1
    `).get() || null);
}

async function getQueueItems(options = {}, db = null) {
    const active = db || await getDb();
    const clauses = [];
    const params = [];

    if (options.status) {
        clauses.push(`status = ?`);
        params.push(options.status);
    }
    if (options.batch !== undefined && options.batch !== null) {
        clauses.push(`batch = ?`);
        params.push(options.batch);
    }
    if (options.search && String(options.search).trim()) {
        clauses.push(`(CAST(gallery_id AS TEXT) LIKE ? OR title LIKE ? OR url LIKE ?)`);
        const like = `%${String(options.search).trim()}%`;
        params.push(like, like, like);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM queue ${whereSql} ORDER BY batch ASC, id ASC`;

    if (Number.isFinite(options.limit) && options.limit > 0) {
        sql += ` LIMIT ?`;
        params.push(options.limit);
        if (Number.isFinite(options.offset) && options.offset >= 0) {
            sql += ` OFFSET ?`;
            params.push(options.offset);
        }
    }

    return active.prepare(sql).all(...params).map(publicRow);
}

async function updateQueueItem(galleryId, fields = {}, db = null) {
    const active = db || await getDb();
    const id = normalizeGalleryId(galleryId);
    const sets = [`updated_at = datetime('now')`];
    const params = [];

    const map = {
        url: 'url',
        title: 'title',
        status: 'status',
        batch: 'batch',
        priority: 'priority',
        pagesDone: 'pages_done',
        pages_done: 'pages_done',
        pagesTotal: 'pages_total',
        pages_total: 'pages_total',
        error: 'error',
        retries: 'retries',
        format: 'format'
    };

    const seenCols = new Set();
    for (const [key, col] of Object.entries(map)) {
        if (fields[key] !== undefined && !seenCols.has(col)) {
            seenCols.add(col);
            sets.push(`${col} = ?`);
            params.push(fields[key]);
        }
    }

    if (fields.incrementRetries) {
        sets.push(`retries = retries + 1`);
    }

    params.push(id);
    active.prepare(`UPDATE queue SET ${sets.join(', ')} WHERE gallery_id = ?`).run(...params);
    const updated = await getQueueItem(id, active);
    if (updated) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        dbEvents.emit('item', {
            type: 'updated',
            item: formatQueueRow(updated),
            rawRow: updated,
            batchCount
        });
    }
    return updated;
}

async function updateQueueStatus(galleryId, status, extra = {}, db = null) {
    const fields = { status, ...extra };
    if (status === 'ERROR' && extra.incrementRetries === undefined && extra.retries === undefined) {
        fields.incrementRetries = true;
    }
    return await updateQueueItem(galleryId, fields, db);
}

async function deleteQueueItem(galleryId, db = null) {
    const active = db || await getDb();
    const id = normalizeGalleryId(galleryId);
    const res = active.prepare(`DELETE FROM queue WHERE gallery_id = ?`).run(id);
    if (res.changes > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        dbEvents.emit('item', { type: 'deleted', galleryId: toPublicId(id), batchCount });
    }
    return Number(res.changes || 0);
}

async function pauseQueueItems(ids = [], db = null) {
    const active = db || await getDb();
    if (!Array.isArray(ids) || ids.length === 0) return { paused: 0, stoppingIds: [] };
    let paused = 0;
    const stoppingIds = [];
    const pausableSet = new Set(['PENDING', 'ERROR', 'COOLDOWN', 'PAUSED', 'ON_PROGRESS']);

    active.exec('BEGIN');
    try {
        for (const rawId of ids) {
            let gid;
            try { gid = normalizeGalleryId(rawId); } catch (e) { continue; }
            const row = await getQueueItem(gid, active);
            if (!row) continue;
            const st = String(row.status || '').toUpperCase();
            const isPausable = pausableSet.has(st) || st.startsWith('ERROR') || st.startsWith('COOLDOWN') || st.startsWith('PAUSED');
            if (!isPausable) continue;

            if (st === 'ON_PROGRESS') {
                stoppingIds.push(toPublicId(gid));
            }
            await updateQueueItem(gid, { status: 'STOPPED' }, active);
            paused++;
        }
        active.exec('COMMIT');
    } catch (err) {
        active.exec('ROLLBACK');
        throw err;
    }

    return { paused, stoppingIds };
}

async function resumeQueueItems(ids = [], db = null) {
    const active = db || await getDb();
    if (!Array.isArray(ids) || ids.length === 0) return { resumed: 0, resumedIds: [] };
    let resumed = 0;
    const resumedIds = [];
    const resumableSet = new Set(['STOPPED', 'ERROR', 'COOLDOWN', 'PAUSED']);

    active.exec('BEGIN');
    try {
        for (const rawId of ids) {
            let gid;
            try { gid = normalizeGalleryId(rawId); } catch (e) { continue; }
            const row = await getQueueItem(gid, active);
            if (!row) continue;
            const st = String(row.status || '').toUpperCase();
            const isResumable = resumableSet.has(st) || st.startsWith('ERROR') || st.startsWith('COOLDOWN') || st.startsWith('PAUSED');
            if (!isResumable) continue;

            await updateQueueItem(gid, { status: 'PENDING', error: null }, active);
            resumed++;
            resumedIds.push(toPublicId(gid));
        }
        active.exec('COMMIT');
    } catch (err) {
        active.exec('ROLLBACK');
        throw err;
    }

    return { resumed, resumedIds };
}

async function deleteQueueItems(ids = [], db = null) {
    const active = db || await getDb();
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0, stoppingIds: [] };
    let deleted = 0;
    const stoppingIds = [];

    active.exec('BEGIN');
    try {
        for (const rawId of ids) {
            let gid;
            try { gid = normalizeGalleryId(rawId); } catch (e) { continue; }
            const row = await getQueueItem(gid, active);
            if (!row) continue;
            if (row.status === 'ON_PROGRESS') {
                stoppingIds.push(toPublicId(gid));
            }
            deleted += await deleteQueueItem(gid, active);
        }
        active.exec('COMMIT');
    } catch (err) {
        active.exec('ROLLBACK');
        throw err;
    }

    return { deleted, stoppingIds };
}

async function updateQueuePriority(ids = [], action = 'top', db = null) {
    const active = db || await getDb();
    const validActions = new Set(['top', 'up', 'down', 'bottom']);
    if (!validActions.has(action) || !Array.isArray(ids) || ids.length === 0) {
        return { updated: 0 };
    }

    const targetSet = new Set();
    for (const rawId of ids) {
        try { targetSet.add(normalizeGalleryId(rawId)); } catch (e) {}
    }
    if (targetSet.size === 0) return { updated: 0 };

    const rows = active.prepare(`
        SELECT id, gallery_id, priority
        FROM queue
        ORDER BY priority DESC, id ASC
    `).all();
    if (rows.length === 0) return { updated: 0 };

    let selectedCount = 0;
    for (let i = 0; i < rows.length; i++) {
        if (targetSet.has(String(rows[i].gallery_id))) selectedCount++;
    }
    if (selectedCount === 0) return { updated: 0 };

    const changedItems = [];
    const nowSql = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const stmt = active.prepare(`
        UPDATE queue
        SET priority = ?, updated_at = ?
        WHERE gallery_id = ?
    `);

    active.exec('BEGIN IMMEDIATE');
    try {
        if (action === 'top') {
            const maxP = rows.reduce((m, r) => Math.max(m, Number(r.priority) || 0), 0);
            const selectedRows = rows.filter(r => targetSet.has(String(r.gallery_id)));
            for (let i = 0; i < selectedRows.length; i++) {
                const newP = maxP + (selectedRows.length - i);
                const gid = String(selectedRows[i].gallery_id);
                if (Number(selectedRows[i].priority) !== newP) {
                    stmt.run(newP, nowSql, gid);
                    changedItems.push({ galleryId: toPublicId(gid), priority: newP });
                }
            }
        } else if (action === 'bottom') {
            const minP = rows.reduce((m, r) => Math.min(m, Number(r.priority) || 0), 0);
            const selectedRows = rows.filter(r => targetSet.has(String(r.gallery_id)));
            for (let i = 0; i < selectedRows.length; i++) {
                const newP = minP - (i + 1);
                const gid = String(selectedRows[i].gallery_id);
                if (Number(selectedRows[i].priority) !== newP) {
                    stmt.run(newP, nowSql, gid);
                    changedItems.push({ galleryId: toPublicId(gid), priority: newP });
                }
            }
        } else if (action === 'up' || action === 'down') {
            const reordered = [...rows];
            if (action === 'up') {
                for (let i = 1; i < reordered.length; i++) {
                    if (targetSet.has(String(reordered[i].gallery_id)) && !targetSet.has(String(reordered[i - 1].gallery_id))) {
                        const tmp = reordered[i - 1];
                        reordered[i - 1] = reordered[i];
                        reordered[i] = tmp;
                    }
                }
            } else {
                for (let i = reordered.length - 2; i >= 0; i--) {
                    if (targetSet.has(String(reordered[i].gallery_id)) && !targetSet.has(String(reordered[i + 1].gallery_id))) {
                        const tmp = reordered[i + 1];
                        reordered[i + 1] = reordered[i];
                        reordered[i] = tmp;
                    }
                }
            }

            let isStrictlyDecreasing = true;
            for (let i = 0; i < rows.length - 1; i++) {
                if ((Number(rows[i].priority) || 0) <= (Number(rows[i + 1].priority) || 0)) {
                    isStrictlyDecreasing = false;
                    break;
                }
            }

            const total = reordered.length;
            if (isStrictlyDecreasing) {
                for (let idx = 0; idx < total; idx++) {
                    const r = reordered[idx];
                    const slotPriority = Number(rows[idx].priority);
                    if (Number(r.priority) !== slotPriority) {
                        const gid = String(r.gallery_id);
                        stmt.run(slotPriority, nowSql, gid);
                        changedItems.push({ galleryId: toPublicId(gid), priority: slotPriority });
                    }
                }
            } else {
                for (let idx = 0; idx < total; idx++) {
                    const r = reordered[idx];
                    const desiredPriority = total - idx;
                    if (Number(r.priority) !== desiredPriority) {
                        const gid = String(r.gallery_id);
                        stmt.run(desiredPriority, nowSql, gid);
                        changedItems.push({ galleryId: toPublicId(gid), priority: desiredPriority });
                    }
                }
            }
        }
        active.exec('COMMIT');
    } catch (err) {
        active.exec('ROLLBACK');
        throw err;
    }

    if (changedItems.length > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        dbEvents.emit('item', {
            type: 'reordered',
            items: changedItems,
            batchCount
        });
    }

    return { updated: selectedCount };
}

async function deleteQueueBatch(batchNum, db = null) {
    const active = db || await getDb();
    const res = active.prepare(`DELETE FROM queue WHERE batch = ?`).run(batchNum);
    if (res.changes > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        dbEvents.emit('batch_deleted', { batch: batchNum, batchCount });
        dbEvents.emit('item', { type: 'batch_deleted', batch: batchNum, batchCount });
    }
    return Number(res.changes || 0);
}

async function clearCompletedQueue(db = null) {
    const active = db || await getDb();
    const rows = active.prepare(`
        SELECT gallery_id FROM queue
        WHERE status = 'DONE' OR status LIKE 'SKIPPED%'
    `).all();
    const res = active.prepare(`
        DELETE FROM queue
        WHERE status = 'DONE' OR status LIKE 'SKIPPED%'
    `).run();
    if (res.changes > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        const removedIds = rows.map(r => toPublicId(r.gallery_id));
        dbEvents.emit('item', { type: 'cleared', removedIds, batchCount });
    }
    return Number(res.changes || 0);
}

async function getMaxBatch(db = null) {
    const active = db || await getDb();
    const row = active.prepare(`SELECT COALESCE(MAX(batch), 0) AS max_batch FROM queue`).get();
    return row ? Number(row.max_batch) : 0;
}

async function importListText(text, options = {}, db = null) {
    const active = db || await getDb();
    const { replace = false, defaultFormat = null } = options;
    const { items: parsedItems, ignored } = parseListTextDetailed(text, defaultFormat);
    const galleryIds = parsedItems.map(i => i.galleryId);

    let added = 0;
    let updated = 0;
    let duplicates = 0;

    active.exec('BEGIN');
    try {
        if (replace) {
            const keepSet = new Set(galleryIds.map(g => String(g)));
            const existingRows = active.prepare(`SELECT gallery_id FROM queue`).all();
            for (const r of existingRows) {
                if (!keepSet.has(String(r.gallery_id))) {
                    await deleteQueueItem(r.gallery_id, active);
                }
            }
        }

        for (const item of parsedItems) {
            const existing = await getQueueItem(item.galleryId, active);
            let libEntry = await getLibraryEntry(item.galleryId, active);
            const isPermanentSkip = !!(libEntry && libEntry.skipped);
            const isValidLib = !!(libEntry && !libEntry.skipped && libEntry.path && fs.existsSync(libEntry.path));

            if (libEntry && !isPermanentSkip && !isValidLib) {
                await deleteLibraryEntry(item.galleryId, active);
                libEntry = null;
            }

            let initialStatus = 'PENDING';
            let initialTitle = item.title;
            let pagesDone = 0;
            let pagesTotal = 0;

            if (isValidLib) {
                initialStatus = 'DONE';
                const display = libEntry.artist && libEntry.artist !== 'Other' && libEntry.artist !== 'Unknown'
                    ? `${libEntry.artist} - ${libEntry.title}`
                    : libEntry.title;
                initialTitle = initialTitle || display;
                pagesDone = libEntry.pages || 0;
                pagesTotal = libEntry.pages || 0;
            } else if (isPermanentSkip) {
                initialStatus = 'SKIPPED';
            }

            if (!existing) {
                await enqueueGallery({
                    galleryId: item.galleryId,
                    url: item.url,
                    title: initialTitle,
                    status: initialStatus,
                    batch: item.batch,
                    format: item.format,
                    pagesDone,
                    pagesTotal,
                    error: isPermanentSkip ? (libEntry.reason || 'Skipped') : null
                }, active);
                added++;
            } else {
                duplicates++;
                const updates = { batch: item.batch };
                if (item.format) updates.format = item.format;
                if (initialTitle && !existing.title) updates.title = initialTitle;
                if (isValidLib && existing.status !== 'DONE' && existing.status !== 'STOPPED') {
                    updates.status = 'DONE';
                    updates.pagesDone = pagesDone;
                    updates.pagesTotal = pagesTotal;
                } else if (
                    !isValidLib &&
                    !isPermanentSkip &&
                    (existing.status === 'DONE' || String(existing.status).startsWith('SKIPPED'))
                ) {
                    updates.status = 'PENDING';
                    updates.pagesDone = 0;
                    updates.error = null;
                }
                await updateQueueItem(item.galleryId, updates, active);
                updated++;
            }
        }
        active.exec('COMMIT');
    } catch (err) {
        active.exec('ROLLBACK');
        throw err;
    }

    return { added, updated, duplicates, ignored, galleryIds, total: parsedItems.length };
}

async function exportListText(db = null) {
    const active = db || await getDb();
    const rows = await getQueueItems({}, active);
    if (rows.length === 0) return '';

    const lines = [];
    let currentBatch = null;

    for (const row of rows) {
        if (row.batch !== currentBatch) {
            currentBatch = row.batch;
            const fmtSuffix = row.format ? ` FORMAT=${row.format}` : '';
            lines.push(`# BATCH ${currentBatch}${fmtSuffix}`);
        }
        const baseUrl = row.url || urlForKey(row.gallery_id);
        if (row.title) {
            lines.push(`${baseUrl} | ${row.title}`);
        } else {
            lines.push(baseUrl);
        }
    }

    return lines.join('\n') + '\n';
}

async function upsertLibraryEntry(entry, db = null) {
    const active = db || await getDb();
    const galleryId = normalizeGalleryId(entry.galleryId ?? entry.gallery_id);
    const title = entry.title || 'Unknown';
    const folderPath = entry.path || entry.folder || '';
    const pages = Number.isFinite(entry.pages) ? entry.pages : null;
    const format = entry.format || (entry.skipped ? 'skipped' : (entry.archived ? (entry.archiveExt || 'cbz') : 'folder'));
    const language = entry.language ?? entry.lang ?? null;
    const artist = entry.artist ?? entry.author ?? null;
    const addedAt = entry.addedAt || entry.downloadedAt || new Date().toISOString();

    let metaObj = null;
    if (entry.meta) {
        metaObj = typeof entry.meta === 'string' ? JSON.parse(entry.meta) : { ...entry.meta };
    }
    if (entry.skipped !== undefined || entry.reason !== undefined || format === 'skipped') {
        metaObj = metaObj || {};
        if (entry.skipped !== undefined) metaObj.skipped = !!entry.skipped;
        else if (format === 'skipped') metaObj.skipped = true;
        if (entry.reason !== undefined) metaObj.reason = entry.reason;
    }
    const metaJson = metaObj ? JSON.stringify(metaObj) : null;

    active.prepare(`
        INSERT INTO library (gallery_id, title, path, pages, format, language, artist, added_at, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(gallery_id) DO UPDATE SET
            title = excluded.title,
            path = excluded.path,
            pages = excluded.pages,
            format = excluded.format,
            language = excluded.language,
            artist = excluded.artist,
            added_at = excluded.added_at,
            meta = COALESCE(excluded.meta, library.meta)
    `).run(galleryId, title, folderPath, pages, format, language, artist, addedAt, metaJson);

    return await getLibraryEntry(galleryId, active);
}

function parseLibraryRow(row) {
    if (!row) return null;
    let parsedMeta = null;
    if (row.meta) {
        try { parsedMeta = JSON.parse(row.meta); } catch (e) {}
    }
    const isArchived = row.format === 'cbz' || row.format === 'zip';
    const isSkipped = row.format === 'skipped' || !!(parsedMeta && parsedMeta.skipped);
    return {
        gallery_id: toPublicId(row.gallery_id),
        id: String(row.gallery_id),
        title: row.title,
        path: row.path,
        folder: row.path,
        pages: row.pages || 0,
        format: row.format || 'folder',
        language: row.language,
        lang: row.language,
        artist: row.artist,
        author: row.artist,
        added_at: row.added_at,
        downloadedAt: row.added_at,
        archived: isArchived,
        archiveExt: isArchived ? row.format : null,
        ext: parsedMeta && parsedMeta.ext ? parsedMeta.ext : (isArchived ? null : 'jpg'),
        pageExts: parsedMeta && parsedMeta.pageExts ? parsedMeta.pageExts : {},
        skipped: isSkipped,
        reason: parsedMeta && parsedMeta.reason ? parsedMeta.reason : null,
        meta: parsedMeta
    };
}

async function getLibraryEntry(galleryId, db = null) {
    const active = db || await getDb();
    const id = normalizeGalleryId(galleryId);
    const row = active.prepare(`SELECT * FROM library WHERE gallery_id = ?`).get(id);
    return parseLibraryRow(row);
}

async function getAllLibraryEntries(db = null) {
    const active = db || await getDb();
    const rows = active.prepare(`SELECT * FROM library ORDER BY added_at DESC, gallery_id DESC`).all();
    return rows.map(parseLibraryRow);
}

async function getLibraryMap(db = null) {
    const active = db || await getDb();
    const entries = await getAllLibraryEntries(active);
    const map = {};
    for (const e of entries) {
        map[e.id] = e;
    }
    return map;
}

async function deleteLibraryEntry(galleryId, db = null) {
    const active = db || await getDb();
    const id = normalizeGalleryId(galleryId);
    const res = active.prepare(`DELETE FROM library WHERE gallery_id = ?`).run(id);
    return Number(res.changes || 0);
}

function hasActiveLibraryEntries(targetDb = null) {
    const active = targetDb || activeDb;
    if (!active) return false;
    try {
        const row = active.prepare(`SELECT 1 FROM library WHERE format IS NULL OR format != 'skipped' LIMIT 1`).get();
        return !!row;
    } catch (e) {
        return false;
    }
}

async function getSetting(key, defaultValue = undefined, db = null) {
    const active = db || await getDb();
    const row = active.prepare(`SELECT value FROM settings WHERE key = ?`).get(String(key));
    if (!row) return defaultValue;
    try {
        return JSON.parse(row.value);
    } catch (e) {
        return row.value;
    }
}

async function setSetting(key, value, db = null) {
    const active = db || await getDb();
    const encoded = JSON.stringify(value);
    active.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), encoded);
    return value;
}

async function getAllSettings(db = null) {
    const active = db || await getDb();
    const rows = active.prepare(`SELECT key, value FROM settings`).all();
    const out = {};
    for (const r of rows) {
        try {
            out[r.key] = JSON.parse(r.value);
        } catch (e) {
            out[r.key] = r.value;
        }
    }
    return out;
}

async function migrateLegacyConfigJson(configPath = path.join(ROOT_DIR, 'config.json'), db = null) {
    const active = db || await getDb();
    try {
        const countRow = active.prepare(`SELECT COUNT(*) AS cnt FROM settings`).get();
        if (countRow && Number(countRow.cnt) > 0) {
            return false;
        }
        if (!configPath || !fs.existsSync(configPath)) {
            return false;
        }
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return false;
        }

        let copied = 0;
        if (parsed.downloadDir !== undefined) {
            await setSetting('downloadDir', parsed.downloadDir, active);
            copied++;
        }
        if (parsed.downloadFormat !== undefined) {
            await setSetting('downloadFormat', parsed.downloadFormat, active);
            copied++;
        }
        if (parsed.autoContinueBatches !== undefined) {
            await setSetting('autoContinueBatches', parsed.autoContinueBatches, active);
            copied++;
        }

        if (copied > 0) {
            await logEvent({ level: 'info', message: 'Migrated settings from config.json' }, active);
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

async function logEvent({ level = 'info', galleryId = null, message = '', maxRows = 10000 }, db = null) {
    const active = db || await getDb();
    const gid = galleryId !== null && galleryId !== undefined && String(galleryId).trim() !== ''
        ? (canonicalKey(galleryId) || null)
        : null;
    const nowIso = new Date().toISOString();

    active.prepare(`
        INSERT INTO events (ts, level, gallery_id, message)
        VALUES (?, ?, ?, ?)
    `).run(nowIso, level, gid, String(message));

    if (maxRows && maxRows > 0) {
        active.prepare(`
            DELETE FROM events
            WHERE id NOT IN (
                SELECT id FROM events ORDER BY id DESC LIMIT ?
            )
        `).run(maxRows);
    }
}

async function getEvents(options = {}, db = null) {
    const active = db || await getDb();
    const clauses = [];
    const params = [];

    if (options.level) {
        clauses.push(`level = ?`);
        params.push(options.level);
    }
    if (options.galleryId !== undefined && options.galleryId !== null) {
        clauses.push(`gallery_id = ?`);
        params.push(normalizeGalleryId(options.galleryId));
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 5000;

    const rows = active.prepare(`
        SELECT * FROM (
            SELECT * FROM events ${whereSql} ORDER BY id DESC LIMIT ?
        ) ORDER BY id ASC
    `).all(...params, limit);

    return rows;
}

async function exportData(db = null) {
    const active = db || await getDb();
    const schemaVersion = await getSchemaVersion(active);
    const queue = active.prepare(`SELECT * FROM queue ORDER BY batch ASC, id ASC`).all().map(publicRow);
    const library = active.prepare(`SELECT * FROM library ORDER BY added_at DESC, gallery_id DESC`).all().map(publicRow);
    const settings = active.prepare(`SELECT * FROM settings ORDER BY key ASC`).all();
    const events = active.prepare(`SELECT * FROM events ORDER BY id ASC`).all();

    return {
        format: 'nhdl-export',
        version: 1,
        exported_at: new Date().toISOString(),
        db_type: 'sqlite',
        schema_version: schemaVersion,
        tables: {
            queue,
            library,
            settings,
            events
        }
    };
}

async function importData(payload, options = {}, db = null) {
    const active = db || await getDb();
    const appSchemaVer = (await getSchemaVersion(active)) || CURRENT_APP_SCHEMA_VERSION;
    validateImportPayload(payload, options, appSchemaVer);

    const mode = options.mode === 'merge' ? 'merge' : 'replace';
    const tables = payload?.tables || {};
    const queueRows = Array.isArray(tables.queue) ? tables.queue : [];
    const libraryRows = Array.isArray(tables.library) ? tables.library : [];
    const settingsRows = Array.isArray(tables.settings) ? tables.settings : [];
    const eventsRows = Array.isArray(tables.events) ? tables.events : [];

    let imported = { queue: 0, library: 0, settings: 0, events: 0 };

    active.exec('BEGIN IMMEDIATE');
    try {
        if (mode === 'replace') {
            active.exec(`DELETE FROM queue; DELETE FROM library; DELETE FROM settings; DELETE FROM events;`);
        }

        const queueStmt = active.prepare(`
            INSERT ${mode === 'merge' ? 'OR IGNORE' : 'OR REPLACE'} INTO queue (
                gallery_id, url, title, status, batch, priority,
                pages_done, pages_total, error, retries, created_at, updated_at, format
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of queueRows) {
            const gid = normalizeGalleryId(r.gallery_id || r.galleryId);
            const url = r.url || urlForKey(gid);
            const title = r.title || null;
            const status = r.status || 'PENDING';
            const batch = Number(r.batch || 1);
            const priority = Number(r.priority || 0);
            const pagesDone = Number(r.pages_done ?? r.pagesDone ?? 0);
            const pagesTotal = Number(r.pages_total ?? r.pagesTotal ?? 0);
            const error = r.error || null;
            const retries = Number(r.retries || 0);
            const createdAt = r.created_at || r.createdAt || new Date().toISOString();
            const updatedAt = r.updated_at || r.updatedAt || new Date().toISOString();
            const format = r.format || null;

            const res = queueStmt.run(
                gid, url, title, status, batch, priority,
                pagesDone, pagesTotal, error, retries, createdAt, updatedAt, format
            );
            if (res.changes > 0) imported.queue++;
        }

        const libStmt = active.prepare(`
            INSERT INTO library (gallery_id, title, path, pages, format, language, artist, added_at, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(gallery_id) DO ${mode === 'merge' ? 'NOTHING' : `UPDATE SET
                title = excluded.title,
                path = excluded.path,
                pages = excluded.pages,
                format = excluded.format,
                language = excluded.language,
                artist = excluded.artist,
                added_at = excluded.added_at,
                meta = excluded.meta`}
        `);
        for (const r of libraryRows) {
            const gid = normalizeGalleryId(r.gallery_id || r.galleryId);
            const title = r.title || 'Unknown';
            const p = r.path || r.folder || '';
            const pages = Number.isFinite(r.pages) ? r.pages : null;
            const format = r.format || 'folder';
            const language = r.language || r.lang || null;
            const artist = r.artist || r.author || null;
            const addedAt = r.added_at || r.addedAt || new Date().toISOString();
            const meta = typeof r.meta === 'object' ? JSON.stringify(r.meta) : (r.meta || null);

            const res = libStmt.run(gid, title, p, pages, format, language, artist, addedAt, meta);
            if (res.changes > 0) imported.library++;
        }

        const setStmt = active.prepare(`
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO ${mode === 'merge' ? 'NOTHING' : 'UPDATE SET value = excluded.value'}
        `);
        for (const r of settingsRows) {
            const key = String(r.key);
            const val = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
            const res = setStmt.run(key, val);
            if (res.changes > 0) imported.settings++;
        }

        const evtStmt = active.prepare(`
            INSERT INTO events (ts, level, gallery_id, message)
            VALUES (?, ?, ?, ?)
        `);
        for (const r of eventsRows) {
            const ts = r.ts || new Date().toISOString();
            const level = r.level || 'info';
            const gid = r.gallery_id ? normalizeGalleryId(r.gallery_id) : null;
            const msg = String(r.message || '');
            const res = evtStmt.run(ts, level, gid, msg);
            if (res.changes > 0) imported.events++;
        }

        active.exec('COMMIT');
    } catch (err) {
        active.exec('ROLLBACK');
        throw err;
    }

    const batchCount = Math.max(1, await getMaxBatch(active));
    dbEvents.emit('reloaded', { batchCount });

    return {
        success: true,
        mode,
        imported
    };
}

module.exports = {
    DEFAULT_DB_PATH,
    dbEvents,
    initDb,
    getDb,
    closeDb,
    getDbInfo,
    getSchemaVersion,
    runMigrations,
    resetStuckQueueItems,
    requeueFailedItems,
    formatQueueRow,
    enqueueGallery,
    getQueueItem,
    getNextPendingItem,
    getQueueItems,
    updateQueueItem,
    updateQueueStatus,
    deleteQueueItem,
    pauseQueueItems,
    resumeQueueItems,
    deleteQueueItems,
    updateQueuePriority,
    deleteQueueBatch,
    clearCompletedQueue,
    getMaxBatch,
    parseListText,
    importListText,
    exportListText,
    upsertLibraryEntry,
    getLibraryEntry,
    getAllLibraryEntries,
    getLibraryMap,
    deleteLibraryEntry,
    hasActiveLibraryEntries,
    getSetting,
    setSetting,
    getAllSettings,
    migrateLegacyConfigJson,
    logEvent,
    getEvents,
    exportData,
    importData
};
