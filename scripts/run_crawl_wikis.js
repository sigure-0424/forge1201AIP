#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

const image = 'unclecode/crawl4ai:0.8.5';
const cwd = process.cwd();
const passthrough = process.argv.slice(2);

const args = [
  'run', '--rm',
  '-v', `${cwd}:/workspace`,
  '-w', '/workspace',
  image,
  'python', 'scripts/crawl_wiki_sources.py',
  ...passthrough,
];

const result = spawnSync('docker', args, { stdio: 'inherit' });
if (result.error) {
  console.error(`[crawl:wikis] failed to execute docker: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
