const DynamicRegistryInjector = require('../src/dynamic_registry_injector');
const assert = require('assert');

function createMockRegistry() {
    return {
        blocks: {
            1: { id: 1, name: 'stone', isUnknownModBlock: false }
        },
        blocksByName: {
            'stone': { id: 1, name: 'stone', isUnknownModBlock: false },
            'water': { id: 32, name: 'water', isUnknownModBlock: false }
        },
        items: {},
        itemsByName: {}
    };
}

async function runTest() {
    console.log('--- Starting Heuristic Collision Test ---');
    const registry = createMockRegistry();
    const injector = new DynamicRegistryInjector(registry);

    // Simulating the bug: minecraft:water is parsed with id 1
    const parsed = [{ id: 1, name: 'minecraft:water', type: 'block' }];

    injector.injectBlockToRegistry(parsed);

    // Since water maps to 1, but 1 is already stone, the injection should skip
    // and stone should remain at blocks[1]
    assert.strictEqual(registry.blocks[1].name, 'stone', 'blocks[1] should still be stone');
    console.log('--- Heuristic Collision Test Passed ---');
}

runTest().catch(err => {
    console.error('[Test] Failed:', err);
    process.exit(1);
});
