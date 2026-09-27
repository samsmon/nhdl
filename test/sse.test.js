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

