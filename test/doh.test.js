const test = require('node:test');
const assert = require('node:assert');
const { dohLookup } = require('../core/providers/http');

function lookup(host, options = {}) {
    return new Promise((resolve, reject) => dohLookup(host, options, (err, a, f) => (err ? reject(err) : resolve([a, f]))));
}

test('dohLookup returns DoH A records and falls back to system DNS on failure', async () => {
    const realFetch = global.fetch;
    const savedCtx = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT; // DoH is disabled under the test runner
    try {
        let calls = 0;
        global.fetch = async (url) => {
            calls++;
            assert.match(String(url), /^https:\/\/1\.1\.1\.1\/dns-query\?name=doh-a\.example&type=A$/);
            return { ok: true, json: async () => ({ Answer: [{ type: 5, data: 'x.' }, { type: 1, data: '203.0.113.7' }] }) };
        };
        assert.deepEqual(await lookup('doh-a.example'), ['203.0.113.7', 4]);
        assert.deepEqual(await lookup('doh-a.example', { all: true }), [[{ address: '203.0.113.7', family: 4 }], undefined]);
        assert.equal(calls, 1, 'second lookup is served from the cache');

        global.fetch = async () => { throw new Error('network down'); };
        const [addr] = await lookup('localhost'); // never goes through DoH
        assert.ok(addr);
        await assert.rejects(lookup('doh-b.invalid'), /ENOTFOUND|EAI_AGAIN|ESERVFAIL/);
    } finally {
        global.fetch = realFetch;
        if (savedCtx !== undefined) process.env.NODE_TEST_CONTEXT = savedCtx;
    }
});
