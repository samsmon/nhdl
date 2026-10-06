const http = require('http');
const https = require('https');
const fs = require('fs');
const { execFile } = require('child_process');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function open(url, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, {
            headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', ...headers }
        }, resolve);
        req.setTimeout(timeoutMs, () => { req.destroy(new Error('Socket Timeout')); });
        req.on('error', reject);
    });
}

async function openFollowing(url, headers, timeoutMs, maxRedirects = 3) {
    let current = url;
    for (let i = 0; i <= maxRedirects; i++) {
        const res = await open(current, headers, timeoutMs);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            current = new URL(res.headers.location, current).toString();
            continue;
        }
        return res;
    }
    throw new Error('Too many redirects');
}

async function fetchText(url, headers = {}, timeoutMs = 20000) {
    const res = await openFollowing(url, headers, timeoutMs);
    const chunks = [];
    await new Promise((resolve, reject) => {
        res.on('data', c => chunks.push(c));
        res.on('end', resolve);
        res.on('error', reject);
    });
    return { status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') };
}

// Block/challenge pages come back as 200 text/html, so the status code alone is not enough:
// the downloaded bytes must start with a known image signature (webp, jpeg, png, gif).
function hasImageSignature(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const b = Buffer.alloc(12);
        const n = fs.readSync(fd, b, 0, 12, 0);
        if (n < 4) return false;
        if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true;
        const head = b.toString('latin1', 0, 6);
        if (head === 'GIF87a' || head === 'GIF89a') return true;
        return n >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
    } catch (e) {
        return false;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
    }
}

function blockedError(contentType) {
    return new Error(`Response is not an image (blocked or unexpected HTML page${contentType ? `, content-type: ${contentType}` : ''})`);
}

async function downloadToFile(url, destPath, headers = {}, onProgress = null, timeoutMs = 30000) {
    const res = await openFollowing(url, headers, timeoutMs);
    if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`Status Code: ${res.statusCode}`);
        err.statusCode = res.statusCode;
        throw err;
    }
    const total = parseInt(res.headers['content-length'], 10) || 0;
    let received = 0;
    if (onProgress) onProgress(0, total);
    const partPath = `${destPath}.part`;

    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(partPath);
        let rejected = false;
        const fail = (err) => {
            if (rejected) return;
            rejected = true;
            out.destroy();
            out.once('close', () => {
                try { fs.unlinkSync(partPath); } catch (e) {}
                reject(err);
            });
        };
        res.on('data', chunk => {
            received += chunk.length;
            if (onProgress) onProgress(received, total);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('Connection aborted')));
        out.on('error', fail);
        out.on('finish', () => {
            out.once('close', () => {
                try {
                    if (!hasImageSignature(partPath)) {
                        try { fs.unlinkSync(partPath); } catch (e) {}
                        return reject(blockedError(res.headers['content-type']));
                    }
                    fs.renameSync(partPath, destPath);
                    resolve();
                } catch (err) {
                    try { fs.unlinkSync(partPath); } catch (e) {}
                    reject(err);
                }
            });
        });
        res.pipe(out);
    });
}

// Some sites sit behind a CDN that serves a challenge page to Node's HTTP stack but not to the
// system curl (site A already shells out to curl for the same reason). These helpers use the plain
// system curl binary via execFile with an argument array: no shell, no impersonation, normal DNS.
function resolveCurlPath() {
    if (process.platform === 'win32') {
        const candidates = [
            'C:\\Program Files\\Git\\mingw64\\bin\\curl.exe',
            'C:\\Program Files\\Git\\usr\\bin\\curl.exe'
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
    }
    return 'curl';
}

function curlArgs(url, headers, timeoutMs, extra = []) {
    if (!/^https?:\/\//i.test(String(url))) throw new Error(`curl: refusing non-http(s) URL: ${String(url).slice(0, 80)}`);
    const args = ['-sS', '-L', '--proto', '=http,https', '--proto-redir', '=http,https', '--max-redirs', '3', '--compressed',
        '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-A', USER_AGENT];
    for (const [name, value] of Object.entries(headers || {})) args.push('-H', `${name}: ${value}`);
    args.push(...extra, '--', String(url));
    return args;
}

function curlFetchText(url, headers = {}, timeoutMs = 20000) {
    const marker = `__NHDL_STATUS_${process.pid}_${Date.now()}__`;
    return new Promise((resolve, reject) => {
        let args;
        try { args = curlArgs(url, headers, timeoutMs, ['-w', '\n' + marker + '%{http_code}']); } catch (e) { return reject(e); }
        execFile(resolveCurlPath(), args, { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                const detail = String(stderr || '').trim() || err.message;
                return reject(new Error(`curl failed: ${detail}`));
            }
            const out = stdout.toString('utf-8');
            const idx = out.lastIndexOf('\n' + marker);
            if (idx < 0) return reject(new Error('curl failed: missing status marker in output'));
            const status = parseInt(out.slice(idx + marker.length + 1), 10) || 0;
            resolve({ status, body: out.slice(0, idx) });
        });
    });
}

function curlDownloadToFile(url, destPath, headers = {}, onProgress = null, timeoutMs = 30000) {
    const partPath = `${destPath}.part`;
    return new Promise((resolve, reject) => {
        let args;
        try { args = curlArgs(url, headers, timeoutMs, ['-o', partPath, '-w', '%{http_code}']); } catch (e) { return reject(e); }
        if (onProgress) onProgress(0, 0);
        execFile(resolveCurlPath(), args, { maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            const cleanup = () => { try { fs.unlinkSync(partPath); } catch (e) {} };
            if (err) {
                cleanup();
                const detail = String(stderr || '').trim() || err.message;
                return reject(new Error(`curl failed: ${detail}`));
            }
            const status = parseInt(String(stdout).trim().slice(-3), 10) || 0;
            if (status !== 200) {
                cleanup();
                const e = new Error(`Status Code: ${status}`);
                e.statusCode = status;
                return reject(e);
            }
            try {
                const size = fs.statSync(partPath).size;
                if (!hasImageSignature(partPath)) {
                    cleanup();
                    return reject(blockedError(null));
                }
                fs.renameSync(partPath, destPath);
                if (onProgress) onProgress(size, size);
                resolve();
            } catch (e) {
                cleanup();
                reject(e);
            }
        });
    });
}

module.exports = { fetchText, downloadToFile, USER_AGENT, resolveCurlPath, curlFetchText, curlDownloadToFile };
