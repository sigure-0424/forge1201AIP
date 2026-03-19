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

// Eye (Perception): Send environment context to AgentManager
bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    const env = {
        position: bot.entity ? {
            x: Math.round(bot.entity.position.x),
            y: Math.round(bot.entity.position.y),
            z: Math.round(bot.entity.position.z)
        } : null,
        players_nearby: Object.keys(bot.players).filter(p => p !== bot.username && bot.players[p].entity)
    };

    process.send({ type: 'USER_CHAT', data: { username, message, environment: env } });
});

// Body (Action): Receive and execute JSON command from Brain
process.on('message', (msg) => {
    if (msg.type === 'EXECUTE_ACTION') {
        const action = msg.action;
        try {
            if (action.action === 'chat') {
                bot.chat(action.message);
            } else if (action.action === 'come') {
                const targetPlayer = bot.players[action.target]?.entity;
                if (targetPlayer) {
                    bot.pathfinder.setGoal(new goals.GoalFollow(targetPlayer, 1), true);
                    bot.chat(`Heading towards ${action.target}!`);
                } else {
                    bot.chat(`I cannot see ${action.target} in my field of view.`);
                }
            } else if (action.action === 'goto') {
                bot.pathfinder.setGoal(new goals.GoalBlock(action.x, action.y, action.z));
                bot.chat(`Moving to coordinates X:${action.x}, Y:${action.y}, Z:${action.z}.`);
            } else if (action.action === 'stop') {
                bot.pathfinder.setGoal(null);
                bot.chat("Stopped.");
            }
        } catch (err) {
            console.error(`[Actuator] Action execution failed: ${err.message}`);
            bot.chat("An error occurred during action execution.");
        }
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
