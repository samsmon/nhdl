const http = require('http');
const https = require('https');
const fs = require('fs');

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

module.exports = { fetchText, downloadToFile, USER_AGENT };
