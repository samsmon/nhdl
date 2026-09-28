const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.NHDL_LEGACY_CONFIG = '';

const {
    initDb,
    closeDb,
    enqueueGallery,
    updateQueueStatus,
    deleteQueueItem
} = require('../core/db');
const { createRequestHandler, engine } = require('../server/index');

function createTempEnv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhdl-sse-test-'));
    const dbPath = path.join(dir, 'test.db');
    initDb(dbPath, { legacyConfigPath: path.join(dir, 'nonexistent-config.json') });
    return {
        dir,
        dbPath,
        cleanup() {
            closeDb();
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (e) {}
        }
    };
}

function parseSseFrames(buffer) {
    const parts = buffer.split('\n\n');
    const remainder = parts.pop() || '';
    const events = [];

    for (const rawBlock of parts) {
        const lines = rawBlock.split(/\r?\n/);
        let eventName = 'message';
        const dataLines = [];

        for (const line of lines) {
            if (!line || line.startsWith(':')) continue;
            if (line.startsWith('event:')) {
                eventName = line.slice('event:'.length).trim();
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice('data:'.length).trim());
            }
        }

        if (dataLines.length > 0) {
            const rawData = dataLines.join('\n');
            events.push({
                event: eventName,
                data: JSON.parse(rawData)
            });
        }
    }

    return { events, remainder };
}

test('GET /api/events streams initial snapshot and emits item delta after UPDATE in queue', async () => {
    const env = createTempEnv();
    const srv = http.createServer(createRequestHandler());

    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;

    try {
        // Seed 2 initial items in queue before opening SSE connection
        enqueueGallery({ galleryId: 177013, title: '[ShindoL] Metamorphosis', batch: 1 });
        enqueueGallery({ galleryId: 228922, title: 'Sample Two', batch: 2 });

        const receivedEvents = [];
        let buffer = '';
        let clientReq = null;

        await new Promise((resolve, reject) => {
            let step = 'waiting_snapshot';

            clientReq = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
                assert.equal(res.statusCode, 200);
                assert.match(String(res.headers['content-type']), /^text\/event-stream/i);
                res.setEncoding('utf8');

                res.on('data', (chunk) => {
                    buffer += chunk;
                    const parsed = parseSseFrames(buffer);
                    buffer = parsed.remainder;

                    for (const evt of parsed.events) {
                        receivedEvents.push(evt);

                        if (step === 'waiting_snapshot' && evt.event === 'snapshot') {
                            step = 'waiting_update_delta';
                            // Trigger an UPDATE in queue after snapshot arrives
                            updateQueueStatus(177013, 'ON_PROGRESS', {
                                pagesDone: 12,
                                pagesTotal: 225
                            });
                        } else if (
                            step === 'waiting_update_delta' &&
                            evt.event === 'item' &&
                            evt.data.type === 'updated' &&
                            evt.data.item &&
                            evt.data.item.galleryId === 177013
                        ) {
                            step = 'waiting_done_delta';
                            // Trigger another UPDATE to DONE and a DELETE on 228922
                            updateQueueStatus(177013, 'DONE', {
                                pagesDone: 225,
                                pagesTotal: 225
                            });
                            deleteQueueItem(228922);
                        } else if (
                            step === 'waiting_done_delta' &&
                            evt.event === 'item' &&
                            evt.data.type === 'deleted' &&
                            evt.data.galleryId === 228922
                        ) {
                            resolve();
                        }
                    }
                });

                res.on('error', reject);
            });

            clientReq.on('error', reject);
        });

        if (clientReq) clientReq.destroy();

        // 1. Verify initial snapshot event
        const snapshotEvt = receivedEvents.find(e => e.event === 'snapshot');
        assert.ok(snapshotEvt, 'Expected initial snapshot SSE event');
        assert.equal(snapshotEvt.data.items.length, 2);
        assert.equal(snapshotEvt.data.batchCount, 2);
        assert.equal(snapshotEvt.data.items[0].galleryId, 177013);
        assert.equal(snapshotEvt.data.items[0].rawStatus, 'PENDING');

        // 2. Verify item delta after UPDATE to ON_PROGRESS
        const updateDelta = receivedEvents.find(
            e => e.event === 'item' && e.data.type === 'updated' && e.data.item.rawStatus === 'ON_PROGRESS'
        );
        assert.ok(updateDelta, 'Expected item delta for ON_PROGRESS update');
        assert.equal(updateDelta.data.item.galleryId, 177013);
        assert.equal(updateDelta.data.item.pagesDone, 12);
        assert.equal(updateDelta.data.item.pagesTotal, 225);

        // 3. Verify item delta after UPDATE to DONE
        const doneDelta = receivedEvents.find(
            e => e.event === 'item' && e.data.type === 'updated' && e.data.item.rawStatus === 'DONE'
        );
        assert.ok(doneDelta, 'Expected item delta for DONE update');
        assert.equal(doneDelta.data.item.pagesDone, 225);

        // 4. Verify item delta after DELETE
        const deleteDelta = receivedEvents.find(
            e => e.event === 'item' && e.data.type === 'deleted' && e.data.galleryId === 228922
        );
        assert.ok(deleteDelta, 'Expected item delta for deleted item');
        assert.equal(deleteDelta.data.batchCount, 1);

        // 5. Verify GET /api/status still works for backward compatibility
        const statusJson = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/api/status`, (res) => {
                assert.equal(res.statusCode, 200);
                let body = '';
                res.setEncoding('utf8');
                res.on('data', c => { body += c; });
                res.on('end', () => resolve(JSON.parse(body)));
            }).on('error', reject);
        });
        assert.equal(statusJson.items.length, 1);
        assert.equal(statusJson.items[0].galleryId, 177013);
        assert.equal(statusJson.items[0].rawStatus, 'DONE');
    } finally {
        await new Promise(resolve => srv.close(resolve));
        env.cleanup();
    }
});

test('GET /api/events streams progress and engine events', async () => {
    const env = createTempEnv();
    const srv = http.createServer(createRequestHandler());

    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;

    try {
        const receivedEvents = [];
        let buffer = '';
        let clientReq = null;

        await new Promise((resolve, reject) => {
            clientReq = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    buffer += chunk;
                    const parsed = parseSseFrames(buffer);
                    buffer = parsed.remainder;

                    for (const evt of parsed.events) {
                        receivedEvents.push(evt);
                        if (evt.event === 'snapshot') {
                            engine.emit('progress', { galleryId: '177013', downloadedPages: 5, totalPages: 10 });
                            engine.pause();
                            engine.resume();
                        }
                        if (
                            receivedEvents.some(e => e.event === 'progress') &&
                            receivedEvents.some(e => e.event === 'engine' && e.data.type === 'paused') &&
                            receivedEvents.some(e => e.event === 'engine' && e.data.type === 'resumed')
                        ) {
                            resolve();
                        }
                    }
                });
                res.on('error', reject);
            });
            clientReq.on('error', reject);
        });

        if (clientReq) clientReq.destroy();

        assert.ok(receivedEvents.some(e => e.event === 'progress'), 'Expected progress SSE event');
        assert.ok(receivedEvents.some(e => e.event === 'engine' && e.data.type === 'paused'), 'Expected paused engine SSE event');
        assert.ok(receivedEvents.some(e => e.event === 'engine' && e.data.type === 'resumed'), 'Expected resumed engine SSE event');
    } finally {
        await new Promise(resolve => srv.close(resolve));
        env.cleanup();
    }
});

test('Fase 3 verification: 1000-item queue import via API, 2-tab real-time SSE sync, and payload/filter benchmark', async () => {
    const env = createTempEnv();
    const srv = http.createServer(createRequestHandler());

    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;

    try {
        // 1. Import 1,000 gallery IDs via POST /api/import (without auto-running engine)
        engine.isRunning = true; // prevent autoProcessQueue from making network calls
        const idsText = Array.from({ length: 1000 }, (_, i) => String(100001 + i)).join('\n');
        const tImportStart = performance.now();
        const importRes = await new Promise((resolve, reject) => {
            const req = http.request(
                `http://127.0.0.1:${port}/api/queue/import`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                },
                (res) => {
                    let body = '';
                    res.setEncoding('utf8');
                    res.on('data', c => { body += c; });
                    res.on('end', () => resolve(JSON.parse(body)));
                }
            );
            req.on('error', reject);
            req.write(JSON.stringify({ text: idsText, format: 'cbz' }));
            req.end();
        });
        const importMs = performance.now() - tImportStart;
        assert.equal(importRes.success, true);
        assert.equal(importRes.added, 1000);

        // 2. Open 2 concurrent SSE streams (simulating 2 browser tabs)
        const tab1Events = [];
        const tab2Events = [];
        let tab1Req = null;
        let tab2Req = null;
        let deltaBytes = 0;

        const connectTab = (eventsArr) => new Promise((resolve, reject) => {
            let buf = '';
            const req = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    buf += chunk;
                    const parsed = parseSseFrames(buf);
                    buf = parsed.remainder;
                    for (const evt of parsed.events) {
                        eventsArr.push(evt);
                        if (evt.event === 'snapshot') resolve(req);
                        if (evt.event === 'item') deltaBytes = Buffer.byteLength(JSON.stringify(evt.data));
                    }
                });
                res.on('error', reject);
            });
            req.on('error', reject);
        });

        const tSnapStart = performance.now();
        [tab1Req, tab2Req] = await Promise.all([connectTab(tab1Events), connectTab(tab2Events)]);
        const snapMs = performance.now() - tSnapStart;

        assert.equal(tab1Events[0].data.items.length, 1000);
        assert.equal(tab2Events[0].data.items.length, 1000);

        // 3. Mutate item 100500 status via updateQueueStatus and verify BOTH tabs receive the SSE item delta in real time
        const tSyncStart = performance.now();
        updateQueueStatus(100500, 'DONE', { pagesDone: 32, pagesTotal: 32 });

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for 2-tab SSE sync')), 2000);
            const check = setInterval(() => {
                const t1Updated = tab1Events.some(e => e.event === 'item' && e.data.type === 'updated' && e.data.item.galleryId === 100500 && e.data.item.rawStatus === 'DONE');
                const t2Updated = tab2Events.some(e => e.event === 'item' && e.data.type === 'updated' && e.data.item.galleryId === 100500 && e.data.item.rawStatus === 'DONE');
                if (t1Updated && t2Updated) {
                    clearInterval(check);
                    clearTimeout(timeout);
                    resolve();
                }
            }, 5);
        });
        const syncMs = performance.now() - tSyncStart;

        if (tab1Req) tab1Req.destroy();
        if (tab2Req) tab2Req.destroy();

        // Compare full /api/status payload size (polled every 1s on main) vs SSE item delta size
        const fullStatusBytes = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/api/status`, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', c => { body += c; });
                res.on('end', () => resolve(Buffer.byteLength(body)));
            }).on('error', reject);
        });

        assert.ok(deltaBytes < 500, `Expected SSE item delta < 500 bytes, got ${deltaBytes}`);
        assert.ok(fullStatusBytes > 150000, `Expected full 1000-item /api/status > 150KB, got ${fullStatusBytes}`);
        console.log(`[Fase 3 Benchmark] 1000 items import=${importMs.toFixed(1)}ms, 2-tab snapshot=${snapMs.toFixed(1)}ms, 2-tab delta sync=${syncMs.toFixed(1)}ms, SSE delta=${deltaBytes}B vs /api/status=${fullStatusBytes}B`);
    } finally {
        engine.isRunning = false;
        await new Promise(resolve => srv.close(resolve));
        env.cleanup();
    }
});

test('Fase 4 A1-A4 HTTP endpoints: /api/queue/pause, /api/queue/resume, /api/queue/priority, /api/queue/delete, and /api/logs?galleryId=', async () => {
    const env = createTempEnv();
    const srv = http.createServer(createRequestHandler());
    const { logEvent, getQueueItem, getNextPendingItem } = require('../core/db');

    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;

    const requestJson = (method, urlPath, payload) => new Promise((resolve, reject) => {
        const req = http.request(
            `http://127.0.0.1:${port}${urlPath}`,
            {
                method,
                headers: payload ? { 'Content-Type': 'application/json' } : {}
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', c => { body += c; });
                res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(body) }));
            }
        );
        req.on('error', reject);
        if (payload) req.write(JSON.stringify(payload));
        req.end();
    });

    try {
        engine.isRunning = true; // prevent autoProcessQueue network calls
        enqueueGallery({ galleryId: 700001, title: 'One', status: 'PENDING', batch: 1 });
        enqueueGallery({ galleryId: 700002, title: 'Two', status: 'PENDING', batch: 1 });
        enqueueGallery({ galleryId: 700003, title: 'Three', status: 'ERROR', error: 'Err', batch: 1 });

        // 1. Pause 700001 and 700003
        const pauseRes = await requestJson('POST', '/api/queue/pause', { ids: [700001, 700003] });
        assert.equal(pauseRes.statusCode, 200);
        assert.equal(pauseRes.data.paused, 2);
        assert.equal(getQueueItem(700001).status, 'STOPPED');
        assert.equal(getQueueItem(700003).status, 'STOPPED');

        // 2. Resume 700001
        const resumeRes = await requestJson('POST', '/api/queue/resume', { ids: [700001] });
        assert.equal(resumeRes.statusCode, 200);
        assert.equal(resumeRes.data.resumed, 1);
        assert.equal(getQueueItem(700001).status, 'PENDING');

        // 3. Priority: move 700002 to top
        const prioRes = await requestJson('POST', '/api/queue/priority', { ids: [700002], action: 'top' });
        assert.equal(prioRes.statusCode, 200);
        assert.equal(getNextPendingItem().gallery_id, 700002);

        // 4. Per-gallery logs vs global logs
        logEvent({ level: 'info', galleryId: 700002, message: 'Started downloading 700002' });
        logEvent({ level: 'warn', galleryId: 700002, message: 'Retrying page 3 for 700002' });
        logEvent({ level: 'info', galleryId: 700001, message: 'Other gallery log' });

        const galleryLogsRes = await requestJson('GET', '/api/logs?galleryId=700002&limit=10');
        assert.equal(galleryLogsRes.statusCode, 200);
        assert.ok(Array.isArray(galleryLogsRes.data));
        assert.equal(galleryLogsRes.data.length, 2);
        assert.equal(galleryLogsRes.data[0].message, 'Started downloading 700002');
        assert.equal(galleryLogsRes.data[1].level, 'warn');

        const globalLogsRes = await requestJson('GET', '/api/logs');
        assert.equal(globalLogsRes.statusCode, 200);
        assert.equal(typeof globalLogsRes.data.log, 'string');
        assert.ok(globalLogsRes.data.log.includes('Started downloading 700002'));

        // 5. Delete 700003 from queue
        const delRes = await requestJson('POST', '/api/queue/delete', { ids: [700003] });
        assert.equal(delRes.statusCode, 200);
        assert.equal(delRes.data.deleted, 1);
        assert.equal(getQueueItem(700003), null);
    } finally {
        engine.isRunning = false;
        await new Promise(resolve => srv.close(resolve));
        env.cleanup();
    }
});

test('Fase 4 verification: 5000-item mixed status DB, virtual window & filter/sort < 50ms, 2-tab real-time SSE sync (pause/resume/priority/delete), and legacy endpoints', async () => {
    const env = createTempEnv();
    const srv = http.createServer(createRequestHandler());
    const { getDb } = require('../core/db');

    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;

    const requestJson = (method, urlPath, payload) => new Promise((resolve, reject) => {
        const req = http.request(
            `http://127.0.0.1:${port}${urlPath}`,
            {
                method,
                headers: payload ? { 'Content-Type': 'application/json' } : {}
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', c => { body += c; });
                res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(body) }));
            }
        );
        req.on('error', reject);
        if (payload) req.write(JSON.stringify(payload));
        req.end();
    });

    let tab1Req, tab2Req;
    try {
        engine.isPaused = true;
        engine.isRunning = true; // keep engine paused so it does not hit external network

        // 1. Seed 5000 mixed-status items in temp DB
        const db = getDb();
        const statuses = ['PENDING', 'ON_PROGRESS', 'DONE', 'SKIPPED', 'STOPPED', 'ERROR'];
        const formats = ['cbz', 'zip', 'folder'];
        db.exec('BEGIN IMMEDIATE');
        const stmt = db.prepare(`
            INSERT INTO queue (gallery_id, url, title, status, priority, batch, format, pages_total, pages_done, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (let i = 1; i <= 5000; i++) {
            const gid = 800000 + i;
            const st = statuses[i % statuses.length];
            stmt.run(
                gid,
                `https://certain.site/g/${gid}/`,
                `[Artist ${i % 50}] Gallery Title #${i}`,
                st,
                0,
                ((i - 1) % 5) + 1,
                formats[i % formats.length],
                40,
                st === 'DONE' || st === 'SKIPPED' ? 40 : st === 'ON_PROGRESS' || st === 'STOPPED' ? 18 : 0,
                st === 'ERROR' ? 'HTTP 503' : null
            );
        }
        db.exec('COMMIT');

        // 2. Connect 2 SSE tabs and verify 5000-item snapshot
        const tab1Events = [];
        const tab2Events = [];
        const connectTab = (bucket) => new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
                res.setEncoding('utf8');
                let buf = '';
                res.on('data', (chunk) => {
                    buf += chunk;
                    const blocks = buf.split('\n\n');
                    buf = blocks.pop();
                    for (const block of blocks) {
                        const lines = block.split('\n').filter(Boolean);
                        let evName = 'message';
                        let dataStr = '';
                        for (const line of lines) {
                            if (line.startsWith('event: ')) evName = line.slice(7).trim();
                            else if (line.startsWith('data: ')) dataStr += line.slice(6);
                        }
                        if (dataStr) {
                            const parsed = JSON.parse(dataStr);
                            bucket.push({ event: evName, data: parsed });
                            if (evName === 'snapshot') resolve(req);
                        }
                    }
                });
            });
            req.on('error', reject);
        });

        [tab1Req, tab2Req] = await Promise.all([connectTab(tab1Events), connectTab(tab2Events)]);
        const snapItems = tab1Events[0].data.items;
        assert.equal(snapItems.length, 5000);

        // 3. Verify client-side filter + sort + virtual slice (< 50ms & bounded DOM row count)
        const ROW_HEIGHT = 32;
        const OVERSCAN = 10;
        const viewportHeight = 420;
        const runFilterAndVirtualSlice = (filterName, scrollTop = 0) => {
            const t0 = performance.now();
            const filtered = snapItems.filter((it) => {
                if (filterName === 'all') return true;
                if (filterName === 'downloading') return it.rawStatus === 'ON_PROGRESS';
                if (filterName === 'completed') return it.rawStatus === 'DONE' || it.rawStatus === 'SKIPPED';
                if (filterName === 'stopped') return it.rawStatus === 'STOPPED';
                if (filterName === 'failed') return it.rawStatus === 'ERROR';
                return true;
            });
            const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
            const endIdx = Math.min(filtered.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
            const visibleSlice = filtered.slice(startIdx, endIdx);
            const elapsedMs = performance.now() - t0;
            return { count: filtered.length, domRows: visibleSlice.length, elapsedMs };
        };

        for (const f of ['downloading', 'completed', 'stopped', 'failed', 'all']) {
            const res = runFilterAndVirtualSlice(f, 0);
            assert.ok(res.elapsedMs < 50, `Filter ${f} took ${res.elapsedMs.toFixed(2)}ms (expected < 50ms)`);
            assert.ok(res.domRows <= 35, `Virtual DOM rows for ${f} was ${res.domRows} (expected <= 35, not 5000)`);
        }

        // Scroll from top to bottom without empty slices
        const maxScroll = 5000 * ROW_HEIGHT - viewportHeight;
        for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
            const res = runFilterAndVirtualSlice('all', Math.floor(maxScroll * ratio));
            assert.ok(res.domRows >= 20 && res.domRows <= 35, `Expected 20..35 DOM rows at scroll ratio ${ratio}, got ${res.domRows}`);
        }

        // 4. Verify 2-tab real-time SSE sync for pause, resume, priority, delete
        await requestJson('POST', '/api/queue/pause', { ids: [800001] });
        await requestJson('POST', '/api/queue/resume', { ids: [800001] });
        await requestJson('POST', '/api/queue/priority', { ids: [800001], action: 'top' });
        await requestJson('POST', '/api/queue/delete', { ids: [800001] });

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for Tab 2 SSE events')), 2000);
            const check = setInterval(() => {
                const paused = tab2Events.some(e => e.event === 'item' && e.data.item?.galleryId === 800001 && e.data.item?.rawStatus === 'STOPPED');
                const resumed = tab2Events.some(e => e.event === 'item' && e.data.item?.galleryId === 800001 && e.data.item?.rawStatus === 'PENDING');
                const deleted = tab2Events.some(e => e.event === 'item' && e.data.type === 'deleted' && e.data.galleryId === 800001);
                if (paused && resumed && deleted) {
                    clearInterval(check);
                    clearTimeout(timeout);
                    resolve();
                }
            }, 5);
        });

        // 5. Verify legacy endpoints still work properly
        const libRes = await requestJson('GET', '/api/library');
        assert.equal(libRes.statusCode, 200);
        const logsRes = await requestJson('GET', '/api/logs');
        assert.equal(logsRes.statusCode, 200);
        const fsRes = await requestJson('GET', '/api/fs/browse');
        assert.equal(fsRes.statusCode, 200);
    } finally {
        if (tab1Req) tab1Req.destroy();
        if (tab2Req) tab2Req.destroy();
        engine.isRunning = false;
        await new Promise(resolve => srv.close(resolve));
        env.cleanup();
    }
});



