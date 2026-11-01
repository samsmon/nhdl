// Backfill job: fills in tags, dates and scanlator for library entries that were scanned from
// disk (so only artist/language from the folder path are known), then writes ComicInfo.xml.
// Runs in the background, paced under the API rate limit (20/min without key, 45/min with).

const fs = require('fs');
const { fetchGalleryMetadata } = require('./nhentaiApi');
const { getAllLibraryEntries, upsertLibraryEntry } = require('./db');
const { writeComicInfo, hasFullMetadata } = require('./comicInfo');
const { logActivity } = require('./logger');

const RETRY_WAIT_MS = 60000;
const MAX_RETRIES = 3;
const MAX_CONSECUTIVE_FAILURES = 5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Same shape as DownloaderEngine.fetchMetadata -> extraMeta.
function extraMetaFromApi(data) {
    return {
        tags: data.tags || [],
        numFavorites: data.num_favorites,
        uploadDate: data.upload_date,
        scanlator: data.scanlator,
        titleEnglish: data.title && data.title.english,
        titleJapanese: data.title && data.title.japanese,
        titlePretty: data.title && data.title.pretty,
        cover: data.cover,
        thumbnail: data.thumbnail
    };
}

function isCandidate(entry) {
    if (!entry || entry.format === 'skipped') return false;
    if (!/^\d+$/.test(String(entry.id))) return false; // other sources have no tag API here
    if (hasFullMetadata(entry.meta)) return false;
    if (entry.meta && entry.meta.metadataNotFound) return false;
    return !!(entry.path && fs.existsSync(entry.path));
}

let job = null;
let cancelRequested = false;

function getJob() { return job; }
function isRunning() { return !!(job && !job.finishedAt); }
function cancel() { cancelRequested = true; }

async function startBackfill() {
    if (isRunning()) return { started: false, error: 'A metadata backfill is already running' };
    const candidates = (await getAllLibraryEntries()).filter(isCandidate);
    const apiKey = process.env.NHENTAI_API_KEY || '';
    job = {
        total: candidates.length,
        done: 0,
        updated: 0,
        notFound: 0,
        failed: 0,
        currentId: null,
        currentTitle: null,
        errors: [],
        abortedReason: null,
        etaSeconds: Math.round(candidates.length * (apiKey ? 1.5 : 3.2)),
        startedAt: new Date().toISOString(),
        finishedAt: null
    };
    cancelRequested = false;
    run(candidates, apiKey).catch(async (e) => {
        job.abortedReason = e.message;
        job.finishedAt = new Date().toISOString();
        await logActivity(`Metadata backfill crashed: ${e.message}`);
    });
    return { started: true, total: candidates.length };
}

async function fetchWithRetry(id, apiKey) {
    let last;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        last = await fetchGalleryMetadata(id, apiKey);
        if (last.success || last.notFound) return last;
        if (cancelRequested) return last;
        await sleep(RETRY_WAIT_MS);
    }
    return last;
}

async function run(candidates, apiKey) {
    const delay = apiKey ? 1500 : 3200;
    let consecutiveFailures = 0;
    await logActivity(`Metadata backfill started: ${candidates.length} entries`);

    for (const entry of candidates) {
        if (cancelRequested) { job.abortedReason = 'cancelled'; break; }
        job.currentId = entry.id;
        job.currentTitle = entry.title;

        const res = await fetchWithRetry(entry.id, apiKey);
        const meta = entry.meta && typeof entry.meta === 'object' ? { ...entry.meta } : {};

        if (res.success) {
            consecutiveFailures = 0;
            Object.assign(meta, extraMetaFromApi(res.data));
            try {
                await upsertLibraryEntry({
                    galleryId: entry.id,
                    title: entry.title,
                    path: entry.path,
                    pages: entry.pages,
                    format: entry.format,
                    language: entry.language,
                    artist: entry.artist,
                    addedAt: entry.added_at,
                    meta
                });
                writeComicInfo(entry.id, entry.path, entry.format, meta);
                job.updated++;
            } catch (e) {
                job.failed++;
                job.errors.push({ id: entry.id, error: e.message });
            }
        } else if (res.notFound) {
            consecutiveFailures = 0;
            meta.metadataNotFound = true; // gallery removed upstream; do not ask again
            try {
                await upsertLibraryEntry({
                    galleryId: entry.id, title: entry.title, path: entry.path, pages: entry.pages,
                    format: entry.format, language: entry.language, artist: entry.artist,
                    addedAt: entry.added_at, meta
                });
            } catch (e) {}
            job.notFound++;
        } else {
            job.failed++;
            consecutiveFailures++;
            job.errors.push({ id: entry.id, error: res.reason });
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                job.abortedReason = `${MAX_CONSECUTIVE_FAILURES} failures in a row: ${res.reason}`;
                break;
            }
        }
        job.done++;
        await sleep(delay);
    }

    job.currentId = null;
    job.currentTitle = null;
    job.finishedAt = new Date().toISOString();
    await logActivity(`Metadata backfill finished: ${job.updated} updated, ${job.notFound} not found upstream, ${job.failed} failed${job.abortedReason ? ` (stopped: ${job.abortedReason})` : ''}`);
}

module.exports = { startBackfill, getJob, isRunning, cancel, isCandidate, extraMetaFromApi };
