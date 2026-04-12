// src/actuator/tools.js
// Equipment, inventory, and container helpers extracted from bot_actuator.js.

'use strict';

const { goals } = require('mineflayer-pathfinder');
const Vec3      = require('vec3');
const ctx       = require('./ctx');
const { withTimeout } = require('./utils');
const { detectAviationMethod } = require('./flight');

// ── Constants ────────────────────────────────────────────────────────────────

const TOOL_SUFFIXES  = ['_pickaxe', '_axe', '_shovel', '_hoe', '_sword', '_shears'];
const WEAPON_PRIORITY = [
    'netherite_axe', 'diamond_axe', 'iron_axe', 'netherite_sword', 'diamond_sword', 'iron_sword',
    'stone_axe', 'stone_sword', 'wooden_axe', 'wooden_sword', 'golden_axe', 'golden_sword'
];
const ARMOR_TIERS  = ['netherite', 'diamond', 'iron', 'golden', 'chainmail', 'leather'];
const ARMOR_PIECES = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' };

const PLANK_NAMES = new Set([
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks'
]);
const LOG_NAMES = new Set([
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'mangrove_log', 'cherry_log',
    'oak_wood', 'spruce_wood', 'birch_wood', 'jungle_wood', 'acacia_wood',
    'dark_oak_wood', 'mangrove_wood', 'cherry_wood',
    'bamboo_block', 'stripped_bamboo_block',
]);

const _LOG_LIST   = [...LOG_NAMES];
const _PLANK_LIST = [...PLANK_NAMES];
const MATERIAL_TAG_GROUPS = {
    oak_log:         _LOG_LIST, spruce_log:    _LOG_LIST, birch_log:     _LOG_LIST,
    jungle_log:      _LOG_LIST, acacia_log:    _LOG_LIST, dark_oak_log:  _LOG_LIST,
    mangrove_log:    _LOG_LIST, cherry_log:    _LOG_LIST, oak_wood:      _LOG_LIST,
    bamboo_block:    _LOG_LIST, stripped_bamboo_block: _LOG_LIST,
    oak_planks:     _PLANK_LIST, spruce_planks:   _PLANK_LIST, birch_planks:    _PLANK_LIST,
    jungle_planks:  _PLANK_LIST, acacia_planks:   _PLANK_LIST, dark_oak_planks: _PLANK_LIST,
    mangrove_planks:_PLANK_LIST, cherry_planks:   _PLANK_LIST, bamboo_planks:   _PLANK_LIST,
    stone:       ['stone', 'andesite', 'granite', 'diorite', 'tuff', 'calcite', 'deepslate'],
    andesite:    ['stone', 'andesite', 'granite', 'diorite'],
    cobblestone: ['cobblestone', 'stone'],
};

// ── Item name helpers ────────────────────────────────────────────────────────

function _shortItemName(name) {
    if (!name) return '';
    const n = String(name).toLowerCase();
    return n.includes(':') ? n.split(':').pop() : n;
}

function resolveInventoryItemForTarget(targetName) {
    const bot     = ctx.bot;
    const wanted  = String(targetName || '').toLowerCase().trim();
    if (!wanted) return null;
    const wantedShort = _shortItemName(wanted);
    const inventory   = bot.inventory.items();
    if (!inventory.length) return null;

    let exact = inventory.find(i => String(i.name || '').toLowerCase() === wanted);
    if (exact) return exact;
    exact = inventory.find(i => _shortItemName(i.name) === wantedShort);
    if (exact) return exact;

    let fuzzy = inventory.find(i => String(i.name || '').toLowerCase().includes(wanted));
    if (fuzzy) return fuzzy;
    fuzzy = inventory.find(i => _shortItemName(i.name).includes(wantedShort));
    return fuzzy || null;
}

// ── Block placement helper ───────────────────────────────────────────────────

async function placeItemIntelligently(itemToPlace, timeoutMs) {
    const bot = ctx.bot;
    const refs = bot.findBlocks({
        matching: b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava' && b.boundingBox === 'block',
        maxDistance: 4,
        count: 50
    });
    refs.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
    const botPos = bot.entity.position;

    for (const refPos of refs) {
        const placePos   = refPos.offset(0, 1, 0);
        const blockAbove = bot.blockAt(placePos);
        if (blockAbove && blockAbove.name === 'air') {
            const dx = Math.abs(botPos.x - (placePos.x + 0.5));
            const dz = Math.abs(botPos.z - (placePos.z + 0.5));
            const dy = placePos.y - botPos.y;
            const intersectsBot = dx < 0.8 && dz < 0.8 && dy > -1 && dy < 2;
            if (!intersectsBot) {
                const refBlock = bot.blockAt(refPos);
                try {
                    await bot.equip(itemToPlace, 'hand');
                    const promise = bot.placeBlock(refBlock, new Vec3(0, 1, 0));
                    if (timeoutMs) await withTimeout(promise, timeoutMs, 'place block');
                    else           await promise;
                    return true;
                } catch (e) {
                    console.log(`[Actuator] Intelligent place failed at ${refPos}: ${e.message}`);
                }
            }
        }
    }

    try {
        const botFloored = bot.entity.position.floored();
        const blockBelow = bot.blockAt(botFloored.offset(0, -1, 0));
        if (blockBelow && blockBelow.boundingBox === 'block') {
            await bot.equip(itemToPlace, 'hand');
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 250));
            const promise = bot.placeBlock(blockBelow, new Vec3(0, 1, 0));
            bot.setControlState('jump', false);
            if (timeoutMs) await withTimeout(promise, timeoutMs, 'jump place block');
            else           await promise;
            return true;
        }
    } catch (e) {
        ctx.bot.setControlState('jump', false);
        console.log(`[Actuator] Jump place failed: ${e.message}`);
    }
    throw new Error('No valid location to place block');
}

// ── Equipment helpers ────────────────────────────────────────────────────────

async function equipBestTool(block) {
    const bot       = ctx.bot;
    const toolItems = bot.inventory.items().filter(i => TOOL_SUFFIXES.some(s => i.name.endsWith(s)));
    let bestTool = null, bestTime = block.digTime(null, false, false, false, [], bot.entity.effects);
    for (const tool of toolItems) {
        const t = block.digTime(tool.type, false, false, false, [], bot.entity.effects);
        if (t < bestTime) { bestTime = t; bestTool = tool; }
    }
    if (bestTool) {
        try { await bot.equip(bestTool, 'hand'); }
        catch (e) { console.log(`[Actuator] equipBestTool: ${e.message}`); }
    }
}

async function equipBestWeapon() {
    const bot = ctx.bot;
    for (const name of WEAPON_PRIORITY) {
        const w = bot.inventory.items().find(i => i.name === name);
        if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} break; }
    }
    const shield = bot.inventory.items().find(i => i.name === 'shield');
    if (shield) { try { await bot.equip(shield, 'off-hand'); } catch (e) {} }
}

async function equipBestArmor() {
    const bot = ctx.bot;
    for (const [slot, piece] of Object.entries(ARMOR_PIECES)) {
        const destSlot       = bot.getEquipmentDestSlot(slot);
        const currentEquipped = bot.inventory.slots[destSlot];
        if (slot === 'torso' && detectAviationMethod(currentEquipped)) continue;
        const currentTierIdx  = currentEquipped
            ? ARMOR_TIERS.findIndex(t => currentEquipped.name === `${t}_${piece}`)
            : ARMOR_TIERS.length;
        const effectiveIdx = currentTierIdx === -1 ? ARMOR_TIERS.length : currentTierIdx;
        for (let i = 0; i < effectiveIdx; i++) {
            const a = bot.inventory.items().find(itm => itm.name === `${ARMOR_TIERS[i]}_${piece}`);
            if (a) {
                try {
                    if (currentEquipped) await bot.unequip(slot);
                    await bot.equip(a, slot);
                } catch (e) {}
                break;
            }
        }
    }
}

function isMissingGear() {
    const bot = ctx.bot;
    for (const slot of ['head', 'torso', 'legs', 'feet']) {
        if (!bot.inventory.slots[bot.getEquipmentDestSlot(slot)]) return true;
    }
    return !WEAPON_PRIORITY.some(name => bot.inventory.items().find(i => i.name === name));
}

function getEquipmentContainerIds() {
    const bot = ctx.bot;
    const ids = [];
    const reg = bot.registry.blocksByName;
    for (const name of ['chest', 'barrel']) {
        if (reg[name]?.id !== undefined) ids.push(reg[name].id);
    }
    for (const key of Object.keys(reg)) {
        if (key === 'shulker_box' || key.endsWith('_shulker_box')) ids.push(reg[key].id);
    }
    return ids;
}

// ── Container helpers ────────────────────────────────────────────────────────

function _normalizeContainerKind(raw) {
    const t = String(raw || '').toLowerCase();
    if (t.includes('shulker') || t.includes('シュルカー')) return 'shulker';
    if (t.includes('barrel')  || t.includes('バレル'))    return 'barrel';
    if (t.includes('chest')   || t.includes('チェスト') || t.includes('箱')) return 'chest';
    return 'container';
}

function _normalizeItemTargetName(raw) {
    const text = String(raw || '').toLowerCase().trim();
    if (!text) return '';
    const aliases = [
        { re: /(滑らかな石|smooth[_\s-]?stone|smoothstone)/i, id: 'smooth_stone' },
        { re: /(丸石|cobblestone|cobble)/i,                   id: 'cobblestone' },
        { re: /(石|stone)/i,                                  id: 'stone' },
        { re: /(原木|log)/i,                                  id: 'oak_log' }
    ];
    for (const a of aliases) { if (a.re.test(text)) return a.id; }
    return text.replace(/[\s-]+/g, '_');
}

function _isContainerBlockByName(name) {
    const n = String(name || '').toLowerCase();
    return n === 'chest' || n === 'trapped_chest' || n === 'barrel' ||
           n === 'shulker_box' || n.endsWith('_shulker_box');
}

function _getContainerBlockIds(kind = 'container') {
    const bot = ctx.bot;
    const reg = bot.registry.blocksByName || {};
    const ids = new Set();
    const k = _normalizeContainerKind(kind);
    for (const [name, info] of Object.entries(reg)) {
        if (!info || info.id === undefined) continue;
        const n = String(name || '').toLowerCase();
        if (k === 'chest'     && (n === 'chest' || n === 'trapped_chest')) ids.add(info.id);
        else if (k === 'barrel'  && n === 'barrel') ids.add(info.id);
        else if (k === 'shulker' && (n === 'shulker_box' || n.endsWith('_shulker_box'))) ids.add(info.id);
        else if (k === 'container' && _isContainerBlockByName(n)) ids.add(info.id);
    }
    return [...ids];
}

function _resolveContainerCoords(action) {
    const candidates = _listContainerCandidates(action);
    return candidates.length > 0 ? candidates[0] : null;
}

function _listContainerCandidates(action) {
    const bot = ctx.bot;
    const hasExplicit = [action.x, action.y, action.z].every(
        v => v !== undefined && v !== null && Number.isFinite(Number(v))
    );
    if (hasExplicit) {
        return [{ x: Number(action.x), y: Number(action.y), z: Number(action.z), via: 'explicit' }];
    }
    const kind        = _normalizeContainerKind(action.container || action.target || 'container');
    const requestedMax = Number.isFinite(Number(action.distance)) ? Number(action.distance) : 96;
    const maxDistance  = Math.max(16, Math.min(192, requestedMax));
    const ids = _getContainerBlockIds(kind);
    if (ids.length === 0) return [];

    const positions = [];
    const seen      = new Set();
    const radii     = [Math.min(32, maxDistance), Math.min(64, maxDistance), Math.min(96, maxDistance), maxDistance]
        .filter((v, i, arr) => v > 0 && arr.indexOf(v) === i)
        .sort((a, b) => a - b);
    for (const r of radii) {
        const found = bot.findBlocks({ matching: ids, maxDistance: r, count: 256 }) || [];
        for (const p of found) {
            const key = `${p.x},${p.y},${p.z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            positions.push(p);
        }
        if (positions.length >= 8) break;
    }
    if (!positions.length) return [];

    return positions
        .map(p => ({
            x: p.x, y: p.y, z: p.z,
            via: `nearest_${kind}`,
            _dist: bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z))
        }))
        .sort((a, b) => a._dist - b._dist)
        .map(({ _dist, ...rest }) => rest);
}

function _resolveTargetItemIds(itemTargetName) {
    const bot        = ctx.bot;
    const normalized = _normalizeItemTargetName(itemTargetName);
    const ids        = [];
    const targetGroup = MATERIAL_TAG_GROUPS[normalized];
    if (targetGroup) {
        for (const n of targetGroup) {
            const id = bot.registry.itemsByName[n]?.id || bot.registry.blocksByName[n]?.id;
            if (id !== undefined) ids.push(id);
        }
    } else {
        const id = bot.registry.itemsByName[normalized]?.id || bot.registry.blocksByName[normalized]?.id;
        if (id !== undefined) ids.push(id);
    }
    return ids;
}

async function _withdrawFromOpenedContainer(containerWindow, neededIds, quantity) {
    let taken = 0;
    while (taken < quantity && !ctx.currentCancelToken.cancelled) {
        const match = containerWindow.containerItems().find(i => neededIds.includes(i.type));
        if (!match) break;
        const amountToTake = Math.min(match.count, quantity - taken);
        try {
            await containerWindow.withdraw(match.type, null, amountToTake);
            taken += amountToTake;
        } catch (_) { break; }
    }
    return taken;
}

async function _depositToOpenedContainer(containerWindow, neededIds, quantity, itemTargetName) {
    const bot = ctx.bot;
    let moved = 0;
    while (moved < quantity && !ctx.currentCancelToken.cancelled) {
        const inv   = bot.inventory.items();
        const stack = inv.find(i => neededIds.includes(i.type)) ||
            inv.find(i => String(i.name || '').toLowerCase().includes(String(itemTargetName || '').toLowerCase()));
        if (!stack) break;
        const amount = Math.min(stack.count, quantity - moved);
        try {
            await containerWindow.deposit(stack.type, null, amount);
            moved += amount;
        } catch (_) { break; }
    }
    return moved;
}

async function withdrawNeededEquipment(containerWindow) {
    const bot = ctx.bot;
    const equippedNames = new Set(
        ['head', 'torso', 'legs', 'feet']
            .map(s => bot.inventory.slots[bot.getEquipmentDestSlot(s)]?.name)
            .filter(Boolean)
    );
    const alreadyHaveNames = new Set(bot.inventory.items().map(i => i.name));
    let taken = 0;
    for (const item of containerWindow.containerItems()) {
        if (ctx.currentCancelToken.cancelled) break;
        const name    = item.name;
        const isGear  =
            TOOL_SUFFIXES.some(s => name.endsWith(s)) ||
            ARMOR_TIERS.some(t => Object.values(ARMOR_PIECES).some(p => name === `${t}_${p}`));
        if (!isGear || equippedNames.has(name) || alreadyHaveNames.has(name)) continue;
        try {
            await containerWindow.withdraw(item.type, null, 1);
            alreadyHaveNames.add(name);
            taken++;
        } catch (e) {}
    }
    return taken;
}

function getBestFoodItem() {
    const bot   = ctx.bot;
    const mcData = ctx.mcData;
    const foods  = mcData.foodsArray || [];
    const sorted = [...foods].sort((a, b) => b.foodPoints - a.foodPoints);
    for (const food of sorted) {
        const item = bot.inventory.items().find(i => i.name === food.name);
        if (item) return item;
    }
    return null;
}

// ── Tool category inference ──────────────────────────────────────────────────

function inferToolCategory(block) {
    const name = block.name.toLowerCase();
    if (name.includes('grave') || name.includes('tomb') || name.includes('crave') ||
        name.includes('obituary') || name.includes('death')) return 'pickaxe';
    if (name.includes('log') || name.includes('_wood') || name.includes('plank') ||
        name.includes('bamboo_block') || name.includes('bamboo_mosaic') ||
        name.includes('fence') || name.includes('stem') || name.includes('hyphae') ||
        name.includes('chest') || name.includes('barrel') || name.includes('bookshelf') ||
        name.includes('crafting_table') || name.includes('jukebox') || name.includes('note_block') ||
        name.includes('door') || name.includes('trapdoor')) return 'axe';
    if (name.includes('dirt') || name.includes('gravel') || name.includes('sand') ||
        name.includes('grass') || name.includes('podzol') || name.includes('mycelium') ||
        name.includes('soul_sand') || name.includes('soul_soil') || name.includes('clay') ||
        name.includes('farmland') || name.includes('path') || name.includes('snow') ||
        name.includes('mud')) return 'shovel';
    return 'pickaxe';
}

// ── Auto-tool obtainer ───────────────────────────────────────────────────────

async function ensureToolFor(block) {
    const bot = ctx.bot;
    if (!block) return;
    const bname = block.name || '';
    if (bname === 'air' || bname.includes('water') || bname.includes('lava') ||
        bname === 'void_air' || bname === 'cave_air') return;
    if (block.diggable === false) return;

    const toolCat       = inferToolCategory(block);
    const hasRequirement = block.harvestTools && Object.keys(block.harvestTools).length > 0;

    const items      = bot.inventory.items();
    const toolSuffix = `_${toolCat}`;
    const hasGoodTool = items.some(i =>
        (hasRequirement && block.harvestTools[i.type]) ||
        (!hasRequirement && i.name.endsWith(toolSuffix))
    );
    if (hasGoodTool) { await equipBestTool(block); return; }

    // Try to loot a tool from nearby chests first
    const chestId = bot.registry.blocksByName.chest?.id;
    if (chestId !== undefined) {
        const chests = bot.findBlocks({ matching: chestId, maxDistance: 16, count: 5 });
        for (const cpos of chests) {
            if (ctx.currentCancelToken.cancelled) return;
            try {
                const chestBlock = bot.blockAt(cpos);
                if (chestBlock) {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(cpos.x, cpos.y, cpos.z, 2)), 10000, 'goto chest', () => bot.pathfinder.setGoal(null));
                    const chestWindow  = await bot.openContainer(chestBlock);
                    const neededItems  = [`iron_${toolCat}`, `stone_${toolCat}`, `wooden_${toolCat}`, 'iron_ingot', 'cobblestone'];
                    for (const item of chestWindow.containerItems()) {
                        if (neededItems.includes(item.name)) {
                            await chestWindow.withdraw(item.type, null, item.name.endsWith(toolCat) ? 1 : Math.min(item.count, 64));
                        }
                    }
                    bot.closeWindow(chestWindow);
                }
            } catch (e) { console.log(`[Actuator] ensureToolFor chest scan: ${e.message}`); }

            const itemsPostChest = bot.inventory.items();
            if (itemsPostChest.some(i =>
                (hasRequirement && block.harvestTools[i.type]) ||
                (!hasRequirement && i.name.endsWith(toolSuffix))
            )) {
                await equipBestTool(block); return;
            }
        }
    }

    if (!hasRequirement) {
        console.log(`[Actuator] No ${toolCat} found for ${block.name}. Continuing without optional tool.`);
        return;
    }

    console.log(`[Actuator] No ${toolCat} found for ${block.name}. Auto-crafting tool...`);
    bot.chat(`[System] Need a ${toolCat}. Crafting one...`);

    const countBy = (set) => bot.inventory.items().filter(i => set.has(i.name)).reduce((s, i) => s + i.count, 0);

    // Step 1: Gather logs if short on planks
    if (ctx.currentCancelToken.cancelled) return;
    const sticksHave   = bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0);
    const planksNeeded = 3 + (sticksHave >= 2 ? 0 : 2);

    if (countBy(PLANK_NAMES) < planksNeeded) {
        const logsNeeded = Math.ceil((planksNeeded - countBy(PLANK_NAMES)) / 4);
        const logsHave   = countBy(LOG_NAMES);
        if (logsHave < logsNeeded) {
            for (const logName of LOG_NAMES) {
                if (ctx.currentCancelToken.cancelled) return;
                const logBlockId = bot.registry.blocksByName[logName]?.id;
                if (!logBlockId) continue;
                const matchFn   = b => b && b.type === logBlockId;
                let logBlocks   = bot.findBlocks({ matching: matchFn, maxDistance: 32, count: logsNeeded * 4, useExtraInfo: true });
                if (logBlocks.length === 0) logBlocks = bot.findBlocks({ matching: logBlockId, maxDistance: 64, count: logsNeeded * 4 });
                if (logBlocks.length === 0) continue;
                const botFloorY = Math.floor(bot.entity.position.y);
                const lowLogs   = logBlocks.filter(p => Math.abs(p.y - botFloorY) <= 5);
                const sortedLogs = lowLogs.length > 0 ? lowLogs : logBlocks;
                for (const logPos of sortedLogs.slice(0, 2)) {
                    if (ctx.currentCancelToken.cancelled) return;
                    if (countBy(LOG_NAMES) >= logsNeeded) break;
                    try {
                        await withTimeout(
                            bot.pathfinder.goto(new goals.GoalNear(logPos.x, logPos.y, logPos.z, 4)),
                            8000, `auto-goto ${logName}`, () => bot.pathfinder.setGoal(null)
                        );
                        const b = bot.blockAt(logPos);
                        if (b && b.type === logBlockId) {
                            await bot.dig(b, true);
                            await new Promise(r => setTimeout(r, 800));
                        }
                    } catch (e) { console.log(`[Actuator] auto-tool: ${e.message}`); }
                    if (ctx.movements) bot.pathfinder.setMovements(ctx.movements);
                }
                if (countBy(LOG_NAMES) >= logsNeeded) break;
            }
        }

        // Step 2: Craft planks
        if (ctx.currentCancelToken.cancelled) return;
        for (const log of bot.inventory.items().filter(i => LOG_NAMES.has(i.name))) {
            const plankName = log.name.replace(/_log$/, '_planks').replace(/_wood$/, '_planks');
            const plankId   = bot.registry.itemsByName[plankName]?.id;
            if (plankId === undefined) continue;
            const recipe = bot.recipesFor(plankId, null, 1, false)[0];
            if (!recipe) continue;
            try { await bot.craft(recipe, Math.min(log.count, 2), null); break; }
            catch (e) { console.log(`[Actuator] auto-tool craft planks: ${e.message}`); }
        }
    }

    // Step 3: Craft sticks
    if (ctx.currentCancelToken.cancelled) return;
    if (bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0) < 2) {
        const anyPlank = bot.inventory.items().find(i => PLANK_NAMES.has(i.name));
        if (anyPlank) {
            const stickId = bot.registry.itemsByName['stick']?.id;
            const r = stickId !== undefined ? bot.recipesFor(stickId, null, 1, false)[0] : null;
            if (r) try { await bot.craft(r, 1, null); } catch (e) {}
        }
    }

    // Step 4: Find or create crafting table and craft tool
    if (ctx.currentCancelToken.cancelled) return;
    const ctBlockId = bot.registry.blocksByName['crafting_table']?.id;
    let craftingTable = ctBlockId !== undefined ? bot.findBlock({ matching: ctBlockId, maxDistance: 32 }) : null;

    if (!craftingTable) {
        const ctItemId = bot.registry.itemsByName['crafting_table']?.id ?? ctBlockId;
        if (ctItemId !== undefined && !bot.inventory.items().find(i => i.name === 'crafting_table')) {
            const ctR = bot.recipesFor(ctItemId, null, 1, false)[0];
            if (ctR) try { await bot.craft(ctR, 1, null); } catch (e) {}
        }
        if (ctx.currentCancelToken.cancelled) return;
        const ctItem = bot.inventory.items().find(i => i.name === 'crafting_table');
        if (ctItem) {
            try {
                await placeItemIntelligently(ctItem, null);
                craftingTable = ctBlockId !== undefined ? bot.findBlock({ matching: ctBlockId, maxDistance: 8 }) : null;
            } catch (e) {}
        }
    }

    if (ctx.currentCancelToken.cancelled) return;
    if (craftingTable) {
        let toolName  = `wooden_${toolCat}`;
        const invNames = new Set(bot.inventory.items().map(i => i.name));
        if (invNames.has('iron_ingot'))   toolName = `iron_${toolCat}`;
        else if (invNames.has('cobblestone')) toolName = `stone_${toolCat}`;

        const toolId  = bot.registry.itemsByName[toolName]?.id;
        if (toolId !== undefined) {
            const toolR = bot.recipesFor(toolId, null, 1, true)[0];
            if (toolR) {
                try {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 1)), 15000, 'goto table (auto-tool)', () => bot.pathfinder.setGoal(null));
                    if (ctx.currentCancelToken.cancelled) return;
                    await bot.craft(toolR, 1, craftingTable);
                    bot.chat(`[System] Crafted a ${toolName}!`);
                } catch (e) {}
            }
        }
    }
    await equipBestTool(block);
}

module.exports = {
    TOOL_SUFFIXES,
    WEAPON_PRIORITY,
    ARMOR_TIERS,
    ARMOR_PIECES,
    PLANK_NAMES,
    LOG_NAMES,
    MATERIAL_TAG_GROUPS,
    _shortItemName,
    resolveInventoryItemForTarget,
    placeItemIntelligently,
    equipBestTool,
    equipBestWeapon,
    equipBestArmor,
    isMissingGear,
    getEquipmentContainerIds,
    _normalizeContainerKind,
    _normalizeItemTargetName,
    _isContainerBlockByName,
    _getContainerBlockIds,
    _resolveContainerCoords,
    _listContainerCandidates,
    _resolveTargetItemIds,
    _withdrawFromOpenedContainer,
    _depositToOpenedContainer,
    withdrawNeededEquipment,
    getBestFoodItem,
    inferToolCategory,
    ensureToolFor,
};
