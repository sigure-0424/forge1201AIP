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

async function runTest() {
    console.log('--- Starting DynamicRegistryInjector Test ---');
    
    const registry = createMockRegistry();
    const injector = new DynamicRegistryInjector(registry);
    
    const mockPayload = Buffer.alloc(0); // Payload parsing is currently a mock anyway
    const parsed = injector.parseRegistryPayload(mockPayload);
    
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].name, 'create:andesite_alloy');
    
    injector.injectBlockToRegistry(parsed);
    
    // Verify injection
    assert.ok(registry.items[4001]);
    assert.strictEqual(registry.items[4001].name, 'create:andesite_alloy');
    assert.strictEqual(registry.itemsByName['create:andesite_alloy'].id, 4001);
    
    assert.ok(registry.blocks[4002]);
    assert.strictEqual(registry.blocks[4002].name, 'veinminer:vein_block');
    assert.strictEqual(registry.blocksByName['veinminer:vein_block'].id, 4002);
    
    console.log('--- DynamicRegistryInjector Test Passed ---');
}

runTest().catch(err => {
    console.error('[Test] Failed:', err);
    process.exit(1);
});
