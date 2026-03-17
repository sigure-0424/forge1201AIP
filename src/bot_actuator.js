// bot_actuator.js
// Isolated child process containing the actual Mineflayer logic and middlewares
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

process.send({ type: 'LOG', data: `Actuator for ${botId} starting up...` });

// Global NBT Leniency Patch: Handle Forge's anonymous NBT in named slots
try {
    const nbtProto = nbt.protos.big;
    const originalRead = nbtProto.read;
    nbtProto.read = function (buffer, offset) {
        try {
            return originalRead.call(this, buffer, offset);
        } catch (e) {
            // Fallback to anonymous read (no name length prefix)
            return nbtProto.readAnon(buffer, offset);
        }
    };
    process.send({ type: 'LOG', data: 'Applied global NBT leniency patch.' });
} catch (e) {
    process.send({ type: 'LOG', data: `NBT patch failed: ${e.message}` });
}

const bot = mineflayer.createBot({
    host: (botOptions.host || 'localhost') + '\0FML3\0',
    port: botOptions.port || 25565,
    username: botId,
    version: '1.20.1',
    maxPacketSize: 10 * 1024 * 1024 // 10MB for large modded packets
});

// Forge 1.20.1 Protocol Patch: Disable problematic large packets
bot.once('inject_allowed', () => {
    process.send({ type: 'LOG', data: `${botId} client injected, initializing FML3 handshake.` });
    
    // Patch protocol to skip recipes and tags if they cause parse errors
    const tryPatch = () => {
        try {
            const protocol = bot._client.deserializer.protocol;
            if (protocol && protocol.play && protocol.play.toClient && protocol.play.toClient.types) {
                protocol.play.toClient.types.declare_recipes = 'native';
                protocol.play.toClient.types.tags = 'native';
                process.send({ type: 'LOG', data: 'Successfully patched declare_recipes and tags to native.' });
                return true;
            }
        } catch (e) {}
        return false;
    };

    if (!tryPatch()) {
        const timer = setInterval(() => { if (tryPatch()) clearInterval(timer); }, 50);
        setTimeout(() => clearInterval(timer), 5000);
    }

    const handshake = new ForgeHandshakeStateMachine(bot._client);
    
    handshake.on('handshake_complete', (registrySyncBuffer) => {
        process.send({ type: 'LOG', data: `${botId} FML3 handshake complete. Scheduling registry injection...` });
        
        // Use a small delay to avoid blocking the initial PLAY state packet processing
        setTimeout(() => {
            const injector = new DynamicRegistryInjector(bot.registry);
            const parsed = injector.parseRegistryPayload(registrySyncBuffer);
            injector.injectBlockToRegistry(parsed);
        }, 100);
    });

    // Handle packet parsing errors specifically
    bot._client.on('error', (err) => {
        process.send({ type: 'ERROR', category: 'ParseError', details: `Parse error for ${err.field}: ${err.message}` });
    });
});

// Load pathfinder
bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
    process.send({ type: 'LOG', data: `${botId} spawned successfully.` });
    
    // Initialize middlewares
    const debouncer = new EventDebouncer(bot);
    const nbtPatch = new InventoryNBTPatch(bot);
    const hazard = new CreateContraptionHazard(bot.pathfinder);
    
    nbtPatch.applyPatches();
    hazard.applyHeuristicOverride();

    const mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);

    process.send({ type: 'LOG', data: `${botId} middlewares initialized.` });

    // Chat command listener
    bot.on('chat', (username, message) => {
        if (username === bot.username) return;
        process.send({ type: 'LOG', data: `Received chat from ${username}: ${message}` });

        const args = message.split(' ');
        const command = args.shift();

        if (command === 'come') {
            const target = bot.players[username]?.entity;
            if (target) {
                process.send({ type: 'LOG', data: `Pathfinding to ${username}...` });
                bot.pathfinder.setGoal(new goals.GoalFollow(target, 1), true);
            } else {
                bot.chat(`I can't see you, ${username}.`);
            }
        }
    });
});

// Command Listener via IPC
process.on('message', (msg) => {
    if (msg.command === 'move_to') {
        const { x, y, z } = msg.params;
        process.send({ type: 'LOG', data: `${botId} moving to ${x}, ${y}, ${z}` });
        const goal = new goals.GoalBlock(x, y, z);
        bot.pathfinder.setGoal(goal);
    } else if (msg.command === 'inject_dummy_block') {
        process.send({ type: 'LOG', data: 'Dummy block injected successfully for recovery.' });
    }
});

bot.on('error', (err) => {
    process.send({ type: 'ERROR', category: 'BotError', details: err.message });
});

bot.on('kicked', (reason) => {
    process.send({ type: 'ERROR', category: 'Kicked', details: reason });
});
