// ComicInfo.xml support: builds the XML from gallery metadata (tags, dates, scanlator) and
// writes it next to a folder gallery or inside a .cbz/.zip archive, so readers such as Komga
// see the full metadata and not just the artist taken from the folder name.
// Schema: https://anansi-project.github.io/docs/comicinfo/documentation

const fs = require('fs');
const path = require('path');
const { crc32 } = require('./zip');
const { urlForKey } = require('./db/common');

const COMIC_INFO_NAME = 'ComicInfo.xml';

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// Joins the names of tags of the given types, sorted, or null when none match.
function joinTags(tags, types, withType) {
    const names = tags
        .filter(t => t && types.includes(t.type || 'tag') && t.name) // other sources give untyped tags
        .map(t => (withType ? `${t.type || 'tag'}: ${t.name}` : t.name));
    if (names.length === 0) return null;
    return names.sort().join(', ');
}

// The API returns upload_date as unix seconds; other sources may give an ISO string.
function parseUploadDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = typeof value === 'number' || /^\d+$/.test(String(value))
        ? new Date(Number(value) * 1000)
        : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function hasFullMetadata(meta) {
    return !!(meta && Array.isArray(meta.tags) && meta.tags.length > 0);
}

// meta is the library `meta` object (see DownloaderEngine.fetchMetadata -> extraMeta).
function buildComicInfoXml(galleryId, meta, { webUrl = null, artist = null } = {}) {
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    const title = meta.titlePretty || meta.titleEnglish || meta.titleJapanese || '';
    const date = parseUploadDate(meta.uploadDate);
    const fields = [
        ['Title', `${galleryId} ${title}`.trim()],
        ['Year', date ? date.getUTCFullYear() : null],
        ['Month', date ? date.getUTCMonth() + 1 : null],
        ['Day', date ? date.getUTCDate() : null],
        ['Writer', joinTags(tags, ['artist'], false) || artist],
        ['Translator', meta.scanlator || null],
        ['Publisher', joinTags(tags, ['group'], false)],
        ['Genre', joinTags(tags, ['category'], false)],
        ['Tags', joinTags(tags, ['character', 'language', 'parody', 'tag'], true)],
        ['Web', webUrl],
        ['PageCount', meta.numPages || null]
    ];
    const body = fields
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `  <${k}>${xmlEscape(v)}</${k}>`)
        .join('\n');
    return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${body}\n</ComicInfo>\n`;
}

function webUrlFor(galleryId) {
    try { return urlForKey(galleryId); } catch (e) { return null; }
}

// Returns a copy of a zip buffer with `name` added or replaced. Existing entries are copied
// byte for byte (no recompression). ZIP64 and multi-disk archives are refused.
function upsertZipEntry(zipBuf, name, data) {
    let eocd = -1;
    for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 22 - 65535); i--) {
        if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record)');
    const count = zipBuf.readUInt16LE(eocd + 10);
    const cdSize = zipBuf.readUInt32LE(eocd + 12);
    const cdOffset = zipBuf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
        throw new Error('ZIP64 archives are not supported');
    }

    const records = [];
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
        if (zipBuf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt central directory');
        const flags = zipBuf.readUInt16LE(p + 8);
        const compSize = zipBuf.readUInt32LE(p + 20);
        const nameLen = zipBuf.readUInt16LE(p + 28);
        const extraLen = zipBuf.readUInt16LE(p + 30);
        const commentLen = zipBuf.readUInt16LE(p + 32);
        const localOffset = zipBuf.readUInt32LE(p + 42);
        const entryName = zipBuf.toString('utf-8', p + 46, p + 46 + nameLen);
        const central = Buffer.from(zipBuf.subarray(p, p + 46 + nameLen + extraLen + commentLen));

        if (zipBuf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt local header');
        const lNameLen = zipBuf.readUInt16LE(localOffset + 26);
        const lExtraLen = zipBuf.readUInt16LE(localOffset + 28);
        let end = localOffset + 30 + lNameLen + lExtraLen + compSize;
        if (flags & 0x08) { // trailing data descriptor, with or without signature
            end += zipBuf.readUInt32LE(end) === 0x08074b50 ? 16 : 12;
        }
        records.push({ name: entryName, central, local: zipBuf.subarray(localOffset, end) });
        p += 46 + nameLen + extraLen + commentLen;
    }

    const kept = records.filter(r => r.name !== name);
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = crc32(data);
    const now = new Date();
    const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
    const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 name
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const newLocal = Buffer.concat([local, nameBuf, data]);

    const parts = [];
    const centrals = [];
    let offset = 0;
    for (const r of kept) {
        const c = Buffer.from(r.central);
        c.writeUInt32LE(offset, 42);
        parts.push(r.local);
        centrals.push(c);
        offset += r.local.length;
    }
    const newCentral = Buffer.alloc(46);
    newCentral.writeUInt32LE(0x02014b50, 0);
    newCentral.writeUInt16LE(20, 4);
    newCentral.writeUInt16LE(20, 6);
    newCentral.writeUInt16LE(0x0800, 8);
    newCentral.writeUInt16LE(0, 10);
    newCentral.writeUInt16LE(dosTime, 12);
    newCentral.writeUInt16LE(dosDate, 14);
    newCentral.writeUInt32LE(crc, 16);
    newCentral.writeUInt32LE(data.length, 20);
    newCentral.writeUInt32LE(data.length, 24);
    newCentral.writeUInt16LE(nameBuf.length, 28);
    newCentral.writeUInt32LE(offset, 42);
    parts.push(newLocal);
    centrals.push(Buffer.concat([newCentral, nameBuf]));
    offset += newLocal.length;

    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(kept.length + 1, 8);
    end.writeUInt16LE(kept.length + 1, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, end]);
}

// True when ComicInfo.xml already exists for the entry (folder file, or archive entry found by
// reading only the zip's central directory, not the whole archive).
function hasComicInfo(target, format) {
    try {
        if (format !== 'cbz' && format !== 'zip') return fs.existsSync(path.join(target, COMIC_INFO_NAME));
        const fd = fs.openSync(target, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const tailLen = Math.min(size, 22 + 65535);
            const tail = Buffer.alloc(tailLen);
            fs.readSync(fd, tail, 0, tailLen, size - tailLen);
            let e = -1;
            for (let i = tailLen - 22; i >= 0; i--) { if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; } }
            if (e < 0) return false;
            const cdSize = tail.readUInt32LE(e + 12);
            const cdOffset = tail.readUInt32LE(e + 16);
            const cd = Buffer.alloc(cdSize);
            fs.readSync(fd, cd, 0, cdSize, cdOffset);
            let p = 0;
            while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
                const n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
                if (cd.toString('utf-8', p + 46, p + 46 + n) === COMIC_INFO_NAME) return true;
                p += 46 + n + x + c;
            }
            return false;
        } finally { fs.closeSync(fd); }
    } catch (e) { return false; }
}

// Writes ComicInfo.xml for a library entry. `target` is the folder or archive path.
// The archive is rewritten through a temp file and swapped in, so a crash never leaves a
// half-written .cbz behind.
function writeComicInfo(galleryId, target, format, meta, { artist = null } = {}) {
    if (!hasFullMetadata(meta)) return { written: false, reason: 'no tag metadata' };
    if (!target || !fs.existsSync(target)) return { written: false, reason: 'target missing' };
    const xml = Buffer.from(buildComicInfoXml(galleryId, meta, { webUrl: webUrlFor(galleryId), artist }), 'utf-8');

    if (format === 'cbz' || format === 'zip') {
        const tmp = `${target}.nhdl-tmp`;
        const out = upsertZipEntry(fs.readFileSync(target), COMIC_INFO_NAME, xml);
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, target);
        return { written: true };
    }
    fs.writeFileSync(path.join(target, COMIC_INFO_NAME), xml);
    return { written: true };
}

module.exports = { hasComicInfo, COMIC_INFO_NAME, buildComicInfoXml, upsertZipEntry, writeComicInfo, hasFullMetadata, parseUploadDate };
