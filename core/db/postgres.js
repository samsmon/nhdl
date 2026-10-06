const pg = require('pg');
const { Pool } = pg;
pg.types.setTypeParser(20, v => parseInt(v, 10)); // int8/bigint -> number
const fs = require('fs');
const path = require('path');
const { dbEvents } = require('./events');
const { normalizeGalleryId, toPublicId, publicRow, formatQueueRow, maskDatabaseUrl, validateImportPayload, CURRENT_APP_SCHEMA_VERSION } = require('./common');
const { parseListText, parseListTextDetailed } = require('./listParser');
const { canonicalKey } = require('../providers');

let activePool = null;
let activeUrl = null;
let hasActiveEntriesCache = false;

const MIGRATIONS = [
    {
        version: 1,
        async up(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

                CREATE TABLE IF NOT EXISTS queue (
                  id           BIGSERIAL PRIMARY KEY,
                  gallery_id   BIGINT NOT NULL UNIQUE,
                  url          TEXT    NOT NULL,
                  title        TEXT,
                  status       TEXT    NOT NULL DEFAULT 'PENDING',
                  batch        INTEGER NOT NULL DEFAULT 1,
                  priority     INTEGER NOT NULL DEFAULT 0,
                  pages_done   INTEGER NOT NULL DEFAULT 0,
                  pages_total  INTEGER NOT NULL DEFAULT 0,
                  error        TEXT,
                  retries      INTEGER NOT NULL DEFAULT 0,
                  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                  format       TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
                CREATE INDEX IF NOT EXISTS idx_queue_batch  ON queue(batch);
                CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue(priority DESC, id ASC);

                CREATE TABLE IF NOT EXISTS library (
                  gallery_id   BIGINT PRIMARY KEY,
                  title        TEXT NOT NULL,
                  path         TEXT NOT NULL,
                  pages        INTEGER,
                  format       TEXT,
                  language     TEXT,
                  artist       TEXT,
                  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
                  meta         TEXT
                );

                CREATE TABLE IF NOT EXISTS settings (
                  key   TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS events (
                  id          BIGSERIAL PRIMARY KEY,
                  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
                  level       TEXT NOT NULL,
                  gallery_id  BIGINT,
                  message     TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_events_gallery ON events(gallery_id);
            `);
        }
    },
    {
        version: 2,
        async up(client) {
            await client.query(`
                ALTER TABLE queue ADD COLUMN IF NOT EXISTS format TEXT;
                ALTER TABLE library ADD COLUMN IF NOT EXISTS meta TEXT;
                CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue(priority DESC, id ASC);
            `);
        }
    },
    {
        version: 3,
        async up(client) {
            await client.query(`
                ALTER TABLE queue   ALTER COLUMN gallery_id TYPE TEXT USING gallery_id::text;
                ALTER TABLE library ALTER COLUMN gallery_id TYPE TEXT USING gallery_id::text;
                ALTER TABLE events  ALTER COLUMN gallery_id TYPE TEXT USING gallery_id::text;
            `);
        }
    }
];

async function connectWithRetry(connectionString, timeoutMs = 60000, retryIntervalMs = 2000) {
    const masked = maskDatabaseUrl(connectionString);
    const pool = new Pool({
        connectionString,
        max: 10,
        connectionTimeoutMillis: 5000
    });

    const start = Date.now();
    let lastErr = null;

    while (Date.now() - start < timeoutMs) {
        try {
            const client = await pool.connect();
            client.release();
            return pool;
        } catch (err) {
            lastErr = err;
            console.warn(`[!] PostgreSQL not ready at ${masked} (${err.message}), retrying in ${retryIntervalMs / 1000}s...`);
            await new Promise(r => setTimeout(r, retryIntervalMs));
        }
    }

    try { await pool.end(); } catch (e) {}
    throw new Error(`Failed to connect to PostgreSQL at ${masked} after ${timeoutMs / 1000}s: ${lastErr?.message}`);
}

async function getSchemaVersion(db = null) {
    const active = db || await getDb();
    const checkTable = await active.query(`
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables 
            WHERE table_name = 'schema_version'
        ) AS exists;
    `);
    if (!checkTable.rows[0]?.exists) return 0;
    const res = await active.query(`SELECT MAX(version) AS v FROM schema_version`);
    return res.rows[0]?.v ? Number(res.rows[0].v) : 0;
}

async function runMigrations(db = null) {
    const active = db || await getDb();
    await active.query(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`);
    let currentVersion = await getSchemaVersion(active);

    for (const migration of MIGRATIONS) {
        if (migration.version > currentVersion) {
            const client = active.connect ? await active.connect() : active;
            const needsRelease = typeof active.connect === 'function';
            try {
                await client.query('BEGIN');
                await migration.up(client);
                await client.query(`DELETE FROM schema_version`);
                await client.query(`INSERT INTO schema_version (version) VALUES ($1)`, [migration.version]);
                await client.query('COMMIT');
                currentVersion = migration.version;
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch (e) {}
                throw err;
            } finally {
                if (needsRelease) client.release();
            }
        }
    }
    return currentVersion;
}

async function initDb(connectionString, options = {}) {
    if (activePool && activeUrl === connectionString) {
        return activePool;
    }
    if (activePool) {
        try { await activePool.end(); } catch (e) {}
        activePool = null;
    }

    const pool = await connectWithRetry(connectionString, options.timeoutMs || 60000, options.retryIntervalMs || 2000);
    await runMigrations(pool);

    // Refresh active library entries cache
    try {
        const checkLib = await pool.query(`SELECT 1 FROM library WHERE format IS NULL OR format != 'skipped' LIMIT 1`);
        hasActiveEntriesCache = checkLib.rows.length > 0;
    } catch (e) {
        hasActiveEntriesCache = false;
    }

    activePool = pool;
    activeUrl = connectionString;
    return pool;
}

async function getDb() {
    if (!activePool) {
        const url = process.env.DATABASE_URL;
        if (!url) {
            throw new Error('DATABASE_URL is not set for PostgreSQL adapter');
        }
        return await initDb(url);
    }
    return activePool;
}

async function closeDb() {
    if (activePool) {
        try { await activePool.end(); } catch (e) {}
        activePool = null;
        activeUrl = null;
        hasActiveEntriesCache = false;
    }
}

function getDbInfo() {
    let host = 'unknown';
    let port = '5432';
    let database = 'nhdl';
    if (activeUrl) {
        try {
            const parsed = new URL(activeUrl);
            host = parsed.hostname;
            port = parsed.port || '5432';
            database = parsed.pathname.replace(/^\//, '');
        } catch (e) {}
    }
    return {
        type: 'postgres',
        connected: !!activePool,
        host,
        port,
        database,
        detail: `${host}:${port}/${database}`,
        maskedUrl: maskDatabaseUrl(activeUrl)
    };
}

async function resetStuckQueueItems(db = null) {
    const active = db || await getDb();
    const res = await active.query(`
        UPDATE queue
        SET status = 'PENDING', updated_at = now()
        WHERE status = 'ON_PROGRESS'
        RETURNING gallery_id
    `);
    if (res.rows.length > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        for (const r of res.rows) {
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
    return res.rows.length;
}

async function requeueFailedItems(options = {}, db = null) {
    const active = db || await getDb();
    const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 5;
    const res = await active.query(`
        UPDATE queue
        SET status = 'PENDING', error = NULL, updated_at = now()
        WHERE status IN ('ERROR', 'COOLDOWN', 'PAUSED')
          AND COALESCE(retries, 0) < $1
        RETURNING gallery_id
    `, [maxRetries]);

    if (res.rows.length > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        for (const r of res.rows) {
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
    return res.rows.length;
}

async function enqueueGallery(item, db = null) {
    const active = db || await getDb();
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

    const res = await active.query(`
        INSERT INTO queue (
            gallery_id, url, title, status, batch, priority,
            pages_done, pages_total, error, retries, format
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (gallery_id) DO NOTHING
        RETURNING *
    `, [galleryId, url, title, status, batch, priority, pagesDone, pagesTotal, error, retries, format]);

    const row = publicRow(res.rows[0]) || await getQueueItem(galleryId, active);
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
    const res = await active.query(`SELECT * FROM queue WHERE gallery_id = $1`, [id]);
    return publicRow(res.rows[0] || null);
}

async function getNextPendingItem(db = null) {
    const active = db || await getDb();
    const res = await active.query(`
        SELECT * FROM queue
        WHERE status = 'PENDING'
        ORDER BY priority DESC, id ASC
        LIMIT 1
    `);
    return publicRow(res.rows[0] || null);
}

async function getQueueItems(options = {}, db = null) {
    const active = db || await getDb();
    const clauses = [];
    const params = [];

    if (options.status) {
        params.push(options.status);
        clauses.push(`status = $${params.length}`);
    }
    if (options.batch !== undefined && options.batch !== null) {
        params.push(options.batch);
        clauses.push(`batch = $${params.length}`);
    }
    if (options.search && String(options.search).trim()) {
        params.push(`%${String(options.search).trim()}%`);
        const idx = params.length;
        clauses.push(`(CAST(gallery_id AS TEXT) LIKE $${idx} OR title ILIKE $${idx} OR url ILIKE $${idx})`);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM queue ${whereSql} ORDER BY batch ASC, id ASC`;

    if (Number.isFinite(options.limit) && options.limit > 0) {
        params.push(options.limit);
        sql += ` LIMIT $${params.length}`;
        if (Number.isFinite(options.offset) && options.offset >= 0) {
            params.push(options.offset);
            sql += ` OFFSET $${params.length}`;
        }
    }

    const res = await active.query(sql, params);
    return res.rows.map(publicRow);
}

async function updateQueueItem(galleryId, fields = {}, db = null) {
    const active = db || await getDb();
    const id = normalizeGalleryId(galleryId);
    const sets = [`updated_at = now()`];
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
            params.push(fields[key]);
            sets.push(`${col} = $${params.length}`);
        }
    }

    if (fields.incrementRetries) {
        sets.push(`retries = retries + 1`);
    }

    params.push(id);
    const sql = `UPDATE queue SET ${sets.join(', ')} WHERE gallery_id = $${params.length} RETURNING *`;
    const res = await active.query(sql, params);
    const updated = publicRow(res.rows[0] || null);

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
    const res = await active.query(`DELETE FROM queue WHERE gallery_id = $1`, [id]);
    const changes = res.rowCount || 0;
    if (changes > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        dbEvents.emit('item', { type: 'deleted', galleryId: toPublicId(id), batchCount });
    }
    return changes;
}

async function pauseQueueItems(ids = [], db = null) {
    const active = db || await getDb();
    if (!Array.isArray(ids) || ids.length === 0) return { paused: 0, stoppingIds: [] };
    let paused = 0;
    const stoppingIds = [];
    const pausableSet = new Set(['PENDING', 'ERROR', 'COOLDOWN', 'PAUSED', 'ON_PROGRESS']);

    const client = active.connect ? await active.connect() : active;
    const needsRelease = typeof active.connect === 'function';

    try {
        await client.query('BEGIN');
        for (const rawId of ids) {
            let gid;
            try { gid = normalizeGalleryId(rawId); } catch (e) { continue; }
            const row = await getQueueItem(gid, client);
            if (!row) continue;
            const st = String(row.status || '').toUpperCase();
            const isPausable = pausableSet.has(st) || st.startsWith('ERROR') || st.startsWith('COOLDOWN') || st.startsWith('PAUSED');
            if (!isPausable) continue;

            if (st === 'ON_PROGRESS') {
                stoppingIds.push(toPublicId(gid));
            }
            await updateQueueItem(gid, { status: 'STOPPED' }, client);
            paused++;
        }
        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        throw err;
    } finally {
        if (needsRelease) client.release();
    }

    return { paused, stoppingIds };
}

async function resumeQueueItems(ids = [], db = null) {
    const active = db || await getDb();
    if (!Array.isArray(ids) || ids.length === 0) return { resumed: 0, resumedIds: [] };
    let resumed = 0;
    const resumedIds = [];
    const resumableSet = new Set(['STOPPED', 'ERROR', 'COOLDOWN', 'PAUSED']);

    const client = active.connect ? await active.connect() : active;
    const needsRelease = typeof active.connect === 'function';

    try {
        await client.query('BEGIN');
        for (const rawId of ids) {
            let gid;
            try { gid = normalizeGalleryId(rawId); } catch (e) { continue; }
            const row = await getQueueItem(gid, client);
            if (!row) continue;
            const st = String(row.status || '').toUpperCase();
            const isResumable = resumableSet.has(st) || st.startsWith('ERROR') || st.startsWith('COOLDOWN') || st.startsWith('PAUSED');
            if (!isResumable) continue;

            await updateQueueItem(gid, { status: 'PENDING', error: null }, client);
            resumed++;
            resumedIds.push(toPublicId(gid));
        }
        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        throw err;
    } finally {
        if (needsRelease) client.release();
    }

    return { resumed, resumedIds };
}

async function deleteQueueItems(ids = [], db = null) {
    const active = db || await getDb();
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0, stoppingIds: [] };
    let deleted = 0;
    const stoppingIds = [];

    const client = active.connect ? await active.connect() : active;
    const needsRelease = typeof active.connect === 'function';

    try {
        await client.query('BEGIN');
        for (const rawId of ids) {
            let gid;
            try { gid = normalizeGalleryId(rawId); } catch (e) { continue; }
            const row = await getQueueItem(gid, client);
            if (!row) continue;
            if (row.status === 'ON_PROGRESS') {
                stoppingIds.push(toPublicId(gid));
            }
            deleted += await deleteQueueItem(gid, client);
        }
        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        throw err;
    } finally {
        if (needsRelease) client.release();
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

    const res = await active.query(`
        SELECT id, gallery_id, priority
        FROM queue
        ORDER BY priority DESC, id ASC
    `);
    const rows = res.rows;
    if (rows.length === 0) return { updated: 0 };

    let selectedCount = 0;
    for (let i = 0; i < rows.length; i++) {
        if (targetSet.has(String(rows[i].gallery_id))) selectedCount++;
    }
    if (selectedCount === 0) return { updated: 0 };

    const changedItems = [];
    const client = active.connect ? await active.connect() : active;
    const needsRelease = typeof active.connect === 'function';

    try {
        await client.query('BEGIN');

        if (action === 'top') {
            const maxP = rows.reduce((m, r) => Math.max(m, Number(r.priority) || 0), 0);
            const selectedRows = rows.filter(r => targetSet.has(String(r.gallery_id)));
            for (let i = 0; i < selectedRows.length; i++) {
                const newP = maxP + (selectedRows.length - i);
                const gid = String(selectedRows[i].gallery_id);
                if (Number(selectedRows[i].priority) !== newP) {
                    await client.query(`UPDATE queue SET priority = $1, updated_at = now() WHERE gallery_id = $2`, [newP, gid]);
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
                    await client.query(`UPDATE queue SET priority = $1, updated_at = now() WHERE gallery_id = $2`, [newP, gid]);
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
                        await client.query(`UPDATE queue SET priority = $1, updated_at = now() WHERE gallery_id = $2`, [slotPriority, gid]);
                        changedItems.push({ galleryId: toPublicId(gid), priority: slotPriority });
                    }
                }
            } else {
                for (let idx = 0; idx < total; idx++) {
                    const r = reordered[idx];
                    const desiredPriority = total - idx;
                    if (Number(r.priority) !== desiredPriority) {
                        const gid = String(r.gallery_id);
                        await client.query(`UPDATE queue SET priority = $1, updated_at = now() WHERE gallery_id = $2`, [desiredPriority, gid]);
                        changedItems.push({ galleryId: toPublicId(gid), priority: desiredPriority });
                    }
                }
            }
        }

        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        throw err;
    } finally {
        if (needsRelease) client.release();
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
    const res = await active.query(`DELETE FROM queue WHERE batch = $1`, [batchNum]);
    const changes = res.rowCount || 0;
    if (changes > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        dbEvents.emit('batch_deleted', { batch: batchNum, batchCount });
        dbEvents.emit('item', { type: 'batch_deleted', batch: batchNum, batchCount });
    }
    return changes;
}

async function clearCompletedQueue(db = null) {
    const active = db || await getDb();
    const res = await active.query(`
        DELETE FROM queue
        WHERE status = 'DONE' OR status LIKE 'SKIPPED%'
        RETURNING gallery_id
    `);
    const changes = res.rows.length;
    if (changes > 0) {
        const batchCount = Math.max(1, await getMaxBatch(active));
        const removedIds = res.rows.map(r => toPublicId(r.gallery_id));
        dbEvents.emit('item', { type: 'cleared', removedIds, batchCount });
    }
    return changes;
}

async function getMaxBatch(db = null) {
    const active = db || await getDb();
    const res = await active.query(`SELECT COALESCE(MAX(batch), 0) AS max_batch FROM queue`);
    return res.rows[0] ? Number(res.rows[0].max_batch) : 0;
}

async function importListText(text, options = {}, db = null) {
    const active = db || await getDb();
    const { replace = false, defaultFormat = null } = options;
    const { items: parsedItems, ignored } = parseListTextDetailed(text, defaultFormat);
    const galleryIds = parsedItems.map(i => i.galleryId);

    let added = 0;
    let updated = 0;
    let duplicates = 0;

    const client = active.connect ? await active.connect() : active;
    const needsRelease = typeof active.connect === 'function';

    try {
        await client.query('BEGIN');
        if (replace) {
            const keepSet = new Set(galleryIds.map(g => String(g)));
            const res = await client.query(`SELECT gallery_id FROM queue`);
            for (const r of res.rows) {
                if (!keepSet.has(String(r.gallery_id))) {
                    await deleteQueueItem(r.gallery_id, client);
                }
            }
        }

        for (const item of parsedItems) {
            const existing = await getQueueItem(item.galleryId, client);
            let libEntry = await getLibraryEntry(item.galleryId, client);
            const isPermanentSkip = !!(libEntry && libEntry.skipped);
            const isValidLib = !!(libEntry && !libEntry.skipped && libEntry.path && fs.existsSync(libEntry.path));

            if (libEntry && !isPermanentSkip && !isValidLib) {
                await deleteLibraryEntry(item.galleryId, client);
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
                }, client);
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
                await updateQueueItem(item.galleryId, updates, client);
                updated++;
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        throw err;
    } finally {
        if (needsRelease) client.release();
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
        const baseUrl = row.url || `https://nhentai.net/g/${row.gallery_id}/`;
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

    await active.query(`
        INSERT INTO library (gallery_id, title, path, pages, format, language, artist, added_at, meta)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT(gallery_id) DO UPDATE SET
            title = EXCLUDED.title,
            path = EXCLUDED.path,
            pages = EXCLUDED.pages,
            format = EXCLUDED.format,
            language = EXCLUDED.language,
            artist = EXCLUDED.artist,
            added_at = EXCLUDED.added_at,
            meta = COALESCE(EXCLUDED.meta, library.meta)
    `, [galleryId, title, folderPath, pages, format, language, artist, addedAt, metaJson]);

    if (format !== 'skipped') {
        hasActiveEntriesCache = true;
    }

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
    const addedAtStr = row.added_at instanceof Date ? row.added_at.toISOString() : String(row.added_at);
    return {
        gallery_id: toPublicId(row.gallery_id),
        id: String(row.gallery_id),
        title: row.title,
        path: row.path,
        folder: row.path,
        pages: Number(row.pages || 0),
        format: row.format || 'folder',
        language: row.language,
        lang: row.language,
        artist: row.artist,
        author: row.artist,
        added_at: addedAtStr,
        downloadedAt: addedAtStr,
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
    const res = await active.query(`SELECT * FROM library WHERE gallery_id = $1`, [id]);
    return parseLibraryRow(res.rows[0]);
}

async function getAllLibraryEntries(db = null) {
    const active = db || await getDb();
    const res = await active.query(`SELECT * FROM library ORDER BY added_at DESC, gallery_id DESC`);
    return res.rows.map(parseLibraryRow);
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
    const res = await active.query(`DELETE FROM library WHERE gallery_id = $1`, [id]);
    return res.rowCount || 0;
}

function hasActiveLibraryEntries(targetDb = null) {
    return hasActiveEntriesCache;
}

async function getSetting(key, defaultValue = undefined, db = null) {
    const active = db || await getDb();
    const res = await active.query(`SELECT value FROM settings WHERE key = $1`, [String(key)]);
    if (res.rows.length === 0) return defaultValue;
    const raw = res.rows[0].value;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return raw;
    }
}

async function setSetting(key, value, db = null) {
    const active = db || await getDb();
    const encoded = JSON.stringify(value);
    await active.query(`
        INSERT INTO settings (key, value) VALUES ($1, $2)
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `, [String(key), encoded]);
    return value;
}

async function getAllSettings(db = null) {
    const active = db || await getDb();
    const res = await active.query(`SELECT key, value FROM settings`);
    const out = {};
    for (const r of res.rows) {
        try {
            out[r.key] = JSON.parse(r.value);
        } catch (e) {
            out[r.key] = r.value;
        }
    }
    return out;
}

async function migrateLegacyConfigJson(configPath, db = null) {
    // Legacy config migration is primarily for local SQLite migrations
    return false;
}

async function logEvent({ level = 'info', galleryId = null, message = '', maxRows = 10000 }, db = null) {
    const active = db || await getDb();
    const gid = galleryId !== null && galleryId !== undefined && String(galleryId).trim() !== ''
        ? (canonicalKey(galleryId) || null)
        : null;

    await active.query(`
        INSERT INTO events (ts, level, gallery_id, message)
        VALUES (now(), $1, $2, $3)
    `, [level, gid, String(message)]);

    if (maxRows && maxRows > 0) {
        await active.query(`
            DELETE FROM events
            WHERE id NOT IN (
                SELECT id FROM events ORDER BY id DESC LIMIT $1
            )
        `, [maxRows]);
    }
}

async function getEvents(options = {}, db = null) {
    const active = db || await getDb();
    const clauses = [];
    const params = [];

    if (options.level) {
        params.push(options.level);
        clauses.push(`level = $${params.length}`);
    }
    if (options.galleryId !== undefined && options.galleryId !== null) {
        params.push(normalizeGalleryId(options.galleryId));
        clauses.push(`gallery_id = $${params.length}`);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 5000;
    params.push(limit);

    const res = await active.query(`
        SELECT * FROM (
            SELECT * FROM events ${whereSql} ORDER BY id DESC LIMIT $${params.length}
        ) t ORDER BY id ASC
    `, params);

    return res.rows.map(r => ({
        ...r,
        id: Number(r.id),
        gallery_id: r.gallery_id ? toPublicId(r.gallery_id) : null,
        ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts)
    }));
}

async function exportData(db = null) {
    const active = db || await getDb();
    const schemaVersion = await getSchemaVersion(active);
    const queueRes = await active.query(`SELECT * FROM queue ORDER BY batch ASC, id ASC`);
    const libRes = await active.query(`SELECT * FROM library ORDER BY added_at DESC, gallery_id DESC`);
    const setRes = await active.query(`SELECT * FROM settings ORDER BY key ASC`);
    const evtRes = await active.query(`SELECT * FROM events ORDER BY id ASC`);

    const queue = queueRes.rows.map(r => ({
        ...r,
        id: Number(r.id),
        gallery_id: toPublicId(r.gallery_id),
        batch: Number(r.batch || 1),
        priority: Number(r.priority || 0),
        pages_done: Number(r.pages_done || 0),
        pages_total: Number(r.pages_total || 0),
        retries: Number(r.retries || 0),
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at)
    }));

    const library = libRes.rows.map(r => ({
        ...r,
        gallery_id: toPublicId(r.gallery_id),
        pages: Number(r.pages || 0),
        added_at: r.added_at instanceof Date ? r.added_at.toISOString() : String(r.added_at)
    }));

    const settings = setRes.rows;
    const events = evtRes.rows.map(r => ({
        ...r,
        id: Number(r.id),
        gallery_id: r.gallery_id ? toPublicId(r.gallery_id) : null,
        ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts)
    }));

    return {
        format: 'nhdl-export',
        version: 1,
        exported_at: new Date().toISOString(),
        db_type: 'postgres',
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
    const active = db || options.db || await getDb();
    const appSchemaVer = (await getSchemaVersion(active)) || CURRENT_APP_SCHEMA_VERSION;
    validateImportPayload(payload, options, appSchemaVer);

    const mode = options.mode === 'merge' ? 'merge' : 'replace';
    const tables = payload?.tables || {};
    const queueRows = Array.isArray(tables.queue) ? tables.queue : [];
    const libraryRows = Array.isArray(tables.library) ? tables.library : [];
    const settingsRows = Array.isArray(tables.settings) ? tables.settings : [];
    const eventsRows = Array.isArray(tables.events) ? tables.events : [];

    let imported = { queue: 0, library: 0, settings: 0, events: 0 };

    const client = active.connect ? await active.connect() : active;
    const needsRelease = typeof active.connect === 'function';

    try {
        await client.query('BEGIN');
        if (mode === 'replace') {
            await client.query(`TRUNCATE TABLE queue, library, settings, events RESTART IDENTITY;`);
        }

        for (const r of queueRows) {
            const gid = normalizeGalleryId(r.gallery_id || r.galleryId);
            const url = r.url || `https://nhentai.net/g/${gid}/`;
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

            const res = await client.query(`
                INSERT INTO queue (
                    gallery_id, url, title, status, batch, priority,
                    pages_done, pages_total, error, retries, created_at, updated_at, format
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (gallery_id) DO ${mode === 'merge' ? 'NOTHING' : `UPDATE SET
                    url = EXCLUDED.url,
                    title = EXCLUDED.title,
                    status = EXCLUDED.status,
                    batch = EXCLUDED.batch,
                    priority = EXCLUDED.priority,
                    pages_done = EXCLUDED.pages_done,
                    pages_total = EXCLUDED.pages_total,
                    error = EXCLUDED.error,
                    retries = EXCLUDED.retries,
                    updated_at = EXCLUDED.updated_at,
                    format = EXCLUDED.format`}
            `, [gid, url, title, status, batch, priority, pagesDone, pagesTotal, error, retries, createdAt, updatedAt, format]);
            if (res.rowCount > 0) imported.queue++;
        }

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

            const res = await client.query(`
                INSERT INTO library (gallery_id, title, path, pages, format, language, artist, added_at, meta)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (gallery_id) DO ${mode === 'merge' ? 'NOTHING' : `UPDATE SET
                    title = EXCLUDED.title,
                    path = EXCLUDED.path,
                    pages = EXCLUDED.pages,
                    format = EXCLUDED.format,
                    language = EXCLUDED.language,
                    artist = EXCLUDED.artist,
                    added_at = EXCLUDED.added_at,
                    meta = EXCLUDED.meta`}
            `, [gid, title, p, pages, format, language, artist, addedAt, meta]);
            if (res.rowCount > 0) imported.library++;
        }

        for (const r of settingsRows) {
            const key = String(r.key);
            const val = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
            const res = await client.query(`
                INSERT INTO settings (key, value) VALUES ($1, $2)
                ON CONFLICT (key) DO ${mode === 'merge' ? 'NOTHING' : 'UPDATE SET value = EXCLUDED.value'}
            `, [key, val]);
            if (res.rowCount > 0) imported.settings++;
        }

        for (const r of eventsRows) {
            const ts = r.ts || new Date().toISOString();
            const level = r.level || 'info';
            const gid = r.gallery_id ? normalizeGalleryId(r.gallery_id) : null;
            const msg = String(r.message || '');
            const res = await client.query(`
                INSERT INTO events (ts, level, gallery_id, message)
                VALUES ($1, $2, $3, $4)
            `, [ts, level, gid, msg]);
            if (res.rowCount > 0) imported.events++;
        }

        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        throw err;
    } finally {
        if (needsRelease) client.release();
    }

    try {
        const checkLib = await active.query(`SELECT 1 FROM library WHERE format IS NULL OR format != 'skipped' LIMIT 1`);
        hasActiveEntriesCache = checkLib.rows.length > 0;
    } catch (e) {}

    const batchCount = Math.max(1, await getMaxBatch(active));
    dbEvents.emit('reloaded', { batchCount });

    return {
        success: true,
        mode,
        imported
    };
}

module.exports = {
    connectWithRetry,
    dbEvents,
    MIGRATIONS,
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
