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

    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = 3000;

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
        players_nearby: Object.keys(bot.players).filter(p => p !== bot.username && bot.players[p].entity)
    };
}

// Eye (Perception): Send environment context to AgentManager
bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    process.send({ type: 'USER_CHAT', data: { username, message, environment: getEnvironmentContext() } });
});

// Body (Action): Receive and execute JSON command from Brain
let actionQueue = [];
let isExecuting = false;

function withTimeout(promise, ms, actionName) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout exceeded for action: ${actionName} (${ms}ms)`)), ms))
    ]);
}

async function processActionQueue() {
    if (isExecuting) return;
    isExecuting = true;

    while (actionQueue.length > 0) {
        const action = actionQueue.shift();
        const timeoutMs = action.timeout ? action.timeout * 1000 : 30000; // default 30s timeout per action

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

        try {
            if (!action || !action.action) continue;

            if (action.action === 'chat') {
                bot.chat(action.message);
            } else if (action.action === 'come') {
                const targetPlayer = bot.players[action.target]?.entity;
                if (targetPlayer) {
                    bot.chat(`Heading towards ${action.target}!`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(targetPlayer.position.x, targetPlayer.position.y, targetPlayer.position.z, 2)), timeoutMs, 'come');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully followed ${action.target}.`, environment: getEnvironmentContext() } });
                } else {
                    bot.chat(`I cannot see ${action.target} in my field of view.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to find ${action.target}.`, environment: getEnvironmentContext() } });
                }
            } else if (action.action === 'goto') {
                let targetX = action.x;
                let targetZ = action.z;
                const dist = Math.sqrt(Math.pow(action.x - bot.entity.position.x, 2) + Math.pow(action.z - bot.entity.position.z, 2));

                if (dist > 50) {
                    const angle = Math.atan2(action.z - bot.entity.position.z, action.x - bot.entity.position.x);
                    targetX = bot.entity.position.x + 50 * Math.cos(angle);
                    targetZ = bot.entity.position.z + 50 * Math.sin(angle);
                    bot.chat(`Target is too far (${Math.round(dist)} blocks). Moving 50 blocks towards X:${action.x}, Z:${action.z}.`);
                }

                if (action.y === undefined) {
                    bot.chat(`Moving to coordinates X:${Math.round(targetX)}, Z:${Math.round(targetZ)}.`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalXZ(targetX, targetZ)), timeoutMs, 'goto XZ');
                } else {
                    bot.chat(`Moving to coordinates X:${Math.round(targetX)}, Y:${action.y}, Z:${Math.round(targetZ)}.`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(targetX, action.y, targetZ, 2)), timeoutMs, 'goto XYZ');
                }
                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully reached destination.`, environment: getEnvironmentContext() } });
            } else if (action.action === 'stop') {
                bot.pathfinder.setGoal(null);
                actionQueue = [];
                bot.chat("Stopped.");
            } else if (action.action === 'collect') {
                const blockId = bot.registry.blocksByName[action.target]?.id;
                if (blockId !== undefined) {
                    const blocks = bot.findBlocks({ matching: blockId, maxDistance: 64, count: action.quantity || 1 });
                    if (blocks.length > 0) {
                        bot.chat(`Collecting ${blocks.length} ${action.target}...`);
                        let collected = 0;
                        for (const blockPos of blocks) {
                            try {
                                const targetBlock = bot.blockAt(blockPos);
                                await equipBestTool(targetBlock);
                                await withTimeout(bot.collectBlock.collect(targetBlock), timeoutMs, `collect ${action.target}`);
                                collected++;
                            } catch (err) {
                                console.error(`[Actuator] Failed to collect block at ${blockPos}:`, err);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to collect block at ${blockPos}: ${err.message}`, environment: getEnvironmentContext() } });
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
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(targetPlayer.position.x, targetPlayer.position.y, targetPlayer.position.z, 2)), timeoutMs, 'goto player for give');
                    await bot.lookAt(targetPlayer.position.offset(0, 1.6, 0));
                    await bot.toss(itemId, null, action.quantity || 1);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully gave item to ${action.target}.`, environment: getEnvironmentContext() } });
                } else if (!targetPlayer) {
                    bot.chat(`I cannot see ${action.target} to give them items.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot see ${action.target}.`, environment: getEnvironmentContext() } });
                } else {
                    bot.chat(`I don't know what item ${itemTargetName} is.`);
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
            bot.pathfinder.setGoal(null); // Clear goal on failure
            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Action failed: ${err.message}`, environment: getEnvironmentContext() } });
        }
    }

    isExecuting = false;
}

process.on('message', async (msg) => {
    if (msg.type === 'EXECUTE_ACTION') {
        let actions = msg.action;
        if (!Array.isArray(actions)) actions = [actions];
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
