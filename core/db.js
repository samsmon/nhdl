const { DatabaseSync } = require('node:sqlite');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = process.env.NHDL_DB_PATH || path.join(ROOT_DIR, 'data', 'nhdl.db');

const dbEvents = new EventEmitter();

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
];

function getSchemaVersion(db = getDb()) {
    const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`
    ).get();
    if (!tableExists) return 0;
    const row = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get();
    return row && typeof row.v === 'number' ? row.v : 0;
}

function runMigrations(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`);
    let currentVersion = getSchemaVersion(db);

    for (const migration of MIGRATIONS) {
        if (migration.version > currentVersion) {
            db.exec('BEGIN');
            try {
                migration.up(db);
                db.prepare(`DELETE FROM schema_version`).run();
                db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(migration.version);
                db.exec('COMMIT');
                currentVersion = migration.version;
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            }
        }
    }
    return currentVersion;
}

function initDb(dbPath = DEFAULT_DB_PATH, options = {}) {
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
    runMigrations(db);

    const legacyConfigPath = options.legacyConfigPath !== undefined
        ? options.legacyConfigPath
        : (process.env.NHDL_LEGACY_CONFIG !== undefined
            ? process.env.NHDL_LEGACY_CONFIG
            : path.join(ROOT_DIR, 'config.json'));
    if (legacyConfigPath) {
        migrateLegacyConfigJson(legacyConfigPath, db);
    }

    activeDb = db;
    activeDbPath = dbPath;
    return db;
}

function getDb() {
    if (!activeDb) {
        return initDb(DEFAULT_DB_PATH);
    }
    return activeDb;
}

function closeDb() {
    if (activeDb) {
        try { activeDb.close(); } catch (e) {}
        activeDb = null;
        activeDbPath = null;
    }
}

// Startup recovery: any item left in ON_PROGRESS when the server died must be reset to PENDING
function resetStuckQueueItems(db = getDb()) {
    const stuckRows = db.prepare(`SELECT gallery_id FROM queue WHERE status = 'ON_PROGRESS'`).all();
    const stmt = db.prepare(`
        UPDATE queue
        SET status = 'PENDING', updated_at = datetime('now')
        WHERE status = 'ON_PROGRESS'
    `);
    const res = stmt.run();
    if (res.changes > 0) {
        const batchCount = Math.max(1, getMaxBatch(db));
        for (const r of stuckRows) {
            const updated = getQueueItem(r.gallery_id, db);
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

// Re-queue ERROR / COOLDOWN / PAUSED items back to PENDING if retries < maxRetries (default 5)
function requeueFailedItems(options = {}, db = getDb()) {
    const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 5;
    const targetRows = db.prepare(`
        SELECT gallery_id FROM queue
        WHERE status IN ('ERROR', 'COOLDOWN', 'PAUSED')
          AND COALESCE(retries, 0) < ?
    `).all(maxRetries);

    const stmt = db.prepare(`
        UPDATE queue
        SET status = 'PENDING', error = NULL, updated_at = datetime('now')
        WHERE status IN ('ERROR', 'COOLDOWN', 'PAUSED')
          AND COALESCE(retries, 0) < ?
    `);
    const res = stmt.run(maxRetries);
    if (res.changes > 0) {
        const batchCount = Math.max(1, getMaxBatch(db));
        for (const r of targetRows) {
            const updated = getQueueItem(r.gallery_id, db);
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

function normalizeGalleryId(galleryId) {
    const num = typeof galleryId === 'number' ? galleryId : parseInt(String(galleryId).trim(), 10);
    if (!Number.isFinite(num) || num <= 0) {
        throw new Error(`Invalid gallery_id: ${galleryId}`);
    }
    return num;
}

function formatQueueRow(r) {
    if (!r) return null;
    const displayStatus = r.error ? `${r.status} - ${r.error}` : r.status;
    const displayUrl = r.title ? `${r.url} | ${r.title}` : r.url;
    return {
        id: r.id,
        galleryId: r.gallery_id,
        status: displayStatus,
        rawStatus: r.status,
        url: displayUrl,
        title: r.title,
        batch: r.batch || 1,
        priority: r.priority || 0,
        pagesDone: r.pages_done || 0,
        pagesTotal: r.pages_total || 0,
        error: r.error || null,
        retries: r.retries || 0,
        format: r.format || null
    };
}

function enqueueGallery(item, db = getDb()) {
    const galleryId = normalizeGalleryId(item.galleryId ?? item.gallery_id);
    const url = item.url || `https://nhentai.net/g/${galleryId}/`;
    const title = item.title ?? null;
    const status = item.status || 'PENDING';
    const batch = Number.isFinite(item.batch) ? item.batch : 1;
    const priority = Number.isFinite(item.priority) ? item.priority : 0;
    const pagesDone = Number.isFinite(item.pagesDone ?? item.pages_done) ? (item.pagesDone ?? item.pages_done) : 0;
    const pagesTotal = Number.isFinite(item.pagesTotal ?? item.pages_total) ? (item.pagesTotal ?? item.pages_total) : 0;
    const error = item.error ?? null;
    const retries = Number.isFinite(item.retries) ? item.retries : 0;
    const format = item.format ?? null;

    const stmt = db.prepare(`
        INSERT INTO queue (
            gallery_id, url, title, status, batch, priority,
            pages_done, pages_total, error, retries, format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        galleryId, url, title, status, batch, priority,
        pagesDone, pagesTotal, error, retries, format
    );
    const row = getQueueItem(galleryId, db);
    const batchCount = Math.max(1, getMaxBatch(db));
    dbEvents.emit('item', {
        type: 'inserted',
        item: formatQueueRow(row),
        rawRow: row,
        batchCount
    });
    return row;
}

function getQueueItem(galleryId, db = getDb()) {
    const id = normalizeGalleryId(galleryId);
    return db.prepare(`SELECT * FROM queue WHERE gallery_id = ?`).get(id) || null;
}

function getNextPendingItem(db = getDb()) {
    return db.prepare(`
        SELECT * FROM queue
        WHERE status = 'PENDING'
        ORDER BY priority DESC, id ASC
        LIMIT 1
    `).get() || null;
}

function getQueueItems(options = {}, db = getDb()) {
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

    return db.prepare(sql).all(...params);
}

function updateQueueItem(galleryId, fields = {}, db = getDb()) {
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
    db.prepare(`UPDATE queue SET ${sets.join(', ')} WHERE gallery_id = ?`).run(...params);
    const updated = getQueueItem(id, db);
    if (updated) {
        const batchCount = Math.max(1, getMaxBatch(db));
        dbEvents.emit('item', {
            type: 'updated',
            item: formatQueueRow(updated),
            rawRow: updated,
            batchCount
        });
    }
    return updated;
}

function updateQueueStatus(galleryId, status, extra = {}, db = getDb()) {
    const fields = { status, ...extra };
    if (status === 'ERROR' && extra.incrementRetries === undefined && extra.retries === undefined) {
        fields.incrementRetries = true;
    }
    return updateQueueItem(galleryId, fields, db);
}

function deleteQueueItem(galleryId, db = getDb()) {
    const id = normalizeGalleryId(galleryId);
    const res = db.prepare(`DELETE FROM queue WHERE gallery_id = ?`).run(id);
    if (res.changes > 0) {
        const batchCount = Math.max(1, getMaxBatch(db));
        dbEvents.emit('item', { type: 'deleted', galleryId: id, batchCount });
    }
    return Number(res.changes || 0);
}

function deleteQueueBatch(batchNum, db = getDb()) {
    const res = db.prepare(`DELETE FROM queue WHERE batch = ?`).run(batchNum);
    if (res.changes > 0) {
        const batchCount = Math.max(1, getMaxBatch(db));
        dbEvents.emit('batch_deleted', { batch: batchNum, batchCount });
        dbEvents.emit('item', { type: 'batch_deleted', batch: batchNum, batchCount });
    }
    return Number(res.changes || 0);
}

function clearCompletedQueue(db = getDb()) {
    const rows = db.prepare(`
        SELECT gallery_id FROM queue
        WHERE status = 'DONE' OR status LIKE 'SKIPPED%'
    `).all();
    const res = db.prepare(`
        DELETE FROM queue
        WHERE status = 'DONE' OR status LIKE 'SKIPPED%'
    `).run();
    if (res.changes > 0) {
        const batchCount = Math.max(1, getMaxBatch(db));
        const removedIds = rows.map(r => Number(r.gallery_id));
        dbEvents.emit('item', { type: 'cleared', removedIds, batchCount });
    }
    return Number(res.changes || 0);
}

function getMaxBatch(db = getDb()) {
    const row = db.prepare(`SELECT COALESCE(MAX(batch), 0) AS max_batch FROM queue`).get();
    return row ? Number(row.max_batch) : 0;
}

// Parses a list.txt string (supporting "# BATCH N FORMAT=cbz", URLs, raw IDs, and "| Title" display suffixes)
function parseListText(text, defaultFormat = null) {
    const lines = String(text || '').split(/\r?\n/);
    let currentBatch = 1;
    let currentFormat = defaultFormat;
    const parsedItems = [];
    const seen = new Set();

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const batchMatch = line.match(/^#\s*BATCH\s+(\d+)(?:\s+FORMAT=(\w+))?/i);
        if (batchMatch) {
            currentBatch = parseInt(batchMatch[1], 10);
            currentFormat = batchMatch[2] ? batchMatch[2].toLowerCase() : defaultFormat;
            continue;
        }
        if (line.startsWith('#')) continue;

        const idMatch = line.match(/(?:(?:nhentai\.net|certain\.site)\/g\/|^)\s*(\d+)\b/i)
            || line.match(/\b(\d{5,7})\b/);
        if (!idMatch) continue;

        const galleryId = parseInt(idMatch[1], 10);
        if (!Number.isFinite(galleryId) || seen.has(galleryId)) continue;
        seen.add(galleryId);

        let title = null;
        const pipeIdx = line.indexOf('|');
        if (pipeIdx !== -1) {
            const afterPipe = line.slice(pipeIdx + 1).trim();
            if (afterPipe) title = afterPipe;
        }

        const url = `https://nhentai.net/g/${galleryId}/`;
        parsedItems.push({
            galleryId,
            url,
            title,
            batch: currentBatch,
            format: currentFormat
        });
    }

    return parsedItems;
}

function importListText(text, options = {}, db = getDb()) {
    const { replace = false, defaultFormat = null } = options;
    const parsedItems = parseListText(text, defaultFormat);
    const galleryIds = parsedItems.map(i => i.galleryId);

    let added = 0;
    let updated = 0;
    let duplicates = 0;

    db.exec('BEGIN');
    try {
        if (replace) {
            const keepSet = new Set(galleryIds);
            const existingRows = db.prepare(`SELECT gallery_id FROM queue`).all();
            for (const r of existingRows) {
                if (!keepSet.has(Number(r.gallery_id))) {
                    deleteQueueItem(r.gallery_id, db);
                }
            }
        }

        for (const item of parsedItems) {
            const existing = getQueueItem(item.galleryId, db);
            let libEntry = getLibraryEntry(item.galleryId, db);
            const isPermanentSkip = !!(libEntry && libEntry.skipped);
            const isValidLib = !!(libEntry && !libEntry.skipped && libEntry.path && fs.existsSync(libEntry.path));

            if (libEntry && !isPermanentSkip && !isValidLib) {
                deleteLibraryEntry(item.galleryId, db);
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
                enqueueGallery({
                    galleryId: item.galleryId,
                    url: item.url,
                    title: initialTitle,
                    status: initialStatus,
                    batch: item.batch,
                    format: item.format,
                    pagesDone,
                    pagesTotal,
                    error: isPermanentSkip ? (libEntry.reason || 'Skipped') : null
                }, db);
                added++;
            } else {
                duplicates++;
                const updates = { batch: item.batch };
                if (item.format) updates.format = item.format;
                if (initialTitle && !existing.title) updates.title = initialTitle;
                if (isValidLib && existing.status !== 'DONE') {
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
                updateQueueItem(item.galleryId, updates, db);
                updated++;
            }
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }

    return { added, updated, duplicates, galleryIds, total: parsedItems.length };
}

function exportListText(db = getDb()) {
    const rows = getQueueItems({}, db);
    if (rows.length === 0) return '';

    const lines = [];
    let currentBatch = null;

    for (const row of rows) {
        if (row.batch !== currentBatch) {
            currentBatch = row.batch;
            const fmtSuffix = row.format ? ` FORMAT=${row.format}` : '';
            lines.push(`# BATCH ${currentBatch}${fmtSuffix}`);
        }
        const baseUrl = row.url || `https://nhentai.net/g/${row.gallery_id}/`;
        if (row.title) {
            lines.push(`${baseUrl} | ${row.title}`);
        } else {
            lines.push(baseUrl);
        }
    }

    return lines.join('\n') + '\n';
}

// Library queries
function upsertLibraryEntry(entry, db = getDb()) {
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

    db.prepare(`
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

    return getLibraryEntry(galleryId, db);
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
        gallery_id: row.gallery_id,
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

function getLibraryEntry(galleryId, db = getDb()) {
    const id = normalizeGalleryId(galleryId);
    const row = db.prepare(`SELECT * FROM library WHERE gallery_id = ?`).get(id);
    return parseLibraryRow(row);
}

function getAllLibraryEntries(db = getDb()) {
    const rows = db.prepare(`SELECT * FROM library ORDER BY added_at DESC, gallery_id DESC`).all();
    return rows.map(parseLibraryRow);
}

function getLibraryMap(db = getDb()) {
    const entries = getAllLibraryEntries(db);
    const map = {};
    for (const e of entries) {
        map[e.id] = e;
    }
    return map;
}

function deleteLibraryEntry(galleryId, db = getDb()) {
    const id = normalizeGalleryId(galleryId);
    const res = db.prepare(`DELETE FROM library WHERE gallery_id = ?`).run(id);
    return Number(res.changes || 0);
}

// Settings queries
function getSetting(key, defaultValue = undefined, db = getDb()) {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(String(key));
    if (!row) return defaultValue;
    try {
        return JSON.parse(row.value);
    } catch (e) {
        return row.value;
    }
}

function setSetting(key, value, db = getDb()) {
    const encoded = JSON.stringify(value);
    db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), encoded);
    return value;
}

function getAllSettings(db = getDb()) {
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
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

function migrateLegacyConfigJson(configPath = path.join(ROOT_DIR, 'config.json'), db = getDb()) {
    try {
        const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM settings`).get();
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
            setSetting('downloadDir', parsed.downloadDir, db);
            copied++;
        }
        if (parsed.downloadFormat !== undefined) {
            setSetting('downloadFormat', parsed.downloadFormat, db);
            copied++;
        }
        if (parsed.autoContinueBatches !== undefined) {
            setSetting('autoContinueBatches', parsed.autoContinueBatches, db);
            copied++;
        }

        if (copied > 0) {
            logEvent({ level: 'info', message: 'Migrated settings from config.json' }, db);
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

// Events (activity & error logs)
function logEvent({ level = 'info', galleryId = null, message = '', maxRows = 10000 }, db = getDb()) {
    const gid = galleryId !== null && galleryId !== undefined && String(galleryId).trim() !== ''
        ? parseInt(String(galleryId), 10) || null
        : null;
    const nowIso = new Date().toISOString();

    db.prepare(`
        INSERT INTO events (ts, level, gallery_id, message)
        VALUES (?, ?, ?, ?)
    `).run(nowIso, level, gid, String(message));

    if (maxRows && maxRows > 0) {
        db.prepare(`
            DELETE FROM events
            WHERE id NOT IN (
                SELECT id FROM events ORDER BY id DESC LIMIT ?
            )
        `).run(maxRows);
    }
}

function getEvents(options = {}, db = getDb()) {
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

    const rows = db.prepare(`
        SELECT * FROM (
            SELECT * FROM events ${whereSql} ORDER BY id DESC LIMIT ?
        ) ORDER BY id ASC
    `).all(...params, limit);

    return rows;
}

module.exports = {
    DEFAULT_DB_PATH,
    dbEvents,
    initDb,
    getDb,
    closeDb,
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
    getSetting,
    setSetting,
    getAllSettings,
    migrateLegacyConfigJson,
    logEvent,
    getEvents
};
