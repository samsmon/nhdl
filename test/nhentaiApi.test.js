const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadArchiveFile } = require('../core/nhentaiApi');

// Minimal stand-in for the archive CDN: a Cloudflare-style HTML challenge (403) unless the
// request carries a browser User-Agent, in which case it serves a real (tiny) zip.
const ZIP_BYTES = Buffer.from('504b0506000000000000000000000000000000000000', 'hex'); // empty zip (EOCD only)
function startServer({ alwaysHtml = false } = {}) {
    const server = http.createServer((req, res) => {
        const ua = req.headers['user-agent'] || '';
        if (alwaysHtml || !ua.includes('Mozilla')) {
            res.writeHead(alwaysHtml ? 200 : 403, { 'Content-Type': 'text/html' });
            return res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>');
        }
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(Buffer.concat([Buffer.from('PK\x03\x04'), ZIP_BYTES]));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function tmpFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-test-')), 'out.cbz');
}

test('downloadArchiveFile sends a browser User-Agent and saves the real archive', async () => {
    const server = await startServer();
    const dest = tmpFile();
    try {
        const result = await downloadArchiveFile(`http://127.0.0.1:${server.address().port}/download/x`, dest, 1);
        assert.strictEqual(result.success, true, result.reason);
        assert.strictEqual(fs.readFileSync(dest).subarray(0, 2).toString(), 'PK');
    } finally {
        server.close();
    }
});

test('downloadArchiveFile rejects a non-zip response instead of saving it', async () => {
    const server = await startServer({ alwaysHtml: true });
    const dest = tmpFile();
    try {
        const result = await downloadArchiveFile(`http://127.0.0.1:${server.address().port}/download/x`, dest, 1);
        assert.strictEqual(result.success, false);
        assert.strictEqual(fs.existsSync(dest), false, 'bogus file must not be left on disk');
    } finally {
        server.close();
    }
});
