// wiki_rag.js — Issue 10: Local wiki search via inverted index (lightweight RAG)
//
// Usage:
//   const rag = require('./wiki_rag');
//   rag.buildIndex();                      // call once at startup
//   const snippets = rag.search('enderdragon breath attack', 3);
//   // returns array of { file, line, text } for top-N matches
//
// Index is rebuilt automatically when wiki files change (mtime check on each search).

const fs   = require('fs');
const path = require('path');

const WIKI_DIR = path.join(process.cwd(), 'data', 'wiki');
const CRAWL_JSONL = path.join(process.cwd(), 'data', 'processed', 'wiki_crawl', 'pages.jsonl');

// ── State ───────────────────────────────────────────────────────────────────
let _index     = null;  // Map<word, Array<{file,line,text}>>
let _indexedAt = 0;     // mtime of last full rebuild (max of all files)

// ── Tokenisation ────────────────────────────────────────────────────────────
function tokenise(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, ' ')
        .split(' ')
        .filter(t => t.length > 2);
}

function cleanSearchLine(text) {
    if (!text) return '';
    let t = String(text);
    // Remove markdown images and links while preserving anchor text.
    t = t.replace(/!\[[^\]]*\]\([^\)]*\)/g, ' ');
    t = t.replace(/\[([^\]]+)\]\(([^\)]*)\)/g, '$1');
    // Strip raw URLs and repeated heading markers.
    t = t.replace(/https?:\/\/\S+/g, ' ');
    t = t.replace(/[#*_`>|]/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
}

function shouldIndexLine(text) {
    const t = cleanSearchLine(text);
    if (!t) return false;
    if (t.length < 20) return false;
    if (t.length > 700) return false;
    if (/^(file|image|category|help):/i.test(t)) return false;
    if (/cookie|consent|advertis|sponsor|privacy policy/i.test(t)) return false;
    return true;
}

function listWikiTextFilesRecursively(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    const stack = [dir];
    while (stack.length > 0) {
        const cur = stack.pop();
        for (const name of fs.readdirSync(cur)) {
            const full = path.join(cur, name);
            const st = fs.statSync(full);
            if (st.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (name.endsWith('.md') || name.endsWith('.txt')) out.push(full);
        }
    }
    return out;
}

// ── Index building ──────────────────────────────────────────────────────────

/**
 * Reads all .md/.txt files in data/wiki/ and builds an inverted index.
 * Called automatically on first search or when files have changed.
 */
function buildIndex() {
    if (!fs.existsSync(WIKI_DIR)) {
        fs.mkdirSync(WIKI_DIR, { recursive: true });
    }

    const files = listWikiTextFilesRecursively(WIKI_DIR);
    const hasCrawlJsonl = fs.existsSync(CRAWL_JSONL);

    if (files.length === 0 && !hasCrawlJsonl) {
        _index = new Map();
        _indexedAt = Date.now();
        return;
    }

    const mtimes = files.map(f => fs.statSync(f).mtimeMs);
    if (hasCrawlJsonl) mtimes.push(fs.statSync(CRAWL_JSONL).mtimeMs);
    const maxMtime = Math.max(...mtimes);
    if (_index && maxMtime <= _indexedAt) return; // no change

    const newIndex = new Map();

    for (const filePath of files) {
        const fileName = path.relative(WIKI_DIR, filePath).replace(/\\/g, '/');
        const lines = fs.readFileSync(filePath, 'utf8').split('\n');
        lines.forEach((text, idx) => {
            if (!shouldIndexLine(text)) return;
            const cleaned = cleanSearchLine(text);
            const words = tokenise(cleaned);
            for (const word of words) {
                if (!newIndex.has(word)) newIndex.set(word, []);
                newIndex.get(word).push({ file: fileName, line: idx + 1, text: cleaned });
            }
        });
    }

    if (hasCrawlJsonl) {
        const jsonlLines = fs.readFileSync(CRAWL_JSONL, 'utf8').split('\n').filter(Boolean);
        for (const raw of jsonlLines) {
            let obj = null;
            try { obj = JSON.parse(raw); } catch (_) { obj = null; }
            if (!obj || !obj.markdown) continue;
            const source = obj.url || 'crawl4ai';
            const lines = String(obj.markdown).split('\n');
            lines.forEach((text, idx) => {
                if (!shouldIndexLine(text)) return;
                const cleaned = cleanSearchLine(text);
                const words = tokenise(cleaned);
                for (const word of words) {
                    if (!newIndex.has(word)) newIndex.set(word, []);
                    newIndex.get(word).push({ file: source, line: idx + 1, text: cleaned });
                }
            });
        }
    }

    _index = newIndex;
    _indexedAt = maxMtime;
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Search the wiki for a natural-language query.
 * @param {string} query  Space-separated keywords.
 * @param {number} topN   Maximum results to return (default 5).
 * @returns {Array<{file:string, line:number, text:string, score:number}>}
 */
function search(query, topN = 5) {
    buildIndex(); // no-op if already up to date

    if (!_index || _index.size === 0) return [];

    const words = tokenise(query);
    const scores = new Map(); // key → score
    const queryNorm = cleanSearchLine(query).toLowerCase();

    for (const word of words) {
        const hits = _index.get(word) || [];
        for (const hit of hits) {
            const key = `${hit.file}:${hit.line}`;
            scores.set(key, (scores.get(key) || { hit, count: 0 }));
            scores.get(key).count += 1;
        }
    }

    const scored = [...scores.values()].map(({ hit, count }) => {
        const text = (hit.text || '').toLowerCase();
        let bonus = 0;
        if (queryNorm && text.includes(queryNorm)) bonus += 4;
        const allTerms = words.length > 0 && words.every(w => text.includes(w));
        if (allTerms) bonus += 2;
        if (text.length >= 60 && text.length <= 260) bonus += 1;
        if (text.length > 420) bonus -= 1;
        return { ...hit, score: count + bonus };
    });

    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
        .map(r => ({ ...r }));
}

/**
 * Format search results as a compact string suitable for LLM context injection.
 * @param {string} query
 * @param {number} topN
 * @returns {string}  Empty string when no wiki content is available.
 */
function searchForPrompt(query, topN = 3) {
    const results = search(query, topN);
    if (results.length === 0) return '';
    const lines = results.map(r => `[${r.file}:${r.line}] ${r.text}`);
    return `\n\n### Wiki Knowledge (query: "${query}")\n${lines.join('\n')}`;
}

module.exports = { buildIndex, search, searchForPrompt };
