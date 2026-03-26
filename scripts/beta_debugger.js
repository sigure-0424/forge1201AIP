const mineflayer = require('mineflayer');
const AgentManager = require('../src/agent_manager');
const ForgeHandshakeStateMachine = require('../src/forge_handshake_state_machine');
const DynamicRegistryInjector = require('../src/dynamic_registry_injector');
const fs = require('fs');

const host = process.env.MC_HOST || 'localhost';
const port = parseInt(process.env.MC_PORT || '25565', 10);
const debugMode = process.env.DEBUG === 'true';

const testMasterOptions = {
    host: host + '\0FML3\0',
    port: port,
    username: 'TestMaster',
    version: '1.20.1',
    maxPacketSize: 10 * 1024 * 1024,
    disableChatSigning: true,
    hideErrors: false
};

const MOD_ITEMS = ['iron_chest:iron_chest', 'iron_chest:gold_chest', 'iron_chest:diamond_chest'];
const MOD_BLOCKS = ['iron_chest:iron_chest', 'iron_chest:gold_chest'];

let aiBotId1 = 'DebugBot_1';
let aiBotId2 = 'DebugBot_2';

let manager = null;
let master = null;
let basePos = null;

async function safeChat(bot, msg, delayMs = 250) {
    bot.chat(msg);
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

// Helper to wait for a specific chat message from the bot
function waitForBotChat(botId, pattern, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        let timeout = setTimeout(() => {
            master.removeListener('chat', listener);
            console.log(`[BetaDebugger] Timeout waiting for ${botId} to say: ${pattern}`);
            resolve(false);
        }, timeoutMs);

        const listener = (username, message) => {
            if (username === botId && message.match(pattern)) {
                clearTimeout(timeout);
                master.removeListener('chat', listener);
                console.log(`[BetaDebugger] Confirmed ${botId} response: ${message}`);
                resolve(true);
            }
        };
        master.on('chat', listener);
    });
}

async function startDebugger() {
    console.log('--- Starting Beta Debugging Test System ---');
    master = mineflayer.createBot(testMasterOptions);

    master.on('inject_allowed', () => {
        const handshake = new ForgeHandshakeStateMachine(master._client);
        handshake.on('handshake_complete', (registrySyncBuffer) => {
            const injector = new DynamicRegistryInjector(master.registry);
            const parsed = injector.parseRegistryPayload(registrySyncBuffer);
            injector.injectBlockToRegistry(parsed);
        });
    });

    master.on('spawn', async () => {
        console.log('[TestMaster] Spawned. Setting up test environment...');

        await new Promise(r => setTimeout(r, 2000));
        await safeChat(master, '/gamemode creative', 1000);

        const pos = master.entity.position;
        const x = Math.floor(pos.x);
        const y = Math.floor(pos.y);
        const z = Math.floor(pos.z);
        basePos = { x, y, z };

        console.log(`[TestMaster] Flattening area around ${x}, ${y}, ${z}...`);

        // Chunked fill to avoid 32k block limit (filling a 100x100x20 area is 200k blocks)
        // Split into quadrants
        await safeChat(master, `/fill ${x - 50} ${y} ${z - 50} ${x} ${y} ${z} stone`);
        await safeChat(master, `/fill ${x + 1} ${y} ${z - 50} ${x + 50} ${y} ${z} stone`);
        await safeChat(master, `/fill ${x - 50} ${y} ${z + 1} ${x} ${y} ${z + 50} stone`);
        await safeChat(master, `/fill ${x + 1} ${y} ${z + 1} ${x + 50} ${y} ${z + 50} stone`);
        await new Promise(r => setTimeout(r, 1000));

        // Clear air above (split by Y layers and quadrants)
        for (let dy = 1; dy <= 20; dy += 5) {
            let maxY = Math.min(dy + 4, 20);
            await safeChat(master, `/fill ${x - 50} ${y + dy} ${z - 50} ${x} ${y + maxY} ${z} air`);
            await safeChat(master, `/fill ${x + 1} ${y + dy} ${z - 50} ${x + 50} ${y + maxY} ${z} air`);
            await safeChat(master, `/fill ${x - 50} ${y + dy} ${z + 1} ${x} ${y + maxY} ${z + 50} air`);
            await safeChat(master, `/fill ${x + 1} ${y + dy} ${z + 1} ${x + 50} ${y + maxY} ${z + 50} air`);
        }
        await new Promise(r => setTimeout(r, 1000));

        console.log(`[TestMaster] Creating test structures...`);
        await safeChat(master, `/fill ${x + 20} ${y} ${z + 20} ${x + 30} ${y + 15} ${z + 30} stone`); // Mountain
        await safeChat(master, `/fill ${x - 10} ${y - 1} ${z - 10} ${x - 5} ${y - 1} ${z + 10} water`); // River
        await safeChat(master, `/fill ${x + 5} ${y - 10} ${z + 5} ${x + 10} ${y - 5} ${z + 10} air`); // Cave

        await safeChat(master, `/setblock ${x + 15} ${y + 1} ${z - 15} oak_log`); // Trees
        await safeChat(master, `/setblock ${x + 15} ${y + 2} ${z - 15} oak_log`);
        await safeChat(master, `/setblock ${x + 15} ${y + 3} ${z - 15} oak_leaves`);
        await new Promise(r => setTimeout(r, 1000));

        // Smooth stone for equipment chest
        await safeChat(master, `/setblock ${x + 2} ${y + 1} ${z + 2} smooth_stone`);
        await safeChat(master, `/setblock ${x + 2} ${y + 2} ${z + 2} chest`);
        await new Promise(r => setTimeout(r, 1000));

        await safeChat(master, '/time set night');
        await safeChat(master, '/gamerule doDaylightCycle false');

        console.log(`[TestMaster] Spawning mobs...`);
        await safeChat(master, `/summon cow ${x + 5} ${y + 1} ${z - 5}`);
        await safeChat(master, `/summon zombie ${x + 10} ${y + 1} ${z + 10}`);

        await safeChat(master, `/setblock ${x - 20} ${y + 1} ${z - 20} stone`);
        await safeChat(master, `/setblock ${x - 22} ${y + 2} ${z - 20} stone`);
        await safeChat(master, `/setblock ${x - 24} ${y + 3} ${z - 20} ${MOD_BLOCKS[0] || 'glass'}`);
        await new Promise(r => setTimeout(r, 1000));

        await safeChat(master, `/tp TestMaster ${x + 25} ${y + 16} ${z + 25}`, 1000);

        console.log('[TestMaster] Environment setup complete.');
        startAIBots(x, y, z);
    });

    master.on('error', (err) => console.log(`[TestMaster Error] ${err.message}`));
}

function startAIBots(baseX, baseY, baseZ) {
    console.log('[BetaDebugger] Starting AgentManager and AI bots...');
    manager = new AgentManager();
    const bot1 = manager.startBot(aiBotId1, { host, port, mode: 'normal' });

    setTimeout(async () => {
        try {
            await runModItemsCheck(manager, aiBotId1, master, basePos);
            await runMovementAndCombatTests(manager, aiBotId1, master, basePos);
            await runCraftingAndGatheringTests(manager, aiBotId1, master, basePos);
            await runStorageTests(manager, aiBotId1, master, basePos);
            await runBedAndWaypointTests(manager, aiBotId1, master, basePos);
            await runEvasionAndPvPTests(manager, aiBotId1, aiBotId2, master, basePos);
        } catch(e) {
            console.error(`[BetaDebugger] Test Sequence Failed: ${e.message}`);
        }
    }, 15000);
}

async function runModItemsCheck(manager, botId, masterBot, startPos) {
    console.log(`[BetaDebugger] Starting Mod Items Check for ${botId}...`);
    for (const item of MOD_ITEMS) {
        await safeChat(masterBot, `/give ${botId} ${item} 1`);
    }
    await new Promise(r => setTimeout(r, 2000));
    await safeChat(masterBot, `- ${botId}, equip ${MOD_ITEMS[0]} in hand.`);
    await waitForBotChat(botId, /Equipped/i, 15000);
    await safeChat(masterBot, `- ${botId}, equip ${MOD_ITEMS[1] || 'shield'} in off-hand.`);
    await waitForBotChat(botId, /Equipped/i, 15000);
}

async function runMovementAndCombatTests(manager, botId, masterBot, startPos) {
    console.log(`[BetaDebugger] Starting Movement & Combat tests for ${botId}...`);
    await safeChat(masterBot, `- ${botId}, come to TestMaster.`);
    // Following a player implies we should see them arrive near the coords of TestMaster
    await new Promise(r => setTimeout(r, 20000));

    console.log(`[TestMaster] Knocking bot off mountain for MLG test...`);
    await safeChat(masterBot, `/give ${botId} water_bucket 1`);
    await new Promise(r => setTimeout(r, 2000));
    await safeChat(masterBot, `/tp ${botId} ~ ~2 ~1`);
    await new Promise(r => setTimeout(r, 1000));
    await safeChat(masterBot, `/execute as TestMaster run damage ${botId} 1 minecraft:generic`);
    await new Promise(r => setTimeout(r, 5000));

    await safeChat(masterBot, `-! ${botId}, status`);
    await waitForBotChat(botId, /Status:/i, 10000);

    console.log(`[TestMaster] Testing 1000-block Round Trip...`);
    await safeChat(masterBot, `- ${botId}, goto ${startPos.x + 1000} ${startPos.y} ${startPos.z}`);
    // A 1000 block journey takes a realistic amount of time. 3.5m is safer.
    await waitForBotChat(botId, /Reached destination/i, 210000);

    await safeChat(masterBot, `/give ${botId} elytra 1`);
    await safeChat(masterBot, `/give ${botId} firework_rocket 64`);
    await safeChat(masterBot, `- ${botId}, fly back to ${startPos.x} ${startPos.y} ${startPos.z} using your elytra.`);
    await waitForBotChat(botId, /Reached destination/i, 120000);
}

async function runCraftingAndGatheringTests(manager, botId, masterBot, startPos) {
    console.log(`[BetaDebugger] Starting Crafting & Gathering tests for ${botId}...`);
    await safeChat(masterBot, `/give ${botId} oak_log 10`);
    await safeChat(masterBot, `/give ${botId} cobblestone 10`);
    await safeChat(masterBot, `/give ${botId} raw_iron 10`);
    await safeChat(masterBot, `/give ${botId} coal 5`);
    await new Promise(r => setTimeout(r, 2000));

    await safeChat(masterBot, `- ${botId}, craft a stone_pickaxe.`);
    await waitForBotChat(botId, /Successfully crafted/i, 20000);

    await safeChat(masterBot, `- ${botId}, collect 30 stone.`);
    await waitForBotChat(botId, /Successfully collected/i, 120000);
}

async function runStorageTests(manager, botId, masterBot, startPos) {
    console.log(`[TestMaster] Testing Furnace, Shulker, Ender Chest, Blast Furnace...`);
    await safeChat(masterBot, `/give ${botId} furnace 1`);
    await safeChat(masterBot, `/give ${botId} blast_furnace 1`);
    await safeChat(masterBot, `/give ${botId} ender_chest 1`);
    await safeChat(masterBot, `/give ${botId} red_shulker_box 1`);
    await safeChat(masterBot, `/give ${botId} raw_iron 10`);
    await safeChat(masterBot, `/give ${botId} coal 10`);
    await new Promise(r => setTimeout(r, 2000));

    await safeChat(masterBot, `- ${botId}, place furnace.`);
    await waitForBotChat(botId, /Successfully placed/i, 15000);

    await safeChat(masterBot, `- ${botId}, smelt 5 raw_iron.`);
    await waitForBotChat(botId, /Successfully smelted/i, 60000);

    await safeChat(masterBot, `- ${botId}, place blast_furnace.`);
    await waitForBotChat(botId, /Successfully placed/i, 15000);

    await safeChat(masterBot, `- ${botId}, place ender_chest.`);
    await waitForBotChat(botId, /Successfully placed/i, 15000);

    await safeChat(masterBot, `- ${botId}, place red_shulker_box.`);
    await waitForBotChat(botId, /Successfully placed/i, 15000);
}

async function runBedAndWaypointTests(manager, botId, masterBot, startPos) {
    console.log(`[TestMaster] Testing Beds and Waypoints...`);

    await safeChat(masterBot, `/give ${botId} white_bed 1`);
    await new Promise(r => setTimeout(r, 1000));
    await safeChat(masterBot, `- ${botId}, place white_bed.`);
    await waitForBotChat(botId, /Successfully placed/i, 15000);

    await safeChat(masterBot, `/time set day`);
    await new Promise(r => setTimeout(r, 1000));
    await safeChat(masterBot, `- ${botId}, sleep.`);
    await waitForBotChat(botId, /cannot sleep during day|Respawn point set/i, 30000);

    await safeChat(masterBot, `/time set night`);
    await new Promise(r => setTimeout(r, 1000));
    await safeChat(masterBot, `- ${botId}, set_respawn.`);
    await waitForBotChat(botId, /Sleeping|Respawn point set/i, 30000);

    // Auto waypoint test - explore should trigger structure finding and auto waypoint
    await safeChat(masterBot, `- ${botId}, explore east for village.`);
    await waitForBotChat(botId, /Auto-registered waypoint|Explored|Found/i, 120000);
}


async function runEvasionAndPvPTests(manager, botId, botId2, masterBot, startPos) {
    console.log(`[BetaDebugger] Starting Evasion, PvP & Death tests for ${botId}...`);

    await safeChat(masterBot, `/fill ${startPos.x+40} ${startPos.y} ${startPos.z+40} ${startPos.x+50} ${startPos.y+5} ${startPos.z+50} glass hollow`); // Safe zone
    await safeChat(masterBot, `/tp ${botId} ${startPos.x+45} ${startPos.y+1} ${startPos.z+45}`);
    await new Promise(r => setTimeout(r, 2000));

    await safeChat(masterBot, `/summon blaze ${startPos.x+42} ${startPos.y+1} ${startPos.z+42}`);
    await safeChat(masterBot, `/summon skeleton ${startPos.x+48} ${startPos.y+1} ${startPos.z+48}`);
    await safeChat(masterBot, `/give ${botId} cooked_beef 10`);

    await safeChat(masterBot, `- ${botId}, kill blazes and collect 20 blaze_rod.`);
    await waitForBotChat(botId, /Successfully killed|Successfully collected/i, 120000);

    console.log(`[TestMaster] Starting PvP Test (${botId} vs ${botId2})...`);
    if (!manager.bots.has(botId2)) {
        manager.startBot(botId2, { host: process.env.MC_HOST || 'localhost', port: parseInt(process.env.MC_PORT || '25565', 10), mode: 'normal' });
        await new Promise(r => setTimeout(r, 15000));
    }

    await safeChat(masterBot, `/tp ${botId} ${startPos.x} ${startPos.y+1} ${startPos.z}`);
    await safeChat(masterBot, `/tp ${botId2} ${startPos.x+5} ${startPos.y+1} ${startPos.z+5}`);
    await safeChat(masterBot, `/give ${botId} diamond_sword 1`);
    await safeChat(masterBot, `/give ${botId2} iron_sword 1`);
    await safeChat(masterBot, `/give ${botId} iron_chestplate 1`);
    await safeChat(masterBot, `/give ${botId2} iron_chestplate 1`);
    await new Promise(r => setTimeout(r, 2000));

    await safeChat(masterBot, `- ${botId}, kill ${botId2}.`);
    await safeChat(masterBot, `- ${botId2}, kill ${botId}.`);
    await waitForBotChat(botId, /Successfully killed|I died/i, 60000);

    console.log(`[TestMaster] Testing Cross-Dimension Death Recovery for ${botId}...`);
    // Correct execute syntax for 1.20+
    await safeChat(masterBot, `/execute as ${botId} in minecraft:the_nether run tp @s 0 100 0`);
    await new Promise(r => setTimeout(r, 5000));
    await safeChat(masterBot, `/kill ${botId}`);

    await waitForBotChat(botId, /I died! Do you want me to recover/i, 30000);
    await safeChat(masterBot, `- System: yes`);

    await waitForBotChat(botId, /Recovered items|Successfully recovered/i, 240000);

    await safeChat(masterBot, `-! ${botId}, status`);
    await new Promise(r => setTimeout(r, 5000));

    console.log(`[BetaDebugger] All tests completed! Ending test sequence.`);
    process.exit(0);
}

startDebugger();
