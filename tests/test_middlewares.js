const EventDebouncer = require('../src/event_debouncer');
const InventoryNBTPatch = require('../src/inventory_nbt_patch');
const CreateContraptionHazard = require('../src/create_contraption_hazard');
const EventEmitter = require('events');
const assert = require('assert');

// Mock Bot
class MockBot extends EventEmitter {
    constructor() {
        super();
        this.registry = {
            items: {
                1: { id: 1, name: 'stone', stackSize: 64 },
                2: { id: 2, name: 'diamond', stackSize: 64 }
            }
        };
        this.inventory = new EventEmitter();
        this.pathfinder = {
            movements: {
                getCost: (node, move) => 1
            }
        };
    }
}

async function testEventDebouncer() {
    console.log('--- Testing EventDebouncer ---');
    const bot = new MockBot();
    const debouncer = new EventDebouncer(bot, 100);
    
    let waitStarted = false;
    let waitEnded = false;
    
    debouncer.on('cascading_wait_start', () => { waitStarted = true; });
    debouncer.on('cascading_wait_end', () => { waitEnded = true; });
    
    // Simulate block break
    bot.emit('blockUpdate', { type: 1 }, { type: 0 });
    assert.strictEqual(waitStarted, true);
    assert.strictEqual(waitEnded, false);
    
    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.strictEqual(waitEnded, true);
    console.log('[OK] EventDebouncer verified.');
}

async function testInventoryNBTPatch() {
    console.log('--- Testing InventoryNBTPatch ---');
    const bot = new MockBot();
    const patch = new InventoryNBTPatch(bot);
    
    patch.applyPatches();
    
    // Verify stack size override
    assert.strictEqual(bot.registry.items[1].stackSize, 2147483647);
    assert.strictEqual(bot.registry.items[2].stackSize, 2147483647);
    
    // Verify NBT intercept
    const mockItem = {
        name: 'storage_box',
        count: 1,
        nbt: {
            type: 'compound',
            value: {
                StorageCount: { type: 'int', value: 500 }
            }
        }
    };
    
    bot.inventory.emit('windowUpdate', 10, null, mockItem);
    assert.strictEqual(mockItem.count, 500);
    console.log('[OK] InventoryNBTPatch verified.');
}

async function testCreateContraptionHazard() {
    console.log('--- Testing CreateContraptionHazard ---');
    const bot = new MockBot();
    const hazard = new CreateContraptionHazard(bot.pathfinder);
    
    hazard.applyHeuristicOverride();
    
    // Set a contraption zone
    hazard.updateContraptions([
        { minX: 10, maxX: 20, minY: 60, maxY: 70, minZ: 10, maxZ: 20 }
    ]);
    
    const movements = bot.pathfinder.movements;
    
    // Test point outside
    const costOutside = movements.getCost({}, { x: 5, y: 64, z: 5 });
    assert.strictEqual(costOutside, 1);
    
    // Test point inside
    const costInside = movements.getCost({}, { x: 15, y: 65, z: 15 });
    assert.strictEqual(costInside, Infinity);
    
    console.log('[OK] CreateContraptionHazard verified.');
}

async function runTests() {
    await testEventDebouncer();
    await testInventoryNBTPatch();
    await testCreateContraptionHazard();
    console.log('--- All Middleware Tests Passed ---');
}

runTests().catch(err => {
    console.error('[Test] Failed:', err);
    process.exit(1);
});
