// bot_actuator.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const ForgeHandshakeStateMachine = require('./forge_handshake_state_machine');
const DynamicRegistryInjector = require('./dynamic_registry_injector');
const nbt = require('prismarine-nbt');
const Vec3 = require('vec3');

// Robust Crash Protection
process.on('uncaughtException', (err) => {
    console.error(`[Actuator] CRITICAL UNCAUGHT EXCEPTION: ${err.message}`);
    console.error(err.stack);
    process.send({ type: 'ERROR', category: 'BotError', details: err.message });
});

const botId = process.env.BOT_ID || 'Bot';
const botOptions = process.env.BOT_OPTIONS ? JSON.parse(process.env.BOT_OPTIONS) : {};

console.log(`[Actuator] Initializing ${botId}...`);

// Protocol & NBT Bypasses
try {
    const mcDataGlobal = require('minecraft-data')('1.20.1');
    const types = mcDataGlobal.protocol.play.toClient.types;
    const bypass = ['declare_recipes', 'tags', 'advancements', 'declare_commands', 'unlock_recipes', 'craft_recipe_response', 'nbt_query_response'];
    bypass.forEach(p => {
        types[p] = 'restBuffer';
        if (types['packet_' + p]) types['packet_' + p] = 'restBuffer';
    });

    const nbtProto = nbt.protos.big;
    const originalRead = nbtProto.read;
    nbtProto.read = function (buffer, offset) {
        try { return originalRead.call(this, buffer, offset); } catch (e) { return nbtProto.readAnon(buffer, offset); }
    };
    console.log('[Actuator] Protocol bypasses and NBT leniency applied.');
} catch (e) { console.error(`[Actuator] Patch failed: ${e.message}`); }

const bot = mineflayer.createBot({
    host: (botOptions.host || 'localhost') + '\0FML3\0',
    port: botOptions.port || 25565,
    username: botId,
    version: '1.20.1',
    maxPacketSize: 10 * 1024 * 1024,
    disableChatSigning: true
});

const mcData = require('minecraft-data')(bot.version);

bot.on('inject_allowed', () => {
    console.log('[Actuator] Connection allowed. Starting handshake machine...');
    const handshake = new ForgeHandshakeStateMachine(bot._client);
    handshake.on('handshake_complete', (registrySyncBuffer) => {
        console.log('[Actuator] Handshake complete. Processing registries via Vanilla-First Mode...');
        const injector = new DynamicRegistryInjector(bot.registry);
        const parsed = injector.parseRegistryPayload(registrySyncBuffer);
        injector.injectBlockToRegistry(parsed);
    });
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(require('mineflayer-collectblock').plugin);

bot.on('spawn', async () => {
    console.log(`[Actuator] Bot spawned. Initializing physics and pathfinder...`);
    try { await bot.waitForChunksToLoad(); } catch (e) {
        console.log(`[Actuator] Failed to wait for chunks: ${e.message}`);
    }

    bot.physics.enabled = true;

    const movements = new Movements(bot, mcData);
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.allow1by1towers = true;
    movements.maxDropDown = 4;

    // Use cheap vanilla blocks for scaffolding
    movements.scafoldingBlocks = [
        bot.registry.blocksByName.dirt?.id,
        bot.registry.blocksByName.cobblestone?.id,
        bot.registry.blocksByName.netherrack?.id,
        bot.registry.blocksByName.sand?.id
    ].filter(id => id !== undefined);

    for (const [name, block] of Object.entries(bot.registry.blocksByName)) {
        if (name.includes('leaves')) {
            movements.blocksCantBreak.add(block.id);
        }
    }

    bot.pathfinder.setMovements(movements);
    // thinkTimeout: max ms A* may search before giving up on a path.
    // 5 000 ms caps peak heap at ~300 MB per failed attempt (10 000 ms OOM'd at ~600 MB).
    bot.pathfinder.thinkTimeout = 5000;
    // tickTimeout: ms of A* work per game tick. Smaller → more GC opportunities.
    bot.pathfinder.tickTimeout = 5;

    let lastHealth = bot.health || 20;
    bot.on('health', () => {
        if (bot.health < lastHealth && bot.health > 0) {
            bot.pathfinder.setGoal(null);
            if (typeof bot.clearControlStates === 'function') {
                bot.clearControlStates();
            } else {
                bot.setControlState('forward', false);
                bot.setControlState('sprint', false);
                bot.setControlState('jump', false);
            }
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            bot.setControlState('jump', true);
            setTimeout(() => {
                if (typeof bot.clearControlStates === 'function') {
                    bot.clearControlStates();
                } else {
                    bot.setControlState('forward', false);
                    bot.setControlState('sprint', false);
                    bot.setControlState('jump', false);
                }
            }, 1000);
        }
        lastHealth = bot.health;
    });

    console.log('[Actuator] Pathfinder and Physics initialized.');
    bot.chat('Forge AI Player Ready.');
});

function getEnvironmentContext() {
    return {
        position: bot.entity ? {
            x: Math.round(bot.entity.position.x),
            y: Math.round(bot.entity.position.y),
            z: Math.round(bot.entity.position.z)
        } : null,
        health: bot.health ? Math.round(bot.health) : null,
        food: bot.food ? Math.round(bot.food) : null,
        players_nearby: Object.keys(bot.players).filter(p => p !== bot.username && bot.players[p].entity),
        inventory: bot.inventory ? bot.inventory.items().map(item => ({ name: item.name, count: item.count })) : []
    };
}

// Eye (Perception)
// Forge 1.20.1 servers can deliver the same player chat message twice
// (once as player_chat, once as system_chat formatted by a plugin).
// Deduplicate within a 3-second window to avoid double-processing.
// Window is 3 s (not 1 s) because with a live server the HTTP round-trip
// means the two Forge duplicate packets can arrive >1 s apart.
const _chatDedup = new Map(); // 'username:message' → timestamp
bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    const key = `${username}:${message}`;
    const now = Date.now();
    if (now - (_chatDedup.get(key) ?? 0) < 3000) return;
    _chatDedup.set(key, now);
    // Prune stale entries so the map doesn't grow unbounded
    if (_chatDedup.size > 64) {
        const cutoff = now - 5000;
        for (const [k, t] of _chatDedup) if (t < cutoff) _chatDedup.delete(k);
    }
    process.send({ type: 'USER_CHAT', data: { username, message, environment: getEnvironmentContext() } });
});

// Body (Action)
let actionQueue = [];
let currentCancelToken = { cancelled: false };
let isExecuting = false;

function withTimeout(promise, ms, actionName, cancelFn) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            if (cancelFn) cancelFn();
            reject(new Error(`Timeout exceeded for action: ${actionName} (${ms}ms)`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

async function equipBestTool(block) {
    let bestTool = null, bestTime = Infinity;
    for (const tool of bot.inventory.items()) {
        const t = block.digTime(tool ? tool.type : null, false, false, false, [], bot.entity.effects);
        if (t < bestTime) { bestTime = t; bestTool = tool; }
    }
    if (bestTool) {
        try { await bot.equip(bestTool, 'hand'); } catch (e) {
            console.log(`[Actuator] equipBestTool: ${e.message}`);
        }
    }
}

const WEAPON_PRIORITY = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'
];
async function equipBestWeapon() {
    for (const name of WEAPON_PRIORITY) {
        const w = bot.inventory.items().find(i => i.name === name);
        if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} return; }
    }
}

const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'golden', 'chainmail', 'leather'];
const ARMOR_PIECES = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' };
async function equipBestArmor() {
    for (const [slot, piece] of Object.entries(ARMOR_PIECES)) {
        for (const tier of ARMOR_TIERS) {
            const a = bot.inventory.items().find(i => i.name === `${tier}_${piece}`);
            if (a) { try { await bot.equip(a, slot); } catch (e) {} break; }
        }
    }
}

function getBestFoodItem() {
    const foods = mcData.foodsArray || [];
    const sorted = [...foods].sort((a, b) => b.foodPoints - a.foodPoints);
    for (const food of sorted) {
        const item = bot.inventory.items().find(i => i.name === food.name);
        if (item) return item;
    }
    return null;
}

// FIX: Improved inferToolCategory — also detects log-type blocks for axe suggestion
function inferToolCategory(block) {
    const name = block.name.toLowerCase();
    if (name.includes('log') || name.includes('_wood') || name.includes('plank') ||
        name.includes('fence') || name.includes('stem') || name.includes('hyphae') ||
        name.includes('chest') || name.includes('barrel') || name.includes('bookshelf') ||
        name.includes('crafting_table') || name.includes('jukebox') || name.includes('note_block') ||
        name.includes('ladder') || name.includes('door') || name.includes('trapdoor')) {
        return 'axe';
    }
    if (name.includes('dirt') || name.includes('gravel') || name.includes('sand') ||
        name.includes('grass') || name.includes('podzol') || name.includes('mycelium') ||
        name.includes('soul_sand') || name.includes('soul_soil') || name.includes('clay') ||
        name.includes('farmland') || name.includes('path') || name.includes('snow') ||
        name.includes('mud')) {
        return 'shovel';
    }
    // Stone, ore, concrete, bricks, etc.
    return 'pickaxe';
}

const PLANK_NAMES = new Set([
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks'
]);
const LOG_NAMES = new Set([
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'mangrove_log', 'cherry_log',
    'oak_wood', 'spruce_wood', 'birch_wood', 'jungle_wood', 'acacia_wood', 'dark_oak_wood'
]);

// FIX: ensureToolFor now also proactively crafts a speed-improving tool (axe for logs)
// even when harvestTools is null, preventing the 30s-per-log timeout without an axe.
async function ensureToolFor(block) {
    // Skip fluids, air, and any block the registry marks as non-diggable.
    // Calling this for water/lava would fall through to the default 'pickaxe'
    // branch and trigger an expensive (and fatal-OOM) auto-craft loop.
    if (!block) return;
    const bname = block.name || '';
    if (bname === 'air' || bname.includes('water') || bname.includes('lava') ||
        bname === 'void_air' || bname === 'cave_air') return;
    if (block.diggable === false) return;

    const toolCat = inferToolCategory(block);
    const hasRequirement = block.harvestTools && Object.keys(block.harvestTools).length > 0;

    // Check for a suitable tool (or a speed-improving tool for axe/shovel/pickaxe categories)
    const items = bot.inventory.items();
    const toolSuffix = `_${toolCat}`;
    const hasGoodTool = items.some(i =>
        (hasRequirement && block.harvestTools[i.type]) ||
        (!hasRequirement && i.name.endsWith(toolSuffix))
    );
    if (hasGoodTool) { await equipBestTool(block); return; }

    console.log(`[Actuator] No ${toolCat} found for ${block.name}. Auto-crafting wooden_${toolCat}...`);
    bot.chat(`Need a ${toolCat}. Crafting one...`);

    const countBy = (set) => bot.inventory.items().filter(i => set.has(i.name)).reduce((s, i) => s + i.count, 0);

    // ── Step 1: Gather logs if short on planks ──────────────────────────────
    const sticksHave = bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0);
    const planksNeeded = 3 + (sticksHave >= 2 ? 0 : 2);

    if (countBy(PLANK_NAMES) < planksNeeded) {
        const logsNeeded = Math.ceil((planksNeeded - countBy(PLANK_NAMES)) / 4);
        if (countBy(LOG_NAMES) < logsNeeded) {
            for (const logName of LOG_NAMES) {
                const logBlockId = bot.registry.blocksByName[logName]?.id;
                if (!logBlockId) continue;
                const logBlocks = bot.findBlocks({ matching: logBlockId, maxDistance: 32, count: logsNeeded });
                if (logBlocks.length === 0) continue;
                for (const logPos of logBlocks) {
                    if (countBy(LOG_NAMES) >= logsNeeded) break;
                    try {
                        await withTimeout(bot.collectBlock.collect(bot.blockAt(logPos)), 20000,
                            `auto-collect ${logName}`,
                            () => { bot.pathfinder.setGoal(null); if (bot.collectBlock.cancelTask) bot.collectBlock.cancelTask(); });
                    } catch (e) { console.log(`[Actuator] auto-tool: ${e.message}`); }
                }
                if (countBy(LOG_NAMES) >= logsNeeded) break;
            }
        }

        // ── Step 2: Craft planks ──────────────────────────────────────────────
        for (const log of bot.inventory.items().filter(i => LOG_NAMES.has(i.name))) {
            const plankName = log.name.replace(/_log$/, '_planks').replace(/_wood$/, '_planks');
            const plankId = bot.registry.itemsByName[plankName]?.id;
            if (plankId === undefined) continue;
            const recipe = bot.recipesFor(plankId, null, 1, false)[0];
            if (!recipe) continue;
            try { await bot.craft(recipe, Math.min(log.count, 2), null); break; }
            catch (e) { console.log(`[Actuator] auto-tool craft planks: ${e.message}`); }
        }
    }

    // ── Step 3: Craft sticks ─────────────────────────────────────────────────
    if (bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0) < 2) {
        const anyPlank = bot.inventory.items().find(i => PLANK_NAMES.has(i.name));
        if (anyPlank) {
            const stickId = bot.registry.itemsByName['stick']?.id;
            const r = stickId !== undefined ? bot.recipesFor(stickId, null, 1, false)[0] : null;
            if (r) try { await bot.craft(r, 1, null); } catch (e) { console.log(`[Actuator] auto-tool craft sticks: ${e.message}`); }
        }
    }

    // ── Step 4: Find or create crafting table, craft tool ───────────────────
    const ctBlockId = bot.registry.blocksByName['crafting_table']?.id;
    let craftingTable = ctBlockId !== undefined ? bot.findBlock({ matching: ctBlockId, maxDistance: 32 }) : null;

    if (!craftingTable) {
        const ctItemId = bot.registry.itemsByName['crafting_table']?.id ?? ctBlockId;
        if (ctItemId !== undefined && !bot.inventory.items().find(i => i.name === 'crafting_table')) {
            const ctR = bot.recipesFor(ctItemId, null, 1, false)[0];
            if (ctR) try { await bot.craft(ctR, 1, null); } catch (e) { console.log(`[Actuator] auto-tool craft table: ${e.message}`); }
        }
        const ctItem = bot.inventory.items().find(i => i.name === 'crafting_table');
        if (ctItem) {
            try {
                await bot.equip(ctItem, 'hand');
                const ref = bot.findBlock({ matching: b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava', maxDistance: 4 });
                if (ref) {
                    await bot.placeBlock(ref, new Vec3(0, 1, 0));
                    craftingTable = ctBlockId !== undefined ? bot.findBlock({ matching: ctBlockId, maxDistance: 8 }) : null;
                }
            } catch (e) { console.log(`[Actuator] auto-tool place table: ${e.message}`); }
        }
    }

    if (craftingTable) {
        const toolName = `wooden_${toolCat}`;
        const toolId = bot.registry.itemsByName[toolName]?.id;
        if (toolId !== undefined) {
            const toolR = bot.recipesFor(toolId, null, 1, true)[0];
            if (toolR) {
                try {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 1)), 15000, 'goto table (auto-tool)', () => bot.pathfinder.setGoal(null));
                    await bot.craft(toolR, 1, craftingTable);
                    bot.chat(`Crafted a ${toolName}!`);
                } catch (e) { console.log(`[Actuator] auto-tool craft ${toolName}: ${e.message}`); }
            }
        }
    } else {
        console.log('[Actuator] auto-tool: could not obtain a crafting table.');
    }
    await equipBestTool(block);
}

// Wither summon pattern. Skulls must be placed LAST to trigger the spawn.
// Layout (relative offsets from baseX/baseY/baseZ):
//   soul_sand:            (0,0,0) (1,0,0) (2,0,0)  ← horizontal bar
//                         (1,0,1)                   ← T-stem
//   wither_skeleton_skull:(0,1,0) (1,1,0) (2,1,0)  ← on top of bar
const PLACE_PATTERNS = {
    wither: [
        { name: 'soul_sand',              dx: 0, dy: 0, dz: 0 },
        { name: 'soul_sand',              dx: 1, dy: 0, dz: 0 },
        { name: 'soul_sand',              dx: 2, dy: 0, dz: 0 },
        { name: 'soul_sand',              dx: 1, dy: 0, dz: 1 },
        { name: 'wither_skeleton_skull',  dx: 0, dy: 1, dz: 0 },
        { name: 'wither_skeleton_skull',  dx: 1, dy: 1, dz: 0 },
        { name: 'wither_skeleton_skull',  dx: 2, dy: 1, dz: 0 },
    ]
};

// Potion ingredient map (ingredient → base bottle type required)
// base=water_bottle → awkward_potion (nether_wart step), then the ingredient
const POTION_RECIPES = {
    healing:         { ingredient: 'glistering_melon_slice', base: 'awkward_potion' },
    regeneration:    { ingredient: 'ghast_tear',             base: 'awkward_potion' },
    strength:        { ingredient: 'blaze_powder',           base: 'awkward_potion' },
    fire_resistance: { ingredient: 'magma_cream',            base: 'awkward_potion' },
    swiftness:       { ingredient: 'sugar',                  base: 'awkward_potion' },
    night_vision:    { ingredient: 'golden_carrot',          base: 'awkward_potion' },
    water_breathing: { ingredient: 'puffer_fish',            base: 'awkward_potion' },
    leaping:         { ingredient: 'rabbit_foot',            base: 'awkward_potion' },
    slow_falling:    { ingredient: 'phantom_membrane',       base: 'awkward_potion' },
    invisibility:    { ingredient: 'fermented_spider_eye',   base: 'potion_of_night_vision' },
    poison:          { ingredient: 'spider_eye',             base: 'awkward_potion' },
    weakness:        { ingredient: 'fermented_spider_eye',   base: 'water_bottle' },
    awkward:         { ingredient: 'nether_wart',            base: 'water_bottle' },
};

const FUEL_PRIORITY = ['coal', 'charcoal', 'coal_block', 'oak_log', 'spruce_log', 'birch_log', 'oak_planks', 'spruce_planks'];

const STRUCTURE_MARKERS = {
    nether_fortress: ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs'],
    ocean_monument:  ['prismarine', 'prismarine_bricks', 'dark_prismarine', 'sea_lantern'],
    stronghold:      ['end_portal_frame', 'mossy_stone_bricks', 'cracked_stone_bricks'],
    village:         ['hay_block', 'bell', 'villager_spawn_egg'],
    nether_portal:   ['nether_portal'],
};

// ─── Main Action Processor ────────────────────────────────────────────────────

async function processActionQueue() {
    if (isExecuting) return;
    isExecuting = true;

    while (actionQueue.length > 0) {
        const action = actionQueue.shift();
        const timeoutMs = action.timeout ? action.timeout * 1000 : 30000;

        try {
            if (!action || !action.action) continue;
            if (currentCancelToken.cancelled) break;

            // ── chat ──────────────────────────────────────────────────────────
            if (action.action === 'chat') {
                bot.chat(action.message);

            // ── come (continuous follow via GoalNear loop) ───────────────────────
            } else if (action.action === 'come') {
                const targetEntity = bot.players[action.target]?.entity;
                if (targetEntity) {
                    bot.chat(`Following ${action.target}!`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Now following ${action.target}.`, environment: getEnvironmentContext() } });

                    while (!currentCancelToken.cancelled) {
                        const currentTarget = bot.players[action.target]?.entity;
                        if (!currentTarget) {
                            bot.chat(`I lost sight of ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Lost sight of ${action.target}.`, environment: getEnvironmentContext() } });
                            break;
                        }

                        const dist = bot.entity.position.distanceTo(currentTarget.position);
                        if (dist > 3) {
                            try {
                                await withTimeout(bot.pathfinder.goto(new goals.GoalNear(currentTarget.position.x, currentTarget.position.y, currentTarget.position.z, 2)), 10000, 'follow target', () => bot.pathfinder.setGoal(null));
                            } catch (e) {
                                // Ignore timeout/pathing errors during follow loop to prevent crash, just keep trying
                            }
                        } else {
                            // Close enough, just wait a bit
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                } else {
                    bot.chat(`I cannot see ${action.target}.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to find ${action.target}.`, environment: getEnvironmentContext() } });
                }

            // ── goto (waypoints, no distance cap) ────────────────────────────
            } else if (action.action === 'goto') {
                const WAYPOINT_STEP = 64;
                const destX = action.x, destZ = action.z;

                if (action.y !== undefined) {
                    bot.chat(`Moving to X:${Math.round(destX)}, Y:${action.y}, Z:${Math.round(destZ)}.`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(destX, action.y, destZ, 2)), timeoutMs, 'goto XYZ', () => bot.pathfinder.setGoal(null));
                } else {
                    const dx0 = destX - bot.entity.position.x, dz0 = destZ - bot.entity.position.z;
                    const total = Math.sqrt(dx0 * dx0 + dz0 * dz0);
                    bot.chat(`Moving to X:${Math.round(destX)}, Z:${Math.round(destZ)}${total > WAYPOINT_STEP ? ` (~${Math.round(total)} blocks)` : ''}.`);

                    let lastRem = total, stuck = 0;
                    while (!currentCancelToken.cancelled) {
                        const cx = bot.entity.position.x, cz = bot.entity.position.z;
                        const rdx = destX - cx, rdz = destZ - cz;
                        const rem = Math.sqrt(rdx * rdx + rdz * rdz);
                        if (rem <= 2) break;
                        if (rem >= lastRem - 1) { if (++stuck >= 3) throw new Error(`Stuck: no progress toward X:${Math.round(destX)}, Z:${Math.round(destZ)}.`); }
                        else stuck = 0;
                        lastRem = rem;

                        let wpX = destX, wpZ = destZ;
                        if (rem > WAYPOINT_STEP) {
                            const a = Math.atan2(rdz, rdx);
                            wpX = cx + WAYPOINT_STEP * Math.cos(a);
                            wpZ = cz + WAYPOINT_STEP * Math.sin(a);
                        }
                        await withTimeout(bot.pathfinder.goto(new goals.GoalXZ(wpX, wpZ)), timeoutMs, 'goto XZ waypoint', () => bot.pathfinder.setGoal(null));
                    }
                }
                if (!currentCancelToken.cancelled)
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully reached destination.`, environment: getEnvironmentContext() } });

            // ── collect (3× candidate pool + progressive radius fallback) ─────
            } else if (action.action === 'collect') {
                const blockId = bot.registry.blocksByName[action.target]?.id;
                if (blockId === undefined) { bot.chat(`I don't know what ${action.target} is.`); }
                else {
                    const quantity = parseInt(action.quantity, 10) || 1;
                    let collected = 0;

                    // Search passes: 32 blocks (3× candidates) then expand to 64
                    const SEARCH_PASSES = [
                        { maxDistance: 32, count: Math.min(quantity * 3, 64) },
                        { maxDistance: 64, count: Math.min((quantity + 4) * 2, 64) }
                    ];
                    const triedSet = new Set();

                    for (const pass of SEARCH_PASSES) {
                        if (collected >= quantity || currentCancelToken.cancelled) break;

                        const candidates = bot.findBlocks({ matching: blockId, maxDistance: pass.maxDistance, count: pass.count });
                        const fresh = candidates.filter(p => !triedSet.has(`${p.x},${p.y},${p.z}`));
                        if (fresh.length === 0) continue;

                        if (collected === 0 && pass.maxDistance === 32) {
                            // Pre-check tool once before the first pass.
                            // Verify the block type still matches — the position may have changed
                            // (water flowed in, chunk unloaded) since findBlocks ran.
                            const firstBlock = bot.blockAt(fresh[0]);
                            if (firstBlock && firstBlock.type === blockId) {
                                await ensureToolFor(firstBlock);
                            }
                            bot.chat(`Collecting ${action.target}...`);
                        } else if (pass.maxDistance === 64) {
                            bot.chat(`Expanding search for more ${action.target}...`);
                        }

                        for (const blockPos of fresh) {
                            if (currentCancelToken.cancelled || collected >= quantity) break;
                            triedSet.add(`${blockPos.x},${blockPos.y},${blockPos.z}`);

                            try {
                                bot.pathfinder.setGoal(null);
                                const targetBlock = bot.blockAt(blockPos);

                                // Step 1: Navigate to the block with a strict timeout
                                try {
                                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, 2)), 15000, `goto ${action.target}`, () => bot.pathfinder.setGoal(null));
                                } catch (gotoErr) {
                                    throw new Error(`Failed to reach block: ${gotoErr.message}`);
                                }

                                await equipBestTool(targetBlock);

                                // Check if the block has a mandatory tool requirement and we don't hold it
                                if (targetBlock.harvestTools && Object.keys(targetBlock.harvestTools).length > 0) {
                                    const heldItem = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
                                    if (!heldItem || !targetBlock.harvestTools[heldItem.type]) {
                                        throw new Error(`Requires a specific tool to harvest (held: ${heldItem ? heldItem.name : 'nothing'})`);
                                    }
                                }

                                // Step 2: Dig the block with a separate timeout based on hardness
                                // Give it 10s base + extra time if it's a hard block
                                const digTimeMs = targetBlock.digTime(bot.inventory.slots[bot.getEquipmentDestSlot('hand')]?.type || null, false, false, false, [], bot.entity.effects);
                                const maxDigTime = 10000 + (digTimeMs > 0 ? digTimeMs : 0);

                                await withTimeout(bot.collectBlock.collect(targetBlock), maxDigTime, `dig ${action.target}`, () => {
                                    bot.pathfinder.setGoal(null);
                                    if (bot.collectBlock.cancelTask) bot.collectBlock.cancelTask();
                                });

                                collected++;
                            } catch (err) {
                                console.error(`[Actuator] Skipping block at ${blockPos}: ${err.message}`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Skipped block at ${blockPos}: ${err.message}`, environment: getEnvironmentContext() } });
                                // continue to next block
                            }
                        }
                    }

                    if (collected >= quantity) {
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully collected ${collected} ${action.target}.`, environment: getEnvironmentContext() } });
                    } else if (collected > 0) {
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Partially collected ${collected}/${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                    } else {
                        bot.chat(`Could not find any ${action.target} nearby.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Could not find ${action.target}.`, environment: getEnvironmentContext() } });
                    }
                }

            // ── give ──────────────────────────────────────────────────────────
            } else if (action.action === 'give') {
                const targetPlayer = bot.players[action.target]?.entity;
                const itemTargetName = action.item || action.target;
                const itemId = bot.registry.itemsByName[itemTargetName]?.id || bot.registry.blocksByName[itemTargetName]?.id;
                if (targetPlayer && itemId !== undefined) {
                    bot.chat(`Giving ${action.quantity || 1} ${itemTargetName} to ${action.target}...`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(targetPlayer.position.x, targetPlayer.position.y, targetPlayer.position.z, 2)), timeoutMs, 'goto player for give', () => bot.pathfinder.setGoal(null));
                    await bot.lookAt(targetPlayer.position.offset(0, 1.6, 0));
                    await bot.toss(itemId, null, action.quantity || 1);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully gave item to ${action.target}.`, environment: getEnvironmentContext() } });
                } else if (!targetPlayer) {
                    bot.chat(`I cannot see ${action.target}.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot see ${action.target}.`, environment: getEnvironmentContext() } });
                } else {
                    bot.chat(`I don't know what item ${itemTargetName} is.`);
                }

            // ── craft ─────────────────────────────────────────────────────────
            } else if (action.action === 'craft') {
                const itemId = bot.registry.itemsByName[action.target]?.id || bot.registry.blocksByName[action.target]?.id;
                if (itemId !== undefined) {
                    const quantity = parseInt(action.quantity, 10) || 1;
                    const recipe = bot.recipesFor(itemId, null, 1, true)[0];
                    if (recipe) {
                        bot.chat(`Crafting ${action.target}...`);
                        if (recipe.requiresTable) {
                            const ctId = bot.registry.blocksByName['crafting_table']?.id;
                            const ct = ctId !== undefined ? bot.findBlock({ matching: ctId, maxDistance: 32 }) : null;
                            if (ct) {
                                await withTimeout(bot.pathfinder.goto(new goals.GoalNear(ct.position.x, ct.position.y, ct.position.z, 1)), timeoutMs, 'goto crafting table', () => bot.pathfinder.setGoal(null));
                                try {
                                    await withTimeout(bot.craft(recipe, quantity, ct), timeoutMs, 'craft at table');
                                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully crafted ${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                                } catch (err) {
                                    bot.chat(`Failed to craft ${action.target}.`);
                                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to craft: ${err.message}`, environment: getEnvironmentContext() } });
                                }
                            } else {
                                bot.chat(`Need a crafting table but none nearby.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `No crafting table for ${action.target}.`, environment: getEnvironmentContext() } });
                            }
                        } else {
                            try {
                                await withTimeout(bot.craft(recipe, quantity, null), timeoutMs, 'craft in inventory');
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully crafted ${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                            } catch (err) {
                                bot.chat(`Failed to craft ${action.target}.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to craft: ${err.message}`, environment: getEnvironmentContext() } });
                            }
                        }
                    } else {
                        bot.chat(`Missing materials for ${action.target}.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot craft ${action.target}: missing materials or recipe.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    bot.chat(`I don't know what ${action.target} is.`);
                }

            // ── place ─────────────────────────────────────────────────────────
            } else if (action.action === 'place') {
                const blockId = bot.registry.blocksByName[action.target]?.id || bot.registry.itemsByName[action.target]?.id;
                if (blockId !== undefined) {
                    const itemToPlace = bot.inventory.items().find(item => item.type === blockId);
                    if (itemToPlace) {
                        try {
                            await bot.equip(itemToPlace, 'hand');
                            const ref = bot.findBlock({ matching: b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava', maxDistance: 4 });
                            if (ref) {
                                await withTimeout(bot.placeBlock(ref, new Vec3(0, 1, 0)), timeoutMs, 'place block');
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully placed ${action.target}.`, environment: getEnvironmentContext() } });
                            } else {
                                bot.chat(`No surface nearby to place ${action.target}.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `No reference block found.`, environment: getEnvironmentContext() } });
                            }
                        } catch (err) {
                            bot.chat(`Failed to place ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Place failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    } else {
                        bot.chat(`No ${action.target} in inventory.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${action.target} in inventory.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    bot.chat(`I don't know what ${action.target} is.`);
                }

            // ── equip ─────────────────────────────────────────────────────────
            } else if (action.action === 'equip') {
                const itemId = bot.registry.itemsByName[action.target]?.id;
                if (itemId !== undefined) {
                    const item = bot.inventory.items().find(i => i.type === itemId);
                    if (item) {
                        try {
                            await bot.equip(item, 'hand');
                            bot.chat(`Equipped ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equipped ${action.target}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equip failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    } else {
                        bot.chat(`No ${action.target} to equip.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${action.target} in inventory.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    bot.chat(`I don't know what ${action.target} is.`);
                }

            // ── equip_armor ───────────────────────────────────────────────────
            } else if (action.action === 'equip_armor') {
                await equipBestArmor();
                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equipped best available armor.`, environment: getEnvironmentContext() } });

            // ── eat / drink ───────────────────────────────────────────────────
            } else if (action.action === 'eat') {
                let foodItem = action.target
                    ? bot.inventory.items().find(i => i.name === action.target)
                    : getBestFoodItem();
                if (foodItem) {
                    await bot.equip(foodItem, 'hand');
                    try {
                        await withTimeout(bot.consume(), timeoutMs, 'eat');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Ate ${foodItem.name}.`, environment: getEnvironmentContext() } });
                    } catch (err) {
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to eat: ${err.message}`, environment: getEnvironmentContext() } });
                    }
                } else {
                    bot.chat('No food in inventory.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No food available.', environment: getEnvironmentContext() } });
                }

            // ── smelt ─────────────────────────────────────────────────────────
            } else if (action.action === 'smelt') {
                const inputName = action.target;
                const quantity = parseInt(action.quantity, 10) || 1;
                const inputItem = bot.inventory.items().find(i => i.name === inputName);

                if (!inputItem) {
                    bot.chat(`No ${inputName} to smelt.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${inputName} in inventory.`, environment: getEnvironmentContext() } });
                } else {
                    const furnaceBlockId = bot.registry.blocksByName['furnace']?.id;
                    let furnaceBlock = furnaceBlockId !== undefined
                        ? bot.findBlock({ matching: furnaceBlockId, maxDistance: 32 })
                        : null;

                    // Auto-craft and place furnace if not found
                    if (!furnaceBlock) {
                        const furnaceItemId = bot.registry.itemsByName['furnace']?.id ?? furnaceBlockId;
                        if (furnaceItemId !== undefined && !bot.inventory.items().find(i => i.name === 'furnace')) {
                            // Furnace needs 8 cobblestone at a crafting table
                            const cbR = bot.recipesFor(furnaceItemId, null, 1, true)[0];
                            const ctId = bot.registry.blocksByName['crafting_table']?.id;
                            const ct = ctId !== undefined ? bot.findBlock({ matching: ctId, maxDistance: 32 }) : null;
                            if (cbR && ct) {
                                await withTimeout(bot.pathfinder.goto(new goals.GoalNear(ct.position.x, ct.position.y, ct.position.z, 1)), timeoutMs, 'goto table for furnace', () => bot.pathfinder.setGoal(null));
                                try { await bot.craft(cbR, 1, ct); } catch (e) { console.log(`[Actuator] smelt craft furnace: ${e.message}`); }
                            }
                        }
                        const fi = bot.inventory.items().find(i => i.name === 'furnace');
                        if (fi) {
                            try {
                                await bot.equip(fi, 'hand');
                                const ref = bot.findBlock({ matching: b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava', maxDistance: 4 });
                                if (ref) {
                                    await bot.placeBlock(ref, new Vec3(0, 1, 0));
                                    furnaceBlock = furnaceBlockId !== undefined ? bot.findBlock({ matching: furnaceBlockId, maxDistance: 8 }) : null;
                                }
                            } catch (e) { console.log(`[Actuator] smelt place furnace: ${e.message}`); }
                        }
                    }

                    if (!furnaceBlock) {
                        bot.chat('Cannot find or create a furnace.');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No furnace available.', environment: getEnvironmentContext() } });
                    } else {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 1)), timeoutMs, 'goto furnace', () => bot.pathfinder.setGoal(null));
                        const furnace = await bot.openFurnace(furnaceBlock);
                        try {
                            if (!furnace.fuelItem()) {
                                for (const fname of FUEL_PRIORITY) {
                                    const fuel = bot.inventory.items().find(i => i.name === fname);
                                    if (fuel) { await furnace.putFuel(fuel.type, null, Math.min(fuel.count, quantity + 2)); break; }
                                }
                            }
                            const fresh = bot.inventory.items().find(i => i.name === inputName);
                            if (fresh) await furnace.putInput(fresh.type, null, Math.min(quantity, fresh.count));

                            bot.chat(`Smelting ${quantity} ${inputName}...`);
                            const waitMs = Math.min(quantity * 11000, timeoutMs - 5000);
                            const t0 = Date.now();
                            while (Date.now() - t0 < waitMs && !currentCancelToken.cancelled) {
                                const out = furnace.outputItem();
                                if (out && out.count >= Math.min(quantity, fresh ? fresh.count : quantity)) break;
                                await new Promise(r => setTimeout(r, 2000));
                            }
                            if (furnace.outputItem()) await furnace.takeOutput();
                            furnace.close();
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully smelted ${inputName}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            furnace.close();
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Smelt failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    }
                }

            // ── kill (combat loop with armor + weapon auto-equip) ─────────────
            } else if (action.action === 'kill') {
                const killQty = parseInt(action.quantity, 10) || 1;
                let killed = 0;
                const combatMs = action.timeout ? action.timeout * 1000 : 120000;
                const combatStart = Date.now();

                await equipBestArmor();
                await equipBestWeapon();
                bot.chat(`Engaging ${action.target}...`);

                while (killed < killQty && !currentCancelToken.cancelled && Date.now() - combatStart < combatMs) {
                    // Find nearest living target
                    let target = null, minDist = Infinity;
                    for (const ent of Object.values(bot.entities)) {
                        if (ent === bot.entity) continue;
                        const eName = (ent.name || ent.username || '').toLowerCase();
                        if (eName === action.target.toLowerCase()) {
                            const d = bot.entity.position.distanceTo(ent.position);
                            if (d < minDist) { minDist = d; target = ent; }
                        }
                    }
                    if (!target) {
                        if (killed === 0) {
                            bot.chat(`Cannot find ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `${action.target} not found.`, environment: getEnvironmentContext() } });
                        }
                        break;
                    }

                    // Combat sub-loop: attack until this entity dies
                    while (target.isValid && !currentCancelToken.cancelled) {
                        // Eat if health is critically low
                        if (bot.health < 6) {
                            const food = getBestFoodItem();
                            if (food) {
                                bot.pathfinder.setGoal(null);
                                await bot.equip(food, 'hand');
                                await bot.consume().catch(() => {});
                                await equipBestWeapon();
                            }
                        }
                        const dist = bot.entity.position.distanceTo(target.position);
                        if (dist > 3.5) {
                            bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
                        } else {
                            bot.pathfinder.setGoal(null);
                            bot.attack(target);
                        }
                        await new Promise(r => setTimeout(r, 600)); // ~attack cooldown
                    }

                    if (!target.isValid) {
                        killed++;
                        bot.pathfinder.setGoal(null);
                        // Short pause to let drops appear
                        await new Promise(r => setTimeout(r, 800));
                    }
                }

                if (killed >= killQty) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully killed ${killed} ${action.target}.`, environment: getEnvironmentContext() } });
                } else if (killed > 0) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Partially killed ${killed}/${killQty} ${action.target}.`, environment: getEnvironmentContext() } });
                } else {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to kill ${action.target}.`, environment: getEnvironmentContext() } });
                }

            // ── sleep ─────────────────────────────────────────────────────────
            } else if (action.action === 'sleep') {
                const bedBlock = bot.findBlock({
                    matching: b => b && b.name.endsWith('_bed'),
                    maxDistance: 32
                });
                if (!bedBlock) {
                    bot.chat('No bed nearby.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No bed found within 32 blocks.', environment: getEnvironmentContext() } });
                } else {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2)), timeoutMs, 'goto bed', () => bot.pathfinder.setGoal(null));
                    try {
                        await withTimeout(bot.sleep(bedBlock), timeoutMs, 'sleep');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: 'Sleeping...', environment: getEnvironmentContext() } });
                    } catch (err) {
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot sleep: ${err.message}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── brew ──────────────────────────────────────────────────────────
            } else if (action.action === 'brew') {
                const potionKey = (action.potion || action.target || '').replace('potion_of_', '').replace('_potion', '');
                const recipe = POTION_RECIPES[potionKey];

                if (!recipe) {
                    bot.chat(`Unknown potion type: ${potionKey}`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Unknown potion: ${potionKey}`, environment: getEnvironmentContext() } });
                } else {
                    const standId = bot.registry.blocksByName['brewing_stand']?.id;
                    const stand = standId !== undefined ? bot.findBlock({ matching: standId, maxDistance: 32 }) : null;
                    if (!stand) {
                        bot.chat('No brewing stand nearby.');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No brewing stand found.', environment: getEnvironmentContext() } });
                    } else {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(stand.position.x, stand.position.y, stand.position.z, 1)), timeoutMs, 'goto brewing stand', () => bot.pathfinder.setGoal(null));
                        const brewingStand = await bot.openBrewingStand(stand);
                        try {
                            // Ensure blaze powder fuel
                            const blazePowder = bot.inventory.items().find(i => i.name === 'blaze_powder');
                            if (blazePowder) await brewingStand.putFuel(blazePowder.type, null, 1);

                            // Add ingredient
                            const ingredientId = bot.registry.itemsByName[recipe.ingredient]?.id;
                            const ingredient = ingredientId !== undefined ? bot.inventory.items().find(i => i.type === ingredientId) : null;
                            if (ingredient) await brewingStand.putIngredient(ingredient.type, null, 1);

                            bot.chat(`Brewing ${potionKey} potion...`);
                            // Wait for brewing to complete (~20 seconds)
                            await new Promise(r => setTimeout(r, Math.min(22000, timeoutMs - 3000)));
                            brewingStand.close();
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully brewed ${potionKey}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            brewingStand.close();
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Brew failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    }
                }

            // ── enchant ───────────────────────────────────────────────────────
            } else if (action.action === 'enchant') {
                const tableId = bot.registry.blocksByName['enchanting_table']?.id;
                const tableBlock = tableId !== undefined ? bot.findBlock({ matching: tableId, maxDistance: 32 }) : null;
                const targetItem = bot.inventory.items().find(i => i.name === action.target);

                if (!tableBlock) {
                    bot.chat('No enchanting table nearby.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No enchanting table found.', environment: getEnvironmentContext() } });
                } else if (!targetItem) {
                    bot.chat(`No ${action.target} to enchant.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `${action.target} not in inventory.`, environment: getEnvironmentContext() } });
                } else {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 1)), timeoutMs, 'goto enchanting table', () => bot.pathfinder.setGoal(null));
                    await bot.equip(targetItem, 'hand');
                    const table = await bot.openEnchantmentTable(tableBlock);
                    try {
                        await new Promise(r => setTimeout(r, 1000)); // wait for enchantments to load
                        const validOptions = (table.enchantments || []).filter(e => e && e.level > 0);
                        if (validOptions.length > 0) {
                            const choice = validOptions.length - 1; // highest tier
                            await withTimeout(table.enchant(choice), timeoutMs, 'enchant');
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully enchanted ${action.target}.`, environment: getEnvironmentContext() } });
                        } else {
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `No enchantments available (need lapis + experience levels).`, environment: getEnvironmentContext() } });
                        }
                        table.close();
                    } catch (err) {
                        table.close();
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Enchant failed: ${err.message}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── explore ───────────────────────────────────────────────────────
            } else if (action.action === 'explore') {
                const DIRS = { north: [0,-1], south: [0,1], east: [1,0], west: [-1,0], up: [0,0] };
                const [dx, dz] = DIRS[action.direction] || DIRS.east;
                const maxDist = parseInt(action.distance, 10) || 500;
                const STEP = 64;
                const markers = STRUCTURE_MARKERS[action.target] || [];
                let found = null, traveled = 0;

                bot.chat(`Exploring ${action.direction || 'east'}${action.target ? ` for ${action.target}` : ''}...`);

                while (traveled < maxDist && !currentCancelToken.cancelled && !found) {
                    const nx = bot.entity.position.x + dx * STEP;
                    const nz = bot.entity.position.z + dz * STEP;
                    try {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalXZ(nx, nz)), timeoutMs, 'explore step', () => bot.pathfinder.setGoal(null));
                    } catch (e) { /* terrain obstacle — keep moving */ }
                    traveled += STEP;

                    for (const markerName of markers) {
                        const markerId = bot.registry.blocksByName[markerName]?.id;
                        if (!markerId) continue;
                        const markerBlock = bot.findBlock({ matching: markerId, maxDistance: 48 });
                        if (markerBlock) { found = markerBlock; break; }
                    }
                }

                if (found) {
                    bot.chat(`Found ${action.target}!`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Found ${action.target} at ${found.position}.`, environment: getEnvironmentContext() } });
                } else if (!currentCancelToken.cancelled) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Explored ${traveled} blocks. ${action.target ? `${action.target} not found.` : 'Done.'}`, environment: getEnvironmentContext() } });
                }

            // ── navigate_portal ───────────────────────────────────────────────
            } else if (action.action === 'navigate_portal') {
                const portalName = action.target === 'end' ? 'end_portal' : 'nether_portal';
                const portalBlockId = bot.registry.blocksByName[portalName]?.id;
                const portalBlock = portalBlockId !== undefined
                    ? bot.findBlock({ matching: portalBlockId, maxDistance: 64 })
                    : null;

                if (!portalBlock) {
                    bot.chat(`No ${action.target || 'nether'} portal visible.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Portal not found. Explore to locate one.`, environment: getEnvironmentContext() } });
                } else {
                    bot.chat(`Entering ${action.target || 'nether'} portal...`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(portalBlock.position.x, portalBlock.position.y, portalBlock.position.z, 1)), timeoutMs, 'goto portal', () => bot.pathfinder.setGoal(null));
                    const currentDim = bot.game.dimension;
                    // Walk into the portal and wait for teleportation (up to 10s)
                    try {
                        await withTimeout(new Promise(resolve => {
                            const check = setInterval(() => {
                                if (bot.game.dimension !== currentDim) { clearInterval(check); resolve(); }
                            }, 500);
                        }), 10000, 'portal teleport');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Entered portal. Now in ${bot.game.dimension}.`, environment: getEnvironmentContext() } });
                    } catch (e) {
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Portal transit timeout: ${e.message}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── activate_end_portal ───────────────────────────────────────────
            } else if (action.action === 'activate_end_portal') {
                const frameId = bot.registry.blocksByName['end_portal_frame']?.id;
                if (!frameId) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'end_portal_frame not in registry.', environment: getEnvironmentContext() } });
                } else {
                    const frames = bot.findBlocks({ matching: frameId, maxDistance: 16, count: 12 });
                    let activated = 0;
                    for (const framePos of frames) {
                        if (currentCancelToken.cancelled) break;
                        const frameBlock = bot.blockAt(framePos);
                        if (!frameBlock) continue;
                        // Check if eye is already present
                        if (frameBlock.properties && frameBlock.properties.eye === 'true') continue;

                        const eyeId = bot.registry.itemsByName['ender_eye']?.id;
                        const eye = eyeId !== undefined ? bot.inventory.items().find(i => i.name === 'ender_eye') : null;
                        if (!eye) { bot.chat('Out of Eyes of Ender.'); break; }

                        await bot.equip(eye, 'hand');
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(framePos.x, framePos.y, framePos.z, 3)), 15000, 'goto portal frame', () => bot.pathfinder.setGoal(null));
                        try {
                            await withTimeout(bot.activateBlock(frameBlock), 5000, 'place eye in frame');
                            activated++;
                        } catch (e) { console.log(`[Actuator] activate_end_portal: ${e.message}`); }
                    }
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Activated ${activated}/${frames.length} portal frames.`, environment: getEnvironmentContext() } });
                }

            // ── place_pattern (includes Wither summon) ────────────────────────
            } else if (action.action === 'place_pattern') {
                const patternName = action.target || action.pattern;
                const pattern = PLACE_PATTERNS[patternName];

                if (!pattern) {
                    bot.chat(`Unknown pattern: ${patternName}`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Unknown pattern: ${patternName}`, environment: getEnvironmentContext() } });
                } else {
                    // Place the pattern in front of and at the feet of the bot
                    const baseX = Math.floor(bot.entity.position.x) - 1;
                    const baseY = Math.floor(bot.entity.position.y) - 1;
                    const baseZ = Math.floor(bot.entity.position.z) + 2;
                    let placed = 0, missing = 0;

                    for (const entry of pattern) {
                        if (currentCancelToken.cancelled) break;
                        const tx = baseX + entry.dx;
                        const ty = baseY + entry.dy;
                        const tz = baseZ + entry.dz;

                        const existing = bot.blockAt(new Vec3(tx, ty, tz));
                        if (existing && existing.name !== 'air') { placed++; continue; }

                        const blockItemId = bot.registry.itemsByName[entry.name]?.id ?? bot.registry.blocksByName[entry.name]?.id;
                        const blockItem = bot.inventory.items().find(i => i.name === entry.name || i.type === blockItemId);
                        if (!blockItem) { bot.chat(`Missing ${entry.name}.`); missing++; continue; }

                        await bot.equip(blockItem, 'hand');
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, 3)), 15000, `goto pattern pos`, () => bot.pathfinder.setGoal(null)).catch(() => {});

                        const below = bot.blockAt(new Vec3(tx, ty - 1, tz));
                        if (below && below.name !== 'air' && below.name !== 'water' && below.name !== 'lava') {
                            try {
                                await withTimeout(bot.placeBlock(below, new Vec3(0, 1, 0)), 5000, `place ${entry.name}`);
                                placed++;
                            } catch (e) { console.log(`[Actuator] place_pattern: ${e.message}`); missing++; }
                        } else {
                            console.log(`[Actuator] place_pattern: no solid surface below ${tx},${ty},${tz}`);
                            missing++;
                        }
                    }

                    const msg = missing === 0
                        ? `Pattern ${patternName} placed successfully.`
                        : `Pattern ${patternName}: placed ${placed}, failed ${missing}.`;
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: msg, environment: getEnvironmentContext() } });
                }

            } // end action dispatch

        } catch (err) {
            console.error(`[Actuator] Action execution failed: ${err.message}`);
            bot.chat("An error occurred.");
            bot.pathfinder.setGoal(null);
            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Action failed: ${err.message}`, environment: getEnvironmentContext() } });
        }
    }

    isExecuting = false;
}

process.on('message', async (msg) => {
    if (msg.type === 'EXECUTE_ACTION') {
        let actions = msg.action;
        if (!Array.isArray(actions)) actions = [actions];

        // 1. Signal the running loop to stop
        actionQueue = [];
        currentCancelToken.cancelled = true;
        bot.pathfinder.setGoal(null);
        if (bot.collectBlock && typeof bot.collectBlock.cancelTask === 'function') {
            bot.collectBlock.cancelTask();
        }

        // 2. Wait for the current processActionQueue() iteration to exit.
        //    Without this, assigning a new cancelToken and pushing to the queue
        //    races with the old loop, causing actions to re-execute or infinite loops.
        while (isExecuting) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // 3. Exit if the command was only "stop"
        if (actions.length === 1 && actions[0].action === 'stop') {
            return;
        }

        // 4. Fresh token + queue for the new command
        currentCancelToken = { cancelled: false };
        actionQueue.push(...actions);
        processActionQueue();
    }
});

// Global Error Handling
bot.on('kicked', (reason) => {
    console.log(`[Actuator] Kicked: ${reason}`);
    process.send({ type: 'ERROR', category: 'Kicked', details: reason });
});
bot.on('error', (err) => {
    console.error(`[Actuator] Bot Error: ${err.message}`);
    process.send({ type: 'ERROR', category: 'BotError', details: err.message });
});
bot.on('end', () => console.log('[Actuator] Disconnected from server.'));
