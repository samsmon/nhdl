const path = require('path');
const sqliteAdapter = require('./db/sqlite');
const postgresAdapter = require('./db/postgres');
const { dbEvents } = require('./db/events');
const { normalizeGalleryId, formatQueueRow, maskDatabaseUrl } = require('./db/common');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = sqliteAdapter.DEFAULT_DB_PATH;

let activeAdapter = null;
let activeType = null;

function resolveAdapterType(dbPathOrUrl, options = {}) {
    if (typeof dbPathOrUrl === 'string' && (dbPathOrUrl.startsWith('postgres://') || dbPathOrUrl.startsWith('postgresql://'))) {
        return 'postgres';
    }
    if (options.type === 'postgres' || options.databaseUrl) {
        return 'postgres';
    }
    if ((!dbPathOrUrl || dbPathOrUrl === DEFAULT_DB_PATH) && process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
        return 'postgres';
    }
    return 'sqlite';
}

async function initDb(dbPathOrUrl = null, options = {}) {
    const type = resolveAdapterType(dbPathOrUrl, options);
    if (type === 'postgres') {
        const url = (typeof dbPathOrUrl === 'string' && (dbPathOrUrl.startsWith('postgres://') || dbPathOrUrl.startsWith('postgresql://')))
            ? dbPathOrUrl
            : (options.databaseUrl || process.env.DATABASE_URL);
        activeType = 'postgres';
        activeAdapter = postgresAdapter;
        const pool = await postgresAdapter.initDb(url, options);
        if (options.skipAutoMigrate !== true) {
            const { autoMigrateSqliteToPostgres } = require('./db/auto-migrate');
            await autoMigrateSqliteToPostgres(pool, options);
        }
        return pool;
    } else {
        const targetPath = (typeof dbPathOrUrl === 'string' && !dbPathOrUrl.startsWith('postgres://') && !dbPathOrUrl.startsWith('postgresql://'))
            ? dbPathOrUrl
            : DEFAULT_DB_PATH;
        activeType = 'sqlite';
        activeAdapter = sqliteAdapter;
        return await sqliteAdapter.initDb(targetPath, options);
    }
}

async function getDb() {
    if (!activeAdapter) {
        await initDb();
    }
    return await activeAdapter.getDb();
}

async function closeDb() {
    if (activeAdapter) {
        const adapter = activeAdapter;
        activeAdapter = null;
        activeType = null;
        await adapter.closeDb();
    }
}

function getDatabaseType() {
    return activeType || (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '' ? 'postgres' : 'sqlite');
}

function getDbInfo() {
    if (!activeAdapter) {
        const type = getDatabaseType();
        if (type === 'postgres') {
            return {
                type: 'postgres',
                connected: false,
                maskedUrl: maskDatabaseUrl(process.env.DATABASE_URL)
            };
        }
        return {
            type: 'sqlite',
            connected: false,
            path: DEFAULT_DB_PATH
        };
    }
    return activeAdapter.getDbInfo();
}

function hasActiveLibraryEntries(targetDb = null) {
    if (activeAdapter && typeof activeAdapter.hasActiveLibraryEntries === 'function') {
        return activeAdapter.hasActiveLibraryEntries(targetDb);
    }
    return sqliteAdapter.hasActiveLibraryEntries(targetDb);
}

async function getSchemaVersion(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getSchemaVersion(db);
}

async function runMigrations(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.runMigrations(db);
}

async function resetStuckQueueItems(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.resetStuckQueueItems(db);
}

async function requeueFailedItems(options = {}, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.requeueFailedItems(options, db);
}

async function enqueueGallery(gallery, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.enqueueGallery(gallery, db);
}

async function getQueueItem(galleryId, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getQueueItem(galleryId, db);
}

async function getNextPendingItem(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getNextPendingItem(db);
}

async function getQueueItems(options = {}, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getQueueItems(options, db);
}

async function updateQueueItem(galleryId, fields = {}, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.updateQueueItem(galleryId, fields, db);
}

async function updateQueueStatus(galleryId, status, extra = {}, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.updateQueueStatus(galleryId, status, extra, db);
}

async function deleteQueueItem(galleryId, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.deleteQueueItem(galleryId, db);
}

async function pauseQueueItems(ids = [], db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.pauseQueueItems(ids, db);
}

async function resumeQueueItems(ids = [], db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.resumeQueueItems(ids, db);
}

async function deleteQueueItems(ids = [], db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.deleteQueueItems(ids, db);
}

async function updateQueuePriority(ids = [], action = 'top', db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.updateQueuePriority(ids, action, db);
}

async function deleteQueueBatch(batchNum, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.deleteQueueBatch(batchNum, db);
}

async function clearCompletedQueue(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.clearCompletedQueue(db);
}

async function getMaxBatch(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getMaxBatch(db);
}

function parseListText(text, defaultFormat = null) {
    return sqliteAdapter.parseListText(text, defaultFormat);
}

async function importListText(text, options = {}, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.importListText(text, options, db);
}

async function exportListText(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.exportListText(db);
}

async function upsertLibraryEntry(entry, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.upsertLibraryEntry(entry, db);
}

async function getLibraryEntry(galleryId, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getLibraryEntry(galleryId, db);
}

async function getAllLibraryEntries(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getAllLibraryEntries(db);
}

async function getLibraryMap(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getLibraryMap(db);
}

async function deleteLibraryEntry(galleryId, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.deleteLibraryEntry(galleryId, db);
}

async function getSetting(key, defaultValue = undefined, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getSetting(key, defaultValue, db);
}

async function setSetting(key, value, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.setSetting(key, value, db);
}

async function getAllSettings(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getAllSettings(db);
}

async function migrateLegacyConfigJson(configPath = path.join(ROOT_DIR, 'config.json'), db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.migrateLegacyConfigJson(configPath, db);
}

async function logEvent(entry, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.logEvent(entry, db);
}

async function getEvents(options = {}, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.getEvents(options, db);
}

async function exportData(db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.exportData(db);
}

async function importData(payload, options = {}, db = null) {
    if (!activeAdapter) await initDb();
    return await activeAdapter.importData(payload, options, db);
}

const backupMod = require('./db/backup');

module.exports = {
    DEFAULT_DB_PATH,
    dbEvents,
    initDb,
    getDb,
    closeDb,
    getDatabaseType,
    getDbInfo,
    getSchemaVersion,
    runMigrations,
    resetStuckQueueItems,
    requeueFailedItems,
    formatQueueRow,
    normalizeGalleryId,
    maskDatabaseUrl,
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
    importData,
    BACKUP_DIR: backupMod.BACKUP_DIR,
    createBackup: backupMod.createBackup,
    listBackups: backupMod.listBackups,
    restoreBackup: backupMod.restoreBackup,
    deleteBackup: backupMod.deleteBackup,
    rotateBackups: backupMod.rotateBackups,
    setupAutoBackup: backupMod.setupAutoBackup,
    stopAutoBackup: backupMod.stopAutoBackup,
    autoMigrateSqliteToPostgres: require('./db/auto-migrate').autoMigrateSqliteToPostgres
};
