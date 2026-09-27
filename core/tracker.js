const fs = require('fs');
const path = require('path');
const { sanitizeName } = require('./utils');
const { buildZip } = require('./zip');
const {
    getLibraryEntry,
    getAllLibraryEntries,
    getLibraryMap,
    upsertLibraryEntry,
    deleteLibraryEntry,
    getQueueItem,
    getQueueItems,
    updateQueueItem,
    updateQueueStatus,
    importListText,
    logEvent
} = require('./db');
const { logErrorEvent } = require('./logger');

const MARKER_FILENAME = '.nhdl-id';

function setStateDir() {
    // Kept as a no-op for backward compatibility; state is stored in data/nhdl.db
}

function archiveMarkerPath(archivePath) {
    return archivePath + MARKER_FILENAME;
}

function loadLibrary() {
    return getLibraryMap();
}

function saveToLibrary(id, title, folder, pages, ext, pageExts = {}, extra = {}) {
    try {
        const meta = {
            ext: ext || 'jpg',
            pageExts: pageExts || {},
            ...(extra.extraMeta ? extra.extraMeta : {})
        };
        upsertLibraryEntry({
            galleryId: id,
            title,
            path: folder,
            pages,
            format: 'folder',
            language: extra.lang || null,
            artist: extra.author || null,
            meta
        });

        try {
            fs.writeFileSync(path.join(folder, MARKER_FILENAME), id.toString(), 'utf-8');
        } catch (e) {}
    } catch (e) {
        console.error('Failed to save to SQLite library:', e.message);
    }
}

function saveArchivedToLibrary(id, title, archivePath, archiveExt, extra = {}) {
    try {
        const fmt = archiveExt === 'zip' ? 'zip' : 'cbz';
        upsertLibraryEntry({
            galleryId: id,
            title,
            path: archivePath,
            pages: extra.pages || 0,
            format: fmt,
            language: extra.lang || null,
            artist: extra.author || null,
            meta: extra.extraMeta || null
        });
        try {
            fs.writeFileSync(archiveMarkerPath(archivePath), id.toString(), 'utf-8');
        } catch (e) {}
    } catch (e) {
        console.error('Failed to save archived entry to SQLite library:', e.message);
    }
}

function saveArchivedGallery(id, title, archivePath, ext, extra = {}) {
    return saveArchivedToLibrary(id, title, archivePath, ext, extra);
}

function deriveLineageFromPath(targetPath, baseDownloadDir) {
    const parentDir = path.dirname(targetPath);
    const grandParentDir = path.dirname(parentDir);
    const normBase = path.resolve(baseDownloadDir);

    let artist = null;
    let language = null;

    if (path.resolve(parentDir) !== normBase) {
        artist = path.basename(parentDir);
        if (path.resolve(grandParentDir) !== normBase && path.resolve(grandParentDir) !== path.resolve(parentDir)) {
            language = path.basename(grandParentDir);
        }
    }
    return { artist, language };
}

function inspectFolderPages(folderPath) {
    let files = [];
    try {
        files = fs.readdirSync(folderPath).filter(f => /^\d+\.(jpg|jpeg|png|webp|gif)$/i.test(f));
    } catch (e) {}
    const pageExts = {};
    let maxPage = 0;
    let ext = 'jpg';
    for (const f of files) {
        const m = f.match(/^(\d+)\.(\w+)$/);
        if (m) {
            const p = parseInt(m[1], 10);
            pageExts[p] = m[2].toLowerCase();
            if (p === 1 || !ext) ext = m[2].toLowerCase();
            if (p > maxPage) maxPage = p;
        }
    }
    return { pages: maxPage || files.length, ext, pageExts };
}

// Reconciles and populates the SQLite `library` table from `.nhdl-id` and `<archive>.nhdl-id`
// marker files on disk inside `baseDownloadDir`.
function rescanLibrary(baseDownloadDir) {
    const result = { scanned: 0, relocated: 0, unchanged: 0, pruned: 0 };
    if (!baseDownloadDir || !fs.existsSync(baseDownloadDir)) return result;

    const MAX_DEPTH = 6;
    const stack = [{ dir: baseDownloadDir, depth: 0 }];

    while (stack.length > 0) {
        const { dir, depth } = stack.pop();
        let dirents;
        try {
            dirents = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            continue;
        }

        const hasMarker = dirents.some(d => d.isFile() && d.name === MARKER_FILENAME);
        if (hasMarker) {
            result.scanned++;
            try {
                const rawId = fs.readFileSync(path.join(dir, MARKER_FILENAME), 'utf-8').trim();
                const id = parseInt(rawId, 10);
                if (Number.isFinite(id) && id > 0) {
                    const existing = getLibraryEntry(id);
                    const { artist, language } = deriveLineageFromPath(dir, baseDownloadDir);
                    const { pages, ext, pageExts } = inspectFolderPages(dir);

                    if (!existing) {
                        upsertLibraryEntry({
                            galleryId: id,
                            title: path.basename(dir),
                            path: dir,
                            pages,
                            format: 'folder',
                            language,
                            artist,
                            meta: { ext, pageExts }
                        });
                        result.relocated++;
                    } else if (existing.path !== dir || existing.format !== 'folder') {
                        upsertLibraryEntry({
                            galleryId: id,
                            title: existing.title || path.basename(dir),
                            path: dir,
                            pages: pages || existing.pages,
                            format: 'folder',
                            language: existing.language || language,
                            artist: existing.artist || artist,
                            addedAt: existing.added_at,
                            meta: { ...(existing.meta || {}), ext, pageExts }
                        });
                        result.relocated++;
                    } else {
                        result.unchanged++;
                    }

                    const qItem = getQueueItem(id);
                    if (qItem && qItem.status !== 'DONE') {
                        updateQueueStatus(id, 'DONE', { pagesDone: pages, pagesTotal: pages });
                    }
                }
            } catch (e) {}
            continue;
        }

        for (const d of dirents) {
            if (!d.isFile() || !d.name.endsWith(MARKER_FILENAME) || d.name === MARKER_FILENAME) continue;
            const archivePath = path.join(dir, d.name.slice(0, -MARKER_FILENAME.length));
            if (!fs.existsSync(archivePath)) continue;
            result.scanned++;
            try {
                const rawId = fs.readFileSync(path.join(dir, d.name), 'utf-8').trim();
                const id = parseInt(rawId, 10);
                if (Number.isFinite(id) && id > 0) {
                    const existing = getLibraryEntry(id);
                    const extMatch = archivePath.match(/\.(cbz|zip)$/i);
                    const archiveExt = extMatch ? extMatch[1].toLowerCase() : 'cbz';
                    const baseTitle = path.basename(archivePath, path.extname(archivePath));
                    const { artist, language } = deriveLineageFromPath(archivePath, baseDownloadDir);

                    if (!existing) {
                        upsertLibraryEntry({
                            galleryId: id,
                            title: baseTitle,
                            path: archivePath,
                            pages: 0,
                            format: archiveExt,
                            language,
                            artist
                        });
                        result.relocated++;
                    } else if (existing.path !== archivePath || existing.format !== archiveExt) {
                        upsertLibraryEntry({
                            galleryId: id,
                            title: existing.title || baseTitle,
                            path: archivePath,
                            pages: existing.pages || 0,
                            format: archiveExt,
                            language: existing.language || language,
                            artist: existing.artist || artist,
                            addedAt: existing.added_at,
                            meta: existing.meta
                        });
                        result.relocated++;
                    } else {
                        result.unchanged++;
                    }

                    const qItem = getQueueItem(id);
                    if (qItem && qItem.status !== 'DONE') {
                        updateQueueStatus(id, 'DONE');
                    }
                }
            } catch (e) {}
        }

        if (depth < MAX_DEPTH) {
            for (const d of dirents) {
                if (d.isDirectory()) {
                    stack.push({ dir: path.join(dir, d.name), depth: depth + 1 });
                }
            }
        }
    }

    const allEntries = getAllLibraryEntries();
    for (const entry of allEntries) {
        if (entry.skipped) continue;
        if (entry.path && fs.existsSync(entry.path)) {
            const markerPath = entry.archived
                ? archiveMarkerPath(entry.path)
                : path.join(entry.path, MARKER_FILENAME);
            if (!fs.existsSync(markerPath)) {
                try {
                    fs.writeFileSync(markerPath, String(entry.gallery_id), 'utf-8');
                } catch (e) {}
            }
        } else {
            deleteLibraryEntry(entry.gallery_id);
            result.pruned++;
        }
    }

    return result;
}

function getBatchFormatForGallery(_listPath, galleryId) {
    try {
        const item = getQueueItem(galleryId);
        if (item && item.format) return item.format.toLowerCase();
    } catch (e) {}
    return null;
}

function buildDisplayName(title, author) {
    if (author && author !== 'Other' && author !== 'Unknown') {
        return `${author} - ${title}`;
    }
    return title;
}

function getCachedDisplayName(_listPath, galleryId) {
    try {
        const item = getQueueItem(galleryId);
        if (item && item.title) {
            const full = item.title.trim();
            const sepIdx = full.indexOf(' - ');
            if (sepIdx > 0) {
                return { author: full.slice(0, sepIdx), title: full.slice(sepIdx + 3) };
            }
            return { author: null, title: full };
        }
    } catch (e) {}
    return null;
}

function updateListDisplayName(_listPath, galleryId, displayName) {
    try {
        const item = getQueueItem(galleryId);
        if (item) {
            updateQueueItem(galleryId, { title: displayName });
        }
    } catch (e) {}
}

function trackerFileToListPath(trackerFile) {
    if (!trackerFile) return null;
    return trackerFile.replace(/_status\.txt$/, '.txt');
}

function isLibraryEntryValid(entry) {
    return !!(entry && !entry.skipped && entry.folder && fs.existsSync(entry.folder));
}

function isPermanentlySkipped(entry) {
    return !!(entry && entry.skipped === true);
}

function saveSkippedToLibrary(id, reason) {
    try {
        upsertLibraryEntry({
            galleryId: id,
            title: 'Skipped',
            path: '',
            pages: 0,
            format: 'skipped',
            meta: { skipped: true, reason, skippedAt: new Date().toISOString() }
        });
    } catch (e) {
        console.error('Failed to save skipped entry to SQLite library:', e.message);
    }
}

function logPlaceholderPage(galleryId, page, title) {
    const msg = `ID: ${galleryId} ("${title}") - page ${page} substituted with a blank image (CDN served placeholder)`;
    logEvent({ level: 'warn', galleryId, message: msg });
}

function logError(galleryId, message) {
    logErrorEvent(galleryId, message);
}

function parseCompoundStatus(rawStatus) {
    const str = String(rawStatus || 'PENDING').trim();
    const prefixes = ['SKIPPED', 'ERROR', 'COOLDOWN', 'PAUSED'];
    for (const prefix of prefixes) {
        if (str.toUpperCase().startsWith(prefix)) {
            const detail = str.slice(prefix.length).replace(/^\s*-\s*/, '').trim();
            return { status: prefix, error: detail || null };
        }
    }
    return { status: str, error: null };
}

function updateListStatus(_trackerFile, galleryId, newStatus) {
    try {
        const item = getQueueItem(galleryId);
        if (!item) return;
        const { status, error } = parseCompoundStatus(newStatus);
        updateQueueStatus(galleryId, status, { error });
    } catch (e) {}
}

function syncListTracker(listPathOrText) {
    if (typeof listPathOrText === 'string' && listPathOrText.trim() !== '') {
        if (fs.existsSync(listPathOrText)) {
            const content = fs.readFileSync(listPathOrText, 'utf-8');
            importListText(content, { replace: true });
        } else if (listPathOrText.includes('\n') || /\b\d{5,7}\b/.test(listPathOrText)) {
            importListText(listPathOrText, { replace: true });
        }
    }
    const rows = getQueueItems();
    const galleryIds = rows.map(r => String(r.gallery_id));
    return { galleryIds, trackerFile: null };
}

function renameLibraryEntry(id, newTitle) {
    const entry = getLibraryEntry(id);
    if (!entry || !entry.folder || !fs.existsSync(entry.folder)) {
        return { success: false, error: 'Gallery not found or its folder is missing' };
    }

    const trimmedTitle = (newTitle || '').trim();
    if (!trimmedTitle) return { success: false, error: 'Name cannot be empty' };

    const isArchive = !!entry.archived;
    const ext = isArchive ? path.extname(entry.folder) : '';
    const sanitized = sanitizeName(trimmedTitle) || String(id);
    const parentDir = path.dirname(entry.folder);
    const newPath = path.join(parentDir, sanitized + ext);

    if (newPath !== entry.folder) {
        if (fs.existsSync(newPath)) {
            return { success: false, error: 'Something with that name already exists in the same folder' };
        }
        try {
            fs.renameSync(entry.folder, newPath);
            if (isArchive && fs.existsSync(archiveMarkerPath(entry.folder))) {
                try {
                    fs.renameSync(archiveMarkerPath(entry.folder), archiveMarkerPath(newPath));
                } catch (e) {}
            }
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    upsertLibraryEntry({
        galleryId: id,
        title: trimmedTitle,
        path: newPath,
        pages: entry.pages,
        format: entry.format,
        language: entry.language,
        artist: entry.artist,
        addedAt: entry.added_at,
        meta: entry.meta
    });

    const qItem = getQueueItem(id);
    if (qItem) {
        updateQueueItem(id, { title: buildDisplayName(trimmedTitle, entry.author) });
    }

    return { success: true, folder: newPath };
}

function compressLibraryEntry(id, options = {}) {
    const ext = options.ext === 'zip' ? 'zip' : 'cbz';
    const entry = getLibraryEntry(id);
    if (!entry || !entry.folder || !fs.existsSync(entry.folder)) {
        return { success: false, error: 'Gallery not found or its folder is missing' };
    }
    if (entry.archived) {
        return { success: false, error: 'Already compressed', skipped: true };
    }

    let files;
    try {
        files = fs.readdirSync(entry.folder, { withFileTypes: true })
            .filter(d => d.isFile() && /^\d+\.(jpg|jpeg|png|webp|gif)$/i.test(d.name))
            .map(d => d.name)
            .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    } catch (e) {
        return { success: false, error: e.message };
    }

    if (files.length === 0) {
        return { success: false, error: 'No page images found in this folder' };
    }

    let zipBuf;
    try {
        const entries = files.map(name => ({ name, data: fs.readFileSync(path.join(entry.folder, name)) }));
        zipBuf = buildZip(entries);
    } catch (e) {
        return { success: false, error: 'Failed to build archive: ' + e.message };
    }

    const parentDir = path.dirname(entry.folder);
    const baseName = sanitizeName(entry.title) || String(id);
    const cbzPath = uniqueArchivePath(parentDir, baseName, ext);

    try {
        fs.writeFileSync(cbzPath, zipBuf);
    } catch (e) {
        return { success: false, error: `Failed to write .${ext}: ` + e.message };
    }
    try {
        fs.writeFileSync(archiveMarkerPath(cbzPath), id.toString(), 'utf-8');
    } catch (e) {}

    try {
        fs.rmSync(entry.folder, { recursive: true, force: true });
    } catch (e) {}

    upsertLibraryEntry({
        galleryId: id,
        title: entry.title,
        path: cbzPath,
        pages: files.length,
        format: ext,
        language: entry.language,
        artist: entry.artist,
        addedAt: entry.added_at,
        meta: entry.meta
    });

    return { success: true, cbzPath, pages: files.length, sizeBytes: zipBuf.length };
}

function uniqueArchivePath(parentDir, baseName, ext) {
    let archivePath = path.join(parentDir, `${baseName}.${ext}`);
    let suffix = 2;
    while (fs.existsSync(archivePath)) {
        archivePath = path.join(parentDir, `${baseName} (${suffix}).${ext}`);
        suffix++;
    }
    return archivePath;
}

module.exports = {
    setStateDir,
    loadLibrary,
    saveToLibrary,
    saveArchivedToLibrary,
    saveSkippedToLibrary,
    logError,
    logPlaceholderPage,
    syncListTracker,
    updateListStatus,
    isLibraryEntryValid,
    isPermanentlySkipped,
    buildDisplayName,
    getCachedDisplayName,
    updateListDisplayName,
    trackerFileToListPath,
    rescanLibrary,
    renameLibraryEntry,
    compressLibraryEntry,
    getBatchFormatForGallery,
    uniqueArchivePath,
    saveArchivedGallery
};
