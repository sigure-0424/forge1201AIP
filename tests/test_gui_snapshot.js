// tests/test_gui_snapshot.js
//
// Unit tests for src/gui_snapshot.js
// Tests buildSnapshot(), snapshotToText(), buildGuiPrompt(), slotRole().

'use strict';

const assert = require('assert');
const { buildSnapshot, snapshotToText, buildGuiPrompt, slotRole, windowTypeName } = require('../src/gui_snapshot');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal fake mineflayer item. */
function fakeItem(name, count, nbt) {
    return { name, count, type: 1, nbt: nbt || null };
}

/** Build a minimal fake bot with a currentWindow. */
function fakeBot({ windowType, windowTitle, slots }) {
    const slotArr = slots || [];
    return {
        currentWindow: {
            type:  windowType  || 'unknown',
            title: windowTitle || 'Test Window',
            slots: slotArr,
        },
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function testBuildSnapshotNull() {
    console.log('--- test: buildSnapshot returns null when no window ---');
    assert.strictEqual(buildSnapshot(null), null);
    assert.strictEqual(buildSnapshot({}), null);
    assert.strictEqual(buildSnapshot({ currentWindow: null }), null);
    console.log('[OK]');
}

function testBuildSnapshotBasic() {
    console.log('--- test: buildSnapshot captures window type, title, slot count ---');
    const bot = fakeBot({
        windowType:  'minecraft:furnace',
        windowTitle: 'Furnace',
        slots: [
            fakeItem('minecraft:coal', 10),  // slot 0 — input (furnace)
            fakeItem('minecraft:coal', 8),   // slot 1 — fuel
            null,                            // slot 2 — output (empty)
            // 36 player slots omitted — test with a shorter array
        ],
    });
    const snapshot = buildSnapshot(bot);
    assert.ok(snapshot, 'snapshot should not be null');
    assert.strictEqual(snapshot.windowType, 'minecraft:furnace');
    assert.strictEqual(snapshot.windowTitle, 'Furnace');
    assert.strictEqual(snapshot.totalSlots, 3);
    // slot 0 and 1 should be non-empty
    assert.strictEqual(snapshot.slots[0].empty, false);
    assert.strictEqual(snapshot.slots[0].name, 'minecraft:coal');
    assert.strictEqual(snapshot.slots[0].count, 10);
    // slot 2 (null) should be empty
    assert.strictEqual(snapshot.slots[2].empty, true);
    console.log('[OK]');
}

function testBuildSnapshotAirItem() {
    console.log('--- test: item with type=0 / name="air" treated as empty ---');
    const bot = fakeBot({
        slots: [
            { name: 'air', type: 0, count: 0 },
            fakeItem('minecraft:stone', 5),
        ],
    });
    const snapshot = buildSnapshot(bot);
    assert.strictEqual(snapshot.slots[0].empty, true);
    assert.strictEqual(snapshot.slots[1].empty, false);
    console.log('[OK]');
}

function testSnapshotToTextContainsHeader() {
    console.log('--- test: snapshotToText includes window_type and title ---');
    const bot = fakeBot({
        windowType:  'mymod:machine',
        windowTitle: 'Super Machine',
        slots: [fakeItem('mymod:fuel_item', 32), null],
    });
    const text = snapshotToText(buildSnapshot(bot));
    assert.ok(text.includes('window_type:'), 'should include window_type');
    assert.ok(text.includes('mymod:machine'), 'should include actual type');
    assert.ok(text.includes('Super Machine'), 'should include title');
    assert.ok(text.includes('mymod:fuel_item x32'), 'should include item');
    assert.ok(text.includes('empty'), 'should mark empty slot');
    console.log('[OK]');
}

function testSnapshotToTextNull() {
    console.log('--- test: snapshotToText with null returns fallback string ---');
    const text = snapshotToText(null);
    assert.ok(typeof text === 'string' && text.length > 0);
    console.log('[OK]');
}

function testSlotRolePlayerInventory() {
    console.log('--- test: slotRole identifies player slots ---');
    // 3-slot container + 36 player = 39 total
    const total = 39;
    // slot 3 → player_inv_0
    assert.strictEqual(slotRole(3, 'test:thing', total), 'player_inv_0');
    // slot 29 → player_inv_26
    assert.strictEqual(slotRole(29, 'test:thing', total), 'player_inv_26');
    // slot 30 → player_hotbar_0
    assert.strictEqual(slotRole(30, 'test:thing', total), 'player_hotbar_0');
    // slot 38 → player_hotbar_8
    assert.strictEqual(slotRole(38, 'test:thing', total), 'player_hotbar_8');
    console.log('[OK]');
}

function testSlotRoleFurnace() {
    console.log('--- test: slotRole identifies furnace slots ---');
    // Furnace: 3 container slots + 36 player = 39
    const total = 39;
    assert.strictEqual(slotRole(0, 'minecraft:furnace', total), 'input');
    assert.strictEqual(slotRole(1, 'minecraft:furnace', total), 'fuel');
    assert.strictEqual(slotRole(2, 'minecraft:furnace', total), 'output');
    console.log('[OK]');
}

function testSlotRoleCrafting() {
    console.log('--- test: slotRole identifies crafting table slots ---');
    // Crafting: 10 container + 36 player = 46
    const total = 46;
    assert.strictEqual(slotRole(0, 'minecraft:crafting', total), 'output');
    assert.strictEqual(slotRole(1, 'minecraft:crafting', total), 'grid_0');
    assert.strictEqual(slotRole(9, 'minecraft:crafting', total), 'grid_8');
    console.log('[OK]');
}

function testSlotRoleModGui() {
    console.log('--- test: slotRole falls back to container_N for unknown MOD GUI ---');
    const total = 48; // 12 container + 36 player
    assert.strictEqual(slotRole(0,  'mymod:reactor', total), 'container_0');
    assert.strictEqual(slotRole(11, 'mymod:reactor', total), 'container_11');
    console.log('[OK]');
}

function testWindowTypeName() {
    console.log('--- test: windowTypeName returns readable names ---');
    assert.strictEqual(windowTypeName('minecraft:furnace'), 'Furnace');
    assert.strictEqual(windowTypeName('minecraft:crafting'), 'Crafting Table');
    // Unknown MOD
    const modName = windowTypeName('mymod:fancy_machine');
    assert.ok(modName.includes('MOD GUI'), `expected "MOD GUI" in: ${modName}`);
    console.log('[OK]');
}

function testBuildGuiPromptStructure() {
    console.log('--- test: buildGuiPrompt returns string with key sections ---');
    const bot = fakeBot({
        windowType:  'minecraft:furnace',
        windowTitle: 'Furnace',
        slots: [null, fakeItem('minecraft:coal', 32), null],
    });
    const snapshot = buildSnapshot(bot);
    const prompt = buildGuiPrompt(snapshot, 'check the fuel slot');
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.includes('OPEN GUI'),        'should include OPEN GUI header');
    assert.ok(prompt.includes('check the fuel slot'), 'should include instruction');
    assert.ok(prompt.includes('click_slot'),      'should mention click_slot primitive');
    assert.ok(prompt.includes('transfer_slot'),   'should mention transfer_slot');
    assert.ok(prompt.includes('close_window'),    'should mention close_window');
    assert.ok(prompt.includes('minecraft:coal'),  'should include item in snapshot');
    console.log('[OK]');
}

function testNbtAnnotation() {
    console.log('--- test: NBT Damage tag is included in snapshot text ---');
    const itemWithNbt = {
        name: 'minecraft:diamond_sword',
        count: 1,
        type: 1,
        nbt: {
            value: {
                Damage: { value: 50, type: 'int' },
            },
        },
    };
    const bot = fakeBot({ slots: [itemWithNbt] });
    const text = snapshotToText(buildSnapshot(bot));
    assert.ok(text.includes('Damage:50'), `Expected Damage:50 in: ${text}`);
    console.log('[OK]');
}

// ── Run all ───────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== test_gui_snapshot.js ===');
    testBuildSnapshotNull();
    testBuildSnapshotBasic();
    testBuildSnapshotAirItem();
    testSnapshotToTextContainsHeader();
    testSnapshotToTextNull();
    testSlotRolePlayerInventory();
    testSlotRoleFurnace();
    testSlotRoleCrafting();
    testSlotRoleModGui();
    testWindowTypeName();
    testBuildGuiPromptStructure();
    testNbtAnnotation();
    console.log('=== All gui_snapshot tests passed ===');
}

main().catch(e => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
