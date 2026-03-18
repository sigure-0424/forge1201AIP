// bot_actuator.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const ForgeHandshakeStateMachine = require('./forge_handshake_state_machine');
const DynamicRegistryInjector = require('./dynamic_registry_injector');
const EventDebouncer = require('./event_debouncer');
const InventoryNBTPatch = require('./inventory_nbt_patch');
const CreateContraptionHazard = require('./create_contraption_hazard');
const nbt = require('prismarine-nbt');

// Robust Crash Protection
process.on('uncaughtException', (err) => {
    console.error(`[Actuator] CRITICAL UNCAUGHT EXCEPTION: ${err.message}`);
    console.error(err.stack);
    process.send({ type: 'ERROR', category: 'BotError', details: err.message });
});

const botId = process.env.BOT_ID || 'Bot';
const botOptions = process.env.BOT_OPTIONS ? JSON.parse(process.env.BOT_OPTIONS) : {};

console.log(`[Actuator] Starting ${botId} for Forge 1.20.1...`);

// Global Protocol/NBT Bypasses
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
        console.log('[Actuator] Handshake finalized. Injecting registries...');
        const injector = new DynamicRegistryInjector(bot.registry);
        const parsed = injector.parseRegistryPayload(registrySyncBuffer);
        injector.injectBlockToRegistry(parsed);
        bot.hazards = new Set();
    });
});

bot.loadPlugin(pathfinder);

bot.on('spawn', () => {
    const pos = bot.entity.position;
    console.log(`[Actuator] Bot spawned at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`);
    
    bot.entity.velocity.set(0, 0, 0);

    // Movements Setup
    const movements = new Movements(bot, mcData); 
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.allow1by1towers = true;
    movements.digCost = 10;
    movements.placeCost = 10;
    
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = 4000; // Cap pathfinding time to prevent lockup
    
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

// SERVER VELOCITY SYNC
bot._client.on('entity_velocity', (packet) => {
    if (packet.entityId === bot.entity.id) {
        console.log(`[Actuator] Recv Knockback: ${packet.velocityX}, ${packet.velocityY}, ${packet.velocityZ}`);
        // The server sends velocity as 1/8000th of a block per tick.
        bot.entity.velocity.set(packet.velocityX / 8000, packet.velocityY / 8000, packet.velocityZ / 8000);
    }
});

// PASSIVE PHYSICS FALLBACK: Prevent floating when chunks are unloaded
bot.on('physicsTick', () => {
    if (!bot.entity) return;
    const pos = bot.entity.position;
    // When the bot is in an unloaded chunk, Mineflayer's physics engine simply returns without
    // updating gravity, causing the bot to float. To "treat the server as the source of truth"
    // and passively fall, we manually apply gravity if the block underneath cannot be resolved.
    if (bot.blockAt(pos) == null) {
        bot.entity.velocity.y -= 0.08; // gravity
        bot.entity.velocity.y *= 0.98; // drag
        bot.entity.position.add(bot.entity.velocity);
    }
});

// Chat Command Handler
bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    const parts = message.toLowerCase().split(' ');
    const cmd = parts[0];

    try {
        if (cmd === 'come') {
            const player = bot.players[username];
            if (!player || !player.entity) {
                bot.chat('I cannot see you!');
                return;
            }
            bot.chat(`Coming to you, ${username}!`);
            const goal = new goals.GoalFollow(player.entity, 1);
            bot.pathfinder.setGoal(goal, true);
        } else if (cmd === 'status') {
            const p = bot.entity.position;
            bot.chat(`Pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} | HP: ${bot.health.toFixed(0)} | Ground: ${bot.entity.onGround}`);
        } else if (cmd === 'stop') {
            bot.pathfinder.setGoal(null);
            bot.chat('Stopped.');
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
