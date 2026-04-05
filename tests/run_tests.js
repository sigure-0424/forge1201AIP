'use strict';
// run_tests.js — Test runner driven by tests/test_manifest.json.
// Usage: node tests/run_tests.js [--category <name>] [--id <id>]

const fs   = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, 'test_manifest.json');
const RESULTS_DIR   = path.join(process.cwd(), 'results');

// ── Argument parsing ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let filterCategory = null;
let filterId       = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) { filterCategory = args[++i]; }
    else if (args[i] === '--id' && args[i + 1])       { filterId       = args[++i]; }
}

// ── Load manifest ─────────────────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

// Flatten all test entries
const allTests = [];
for (const [category, entries] of Object.entries(manifest.categories || {})) {
    for (const entry of entries) {
        allTests.push({ ...entry, category });
    }
}

// ── Filter ─────────────────────────────────────────────────────────────────────
let testsToRun = allTests;
if (filterCategory) testsToRun = testsToRun.filter(t => t.category === filterCategory);
if (filterId)       testsToRun = testsToRun.filter(t => t.id === filterId);

// Only run entries with a non-null script
const runnable = testsToRun.filter(t => t.script !== null);
const skipped  = testsToRun.filter(t => t.script === null);

// ── Runner ────────────────────────────────────────────────────────────────────
async function runTest(entry) {
    const scriptPath = path.resolve(process.cwd(), entry.script);
    const start = Date.now();

    try {
        // Clear require cache so sequential runs don't share state
        delete require.cache[require.resolve(scriptPath)];
        const result = require(scriptPath);
        // If the module exports a promise or async function, await it
        if (result && typeof result.then === 'function') {
            await result;
        } else if (typeof result === 'function') {
            await result();
        }
        return { id: entry.id, category: entry.category, status: 'pass', duration_ms: Date.now() - start, error: null };
    } catch (err) {
        return { id: entry.id, category: entry.category, status: 'fail', duration_ms: Date.now() - start, error: err.message };
    }
}

// ── Load previous report for diff ─────────────────────────────────────────────
function loadLatestReport() {
    try {
        if (!fs.existsSync(RESULTS_DIR)) return null;
        const files = fs.readdirSync(RESULTS_DIR)
            .filter(f => f.startsWith('test_report_') && f.endsWith('.json'))
            .sort()
            .reverse();
        if (files.length === 0) return null;
        return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, files[0]), 'utf8'));
    } catch (_) {
        return null;
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
    console.log(`\n[TestRunner] Running ${runnable.length} test(s)  (${skipped.length} skipped — no script)\n`);

    const results = [];

    for (const entry of runnable) {
        process.stdout.write(`  ${entry.category}/${entry.id} … `);
        const r = await runTest(entry);
        results.push(r);
        console.log(r.status === 'pass' ? 'PASS' : `FAIL  ${r.error}`);
    }

    for (const entry of skipped) {
        results.push({ id: entry.id, category: entry.category, status: 'skip', duration_ms: 0, error: null });
    }

    const pass = results.filter(r => r.status === 'pass').length;
    const fail = results.filter(r => r.status === 'fail').length;
    const skip = results.filter(r => r.status === 'skip').length;

    const report = {
        run_at: new Date().toISOString(),
        summary: { total: results.length, pass, fail, skip },
        results
    };

    // Write report
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(RESULTS_DIR, `test_report_${ts}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n[TestRunner] Report written: ${reportPath}`);
    console.log(`[TestRunner] Summary: total=${results.length} pass=${pass} fail=${fail} skip=${skip}`);

    // ── Diff against previous report ──────────────────────────────────────
    const prev = loadLatestReport();
    if (prev && prev.results) {
        const prevById = new Map(prev.results.map(r => [r.id, r.status]));
        const fixed       = results.filter(r => r.status === 'pass' && prevById.get(r.id) === 'fail');
        const regressions = results.filter(r => r.status === 'fail' && prevById.get(r.id) === 'pass');

        if (fixed.length > 0) {
            console.log('\n✔ Regressions fixed (FAIL → PASS):');
            fixed.forEach(r => console.log(`  ${r.category}/${r.id}`));
        }
        if (regressions.length > 0) {
            console.log('\n✘ New regressions (PASS → FAIL):');
            regressions.forEach(r => console.log(`  ${r.category}/${r.id}  ${r.error}`));
        }
        if (fixed.length === 0 && regressions.length === 0) {
            console.log('\n  No status changes vs previous run.');
        }
    }

    process.exit(fail > 0 ? 1 : 0);
})();
