// bot_actuator.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const ForgeHandshakeStateMachine = require('./forge_handshake_state_machine');
const DynamicRegistryInjector = require('./dynamic_registry_injector');
const EventDebouncer = require('./event_debouncer');
const nbt = require('prismarine-nbt');
const Vec3 = require('vec3');
const fs = require('fs');
const path = require('path');
const util = require('util');

// --- Overwrite Console Logging for External AI Monitor ---
const originalLog = console.log;
const originalError = console.error;
const LOG_FILE = path.join(process.cwd(), 'bot_system.log');

// Use non-blocking appendFile to avoid stalling the event loop (physics ticks).
// appendFileSync was blocking 1-10ms per call on WSL2, starving the pathfinder.
console.log = function(...args) {
    originalLog.apply(console, args);
    try {
        fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ` + util.format(...args) + '\n', () => {});
    } catch(e) {}
};

console.error = function(...args) {
    originalError.apply(console, args);
    try {
        fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ERROR: ` + util.format(...args) + '\n', () => {});
    } catch(e) {}
};

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
    // Suppress partial packet read exceptions by ignoring packets known to desync (like world_particles with custom Forge particle types).
    const bypass = ['declare_recipes', 'tags', 'advancements', 'declare_commands', 'unlock_recipes', 'craft_recipe_response', 'nbt_query_response', 'world_particles'];
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

// Track server position corrections for diagnostics + frozen-bot watchdog
let _serverPosCount = 0;
let _lastServerPosCheck = Date.now();
let _frozenPosKey = null;
let _frozenPeriods = 0;
bot._client.on('position', (packet) => {
    _serverPosCount++;
    const now = Date.now();
    if (now - _lastServerPosCheck > 10000) {
        if (_serverPosCount > 0) {
            console.log(`[ServerPos] ${_serverPosCount} corrections in 10s. Pos=(${packet.x?.toFixed(1)}, ${packet.y?.toFixed(1)}, ${packet.z?.toFixed(1)})`);
        }

        // Watchdog: if 100+ corrections AND same position for 2 consecutive 10s windows,
        // the bot is frozen (server and client physics disagree). Auto-recover via /tp.
        if (_serverPosCount > 100 && bot.entity && _botReady) {
            const pos = bot.entity.position;
            const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
            if (key === _frozenPosKey) {
                _frozenPeriods++;
                if (_frozenPeriods >= 2) {
                    console.log(`[Actuator] Frozen watchdog triggered at ${key} (${_frozenPeriods} periods). Teleporting to player...`);
                    bot.pathfinder.setGoal(null);
                    const nearestPlayer = Object.values(bot.players)
                        .filter(p => p.username !== bot.username && p.entity)
                        .sort((a, b) => pos.distanceTo(a.entity.position) - pos.distanceTo(b.entity.position))[0];
                    if (nearestPlayer) {
                        bot.chat(`/tp ${bot.username} ${nearestPlayer.username}`);
                    }
                    _frozenPeriods = 0;
                    _frozenPosKey = null;
                }
            } else {
                _frozenPosKey = key;
                _frozenPeriods = 1;
            }
        } else {
            _frozenPosKey = null;
            _frozenPeriods = 0;
        }

        _serverPosCount = 0;
        _lastServerPosCheck = now;
    }
});

// Guard: only initialize once (spawn fires on every respawn / dimension change)
let _spawnInitDone = false;
let _passiveDefenseInterval = null;
let _lastHealth = 20;

// IPC readiness gate — prevents processing actions before login/spawn complete.
// Actions arriving before bot is ready are buffered and flushed after spawn.
let _botReady = false;
let _pendingIpcActions = [];

bot.on('spawn', async () => {
    console.log(`[Actuator] Bot spawned. Initializing physics and pathfinder...`);
    try { await bot.waitForChunksToLoad(); } catch (e) {
        console.log(`[Actuator] Failed to wait for chunks: ${e.message}`);
    }

    bot.physics.enabled = true;
    // stepHeight: 0.6 is vanilla default. Setting to 1 can cause physics simulation
    // disagreements with the pathfinder's A* (which uses 0.6 internally).
    // Keep at vanilla default for consistent behavior.

    movements = new Movements(bot, mcData);
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.liquidCost = 3;
    movements.allow1by1towers = true;
    movements.maxDropDown = 4;

    // Use cheap vanilla blocks for scaffolding
    movements.scafoldingBlocks = [
        bot.registry.blocksByName.dirt?.id,
        bot.registry.blocksByName.cobblestone?.id,
        bot.registry.blocksByName.netherrack?.id,
        bot.registry.blocksByName.sand?.id
    ].filter(id => id !== undefined);

    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = 5000;
    // tickTimeout: ms of A* work per game tick.
    // 10 ms matches the original working configuration (commit 00fe7ea).
    bot.pathfinder.tickTimeout = 10;

    // Only register event handlers ONCE to prevent accumulation on respawn
    if (!_spawnInitDone) {
        _spawnInitDone = true;

        _lastHealth = bot.health || 20;
        bot.on('health', () => {
            if (bot.food < 15) {
                const food = getBestFoodItem();
                if (food && !isExecuting) {
                    bot.equip(food, 'hand').then(() => bot.consume().catch(() => {}));
                }
            }

            if (bot.health < _lastHealth && bot.health > 0) {
                const attacker = findNearestHostile(6);
                if (attacker) {
                    if (!isExecuting) equipBestWeapon().catch(() => {});
                    if (bot.entity.position.distanceTo(attacker.position) <= 3.5) {
                        bot.attack(attacker);
                    }
                }
                // Self-defense: attack the attacker but do NOT destroy the active
                // pathfinder goal.  The old code called bot.pathfinder.setGoal(null)
                // here, which permanently killed GoalFollow during a "come" action.
                // The bot would then sit idle forever because the come action only
                // checked the cancel token, not whether the goal still existed.
            }
            _lastHealth = bot.health;
        });

        // Passive defense: attack nearby hostiles.
        // Only attack when the bot is IDLE — during active pathfinding the
        // bot.attack() call changes the look direction, conflicting with the
        // pathfinder's bot.look() and causing erratic movement.
        _passiveDefenseInterval = setInterval(() => {
            if (!bot.entity || bot.health <= 0) return;
            if (isExecuting) return;  // Don't interfere with active pathfinding
            const hostile = findNearestHostile(3.5);
            if (!hostile) return;
            bot.attack(hostile);
            equipBestWeapon().catch(() => {});
        }, 600);

        debouncer = new EventDebouncer(bot, 500);

        // Movement override for modded terrain + sprint-jumping.
        //
        // Runs AFTER the pathfinder's monitorMovement (same physicsTick event) because
        // Node.js EventEmitter fires listeners in registration order — the pathfinder
        // plugin is loaded first (line 87), so its listener runs first.
        //
        // Problem: monitorMovement simulates physics forward (canStraightLine /
        // canSprintJump / canWalkJump) every tick.  On modded terrain the simulation
        // hits unknown block collision shapes and fails for ALL three checks.  The
        // else branch then sets forward=false, STOPPING the bot entirely.  This
        // caused 0.21 b/s measured speed.
        //
        // Fix: when the pathfinder has an active path but decided to stop (forward
        // is false), override to keep walking.  The pathfinder's own 3.5 s stuck
        // detector (resetPath('stuck')) handles truly blocked situations.
        //
        // Sprint-jumping: Minecraft sprint-jumping (~7.1 b/s) is ~27% faster than
        // sprinting alone (~5.6 b/s).  We add continuous jumping whenever the bot
        // is sprinting on flat ground.
        let _moveDiagTick = 0;
        let _lastDiagPos = null;
        bot.on('physicsTick', () => {
            _moveDiagTick++;

            // Water surface detection is now handled inside prismarine-physics
            // (simulatePlayer patch) so isInWater is correct BEFORE this handler fires.

            const fwd = bot.getControlState('forward');
            const spr = bot.getControlState('sprint');
            const jmp = bot.getControlState('jump');
            const moving = bot.pathfinder.isMoving();
            const mining = bot.pathfinder.isMining();
            const building = bot.pathfinder.isBuilding();
            const inWater = bot.entity.isInWater;
            const onGround = bot.entity.onGround;

            // Override: if pathfinder has a path but stopped us, keep walking
            if (moving && !fwd && !mining && !building) {
                bot.setControlState('forward', true);
                if (!inWater) bot.setControlState('sprint', true);
            }

            // On land, ensure sprint is enabled when path exists
            if (moving && fwd && !spr && !inWater && !mining && !building) {
                bot.setControlState('sprint', true);
            }

            // Sprint-jumping on flat ground (not in water)
            if (bot.getControlState('sprint') && bot.getControlState('forward') && onGround && !inWater) {
                bot.setControlState('jump', true);
            } else if (inWater) {
                // In water, actively clear jump — otherwise jump=true persists from a
                // prior land state, causing the bot to repeatedly swim upward ("bobbing")
                // while barely moving forward.  The pathfinder handles water swimming.
                bot.setControlState('jump', false);
            }

            // Diagnostic: log movement state every 100 ticks (~5 seconds)
            if (_moveDiagTick % 100 === 0 && bot.entity) {
                const pos = bot.entity.position;
                let speed = 0;
                if (_lastDiagPos) {
                    const dx = pos.x - _lastDiagPos.x;
                    const dz = pos.z - _lastDiagPos.z;
                    speed = Math.sqrt(dx * dx + dz * dz) / 5; // blocks per second over 5s
                }
                _lastDiagPos = pos.clone();
                // Block inspection for physics debugging
                const blockBelow = bot.blockAt(pos.offset(0, -1, 0));
                const blockAt = bot.blockAt(pos);
                const blockAbove = bot.blockAt(pos.offset(0, 1, 0));
                const belowInfo = blockBelow ? `${blockBelow.name}(id=${blockBelow.id},type=${blockBelow.type},bb=${blockBelow.boundingBox})` : 'null';
                const atInfo = blockAt ? `${blockAt.name}(id=${blockAt.id},type=${blockAt.type},bb=${blockAt.boundingBox})` : 'null';
                // Log vanilla water id for comparison
                const vanillaWaterId = bot.registry.blocksByName['water']?.id;
                console.log(`[MoveDiag] tick=${_moveDiagTick} pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}) speed=${speed.toFixed(2)}b/s fwd=${bot.getControlState('forward')} spr=${bot.getControlState('sprint')} jmp=${bot.getControlState('jump')} moving=${moving} mining=${mining} water=${inWater} ground=${onGround} goal=${!!bot.pathfinder.goal} below=${belowInfo} at=${atInfo} vanillaWater=${vanillaWaterId}`);
            }
        });
    }

    console.log('[Actuator] Pathfinder and Physics initialized.');

    // Wait for physics to settle before checking ground state
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Diagnostic: log raw block info around spawn point
    try {
        const sp = bot.entity.position.floored();
        for (let dy = -3; dy <= 2; dy++) {
            const b = bot.blockAt(sp.offset(0, dy, 0));
            console.log(`[SpawnDiag] Y=${sp.y + dy}: name=${b?.name} type=${b?.type} stateId=${b?.stateId} bb=${b?.boundingBox}`);
        }
    } catch (e) {}

    // ── Mark bot ready EARLY so test harness can start, then escape water in background ──
    bot.chat('Forge AI Player Ready.');
    _botReady = true;
    console.log('[Actuator] Bot ready. Flushing pending IPC actions:', _pendingIpcActions.length);
    for (const pending of _pendingIpcActions) {
        actionQueue.push(...pending);
    }
    _pendingIpcActions = [];
    if (actionQueue.length > 0) processActionQueue();

    // --- File Logging for External AI Monitor ---
    setInterval(() => {
        if (!bot.entity) return;
        try {
            const debugState = {
                timestamp: new Date().toISOString(),
                ready: _botReady,
                position: {
                    x: Math.round(bot.entity.position.x * 10) / 10,
                    y: Math.round(bot.entity.position.y * 10) / 10,
                    z: Math.round(bot.entity.position.z * 10) / 10
                },
                health: Math.round(bot.health),
                food: Math.round(bot.food),
                isExecuting,
                actionQueue: [...actionQueue]
            };
            fs.writeFile(path.join(process.cwd(), 'ai_debug.json'), JSON.stringify(debugState, null, 2), () => {});
            fs.appendFile(path.join(process.cwd(), 'ai_history.log'), JSON.stringify(debugState) + '\n', () => {});
        } catch (e) {
            console.error(`[Actuator] Failed to write ai_debug: ${e.message}`);
        }
    }, 5000);

    // Run water/ground escape asynchronously so it doesn't block IPC actions.
    // If an IPC action cancels the pathfinder, the escape may abort — that's fine.
    (async () => {
    // Skip water escape if IPC actions are already queued (e.g. find_land will handle positioning).
    if (isExecuting || actionQueue.length > 0) {
        console.log('[Actuator] IPC actions queued — skipping background water escape.');
        return;
    }
    // If bot is not on recognizable solid ground, try to find and tp to solid vanilla terrain.
    // This handles: (1) ocean spawn, (2) spawn above modded blocks that appear as air to our registry.
    if (!bot.entity.onGround) {
        // First: try to find any solid (boundingBox='block') non-water block within 128 blocks
        const solidBlocks = bot.findBlocks({
            matching: b => b && b.boundingBox === 'block' && b.name !== 'air' && !b.name.includes('water') && !b.name.includes('lava'),
            maxDistance: 128,
            count: 20
        });
        console.log(`[Actuator] Not on ground. Found ${solidBlocks.length} solid blocks within 128 blocks.`);

        if (solidBlocks.length > 0) {
            // Sort by distance and find one with air above (safe to stand on)
            solidBlocks.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
            let landTarget = null;
            // Prefer blocks with dry air (not water) above them — avoids underwater blocks
            for (const pos of solidBlocks) {
                const above1 = bot.blockAt(pos.offset(0, 1, 0));
                const above2 = bot.blockAt(pos.offset(0, 2, 0));
                const dryAbove1 = above1 && above1.boundingBox === 'empty' && above1.name !== 'water' && above1.name !== 'flowing_water';
                const dryAbove2 = above2 && above2.boundingBox === 'empty' && above2.name !== 'water' && above2.name !== 'flowing_water';
                if (dryAbove1 && dryAbove2) {
                    landTarget = pos;
                    break;
                }
            }
            // Fallback: standable block with any air above (but still exclude water above)
            if (!landTarget) {
                for (const pos of solidBlocks) {
                    const above1 = bot.blockAt(pos.offset(0, 1, 0));
                    const above2 = bot.blockAt(pos.offset(0, 2, 0));
                    const isWaterAbove = (above1?.name?.includes('water') || above2?.name?.includes('water'));
                    if (!isWaterAbove && above1 && above1.boundingBox === 'empty' && above2 && above2.boundingBox === 'empty') {
                        landTarget = pos;
                        break;
                    }
                }
            }
            if (landTarget) {
                console.log(`[Actuator] Solid ground at (${landTarget.x}, ${landTarget.y}, ${landTarget.z}) name=${bot.blockAt(landTarget)?.name}. Teleporting...`);
                bot.chat(`/tp ${bot.username} ${landTarget.x + 0.5} ${landTarget.y + 1} ${landTarget.z + 0.5}`);
                await new Promise(resolve => setTimeout(resolve, 3000));
                console.log(`[Actuator] Now at (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) onGround=${bot.entity.onGround}`);
            } else {
                console.log('[Actuator] No standable solid block found nearby. Will try /tp to player then proceed.');
            }
        }

        // If still not on ground and tp failed/no blocks found, try tp to player
        if (!bot.entity.onGround) {
            const nearbyPlayers = Object.values(bot.players).filter(p => p.username !== bot.username);
            if (nearbyPlayers.length > 0 && !solidBlocks.length) {
                // No solid blocks at all — likely in ocean. Try tp to player or ask for help
                bot.chat(`/tp ${bot.username} ${nearbyPlayers[0].username}`);
                await new Promise(resolve => setTimeout(resolve, 3000));
                console.log(`[Actuator] After /tp: pos=(${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) onGround=${bot.entity.onGround}`);
            }
        }
    }

    // Always try to tp to the nearest player to get to proper dry land.
    // The fallback copper-stairs position is water-logged; the player is on land.
    {
        const nearbyPlayers = Object.values(bot.players)
            .filter(p => p.username !== bot.username && p.entity);
        if (nearbyPlayers.length > 0) {
            const tpTarget = nearbyPlayers[0].username;
            const curPos = bot.entity.position;
            const playerEntity = nearbyPlayers[0].entity;
            // Only tp if player is significantly above us (on higher ground / land)
            // OR we are currently in a water-logged area
            const isInWaterArea = (bot.blockAt(curPos)?.name?.includes('water') ||
                bot.blockAt(curPos.offset(0, -1, 0))?.name?.includes('water') ||
                bot.blockAt(curPos.offset(1, 0, 0))?.name?.includes('water') ||
                bot.blockAt(curPos.offset(-1, 0, 0))?.name?.includes('water'));
            const playerHigher = playerEntity && (playerEntity.position.y > curPos.y + 5);
            if (isInWaterArea || playerHigher) {
                console.log(`[Actuator] Area is water-logged or player is higher. Teleporting to ${tpTarget}...`);
                bot.chat(`/tp ${bot.username} ${tpTarget}`);
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Wait a tick for chunks to load, then check if we're in water
                await new Promise(resolve => setTimeout(resolve, 500));
                // Emerge from water: tp up in steps until above water surface (max 30 blocks)
                for (let attempt = 0; attempt < 6; attempt++) {
                    const checkPos = bot.entity.position;
                    const atWater = bot.blockAt(checkPos)?.name?.includes('water');
                    const belowWater = bot.blockAt(checkPos.offset(0, -1, 0))?.name?.includes('water');
                    if (!atWater && !belowWater && bot.entity.onGround) break;
                    if (!atWater && !belowWater) break;  // Above water surface, let gravity handle it
                    console.log(`[Actuator] In water after player tp (attempt ${attempt+1}). Teleporting up 5 blocks...`);
                    const emergPos = bot.entity.position;
                    bot.chat(`/tp ${bot.username} ${emergPos.x.toFixed(2)} ${(emergPos.y + 5).toFixed(2)} ${emergPos.z.toFixed(2)}`);
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }

                console.log(`[Actuator] Final position: (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) onGround=${bot.entity.onGround}`);
            }
        }
    }

    // Legacy water escape (kept for backward compat — handles the case where bot is in actual water after above failed)
    if (!bot.entity.onGround) {
        const waterBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        const blockAtFeet = bot.blockAt(bot.entity.position);
        const inWaterZone = bot.entity.isInWater ||
            (blockAtFeet && (blockAtFeet.name === 'water' || blockAtFeet.name === 'flowing_water')) ||
            (waterBelow && (waterBelow.name === 'water' || waterBelow.name === 'flowing_water') &&
             !(blockAtFeet && blockAtFeet.boundingBox === 'block'));
        if (inWaterZone) {
            console.log('[Actuator] Spawned in water. Attempting /tp to nearest player...');
            // Try teleporting to nearest player via server command (requires op)
            const nearbyPlayers = Object.values(bot.players).filter(p => p.username !== bot.username);
            let tpTarget = nearbyPlayers.length > 0 ? nearbyPlayers[0].username : null;
            let escaped = false;

            if (tpTarget) {
                const prePos = bot.entity.position.clone();
                bot.chat(`/tp ${bot.username} ${tpTarget}`);
                console.log(`[Actuator] Sent /tp ${bot.username} ${tpTarget}. Waiting for teleport...`);
                // Wait up to 3 seconds for teleport to take effect
                await new Promise(resolve => setTimeout(resolve, 3000));
                const dist = bot.entity.position.distanceTo(prePos);
                if (dist > 5) {
                    console.log(`[Actuator] Teleport successful! Moved ${dist.toFixed(1)} blocks to (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
                    // Check if we're still in water at the new location — player may be standing near/above water
                    const stillInWater = bot.entity.isInWater ||
                        (bot.blockAt(bot.entity.position)?.name?.includes('water')) ||
                        (bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name?.includes('water'));
                    if (!stillInWater) {
                        escaped = true;
                    } else {
                        console.log(`[Actuator] Still in water near player. Scanning for dry ground...`);
                        // Find nearest solid non-water surface block within 32 blocks
                        const dryBlocks = bot.findBlocks({
                            matching: b => b && b.boundingBox === 'block' &&
                                !b.name.includes('water') && !b.name.includes('lava') &&
                                b.name !== 'air',
                            maxDistance: 32,
                            count: 50
                        });
                        // Need block with air above (so we can stand on it)
                        const standable = dryBlocks.find(pos => {
                            const above = bot.blockAt(pos.offset(0, 1, 0));
                            const above2 = bot.blockAt(pos.offset(0, 2, 0));
                            return above && above.boundingBox === 'empty' &&
                                   above2 && above2.boundingBox === 'empty';
                        });
                        if (standable) {
                            bot.chat(`/tp ${bot.username} ${standable.x + 0.5} ${standable.y + 1} ${standable.z + 0.5}`);
                            console.log(`[Actuator] Sending /tp to dry ground at (${standable.x}, ${standable.y + 1}, ${standable.z})...`);
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            // Log blocks at new position to confirm solid ground
                            try {
                                const np = bot.entity.position.floored();
                                for (let dy = -2; dy <= 1; dy++) {
                                    const b2 = bot.blockAt(np.offset(0, dy, 0));
                                    console.log(`[GroundDiag] Y=${np.y + dy}: name=${b2?.name} type=${b2?.type} bb=${b2?.boundingBox}`);
                                }
                            } catch (e) {}
                            console.log(`[Actuator] Now at (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) onGround=${bot.entity.onGround}`);
                            escaped = true;
                        } else {
                            console.log(`[Actuator] No dry ground found within 32 blocks of player. Trying pathfinder...`);
                            escaped = false;
                        }
                    }
                } else {
                    console.log(`[Actuator] /tp failed (moved ${dist.toFixed(1)} blocks). Bot may not have op. Trying pathfinder...`);
                }
            }

            if (!escaped) {
                // Pathfinder fallback: find shore blocks above seabed
                const surfaceY = Math.floor(bot.entity.position.y) - 2;
                let landTarget = null;
                for (let r = 16; r <= 128 && !landTarget; r += 16) {
                    const candidates = bot.findBlocks({
                        matching: b => b && b.boundingBox === 'block' &&
                            !b.name.includes('water') && !b.name.includes('lava') &&
                            b.name !== 'air',
                        maxDistance: r,
                        count: 50
                    });
                    const shoreCandidates = candidates.filter(c => c.y >= surfaceY);
                    if (shoreCandidates.length > 0) {
                        shoreCandidates.sort((a, b) => {
                            const da = (a.x - bot.entity.position.x) ** 2 + (a.z - bot.entity.position.z) ** 2;
                            const db = (b.x - bot.entity.position.x) ** 2 + (b.z - bot.entity.position.z) ** 2;
                            return da - db;
                        });
                        landTarget = shoreCandidates[0];
                    }
                }
                if (landTarget) {
                    console.log(`[Actuator] Land at (${landTarget.x}, ${landTarget.y}, ${landTarget.z}). Swimming...`);
                    bot.chat('Swimming to land...');
                    try {
                        await withTimeout(
                            bot.pathfinder.goto(new goals.GoalNear(landTarget.x, landTarget.y + 1, landTarget.z, 2)),
                            60000, 'water escape',
                            () => bot.pathfinder.setGoal(null)
                        );
                        console.log(`[Actuator] Reached land.`);
                        escaped = true;
                    } catch (e) {
                        console.log(`[Actuator] Pathfinder swim failed: ${e.message}`);
                    }
                }
            }

            if (!escaped && nearbyPlayers.length > 0) {
                // Ask player for help as last resort
                bot.chat(`I'm stuck in water and can't move. Please use: /tp ${bot.username} ${tpTarget || 'YourName'}`);
                console.log('[Actuator] Requested player teleport assistance.');
                // Wait up to 60s for someone to tp us
                const waitStart = Date.now();
                const prePos2 = bot.entity.position.clone();
                await new Promise(resolve => {
                    const check = setInterval(() => {
                        const dist = bot.entity.position.distanceTo(prePos2);
                        if (dist > 5 || bot.entity.onGround || Date.now() - waitStart > 60000) {
                            clearInterval(check);
                            if (dist > 5 || bot.entity.onGround) {
                                console.log(`[Actuator] Teleported by player! Now at (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
                            } else {
                                console.log('[Actuator] No teleport received. Bot remains in water.');
                            }
                            resolve();
                        }
                    }, 1000);
                });
            } else if (!escaped) {
                console.log('[Actuator] No players nearby. Bot stuck in open water.');
            }
        }
    }

    })().catch(e => console.log('[Actuator] Background water escape error:', e.message));
});

function getEnvironmentContext() {
    const nearbyBlocks = [];
    if (bot.entity) {
        // Beds (by name suffix — works once the registry is correctly mapped)
        const bedBlock = bot.findBlock({ matching: b => b && b.name.endsWith('_bed'), maxDistance: 16 });
        if (bedBlock) nearbyBlocks.push(bedBlock.name);
        // Other interactive blocks
        for (const name of ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel',
                             'anvil', 'enchanting_table', 'brewing_stand']) {
            const id = bot.registry.blocksByName[name]?.id;
            if (id !== undefined && bot.findBlock({ matching: id, maxDistance: 16 })) nearbyBlocks.push(name);
        }
    }
    const inventoryItems = bot.inventory ? bot.inventory.items() : [];
    return {
        position: bot.entity ? {
            x: Math.round(bot.entity.position.x),
            y: Math.round(bot.entity.position.y),
            z: Math.round(bot.entity.position.z)
        } : null,
        health: bot.health ? Math.round(bot.health) : null,
        food: bot.food ? Math.round(bot.food) : null,
        players_nearby: Object.keys(bot.players).filter(p => p !== bot.username && bot.players[p].entity),
        inventory: inventoryItems.map(item => ({ name: item.name, count: item.count })),
        has_pickaxe: inventoryItems.some(i => i.name.endsWith('_pickaxe')),
        has_axe: inventoryItems.some(i => i.name.endsWith('_axe')),
        has_sword: inventoryItems.some(i => i.name.endsWith('_sword')),
        nearby_blocks: nearbyBlocks
    };
}

// Eye (Perception)
// Forge 1.20.1 servers can deliver the same player chat message twice
// (once as player_chat, once as system_chat formatted by a plugin).
// Deduplicate within a 3-second window to avoid double-processing.
// Window is 3 s (not 1 s) because with a live server the HTTP round-trip
// means the two Forge duplicate packets can arrive >1 s apart.
const _chatDedup = new Map(); // 'username:message' → timestamp
bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    const key = `${username}:${message}`;
    const now = Date.now();
    if (now - (_chatDedup.get(key) ?? 0) < 3000) return;
    _chatDedup.set(key, now);
    // Prune stale entries so the map doesn't grow unbounded
    if (_chatDedup.size > 64) {
        const cutoff = now - 5000;
        for (const [k, t] of _chatDedup) if (t < cutoff) _chatDedup.delete(k);
    }
    process.send({ type: 'USER_CHAT', data: { username, message, environment: getEnvironmentContext() } });
});

// Body (Action)
let actionQueue = [];
let currentCancelToken = { cancelled: false };
let isExecuting = false;
let movements = null; // initialized in 'spawn'

// ─── Self-defense ─────────────────────────────────────────────────────────────
const HOSTILE_MOBS = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
    'enderman', 'endermite', 'silverfish', 'witch',
    'pillager', 'vindicator', 'evoker', 'vex', 'ravager',
    'phantom', 'drowned', 'husk', 'stray', 'zombie_villager',
    'blaze', 'ghast', 'slime', 'magma_cube',
    'wither_skeleton', 'wither', 'ender_dragon',
    'elder_guardian', 'guardian', 'shulker',
    'hoglin', 'zoglin', 'piglin_brute', 'zombified_piglin',
]);
function findNearestHostile(maxDist = 6) {
    if (!bot.entity) return null;
    let nearest = null, minDist = maxDist;
    for (const ent of Object.values(bot.entities)) {
        if (ent === bot.entity || !ent.isValid) continue;
        if (ent.type === 'player') continue;
        const name = (ent.name || '').toLowerCase();
        if (!HOSTILE_MOBS.has(name)) continue;
        const d = bot.entity.position.distanceTo(ent.position);
        if (d < minDist) { minDist = d; nearest = ent; }
    }
    return nearest;
}

// ─── Underground resource set ──────────────────────────────────────────────────
// These blocks generate underground. When a surface search fails, the system
// should tell the LLM to plan a dig-down step first.
const UNDERGROUND_BLOCKS = new Set([
    'stone', 'andesite', 'granite', 'diorite', 'deepslate', 'tuff', 'calcite',
    'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore',
    'lapis_ore', 'redstone_ore', 'copper_ore',
    'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_gold_ore',
    'deepslate_diamond_ore', 'deepslate_copper_ore', 'deepslate_lapis_ore',
    'deepslate_redstone_ore', 'deepslate_emerald_ore',
    'nether_quartz_ore', 'ancient_debris',
]);

// ─── Drop-to-source block mapping ─────────────────────────────────────────────
// Maps the requested item name to block(s) that yield it when mined.
// Without this, collect('cobblestone') searches for cobblestone blocks, which
// don't exist in natural terrain — you must mine stone to obtain cobblestone.
const DROP_TO_SOURCE = {
    cobblestone:    ['stone', 'cobblestone'],
    gravel:         ['gravel'],
    sand:           ['sand', 'red_sand'],
    flint:          ['gravel'],
    clay_ball:      ['clay'],
    snowball:       ['snow', 'snow_block'],
    coal:           ['coal_ore', 'deepslate_coal_ore'],
    raw_iron:       ['iron_ore', 'deepslate_iron_ore'],
    raw_gold:       ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
    diamond:        ['diamond_ore', 'deepslate_diamond_ore'],
    emerald:        ['emerald_ore', 'deepslate_emerald_ore'],
    lapis_lazuli:   ['lapis_ore', 'deepslate_lapis_ore'],
    redstone:       ['redstone_ore', 'deepslate_redstone_ore'],
    quartz:         ['nether_quartz_ore'],
    glowstone_dust: ['glowstone'],
};

function withTimeout(promise, ms, actionName, cancelFn) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            if (cancelFn) cancelFn();
            reject(new Error(`Timeout exceeded for action: ${actionName} (${ms}ms)`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

let debouncer = null; // initialized in 'spawn' — used for VeinMiner cascade detection

// ─── Module-level helpers ─────────────────────────────────────────────────────

const TOOL_SUFFIXES = ['_pickaxe', '_axe', '_shovel', '_hoe', '_sword', '_shears'];
async function equipBestTool(block) {
    // Only compare genuine tools — never equip decorative items (beds, lecterns, slabs) as a
    // "tool" just because they tie with bare-hands on the dig-time comparison.
    const toolItems = bot.inventory.items().filter(i => TOOL_SUFFIXES.some(s => i.name.endsWith(s)));
    // Baseline: bare-hand dig time; only equip a tool if it beats that.
    let bestTool = null, bestTime = block.digTime(null, false, false, false, [], bot.entity.effects);
    for (const tool of toolItems) {
        const t = block.digTime(tool.type, false, false, false, [], bot.entity.effects);
        if (t < bestTime) { bestTime = t; bestTool = tool; }
    }
    if (bestTool) {
        try { await bot.equip(bestTool, 'hand'); } catch (e) {
            console.log(`[Actuator] equipBestTool: ${e.message}`);
        }
    }
}

const WEAPON_PRIORITY = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'
];
async function equipBestWeapon() {
    for (const name of WEAPON_PRIORITY) {
        const w = bot.inventory.items().find(i => i.name === name);
        if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} return; }
    }
}

const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'golden', 'chainmail', 'leather'];
const ARMOR_PIECES = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' };
async function equipBestArmor() {
    for (const [slot, piece] of Object.entries(ARMOR_PIECES)) {
        for (const tier of ARMOR_TIERS) {
            const a = bot.inventory.items().find(i => i.name === `${tier}_${piece}`);
            if (a) { try { await bot.equip(a, slot); } catch (e) {} break; }
        }
    }
}

function getBestFoodItem() {
    const foods = mcData.foodsArray || [];
    const sorted = [...foods].sort((a, b) => b.foodPoints - a.foodPoints);
    for (const food of sorted) {
        const item = bot.inventory.items().find(i => i.name === food.name);
        if (item) return item;
    }
    return null;
}

// FIX: Improved inferToolCategory — also detects log-type blocks for axe suggestion
function inferToolCategory(block) {
    const name = block.name.toLowerCase();
    if (name.includes('log') || name.includes('_wood') || name.includes('plank') ||
        name.includes('fence') || name.includes('stem') || name.includes('hyphae') ||
        name.includes('chest') || name.includes('barrel') || name.includes('bookshelf') ||
        name.includes('crafting_table') || name.includes('jukebox') || name.includes('note_block') ||
        name.includes('ladder') || name.includes('door') || name.includes('trapdoor')) {
        return 'axe';
    }
    if (name.includes('dirt') || name.includes('gravel') || name.includes('sand') ||
        name.includes('grass') || name.includes('podzol') || name.includes('mycelium') ||
        name.includes('soul_sand') || name.includes('soul_soil') || name.includes('clay') ||
        name.includes('farmland') || name.includes('path') || name.includes('snow') ||
        name.includes('mud')) {
        return 'shovel';
    }
    // Stone, ore, concrete, bricks, etc.
    return 'pickaxe';
}

const PLANK_NAMES = new Set([
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks'
]);
const LOG_NAMES = new Set([
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'mangrove_log', 'cherry_log',
    'oak_wood', 'spruce_wood', 'birch_wood', 'jungle_wood', 'acacia_wood', 'dark_oak_wood'
]);

// FIX: ensureToolFor now also proactively crafts a speed-improving tool (axe for logs)
// even when harvestTools is null, preventing the 30s-per-log timeout without an axe.
async function ensureToolFor(block) {
    // Skip fluids, air, and any block the registry marks as non-diggable.
    // Calling this for water/lava would fall through to the default 'pickaxe'
    // branch and trigger an expensive (and fatal-OOM) auto-craft loop.
    if (!block) return;
    const bname = block.name || '';
    if (bname === 'air' || bname.includes('water') || bname.includes('lava') ||
        bname === 'void_air' || bname === 'cave_air') return;
    if (block.diggable === false) return;

    const toolCat = inferToolCategory(block);
    const hasRequirement = block.harvestTools && Object.keys(block.harvestTools).length > 0;

    // Check for a suitable tool (or a speed-improving tool for axe/shovel/pickaxe categories)
    const items = bot.inventory.items();
    const toolSuffix = `_${toolCat}`;
    const hasGoodTool = items.some(i =>
        (hasRequirement && block.harvestTools[i.type]) ||
        (!hasRequirement && i.name.endsWith(toolSuffix))
    );
    if (hasGoodTool) { await equipBestTool(block); return; }

    console.log(`[Actuator] No ${toolCat} found for ${block.name}. Auto-crafting wooden_${toolCat}...`);
    bot.chat(`Need a ${toolCat}. Crafting one...`);

    const countBy = (set) => bot.inventory.items().filter(i => set.has(i.name)).reduce((s, i) => s + i.count, 0);

    // ── Step 1: Gather logs if short on planks ──────────────────────────────
    const sticksHave = bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0);
    const planksNeeded = 3 + (sticksHave >= 2 ? 0 : 2);

    if (countBy(PLANK_NAMES) < planksNeeded) {
        const logsNeeded = Math.ceil((planksNeeded - countBy(PLANK_NAMES)) / 4);
        if (countBy(LOG_NAMES) < logsNeeded) {
            for (const logName of LOG_NAMES) {
                const logBlockId = bot.registry.blocksByName[logName]?.id;
                if (!logBlockId) continue;
                const logBlocks = bot.findBlocks({ matching: logBlockId, maxDistance: 32, count: logsNeeded });
                // Try wider radii if not found close by
                if (logBlocks.length === 0) logBlocks = bot.findBlocks({ matching: logBlockId, maxDistance: 64, count: logsNeeded });
                if (logBlocks.length === 0) logBlocks = bot.findBlocks({ matching: logBlockId, maxDistance: 128, count: logsNeeded });
                if (logBlocks.length === 0) continue;
                for (const logPos of logBlocks) {
                    if (countBy(LOG_NAMES) >= logsNeeded) break;
                    try {
                        await withTimeout(bot.collectBlock.collect(bot.blockAt(logPos)), 20000,
                            `auto-collect ${logName}`,
                            () => { bot.pathfinder.setGoal(null); if (bot.collectBlock.cancelTask) bot.collectBlock.cancelTask(); });
                    } catch (e) { console.log(`[Actuator] auto-tool: ${e.message}`); }
                }
                if (countBy(LOG_NAMES) >= logsNeeded) break;
            }
        }

        // ── Step 2: Craft planks ──────────────────────────────────────────────
        for (const log of bot.inventory.items().filter(i => LOG_NAMES.has(i.name))) {
            const plankName = log.name.replace(/_log$/, '_planks').replace(/_wood$/, '_planks');
            const plankId = bot.registry.itemsByName[plankName]?.id;
            if (plankId === undefined) continue;
            const recipe = bot.recipesFor(plankId, null, 1, false)[0];
            if (!recipe) continue;
            try { await bot.craft(recipe, Math.min(log.count, 2), null); break; }
            catch (e) { console.log(`[Actuator] auto-tool craft planks: ${e.message}`); }
        }
    }

    // ── Step 3: Craft sticks ─────────────────────────────────────────────────
    if (bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0) < 2) {
        const anyPlank = bot.inventory.items().find(i => PLANK_NAMES.has(i.name));
        if (anyPlank) {
            const stickId = bot.registry.itemsByName['stick']?.id;
            const r = stickId !== undefined ? bot.recipesFor(stickId, null, 1, false)[0] : null;
            if (r) try { await bot.craft(r, 1, null); } catch (e) { console.log(`[Actuator] auto-tool craft sticks: ${e.message}`); }
        }
    }

    // ── Step 4: Find or create crafting table, craft tool ───────────────────
    const ctBlockId = bot.registry.blocksByName['crafting_table']?.id;
    let craftingTable = ctBlockId !== undefined ? bot.findBlock({ matching: ctBlockId, maxDistance: 32 }) : null;

    if (!craftingTable) {
        const ctItemId = bot.registry.itemsByName['crafting_table']?.id ?? ctBlockId;
        if (ctItemId !== undefined && !bot.inventory.items().find(i => i.name === 'crafting_table')) {
            const ctR = bot.recipesFor(ctItemId, null, 1, false)[0];
            if (ctR) try { await bot.craft(ctR, 1, null); } catch (e) { console.log(`[Actuator] auto-tool craft table: ${e.message}`); }
        }
        const ctItem = bot.inventory.items().find(i => i.name === 'crafting_table');
        if (ctItem) {
            try {
                await bot.equip(ctItem, 'hand');
                const ref = bot.findBlock({ matching: b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava', maxDistance: 4 });
                if (ref) {
                    await bot.placeBlock(ref, new Vec3(0, 1, 0));
                    craftingTable = ctBlockId !== undefined ? bot.findBlock({ matching: ctBlockId, maxDistance: 8 }) : null;
                }
            } catch (e) { console.log(`[Actuator] auto-tool place table: ${e.message}`); }
        }
    }

    if (craftingTable) {
        const toolName = `wooden_${toolCat}`;
        const toolId = bot.registry.itemsByName[toolName]?.id;
        if (toolId !== undefined) {
            const toolR = bot.recipesFor(toolId, null, 1, true)[0];
            if (toolR) {
                try {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 1)), 15000, 'goto table (auto-tool)', () => bot.pathfinder.setGoal(null));
                    await bot.craft(toolR, 1, craftingTable);
                    bot.chat(`Crafted a ${toolName}!`);
                } catch (e) { console.log(`[Actuator] auto-tool craft ${toolName}: ${e.message}`); }
            }
        }
    } else {
        console.log('[Actuator] auto-tool: could not obtain a crafting table.');
    }
    await equipBestTool(block);
}

// Wither summon pattern. Skulls must be placed LAST to trigger the spawn.
// Layout (relative offsets from baseX/baseY/baseZ):
//   soul_sand:            (0,0,0) (1,0,0) (2,0,0)  ← horizontal bar
//                         (1,0,1)                   ← T-stem
//   wither_skeleton_skull:(0,1,0) (1,1,0) (2,1,0)  ← on top of bar
const PLACE_PATTERNS = {
    wither: [
        { name: 'soul_sand',              dx: 0, dy: 0, dz: 0 },
        { name: 'soul_sand',              dx: 1, dy: 0, dz: 0 },
        { name: 'soul_sand',              dx: 2, dy: 0, dz: 0 },
        { name: 'soul_sand',              dx: 1, dy: 0, dz: 1 },
        { name: 'wither_skeleton_skull',  dx: 0, dy: 1, dz: 0 },
        { name: 'wither_skeleton_skull',  dx: 1, dy: 1, dz: 0 },
        { name: 'wither_skeleton_skull',  dx: 2, dy: 1, dz: 0 },
    ]
};

// Potion ingredient map (ingredient → base bottle type required)
// base=water_bottle → awkward_potion (nether_wart step), then the ingredient
const POTION_RECIPES = {
    healing:         { ingredient: 'glistering_melon_slice', base: 'awkward_potion' },
    regeneration:    { ingredient: 'ghast_tear',             base: 'awkward_potion' },
    strength:        { ingredient: 'blaze_powder',           base: 'awkward_potion' },
    fire_resistance: { ingredient: 'magma_cream',            base: 'awkward_potion' },
    swiftness:       { ingredient: 'sugar',                  base: 'awkward_potion' },
    night_vision:    { ingredient: 'golden_carrot',          base: 'awkward_potion' },
    water_breathing: { ingredient: 'puffer_fish',            base: 'awkward_potion' },
    leaping:         { ingredient: 'rabbit_foot',            base: 'awkward_potion' },
    slow_falling:    { ingredient: 'phantom_membrane',       base: 'awkward_potion' },
    invisibility:    { ingredient: 'fermented_spider_eye',   base: 'potion_of_night_vision' },
    poison:          { ingredient: 'spider_eye',             base: 'awkward_potion' },
    weakness:        { ingredient: 'fermented_spider_eye',   base: 'water_bottle' },
    awkward:         { ingredient: 'nether_wart',            base: 'water_bottle' },
};

const FUEL_PRIORITY = ['coal', 'charcoal', 'coal_block', 'oak_log', 'spruce_log', 'birch_log', 'oak_planks', 'spruce_planks'];

const STRUCTURE_MARKERS = {
    nether_fortress: ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs'],
    ocean_monument:  ['prismarine', 'prismarine_bricks', 'dark_prismarine', 'sea_lantern'],
    stronghold:      ['end_portal_frame', 'mossy_stone_bricks', 'cracked_stone_bricks'],
    village:         ['hay_block', 'bell', 'villager_spawn_egg'],
    nether_portal:   ['nether_portal'],
};

// ─── Main Action Processor ────────────────────────────────────────────────────

async function processActionQueue() {
    if (isExecuting) return;
    isExecuting = true;

    while (actionQueue.length > 0) {
        const action = actionQueue.shift();
        const timeoutMs = action.timeout ? action.timeout * 1000 : 30000;

        try {
            if (!action || !action.action) continue;
            if (currentCancelToken.cancelled) break;

            if (action.target && typeof action.target === 'string') {
                action.target = action.target.replace(/^[^:]+:/, '');
            }

            // ── chat ──────────────────────────────────────────────────────────
            if (action.action === 'chat') {
                bot.chat(action.message);

            // ── dump_chunks ───────────────────────────────────────────────────
            } else if (action.action === 'dump_chunks') {
                bot.chat("Dumping loaded chunks to chunk_dump.json...");
                try {
                    const blocks = bot.findBlocks({
                        matching: (b) => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava' && b.name !== 'cave_air',
                        maxDistance: 32,
                        count: 50000
                    });

                    const blockDump = {};
                    for (const pos of blocks) {
                        const b = bot.blockAt(pos);
                        if (b) {
                            if (!blockDump[b.name]) blockDump[b.name] = [];
                            blockDump[b.name].push({ x: pos.x, y: pos.y, z: pos.z });
                        }
                    }
                    fs.writeFileSync(path.join(process.cwd(), 'chunk_dump.json'), JSON.stringify(blockDump, null, 2));

                    const message = `Dumped ${blocks.length} blocks to chunk_dump.json.`;
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: message, environment: getEnvironmentContext() } });
                } catch (e) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Dump failed: ${e.message}`, environment: getEnvironmentContext() } });
                }

            // ── status ────────────────────────────────────────────────────────
            } else if (action.action === 'status') {
                const env = getEnvironmentContext();
                const posStr = env.position ? `X:${env.position.x} Y:${env.position.y} Z:${env.position.z}` : 'Unknown';
                const healthStr = env.health !== null ? `${env.health}/20` : 'Unknown';
                const foodStr = env.food !== null ? `${env.food}/20` : 'Unknown';

                const groundState = bot.entity && bot.entity.onGround ? "on ground" : "mid-air";
                const blockBelow = bot.entity ? bot.blockAt(bot.entity.position.offset(0, -0.5, 0)) : null;
                const belowName = blockBelow ? blockBelow.name : 'Unknown';

                let message = `Status: ${healthStr} HP, ${foodStr} Food. Position: ${posStr} (${groundState}, above ${belowName}).`;
                if (env.players_nearby && env.players_nearby.length > 0) message += ` Nearby: ${env.players_nearby.join(', ')}.`;
                if (env.nearby_blocks && env.nearby_blocks.length > 0) message += ` Blocks: ${env.nearby_blocks.join(', ')}.`;

                bot.chat(message);
                process.send({ type: 'USER_CHAT', data: { username: "System", message: message, environment: env } });

            // ── come (continuous follow via GoalFollow) ─────────────────────
            // GoalFollow with dynamic=true lets the pathfinder continuously
            // recompute the path as the target moves.  This is what worked in
            // the original implementation (commit 00fe7ea).  Previous regressions
            // were caused by a supervision loop calling setGoal every 1 s (fixed
            // in BUGFIX-20260321-003) and tickTimeout=5 starving A* (fixed to 40
            // in BUGFIX-20260321-002).
            } else if (action.action === 'come') {
                const targetEntity = bot.players[action.target]?.entity;
                if (targetEntity) {
                    bot.chat(`Following ${action.target}!`);
                    bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, 2), true);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Now following ${action.target}.`, environment: getEnvironmentContext() } });

                    // Hold the queue slot until a 'stop' command cancels the token.
                    // Also monitor the goal — if something external clears it (e.g. the
                    // pathfinder's own stop(), or a bug), re-set it so following continues.
                    await new Promise(resolve => {
                        const check = setInterval(() => {
                            if (currentCancelToken.cancelled) {
                                clearInterval(check);
                                bot.pathfinder.setGoal(null);
                                resolve();
                                return;
                            }
                            // Re-validate: target still visible?
                            const t = bot.players[action.target]?.entity;
                            if (!t || !t.isValid) {
                                clearInterval(check);
                                bot.pathfinder.setGoal(null);
                                bot.chat(`Lost sight of ${action.target}.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Lost sight of ${action.target}.`, environment: getEnvironmentContext() } });
                                resolve();
                                return;
                            }
                            // If the goal was cleared externally, restore it
                            if (!bot.pathfinder.goal) {
                                bot.pathfinder.setGoal(new goals.GoalFollow(t, 2), true);
                            }
                        }, 1000);
                    });
                } else {
                    bot.chat(`I cannot see ${action.target}.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to find ${action.target}.`, environment: getEnvironmentContext() } });
                }

            // ── goto (waypoints, no distance cap) ────────────────────────────
            } else if (action.action === 'goto') {
                const WAYPOINT_STEP = 64;
                const destX = action.x, destZ = action.z;
                // Per-waypoint timeout: 60s gives sprint-jumping bot time for 64 blocks
                // even on complex terrain.  The outer action timeout is separate.
                const wpTimeout = Math.max(timeoutMs, 60000);

                if (action.y !== undefined) {
                    bot.chat(`Moving to X:${Math.round(destX)}, Y:${action.y}, Z:${Math.round(destZ)}.`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(destX, action.y, destZ, 2)), wpTimeout, 'goto XYZ', () => bot.pathfinder.setGoal(null));
                } else {
                    const dx0 = destX - bot.entity.position.x, dz0 = destZ - bot.entity.position.z;
                    const total = Math.sqrt(dx0 * dx0 + dz0 * dz0);
                    bot.chat(`Moving to X:${Math.round(destX)}, Z:${Math.round(destZ)}${total > WAYPOINT_STEP ? ` (~${Math.round(total)} blocks)` : ''}.`);

                    let lastRem = total, stuck = 0;
                    while (!currentCancelToken.cancelled) {
                        const cx = bot.entity.position.x, cz = bot.entity.position.z;
                        const rdx = destX - cx, rdz = destZ - cz;
                        const rem = Math.sqrt(rdx * rdx + rdz * rdz);
                        if (rem <= 4) break;  // close enough (was 2, too tight for XZ-only goals)
                        // Stuck detection: require at least 3 blocks progress per waypoint.
                        // The old threshold (1 block) triggered false positives on terrain
                        // where the bot made partial progress each attempt.
                        if (rem >= lastRem - 3) { if (++stuck >= 5) { bot.chat('Cannot make progress.'); break; } }
                        else stuck = 0;
                        lastRem = rem;

                        let wpX = destX, wpZ = destZ;
                        if (rem > WAYPOINT_STEP) {
                            const a = Math.atan2(rdz, rdx);
                            wpX = cx + WAYPOINT_STEP * Math.cos(a);
                            wpZ = cz + WAYPOINT_STEP * Math.sin(a);
                        }
                        try {
                            await withTimeout(bot.pathfinder.goto(new goals.GoalXZ(wpX, wpZ)), wpTimeout, 'goto XZ waypoint', () => bot.pathfinder.setGoal(null));
                        } catch (wpErr) {
                            // Per-waypoint failure is NOT fatal — the bot might still make
                            // progress.  Log it and let the stuck detector handle retries.
                            console.log(`[Actuator] goto waypoint error: ${wpErr.message}`);
                        }
                    }
                }
                if (!currentCancelToken.cancelled) {
                    const finalDist = Math.sqrt(
                        Math.pow(destX - bot.entity.position.x, 2) +
                        Math.pow((action.z || 0) - bot.entity.position.z, 2)
                    );
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Reached destination (${Math.round(finalDist)} blocks from target).`, environment: getEnvironmentContext() } });
                }

            // ── collect (3× candidate pool + progressive radius fallback) ─────
            } else if (action.action === 'collect') {
                // Resolve which blocks to search for.
                // Some items only exist as drops, not as placed blocks (e.g. cobblestone comes
                // from mining stone; flint comes from gravel). DROP_TO_SOURCE maps the requested
                // item to the actual block(s) to find with findBlocks().
                const sourceSNames = DROP_TO_SOURCE[action.target];
                const directBlockId = bot.registry.blocksByName[action.target]?.id;
                const searchIds = sourceSNames
                    ? sourceSNames.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
                    : (directBlockId !== undefined ? [directBlockId] : []);

                if (searchIds.length === 0) { bot.chat(`I don't know what ${action.target} is.`); }
                else {
                    const quantity = parseInt(action.quantity, 10) || 1;
                    let collected = 0;

                    // Count actual drops via inventory delta (accurate even for stone→cobblestone,
                    // gravel→flint, ore→raw_iron, etc. where the block ID ≠ drop item ID).
                    const countInInventory = () => bot.inventory.items()
                        .filter(i => i.name === action.target)
                        .reduce((s, i) => s + i.count, 0);

                    // Search passes: 32 → 64 → 128 blocks.
                    // Underground resources (stone, ores) rarely appear within 64 blocks
                    // of the surface spawn point, so the wider passes matter a lot for them.
                    const SEARCH_PASSES = [
                        { maxDistance: 32,  count: Math.min(quantity * 3, 64) },
                        { maxDistance: 64,  count: Math.min((quantity + 4) * 2, 64) },
                        { maxDistance: 128, count: Math.min(quantity + 8, 32) },
                    ];
                    const triedSet = new Set(); // keyed by 'x,z' — one attempt per XZ column
                    let toolCheckDone = false;

                    for (const pass of SEARCH_PASSES) {
                        if (collected >= quantity || currentCancelToken.cancelled) break;

                        const candidates = bot.findBlocks({
                            matching: b => b && searchIds.includes(b.type),
                            maxDistance: pass.maxDistance,
                            count: pass.count
                        });

                        // Group by XZ column and keep only the lowest Y per column.
                        // A tree trunk has logs at Y=63,64,65,66,67. Only the base (Y=63) is
                        // accessible from the ground. Trying all Y values wastes 15 s per level.
                        const xzLowest = new Map();
                        for (const pos of candidates) {
                            const key = `${pos.x},${pos.z}`;
                            if (!xzLowest.has(key) || pos.y < xzLowest.get(key).y) xzLowest.set(key, pos);
                        }
                        const fresh = [...xzLowest.values()].filter(p => !triedSet.has(`${p.x},${p.z}`));
                        fresh.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
                        if (fresh.length === 0) continue;

                        if (!toolCheckDone) {
                            toolCheckDone = true;
                            const firstBlock = bot.blockAt(fresh[0]);
                            if (firstBlock && searchIds.includes(firstBlock.type)) {
                                await ensureToolFor(firstBlock);
                                // If this block requires a specific tool, confirm we now have one.
                                // If ensureToolFor failed (e.g. no logs nearby to auto-craft),
                                // abort early rather than silently skipping every block.
                                if (firstBlock.harvestTools && Object.keys(firstBlock.harvestTools).length > 0) {
                                    const heldItem = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
                                    if (!heldItem || !firstBlock.harvestTools[heldItem.type]) {
                                        const toolCat = inferToolCategory(firstBlock);
                                        bot.chat(`I need a ${toolCat} to collect ${action.target}.`);
                                        // Give the LLM the full dependency chain so it can plan recovery.
                                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${toolCat} available to collect ${action.target}. Craft one: collect oak_log(2) → craft oak_planks → craft sticks → place crafting_table → craft wooden_${toolCat} → then retry collect ${action.target}.`, environment: getEnvironmentContext() } });
                                        break; // abort — outer pass loop
                                    }
                                }
                            }
                            bot.chat(`Collecting ${action.target}...`);
                        } else if (pass.maxDistance === 64) {
                            bot.chat(`Expanding search for more ${action.target}...`);
                        }

                        bot.chat(`I am mining ${action.quantity || 1} ${action.target}...`);

                        for (const blockPos of fresh) {
                            if (currentCancelToken.cancelled || collected >= quantity) break;
                            triedSet.add(`${blockPos.x},${blockPos.z}`);

                            try {
                                bot.pathfinder.setGoal(null);
                                try {
                                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, 2)), 15000, `goto ${action.target}`, () => bot.pathfinder.setGoal(null));
                                } catch (gotoErr) {
                                    throw new Error(`Failed to reach block: ${gotoErr.message}`);
                                }

                                const targetBlock = bot.blockAt(blockPos);
                                if (!targetBlock || !searchIds.includes(targetBlock.type)) continue;

                                await equipBestTool(targetBlock);
                                if (targetBlock.harvestTools && Object.keys(targetBlock.harvestTools).length > 0) {
                                    const heldItem = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
                                    if (!heldItem || !targetBlock.harvestTools[heldItem.type]) {
                                        throw new Error(`Requires a specific tool to harvest (held: ${heldItem ? heldItem.name : 'nothing'})`);
                                    }
                                }

                                const toolCat = inferToolCategory(targetBlock);
                                if (toolCat === 'pickaxe') {
                                    const heldForDig = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
                                    if (!heldForDig || !heldForDig.name.endsWith('_pickaxe')) {
                                        throw new Error(`Requires a pickaxe to harvest (held: ${heldForDig ? heldForDig.name : 'nothing'})`);
                                    }
                                }

                                // Dig directly — bot.dig() avoids collectBlock's internal re-pathfinding
                                // and item-pickup navigation, which together caused the 13 s dig timeout.
                                const countBefore = countInInventory();
                                await bot.lookAt(targetBlock.position.offset(0.5, 0.5, 0.5));
                                const heldForDig = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
                                const digTimeMs = targetBlock.digTime(heldForDig?.type ?? null, false, false, false, [], bot.entity.effects);
                                const maxDigMs = Math.max(8000, digTimeMs + 3000);

                                await withTimeout(bot.dig(targetBlock, true), maxDigMs, `dig ${action.target}`, () => {});
                                // VeinMiner may chain-break many more blocks. Wait for the cascade to settle
                                // (EventDebouncer fires cascading_wait_end after 500 ms of no new breaks).
                                if (debouncer && debouncer.isCascadingWait) {
                                    await new Promise(resolve => {
                                        const onEnd = () => resolve();
                                        debouncer.once('cascading_wait_end', onEnd);
                                        setTimeout(() => { debouncer.removeListener('cascading_wait_end', onEnd); resolve(); }, 5000);
                                    });
                                }
                                await new Promise(r => setTimeout(r, 600)); // pause for item drop + auto-collect

                                // Issue 4: count via inventory delta, not dig calls.
                                // This correctly handles stone→cobblestone, gravel→flint, etc.
                                const gained = countInInventory() - countBefore;
                                if (gained > 0) {
                                    collected += gained;
                                } else {
                                    // Item didn't auto-collect (fell into gap or entity lag).
                                    // Navigate to the drop position to pick it up.
                                    try {
                                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, 1)), 3000, 'pickup drop', () => bot.pathfinder.setGoal(null));
                                        collected += Math.max(0, countInInventory() - countBefore);
                                    } catch (e) { /* item unreachable — skip */ }
                                }
                            } catch (err) {
                                console.log(`[Actuator] Skipping block at ${blockPos}: ${err.message}`);
                            }
                        }
                    }

                    if (collected >= quantity) {
                        bot.chat(`Completed mining ${action.target}. Processing next step...`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully collected ${collected} ${action.target}.`, environment: getEnvironmentContext() } });
                    } else if (collected > 0) {
                        actionQueue = []; // Clear queue on partial success to re-evaluate
                        bot.chat(`Completed mining ${collected} ${action.target}. Processing next step...`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Partially collected ${collected}/${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                    } else {
                        actionQueue = []; // Clear queue on failure
                        bot.chat(`Could not find any ${action.target} nearby.`);
                        const undergroundHint = UNDERGROUND_BLOCKS.has(action.target)
                            ? ` This is an underground resource. You must mine down through stone layers to find it — issue a collect for "stone" first to dig a shaft, then retry.`
                            : '';
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Could not find ${action.target} within 128 blocks.${undergroundHint}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── give ──────────────────────────────────────────────────────────
            } else if (action.action === 'give') {
                const targetPlayer = bot.players[action.target]?.entity;
                const itemTargetName = action.item || action.target;
                const itemId = bot.registry.itemsByName[itemTargetName]?.id || bot.registry.blocksByName[itemTargetName]?.id;
                if (targetPlayer && itemId !== undefined) {
                    bot.chat(`Giving ${action.quantity || 1} ${itemTargetName} to ${action.target}...`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(targetPlayer.position.x, targetPlayer.position.y, targetPlayer.position.z, 2)), timeoutMs, 'goto player for give', () => bot.pathfinder.setGoal(null));
                    await bot.lookAt(targetPlayer.position.offset(0, 1.6, 0));
                    await bot.toss(itemId, null, action.quantity || 1);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully gave item to ${action.target}.`, environment: getEnvironmentContext() } });
                } else if (!targetPlayer) {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`I cannot see ${action.target}.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot see ${action.target}.`, environment: getEnvironmentContext() } });
                } else {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`I don't know what item ${itemTargetName} is.`);
                }

            // ── craft ─────────────────────────────────────────────────────────
            } else if (action.action === 'craft') {
                const itemId = bot.registry.itemsByName[action.target]?.id || bot.registry.blocksByName[action.target]?.id;
                if (itemId !== undefined) {
                    const quantity = parseInt(action.quantity, 10) || 1;
                    const recipe = bot.recipesFor(itemId, null, 1, true)[0];
                    if (recipe) {
                        bot.chat(`Crafting ${action.target}...`);
                        if (recipe.requiresTable) {
                            const ctId = bot.registry.blocksByName['crafting_table']?.id;
                            const ct = ctId !== undefined ? bot.findBlock({ matching: ctId, maxDistance: 32 }) : null;
                            if (ct) {
                                await withTimeout(bot.pathfinder.goto(new goals.GoalNear(ct.position.x, ct.position.y, ct.position.z, 1)), timeoutMs, 'goto crafting table', () => bot.pathfinder.setGoal(null));
                                try {
                                    await withTimeout(bot.craft(recipe, quantity, ct), timeoutMs, 'craft at table');
                                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully crafted ${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                                } catch (err) {
                                    bot.chat(`Failed to craft ${action.target}.`);
                                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to craft: ${err.message}`, environment: getEnvironmentContext() } });
                                }
                            } else {
                                actionQueue = []; // Clear queue on failure
                                bot.chat(`Need a crafting table but none nearby.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `No crafting table for ${action.target}.`, environment: getEnvironmentContext() } });
                            }
                        } else {
                            try {
                                await withTimeout(bot.craft(recipe, quantity, null), timeoutMs, 'craft in inventory');
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully crafted ${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                            } catch (err) {
                                actionQueue = []; // Clear queue on failure
                                bot.chat(`Failed to craft ${action.target}.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to craft: ${err.message}`, environment: getEnvironmentContext() } });
                            }
                        }
                    } else {
                        actionQueue = []; // Clear queue on failure
                        bot.chat(`Cannot craft ${action.target}: missing materials or recipe.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot craft ${action.target}: missing materials or recipe. Check inventory and gather dependencies.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`I don't know what ${action.target} is.`);
                }

            // ── place ─────────────────────────────────────────────────────────
            } else if (action.action === 'place') {
                const blockId = bot.registry.blocksByName[action.target]?.id || bot.registry.itemsByName[action.target]?.id;
                if (blockId !== undefined) {
                    const itemToPlace = bot.inventory.items().find(item => item.type === blockId);
                    if (itemToPlace) {
                        try {
                            await bot.equip(itemToPlace, 'hand');
                            const ref = bot.findBlock({ matching: b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava', maxDistance: 4 });
                            if (ref) {
                                await withTimeout(bot.placeBlock(ref, new Vec3(0, 1, 0)), timeoutMs, 'place block');
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully placed ${action.target}.`, environment: getEnvironmentContext() } });
                            } else {
                                actionQueue = []; // Clear queue on failure
                                bot.chat(`No surface nearby to place ${action.target}.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `No reference block found.`, environment: getEnvironmentContext() } });
                            }
                        } catch (err) {
                            actionQueue = []; // Clear queue on failure
                            bot.chat(`Failed to place ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Place failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    } else {
                        actionQueue = []; // Clear queue on failure
                        bot.chat(`No ${action.target} in inventory.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${action.target} in inventory.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`I don't know what ${action.target} is.`);
                }

            // ── equip ─────────────────────────────────────────────────────────
            } else if (action.action === 'equip') {
                // Strip namespace prefix — LLM sometimes sends "minecraft:wooden_pickaxe"
                const itemName = (action.target || '').replace(/^[a-z_]+:/, '');
                const itemId = bot.registry.itemsByName[itemName]?.id;
                if (itemId !== undefined) {
                    const item = bot.inventory.items().find(i => i.type === itemId);
                    if (item) {
                        try {
                            await bot.equip(item, 'hand');
                            bot.chat(`Equipped ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equipped ${action.target}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            actionQueue = []; // Clear queue on failure
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equip failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    } else {
                        actionQueue = []; // Clear queue on failure
                        bot.chat(`No ${action.target} to equip.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${action.target} in inventory.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`I don't know what ${action.target} is.`);
                }

            // ── equip_armor ───────────────────────────────────────────────────
            } else if (action.action === 'equip_armor') {
                await equipBestArmor();
                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equipped best available armor.`, environment: getEnvironmentContext() } });

            // ── eat / drink ───────────────────────────────────────────────────
            } else if (action.action === 'eat') {
                let foodItem = action.target
                    ? bot.inventory.items().find(i => i.name === action.target)
                    : getBestFoodItem();
                if (foodItem) {
                    await bot.equip(foodItem, 'hand');
                    try {
                        await withTimeout(bot.consume(), timeoutMs, 'eat');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Ate ${foodItem.name}.`, environment: getEnvironmentContext() } });
                    } catch (err) {
                        actionQueue = []; // Clear queue on failure
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to eat: ${err.message}`, environment: getEnvironmentContext() } });
                    }
                } else {
                    actionQueue = []; // Clear queue on failure
                    bot.chat('No food in inventory.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No food available.', environment: getEnvironmentContext() } });
                }

            // ── smelt ─────────────────────────────────────────────────────────
            } else if (action.action === 'smelt') {
                const inputName = action.target;
                const quantity = parseInt(action.quantity, 10) || 1;
                const inputItem = bot.inventory.items().find(i => i.name === inputName);

                if (!inputItem) {
                    bot.chat(`No ${inputName} to smelt.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${inputName} in inventory.`, environment: getEnvironmentContext() } });
                } else {
                    const furnaceBlockId = bot.registry.blocksByName['furnace']?.id;
                    let furnaceBlock = furnaceBlockId !== undefined
                        ? bot.findBlock({ matching: furnaceBlockId, maxDistance: 32 })
                        : null;

                    // Auto-craft and place furnace if not found
                    if (!furnaceBlock) {
                        const furnaceItemId = bot.registry.itemsByName['furnace']?.id ?? furnaceBlockId;
                        if (furnaceItemId !== undefined && !bot.inventory.items().find(i => i.name === 'furnace')) {
                            // Furnace needs 8 cobblestone at a crafting table
                            const cbR = bot.recipesFor(furnaceItemId, null, 1, true)[0];
                            const ctId = bot.registry.blocksByName['crafting_table']?.id;
                            const ct = ctId !== undefined ? bot.findBlock({ matching: ctId, maxDistance: 32 }) : null;
                            if (cbR && ct) {
                                await withTimeout(bot.pathfinder.goto(new goals.GoalNear(ct.position.x, ct.position.y, ct.position.z, 1)), timeoutMs, 'goto table for furnace', () => bot.pathfinder.setGoal(null));
                                try { await bot.craft(cbR, 1, ct); } catch (e) { console.log(`[Actuator] smelt craft furnace: ${e.message}`); }
                            }
                        }
                        const fi = bot.inventory.items().find(i => i.name === 'furnace');
                        if (fi) {
                            try {
                                await bot.equip(fi, 'hand');
                                const ref = bot.findBlock({ matching: b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava', maxDistance: 4 });
                                if (ref) {
                                    await bot.placeBlock(ref, new Vec3(0, 1, 0));
                                    furnaceBlock = furnaceBlockId !== undefined ? bot.findBlock({ matching: furnaceBlockId, maxDistance: 8 }) : null;
                                }
                            } catch (e) { console.log(`[Actuator] smelt place furnace: ${e.message}`); }
                        }
                    }

                    if (!furnaceBlock) {
                        bot.chat('Cannot find or create a furnace.');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No furnace available.', environment: getEnvironmentContext() } });
                    } else {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 1)), timeoutMs, 'goto furnace', () => bot.pathfinder.setGoal(null));
                        const furnace = await bot.openFurnace(furnaceBlock);
                        try {
                            if (!furnace.fuelItem()) {
                                for (const fname of FUEL_PRIORITY) {
                                    const fuel = bot.inventory.items().find(i => i.name === fname);
                                    if (fuel) { await furnace.putFuel(fuel.type, null, Math.min(fuel.count, quantity + 2)); break; }
                                }
                            }
                            const fresh = bot.inventory.items().find(i => i.name === inputName);
                            if (fresh) await furnace.putInput(fresh.type, null, Math.min(quantity, fresh.count));

                            bot.chat(`Smelting ${quantity} ${inputName}...`);
                            const waitMs = Math.min(quantity * 11000, timeoutMs - 5000);
                            const t0 = Date.now();
                            while (Date.now() - t0 < waitMs && !currentCancelToken.cancelled) {
                                const out = furnace.outputItem();
                                if (out && out.count >= Math.min(quantity, fresh ? fresh.count : quantity)) break;
                                await new Promise(r => setTimeout(r, 2000));
                            }
                            if (furnace.outputItem()) await furnace.takeOutput();
                            furnace.close();
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully smelted ${inputName}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            furnace.close();
                            actionQueue = []; // Clear queue on failure
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Smelt failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    }
                }

            // ── kill (combat loop with armor + weapon auto-equip) ─────────────
            } else if (action.action === 'kill') {
                const killQty = parseInt(action.quantity, 10) || 1;
                let killed = 0;
                const combatMs = action.timeout ? action.timeout * 1000 : 120000;
                const combatStart = Date.now();

                await equipBestArmor();
                await equipBestWeapon();
                bot.chat(`Engaging ${action.target}...`);

                while (killed < killQty && !currentCancelToken.cancelled && Date.now() - combatStart < combatMs) {
                    // Find nearest living target
                    let target = null, minDist = Infinity;
                    for (const ent of Object.values(bot.entities)) {
                        if (ent === bot.entity) continue;
                        const eName = (ent.name || ent.username || '').toLowerCase();
                        if (eName === action.target.toLowerCase()) {
                            const d = bot.entity.position.distanceTo(ent.position);
                            if (d < minDist) { minDist = d; target = ent; }
                        }
                    }
                    if (!target) {
                        if (killed === 0) {
                            bot.chat(`Cannot find ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `${action.target} not found.`, environment: getEnvironmentContext() } });
                        }
                        break;
                    }

                    // Combat sub-loop: attack until this entity dies
                    while (target.isValid && !currentCancelToken.cancelled) {
                        // Eat if health is critically low
                        if (bot.health < 6) {
                            const food = getBestFoodItem();
                            if (food) {
                                bot.pathfinder.setGoal(null);
                                await bot.equip(food, 'hand');
                                await bot.consume().catch(() => {});
                                await equipBestWeapon();
                            }
                        }
                        const dist = bot.entity.position.distanceTo(target.position);
                        if (dist > 3.5) {
                            bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
                        } else {
                            bot.pathfinder.setGoal(null);
                            bot.attack(target);
                        }
                        await new Promise(r => setTimeout(r, 600)); // ~attack cooldown
                    }

                    if (!target.isValid) {
                        killed++;
                        bot.pathfinder.setGoal(null);
                        // Short pause to let drops appear
                        await new Promise(r => setTimeout(r, 800));
                    }
                }

                if (killed >= killQty) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully killed ${killed} ${action.target}.`, environment: getEnvironmentContext() } });
                } else if (killed > 0) {
                    actionQueue = []; // Clear queue on partial success to re-evaluate
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Partially killed ${killed}/${killQty} ${action.target}.`, environment: getEnvironmentContext() } });
                } else {
                    actionQueue = []; // Clear queue on failure
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to kill ${action.target}.`, environment: getEnvironmentContext() } });
                }

            // ── sleep ─────────────────────────────────────────────────────────
            } else if (action.action === 'sleep') {
                const bedBlock = bot.findBlock({
                    matching: b => b && b.name.endsWith('_bed'),
                    maxDistance: 32
                });
                if (!bedBlock) {
                    bot.chat('No bed nearby.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No bed found within 32 blocks.', environment: getEnvironmentContext() } });
                } else {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2)), timeoutMs, 'goto bed', () => bot.pathfinder.setGoal(null));
                    try {
                        await withTimeout(bot.sleep(bedBlock), timeoutMs, 'sleep');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: 'Sleeping...', environment: getEnvironmentContext() } });
                    } catch (err) {
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot sleep: ${err.message}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── brew ──────────────────────────────────────────────────────────
            } else if (action.action === 'brew') {
                const potionKey = (action.potion || action.target || '').replace('potion_of_', '').replace('_potion', '');
                const recipe = POTION_RECIPES[potionKey];

                if (!recipe) {
                    bot.chat(`Unknown potion type: ${potionKey}`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Unknown potion: ${potionKey}`, environment: getEnvironmentContext() } });
                } else {
                    const standId = bot.registry.blocksByName['brewing_stand']?.id;
                    const stand = standId !== undefined ? bot.findBlock({ matching: standId, maxDistance: 32 }) : null;
                    if (!stand) {
                        bot.chat('No brewing stand nearby.');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No brewing stand found.', environment: getEnvironmentContext() } });
                    } else {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(stand.position.x, stand.position.y, stand.position.z, 1)), timeoutMs, 'goto brewing stand', () => bot.pathfinder.setGoal(null));
                        const brewingStand = await bot.openBrewingStand(stand);
                        try {
                            // Ensure blaze powder fuel
                            const blazePowder = bot.inventory.items().find(i => i.name === 'blaze_powder');
                            if (blazePowder) await brewingStand.putFuel(blazePowder.type, null, 1);

                            // Add ingredient
                            const ingredientId = bot.registry.itemsByName[recipe.ingredient]?.id;
                            const ingredient = ingredientId !== undefined ? bot.inventory.items().find(i => i.type === ingredientId) : null;
                            if (ingredient) await brewingStand.putIngredient(ingredient.type, null, 1);

                            bot.chat(`Brewing ${potionKey} potion...`);
                            // Wait for brewing to complete (~20 seconds)
                            await new Promise(r => setTimeout(r, Math.min(22000, timeoutMs - 3000)));
                            brewingStand.close();
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully brewed ${potionKey}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            brewingStand.close();
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Brew failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    }
                }

            // ── enchant ───────────────────────────────────────────────────────
            } else if (action.action === 'enchant') {
                const tableId = bot.registry.blocksByName['enchanting_table']?.id;
                const tableBlock = tableId !== undefined ? bot.findBlock({ matching: tableId, maxDistance: 32 }) : null;
                const targetItem = bot.inventory.items().find(i => i.name === action.target);

                if (!tableBlock) {
                    bot.chat('No enchanting table nearby.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No enchanting table found.', environment: getEnvironmentContext() } });
                } else if (!targetItem) {
                    bot.chat(`No ${action.target} to enchant.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `${action.target} not in inventory.`, environment: getEnvironmentContext() } });
                } else {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 1)), timeoutMs, 'goto enchanting table', () => bot.pathfinder.setGoal(null));
                    await bot.equip(targetItem, 'hand');
                    const table = await bot.openEnchantmentTable(tableBlock);
                    try {
                        await new Promise(r => setTimeout(r, 1000)); // wait for enchantments to load
                        const validOptions = (table.enchantments || []).filter(e => e && e.level > 0);
                        if (validOptions.length > 0) {
                            const choice = validOptions.length - 1; // highest tier
                            await withTimeout(table.enchant(choice), timeoutMs, 'enchant');
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully enchanted ${action.target}.`, environment: getEnvironmentContext() } });
                        } else {
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `No enchantments available (need lapis + experience levels).`, environment: getEnvironmentContext() } });
                        }
                        table.close();
                    } catch (err) {
                        table.close();
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Enchant failed: ${err.message}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── explore ───────────────────────────────────────────────────────
            } else if (action.action === 'explore') {
                const DIRS = { north: [0,-1], south: [0,1], east: [1,0], west: [-1,0], up: [0,0] };
                const [dx, dz] = DIRS[action.direction] || DIRS.east;
                const maxDist = parseInt(action.distance, 10) || 500;
                const STEP = 64;
                const markers = STRUCTURE_MARKERS[action.target] || [];
                let found = null, traveled = 0;

                bot.chat(`Exploring ${action.direction || 'east'}${action.target ? ` for ${action.target}` : ''}...`);

                while (traveled < maxDist && !currentCancelToken.cancelled && !found) {
                    const nx = bot.entity.position.x + dx * STEP;
                    const nz = bot.entity.position.z + dz * STEP;
                    try {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalXZ(nx, nz)), timeoutMs, 'explore step', () => bot.pathfinder.setGoal(null));
                    } catch (e) { /* terrain obstacle — keep moving */ }
                    traveled += STEP;

                    for (const markerName of markers) {
                        const markerId = bot.registry.blocksByName[markerName]?.id;
                        if (!markerId) continue;
                        const markerBlock = bot.findBlock({ matching: markerId, maxDistance: 48 });
                        if (markerBlock) { found = markerBlock; break; }
                    }
                }

                if (found) {
                    bot.chat(`Found ${action.target}!`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Found ${action.target} at ${found.position}.`, environment: getEnvironmentContext() } });
                } else if (!currentCancelToken.cancelled) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Explored ${traveled} blocks. ${action.target ? `${action.target} not found.` : 'Done.'}`, environment: getEnvironmentContext() } });
                }

            // ── navigate_portal ───────────────────────────────────────────────
            } else if (action.action === 'navigate_portal') {
                const portalName = action.target === 'end' ? 'end_portal' : 'nether_portal';
                const portalBlockId = bot.registry.blocksByName[portalName]?.id;
                const portalBlock = portalBlockId !== undefined
                    ? bot.findBlock({ matching: portalBlockId, maxDistance: 64 })
                    : null;

                if (!portalBlock) {
                    bot.chat(`No ${action.target || 'nether'} portal visible.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Portal not found. Explore to locate one.`, environment: getEnvironmentContext() } });
                } else {
                    bot.chat(`Entering ${action.target || 'nether'} portal...`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(portalBlock.position.x, portalBlock.position.y, portalBlock.position.z, 1)), timeoutMs, 'goto portal', () => bot.pathfinder.setGoal(null));
                    const currentDim = bot.game.dimension;
                    // Walk into the portal and wait for teleportation (up to 10s)
                    try {
                        await withTimeout(new Promise(resolve => {
                            const check = setInterval(() => {
                                if (bot.game.dimension !== currentDim) { clearInterval(check); resolve(); }
                            }, 500);
                        }), 10000, 'portal teleport');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Entered portal. Now in ${bot.game.dimension}.`, environment: getEnvironmentContext() } });
                    } catch (e) {
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Portal transit timeout: ${e.message}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── activate_end_portal ───────────────────────────────────────────
            } else if (action.action === 'activate_end_portal') {
                const frameId = bot.registry.blocksByName['end_portal_frame']?.id;
                if (!frameId) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'end_portal_frame not in registry.', environment: getEnvironmentContext() } });
                } else {
                    const frames = bot.findBlocks({ matching: frameId, maxDistance: 16, count: 12 });
                    let activated = 0;
                    for (const framePos of frames) {
                        if (currentCancelToken.cancelled) break;
                        const frameBlock = bot.blockAt(framePos);
                        if (!frameBlock) continue;
                        // Check if eye is already present
                        if (frameBlock.properties && frameBlock.properties.eye === 'true') continue;

                        const eyeId = bot.registry.itemsByName['ender_eye']?.id;
                        const eye = eyeId !== undefined ? bot.inventory.items().find(i => i.name === 'ender_eye') : null;
                        if (!eye) { bot.chat('Out of Eyes of Ender.'); break; }

                        await bot.equip(eye, 'hand');
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(framePos.x, framePos.y, framePos.z, 3)), 15000, 'goto portal frame', () => bot.pathfinder.setGoal(null));
                        try {
                            await withTimeout(bot.activateBlock(frameBlock), 5000, 'place eye in frame');
                            activated++;
                        } catch (e) { console.log(`[Actuator] activate_end_portal: ${e.message}`); }
                    }
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Activated ${activated}/${frames.length} portal frames.`, environment: getEnvironmentContext() } });
                }

            // ── place_pattern (includes Wither summon) ────────────────────────
            } else if (action.action === 'place_pattern') {
                const patternName = action.target || action.pattern;
                const pattern = PLACE_PATTERNS[patternName];

                if (!pattern) {
                    bot.chat(`Unknown pattern: ${patternName}`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Unknown pattern: ${patternName}`, environment: getEnvironmentContext() } });
                } else {
                    // Place the pattern in front of and at the feet of the bot
                    const baseX = Math.floor(bot.entity.position.x) - 1;
                    const baseY = Math.floor(bot.entity.position.y) - 1;
                    const baseZ = Math.floor(bot.entity.position.z) + 2;
                    let placed = 0, missing = 0;

                    for (const entry of pattern) {
                        if (currentCancelToken.cancelled) break;
                        const tx = baseX + entry.dx;
                        const ty = baseY + entry.dy;
                        const tz = baseZ + entry.dz;

                        const existing = bot.blockAt(new Vec3(tx, ty, tz));
                        if (existing && existing.name !== 'air') { placed++; continue; }

                        const blockItemId = bot.registry.itemsByName[entry.name]?.id ?? bot.registry.blocksByName[entry.name]?.id;
                        const blockItem = bot.inventory.items().find(i => i.name === entry.name || i.type === blockItemId);
                        if (!blockItem) { bot.chat(`Missing ${entry.name}.`); missing++; continue; }

                        await bot.equip(blockItem, 'hand');
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, 3)), 15000, `goto pattern pos`, () => bot.pathfinder.setGoal(null)).catch(() => {});

                        const below = bot.blockAt(new Vec3(tx, ty - 1, tz));
                        if (below && below.name !== 'air' && below.name !== 'water' && below.name !== 'lava') {
                            try {
                                await withTimeout(bot.placeBlock(below, new Vec3(0, 1, 0)), 5000, `place ${entry.name}`);
                                placed++;
                            } catch (e) { console.log(`[Actuator] place_pattern: ${e.message}`); missing++; }
                        } else {
                            console.log(`[Actuator] place_pattern: no solid surface below ${tx},${ty},${tz}`);
                            missing++;
                        }
                    }

                    const msg = missing === 0
                        ? `Pattern ${patternName} placed successfully.`
                        : `Pattern ${patternName}: placed ${placed}, failed ${missing}.`;
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: msg, environment: getEnvironmentContext() } });
                }

            // ── find_land ─────────────────────────────────────────────────────────
            // Strategy: TP to the known test player (Seia_Y / any online player) who
            // should already be standing on dry land / a prepared stone field.
            // This replaces the /fill approach which always failed in this all-ocean
            // world (water immediately refills any /fill stone).
            } else if (action.action === 'find_land') {
                // ── Step 1: Teleport to a player on dry land ──────────────────────
                const candidateNames = ['Seia_Y', 'Seia_y'];
                let tpTargetName = null;
                for (const name of candidateNames) {
                    if (bot.players[name]?.entity) { tpTargetName = name; break; }
                }
                if (!tpTargetName) {
                    const other = Object.values(bot.players)
                        .find(p => p.username !== bot.username && p.entity);
                    if (other) tpTargetName = other.username;
                }

                if (tpTargetName) {
                    console.log(`[find_land] Teleporting to player: ${tpTargetName}`);
                    bot.chat(`/tp ${bot.username} ${tpTargetName}`);
                    await new Promise(r => setTimeout(r, 3000));
                    try { await bot.waitForChunksToLoad(); } catch (e) {}
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    console.log('[find_land] No players online — using current position.');
                }

                // ── Step 2: Survival buffs + give oak_log for crafting test ───────
                bot.chat(`/effect give ${bot.username} minecraft:resistance 600 10 true`);
                bot.chat(`/effect give ${bot.username} minecraft:saturation 600 10 true`);
                await new Promise(r => setTimeout(r, 200));
                bot.chat(`/give ${bot.username} minecraft:oak_log 16`);

                // ── Step 3: Find the ground Y from actual position post-TP ─────────
                const pos0 = bot.entity.position;
                const gx = Math.round(pos0.x), gz = Math.round(pos0.z);
                // Scan downward from bot feet to find first solid non-water block
                let groundY = Math.floor(pos0.y) - 1;
                for (let dy = 0; dy >= -15; dy--) {
                    const b = bot.blockAt(new Vec3(gx, Math.floor(pos0.y) + dy, gz));
                    if (b && b.boundingBox === 'block' && !b.name.includes('water')) {
                        groundY = Math.floor(pos0.y) + dy;
                        break;
                    }
                }
                const logY = groundY + 1; // surface = 1 above detected ground

                // ── Step 4: Place 5 oak_log columns (separate XZ → collect dedup OK) ─
                const logOffsets = [[3,3],[4,3],[5,3],[6,3],[7,3]];
                for (const [dx, dz] of logOffsets) {
                    bot.chat(`/setblock ${gx + dx} ${logY} ${gz + dz} minecraft:oak_log`);
                    await new Promise(r => setTimeout(r, 150));
                }

                // ── Step 5: Summon test animals on the surface ────────────────────
                bot.chat(`/summon minecraft:cow ${gx + 8} ${logY} ${gz + 8}`);
                bot.chat(`/summon minecraft:pig ${gx + 6} ${logY} ${gz + 6}`);
                bot.chat(`/summon minecraft:chicken ${gx + 4} ${logY} ${gz + 4}`);
                await new Promise(r => setTimeout(r, 500));

                if (movements) bot.pathfinder.setMovements(movements);

                const landPos = bot.entity.position;
                const blockBelow = bot.blockAt(landPos.offset(0, -1, 0));
                const onLand = bot.entity.onGround &&
                    blockBelow && blockBelow.boundingBox === 'block' &&
                    !blockBelow.name.includes('water');
                const msg = onLand
                    ? `Platform ready. Bot at (${Math.round(landPos.x)},${Math.round(landPos.y)},${Math.round(landPos.z)}). Logs+animals placed.`
                    : `find_land: At (${Math.round(landPos.x)},${Math.round(landPos.y)},${Math.round(landPos.z)}) onGround=${bot.entity.onGround} below=${blockBelow?.name}.`;
                console.log(`[find_land] ${msg}`);
                process.send({ type: 'USER_CHAT', data: { username: "System", message: msg, environment: getEnvironmentContext() } });

            } // end action dispatch

        } catch (err) {
            console.error(`[Actuator] Action execution failed: ${err.message}`);
            if (bot._client.chat) bot.chat("An error occurred.");
            bot.pathfinder.setGoal(null);
            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Action failed: ${err.message}`, environment: getEnvironmentContext() } });
        }
    }

    isExecuting = false;
}

process.on('message', async (msg) => {
    if (msg.type === 'EXECUTE_ACTION') {
        let actions = msg.action;
        if (!Array.isArray(actions)) actions = [actions];

        // If bot hasn't finished login/spawn yet, buffer the action
        if (!_botReady) {
            console.log(`[Actuator] Bot not ready yet — buffering ${actions.length} action(s).`);
            _pendingIpcActions.push(actions);
            return;
        }

        // 1. Signal the running loop to stop
        const remaining = [...actionQueue];
        actionQueue = [];
        currentCancelToken.cancelled = true;
        bot.pathfinder.setGoal(null);
        if (bot.collectBlock && typeof bot.collectBlock.cancelTask === 'function') {
            bot.collectBlock.cancelTask();
        }

        // 2. Wait for the current processActionQueue() iteration to exit.
        //    Without this, assigning a new cancelToken and pushing to the queue
        //    races with the old loop, causing actions to re-execute or infinite loops.
        while (isExecuting) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // 3. Exit if the command was only "stop"
        if (actions.length === 1 && actions[0].action === 'stop') {
            return;
        }

        if (remaining.length > 0) {
            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Task interrupted. Remaining actions in queue: ${JSON.stringify(remaining)}`, environment: getEnvironmentContext() } });
        }

        // 4. Fresh token + queue for the new command
        currentCancelToken = { cancelled: false };
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
