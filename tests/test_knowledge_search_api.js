'use strict';

const assert = require('assert');
const WebUIServer = require('../src/web_ui_server');

function makeManagerStub() {
    return {
        bots: new Map(),
        botConnOptions: new Map(),
        botStatus: new Map(),
        chatLog: new Map(),
        onEvent: null,
        startBot: () => {},
        scheduleRestart: () => {},
        handleIPCMessage: () => {},
    };
}

async function httpJson(url, init) {
    const res = await fetch(url, init);
    const data = await res.json();
    return { status: res.status, data };
}

async function main() {
    const manager = makeManagerStub();
    const web = new WebUIServer(manager, { host: 'localhost', port: 25565, mode: 'full_auto' }, null);

    const port = 34123;
    await new Promise((resolve, reject) => {
        web.server.once('error', reject);
        web.server.listen(port, () => resolve());
    });

    try {
        const statusRes = await httpJson(`http://127.0.0.1:${port}/api/knowledge/status`);
        assert.strictEqual(statusRes.status, 200, 'status endpoint should return 200');
        assert.strictEqual(statusRes.data.ok, true, 'status endpoint should return ok=true');
        assert.ok(typeof statusRes.data.pages === 'number', 'status.pages should be a number');

        const query = 'create mechanical belt';
        const searchRes = await httpJson(`http://127.0.0.1:${port}/api/knowledge/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, topN: 5 }),
        });
        assert.strictEqual(searchRes.status, 200, 'search endpoint should return 200');
        assert.strictEqual(searchRes.data.ok, true, 'search endpoint should return ok=true');
        assert.ok(Array.isArray(searchRes.data.results), 'search results should be an array');

        for (const r of searchRes.data.results) {
            assert.ok(Number.isInteger(r.rank) && r.rank > 0, 'rank should be positive integer');
            assert.ok(typeof r.file === 'string', 'file should be string');
            assert.ok(Number.isFinite(r.line), 'line should be numeric');
            assert.ok(typeof r.text === 'string', 'text should be string');
            assert.ok(Number.isFinite(r.score), 'score should be numeric');
            assert.ok(r.source && typeof r.source.file === 'string', 'source.file should exist');
            assert.ok(Number.isFinite(r.source.line), 'source.line should be numeric');
            assert.strictEqual(r.snippet, r.text, 'snippet should mirror text for normalized schema');
        }

        const badRes = await httpJson(`http://127.0.0.1:${port}/api/knowledge/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '' }),
        });
        assert.strictEqual(badRes.status, 400, 'empty query should return 400');

        console.log('[test_knowledge_search_api] PASS');
    } finally {
        await new Promise(resolve => web.server.close(() => resolve()));
    }
}

main().catch((err) => {
    console.error('[test_knowledge_search_api] FAIL:', err.message);
    process.exit(1);
});
