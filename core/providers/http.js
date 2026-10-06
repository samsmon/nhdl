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

function curlArgs(url, headers, timeoutMs) {
    const args = ['-sS', '-L', '--max-redirs', '3', '--compressed',
        '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-A', USER_AGENT];
    for (const [name, value] of Object.entries(headers || {})) args.push('-H', `${name}: ${value}`);
    args.push(url);
    return args;
}

function curlFetchText(url, headers = {}, timeoutMs = 20000) {
    const marker = `__NHDL_STATUS_${process.pid}_${Date.now()}__`;
    const args = [...curlArgs(url, headers, timeoutMs).slice(0, -1), '-w', '\n' + marker + '%{http_code}', url];
    return new Promise((resolve, reject) => {
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
    const args = [...curlArgs(url, headers, timeoutMs).slice(0, -1), '-o', partPath, '-w', '%{http_code}', url];
    if (onProgress) onProgress(0, 0);
    return new Promise((resolve, reject) => {
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
