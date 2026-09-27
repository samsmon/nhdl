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

function logActivity(message, options = {}) {
    const { level, galleryId } = inferLevelAndGallery(message, options.level, options.galleryId);
    try {
        logEvent({
            level,
            galleryId,
            message: String(message || ''),
            maxRows: MAX_EVENT_ROWS
        });
    } catch (e) {
        console.log(`[${new Date().toISOString()}] ${message} [sqlite events write failed: ${e.message}]`);
    }
}

function logErrorEvent(galleryId, message) {
    const cleanMsg = String(message || '');
    try {
        logEvent({
            level: 'error',
            galleryId,
            message: `ID: ${galleryId} - ${cleanMsg}`,
            maxRows: MAX_EVENT_ROWS
        });
    } catch (e) {
        console.error(`[${new Date().toISOString()}] ID: ${galleryId} - ${cleanMsg} [sqlite events write failed: ${e.message}]`);
    }
}

function readActivityLog(limit = MAX_ACTIVITY_READ) {
    try {
        const rows = getEvents({ limit });
        if (!rows || rows.length === 0) return '';
        return rows.map(r => `[${r.ts}] ${r.message}`).join('\n') + '\n';
    } catch (e) {
        return '';
    }
}

function readErrorLog(limit = MAX_ERROR_READ) {
    try {
        const rows = getEvents({ level: 'error', limit });
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
