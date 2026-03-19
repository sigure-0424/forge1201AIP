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

bot.on('spawn', () => {
    console.log(`[Actuator] Bot spawned. Initializing physics and pathfinder...`);
    
    // Vanilla-standard physics
    bot.physics.enabled = true;
    
    // Vanilla-standard movements
    const movements = new Movements(bot, mcData); 
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.allow1by1towers = false; // Prevent digging beneath own feet
    
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = 5000;
    
    console.log('[Actuator] Pathfinder and Physics initialized.');
    bot.chat('Forge AI Player Ready.');
});

function getEnvironmentContext() {
    const pos = bot.entity.position;
    const health = bot.health;
    const food = bot.food;
    const onGround = bot.entity.onGround;

    const inventory = bot.inventory.items().map(item => ({
        name: item.name,
        count: item.count
    }));

    const heldItem = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
    const heldItemName = heldItem ? heldItem.name : 'none';

    // Scan for nearby entities
    const nearbyEntities = [];
    for (const id in bot.entities) {
        const entity = bot.entities[id];
        if (entity === bot.entity) continue;
        const distance = pos.distanceTo(entity.position);
        if (distance < 16) {
            nearbyEntities.push({
                type: entity.type,
                name: entity.username || entity.name,
                distance: distance.toFixed(1),
                position: { x: entity.position.x.toFixed(1), y: entity.position.y.toFixed(1), z: entity.position.z.toFixed(1) }
            });
        }
    }

    // Quick scan for interesting blocks nearby (simplified to avoid freezing)
    const interestingBlocks = [];
    const blockIdsToFind = [
        bot.registry.blocksByName['oak_log']?.id,
        bot.registry.blocksByName['diamond_ore']?.id,
        bot.registry.blocksByName['iron_ore']?.id
    ].filter(id => id !== undefined);

    if (blockIdsToFind.length > 0) {
        const blocks = bot.findBlocks({ matching: blockIdsToFind, maxDistance: 16, count: 5 });
        for (const p of blocks) {
            const block = bot.blockAt(p);
            if (block) {
                interestingBlocks.push({
                    name: block.name,
                    position: { x: p.x, y: p.y, z: p.z },
                    distance: pos.distanceTo(p).toFixed(1)
                });
            }
        }
    }

    return {
        status: {
            position: { x: pos.x.toFixed(1), y: pos.y.toFixed(1), z: pos.z.toFixed(1) },
            health,
            food,
            onGround
        },
        inventory,
        heldItem: heldItemName,
        nearbyEntities,
        nearbyInterestingBlocks: interestingBlocks
    };
}

class LLMController {
    constructor(apiUrl = 'http://localhost:11434/api/generate', model = 'llama3') {
        this.apiUrl = apiUrl;
        this.model = model;
    }

    async askLLM(context, goal) {
        const prompt = `
You are a Minecraft AI player. Your goal is: "${goal}"

Current Environment:
${JSON.stringify(context, null, 2)}

Based on the environment and goal, choose one action to execute.
Output STRICTLY a valid JSON object matching one of these formats, and nothing else:
- {"action": "come", "target": "player_name"}
- {"action": "stop"}
- {"action": "status"}
- {"action": "goto", "x": number, "y": number, "z": number}
- {"action": "search", "target": "block_name"}
- {"action": "collect", "target": "block_name", "quantity": number}
- {"action": "give", "target": "player_name", "item": "item_name", "quantity": number}
- {"action": "done", "reason": "Goal achieved"}
`;

        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    prompt: prompt,
                    stream: false,
                    format: 'json'
                })
            });

            if (!response.ok) {
                throw new Error(`LLM API returned status ${response.status}`);
            }

            const data = await response.json();
            return JSON.parse(data.response);
        } catch (error) {
            console.error(`[LLM] Error asking LLM: ${error.message}`);
            return { action: 'stop' }; // Safe fallback
        }
    }
}

async function executeAction(payload) {
    const action = payload.action;
    try {
        if (action === 'come') {
            const targetName = payload.target;
            const player = bot.players[targetName];
            if (!player || !player.entity) {
                return `Cannot see player ${targetName}`;
            }
            bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 1), true);
            return `Following ${targetName}`;
        } else if (action === 'status') {
            const pos = bot.entity.position;
            const block = bot.blockAt(pos.offset(0, -0.5, 0));
            return `Pos: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)} | Ground: ${bot.entity.onGround} | Block: ${block ? block.name : '?'}`;
        } else if (action === 'stop') {
            bot.pathfinder.setGoal(null);
            return 'Stopped current action.';
        } else if (action === 'goto') {
            const { x, y, z } = payload;
            if (x === undefined || y === undefined || z === undefined) {
                return 'Missing coordinates for goto.';
            }
            try {
                await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
                return `Arrived at ${x}, ${y}, ${z}.`;
            } catch (err) {
                return `Failed to reach ${x}, ${y}, ${z}: ${err.message}`;
            }
        } else if (action === 'search') {
            const targetBlockName = payload.target;
            const targetBlockData = bot.registry.blocksByName[targetBlockName];
            if (!targetBlockData) {
                return `Unknown block: ${targetBlockName}`;
            }
            const blocks = bot.findBlocks({ matching: targetBlockData.id, maxDistance: 32, count: 10 });
            if (blocks.length === 0) {
                return `Could not find any ${targetBlockName} nearby.`;
            } else {
                return `Found ${blocks.length} ${targetBlockName}(s). Closest is at: ${blocks[0].x}, ${blocks[0].y}, ${blocks[0].z}`;
            }
        } else if (action === 'collect') {
            const targetBlockName = payload.target;
            const targetBlockData = bot.registry.blocksByName[targetBlockName];
            if (!targetBlockData) {
                return `Unknown block: ${targetBlockName}`;
            }
            let quantity = payload.quantity || 1;
            const bounds = payload.bounds;

            let collected = 0;
            while (collected < quantity) {
                const searchCount = bounds ? Math.max(quantity * 2, 256) : quantity * 2;
                let blocks = bot.findBlocks({ matching: targetBlockData.id, maxDistance: 64, count: searchCount });

                if (bounds) {
                    blocks = blocks.filter(p =>
                        p.x >= bounds.min.x && p.x <= bounds.max.x &&
                        p.y >= bounds.min.y && p.y <= bounds.max.y &&
                        p.z >= bounds.min.z && p.z <= bounds.max.z
                    );
                }

                if (blocks.length === 0) {
                    return `No more ${targetBlockName} found in range. Collected ${collected}/${quantity}.`;
                }

                const targetPos = blocks[0];
                try {
                    await bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
                    const targetBlock = bot.blockAt(targetPos);
                    if (targetBlock && targetBlock.name === targetBlockName) {
                        await bot.dig(targetBlock);
                        collected++;
                    }
                } catch (digErr) {
                    console.error(`[Actuator] Collect step failed: ${digErr.message}`);
                    return `Failed to collect block at ${targetPos.x}, ${targetPos.y}, ${targetPos.z}: ${digErr.message}. Collected ${collected}/${quantity}.`;
                }
            }
            return `Collection finished. Got ${collected}/${quantity} ${targetBlockName}(s).`;
        } else if (action === 'give') {
            const targetPlayerName = payload.target;
            const itemName = payload.item;
            const quantity = payload.quantity || 1;

            const targetPlayer = bot.players[targetPlayerName];
            if (!targetPlayer || !targetPlayer.entity) {
                return `I cannot see ${targetPlayerName} to give them items!`;
            }

            const itemData = bot.registry.itemsByName[itemName];
            if (!itemData) {
                return `I don't know what item ${itemName} is.`;
            }

            try {
                await bot.pathfinder.goto(new goals.GoalNear(targetPlayer.entity.position.x, targetPlayer.entity.position.y, targetPlayer.entity.position.z, 2));
                await bot.toss(itemData.id, null, quantity);
                return `Gave ${quantity} ${itemName}(s) to ${targetPlayerName}.`;
            } catch (err) {
                console.error(`[Actuator] Give step failed: ${err.message}`);
                return `Failed to give item to ${targetPlayerName}: ${err.message}`;
            }
        } else {
            return `Unknown action: ${action}`;
        }
    } catch (e) {
        console.error(`[Actuator] Error handling command: ${e.message}`);
        return `Error executing action ${action}: ${e.message}`;
    }
}

const llmController = new LLMController();
let isBusy = false;

// Autonomous Agent Loop
bot.on('chat', async (username, message) => {
    if (username === bot.username) return;

    // Check if the message is directed at the bot or if it's a direct command
    if (!message.toLowerCase().startsWith('bot ') && !message.toLowerCase().startsWith('ai ')) {
        // Fallback to basic commands for backwards compatibility in tests
        const cmd = message.toLowerCase();
        if (cmd === 'come' || cmd === 'status' || cmd === 'stop') {
            const res = await executeAction({ action: cmd, target: username });
            bot.chat(res);
            return;
        }

        // Also support old JSON direct format
        const jsonMatch = message.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
             try {
                 const payload = JSON.parse(jsonMatch[0]);
                 const res = await executeAction(payload);
                 bot.chat(res);
                 return;
             } catch (e) {
                 // ignore
             }
        }
        return;
    }

    const goal = message.replace(/^bot |^ai /i, '').trim();

    if (goal.toLowerCase() === 'stop') {
        bot.pathfinder.setGoal(null);
        isBusy = false;
        bot.chat('Stopped current task.');
        return;
    }

    if (isBusy) {
        bot.chat('I am currently busy. Please say "bot stop" to cancel the current task.');
        return;
    }

    bot.chat(`Understood. My goal is: ${goal}`);
    isBusy = true;
    let loopCount = 0;
    const maxLoops = 10;
    let actionResult = 'Started task.';

    while (isBusy && loopCount < maxLoops) {
        loopCount++;
        console.log(`[Agent Loop] Step ${loopCount}/${maxLoops} for goal: ${goal}`);

        const context = getEnvironmentContext();
        context.lastActionResult = actionResult;

        const actionObj = await llmController.askLLM(context, goal);
        console.log(`[Agent Loop] LLM decided action: ${JSON.stringify(actionObj)}`);

        if (actionObj.action === 'stop' || actionObj.action === 'done') {
            isBusy = false;
            bot.chat(`Goal completed or stopped. Reason: ${actionObj.reason || 'None'}`);
            break;
        }

        // Add implicit target if missing for 'come'
        if (actionObj.action === 'come' && !actionObj.target) {
            actionObj.target = username;
        }

        bot.chat(`Executing: ${actionObj.action}`);
        actionResult = await executeAction(actionObj);
        console.log(`[Agent Loop] Action result: ${actionResult}`);
    }

    if (loopCount >= maxLoops) {
        bot.chat('I stopped because it was taking too many steps.');
    }
    isBusy = false;
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
