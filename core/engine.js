const EventEmitter = require('events');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const https = require('https');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const { sanitizeName, toTitleCase, getDynamicDelay, verifyImage, writeBlankPlaceholderImage, sleep, withFsRetryAsync } = require('./utils');
const { loadLibrary, saveToLibrary, saveArchivedToLibrary, saveSkippedToLibrary, logError, logPlaceholderPage, updateListStatus, isLibraryEntryValid, isPermanentlySkipped, buildDisplayName, getCachedDisplayName, updateListDisplayName, compressLibraryEntry, getBatchFormatForGallery, setStateDir, uniqueArchivePath, saveArchivedGallery, isDownloadDirHealthy, rescanLibrary } = require('./tracker');
const { logActivity, setLogDir } = require('./logger');
const { fetchGalleryMetadata, requestDownloadUrl, downloadArchiveFile } = require('./nhentaiApi');
const {
    getSetting,
    setSetting,
    getQueueItem,
    getQueueItems,
    getNextPendingItem,
    enqueueGallery,
    updateQueueItem,
    requeueFailedItems,
    deleteLibraryEntry,
    getAllLibraryEntries,
    logEvent
} = require('./db');

dns.setServers(['1.1.1.1', '8.8.8.8']);
const NHENTAI_MAIN_IP = '104.26.4.188';

const PLACEHOLDER_RETRY_THRESHOLD = 5;
const PLACEHOLDER_SIZE_CEILING = 1536;

function resolveCurlBinary() {
    if (process.platform !== 'win32') return 'curl';
    const candidates = [
        'C:\\Program Files\\Git\\mingw64\\bin\\curl.exe',
        'C:\\Program Files\\Git\\usr\\bin\\curl.exe'
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return `"${candidate}"`;
    }
    return 'curl';
}
const CURL_BIN = resolveCurlBinary();

class DownloaderEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        const savedDownloadDir = getSetting('downloadDir', null);
        const rawFormat = getSetting('downloadFormat', 'cbz');
        const savedDownloadFormat = (rawFormat === 'folder' || rawFormat === 'zip' || rawFormat === 'cbz') ? rawFormat : 'cbz';
        const savedAutoContinue = getSetting('autoContinueBatches', true) !== false;

        const defaultDownloadDir = path.join(__dirname, '..', 'Download');
        this.baseDownloadDir = options.baseDownloadDir || process.env.DOWNLOAD_DIR || savedDownloadDir || defaultDownloadDir;
        const hasLibraryEntries = getAllLibraryEntries().some(e => !e.skipped);
        if (!fs.existsSync(this.baseDownloadDir) && !hasLibraryEntries) {
            try {
                fs.mkdirSync(this.baseDownloadDir, { recursive: true });
            } catch (e) {}
        }
        setStateDir(this.baseDownloadDir);
        setLogDir(this.baseDownloadDir);
        this.downloadFormat = options.downloadFormat || savedDownloadFormat;
        this.autoContinueBatches = options.autoContinueBatches !== undefined ? options.autoContinueBatches : savedAutoContinue;
        this.batchSize = options.batchSize || 50;
        this.batchRestMinutes = options.batchRestMinutes || 5;
        this.concurrency = options.concurrency || 3;
        this.skipStartupJitter = !!options.skipStartupJitter;
        this.healthCheckIntervalMs = options.healthCheckIntervalMs || 60000;
        this._downloadDirWatchTimer = null;
        this.downloadDirUnavailable = false;
        this.isRunning = false;
        this.isStopped = false;
        this.isPaused = false;
        this.forceRetry = false;
        this.currentProgress = null;
        this.statusReason = null;

        this.consecutiveRateLimits = 0;
        this.circuitBreakerTripped = false;

        if (!isDownloadDirHealthy(this.baseDownloadDir)) {
            this.markDownloadDirUnavailable('Download folder unavailable');
        }
    }

    markDownloadDirUnavailable(reason = 'Download folder unavailable') {
        this.downloadDirUnavailable = true;
        this.statusReason = reason || 'Download folder unavailable';
        logEvent({
            level: 'error',
            message: `Run aborted: ${this.statusReason} (${this.baseDownloadDir})`
        });
        this.emit('download_dir_unavailable', {
            reason: this.statusReason,
            downloadDir: this.baseDownloadDir
        });
        this.startDownloadDirWatch();
    }

    clearDownloadDirUnavailable() {
        this.stopDownloadDirWatch();
        this.downloadDirUnavailable = false;
        this.statusReason = null;
    }

    startDownloadDirWatch() {
        if (this._downloadDirWatchTimer) return;
        this._downloadDirWatchTimer = setInterval(() => {
            this.checkDownloadDirRecovery();
        }, this.healthCheckIntervalMs);
        if (this._downloadDirWatchTimer.unref) {
            this._downloadDirWatchTimer.unref();
        }
    }

    stopDownloadDirWatch() {
        if (this._downloadDirWatchTimer) {
            clearInterval(this._downloadDirWatchTimer);
            this._downloadDirWatchTimer = null;
        }
    }

    checkDownloadDirRecovery() {
        if (!this.downloadDirUnavailable) {
            this.stopDownloadDirWatch();
            return false;
        }
        const hasActiveLibrary = getAllLibraryEntries().some(e => !e.skipped);
        if (!hasActiveLibrary && this.baseDownloadDir && !fs.existsSync(this.baseDownloadDir)) {
            try {
                fs.mkdirSync(this.baseDownloadDir, { recursive: true });
            } catch (e) {}
        }
        if (!isDownloadDirHealthy(this.baseDownloadDir)) {
            return false;
        }
        const rescanResult = rescanLibrary(this.baseDownloadDir);
        if (rescanResult && rescanResult.aborted) {
            this.statusReason = rescanResult.reason || this.statusReason || 'Download folder unavailable';
            return false;
        }
        this.clearDownloadDirUnavailable();
        logEvent({
            level: 'info',
            message: `Download folder recovered and healthy (${this.baseDownloadDir})`
        });
        logActivity(`Download folder recovered: ${this.baseDownloadDir}`);
        this.emit('resumed', { recovered: true, downloadDir: this.baseDownloadDir });
        requeueFailedItems();
        const pending = getQueueItems({ status: 'PENDING' });
        if (pending.length > 0 && !this.isRunning && !this.isPaused) {
            this.runBatch().catch(e => {
                logActivity(`FATAL runBatch (recovery): ${e.stack || e.message}`);
            });
        }
        return true;
    }

    pause() {
        this.isPaused = true;
        this.emit('paused');
    }

    resume() {
        this.isPaused = false;
        this.clearDownloadDirUnavailable();
        this.consecutiveRateLimits = 0;
        this.circuitBreakerTripped = false;
        this.emit('resumed');
    }

    getStatus() {
        if (this.downloadDirUnavailable) return this.statusReason || 'Download folder unavailable';
        if (this.statusReason) return this.statusReason;
        if (this.isPaused) return 'PAUSED';
        if (!this.isRunning) return 'IDLE';
        if (this.currentProgress) {
            if (this.currentProgress.type === 'RATE_LIMIT') return 'COOLDOWN_429';
            if (this.currentProgress.type === 'COOLDOWN' || this.currentProgress.type === 'BATCH_REST') return 'COOLDOWN';
        }
        return 'RUNNING';
    }

    setDownloadDir(newDir) {
        if (!newDir || typeof newDir !== 'string') return;
        this.baseDownloadDir = path.resolve(newDir);
        this.clearDownloadDirUnavailable();
        if (!fs.existsSync(this.baseDownloadDir) && !getAllLibraryEntries().some(e => !e.skipped)) {
            fs.mkdirSync(this.baseDownloadDir, { recursive: true });
        }
        setStateDir(this.baseDownloadDir);
        setLogDir(this.baseDownloadDir);
        try {
            setSetting('downloadDir', this.baseDownloadDir);
            this.emit('config_updated', { downloadDir: this.baseDownloadDir });
        } catch (e) {
            console.error('Failed to save downloadDir to settings:', e.message);
        }
    }

    setDownloadFormat(format) {
        if (format !== 'folder' && format !== 'cbz' && format !== 'zip') return;
        this.downloadFormat = format;
        try {
            setSetting('downloadFormat', format);
            this.emit('config_updated', { downloadFormat: format });
        } catch (e) {
            console.error('Failed to save downloadFormat to settings:', e.message);
        }
    }

    setAutoContinueBatches(enabled) {
        this.autoContinueBatches = !!enabled;
        try {
            setSetting('autoContinueBatches', this.autoContinueBatches);
            this.emit('config_updated', { autoContinueBatches: this.autoContinueBatches });
        } catch (e) {
            console.error('Failed to save autoContinueBatches to settings:', e.message);
        }
    }

    triggerForceRetry() {
        this.forceRetry = true;
        this.emit('retry_triggered');
    }

    maybeCompress(galleryId) {
        const format = getBatchFormatForGallery(null, galleryId) || this.downloadFormat;
        if (format === 'cbz' || format === 'zip') {
            const result = compressLibraryEntry(galleryId, { ext: format });
            if (result.success) logActivity(`Compressed ID ${galleryId} to .${format}`);
        }
    }

    getRandomImageHost() {
        const serverNum = Math.floor(Math.random() * 4) + 1; // i1 - i4
        return `i${serverNum}.nhentai.net`;
    }

    async resolveDomain(domain) {
        if (domain.includes('nhentai.net')) {
            return NHENTAI_MAIN_IP;
        }
        return new Promise((resolve) => {
            dns.resolve4(domain, (err, addresses) => {
                if (err || !addresses || addresses.length === 0) return resolve(NHENTAI_MAIN_IP);
                if (addresses[0].startsWith('202.169.') || addresses[0].startsWith('36.') || addresses[0].startsWith('103.')) {
                    return resolve(NHENTAI_MAIN_IP);
                }
                resolve(addresses[0]);
            });
        });
    }

    httpsGet(url, hostHeader, targetIp) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const options = {
                hostname: targetIp,
                port: 443,
                path: urlObj.pathname + urlObj.search,
                headers: {
                    'Host': hostHeader,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://nhentai.net/'
                },
                servername: hostHeader
            };

            const req = https.get(options, (res) => {
                if (res.statusCode !== 200) return reject(new Error(`Status Code: ${res.statusCode}`));
                resolve(res);
            });

            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Socket Timeout'));
            });

            req.on('error', reject);
        });
    }

    downloadImage(url, destPath, hostHeader, onProgress) {
        return new Promise(async (resolve, reject) => {
            let hardTimeout;
            try {
                const targetIp = await this.resolveDomain(hostHeader);
                hardTimeout = setTimeout(() => {
                    reject(new Error("Hard Timeout (Stalled)"));
                }, 30000);

                const res = await this.httpsGet(url, hostHeader, targetIp);
                const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
                let received = 0;
                if (onProgress) onProgress(0, totalBytes);
                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (onProgress) onProgress(received, totalBytes);
                });

                const fileStream = fs.createWriteStream(destPath);
                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    clearTimeout(hardTimeout);
                    fileStream.close(resolve);
                });

                fileStream.on('error', (err) => {
                    clearTimeout(hardTimeout);
                    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                    reject(err);
                });
            } catch (err) {
                clearTimeout(hardTimeout);
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                reject(err);
            }
        });
    }

    // Searches the whole download tree for a folder or archive matching a (possibly stale)
    // cached title, without needing a language/author breakdown from fresh metadata. Used
    // only as a 429 fallback — see the RATE_LIMIT branch in processGallery().
    findExistingOnDisk(cachedTitle, cachedAuthor) {
        const sanitizedTitle = sanitizeName(cachedTitle);
        if (!sanitizedTitle) return null;
        const sanitizedAuthor = cachedAuthor ? sanitizeName(cachedAuthor) : null;

        let langDirs;
        try {
            langDirs = fs.readdirSync(this.baseDownloadDir, { withFileTypes: true }).filter(d => d.isDirectory());
        } catch (e) { return null; }

        for (const langDir of langDirs) {
            let authorDirs;
            const langPath = path.join(this.baseDownloadDir, langDir.name);
            try {
                authorDirs = fs.readdirSync(langPath, { withFileTypes: true }).filter(d => d.isDirectory());
            } catch (e) { continue; }

            for (const authorDir of authorDirs) {
                if (sanitizedAuthor && authorDir.name !== sanitizedAuthor) continue;
                const parentDir = path.join(langPath, authorDir.name);
                let siblings;
                try {
                    siblings = fs.readdirSync(parentDir, { withFileTypes: true });
                } catch (e) { continue; }

                const archiveMatch = siblings.find(d => {
                    if (!d.isFile()) return false;
                    const m = d.name.match(/^(.*)\.(cbz|zip)$/i);
                    return m && m[1].startsWith(sanitizedTitle);
                });
                if (archiveMatch) {
                    const archiveExt = archiveMatch.name.match(/\.(cbz|zip)$/i)[1].toLowerCase();
                    return { archived: true, path: path.join(parentDir, archiveMatch.name), title: cachedTitle, archiveExt, pages: 0 };
                }

                const folderMatch = siblings.find(d => d.isDirectory() && d.name.startsWith(sanitizedTitle));
                if (folderMatch) {
                    const folderPath = path.join(parentDir, folderMatch.name);
                    let files;
                    try {
                        files = fs.readdirSync(folderPath).filter(f => /^\d+\.(jpg|jpeg|png|webp|gif)$/i.test(f));
                    } catch (e) { files = []; }
                    if (files.length === 0) continue;
                    const pageExts = {};
                    let maxPage = 0;
                    let ext = 'jpg';
                    for (const f of files) {
                        const m = f.match(/^(\d+)\.(\w+)$/);
                        if (m) {
                            const p = parseInt(m[1], 10);
                            pageExts[p] = m[2];
                            ext = m[2];
                            if (p > maxPage) maxPage = p;
                        }
                    }
                    return { archived: false, path: folderPath, title: cachedTitle, pages: maxPage, ext, pageExts };
                }
            }
        }
        return null;
    }

    // API-first: the official JSON endpoint is public (no key needed, though a key raises
    // the rate limit from 20/min to 45/min), returns structured data instead of regex-prone
    // HTML, and hands back every field nhentai tracks for a gallery — not just the handful
    // fetchMetadataViaHtml() extracts. Falls back to the old HTML scrape on any failure
    // (network error, unexpected shape, 429, etc.) so behavior never regresses.
    async fetchMetadata(galleryId) {
        const apiResult = await fetchGalleryMetadata(galleryId, process.env.NHENTAI_API_KEY);
        if (apiResult.success) {
            const data = apiResult.data;
            // "pretty" is nhentai's own cleaned-up short title (no [circle/artist] tags,
            // no [Language]/[Digital] suffixes) — use that for filenames; the long
            // "english" title is still kept in extraMeta for anyone who wants it.
            const title = (data.title && (data.title.pretty || data.title.english || data.title.japanese)) || "Unknown_Title";
            const mediaId = data.media_id;
            const numPages = data.num_pages || (data.pages ? data.pages.length : 0);

            const pageExts = {};
            let ext = "jpg";
            (data.pages || []).forEach(p => {
                const m = p.path && p.path.match(/\.(jpg|jpeg|png|webp|gif)$/i);
                const pageExt = m ? m[1].toLowerCase() : 'jpg';
                pageExts[p.number] = pageExt;
                if (p.number === 1) ext = pageExt;
            });

            const tags = data.tags || [];
            const langTag = [...tags].reverse().find(t => t.type === 'language');
            const langStr = langTag ? toTitleCase(langTag.name) : "Unknown";
            const artistTag = tags.find(t => t.type === 'artist');
            const groupTag = tags.find(t => t.type === 'group');
            const authorStr = artistTag ? toTitleCase(artistTag.name) : (groupTag ? toTitleCase(groupTag.name) : "Other");

            return {
                title, mediaId, numPages, ext, pageExts, langStr, authorStr,
                extraMeta: {
                    tags,
                    numFavorites: data.num_favorites,
                    uploadDate: data.upload_date,
                    scanlator: data.scanlator,
                    titleEnglish: data.title && data.title.english,
                    titleJapanese: data.title && data.title.japanese,
                    titlePretty: data.title && data.title.pretty,
                    cover: data.cover,
                    thumbnail: data.thumbnail
                }
            };
        }
        if (apiResult.notFound) throw new Error("404 Page (Gallery not found / already removed)");
        logActivity(`[METADATA] ID ${galleryId}: API failed (${apiResult.reason}) — using HTML scrape instead`);
        return this.fetchMetadataViaHtml(galleryId);
    }

    async fetchMetadataViaHtml(galleryId) {
        const curlCmd = `${CURL_BIN} -skL --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" https://nhentai.net/g/${galleryId}/`;
        let html = '';
        try {
            const { stdout } = await execAsync(curlCmd, { encoding: 'utf-8', windowsHide: true });
            html = stdout;
        } catch (e) {
            try {
                const fallbackCmd = `curl -skL --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" https://nhentai.net/g/${galleryId}/`;
                const { stdout } = await execAsync(fallbackCmd, { encoding: 'utf-8', windowsHide: true });
                html = stdout;
            } catch (e2) {
                html = e2.stdout || '';
            }
        }

        let title = "Unknown_Title";
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        const metaTitleMatch = html.match(/<meta itemprop="name" content="([^"]+)"/);

        // Note: "challenge-platform" alone is NOT a reliable signal — Cloudflare injects that
        // script tag on normal, successful pages too. Only the title/explicit-block-text checks
        // reliably indicate an actual 429/JS-challenge block.
        if (titleMatch && (titleMatch[1].includes("Error 429") || titleMatch[1].includes("Just a moment...")) ||
            html.includes("Rate limit exceeded") || html.includes("Attention Required! | Cloudflare")) {
            return { status: "RATE_LIMIT" };
        } else if (titleMatch && titleMatch[1].includes("404")) {
            const e = new Error("Link tidak dapat diakses (404 - gallery not found / sudah dihapus)");
            e.permanent = true;
            throw e;
        } else if (!html || html.trim().length === 0) {
            throw new Error("Empty response (network issue, not a broken link)");
        }

        if (metaTitleMatch) title = metaTitleMatch[1];

        let mediaId = null;
        const mediaMatch = html.match(/\\?"media_id\\?":\s*\\?"(\d+)\\?"/);
        if (mediaMatch) mediaId = mediaMatch[1];
        else throw new Error("Failed to find media_id (HTML blocked by Cloudflare)");

        let numPages = 0;
        const numMatch = html.match(/\\?"num_pages\\?":\s*(\d+)/);
        if (numMatch) numPages = parseInt(numMatch[1], 10);
        else throw new Error("Failed to find total page count");

        let ext = "jpg";
        const extMatch = html.match(/\\?"path\\?":\\?"galleries\/\d+\/1\.(jpg|png|webp|gif)\\?"/);
        if (extMatch) ext = extMatch[1];

        // nhentai galleries can mix file extensions across pages (e.g. page 1 is .webp but
        // page 2 is .jpg) — relying on a single gallery-wide ext causes those pages to 404
        // forever. Build a per-page extension map from the full pages array as the source of truth.
        const pageExts = {};
        const pageMatches = html.matchAll(/\\?"number\\?":(\d+),\\?"path\\?":\\?"galleries\/\d+\/\d+\.(jpg|png|webp|gif)\\?"/g);
        for (const m of pageMatches) {
            pageExts[parseInt(m[1], 10)] = m[2];
        }

        const langMatches = [...html.matchAll(/\\"type\\":\\"language\\",\\"name\\":\\"([^\\"]+)\\"/g)].map(m => m[1]);
        let langStr = "Unknown";
        if (langMatches.length > 0) langStr = toTitleCase(langMatches[langMatches.length - 1]);

        const artistMatches = [...html.matchAll(/\\"type\\":\\"artist\\",\\"name\\":\\"([^\\"]+)\\"/g)].map(m => m[1]);
        const groupMatches = [...html.matchAll(/\\"type\\":\\"group\\",\\"name\\":\\"([^\\"]+)\\"/g)].map(m => m[1]);
        let authorStr = "Other";
        if (artistMatches.length > 0) authorStr = toTitleCase(artistMatches[0]);
        else if (groupMatches.length > 0) authorStr = toTitleCase(groupMatches[0]);

        return {
            title,
            mediaId,
            numPages,
            ext,
            pageExts,
            langStr,
            authorStr
        };
    }

    // Fast path: ask the official API for a ready-made archive instead of downloading pages
    // one by one. Returns a processGallery() result object on success, or null to signal
    // "fall back to the normal per-page CDN flow" (bad key, feature disabled, rate limited,
    // network error — anything that isn't a clean success is treated as non-fatal here).
    async tryApiArchiveDownload(galleryId, format, apiKey, ctx) {
        const { sanitizedTitle, title, folderPath, numPages, authorStr, langStr, extraMeta, currentTaskNum, totalTasks, trackerFile } = ctx;

        const baseProgress = {
            galleryId, title: title.substring(0, 40), percent: 0, completed: 0, total: 1,
            taskNum: currentTaskNum, totalTasks, activePages: [], speedKBps: 0,
            stalled: false, stalledSeconds: 0, live: true
        };
        this.currentProgress = { ...baseProgress, message: 'Requesting API download URL...' };
        this.emit('progress', this.currentProgress);

        const urlResult = await requestDownloadUrl(galleryId, format, apiKey);
        if (!urlResult.success) {
            logActivity(`[API] ID ${galleryId}: couldn't get download URL (${urlResult.reason}) — falling back to CDN`);
            this.currentProgress = null;
            return null;
        }

        const parentDir = path.dirname(folderPath);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
        const archivePath = uniqueArchivePath(parentDir, sanitizedTitle, format);

        this.currentProgress = { ...baseProgress, message: 'Downloading archive via API...' };
        this.emit('progress', this.currentProgress);

        const dlResult = await downloadArchiveFile(urlResult.url, archivePath);
        if (!dlResult.success) {
            logActivity(`[API] ID ${galleryId}: archive download failed (${dlResult.reason}) — falling back to CDN`);
            if (fs.existsSync(archivePath)) { try { fs.unlinkSync(archivePath); } catch (e) {} }
            this.currentProgress = null;
            return null;
        }

        saveArchivedGallery(galleryId, sanitizedTitle, archivePath, format, { author: authorStr, lang: langStr, pages: numPages, extraMeta });
        updateListStatus(null, galleryId, 'DONE');
        updateQueueItem(galleryId, { pagesDone: numPages, pagesTotal: numPages });
        logActivity(`[API] DONE ID ${galleryId}: "${title}" (${numPages} pages)`);
        this.currentProgress = null;
        this.emit('done', { galleryId, title, pages: numPages, currentTaskNum, totalTasks });
        return { status: "SUCCESS", numPages };
    }

    async processGallery(galleryId, currentTaskNum = 1, totalTasks = 1, _trackerFile = null) {
        updateListStatus(null, galleryId, 'ON_PROGRESS');

        const library = loadLibrary();
        if (library[galleryId] && library[galleryId].folder && fs.existsSync(library[galleryId].folder) && library[galleryId].pages && library[galleryId].ext) {
            const data = library[galleryId];
            let allValid = !!data.archived;
            if (!allValid) {
                const savedPageExts = data.pageExts || {};
                allValid = true;
                for (let j = 1; j <= data.pages; j++) {
                    if (!verifyImage(path.join(data.folder, `${j}.${savedPageExts[j] || data.ext}`))) {
                        allValid = false;
                        break;
                    }
                }
            }
            if (allValid) {
                updateListStatus(null, galleryId, 'SKIPPED - Already in Library');
                updateListDisplayName(null, galleryId, buildDisplayName(data.title, data.author));
                updateQueueItem(galleryId, { pagesDone: data.pages, pagesTotal: data.pages });
                this.emit('skipped', { galleryId, title: data.title, currentTaskNum, totalTasks, reason: 'Already in Library' });
                return { status: "SUCCESS", numPages: data.pages, skipped: true, skipReason: 'library' };
            }
        }

        const meta = await this.fetchMetadata(galleryId);
        if (meta.status === "RATE_LIMIT") {
            const cached = getCachedDisplayName(null, galleryId);
            if (cached && cached.title) {
                const found = this.findExistingOnDisk(cached.title, cached.author);
                if (found) {
                    if (found.archived) {
                        saveArchivedToLibrary(galleryId, found.title, found.path, found.archiveExt, { author: cached.author });
                    } else {
                        saveToLibrary(galleryId, found.title, found.path, found.pages, found.ext, found.pageExts, { author: cached.author });
                    }
                    updateListStatus(null, galleryId, "SKIPPED - Found on disk (metadata was 429'd)");
                    updateQueueItem(galleryId, { pagesDone: found.pages || 0, pagesTotal: found.pages || 0 });
                    logActivity(`SKIPPED ID ${galleryId}: found existing file on disk, avoided 429 cooldown`);
                    this.emit('skipped', { galleryId, title: found.title, currentTaskNum, totalTasks, reason: 'Already on disk (metadata blocked by 429)' });
                    return { status: "SUCCESS", numPages: found.pages || 0, skipped: true, skipReason: 'library' };
                }
            }
            logError(galleryId, "Cloudflare Rate Limit / Challenge (429)");
            updateListStatus(null, galleryId, "COOLDOWN - CLOUDFLARE 429");
            return { status: "RATE_LIMIT" };
        }

        const { title, mediaId, numPages, ext, pageExts, langStr, authorStr, extraMeta } = meta;
        const extFor = (page) => pageExts[page] || ext;
        const sanitizedLang = sanitizeName(langStr);
        const sanitizedAuthor = sanitizeName(authorStr);
        const sanitizedTitle = sanitizeName(title) || galleryId;

        updateListDisplayName(null, galleryId, buildDisplayName(title, authorStr));
        updateQueueItem(galleryId, { pagesTotal: numPages });

        const parentDir = path.join(this.baseDownloadDir, sanitizedLang, sanitizedAuthor);
        let folderPath = path.join(parentDir, sanitizedTitle);

        if (fs.existsSync(parentDir)) {
            try {
                const siblings = fs.readdirSync(parentDir, { withFileTypes: true });

                const archiveMatch = siblings.find(d => {
                    if (!d.isFile()) return false;
                    const m = d.name.match(/^(.*)\.(cbz|zip)$/i);
                    return m && m[1].startsWith(sanitizedTitle);
                });
                if (archiveMatch) {
                    const archiveExt = archiveMatch.name.match(/\.(cbz|zip)$/i)[1].toLowerCase();
                    const archivePath = path.join(parentDir, archiveMatch.name);
                    saveArchivedToLibrary(galleryId, sanitizedTitle, archivePath, archiveExt, { author: authorStr, lang: langStr, pages: numPages });
                    updateListStatus(null, galleryId, "SKIPPED - Already in Library");
                    updateListDisplayName(null, galleryId, buildDisplayName(title, authorStr));
                    updateQueueItem(galleryId, { pagesDone: numPages, pagesTotal: numPages });
                    this.emit('skipped', { galleryId, title, currentTaskNum, totalTasks, reason: 'Already Downloaded (Archive)' });
                    return { status: "SUCCESS", numPages, skipped: true, skipReason: 'disk_after_metadata' };
                }

                const folderMatch = siblings.find(d => d.isDirectory() && d.name.startsWith(sanitizedTitle));
                if (folderMatch) folderPath = path.join(parentDir, folderMatch.name);
            } catch (e) {}
        }

        const apiKey = process.env.NHENTAI_API_KEY;
        const targetFormat = getBatchFormatForGallery(null, galleryId) || this.downloadFormat;
        if (apiKey && (targetFormat === 'cbz' || targetFormat === 'zip')) {
            const apiResult = await this.tryApiArchiveDownload(galleryId, targetFormat, apiKey, {
                sanitizedTitle, title, folderPath, numPages, authorStr, langStr, extraMeta,
                currentTaskNum, totalTasks, trackerFile: null
            });
            if (apiResult) return apiResult;
        }

        if (!fs.existsSync(folderPath)) {
            try {
                await withFsRetryAsync(() => fs.mkdirSync(folderPath, { recursive: true }), {
                    onRetry: (e, attempt, max) => {
                        logActivity(`WARN ID ${galleryId}: mkdir failed (${e.code}), retry ${attempt}/${max} - ${folderPath}`);
                    }
                });
            } catch (e) {
                if (e.code === 'ENOENT' || e.code === 'ENAMETOOLONG' || e.code === 'EINVAL') {
                    folderPath = path.join(parentDir, galleryId.toString());
                    logError(galleryId, `Folder name rejected by filesystem (${e.code}), falling back to gallery ID as folder name`);
                    fs.mkdirSync(folderPath, { recursive: true });
                } else {
                    throw e;
                }
            }
        }

        let completed = 0;
        let pendingPages = [];

        for (let j = 1; j <= numPages; j++) {
            const checkPath = path.join(folderPath, `${j}.${extFor(j)}`);
            if (verifyImage(checkPath)) {
                completed++;
            } else {
                if (fs.existsSync(checkPath)) fs.unlinkSync(checkPath);
                pendingPages.push(j);
            }
        }

        updateQueueItem(galleryId, { pagesDone: completed, pagesTotal: numPages });

        if (completed === numPages) {
            saveToLibrary(galleryId, sanitizedTitle, folderPath, numPages, ext, pageExts, { author: authorStr, lang: langStr, extraMeta });
            this.maybeCompress(galleryId);
            updateListStatus(null, galleryId, "SKIPPED - Files Complete");
            this.emit('skipped', { galleryId, title, currentTaskNum, totalTasks, reason: 'Files 100% Complete' });
            return { status: "SUCCESS", numPages, skipped: true, skipReason: 'disk_after_metadata' };
        }

        await new Promise((resolve) => {
            let active = 0;
            const pageRetryCounts = new Map();
            const pageErrors = new Map();
            const activePages = new Map();
            let completedBytes = 0;
            let lastSpeedSample = { at: Date.now(), bytes: 0 };
            let lastByteAt = Date.now();

            const buildProgress = () => {
                const percent = Math.round((completed / numPages) * 100);
                const pagesSnapshot = [...activePages.values()].map(p => ({
                    page: p.page,
                    url: p.url,
                    bytesReceived: p.bytesReceived,
                    totalBytes: p.totalBytes,
                    percent: p.totalBytes > 0 ? Math.round((p.bytesReceived / p.totalBytes) * 100) : 0,
                    attempt: p.attempt,
                    lastError: p.lastError || null
                }));

                const nowBytes = completedBytes + [...activePages.values()].reduce((sum, p) => sum + p.bytesReceived, 0);
                const elapsedSec = Math.max((Date.now() - lastSpeedSample.at) / 1000, 0.001);
                const speedKBps = Math.max(0, Math.round(((nowBytes - lastSpeedSample.bytes) / 1024) / elapsedSec));
                lastSpeedSample = { at: Date.now(), bytes: nowBytes };

                const stalledSeconds = Math.round((Date.now() - lastByteAt) / 1000);
                const stalled = active > 0 && stalledSeconds >= 8;

                return {
                    galleryId,
                    title: title.substring(0, 40),
                    percent,
                    completed,
                    total: numPages,
                    taskNum: currentTaskNum,
                    totalTasks,
                    activePages: pagesSnapshot,
                    speedKBps,
                    stalled,
                    stalledSeconds: stalled ? stalledSeconds : 0,
                    live: true
                };
            };

            const heartbeat = setInterval(() => {
                if (active === 0) return;
                this.currentProgress = buildProgress();
                this.emit('progress', this.currentProgress);
            }, 1000);

            const next = () => {
                if (this.isStopped) {
                    clearInterval(heartbeat);
                    return resolve();
                }
                if (this.isPaused) {
                    setTimeout(next, 500);
                    return;
                }
                if (pendingPages.length === 0 && active === 0) {
                    clearInterval(heartbeat);
                    saveToLibrary(galleryId, sanitizedTitle, folderPath, numPages, ext, pageExts, { author: authorStr, lang: langStr, extraMeta });
                    this.maybeCompress(galleryId);
                    updateListStatus(null, galleryId, "DONE");
                    updateQueueItem(galleryId, { pagesDone: numPages, pagesTotal: numPages });
                    logActivity(`[CDN] DONE ID ${galleryId}: "${title}" (${numPages} pages)`);
                    this.currentProgress = null;
                    this.emit('done', { galleryId, title, pages: numPages, currentTaskNum, totalTasks });
                    return resolve();
                }

                while (active < this.concurrency && pendingPages.length > 0 && !this.isStopped) {
                    const currentPage = pendingPages.shift();
                    const pageExt = extFor(currentPage);
                    const destPath = path.join(folderPath, `${currentPage}.${pageExt}`);
                    const dynamicHost = this.getRandomImageHost();
                    const imageUrl = `https://${dynamicHost}/galleries/${mediaId}/${currentPage}.${pageExt}`;
                    const retryCount = pageRetryCounts.get(currentPage) || 0;
                    const startDelay = retryCount > 0 ? Math.min(1000 * 2 ** retryCount, 15000) : Math.floor(Math.random() * 400);

                    const pageEntry = {
                        page: currentPage,
                        url: imageUrl,
                        bytesReceived: 0,
                        totalBytes: 0,
                        attempt: retryCount + 1,
                        lastError: pageErrors.get(currentPage) || null
                    };
                    activePages.set(currentPage, pageEntry);

                    active++;
                    sleep(startDelay)
                        .then(() => this.downloadImage(imageUrl, destPath, dynamicHost, (received, total) => {
                            pageEntry.bytesReceived = received;
                            pageEntry.totalBytes = total;
                            lastByteAt = Date.now();
                        }))
                        .then(() => {
                            if (!verifyImage(destPath)) {
                                const attempt = retryCount + 1;
                                let failedSize = 0;
                                try { failedSize = fs.statSync(destPath).size; } catch (e) {}

                                if (attempt >= PLACEHOLDER_RETRY_THRESHOLD && failedSize > 0 && failedSize < PLACEHOLDER_SIZE_CEILING) {
                                    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                                    writeBlankPlaceholderImage(destPath);
                                    logPlaceholderPage(galleryId, currentPage, title);
                                    logActivity(`[PLACEHOLDER] ID ${galleryId} page ${currentPage}: CDN served a blank image ${attempt}x in a row - substituted a blank page instead of retrying forever`);
                                    pageRetryCounts.delete(currentPage);
                                    pageErrors.delete(currentPage);
                                    completedBytes += failedSize;
                                    completed++;
                                    updateQueueItem(galleryId, { pagesDone: completed, pagesTotal: numPages });
                                    const percent = Math.round((completed / numPages) * 100);
                                    this.currentProgress = buildProgress();
                                    this.currentProgress.percent = percent;
                                    this.emit('progress', this.currentProgress);
                                } else {
                                    pageRetryCounts.set(currentPage, attempt);
                                    pageErrors.set(currentPage, 'Downloaded file failed verification (corrupt/too small)');
                                    pendingPages.unshift(currentPage);
                                }
                            } else {
                                pageRetryCounts.delete(currentPage);
                                pageErrors.delete(currentPage);
                                completedBytes += pageEntry.bytesReceived;
                                completed++;
                                updateQueueItem(galleryId, { pagesDone: completed, pagesTotal: numPages });
                                const percent = Math.round((completed / numPages) * 100);
                                this.currentProgress = buildProgress();
                                this.currentProgress.percent = percent;
                                this.emit('progress', this.currentProgress);
                            }
                        })
                        .catch((err) => {
                            const attempt = retryCount + 1;
                            pageRetryCounts.set(currentPage, attempt);
                            pageErrors.set(currentPage, err.message);
                            pendingPages.unshift(currentPage);

                            if (attempt === 3 || attempt % 5 === 0) {
                                logError(galleryId, `Page ${currentPage} (${imageUrl}) failed ${attempt}x: ${err.message}`);
                            }
                        })
                        .finally(() => {
                            activePages.delete(currentPage);
                            active--;
                            next();
                        });
                }
            };
            next();
        });

        return { status: "SUCCESS", numPages, skipped: false };
    }

    async runBatch(galleryIds = null, trackerFile = null) {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isStopped = false;
        try {
            await this._runBatchBody(galleryIds, trackerFile);
        } finally {
            this.isRunning = false;
        }
    }

    async _runBatchBody(galleryIds = null) {
        const hasActiveLibrary = getAllLibraryEntries().some(e => !e.skipped);
        if (!hasActiveLibrary && this.baseDownloadDir && !fs.existsSync(this.baseDownloadDir)) {
            try {
                fs.mkdirSync(this.baseDownloadDir, { recursive: true });
            } catch (e) {}
        }

        if (!isDownloadDirHealthy(this.baseDownloadDir)) {
            this.markDownloadDirUnavailable('Download folder unavailable');
            return;
        }
        this.clearDownloadDirUnavailable();

        const library = loadLibrary();
        if (Array.isArray(galleryIds) && galleryIds.length > 0) {
            for (const rawId of galleryIds) {
                const existing = getQueueItem(rawId);
                if (!existing) {
                    const isDone = isLibraryEntryValid(library[rawId]);
                    const isSkipped = isPermanentlySkipped(library[rawId]);
                    enqueueGallery({
                        galleryId: rawId,
                        status: isDone ? 'DONE' : (isSkipped ? 'SKIPPED' : 'PENDING')
                    });
                }
            }
        }

        requeueFailedItems();

        const allQueue = getQueueItems();
        for (const row of allQueue) {
            const idStr = String(row.gallery_id);
            const libEntry = library[idStr];
            if (row.status === 'PENDING') {
                if (isLibraryEntryValid(libEntry)) {
                    updateListStatus(null, row.gallery_id, 'DONE');
                } else if (isPermanentlySkipped(libEntry)) {
                    updateListStatus(null, row.gallery_id, `SKIPPED - ${libEntry.reason || 'Skipped'}`);
                } else if (libEntry) {
                    deleteLibraryEntry(row.gallery_id);
                    delete library[idStr];
                }
            } else if (row.status === 'DONE') {
                if (!isLibraryEntryValid(libEntry)) {
                    if (libEntry && !isPermanentlySkipped(libEntry)) {
                        deleteLibraryEntry(row.gallery_id);
                        delete library[idStr];
                    }
                    updateQueueItem(row.gallery_id, {
                        status: 'PENDING',
                        pagesDone: 0,
                        error: null
                    });
                }
            }
        }

        const initialPending = getQueueItems({ status: 'PENDING' });
        const totalQueueCount = allQueue.length;
        this.emit('batch_start', {
            total: totalQueueCount,
            pending: initialPending.length,
            skipped: Math.max(0, totalQueueCount - initialPending.length)
        });
        logActivity(`Run started: ${initialPending.length} pending / ${totalQueueCount} total (${Math.max(0, totalQueueCount - initialPending.length)} already in library)`);

        if (initialPending.length === 0) {
            this.emit('batch_complete', { processed: 0 });
            return;
        }

        if (!this.skipStartupJitter) {
            const startupJitterMs = 5000 + Math.floor(Math.random() * 10000);
            logActivity(`Run starting in ${Math.round(startupJitterMs / 1000)}s (startup jitter, anti-burst)`);
            await sleep(startupJitterMs);
        }

        let processedCount = 0;
        let totalTasksSnapshot = initialPending.length;

        while (!this.isStopped) {
            while (this.isPaused && !this.isStopped) {
                await sleep(500);
            }
            if (this.isStopped) break;

            const nextRow = getNextPendingItem();
            if (!nextRow) break;

            const id = String(nextRow.gallery_id);
            processedCount++;
            const remainingNow = getQueueItems({ status: 'PENDING' }).length;
            totalTasksSnapshot = Math.max(totalTasksSnapshot, processedCount + Math.max(0, remainingNow - 1));

            let result = null;
            try {
                result = await this.processGallery(id, processedCount, totalTasksSnapshot, null);
            } catch (err) {
                if (err.permanent) {
                    saveSkippedToLibrary(id, err.message);
                    logActivity(`SKIPPED ID ${id}: ${err.message}`);
                    updateListStatus(null, id, `SKIPPED - ${err.message.substring(0, 60)}`);
                    this.emit('skipped', { galleryId: id, reason: err.message, currentTaskNum: processedCount, totalTasks: totalTasksSnapshot });
                } else {
                    logError(id, err.message);
                    logActivity(`ERROR ID ${id}: ${err.message}`);
                    updateListStatus(null, id, `ERROR - ${err.message.substring(0, 30)}`);
                    this.emit('error', { galleryId: id, error: err.message, currentTaskNum: processedCount, totalTasks: totalTasksSnapshot });
                }
            }

            const MAX_CONSECUTIVE_RATE_LIMITS = 3;
            const BASE_RATE_LIMIT_WAIT = 5 * 60;
            const MAX_RATE_LIMIT_WAIT = 60 * 60;

            while (result && result.status === "RATE_LIMIT" && !this.isStopped) {
                this.consecutiveRateLimits++;

                if (this.consecutiveRateLimits > MAX_CONSECUTIVE_RATE_LIMITS) {
                    this.circuitBreakerTripped = true;
                    const msg = `Circuit breaker: ${this.consecutiveRateLimits - 1} consecutive rate limits — pausing the run entirely instead of continuing to hammer nhentai. Resume manually once the flag has had time to cool down.`;
                    logActivity(`CIRCUIT BREAKER: ${msg}`);
                    logError(id, msg);
                    this.emit('circuit_breaker', { galleryId: id, consecutiveRateLimits: this.consecutiveRateLimits - 1 });
                    this.pause();
                    updateListStatus(null, id, "PAUSED - Circuit breaker (too many 429s)");
                    break;
                }

                const waitSeconds = Math.min(BASE_RATE_LIMIT_WAIT * 2 ** (this.consecutiveRateLimits - 1), MAX_RATE_LIMIT_WAIT);
                logActivity(`RATE LIMIT ID ${id}: cooling down ${waitSeconds}s (consecutive hit #${this.consecutiveRateLimits})`);
                this.emit('rate_limit', { galleryId: id, waitSeconds, consecutiveRateLimits: this.consecutiveRateLimits });
                for (let s = waitSeconds; s > 0; s--) {
                    if (this.isStopped || this.forceRetry) break;
                    while (this.isPaused && !this.isStopped && !this.forceRetry) {
                        await sleep(500);
                    }
                    if (this.isStopped || this.forceRetry) break;

                    const m = Math.floor(s / 60);
                    const sRem = s % 60;
                    this.currentProgress = {
                        type: 'RATE_LIMIT',
                        title: `Rate Limit 429 - Cooldown IP (hit #${this.consecutiveRateLimits})`,
                        message: `Retrying in: ${m}m ${sRem}s`,
                        percent: Math.round(((waitSeconds - s) / waitSeconds) * 100),
                        remaining: s,
                        total: waitSeconds,
                        taskNum: processedCount,
                        totalTasks: totalTasksSnapshot
                    };
                    this.emit('cooldown', this.currentProgress);
                    await sleep(1000);
                }
                if (this.forceRetry) {
                    this.forceRetry = false;
                    this.currentProgress = null;
                }
                result = await this.processGallery(id, processedCount, totalTasksSnapshot, null);
            }

            if (this.circuitBreakerTripped) break;

            if (result && result.status !== "RATE_LIMIT") {
                this.consecutiveRateLimits = 0;
            }

            const hasMorePending = !!getNextPendingItem();
            const wasFreeSkip = !!(result && result.skipped && result.skipReason === 'library');

            if (wasFreeSkip && hasMorePending && !this.isStopped) {
                await sleep(1000 + Math.floor(Math.random() * 2000));
            }

            if (hasMorePending && !this.isStopped && !wasFreeSkip && !this.skipStartupJitter) {
                if (processedCount % this.batchSize === 0) {
                    const currentBatch = Math.ceil(processedCount / this.batchSize);
                    const totalSeconds = this.batchRestMinutes * 60;
                    for (let s = totalSeconds; s > 0; s--) {
                        if (this.isStopped || this.forceRetry) break;
                        while (this.isPaused && !this.isStopped && !this.forceRetry) {
                            await sleep(500);
                        }
                        if (this.isStopped || this.forceRetry) break;

                        const m = Math.floor(s / 60);
                        const sRem = s % 60;
                        this.currentProgress = {
                            type: 'BATCH_REST',
                            title: `Batch ${currentBatch} Complete - Cooling Down (${this.batchRestMinutes} min)`,
                            message: `Next batch in: ${m}m ${sRem}s`,
                            percent: Math.round(((totalSeconds - s) / totalSeconds) * 100),
                            remaining: s,
                            total: totalSeconds,
                            taskNum: processedCount,
                            totalTasks: totalTasksSnapshot
                        };
                        this.emit('cooldown', this.currentProgress);
                        await sleep(1000);
                    }
                    if (this.forceRetry) this.forceRetry = false;
                    this.currentProgress = null;
                } else {
                    const numPages = result ? result.numPages : 0;
                    const isSkipped = result ? result.skipped : false;
                    const dynamicDelay = getDynamicDelay(numPages, isSkipped);
                    const delaySeconds = Math.round(dynamicDelay / 1000);

                    for (let s = delaySeconds; s > 0; s--) {
                        if (this.isStopped || this.forceRetry) break;
                        while (this.isPaused && !this.isStopped && !this.forceRetry) {
                            await sleep(500);
                        }
                        if (this.isStopped || this.forceRetry) break;
                        this.currentProgress = {
                            type: 'COOLDOWN',
                            title: `Smart Delay Cooldown (Anti-Ban)`,
                            message: `Next in queue in: ${s}s`,
                            percent: Math.round(((delaySeconds - s) / delaySeconds) * 100),
                            remaining: s,
                            total: delaySeconds,
                            taskNum: processedCount,
                            totalTasks: totalTasksSnapshot
                        };
                        this.emit('cooldown', this.currentProgress);
                        await sleep(1000);
                    }
                    if (this.forceRetry) this.forceRetry = false;
                    this.currentProgress = null;
                }
            }
        }

        logActivity(`Run finished: ${processedCount} galleries processed`);
        this.emit('batch_complete', { processed: processedCount });
    }

    stop() {
        this.isStopped = true;
        this.isRunning = false;
        this.isPaused = false;
        if (this.currentProgress) this.currentProgress.live = false;
        this.emit('stopped');
    }

    async restart(galleryIds = null, trackerFile = null) {
        this.stop();
        this.forceRetry = true;
        await sleep(600);
        this.isStopped = false;
        this.isPaused = false;
        this.emit('restarted');
        return this.runBatch(galleryIds, trackerFile);
    }
}

module.exports = DownloaderEngine;
