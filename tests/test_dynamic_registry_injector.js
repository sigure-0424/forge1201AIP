const DynamicRegistryInjector = require('../src/dynamic_registry_injector');
const assert = require('assert');

// Mock bot registry structure
function createMockRegistry() {
    return {
        blocks: {},
        blocksByName: {},
        items: {},
        itemsByName: {}
    };
}

function writeVarInt(value) {
    const bytes = [];
    do {
        let temp = (value & 0b01111111);
        value >>>= 7;
        if (value != 0) temp |= 0b10000000;
        bytes.push(temp);
    } while (value != 0);
    return Buffer.from(bytes);
}

async function runTest() {
    console.log('--- Starting DynamicRegistryInjector Test ---');
    
    const registry = createMockRegistry();
    const injector = new DynamicRegistryInjector(registry);
    
    // Build a mock payload that has a ResourceLocation string and a VarInt ID
    const name = 'create:andesite_alloy';
    const id = 4001;
    const payload = Buffer.concat([
        Buffer.from([0, 0, 0]), // Binary zeros as prefix
        Buffer.from(name, 'utf8'),
        writeVarInt(id),
        Buffer.from([0, 0, 0]) // Binary zeros as suffix
    ]);
    
    const parsed = injector.parseRegistryPayload([payload]);
    
    assert.ok(parsed.length >= 1, 'Should have discovered at least 1 entry');
    const entry = parsed.find(e => e.name === name);
    assert.ok(entry, 'Should find create:andesite_alloy');
    assert.strictEqual(entry.id, id, 'ID should match');
    
    injector.injectBlockToRegistry(parsed);
    
    // Verify injection
    assert.ok(registry.items[id]);
    assert.strictEqual(registry.items[id].name, name);
    
    console.log('--- DynamicRegistryInjector Test Passed ---');
}

runTest().catch(err => {
    console.error('[Test] Failed:', err);
    process.exit(1);
});
