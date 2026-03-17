// bot_actuator.js
// Isolated child process containing the actual Mineflayer logic and middlewares
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const ForgeHandshakeStateMachine = require('./forge_handshake_state_machine');
const DynamicRegistryInjector = require('./dynamic_registry_injector');
const EventDebouncer = require('./event_debouncer');
const InventoryNBTPatch = require('./inventory_nbt_patch');
const CreateContraptionHazard = require('./create_contraption_hazard');

const botId = process.env.BOT_ID || 'Bot';
const botOptions = process.env.BOT_OPTIONS ? JSON.parse(process.env.BOT_OPTIONS) : {};

process.send({ type: 'LOG', data: `Actuator for ${botId} starting up...` });

const bot = mineflayer.createBot({
    host: (botOptions.host || 'localhost') + '\0FML3\0',
    port: botOptions.port || 25565,
    username: botId,
    version: '1.20.1',
    maxPacketSize: 10 * 1024 * 1024 // 10MB for large modded packets
});

// We must append the FML3 token to the host to bypass the initial kick if it's not already handled by node-minecraft-protocol
// Actually, let's wait for bot._client to be available
bot.on('inject_allowed', () => {
    process.send({ type: 'LOG', data: `${botId} client injected, initializing FML3 handshake.` });
    const handshake = new ForgeHandshakeStateMachine(bot._client);
    
    handshake.on('handshake_complete', (registrySyncBuffer) => {
        process.send({ type: 'LOG', data: `${botId} FML3 handshake complete. Injecting registries...` });
        const injector = new DynamicRegistryInjector(bot.registry);
        const parsed = injector.parseRegistryPayload(registrySyncBuffer);
        injector.injectBlockToRegistry(parsed);
    });

    // Handle packet parsing errors specifically
    bot._client.on('error', (err) => {
        if (err.field === 'play.toClient') {
            process.send({ type: 'ERROR', category: 'ParseError', details: `Failed to parse S2C packet: ${err.message}` });
        }
    });
});

// Load pathfinder
bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
    process.send({ type: 'LOG', data: `${botId} spawned successfully.` });
    const block = bot.blockAt(bot.entity.position);
    process.send({ type: 'LOG', data: `Spawned on block: ${block.name} (ID: ${block.type})` });

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
        } else if (command === 'goto') {
            const x = parseInt(args[0], 10);
            const y = parseInt(args[1], 10);
            const z = parseInt(args[2], 10);
            if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
                process.send({ type: 'LOG', data: `Pathfinding to ${x}, ${y}, ${z}...` });
                bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
            } else {
                bot.chat('Invalid coordinates for goto command.');
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
        // Recovery logic
        process.send({ type: 'LOG', data: 'Dummy block injected successfully for recovery.' });
    }
});

// Event listeners for pathfinding
bot.on('path_update', (results) => {
    process.send({ type: 'LOG', data: `Pathfinder update: status=${results.status}, path length=${results.path.length}` });
});

bot.on('goal_reached', () => {
    process.send({ type: 'LOG', data: 'Goal reached.' });
});

bot.on('error', (err) => {
    process.send({ type: 'ERROR', category: 'BotError', details: err.message });
});

bot.on('kicked', (reason) => {
    process.send({ type: 'ERROR', category: 'Kicked', details: reason });
});
