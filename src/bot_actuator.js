// bot_actuator.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const ForgeHandshakeStateMachine = require('./forge_handshake_state_machine');
const DynamicRegistryInjector = require('./dynamic_registry_injector');
const EventDebouncer = require('./event_debouncer');
const InventoryNBTPatch = require('./inventory_nbt_patch');
const CreateContraptionHazard = require('./create_contraption_hazard');
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

console.log(`[Actuator] Initializing ${botId} for Forge 1.20.1...`);

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
    console.log('[Actuator] Global protocol/NBT patches applied.');
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
        bot.hazards = new Set();
    });
});

bot.loadPlugin(pathfinder);

bot.on('spawn', () => {
    const pos = bot.entity.position;
    console.log(`[Actuator] Spawned at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`);
    
    // Enable physics explicitly
    bot.physics.enabled = true;
    bot.entity.velocity.set(0, 0, 0);

    // Movements Setup
    const movements = new Movements(bot, mcData); 
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.allow1by1towers = false; 
    movements.digCost = 10;
    movements.placeCost = 10;
    
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = 4000; 
    
    console.log('[Actuator] Pathfinder and Physics initialized.');
    bot.chat('Forge AI Player Ready.');

    // Periodic Heartbeat
    setInterval(() => {
        if (bot.entity) {
            const p = bot.entity.position;
            console.log(`[Heartbeat] Pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} | Ground: ${bot.entity.onGround} | Health: ${bot.health.toFixed(1)}`);
        }
    }, 10000);
});

// Command Handler
bot.on('chat', async (username, message) => {
    if (username === bot.username) return;

    let cmdObj = null;

    // Attempt to parse JSON command format, including multi-line
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            cmdObj = JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.log(`[Actuator] Failed to parse JSON command: ${e.message}`);
        }
    }

    try {
        if (cmdObj) {
            // JSON Command format
            const action = cmdObj.action;
            const target = cmdObj.target;

            if (action === 'come') {
                const targetPlayer = target || username;
                const player = bot.players[targetPlayer];
                if (!player || !player.entity) {
                    bot.chat(`I cannot see ${targetPlayer}!`);
                    return;
                }
                bot.chat(`Coming to you, ${targetPlayer}!`);
                bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 1), true);
            } else if (action === 'break') {
                if (!target) {
                    bot.chat('Missing target coordinates (x,y,z).');
                    return;
                }
                const [x, y, z] = target.split(',').map(n => parseInt(n.trim(), 10));
                if (isNaN(x) || isNaN(y) || isNaN(z)) {
                    bot.chat('Invalid coordinates format.');
                    return;
                }

                const targetPos = new Vec3(x, y, z);
                const block = bot.blockAt(targetPos);

                if (!block || block.name === 'air') {
                    bot.chat('No block there or it is not loaded.');
                    return;
                }

                bot.chat(`Moving to break ${block.name} at ${x}, ${y}, ${z}...`);

                try {
                    // Wait until pathfinder finishes navigating near the block
                    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3));

                    bot.chat(`Breaking ${block.name}...`);
                    await bot.dig(block);
                    bot.chat(`Finished breaking ${block.name}.`);
                } catch (err) {
                    bot.chat(`Failed to reach or break block: ${err.message}`);
                }

            } else if (action === 'status') {
                const p = bot.entity.position;
                const b = bot.blockAt(p.offset(0, -0.5, 0));
                bot.chat(`Pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} | Ground: ${bot.entity.onGround} | Block: ${b ? b.name : '?'}`);
            } else if (action === 'stop') {
                bot.pathfinder.setGoal(null);
                bot.chat('Stopped.');
            } else {
                bot.chat(`Unknown action: ${action}`);
            }

        } else {
            // Legacy plaintext format fallback
            const parts = message.toLowerCase().split(' ');
            const cmd = parts[0];

            if (cmd === 'come') {
                const player = bot.players[username];
                if (!player || !player.entity) {
                    bot.chat('I cannot see you!');
                    return;
                }
                bot.chat(`Coming to you, ${username}!`);
                bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 1), true);
            } else if (cmd === 'status') {
                const p = bot.entity.position;
                const b = bot.blockAt(p.offset(0, -0.5, 0));
                bot.chat(`Pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} | Ground: ${bot.entity.onGround} | Block: ${b ? b.name : '?'}`);
            } else if (cmd === 'stop') {
                bot.pathfinder.setGoal(null);
                bot.chat('Stopped.');
            }
        }
    } catch (e) {
        console.error(`[Actuator] Chat Command Error: ${e.message}`);
    }
});

// Pathfinder Debugging
bot.on('path_update', (r) => {
    if (r.status === 'success') {
        const goal = r.to || (r.path && r.path.length > 0 ? r.path[r.path.length - 1] : null);
        if (goal) console.log(`[Pathfinder] Path found to ${goal.x.toFixed(1)}, ${goal.y.toFixed(1)}, ${goal.z.toFixed(1)}`);
    } else if (r.status !== 'partial') {
        console.log(`[Pathfinder] Failed: ${r.status}`);
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
