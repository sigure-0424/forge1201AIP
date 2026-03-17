const ConfigRAGParser = require('../src/config_rag_parser');
const assert = require('assert');
const fs = require('fs');

console.log('--- Testing ConfigRAGParser ---');

const parser = new ConfigRAGParser('./data/sample/configs');
parser.parseServerConfigs();

const context = parser.generateLLMPromptContext();
console.log('Generated Context:\n', context);

// Assertions based on data/sample/configs
assert(context.includes('Max Stress = 4096'), 'Should include maxStress from create-common.toml');
assert(context.includes('Max Blocks per vein = 128'), 'Should include maxBlocks from veinminer-common.toml');
assert(context.includes('Cooldown = 10 ticks'), 'Should include cooldown from veinminer-common.toml');

console.log('ConfigRAGParser test PASSED!');
