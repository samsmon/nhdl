const test = require('node:test');
const assert = require('node:assert');

async function load() {
    return await import('../webui/src/lib/queueView.js');
}

const pad = (n) => String(n).padStart(2, '0');

test('isQueuedStatus matches PENDING and ON_PROGRESS only', async () => {
    const q = await load();
    assert.strictEqual(q.isQueuedStatus('PENDING'), true);
    assert.strictEqual(q.isQueuedStatus('ON_PROGRESS'), true);
    for (const s of ['DONE', 'SKIPPED', 'STOPPED', 'ERROR', 'COOLDOWN', 'PAUSED', '', null, undefined]) {
        assert.strictEqual(q.isQueuedStatus(s), false, String(s));
    }
});

test('parseAddedAt handles SQLite UTC, ISO, and invalid values', async () => {
    const q = await load();
    const sqlite = q.parseAddedAt('2026-10-06 06:31:45');
    assert.ok(sqlite instanceof Date);
    assert.strictEqual(sqlite.toISOString(), '2026-10-06T06:31:45.000Z');
    const iso = q.parseAddedAt('2026-10-06T06:31:45.000Z');
    assert.strictEqual(iso.toISOString(), '2026-10-06T06:31:45.000Z');
    const isoOffset = q.parseAddedAt('2026-10-06T13:31:45+07:00');
    assert.strictEqual(isoOffset.toISOString(), '2026-10-06T06:31:45.000Z');
    const asDate = q.parseAddedAt(new Date('2026-10-06T06:31:45Z'));
    assert.strictEqual(asDate.toISOString(), '2026-10-06T06:31:45.000Z');
    for (const bad of [null, undefined, '', 'garbage', '0000-00-00 00:00:00', {}, NaN]) {
        assert.strictEqual(q.parseAddedAt(bad), null, String(bad));
    }
});

test('formatAddedAt / formatAddedAtFull use local time', async () => {
    const q = await load();
    const d = new Date('2026-10-06T06:31:45Z');
    const short = q.formatAddedAt('2026-10-06 06:31:45');
    assert.strictEqual(short, `${pad(d.getDate())} Okt ${pad(d.getHours())}:${pad(d.getMinutes())}`);
    const full = q.formatAddedAtFull('2026-10-06 06:31:45');
    assert.strictEqual(
        full,
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
    assert.strictEqual(q.formatAddedAt('nope'), '—');
    assert.strictEqual(q.formatAddedAtFull(null), '—');
    // month abbreviations
    const may = new Date(2026, 4, 3, 9, 5, 0);
    assert.match(q.formatAddedAt(may.toISOString()), /^03 Mei 09:05$/);
});

test('formatCooldown', async () => {
    const q = await load();
    assert.strictEqual(q.formatCooldown(22), '22s');
    assert.strictEqual(q.formatCooldown(59), '59s');
    assert.strictEqual(q.formatCooldown(60), '1:00');
    assert.strictEqual(q.formatCooldown(272), '4:32');
    assert.strictEqual(q.formatCooldown(3600), '60:00');
    assert.strictEqual(q.formatCooldown(21.2), '22s');
    assert.strictEqual(q.formatCooldown(-5), '0s');
    assert.strictEqual(q.formatCooldown(NaN), '0s');
    assert.strictEqual(q.formatCooldown(undefined), '0s');
});

test('cooldownInfo maps live progress to chip info', async () => {
    const q = await load();
    assert.deepStrictEqual(
        q.cooldownInfo({ type: 'COOLDOWN', remaining: 22, message: 'Next in queue in: 22s' }, 'COOLDOWN'),
        { kind: 'next', remaining: 22, message: 'Next in queue in: 22s' }
    );
    assert.deepStrictEqual(
        q.cooldownInfo({ type: 'BATCH_REST', remaining: 300, title: 'Batch 1 Complete' }, 'COOLDOWN'),
        { kind: 'next', remaining: 300, message: 'Batch 1 Complete' }
    );
    assert.deepStrictEqual(
        q.cooldownInfo({ type: 'RATE_LIMIT', remaining: 272, message: 'Retrying in: 4m 32s' }, 'COOLDOWN_429'),
        { kind: 'rate_limit', remaining: 272, message: 'Retrying in: 4m 32s' }
    );
    assert.strictEqual(q.cooldownInfo(null, 'IDLE'), null);
    assert.strictEqual(q.cooldownInfo(undefined, 'RUNNING'), null);
    assert.strictEqual(q.cooldownInfo({ type: 'DOWNLOAD', remaining: 5 }, 'RUNNING'), null);
    assert.strictEqual(q.cooldownInfo({ type: 'COOLDOWN', remaining: 0 }, 'COOLDOWN'), null);
    assert.strictEqual(q.cooldownInfo({ type: 'COOLDOWN', remaining: -1 }, 'COOLDOWN'), null);
    assert.strictEqual(q.cooldownInfo({ type: 'COOLDOWN', remaining: 'x' }, 'COOLDOWN'), null);
    assert.strictEqual(q.cooldownInfo({ type: 'COOLDOWN' }, 'COOLDOWN'), null);
    assert.deepStrictEqual(
        q.cooldownInfo({ type: 'COOLDOWN', remaining: 3 }, 'COOLDOWN'),
        { kind: 'next', remaining: 3, message: '' }
    );
});
