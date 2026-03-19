// bot_actuator.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const ForgeHandshakeStateMachine = require('./forge_handshake_state_machine');
const DynamicRegistryInjector = require('./dynamic_registry_injector');
const nbt = require('prismarine-nbt');

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

    try {
        await bot.waitForChunksToLoad();
    } catch (e) {
        console.log(`[Actuator] Failed to wait for chunks: ${e.message}`);
    }

    // Vanilla-standard physics
    bot.physics.enabled = true;

    // Vanilla-standard movements
    const movements = new Movements(bot, mcData);
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.allow1by1towers = true;
    movements.maxDropDown = 4;

    bot.pathfinder.setMovements(movements);
    // FIX 2: Increased from 1000ms — 1s was too strict for slight elevation or moderately complex terrain
    bot.pathfinder.thinkTimeout = 5000;
    bot.pathfinder.tickTimeout = 10;

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
        players_nearby: Object.keys(bot.players).filter(p => p !== bot.username && bot.players[p].entity),
        inventory: bot.inventory ? bot.inventory.items().map(item => ({ name: item.name, count: item.count })) : []
    };
}

// Eye (Perception): Send environment context to AgentManager
bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    process.send({ type: 'USER_CHAT', data: { username, message, environment: getEnvironmentContext() } });
});

// Body (Action): Receive and execute JSON command from Brain
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
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
}

// Equip the fastest tool in inventory for the given block.
// Defined at module level so ensureToolFor can call it.
async function equipBestTool(block) {
    let bestTool = null;
    let bestTime = Infinity;

    const tools = bot.inventory.items();
    for (const tool of tools) {
        const time = block.digTime(
            tool ? tool.type : null,
            false, // creative
            false, // in water
            false, // on ground
            [], // enchantments
            bot.entity.effects
        );
        if (time < bestTime) {
            bestTime = time;
            bestTool = tool;
        }
    }
    if (bestTool) {
        try {
            await bot.equip(bestTool, 'hand');
        } catch (e) {
            console.log(`[Actuator] Failed to equip tool: ${e.message}`);
        }
    }
}

// ─── FIX 6: Auto-Tool Verification Subroutine ─────────────────────────────────

// Block name → tool category heuristic. Covers all common vanilla block families.
function inferToolCategory(block) {
    const name = block.name.toLowerCase();
    if (name.includes('stone') || name.includes('ore') || name.includes('cobblestone') ||
        name.includes('granite') || name.includes('diorite') || name.includes('andesite') ||
        name.includes('sandstone') || name.includes('brick') || name.includes('obsidian') ||
        name.includes('basalt') || name.includes('blackstone') || name.includes('deepslate') ||
        name.includes('netherrack') || name.includes('end_stone') || name.includes('prismarine') ||
        name.includes('tuff') || name.includes('calcite') || name.includes('amethyst') ||
        name.includes('copper') || name.includes('iron') || name.includes('gold') ||
        name.includes('diamond') || name.includes('emerald') || name.includes('lapis') ||
        name.includes('redstone') || name.includes('coal') || name.includes('quartz') ||
        name.includes('nether_brick') || name.includes('purpur') || name.includes('terracotta') ||
        name.includes('concrete') || name.includes('smooth') || name.includes('polished')) {
        return 'pickaxe';
    }
    if (name.includes('log') || name.includes('_wood') || name.includes('plank') ||
        name.includes('fence') || name.includes('stem') || name.includes('hyphae') ||
        name.includes('chest') || name.includes('barrel') || name.includes('bookshelf') ||
        name.includes('crafting_table') || name.includes('jukebox') || name.includes('note_block') ||
        name.includes('ladder') || name.includes('sign') || name.includes('door') ||
        name.includes('trapdoor')) {
        return 'axe';
    }
    if (name.includes('dirt') || name.includes('gravel') || name.includes('sand') ||
        name.includes('grass') || name.includes('podzol') || name.includes('mycelium') ||
        name.includes('soul_sand') || name.includes('soul_soil') || name.includes('clay') ||
        name.includes('farmland') || name.includes('path') || name.includes('snow') ||
        name.includes('mud')) {
        return 'shovel';
    }
    return 'pickaxe'; // safe default for unknown tool-required blocks
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

// Before collecting a block, verify we have the required tool.
// If missing: gather wood → craft planks → craft sticks → place crafting table → craft wooden tool.
async function ensureToolFor(block) {
    if (!block.harvestTools || Object.keys(block.harvestTools).length === 0) return;

    const countByNames = (nameSet) => bot.inventory.items()
        .filter(i => nameSet.has(i.name))
        .reduce((sum, i) => sum + i.count, 0);

    // Already have a suitable tool — just equip it
    if (bot.inventory.items().some(item => block.harvestTools[item.type])) {
        await equipBestTool(block);
        return;
    }

    const toolCat = inferToolCategory(block);
    console.log(`[Actuator] No ${toolCat} found for ${block.name}. Auto-crafting wooden_${toolCat}...`);
    bot.chat(`Need a ${toolCat}. Crafting one...`);

    // ── Step 1: Gather logs if we don't have enough planks ──────────────────
    const sticksHave = bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0);
    // Tool head: 3 planks. Sticks (if needed): 2 planks → 4 sticks, we need 2.
    const planksNeeded = 3 + (sticksHave >= 2 ? 0 : 2);

    if (countByNames(PLANK_NAMES) < planksNeeded) {
        const logsNeeded = Math.ceil((planksNeeded - countByNames(PLANK_NAMES)) / 4);

        if (countByNames(LOG_NAMES) < logsNeeded) {
            for (const logName of LOG_NAMES) {
                const logBlockId = bot.registry.blocksByName[logName]?.id;
                if (!logBlockId) continue;
                const logBlocks = bot.findBlocks({ matching: logBlockId, maxDistance: 32, count: logsNeeded });
                if (logBlocks.length === 0) continue;

                for (const logPos of logBlocks) {
                    if (countByNames(LOG_NAMES) >= logsNeeded) break;
                    try {
                        const logBlock = bot.blockAt(logPos);
                        await withTimeout(
                            bot.collectBlock.collect(logBlock), 20000,
                            `auto-collect ${logName}`,
                            () => { bot.pathfinder.setGoal(null); if (bot.collectBlock.cancelTask) bot.collectBlock.cancelTask(); }
                        );
                    } catch (e) {
                        console.log(`[Actuator] Auto-tool: failed to collect ${logName}: ${e.message}`);
                    }
                }
                if (countByNames(LOG_NAMES) >= logsNeeded) break;
            }
        }

        // ── Step 2: Craft planks from gathered logs ──────────────────────────
        for (const log of bot.inventory.items().filter(i => LOG_NAMES.has(i.name))) {
            const plankName = log.name.replace(/_log$/, '_planks').replace(/_wood$/, '_planks');
            const plankId = bot.registry.itemsByName[plankName]?.id;
            if (plankId === undefined) continue;
            const recipe = bot.recipesFor(plankId, null, 1, false)[0];
            if (!recipe) continue;
            try {
                await bot.craft(recipe, Math.min(log.count, 2), null); // up to 2 logs → 8 planks
                break;
            } catch (e) {
                console.log(`[Actuator] Auto-tool: failed to craft planks: ${e.message}`);
            }
        }
    }

    // ── Step 3: Craft sticks if needed ──────────────────────────────────────
    const sticksNow = bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0);
    if (sticksNow < 2) {
        const anyPlank = bot.inventory.items().find(i => PLANK_NAMES.has(i.name));
        if (anyPlank) {
            const stickId = bot.registry.itemsByName['stick']?.id;
            const stickRecipe = stickId !== undefined ? bot.recipesFor(stickId, null, 1, false)[0] : null;
            if (stickRecipe) {
                try { await bot.craft(stickRecipe, 1, null); } catch (e) {
                    console.log(`[Actuator] Auto-tool: failed to craft sticks: ${e.message}`);
                }
            }
        }
    }

    // ── Step 4: Find or create a crafting table, navigate to it, craft tool ─
    const ctBlockId = bot.registry.blocksByName['crafting_table']?.id;
    let craftingTable = ctBlockId !== undefined
        ? bot.findBlock({ matching: ctBlockId, maxDistance: 32 })
        : null;

    if (!craftingTable) {
        const ctItemId = bot.registry.itemsByName['crafting_table']?.id ?? ctBlockId;
        if (ctItemId !== undefined) {
            if (!bot.inventory.items().find(i => i.name === 'crafting_table')) {
                const ctRecipe = bot.recipesFor(ctItemId, null, 1, false)[0];
                if (ctRecipe) {
                    try { await bot.craft(ctRecipe, 1, null); } catch (e) {
                        console.log(`[Actuator] Auto-tool: failed to craft crafting_table: ${e.message}`);
                    }
                }
            }

            const ctItem = bot.inventory.items().find(i => i.name === 'crafting_table');
            if (ctItem) {
                try {
                    await bot.equip(ctItem, 'hand');
                    const refBlock = bot.findBlock({
                        matching: b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava',
                        maxDistance: 4
                    });
                    if (refBlock) {
                        await bot.placeBlock(refBlock, new (require('vec3'))(0, 1, 0));
                        craftingTable = ctBlockId !== undefined
                            ? bot.findBlock({ matching: ctBlockId, maxDistance: 8 })
                            : null;
                    }
                } catch (e) {
                    console.log(`[Actuator] Auto-tool: failed to place crafting_table: ${e.message}`);
                }
            }
        }
    }

    if (craftingTable) {
        const toolName = `wooden_${toolCat}`;
        const toolId = bot.registry.itemsByName[toolName]?.id;
        if (toolId !== undefined) {
            const toolRecipe = bot.recipesFor(toolId, null, 1, true)[0];
            if (toolRecipe) {
                try {
                    await withTimeout(
                        bot.pathfinder.goto(new goals.GoalGetToBlock(
                            craftingTable.position.x, craftingTable.position.y, craftingTable.position.z
                        )),
                        15000, 'goto crafting table (auto-tool)', () => bot.pathfinder.setGoal(null)
                    );
                    await bot.craft(toolRecipe, 1, craftingTable);
                    bot.chat(`Crafted a ${toolName}!`);
                } catch (e) {
                    console.log(`[Actuator] Auto-tool: failed to craft ${toolName}: ${e.message}`);
                }
            }
        }
    } else {
        console.log('[Actuator] Auto-tool: could not obtain a crafting table.');
    }

    await equipBestTool(block);
}

// ─────────────────────────────────────────────────────────────────────────────

async function processActionQueue() {
    if (isExecuting) return;
    isExecuting = true;

    while (actionQueue.length > 0) {
        const action = actionQueue.shift();
        const timeoutMs = action.timeout ? action.timeout * 1000 : 30000;

        try {
            if (!action || !action.action) continue;
            if (currentCancelToken.cancelled) break;

            if (action.action === 'chat') {
                bot.chat(action.message);

            // FIX 1: Continuous follow using GoalFollow instead of a one-shot GoalNear
            } else if (action.action === 'come') {
                const targetEntity = bot.players[action.target]?.entity;
                if (targetEntity) {
                    bot.chat(`Following ${action.target}!`);
                    // Dynamic=true lets the pathfinder recompute as the player moves
                    bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, 2), true);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Now following ${action.target}.`, environment: getEnvironmentContext() } });
                    // Hold the queue slot until a 'stop' command arrives
                    await new Promise(resolve => {
                        const check = setInterval(() => {
                            if (currentCancelToken.cancelled) { clearInterval(check); resolve(); }
                        }, 500);
                    });
                } else {
                    bot.chat(`I cannot see ${action.target} in my field of view.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to find ${action.target}.`, environment: getEnvironmentContext() } });
                }

            // FIX 3: No 50-block cap; waypoint loop handles arbitrarily long XZ distances
            } else if (action.action === 'goto') {
                const WAYPOINT_STEP = 64; // blocks per pathfinding segment

                const destX = action.x;
                const destZ = action.z;

                if (action.y !== undefined) {
                    // XYZ: Y-constraint limits the search tree — navigate directly
                    bot.chat(`Moving to X:${Math.round(destX)}, Y:${action.y}, Z:${Math.round(destZ)}.`);
                    await withTimeout(
                        bot.pathfinder.goto(new goals.GoalNear(destX, action.y, destZ, 2)),
                        timeoutMs, 'goto XYZ', () => bot.pathfinder.setGoal(null)
                    );
                } else {
                    // XZ: use waypoints so the pathfinder never evaluates an enormous graph at once
                    const initDx = destX - bot.entity.position.x;
                    const initDz = destZ - bot.entity.position.z;
                    const totalDist = Math.sqrt(initDx * initDx + initDz * initDz);

                    bot.chat(`Moving to X:${Math.round(destX)}, Z:${Math.round(destZ)}${totalDist > WAYPOINT_STEP ? ` (~${Math.round(totalDist)} blocks)` : ''}.`);

                    let lastRemDist = totalDist;
                    let stuckCount = 0;

                    while (!currentCancelToken.cancelled) {
                        const curX = bot.entity.position.x;
                        const curZ = bot.entity.position.z;
                        const remDx = destX - curX;
                        const remDz = destZ - curZ;
                        const remDist = Math.sqrt(remDx * remDx + remDz * remDz);

                        if (remDist <= 2) break;

                        // Stuck detection: abort if we make no progress across multiple waypoints
                        if (remDist >= lastRemDist - 1) {
                            if (++stuckCount >= 3) {
                                throw new Error(`No progress toward X:${Math.round(destX)}, Z:${Math.round(destZ)} after ${stuckCount} waypoints.`);
                            }
                        } else {
                            stuckCount = 0;
                        }
                        lastRemDist = remDist;

                        // Next waypoint: clamp to destination when close enough
                        let wpX = destX;
                        let wpZ = destZ;
                        if (remDist > WAYPOINT_STEP) {
                            const angle = Math.atan2(remDz, remDx);
                            wpX = curX + WAYPOINT_STEP * Math.cos(angle);
                            wpZ = curZ + WAYPOINT_STEP * Math.sin(angle);
                        }

                        await withTimeout(
                            bot.pathfinder.goto(new goals.GoalXZ(wpX, wpZ)),
                            timeoutMs, 'goto XZ waypoint', () => bot.pathfinder.setGoal(null)
                        );
                    }
                }

                if (!currentCancelToken.cancelled) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully reached destination.`, environment: getEnvironmentContext() } });
                }

            } else if (action.action === 'collect') {
                const blockId = bot.registry.blocksByName[action.target]?.id;
                if (blockId !== undefined) {
                    const quantity = parseInt(action.quantity, 10) || 1;
                    const blocks = bot.findBlocks({ matching: blockId, maxDistance: 32, count: quantity });
                    if (blocks.length > 0) {
                        // FIX 6: Pre-check tool requirement once before the collection loop
                        const firstBlock = bot.blockAt(blocks[0]);
                        if (firstBlock) await ensureToolFor(firstBlock);

                        bot.chat(`Collecting ${blocks.length} ${action.target}...`);
                        let collected = 0;
                        for (const blockPos of blocks) {
                            if (currentCancelToken.cancelled) break;
                            if (collected >= quantity) break;

                            try {
                                const targetBlock = bot.blockAt(blockPos);
                                await equipBestTool(targetBlock);
                                await withTimeout(bot.collectBlock.collect(targetBlock), timeoutMs, `collect ${action.target}`, () => {
                                    bot.pathfinder.setGoal(null);
                                    if (bot.collectBlock.cancelTask) bot.collectBlock.cancelTask();
                                });
                                collected++;
                            } catch (err) {
                                // FIX 4: Skip the failed block; do not abort the whole task
                                console.error(`[Actuator] Skipping block at ${blockPos}: ${err.message}`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Skipped unreachable block at ${blockPos}: ${err.message}`, environment: getEnvironmentContext() } });
                                continue; // was: break
                            }
                        }
                        if (collected > 0) {
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully collected ${collected} ${action.target}.`, environment: getEnvironmentContext() } });
                        }
                    } else {
                        bot.chat(`Could not find any ${action.target} nearby.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Could not find ${action.target}.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    bot.chat(`I don't know what ${action.target} is.`);
                }

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
                    bot.chat(`I cannot see ${action.target} to give them items.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot see ${action.target}.`, environment: getEnvironmentContext() } });
                } else {
                    bot.chat(`I don't know what item ${itemTargetName} is.`);
                }

            } else if (action.action === 'craft') {
                const itemId = bot.registry.itemsByName[action.target]?.id || bot.registry.blocksByName[action.target]?.id;
                if (itemId !== undefined) {
                    const quantity = parseInt(action.quantity, 10) || 1;
                    const recipe = bot.recipesFor(itemId, null, 1, true)[0];
                    if (recipe) {
                        bot.chat(`I can craft ${action.target}.`);
                        if (recipe.requiresTable) {
                            const craftingTableId = bot.registry.blocksByName['crafting_table'].id;
                            const craftingTable = bot.findBlock({ matching: craftingTableId, maxDistance: 32 });
                            if (craftingTable) {
                                bot.chat(`Moving to crafting table at ${craftingTable.position}...`);
                                await withTimeout(bot.pathfinder.goto(new goals.GoalGetToBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z)), timeoutMs, 'goto crafting table', () => bot.pathfinder.setGoal(null));
                                try {
                                    await withTimeout(bot.craft(recipe, quantity, craftingTable), timeoutMs, 'crafting at table');
                                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully crafted ${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                                } catch (err) {
                                    bot.chat(`Failed to craft ${action.target} at table.`);
                                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to craft ${action.target}: ${err.message}`, environment: getEnvironmentContext() } });
                                }
                            } else {
                                bot.chat(`I need a crafting table to craft ${action.target}, but none are nearby.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `No crafting table nearby for ${action.target}.`, environment: getEnvironmentContext() } });
                            }
                        } else {
                            try {
                                await withTimeout(bot.craft(recipe, quantity, null), timeoutMs, 'crafting in inventory');
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully crafted ${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                            } catch (err) {
                                bot.chat(`Failed to craft ${action.target} in inventory.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to craft ${action.target}: ${err.message}`, environment: getEnvironmentContext() } });
                            }
                        }
                    } else {
                        bot.chat(`I do not have the materials or the recipe to craft ${action.target}.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot craft ${action.target}. Missing materials or recipe.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    bot.chat(`I don't know what ${action.target} is.`);
                }

            } else if (action.action === 'place') {
                const blockId = bot.registry.blocksByName[action.target]?.id || bot.registry.itemsByName[action.target]?.id;
                if (blockId !== undefined) {
                    const itemToPlace = bot.inventory.items().find(item => item.type === blockId);
                    if (itemToPlace) {
                        try {
                            await bot.equip(itemToPlace, 'hand');
                            bot.chat(`Placing ${action.target}...`);

                            const referenceBlock = bot.findBlock({
                                matching: (block) => block && block.name !== 'air' && block.name !== 'water' && block.name !== 'lava',
                                maxDistance: 4
                            });

                            if (referenceBlock) {
                                const faceVector = new (require('vec3'))(0, 1, 0);
                                await withTimeout(bot.placeBlock(referenceBlock, faceVector), timeoutMs, 'place block');
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully placed ${action.target}.`, environment: getEnvironmentContext() } });
                            } else {
                                bot.chat(`No suitable block nearby to place ${action.target} against.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to find a reference block to place ${action.target}.`, environment: getEnvironmentContext() } });
                            }
                        } catch (err) {
                            bot.chat(`Failed to place ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to place ${action.target}: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    } else {
                        bot.chat(`I do not have any ${action.target} in my inventory to place.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${action.target} found in inventory.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    bot.chat(`I don't know what ${action.target} is.`);
                }

            } else if (action.action === 'equip') {
                const itemId = bot.registry.itemsByName[action.target]?.id;
                if (itemId !== undefined) {
                    const itemToEquip = bot.inventory.items().find(item => item.type === itemId);
                    if (itemToEquip) {
                        try {
                            await bot.equip(itemToEquip, 'hand');
                            bot.chat(`Equipped ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equipped ${action.target}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            bot.chat(`Cannot equip ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to equip ${action.target}: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    } else {
                        bot.chat(`I don't have any ${action.target} to equip.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${action.target} found in inventory.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    bot.chat(`I don't know what ${action.target} is.`);
                }
            }
        } catch (err) {
            console.error(`[Actuator] Action execution failed: ${err.message}`);
            bot.chat("An error occurred during action execution.");
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

        if (actions.length === 1 && actions[0].action === 'stop') {
            actionQueue = [];
            currentCancelToken.cancelled = true;
            bot.pathfinder.setGoal(null);
            if (bot.collectBlock.cancelTask) bot.collectBlock.cancelTask();
            // FIX 5: Removed bot.chat("Stopped.") — suppressed to prevent chat spam on every user utterance
            return;
        }

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
