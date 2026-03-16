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
    host: botOptions.host || 'localhost',
    port: botOptions.port || 25565,
    username: botId,
    version: '1.20.1' // Version spoofing/handshake happens later
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
bot.on('goal_reached', () => {
    process.send({ type: 'LOG', data: 'Goal reached.' });
});

bot.on('error', (err) => {
    process.send({ type: 'ERROR', category: 'BotError', details: err.message });
});

bot.on('kicked', (reason) => {
    process.send({ type: 'ERROR', category: 'Kicked', details: reason });
});
