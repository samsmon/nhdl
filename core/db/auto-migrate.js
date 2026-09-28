const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const sqliteAdapter = require('./sqlite');
const postgresAdapter = require('./postgres');

async function autoMigrateSqliteToPostgres(postgresPool, options = {}) {
    const sqlitePath = options.sqlitePath || sqliteAdapter.DEFAULT_DB_PATH;
    if (!fs.existsSync(sqlitePath)) return false;

    try {
        // Check if Postgres queue & library are both empty
        const qCountRes = await postgresPool.query(`SELECT COUNT(*) AS cnt FROM queue`);
        const lCountRes = await postgresPool.query(`SELECT COUNT(*) AS cnt FROM library`);
        const qCount = Number(qCountRes.rows[0]?.cnt || 0);
        const lCount = Number(lCountRes.rows[0]?.cnt || 0);
        if (qCount > 0 || lCount > 0) {
            return false; // Target Postgres is not empty
        }

        // Open SQLite and check if it has data
        let sqliteDb = null;
        let hasData = false;
        let exported = null;
        try {
            sqliteDb = new DatabaseSync(sqlitePath);
            const sqQueue = sqliteDb.prepare(`SELECT 1 FROM queue LIMIT 1`).get();
            const sqLib = sqliteDb.prepare(`SELECT 1 FROM library LIMIT 1`).get();
            if (sqQueue || sqLib) {
                hasData = true;
                console.log(`[+] Found existing SQLite database, auto-migrating to PostgreSQL...`);
                exported = await sqliteAdapter.exportData(sqliteDb);
            }
        } catch (e) {
            hasData = false;
        } finally {
            if (sqliteDb) {
                try { sqliteDb.close(); } catch (e) {}
            }
        }

        if (!hasData || !exported) return false;

        // Import into Postgres
        const importRes = await postgresAdapter.importData(exported, { mode: 'replace' }, postgresPool);

        // Rename SQLite file to .migrated so it won't migrate again
        const migratedPath = `${sqlitePath}.migrated`;
        try {
            if (fs.existsSync(migratedPath)) {
                fs.unlinkSync(migratedPath);
            }
            fs.renameSync(sqlitePath, migratedPath);
            // Cleanup wal/shm if present
            try { if (fs.existsSync(`${sqlitePath}-wal`)) fs.unlinkSync(`${sqlitePath}-wal`); } catch (e) {}
            try { if (fs.existsSync(`${sqlitePath}-shm`)) fs.unlinkSync(`${sqlitePath}-shm`); } catch (e) {}
        } catch (err) {
            console.warn(`[!] Note: could not rename ${sqlitePath}: ${err.message}`);
        }

        const msg = `Migration complete: ${importRes.imported.queue} queue items, ${importRes.imported.library} library entries transferred`;
        console.log(`[+] ${msg}`);
        try {
            await postgresAdapter.logEvent({ level: 'info', message: msg }, postgresPool);
        } catch (e) {}

        return {
            migrated: true,
            imported: importRes.imported,
            migratedPath
        };
    } catch (err) {
        console.warn(`[!] Auto-migration check failed: ${err.message}`);
        return false;
    }
}

module.exports = {
    autoMigrateSqliteToPostgres
};
