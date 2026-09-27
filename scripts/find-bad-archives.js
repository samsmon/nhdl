#!/usr/bin/env node
// Finds .cbz/.zip files in the download folder that are not real zip archives — e.g. the
// Cloudflare "Just a moment..." HTML pages saved by the API download bug fixed in 1f7b136.
//
//   node scripts/find-bad-archives.js [downloadDir]            report only (default)
//   node scripts/find-bad-archives.js [downloadDir] --delete   delete bad files + their .nhdl-id marker
//
// downloadDir defaults to the same folder the engine uses (DOWNLOAD_DIR env, config.json, ./Download).
// After --delete, the galleries are no longer "valid" in the library, so running the queue again
// (with those IDs still in list.txt) downloads them fresh. The printed ID list can be pasted back in.

const fs = require('fs');
const path = require('path');

const MARKER_SUFFIX = '.nhdl-id';
const ZIP_SIGNATURES = [
    Buffer.from([0x50, 0x4b, 0x03, 0x04]), // local file header
    Buffer.from([0x50, 0x4b, 0x05, 0x06])  // empty archive
];

function resolveDownloadDir(arg) {
    if (arg) return path.resolve(arg);
    if (process.env.DOWNLOAD_DIR) return process.env.DOWNLOAD_DIR;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
        if (cfg.downloadDir) return cfg.downloadDir;
    } catch (e) {}
    return path.join(__dirname, '..', 'Download');
}

function readHead(filePath, n) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(n);
        const read = fs.readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, read);
    } finally {
        fs.closeSync(fd);
    }
}

function isZip(filePath) {
    const head = readHead(filePath, 4);
    return ZIP_SIGNATURES.some(sig => head.equals(sig));
}

function describe(filePath) {
    const text = readHead(filePath, 512).toString('utf-8');
    const title = text.match(/<title>([^<]*)<\/title>/i);
    if (title) return `HTML "${title[1].trim()}"`;
    if (/^\s*[{[]/.test(text)) return 'JSON';
    return 'unknown';
}

function* walk(dir) {
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of dirents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) yield* walk(full);
        else if (d.isFile() && /\.(cbz|zip)$/i.test(d.name)) yield full;
    }
}

const args = process.argv.slice(2);
const doDelete = args.includes('--delete');
const downloadDir = resolveDownloadDir(args.find(a => !a.startsWith('--')));

if (!fs.existsSync(downloadDir)) {
    console.error(`Folder download tidak ditemukan: ${downloadDir}`);
    process.exit(1);
}

console.log(`Memindai ${downloadDir} ...`);
let scanned = 0;
const bad = [];
for (const file of walk(downloadDir)) {
    scanned++;
    try {
        if (isZip(file)) continue;
        const markerPath = file + MARKER_SUFFIX;
        let id = null;
        try { id = fs.readFileSync(markerPath, 'utf-8').trim() || null; } catch (e) {}
        bad.push({ file, markerPath, id, size: fs.statSync(file).size, kind: describe(file) });
    } catch (e) {
        console.warn(`  gagal membaca ${file}: ${e.message}`);
    }
}

console.log(`${scanned} archive diperiksa, ${bad.length} bukan zip.\n`);
for (const b of bad) {
    console.log(`- [${b.id || 'ID?'}] ${(b.size / 1024).toFixed(1)} KB, ${b.kind}\n  ${b.file}`);
}
if (bad.length === 0) process.exit(0);

if (!doDelete) {
    console.log('\nTidak ada yang dihapus. Jalankan ulang dengan --delete untuk menghapus file di atas.');
} else {
    let deleted = 0;
    for (const b of bad) {
        try {
            fs.unlinkSync(b.file);
            if (fs.existsSync(b.markerPath)) fs.unlinkSync(b.markerPath);
            deleted++;
        } catch (e) {
            console.warn(`  gagal menghapus ${b.file}: ${e.message}`);
        }
    }
    console.log(`\n${deleted} file dihapus.`);
}

const ids = bad.map(b => b.id).filter(Boolean);
if (ids.length) {
    console.log('\nID untuk didownload ulang (tempel ke list/UI):');
    console.log(ids.join('\n'));
}
