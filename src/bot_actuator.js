// bot_actuator.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const ForgeHandshakeStateMachine = require('./forge_handshake_state_machine');
const DynamicRegistryInjector = require('./dynamic_registry_injector');
const EventDebouncer = require('./event_debouncer');
const InventoryNBTPatch = require('./inventory_nbt_patch');
const CreateContraptionHazard = require('./create_contraption_hazard');
const nbt = require('prismarine-nbt');

const botId = process.env.BOT_ID || 'Bot';
const botOptions = process.env.BOT_OPTIONS ? JSON.parse(process.env.BOT_OPTIONS) : {};

console.log(`[Actuator] Starting bot ${botId}...`);

// Global Protocol Patch for Forge 1.20.1
// We patch minecraft-data globally to ensure all subsequent Client instances use 'native'
// for packets that often cause parse errors in modded environments.
try {
    const mcDataGlobal = require('minecraft-data')('1.20.1');
    if (mcDataGlobal && mcDataGlobal.protocol && mcDataGlobal.protocol.play && mcDataGlobal.protocol.play.toClient) {
        const types = mcDataGlobal.protocol.play.toClient.types;
        types.declare_recipes = 'restBuffer';
        types.tags = 'restBuffer';
        types.advancements = 'restBuffer';
        console.log('[Actuator] Applied global protocol patches (Recipes/Tags/Advancements -> restBuffer).');
    }
} catch (e) {
    console.error(`[Actuator] Global protocol patch failed: ${e.message}`);
}

// Global NBT Patch for Forge 1.20.1
try {
    const nbtProto = nbt.protos.big;
    const originalRead = nbtProto.read;
    nbtProto.read = function (buffer, offset) {
        try {
            return originalRead.call(this, buffer, offset);
        } catch (e) {
            return nbtProto.readAnon(buffer, offset);
        }
    };
    console.log('[Actuator] Applied global NBT leniency patch.');
} catch (e) {
    console.error(`[Actuator] NBT patch failed: ${e.message}`);
}

const bot = mineflayer.createBot({
    host: (botOptions.host || 'localhost') + '\0FML3\0',
    port: botOptions.port || 25565,
    username: botId,
    version: '1.20.1',
    maxPacketSize: 10 * 1024 * 1024
});

// Protocol Patch: Preempt default plugin message listeners
bot.on('inject_allowed', () => {
    console.log('[Actuator] Protocol injection allowed. Initializing handshake...');
    
    // Handshake initialization
    const handshake = new ForgeHandshakeStateMachine(bot._client);
    handshake.on('handshake_complete', (registrySyncBuffer) => {
        console.log('[Actuator] Handshake complete. Injecting registries...');
        setTimeout(() => {
            const injector = new DynamicRegistryInjector(bot.registry);
            const parsed = injector.parseRegistryPayload(registrySyncBuffer);
            injector.injectBlockToRegistry(parsed);
            
            // Solid block proxy to prevent void death
            const handler = {
                get: (target, prop) => {
                    if (prop in target) return target[prop];
                    if (!isNaN(prop)) return { id: parseInt(prop), name: 'mod_block', boundingBox: 'block', hardness: 1 };
                    return undefined;
                }
            };
            bot.registry.blocks = new Proxy(bot.registry.blocks, handler);
        }, 100);
    });
});

bot.loadPlugin(pathfinder);

bot.on('spawn', () => {
    console.log('[Actuator] Bot spawned.');
    const debouncer = new EventDebouncer(bot);
    const nbtPatch = new InventoryNBTPatch(bot);
    const hazard = new CreateContraptionHazard(bot.pathfinder);
    nbtPatch.applyPatches();
    hazard.applyHeuristicOverride();
    const mcData = require('minecraft-data')(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));
    bot.chat('AI Player Online');
});

bot._client.on('error', (err) => {
    console.error(`[Actuator] Protocol Error: ${err.message} at ${err.field}`);
    process.send({ type: 'ERROR', category: 'ParseError', details: err.message });
});

bot.on('error', (err) => {
    console.error(`[Actuator] Bot Error: ${err.message}`);
    process.send({ type: 'ERROR', category: 'BotError', details: err.message });
});

bot.on('kicked', (reason) => {
    console.log(`[Actuator] Kicked: ${reason}`);
    process.send({ type: 'ERROR', category: 'Kicked', details: reason });
});

bot.on('end', () => {
    console.log('[Actuator] Connection ended.');
});
