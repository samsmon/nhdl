const { logEvent, getEvents } = require('./db');

const MAX_EVENT_ROWS = 10000;
const MAX_ACTIVITY_READ = 5000;
const MAX_ERROR_READ = 200;

function setLogDir() {
    // Kept as a no-op for backward compatibility; all logs now live in SQLite `events` table.
}

function inferLevelAndGallery(message, explicitLevel, explicitGalleryId) {
    const str = String(message || '');
    let level = explicitLevel;
    if (!level) {
        if (/^(FATAL|ERROR|CIRCUIT BREAKER)\b/i.test(str)) level = 'error';
        else if (/^(WARN|RATE LIMIT|\[PLACEHOLDER\])/i.test(str)) level = 'warn';
        else level = 'info';
    }

    let galleryId = explicitGalleryId ?? null;
    if (galleryId === null || galleryId === undefined) {
        const m = str.match(/\bID:?\s*(\d{1,10})\b/i);
        if (m) galleryId = parseInt(m[1], 10);
    }

    return { level, galleryId };
}

async function logActivity(message, options = {}) {
    const { level, galleryId } = inferLevelAndGallery(message, options.level, options.galleryId);
    try {
        await logEvent({
            level,
            galleryId,
            message: String(message || ''),
            maxRows: MAX_EVENT_ROWS
        });
    } catch (e) {
        console.log(`[${new Date().toISOString()}] ${message} [sqlite events write failed: ${e.message}]`);
    }
}

async function logErrorEvent(galleryId, message) {
    const cleanMsg = String(message || '');
    try {
        await logEvent({
            level: 'error',
            galleryId,
            message: `ID: ${galleryId} - ${cleanMsg}`,
            maxRows: MAX_EVENT_ROWS
        });
    } catch (e) {
        console.error(`[${new Date().toISOString()}] ID: ${galleryId} - ${cleanMsg} [sqlite events write failed: ${e.message}]`);
    }
}

async function readActivityLog(limit = MAX_ACTIVITY_READ) {
    try {
        const rows = await getEvents({ limit });
        if (!rows || rows.length === 0) return '';
        return rows.map(r => `[${r.ts}] ${r.message}`).join('\n') + '\n';
    } catch (e) {
        return '';
    }
}

async function readErrorLog(limit = MAX_ERROR_READ) {
    try {
        const rows = await getEvents({ level: 'error', limit });
        if (!rows || rows.length === 0) return '';
        return rows.map(r => `[${r.ts}] ${r.message}`).join('\n') + '\n';
    } catch (e) {
        return '';
    }
}

module.exports = {
    logActivity,
    logErrorEvent,
    readActivityLog,
    readErrorLog,
    setLogDir
};
