// Gallery metadata sidecars: ComicInfo.xml (LANraragi ComicInfo plugin, Komga) and an
// HDoujin-style info.json (HappyPanda X "File Metadata" plugin). Both are written into the
// archive, or next to the images for a folder gallery.
//
// Archive writes keep every existing byte before the new entries: LANraragi identifies an
// archive by the SHA1 of its first 512000 bytes, so a rewrite that moved those bytes would
// register the file as a new archive and lose its metadata. writeMetadata() therefore refuses
// any write that would change them.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { crc32 } = require('./zip');
const { urlForKey } = require('./db/common');

const COMIC_INFO_NAME = 'ComicInfo.xml';
const INFO_JSON_NAME = 'info.json';
const FORMAT_MARKER = '<!-- nhdl-format:2 -->'; // lets backfill tell new-format files from old ones
const ID_WINDOW = 512000;

const LANG_ISO = { english: 'en', japanese: 'ja', chinese: 'zh' };

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// The API returns upload_date as unix seconds; other sources may give an ISO string.
function parseUploadDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = typeof value === 'number' || /^\d+$/.test(String(value))
        ? new Date(Number(value) * 1000)
        : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

// True when tag data is known: tags are present, or a fetch already returned a gallery without any.
function hasTagData(meta) {
    return !!(meta && ((Array.isArray(meta.tags) && meta.tags.length > 0) || meta.tagsFetched));
}

function webUrlFor(galleryId) {
    try { return urlForKey(galleryId); } catch (e) { return null; }
}

function usable(name) {
    return name && !['other', 'unknown'].includes(String(name).trim().toLowerCase());
}

// Everything the sidecars need, as plain lists. Provider tags have no type, so they count as
// plain tags; artist, language and category fall back to the library entry / provider fields.
function collect(galleryId, meta, ctx = {}) {
    meta = meta || {};
    const by = {};
    for (const t of Array.isArray(meta.tags) ? meta.tags : []) {
        if (!t || !t.name) continue;
        const type = t.type || 'tag';
        (by[type] = by[type] || []).push(String(t.name));
    }
    const artists = by.artist && by.artist.length ? by.artist : (usable(ctx.artist) ? [String(ctx.artist)] : []);
    const langNames = (by.language || []).map(n => n.toLowerCase());
    const ctxLang = ctx.language ? String(ctx.language).toLowerCase() : '';
    const langName = langNames.find(n => LANG_ISO[n]) || (LANG_ISO[ctxLang] ? ctxLang : '');
    const genre = by.category && by.category.length ? by.category : (meta.category ? [String(meta.category)] : []);
    return {
        tags: by.tag || [],
        artists,
        groups: by.group || [],
        characters: by.character || [],
        parodies: by.parody || [],
        genre,
        langName,
        langIso: LANG_ISO[langName] || '',
        url: ctx.url || webUrlFor(galleryId) || ''
    };
}

// Fields that LANraragi's ComicInfo plugin maps: Tags, Genre, Characters, Web, Writer (as group:),
// Penciller (as artist:), LanguageISO. Title is left out so the plugin does not rename the archive.
function buildComicInfoXml(galleryId, meta, ctx = {}) {
    meta = meta || {};
    const c = collect(galleryId, meta, ctx);
    const date = parseUploadDate(meta.uploadDate);
    const fields = [
        ['Year', date ? date.getUTCFullYear() : null],
        ['Month', date ? date.getUTCMonth() + 1 : null],
        ['Day', date ? date.getUTCDate() : null],
        ['Writer', c.artists.join(', ')],
        ['Penciller', c.artists.join(', ')],
        ['Translator', meta.scanlator || null],
        ['Publisher', c.groups.join(', ')],
        ['Genre', c.genre.join(', ')],
        ['Characters', c.characters.join(', ')],
        ['Tags', c.tags.join(', ')],
        ['LanguageISO', c.langIso],
        ['Web', c.url]
    ];
    const body = fields
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `  <${k}>${xmlEscape(v)}</${k}>`)
        .join('\n');
    return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n  ${FORMAT_MARKER}\n${body}\n</ComicInfo>\n`;
}

// HDoujin-style: tags as a list without namespaces, everything else as strings.
function buildInfoJson(galleryId, meta, ctx = {}) {
    const c = collect(galleryId, meta, ctx);
    const info = {
        artist: c.artists.join(', '),
        circle: c.groups.join(', '),
        tags: c.tags,
        characters: c.characters.join(', '),
        parody: c.parodies.join(', '),
        language: c.langName,
        url: c.url
    };
    for (const k of Object.keys(info)) {
        if (info[k] === '' || (Array.isArray(info[k]) && info[k].length === 0)) delete info[k];
    }
    return JSON.stringify({ manga_info: info }, null, 1) + '\n';
}

// ---- zip helpers (central directory based, no ZIP64) ----

function findEocd(buf) {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
}

function parseCentral(buf) {
    const eocd = findEocd(buf);
    if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record)');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
        throw new Error('ZIP64 archives are not supported');
    }
    const records = [];
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt central directory');
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        records.push({
            name: buf.toString('utf-8', p + 46, p + 46 + nameLen),
            central: Buffer.from(buf.subarray(p, p + 46 + nameLen + extraLen + commentLen)),
            flags, method, compSize, localOffset
        });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return records;
}

function localRecord(buf, r) {
    if (buf.readUInt32LE(r.localOffset) !== 0x04034b50) throw new Error('Corrupt local header');
    const nameLen = buf.readUInt16LE(r.localOffset + 26);
    const extraLen = buf.readUInt16LE(r.localOffset + 28);
    const dataStart = r.localOffset + 30 + nameLen + extraLen;
    let end = dataStart + r.compSize;
    if (r.flags & 0x08) end += buf.readUInt32LE(end) === 0x08074b50 ? 16 : 12; // trailing data descriptor
    return { dataStart, bytes: buf.subarray(r.localOffset, end) };
}

function entryData(buf, r) {
    const { dataStart } = localRecord(buf, r);
    const raw = buf.subarray(dataStart, dataStart + r.compSize);
    return r.method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
}

function dosStamp(now = new Date()) {
    return {
        time: ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f),
        date: (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f)
    };
}

// Returns a copy of a zip buffer with the given entries ([{name, data}]) added or replaced.
// Existing entries are copied byte for byte (no recompression) in their original order; the
// new ones go after them, before the central directory.
function upsertZipEntries(zipBuf, entries) {
    const names = new Set(entries.map(e => e.name));
    const kept = parseCentral(zipBuf).filter(r => !names.has(r.name));
    const { time, date } = dosStamp();

    const parts = [];
    const centrals = [];
    let offset = 0;
    for (const r of kept) {
        const local = localRecord(zipBuf, r).bytes;
        const c = Buffer.from(r.central);
        c.writeUInt32LE(offset, 42);
        parts.push(local);
        centrals.push(c);
        offset += local.length;
    }
    for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf-8');
        const crc = crc32(e.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 name
        local.writeUInt16LE(0, 8); // stored
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(e.data.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(e.data.length, 20);
        central.writeUInt32LE(e.data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        parts.push(local, nameBuf, e.data);
        centrals.push(Buffer.concat([central, nameBuf]));
        offset += local.length + nameBuf.length + e.data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(kept.length + entries.length, 8);
    eocd.writeUInt16LE(kept.length + entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, eocd]);
}

function upsertZipEntry(zipBuf, name, data) {
    return upsertZipEntries(zipBuf, [{ name, data }]);
}

// LANraragi's archive ID: SHA1 over the first 512000 bytes.
function archiveId(buf) {
    return crypto.createHash('sha1').update(buf.subarray(0, ID_WINDOW)).digest('hex');
}

// ---- reading what an archive/folder already has ----

// Existing ComicInfo.xml text, or null.
function readComicInfo(target, format) {
    try {
        if (format !== 'cbz' && format !== 'zip') {
            const p = path.join(target, COMIC_INFO_NAME);
            return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
        }
        const buf = fs.readFileSync(target);
        const rec = parseCentral(buf).find(r => r.name === COMIC_INFO_NAME);
        return rec ? entryData(buf, rec).toString('utf-8') : null;
    } catch (e) { return null; }
}

// True when the entry already carries the current format (so backfill can leave it alone).
function hasCurrentComicInfo(target, format) {
    const text = readComicInfo(target, format);
    // A file with Penciller was written by the tagging script that already follows this layout.
    return !!(text && (text.includes(FORMAT_MARKER) || /<Penciller>/.test(text)));
}

// ---- writing ----

// Writes ComicInfo.xml and info.json for a library entry. `target` is the folder or archive.
// ctx: { artist, language, url }. Always writes at least artist, genre and URL, even for a
// gallery without any tags. Returns { written, reason? }; a refused write is a result, not a throw.
function writeMetadata(galleryId, target, format, meta, ctx = {}) {
    if (!target || !fs.existsSync(target)) return { written: false, reason: 'target missing' };
    const xml = Buffer.from(buildComicInfoXml(galleryId, meta, ctx), 'utf-8');
    const json = Buffer.from(buildInfoJson(galleryId, meta, ctx), 'utf-8');

    if (format === 'cbz' || format === 'zip') {
        const before = fs.readFileSync(target);
        let out;
        try {
            out = upsertZipEntries(before, [{ name: COMIC_INFO_NAME, data: xml }, { name: INFO_JSON_NAME, data: json }]);
        } catch (e) {
            return { written: false, reason: `cannot rewrite archive: ${e.message}` };
        }
        if (archiveId(out) !== archiveId(before)) {
            return { written: false, reason: 'would change the first 512000 bytes (LANraragi archive ID); left untouched' };
        }
        const stat = fs.statSync(target);
        const tmp = `${target}.nhdl-tmp`;
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, target);
        // Keep the modification time: reader mirrors (manga-optimizer) compare mtimes, and a touched
        // file would be reprocessed even though its images did not change.
        try { fs.utimesSync(target, stat.atime, stat.mtime); } catch (e) {}
        return { written: true };
    }
    fs.writeFileSync(path.join(target, COMIC_INFO_NAME), xml);
    fs.writeFileSync(path.join(target, INFO_JSON_NAME), json);
    return { written: true };
}

module.exports = {
    COMIC_INFO_NAME, INFO_JSON_NAME, FORMAT_MARKER,
    buildComicInfoXml, buildInfoJson, upsertZipEntry, upsertZipEntries, archiveId,
    readComicInfo, hasCurrentComicInfo, writeMetadata, hasTagData, parseUploadDate
};
