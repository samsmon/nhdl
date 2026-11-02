// Backfill job: fills in tags, dates and scanlator for library entries that were scanned from
// disk (so only artist/language from the folder path are known), then writes ComicInfo.xml and
// info.json. A gallery without any tags still gets the minimal fields (artist, genre, URL).
// Runs in the background, paced under the API rate limit (20/min without key, 45/min with).

const fs = require('fs');
const { fetchGalleryMetadata } = require('./nhentaiApi');
const { providerForKey } = require('./providers');
const { fetchText, curlFetchText } = require('./providers/http');
const { getAllLibraryEntries, upsertLibraryEntry } = require('./db');
const { writeMetadata, hasTagData, hasCurrentComicInfo } = require('./comicInfo');
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
    if (entry.meta && entry.meta.metadataWriteSkipped) return false; // refused once (e.g. archive ID would change)
    if (!(entry.path && fs.existsSync(entry.path))) return false;
    // Needs work when tag data was never fetched, or the sidecars are missing / in the old format.
    return !hasTagData(entry.meta) || !hasCurrentComicInfo(entry.path, entry.format);
}

let job = null;
let cancelRequested = false;

function getJob() { return job; }
function isRunning() { return !!(job && !job.finishedAt); }
function cancel() { cancelRequested = true; }

async function startBackfill({ background = false } = {}) {
    if (isRunning()) return { started: false, error: 'A metadata backfill is already running' };
    const candidates = (await getAllLibraryEntries()).filter(isCandidate);
    if (background && candidates.length === 0) return { started: false, total: 0 };
    const apiKey = process.env.NHENTAI_API_KEY || '';
    job = {
        total: candidates.length,
        done: 0,
        updated: 0,
        notFound: 0,
        skipped: 0,
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
    run(candidates, apiKey, background).catch(async (e) => {
        job.abortedReason = e.message;
        job.finishedAt = new Date().toISOString();
        await logActivity(`Metadata backfill crashed: ${e.message}`);
    });
    return { started: true, total: candidates.length };
}

// Resolves to { success, extraMeta } | { success:false, notFound?, reason }. The default site
// uses the JSON API; the other sources go through their own provider's metadata fetch.
async function fetchOne(id, apiKey) {
    if (/^\d+$/.test(String(id))) {
        const res = await fetchGalleryMetadata(id, apiKey);
        return res.success ? { success: true, extraMeta: extraMetaFromApi(res.data) } : res;
    }
    const provider = providerForKey(String(id));
    if (!provider || typeof provider.fetchMeta !== 'function') return { success: false, reason: 'no metadata fetcher for this source' };
    try {
        const m = await provider.fetchMeta(String(id), { fetchText: provider.transport === 'curl' ? curlFetchText : fetchText });
        return { success: true, extraMeta: m.extraMeta || {} };
    } catch (e) {
        return { success: false, notFound: !!e.permanent, reason: e.message };
    }
}

async function fetchWithRetry(id, apiKey) {
    let last;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        last = await fetchOne(id, apiKey);
        if (last.success || last.notFound) return last;
        if (cancelRequested) return last;
        if (!/^\d+$/.test(String(id))) return last; // other sources: one try, they block rather than rate-limit
        await sleep(RETRY_WAIT_MS);
    }
    return last;
}

async function saveMeta(entry, meta) {
    try {
        await upsertLibraryEntry({
            galleryId: entry.id, title: entry.title, path: entry.path, pages: entry.pages,
            format: entry.format, language: entry.language, artist: entry.artist,
            addedAt: entry.added_at, meta
        });
    } catch (e) {
        job.errors.push({ id: entry.id, error: `saving metadata failed: ${e.message}` });
    }
}

// Writes the sidecars and records a refusal per gallery instead of failing the whole job.
async function writeFor(entry, meta) {
    let result;
    try {
        result = writeMetadata(entry.id, entry.path, entry.format, meta, { artist: entry.artist, language: entry.language });
    } catch (e) {
        result = { written: false, reason: e.message };
    }
    if (result.written) { job.updated++; return; }
    job.skipped++;
    job.errors.push({ id: entry.id, error: result.reason });
    meta.metadataWriteSkipped = true;
    await saveMeta(entry, meta);
}

async function run(candidates, apiKey, background) {
    // Background runs share the rate limit with active downloads, so they go at about half speed.
    const delay = background ? (apiKey ? 2500 : 6500) : (apiKey ? 1500 : 3200);
    let consecutiveFailures = 0;
    await logActivity(`Metadata backfill started: ${candidates.length} entries`);

    for (const entry of candidates) {
        if (cancelRequested) { job.abortedReason = 'cancelled'; break; }
        job.currentId = entry.id;
        job.currentTitle = entry.title;

        const meta = entry.meta && typeof entry.meta === 'object' ? { ...entry.meta } : {};

        if (hasTagData(meta)) { // tag data already stored; only the sidecars are missing or old, no request needed
            await writeFor(entry, meta);
            job.done++;
            continue;
        }

        const res = await fetchWithRetry(entry.id, apiKey);

        if (res.success) {
            consecutiveFailures = 0;
            Object.assign(meta, res.extraMeta);
            meta.tagsFetched = true; // also true for a gallery that really has no tags
            await saveMeta(entry, meta);
            await writeFor(entry, meta);
        } else if (res.notFound) {
            consecutiveFailures = 0;
            meta.metadataNotFound = true; // gallery removed upstream; do not ask again
            meta.tagsFetched = true;
            await saveMeta(entry, meta);
            await writeFor(entry, meta); // minimal sidecars: artist, genre, URL
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
    await logActivity(`Metadata backfill finished: ${job.updated} written, ${job.skipped} skipped, ${job.notFound} not found upstream, ${job.failed} failed${job.abortedReason ? ` (stopped: ${job.abortedReason})` : ''}`);
}

module.exports = { startBackfill, getJob, isRunning, cancel, isCandidate, extraMetaFromApi };
