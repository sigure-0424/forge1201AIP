#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const dictPath = path.join(root, 'data', 'sample', 'configs', 'mod_blocks_dictionary.json');
const rawDir = path.join(root, 'data', 'raw');
const outPath = path.join(root, 'data', 'wiki', 'modpack_index.md');

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function listRuntimeFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === '.gitkeep') continue;
    out.push(name);
  }
  return out;
}

function buildFromDictionary(dict) {
  const byNamespace = new Map();
  for (const fullName of Object.keys(dict || {})) {
    const i = fullName.indexOf(':');
    if (i <= 0) continue;
    const ns = fullName.slice(0, i);
    const block = fullName.slice(i + 1);
    if (!byNamespace.has(ns)) byNamespace.set(ns, []);
    byNamespace.get(ns).push(block);
  }

  const namespaces = [...byNamespace.keys()].sort();
  const lines = [];
  lines.push('# Modpack Knowledge Index');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Data Sources');
  lines.push(`- mod_blocks_dictionary: ${fs.existsSync(dictPath) ? 'available' : 'missing'}`);

  const runtimeFiles = listRuntimeFiles(rawDir);
  if (runtimeFiles.length === 0) {
    lines.push('- runtime world capture: unavailable (data/raw has no capture files)');
    lines.push('- note: This index is built from sample config only, not the current experiment-world runtime dump.');
  } else {
    lines.push(`- runtime world capture files: ${runtimeFiles.join(', ')}`);
  }

  lines.push('');
  lines.push('## Namespace Summary');
  lines.push(`- namespaces: ${namespaces.length}`);
  lines.push(`- total blocks: ${Object.keys(dict || {}).length}`);
  lines.push('');
  lines.push('## Namespace Details');
  lines.push('');

  for (const ns of namespaces) {
    const blocks = byNamespace.get(ns).sort();
    const sample = blocks.slice(0, 15).join(', ');
    lines.push(`### ${ns}`);
    lines.push(`- block_count: ${blocks.length}`);
    lines.push(`- sample_blocks: ${sample}${blocks.length > 15 ? ', ...' : ''}`);
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  const dict = safeReadJson(dictPath);
  if (!dict || typeof dict !== 'object') {
    console.error('[mod-index] mod_blocks_dictionary.json is missing or invalid.');
    process.exit(1);
  }

  const text = buildFromDictionary(dict);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text);

  const nsCount = text.split('\n').filter(l => l.startsWith('### ')).length;
  console.log(`[mod-index] wrote ${path.relative(root, outPath)} (${nsCount} namespaces).`);
}

main();
