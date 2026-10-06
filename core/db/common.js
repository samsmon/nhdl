const { canonicalKey, toPublicId, sourceOf } = require('../providers');

function normalizeGalleryId(galleryId) {
    const key = canonicalKey(galleryId);
    if (!key) {
        throw new Error(`Invalid gallery_id: ${galleryId}`);
    }
    return key;
}

function formatQueueRow(r) {
    if (!r) return null;
    const displayStatus = r.error ? `${r.status} - ${r.error}` : r.status;
    const displayUrl = r.title ? `${r.url} | ${r.title}` : r.url;
    return {
        id: r.id,
        galleryId: toPublicId(r.gallery_id),
        source: sourceOf(r.gallery_id),
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
        format: r.format || null,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
    };
}

function publicRow(row) {
    return row ? { ...row, gallery_id: toPublicId(row.gallery_id) } : row;
}

function maskDatabaseUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        if (parsed.password) {
            parsed.password = '***';
        }
        return parsed.toString();
    } catch {
        return url.replace(/:([^:@/]+)@/, ':***@');
    }
}

const CURRENT_APP_SCHEMA_VERSION = 3;

function isValidGalleryId(rawId) {
    return canonicalKey(rawId) !== null;
}

function validateImportPayload(payload, options = {}, appSchemaVersion = CURRENT_APP_SCHEMA_VERSION) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Import payload must be an object');
    }
    if (payload.format !== 'nhdl-export') {
        throw new Error(`Invalid import format: expected "nhdl-export", got "${payload.format}"`);
    }
    const knownVersions = [1];
    if (!knownVersions.includes(payload.version)) {
        throw new Error(`Unknown export version: ${payload.version}`);
    }
    if (!payload.tables || typeof payload.tables !== 'object' || Array.isArray(payload.tables)) {
        throw new Error('Import payload "tables" property must be an object');
    }
    for (const [tableName, rows] of Object.entries(payload.tables)) {
        if (!Array.isArray(rows)) {
            throw new Error(`Table "${tableName}" in import payload must be an array`);
        }
    }

    const payloadSchemaVer = payload.schemaVersion ?? payload.schema_version;
    const parsedSchemaVer = payloadSchemaVer !== undefined && payloadSchemaVer !== null ? Number(payloadSchemaVer) : null;
    if (parsedSchemaVer !== null && Number.isFinite(parsedSchemaVer) && parsedSchemaVer > appSchemaVersion) {
        throw new Error(`Payload schema version (${parsedSchemaVer}) is newer than application schema version (${appSchemaVersion})`);
    }

    const queueRows = Array.isArray(payload.tables.queue) ? payload.tables.queue : [];
    const libraryRows = Array.isArray(payload.tables.library) ? payload.tables.library : [];

    for (let i = 0; i < queueRows.length; i++) {
        const r = queueRows[i];
        if (!r || typeof r !== 'object') {
            throw new Error(`Invalid queue row at index ${i}`);
        }
        const rawId = r.gallery_id ?? r.galleryId;
        if (!isValidGalleryId(rawId)) {
            throw new Error(`Invalid or missing gallery_id in queue row at index ${i}: ${rawId}`);
        }
    }

    for (let i = 0; i < libraryRows.length; i++) {
        const r = libraryRows[i];
        if (!r || typeof r !== 'object') {
            throw new Error(`Invalid library row at index ${i}`);
        }
        const rawId = r.gallery_id ?? r.galleryId;
        if (!isValidGalleryId(rawId)) {
            throw new Error(`Invalid or missing gallery_id in library row at index ${i}: ${rawId}`);
        }
    }

    const mode = options.mode === 'merge' ? 'merge' : 'replace';
    if (mode === 'replace' && queueRows.length === 0 && libraryRows.length === 0 && options.allowEmpty !== true) {
        throw new Error('Import payload contains no queue or library items for replace mode (set allowEmpty: true to allow)');
    }
}

module.exports = {
    CURRENT_APP_SCHEMA_VERSION,
    normalizeGalleryId,
    isValidGalleryId,
    formatQueueRow,
    toPublicId,
    publicRow,
    maskDatabaseUrl,
    validateImportPayload
};
