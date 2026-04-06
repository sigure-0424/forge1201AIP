// bot_actuator.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const ForgeHandshakeStateMachine = require('./forge_handshake_state_machine');
const DynamicRegistryInjector = require('./dynamic_registry_injector');
const EventDebouncer = require('./event_debouncer');
const { config: runtimeConfig, patch: patchConfig, savePreset, listPresets } = require('./runtime_config');
const nbt = require('prismarine-nbt');
const Vec3 = require('vec3');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { resolveRequiredMaterials } = require('./material_resolver');
const { executeMacro } = require('./mod_interaction_executor');
const wikiRag = require('./wiki_rag');

// ── Visual Debug System instrumentation ─────────────────────────────────────
const debugTrace = require('./debug_trace_logger');
const debugWS    = require('./debug_ws_server');
const obsConnector = require('./obs_connector');
debugWS.start(3001);
obsConnector.connect().catch(() => {});

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
    // Suppress crash if caused by unknown mod protocol/registry errors
    if (err.message && (err.message.includes('unknown packet') || err.message.includes('unknown stateId') || err.message.includes('unknown block') || err.message.includes('unverified'))) {
        console.log(`[Actuator] Suppressed known mod compatibility exception: ${err.message}`);
        return;
    }
    console.error(`[Actuator] CRITICAL UNCAUGHT EXCEPTION: ${err.message}`);
    console.error(err.stack);
    process.send({ type: 'ERROR', category: 'BotError', details: err.message });
});

const botId = process.env.BOT_ID || 'Bot';
const botOptions = process.env.BOT_OPTIONS ? JSON.parse(process.env.BOT_OPTIONS) : {};

// Issue 5: Only issue cheat/server commands (/tp, /spreadplayers) in debug mode.
// In normal operation the bot must behave as a legit player.
const DEBUG = process.env.DEBUG === 'true';

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
    disableChatSigning: true,
    hideErrors: true
});

// Issue 6: Ignore errors from unverified mods to maintain robustness
bot.on('error', (err) => {
    if (err && err.message && (err.message.includes('unknown') || err.message.includes('unverified'))) {
        console.log(`[Actuator] Ignored unverified mod error: ${err.message}`);
        return;
    }
    console.error(`[Actuator Error] ${err.message || err}`);
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
        if (_serverPosCount > 0 && process.env.DEBUG === 'true') {
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
                    console.log(`[Actuator] Frozen watchdog triggered at ${key} (${_frozenPeriods} periods).`);
                    bot.pathfinder.setGoal(null);
                    if (DEBUG) {
                        // Use spreadplayers to escape phantom modded-block collision.
                        // TP to nearest player is wrong — they may be at the same stuck spot.
                        console.log('[Actuator] Frozen watchdog: using spreadplayers to escape phantom block.');
                        bot.chat(`/spreadplayers 0 0 5 500 false ${bot.username}`);
                    } else {
                        // Non-debug: jump to break free from physics lock
                        bot.setControlState('jump', true);
                        setTimeout(() => bot.setControlState('jump', false), 500);
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

// Boss combat mode flag — set true during dedicated boss fight routines.
// Suppresses the generic AoE-flee and passive-defense intervals to prevent
// random interference with carefully choreographed boss combat logic.
let _inBossCombat = false;

// Autonomous maintenance task flag — prevents the idle 30s scanner from
// double-queuing maintenance tasks.
let _autonomousTaskBusy = false;

// Issue 3: Reliable death-position tracking.
// bot.entity.position inside the 'death' event is unreliable (may already be respawn pos).
// Instead, track the last known safe position on a 2s interval.
let _lastSafePos = null;
let _lastSafeDim = 'overworld';
const DEATHS_FILE = path.join(process.cwd(), 'data', `deaths_${botId}.json`);

// Direction from land base toward trees, recorded during find_land step 4b.
// Written to the debug file so test_live.js can use it for goto test direction.
let _treeDir = null; // { dx, dz } unit vector, or null if unknown

// IPC readiness gate — prevents processing actions before login/spawn complete.
// Actions arriving before bot is ready are buffered and flushed after spawn.
let _botReady = false;
let _pendingIpcActions = [];
// Latest external player snapshots relayed from /api/entity_updates via parent IPC.
// Used as a fallback when target entities are temporarily out of render range.
const _externalPlayerPositions = new Map(); // playerName -> { x, y, z, dimension, updatedAt }
let _lastBridgeFailureReason = null;

function _normPlayerName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '');
}

function getTrackedPlayerSnapshot(name) {
    if (!name) return null;
    const direct = _externalPlayerPositions.get(name);
    if (direct) return direct;
    const needle = _normPlayerName(name);
    for (const [playerName, snapshot] of _externalPlayerPositions.entries()) {
        const cand = _normPlayerName(playerName);
        if (cand === needle) return snapshot;
        if (cand.includes(needle) || needle.includes(cand)) return snapshot;
    }
    return null;
}

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
    // Sprinting sends rapid movement packets that can trigger Forge server anti-cheat (EPIPE kick).
    // Walk speed (~4.3 b/s) is sufficient on flat terrain and safer on all terrain types.
    movements.allowSprinting = false;
    movements.liquidCost = 3;
    movements.allow1by1towers = true;
    // Reduce accidental hole drops on flat terrain.
    movements.maxDropDown = 1;
    if ('allowParkour' in movements) movements.allowParkour = false;

    // Use cheap vanilla blocks for scaffolding
    movements.scafoldingBlocks = [
        bot.registry.blocksByName.dirt?.id,
        bot.registry.blocksByName.cobblestone?.id,
        bot.registry.blocksByName.netherrack?.id,
        bot.registry.blocksByName.sand?.id
    ].filter(id => id !== undefined);

    // Goal 1: Restrict breaking to terrain/natural blocks only to avoid destroying structures.
    // If a block doesn't match these natural types, add it to blocksCantBreak.
    if (bot.registry.blocksArray) {
        for (const block of bot.registry.blocksArray) {
            const name = block.name.toLowerCase();
            const isGrave = name.includes('grave') || name.includes('tomb') || name.includes('crave') || name.includes('obituary') || name.includes('death');

            if (block.isUnknownModBlock && !isGrave) {
                movements.blocksCantBreak.add(block.id);
            } else {
                const isNaturalTerrain = isGrave || name.includes('dirt') || name.includes('stone') ||
                                         name.includes('grass') || name.includes('sand') ||
                                         name.includes('gravel') || name.includes('clay') ||
                                         name.includes('netherrack') || name.includes('end_stone') ||
                                         name.includes('ore') || name.includes('log') ||
                                         name.includes('leaves') || name.includes('wood') ||
                                         name.includes('snow') || name.includes('ice') ||
                                         name.includes('obsidian');

                // Allow some utility blocks like crops/plants to be broken if needed,
                // but strictly block obvious manufactured blocks (planks, glass, bricks, etc.)
                const isManufactured = name.includes('planks') || name.includes('glass') ||
                                       name.includes('brick') || name.includes('slab') ||
                                       name.includes('stair') || name.includes('wall') ||
                                       name.includes('fence') || name.includes('door') ||
                                       name.includes('bed') || name.includes('chest') ||
                                       name.includes('table') || name.includes('furnace') ||
                                       name.includes('concrete') || name.includes('terracotta') ||
                                       name.includes('wool') || name.includes('carpet');

                if (isManufactured || !isNaturalTerrain) {
                    movements.blocksCantBreak.add(block.id);
                }
            }
        }
    }

    // Goal 1 & 2: Avoid magma block damage & only break specific blocks (e.g. non-construct blocks)
    // Add magma_block to blocksCantBreak and set its pathfinding cost higher if it was toAvoid
    const magmaBlockId = bot.registry.blocksByName['magma_block']?.id;
    if (magmaBlockId !== undefined) {
        movements.blocksCantBreak.add(magmaBlockId);
        // Force A* to avoid magma blocks if possible (treat as lava)
        movements.blocksToAvoid.add(magmaBlockId);
    }

    bot.pathfinder.setMovements(movements);
    // Keep path planning responsive around gaps/void edges.
    bot.pathfinder.thinkTimeout = 5000;
    bot.pathfinder.tickTimeout = 5;

    // VDS-001: Wrap pathfinder.goto to broadcast path goal to WebUI map overlay.
    if (!bot.pathfinder._vds_wrapped) {
        bot.pathfinder._vds_wrapped = true;
        const _origGoto = bot.pathfinder.goto.bind(bot.pathfinder);
        bot.pathfinder.goto = function(goal, ...rest) {
            try {
                const pos = bot.entity?.position;
                const gx = goal?.x ?? goal?.centerX;
                const gy = goal?.y ?? goal?.centerY;
                const gz = goal?.z ?? goal?.centerZ;
                const points = [];
                if (pos) points.push([Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)]);
                if (gx != null) points.push([Math.floor(gx), Math.floor(gy ?? 0), Math.floor(gz ?? 0)]);
                debugWS.broadcast('path', { botId, points });
            } catch (_) {}
            return _origGoto(goal, ...rest);
        };
    }

    // Only register event handlers ONCE to prevent accumulation on respawn
    if (!_spawnInitDone) {
        _spawnInitDone = true;

        _lastHealth = bot.health || 20;
        bot.on('health', () => {
            if (bot.food < 15) {
                const food = getBestFoodItem();
                if (food && !bot.pathfinder.isMining()) {
                    bot.equip(food, 'hand').then(() => bot.consume().catch(() => {})).catch(() => {});
                }
            }

            if (bot.health < _lastHealth && bot.health > 0) {
                // Mark any nearby neutral mobs as aggro'd when the bot takes damage.
                if (bot.entity) {
                    for (const ent of Object.values(bot.entities)) {
                        if (ent === bot.entity || !ent.isValid) continue;
                        const eName = (ent.name || '').toLowerCase();
                        if (NEUTRAL_MOBS.has(eName) && bot.entity.position.distanceTo(ent.position) <= 8) {
                            _aggroedNeutrals.add(ent.id);
                        }
                    }
                }
                const attacker = findNearestHostile(6);
                if (attacker) {
                    // Include Piglins in retaliation logic
                    const piglinNames = ['piglin', 'piglin_brute'];
                    if (piglinNames.includes(attacker?.name?.toLowerCase())) {
                        console.log('[Actuator] Retaliating against Piglin attacker.');
                        if (!bot.pathfinder.isMoving() && !bot.pathfinder.isMining()) equipBestWeapon().catch(() => {});
                        bot.attack(attacker);
                    } else {
                        if (!bot.pathfinder.isMoving() && !bot.pathfinder.isMining()) equipBestWeapon().catch(() => {});
                        if (bot.entity.position.distanceTo(attacker.position) <= 3.5) {
                            bot.attack(attacker);
                        }
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

        // ── Autonomic Hunger Management ──────────────────────────────────────
        // Independent interval that eats whenever food drops below 18/20.
        // Runs regardless of current action state so the bot never starves mid-task.
        // Uses a busy flag to prevent overlapping equip/consume calls.
        let _autonomicEatBusy = false;
        setInterval(async () => {
            if (!bot.entity || bot.health <= 0 || _autonomicEatBusy) return;
            if (bot.food >= 18) return; // only eat when meaningfully hungry
            if (!bot._client?.socket?.writable) return;
            const food = getBestFoodItem();
            if (!food) return;
            _autonomicEatBusy = true;
            const prevItem = bot.heldItem;
            try {
                await bot.equip(food, 'hand').catch(() => {});
                await bot.consume().catch(() => {});
                // Restore previously held item (weapon/tool) after eating
                if (prevItem && prevItem.name !== food.name) {
                    await bot.equip(prevItem, 'hand').catch(() => {});
                }
            } catch(e) {}
            _autonomicEatBusy = false;
        }, 8000);

        // Issue 3: GraveStone Mod Recovery — use _lastSafePos (tracked every 5s on ground)
        // instead of bot.entity.position which may already be the respawn point when 'death' fires.
        bot.on('death', () => {
            const deathPos = _lastSafePos || (bot.entity?.position?.clone());
            const deathDim = _lastSafeDim || bot.game?.dimension || 'overworld';
            if (deathPos && deathPos.y > -60) {
                bot.chat('[System Error] I died! Do you want me to recover my items? (yes/no)');
                console.log(`[Actuator] Bot died. Last safe pos: ${JSON.stringify({x:Math.round(deathPos.x),y:Math.round(deathPos.y),z:Math.round(deathPos.z)}) } dim:${deathDim}`);
                // Issue 2: Send IPC so agent_manager sets awaitingRecoveryChoice.
                // bot.chat() only sends to server; the bot's own messages are filtered in
                // the bot.on('chat') handler so they never reach agent_manager via the chat path.
                process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'I died! Do you want me to recover my items?', environment: getEnvironmentContext() } });

                // Persist to file so recovery works even after process restart. Issue 1 & 2: Use sequential array.
                const deathRecord = { x: deathPos.x, y: deathPos.y, z: deathPos.z, dimension: deathDim, time: new Date().toISOString(), status: 'pending' };
                let deaths = [];
                try {
                    if (fs.existsSync(DEATHS_FILE)) {
                        deaths = JSON.parse(fs.readFileSync(DEATHS_FILE, 'utf8'));
                    }
                } catch (e) {}
                deaths.push(deathRecord);
                fs.writeFile(DEATHS_FILE, JSON.stringify(deaths, null, 2), () => {});
            }
        });

        // Anti-AFK: rotate the bot's head slightly every ~25 seconds when not moving.
        // Fires during idle AND during wait/idle-combat (isExecuting may be true there),
        // as long as the pathfinder isn't actively steering the bot.
        setInterval(() => {
            if (bot.pathfinder.isMoving()) return; // Don't interfere while pathfinder steers
            if (bot._client?.socket?.writable !== true) return;
            try {
                // Issue 1: Prevent Enderman eye contact — avoid looking at non-aggro'd Endermen.
                // Check if any non-aggro'd Enderman is within 64 blocks; if the random yaw would
                // face their eye level, choose a different pitch that looks below their eyes.
                const nearbyEnderman = Object.values(bot.entities).find(e => {
                    const n = (e.name || '').toLowerCase();
                    return n === 'enderman' && !_aggroedNeutrals.has(e.id) &&
                           bot.entity && bot.entity.position.distanceTo(e.position) <= 64;
                });
                let yaw = (Math.random() * Math.PI * 2) - Math.PI;
                let pitch = (Math.random() * 0.5) - 0.25;
                if (nearbyEnderman && bot.entity) {
                    // Look below enderman's feet to avoid triggering aggro
                    const dx = nearbyEnderman.position.x - bot.entity.position.x;
                    const dz = nearbyEnderman.position.z - bot.entity.position.z;
                    const endermanYaw = Math.atan2(-dx, -dz);
                    // If our random yaw is within 30° of the Enderman, adjust pitch downward
                    const yawDiff = Math.abs(((yaw - endermanYaw) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
                    if (yawDiff < 0.52) { // ~30 degrees
                        pitch = 0.6; // look downward, below Enderman eye level
                    }
                }
                bot.look(yaw, pitch, false).catch(() => {});
            } catch (_) {}
        }, 25000);

        // Issues 3 & 5: Passive defense — attack hostiles within 16 blocks.
        // Close-range (≤3.5 blocks) enemies are attacked immediately even during
        // pathfinding, acting as a melee "interrupt" without stopping movement.
        // Further enemies are handled by the idle combat loop (runWaitLoop).
        _passiveDefenseInterval = setInterval(() => {
            if (_inBossCombat) return; // Boss combat handles its own defense
            if (!bot.entity || bot.health <= 0) return;
            const hostile = findNearestHostile(16); // Issue 5: 16-block radius
            if (!hostile) {
                if (!bot.pathfinder.isMoving() && !bot.pathfinder.isMining()) {
                    bot.deactivateItem();
                }
                return;
            }
            const distToHostile = bot.entity.position.distanceTo(hostile.position);
            if (distToHostile <= 3.5) {
                // Issue 3: attack in melee range even during movement (interrupt)
                bot.deactivateItem();
                bot.attack(hostile);
                equipBestWeapon().catch(() => {});
                const offHand = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
                if (offHand && offHand.name === 'shield') {
                    bot.activateItem(true);
                }
            }
            // Enemies 3.5–16 blocks away: let runWaitLoop handle them during idle
        }, 600);

        // Issue 4: AoE / continuous-damage evasion.
        // Detects two hazard types and triggers emergency flee:
        //   (a) Bot is taking continuous damage while stationary (drowning, fire, Ender Dragon breath).
        //   (b) area_effect_cloud (Ender Dragon breath cloud, lingering potions) is within 5 blocks.
        let _aoeLastHealth  = bot.health || 20;
        let _aoeLastPos     = bot.entity?.position?.clone() || null;
        let _aoeEvading     = false;
        setInterval(() => {
            if (_inBossCombat) return; // Dragon combat handles AoE avoidance internally
            if (!bot.entity || bot.health <= 0 || _aoeEvading) return;
            if (!bot._client?.socket?.writable) return;

            // Check for nearby area_effect_cloud (dragon breath, lingering potions)
            const hazardCloud = Object.values(bot.entities).find(e => {
                const n = (e.name || e.displayName || '').toLowerCase();
                return (n.includes('area_effect_cloud') || n.includes('dragon_breath')) &&
                       bot.entity.position.distanceTo(e.position) < 5;
            });

            // Check for stationary damage (current health < previous health, position barely changed)
            const curPos = bot.entity.position;
            const moved = _aoeLastPos ? curPos.distanceTo(_aoeLastPos) : 999;
            const tookDamage = bot.health < _aoeLastHealth;

            if (hazardCloud || (tookDamage && moved < 0.5)) {
                const reason = hazardCloud ? 'AoE cloud nearby' : 'stationary damage (possible drowning/fire)';
                console.log(`[Actuator] Issue 4: ${reason} — emergency flee.`);
                _aoeEvading = true;

                // Stop current pathfinder goal and sprint in a random horizontal direction
                try { bot.pathfinder.setGoal(null); } catch (_) {}
                const fleeAngle = Math.random() * Math.PI * 2;
                const fx = curPos.x + 10 * Math.cos(fleeAngle);
                const fz = curPos.z + 10 * Math.sin(fleeAngle);
                try {
                    bot.pathfinder.setGoal(new goals.GoalXZ(Math.round(fx), Math.round(fz)), true);
                } catch (_) {}
                // If underwater, also jump to surface
                if (bot.entity.isInWater) {
                    bot.setControlState('jump', true);
                    setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 1500);
                }

                // Reset evasion flag after 2 seconds to allow re-check
                setTimeout(() => { _aoeEvading = false; }, 2000);
            }

            _aoeLastHealth = bot.health;
            _aoeLastPos    = curPos.clone();
        }, 800);

        // Projectile evasion interrupt.
        // Runs every 150ms independently of the combat loop and pathfinder.
        // Raises shield when an inbound projectile is detected; falls back to
        // direct control-state dodge (avoids lava/cliff). Pathfinder-based
        // dodge was replaced because GoalXZ fails with "no path" in Nether terrain.
        let _evasionCooldown = 0;
        let _evasionDodging = false;
        const DODGE_CONTROLS = ['right', 'left', 'back', 'forward']; // index maps to dodgeAngles order
        setInterval(async () => {
            if (!bot.entity || bot.health <= 0) return;
            if (!bot._client?.socket?.writable) return;
            const now = Date.now();
            if (now < _evasionCooldown) return;
            const evasionPos = bot.entity.position;
            const incomingProj = Object.values(bot.entities).find(e => {
                if (e === bot.entity) return false;
                const n = (e.name || e.displayName || '').toLowerCase();
                if (!n.includes('fireball') && !n.includes('arrow') &&
                    !n.includes('shulker_bullet') && !n.includes('wither_skull')) return false;
                // Issue 2: Extended range 12→20 so we detect Blaze fireballs earlier
                if (e.position.distanceTo(evasionPos) > 20) return false;
                const vel = e.velocity;
                if (!vel || (Math.abs(vel.x) < 0.01 && Math.abs(vel.y) < 0.01 && Math.abs(vel.z) < 0.01)) return false;
                const toBot = evasionPos.minus(e.position).normalize();
                const dot = vel.x * toBot.x + vel.y * toBot.y + vel.z * toBot.z;
                // Issue 2: Lowered threshold 0.35→0.2 — Blaze fireballs have moderate velocity
                return dot > 0.2;
            });
            if (!incomingProj) return;

            // Shulker bullets can chain-lift forever. Try to break them first.
            const projName = (incomingProj.name || '').toLowerCase();
            if (projName === 'shulker_bullet' && bot.entity.position.distanceTo(incomingProj.position) <= 5) {
                try {
                    await equipBestWeapon();
                    bot.attack(incomingProj);
                    _evasionCooldown = now + 350;
                    return;
                } catch (_) {}
            }

            // Raise shield first (highest priority)
            try {
                const offSlot = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
                if (offSlot?.name === 'shield') {
                    bot.activateItem(true);
                    _evasionCooldown = now + 900;
                    return;
                }
            } catch (_) {}
            // No shield — dodge via direct control states (works in Nether, no path-planning needed).
            // Priority: right, left, back, forward (avoid lava/cliff in each)
            const dodgeAngles = [
                bot.entity.yaw + Math.PI / 2,
                bot.entity.yaw - Math.PI / 2,
                bot.entity.yaw + Math.PI,
                bot.entity.yaw,
            ];
            const DODGE = 4;
            for (let di = 0; di < dodgeAngles.length; di++) {
                const angle = dodgeAngles[di];
                const tx = evasionPos.x + DODGE * Math.sin(angle);
                const tz = evasionPos.z + DODGE * Math.cos(angle);
                const fx = Math.floor(tx), fy = Math.floor(evasionPos.y), fz = Math.floor(tz);
                const bFoot   = bot.blockAt(new Vec3(fx, fy,     fz));
                const bBelow1 = bot.blockAt(new Vec3(fx, fy - 1, fz));
                const bBelow2 = bot.blockAt(new Vec3(fx, fy - 2, fz));
                const isHazard = b => !b || b.name.includes('lava') || b.name.includes('fire') || b.name === 'magma_block';
                const isAir    = b => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
                if (isHazard(bFoot) || isHazard(bBelow1)) continue;
                // Avoid cliff: 2+ consecutive air blocks below = drop hazard
                if (isAir(bBelow1) && isAir(bBelow2)) continue;
                // Use direct control states — instant, works regardless of terrain path-finding
                const ctrl = DODGE_CONTROLS[di];
                try { bot.pathfinder.setGoal(null); } catch (_) {}
                bot.setControlState(ctrl, true);
                bot.setControlState('sprint', true);
                bot.setControlState('jump', true);
                _evasionCooldown = now + 600;
                setTimeout(() => {
                    bot.setControlState(ctrl, false);
                    bot.setControlState('sprint', false);
                    bot.setControlState('jump', false);
                }, 400);
                break;
            }
        }, 150);

        debouncer = new EventDebouncer(bot, 500);

        // Issue 1 precaution: clear Invisibility effect if present on spawn/respawn.
        // The root cause is likely server-side (mod applying the effect), so we detect
        // and neutralise it by drinking milk (clears all potion effects).
        setTimeout(() => {
            try {
                const INVISIBILITY_ID = 14; // Vanilla Minecraft effect ID for Invisibility
                const effects = bot.entity?.effects || {};
                if (effects[INVISIBILITY_ID]) {
                    console.log('[Actuator] Invisibility effect detected after spawn. Attempting to clear with milk...');
                    const milk = bot.inventory.items().find(i => i.name === 'milk_bucket');
                    if (milk) {
                        bot.equip(milk, 'hand').then(() => bot.consume().catch(() => {})).catch(() => {});
                    } else {
                        bot.chat('[System] Warning: Invisibility effect active. No milk available to clear it.');
                    }
                }
            } catch (e) {}
        }, 3000);

        let _moveDiagTick = 0;
        let _lastDiagPos = null;
        bot.on('physicsTick', () => {
            _moveDiagTick++;

            // Water surface detection is now handled inside prismarine-physics
            // (simulatePlayer patch) so isInWater is correct BEFORE this handler fires.

            const moving = bot.pathfinder.isMoving();
            const mining = bot.pathfinder.isMining();
            const inWater = bot.entity.isInWater;
            const onGround = bot.entity.onGround;

            // SWIMMING_OVERRIDE_START
            // Issue 9: Improve swimming speed and straight-line movement.
            // If the bot is moving via the pathfinder and is in water, force it to sprint and jump
            // to simulate swimming rather than bouncing vertically at the surface.
            if (moving && inWater) {
                bot.setControlState('sprint', true);
                bot.setControlState('jump', true);

                // If there's a specific path node, ensure we look and move straight towards it
                if (bot.pathfinder.goal && bot.pathfinder.goal.hasChanged && typeof bot.pathfinder.goal.hasChanged === 'function') {
                     // Just keep forward true, looking logic is handled by pathfinder but sprinting helps speed.
                     bot.setControlState('forward', true);
                }
            } else if (!moving && inWater && bot.getControlState('jump')) {
                // If we stopped moving, stop jumping so we don't bob infinitely
                bot.setControlState('jump', false);
            }
            // SWIMMING_OVERRIDE_END

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
                if (process.env.DEBUG === 'true') {
                    // Block inspection for physics debugging
                    const blockBelow = bot.blockAt(pos.offset(0, -1, 0));
                    const blockAt = bot.blockAt(pos);
                    const blockAbove = bot.blockAt(pos.offset(0, 1, 0));
                    const belowInfo = blockBelow ? `${blockBelow.name}(id=${blockBelow.id},type=${blockBelow.type},bb=${blockBelow.boundingBox})` : 'null';
                    const atInfo = blockAt ? `${blockAt.name}(id=${blockAt.id},type=${blockAt.type},bb=${blockAt.boundingBox})` : 'null';
                    // Log vanilla water id for comparison
                    const vanillaWaterId = bot.registry.blocksByName['water']?.id;
                    const fwd = bot.getControlState('forward');
                    const spr = bot.getControlState('sprint');
                    const jmp = bot.getControlState('jump');
                    console.log(`[MoveDiag] tick=${_moveDiagTick} pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}) speed=${speed.toFixed(2)}b/s fwd=${fwd} spr=${spr} jmp=${jmp} moving=${moving} mining=${mining} water=${inWater} ground=${onGround} goal=${!!bot.pathfinder.goal} below=${belowInfo} at=${atInfo} vanillaWater=${vanillaWaterId}`);
                }
            }

            // Issue 2: MLG water-bucket and lava escape.
            if (bot.entity) {
                const curY = bot.entity.position.y;
                if (onGround || inWater) {
                    _fallStartY = null;
                    _mlgAttempted = false;
                } else {
                    // Issue 2: Track free-fall regardless of pathfinder state.
                    // maxDropDown=3 limits planned descents but unexpected falls (knockback,
                    // terrain errors) still happen. MLG water covers those cases.
                    if (_fallStartY === null) _fallStartY = curY;
                    const fallDist = _fallStartY - curY;
                    if (fallDist > 4 && !_mlgAttempted) {
                        // Find distance to solid ground below
                        const cx = Math.floor(bot.entity.position.x);
                        const cz = Math.floor(bot.entity.position.z);
                        let groundY = null;
                        for (let y = Math.floor(curY); y >= Math.max(Math.floor(curY) - 20, -64); y--) {
                            const b = bot.blockAt(new Vec3(cx, y, cz));
                            if (b && b.boundingBox === 'block' && !b.name.includes('water') && !b.name.includes('air')) {
                                groundY = y;
                                break;
                            }
                        }
                        // Trigger MLG within 6 blocks of ground (wider window = more reliable)
                        if (groundY !== null && curY - groundY <= 6) {
                            const wb = bot.inventory.items().find(i => i.name === 'water_bucket');
                            if (wb) {
                                _mlgAttempted = true;
                                bot.equip(wb, 'hand').then(async () => {
                                    try {
                                        await bot.look(bot.entity.yaw, -Math.PI / 2, true);
                                        bot.activateItem();
                                    } catch (e) {}
                                }).catch(() => {});
                            }
                        }
                    }
                }

                // Issue 2: Lava escape — if bot lands in lava, cancel pathfinder and jump out.
                const blockAtFeet = bot.blockAt(bot.entity.position);
                if (blockAtFeet && (blockAtFeet.name === 'lava' || blockAtFeet.name === 'flowing_lava')) {
                    if (!_lavaEscapeActive) {
                        _lavaEscapeActive = true;
                        console.log('[Actuator] Detected lava at feet. Cancelling pathfinder and jumping out.');
                        bot.pathfinder.setGoal(null);
                        bot.setControlState('jump', true);
                        bot.setControlState('forward', true);
                        setTimeout(() => {
                            bot.setControlState('jump', false);
                            bot.setControlState('forward', false);
                            _lavaEscapeActive = false;
                        }, 1000);
                    }
                }
            }
        });
    }

    console.log('[Actuator] Pathfinder and Physics initialized.');

    // Wait for physics to settle before checking ground state
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Diagnostic: log raw block info around spawn point
    if (process.env.DEBUG === 'true') {
        try {
            const sp = bot.entity.position.floored();
            for (let dy = -3; dy <= 2; dy++) {
                const b = bot.blockAt(sp.offset(0, dy, 0));
                console.log(`[SpawnDiag] Y=${sp.y + dy}: name=${b?.name} type=${b?.type} stateId=${b?.stateId} bb=${b?.boundingBox}`);
            }
        } catch (e) {}
    }

    // Goal 7: Locate initial equipment containers (chest/barrel/shulker above smooth_stone)
    try {
        const containerIds = getEquipmentContainerIds();
        if (containerIds.length > 0) {
            const containers = bot.findBlocks({ matching: containerIds, maxDistance: 32, count: 20 });
            let announced = false;
            for (const cpos of containers) {
                const below = bot.blockAt(cpos.offset(0, -1, 0));
                if (below && below.name === 'smooth_stone') {
                    const ckey = `${cpos.x},${cpos.y},${cpos.z}`;
                    if (!_lootedChests.has(ckey)) {
                        if (!announced) { bot.chat(`[System] I see an equipment chest! Gearing up...`); announced = true; }
                        console.log(`[Actuator] Found initial equipment container at ${cpos}. Fetching gear...`);
                        _lootedChests.add(ckey);
                        actionQueue.push({ action: 'loot_chest_special', target: cpos });
                    }
                }
            }
        }
    } catch(e) {}

    // ── Mark bot ready EARLY so test harness can start, then escape water in background ──
    bot.chat('[System] Forge AI Player Ready.');
    _botReady = true;
    console.log('[Actuator] Bot ready. Flushing pending IPC actions:', _pendingIpcActions.length);
    for (const pending of _pendingIpcActions) {
        actionQueue.push(...pending);
    }
    _pendingIpcActions = [];

    // Bug Fix 10: Restore checkpoint — if the bot restarted after a crash/disconnect
    // and there are no buffered IPC actions (no new instructions yet), attempt to
    // resume the previous task queue. Skip restore on first-ever spawn.
    if (actionQueue.length === 0) {
        const checkpoint = _loadQueueCheckpoint();
        if (checkpoint) {
            console.log(`[Actuator] Resuming ${checkpoint.length} checkpointed action(s) after restart.`);
            bot.chat(`[System] Resuming ${checkpoint.length} task(s) from before disconnect.`);
            actionQueue.push(...checkpoint);
            _clearQueueCheckpoint();
        }
    }

    if (actionQueue.length > 0) processActionQueue();

    // Death Recovery: check for gravestone mod death-marker item in inventory.
    // If present, recovery is incomplete regardless of how many restarts have occurred.
    // Recovery is only complete when the marker item is gone after collecting items.
    // Fallback: last_death.json used only when no marker item exists (no retry cap when marker present).
    const DEATH_MARKER_PATTERNS = [
        /grave/i, /death/i, /soul/i, /tomb/i, /obituary/i, /rip\b/i, /died/i, /pouch/i, /backpack.*death/i
    ];
    const findDeathMarkerItem = () => {
        try {
            for (const item of bot.inventory.items()) {
                const rawName = item.nbt?.value?.display?.value?.Name?.value || item.customName || item.displayName || item.name || '';
                let plain = rawName.replace(/§[0-9a-fk-or]/gi, '').trim();

                if (item.nbt) {
                    try {
                        plain += ' ' + JSON.stringify(item.nbt).replace(/§[0-9a-fk-or]/gi, '');
                    } catch (e) {}
                }

                let isMarker = DEATH_MARKER_PATTERNS.some(p => p.test(plain));
                let m = plain.match(/X[\s:]+(-?\d+)[^\d-]*Y[\s:]+(-?\d+)[^\d-]*Z[\s:]+(-?\d+)/i);
                if (!m) m = plain.match(/(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/);

                if (m) {
                    const y = +m[2];
                    if (y >= -64 && y <= 320) {
                        return { item, plain: rawName.replace(/§[0-9a-fk-or]/gi, '').trim(), coords: { x: +m[1], y: y, z: +m[3] } };
                    }
                }
                if (isMarker) return { item, plain: rawName.replace(/§[0-9a-fk-or]/gi, '').trim(), coords: null };
            }
        } catch (e) {}
        return null;
    };

    setTimeout(() => {
        if (actionQueue.some(a => a.action === 'recover_gravestone')) return;

        // Issue 3: We no longer auto-queue recovery.
        // We wait for the player to respond to the "[System] I died! Do you want me to recover my items? (yes/no)" prompt.
    }, 3000);

    // Issue 4: Auto-equip best gear when idle (runs every 15s).
    // Ensures any armor/weapons acquired via crafting, looting, or trading get equipped.
    setInterval(() => {
        if (!_botReady || isExecuting || actionQueue.length > 0) return;
        equipBestArmor().catch(() => {});
        equipBestWeapon().catch(() => {});
        if (bot.food < 15 && !bot.pathfinder.isMining()) {
            const food = getBestFoodItem();
            if (food) bot.equip(food, 'hand').then(() => bot.consume().catch(() => {})).catch(() => {});
        }
    }, 15000);

    // Also equip immediately after spawn/respawn
    equipBestArmor().catch(() => {});
    equipBestWeapon().catch(() => {});

    // ── Goal 3: Idle equipment-container scanner + structure auto-waypoint (every 30s) ──
    setInterval(() => {
        if (!_botReady || isExecuting || actionQueue.length > 0) return;
        try {
            const containerIds = getEquipmentContainerIds();
            if (containerIds.length === 0) return;
            const missing = isMissingGear();
            const containers = bot.findBlocks({ matching: containerIds, maxDistance: 32, count: 20 });
            let queued = false;
            for (const cpos of containers) {
                const key = `${cpos.x},${cpos.y},${cpos.z}`;
                // Re-visit previously looted containers only when gear is still missing
                if (_lootedChests.has(key) && !missing) continue;
                const below = bot.blockAt(cpos.offset(0, -1, 0));
                if (below && below.name === 'smooth_stone') {
                    console.log(`[Actuator] Idle: found equipment container at ${cpos}. Gearing up.`);
                    if (!queued) { bot.chat('[System] I see an equipment chest nearby. Gearing up...'); }
                    _lootedChests.add(key);
                    actionQueue.push({ action: 'loot_chest_special', target: cpos });
                    queued = true;
                }
            }
            if (queued) processActionQueue();
        } catch (e) {}

        // Issue 1: auto-register nearby structures as waypoints during idle.
        try {
            if (!bot.entity) return;
            const ctx = getEnvironmentContext();
            if (ctx.nearby_structures && ctx.nearby_structures.length > 0) {
                const wps = loadWaypoints();
                const dim = bot.game?.dimension || 'overworld';
                let saved = false;
                for (const struct of ctx.nearby_structures) {
                    const wpName = struct.toLowerCase().replace(/\s+/g, '_');
                    if (!wps.find(w => w.name === wpName)) {
                        const pos = bot.entity.position;
                        wps.push({ name: wpName, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), dimension: dim });
                        bot.chat(`[System] Auto-registered waypoint "${wpName}".`);
                        saved = true;
                    }
                }
                if (saved) saveWaypoints(wps);
            }
        } catch (e) {}
    }, 30000);

    // Issue 11: Autonomous idle maintenance — tool durability and raw food smelting (30s interval)
    setInterval(async () => {
        if (!_botReady || isExecuting || actionQueue.length > 0 || _autonomousTaskBusy) return;
        if (!bot.entity || bot.health <= 0) return;

        // 11a: Replace worn-out tools (durability < 5%)
        try {
            for (const item of bot.inventory.items()) {
                if (!item.durabilityUsed) continue;
                const maxDur = item.maxDurability || 1;
                const remaining = maxDur - (item.durabilityUsed || 0);
                if (remaining / maxDur < 0.05) {
                    // Craft a replacement — pick the tool type
                    const toolType = ['pickaxe','axe','shovel','sword','hoe'].find(t => item.name.endsWith('_' + t));
                    if (!toolType) continue;
                    const materialOrder = ['netherite','diamond','iron','stone','wood'];
                    const replacement = materialOrder.map(m => `${m}_${toolType}`).find(n => bot.registry.itemsByName[n]);
                    if (replacement && replacement !== item.name) {
                        console.log(`[Actuator] Idle: tool ${item.name} nearly broken, queuing craft of ${replacement}`);
                        bot.chat(`[System] My ${item.name} is nearly broken. Crafting a replacement.`);
                        _autonomousTaskBusy = true;
                        actionQueue.push({ action: 'craft', target: replacement, quantity: 1, _autonomous: true });
                        processActionQueue().finally(() => { _autonomousTaskBusy = false; });
                        return;
                    }
                }
            }
        } catch(e) {}

        // 11b: Smelt raw food if furnace is nearby and bot has raw food
        try {
            const rawFoodMap = {
                'raw_beef': 'cooked_beef', 'raw_porkchop': 'cooked_porkchop',
                'raw_chicken': 'cooked_chicken', 'raw_mutton': 'cooked_mutton',
                'raw_rabbit': 'cooked_rabbit', 'raw_cod': 'cooked_cod',
                'raw_salmon': 'cooked_salmon', 'potato': 'baked_potato'
            };
            const furnaceId = bot.registry.blocksByName['furnace']?.id;
            const litFurnaceId = bot.registry.blocksByName['lit_furnace']?.id;
            const matchingIds = [furnaceId, litFurnaceId].filter(Boolean);
            const furnacePos = matchingIds.length > 0
                ? bot.findBlock({ matching: matchingIds, maxDistance: 16 })
                : null;
            if (furnacePos) {
                for (const [rawName, cookedName] of Object.entries(rawFoodMap)) {
                    const rawItem = bot.inventory.findInventoryItem(bot.registry.itemsByName[rawName]?.id, null, false);
                    if (rawItem && rawItem.count >= 4) {
                        console.log(`[Actuator] Idle: smelting ${rawItem.count}x ${rawName} in nearby furnace`);
                        bot.chat(`[System] Smelting ${rawItem.count} ${rawName} in nearby furnace.`);
                        _autonomousTaskBusy = true;
                        actionQueue.push({ action: 'smelt', target: rawName, quantity: rawItem.count, _autonomous: true });
                        processActionQueue().finally(() => { _autonomousTaskBusy = false; });
                        return;
                    }
                }
            }
        } catch(e) {}
    }, 30000);

    // --- File Logging for External AI Monitor ---
    setInterval(() => {
        if (!bot.entity) return;
        try {
            const invItems = bot.inventory ? bot.inventory.items() : [];
            const armor = {};
            try {
                armor.head  = bot.inventory.slots[bot.getEquipmentDestSlot('head')]?.name  || null;
                armor.torso = bot.inventory.slots[bot.getEquipmentDestSlot('torso')]?.name || null;
                armor.legs  = bot.inventory.slots[bot.getEquipmentDestSlot('legs')]?.name  || null;
                armor.feet  = bot.inventory.slots[bot.getEquipmentDestSlot('feet')]?.name  || null;
                armor.hand  = bot.inventory.slots[bot.getEquipmentDestSlot('hand')]?.name  || null;
            } catch (e) {}
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
                dimension: bot.game?.dimension || 'overworld',
                isExecuting,
                currentAction,
                actionQueue: [...actionQueue],
                treeDir: _treeDir,
                inventory: invItems.map(i => ({ name: i.name, count: i.count })),
                armor
            };
            fs.writeFile(path.join(process.cwd(), `ai_debug_${botId}.json`), JSON.stringify(debugState, null, 2), () => {});
            fs.appendFile(path.join(process.cwd(), `ai_history_${botId}.log`), JSON.stringify(debugState) + '\n', () => {});
            if (process.send) process.send({ type: 'BOT_STATUS', data: debugState });
            // VDS-001: broadcast status to WebUI map overlay
            debugWS.broadcast('status', {
                botId,
                health: debugState.health,
                pos: debugState.position ? [debugState.position.x, debugState.position.y, debugState.position.z] : null,
                action: debugState.currentAction,
                stuckSec: _stuckSeconds
            });

            // Issue 3: Continuously track last safe position for accurate death recovery.
            // Only update when on ground and healthy (not during a fall or combat death spiral).
            if (bot.entity && bot.entity.onGround && bot.health > 4) {
                _lastSafePos = bot.entity.position.clone();
                _lastSafeDim = bot.game?.dimension || 'overworld';
            }

            // Auto-shredder: drop junk items when inventory is nearly full
            if (!_inStopMode) _runAutoShredder().catch(() => {});
        } catch (e) {
            console.error(`[Actuator] Failed to write ai_debug: ${e.message}`);
        }
    }, 5000);

    // VDS-001: Stuck detection — every 5s compare position against previous sample.
    let _stuckLastPos = null;
    let _stuckSeconds = 0;
    let _obsRecording = false;
    setInterval(() => {
        if (!bot.entity) return;
        const pos = bot.entity.position;
        if (_stuckLastPos && currentAction && currentAction !== 'stop') {
            const dx = pos.x - _stuckLastPos.x;
            const dy = pos.y - _stuckLastPos.y;
            const dz = pos.z - _stuckLastPos.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist < 0.5) {
                _stuckSeconds += 5;
                debugTrace.logEvent(botId, 'stuck', currentAction, pos, { duration_sec: _stuckSeconds });
                debugWS.broadcast('stuck', {
                    botId,
                    pos: [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)],
                    duration_sec: _stuckSeconds
                });
                // OBS: start recording when stuck >= 10 s
                if (_stuckSeconds >= 10 && obsConnector.isConnected() && !_obsRecording) {
                    _obsRecording = true;
                    obsConnector.startRecordIfNotRecording().catch(() => {});
                }
            } else {
                if (_stuckSeconds > 0 && _obsRecording) {
                    // Bot moved — stop recording after 5 s delay
                    setTimeout(() => {
                        _obsRecording = false;
                        obsConnector.stopRecord().catch(() => {});
                    }, 5000);
                }
                _stuckSeconds = 0;
            }
        }
        _stuckLastPos = pos.clone();
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
    // Issue 1: Do not run this in the End, as the obsidian platform is safe but surrounded by void.
    if (!bot.entity.onGround && bot.game?.dimension !== 'the_end' && bot.game?.dimension !== 'minecraft:the_end') {
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
                console.log(`[Actuator] Solid ground at (${landTarget.x}, ${landTarget.y}, ${landTarget.z}) name=${bot.blockAt(landTarget)?.name}. Moving there...`);
                if (DEBUG) {
                    bot.chat(`/tp ${bot.username} ${landTarget.x + 0.5} ${landTarget.y + 1} ${landTarget.z + 0.5}`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } else {
                    try {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(landTarget.x, landTarget.y, landTarget.z, 2)), 30000, 'spawn ground escape', () => bot.pathfinder.setGoal(null));
                    } catch (e) { console.log(`[Actuator] Pathfinder spawn escape: ${e.message}`); }
                }
                console.log(`[Actuator] Now at (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) onGround=${bot.entity.onGround}`);
            } else {
                console.log('[Actuator] No standable solid block found nearby. Will try pathfinder or ask player.');
                // Check for void environment and initiate bridging
                console.log('[Actuator] No solid ground detected. Initiating bridge construction...');
                // Attempt to place blocks forward from the bot's current position.
                // bridgeStart is one block below the bot; we place on the top face (+Y) of
                // blocks two below the bot and extending outward in Z.
                for (let i = 0; i < 10; i++) {
                    const bridgeBlock = bot.inventory.items().find(item => item.name.includes('planks') || item.name.includes('stone'));
                    if (!bridgeBlock) {
                        console.log('[Actuator] Out of blocks for bridging. Stopping operation.');
                        break;
                    }
                    // Reference block: two blocks below the bot, extended i blocks in +Z
                    const refPos = bot.entity.position.offset(0, -2, i);
                    const refBlock = bot.blockAt(refPos);
                    // Can only place against a solid block; skip if void/air
                    if (!refBlock || refBlock.boundingBox !== 'block') {
                        console.log(`[Actuator] No reference block at step ${i}. Stopping bridge.`);
                        break;
                    }
                    await bot.equip(bridgeBlock, 'hand');
                    try {
                        await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
                    } catch (e) {
                        console.log(`[Actuator] placeBlock failed at step ${i}: ${e.message}`);
                        break;
                    }
                }
            }
        }

        // If still not on ground, try tp to player (debug) or swim via pathfinder
        if (!bot.entity.onGround) {
            const nearbyPlayers = Object.values(bot.players).filter(p => p.username !== bot.username);
            if (nearbyPlayers.length > 0 && !solidBlocks.length) {
                if (DEBUG) {
                    bot.chat(`/tp ${bot.username} ${nearbyPlayers[0].username}`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                console.log(`[Actuator] After escape attempt: pos=(${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) onGround=${bot.entity.onGround}`);
            }
        }
    }

    // Only in debug mode: teleport to nearest player to reach dry land quickly.
    // Skip if in the End dimension as it usually means teleporting into the void or away from the obsidian platform
    const isEndDimension = bot.game?.dimension === 'the_end' || bot.game?.dimension === 'minecraft:the_end';
    if (DEBUG && !isEndDimension) {
        const nearbyPlayers = Object.values(bot.players)
            .filter(p => p.username !== bot.username && p.entity);
        if (nearbyPlayers.length > 0) {
            const tpTarget = nearbyPlayers[0].username;
            const curPos = bot.entity.position;
            const playerEntity = nearbyPlayers[0].entity;
            const isInWaterArea = (bot.blockAt(curPos)?.name?.includes('water') ||
                bot.blockAt(curPos.offset(0, -1, 0))?.name?.includes('water') ||
                bot.blockAt(curPos.offset(1, 0, 0))?.name?.includes('water') ||
                bot.blockAt(curPos.offset(-1, 0, 0))?.name?.includes('water'));
            const playerHigher = playerEntity && (playerEntity.position.y > curPos.y + 5);
            if (isInWaterArea || playerHigher) {
                console.log(`[Actuator] DEBUG: area water-logged or player higher. Teleporting to ${tpTarget}...`);
                bot.chat(`/tp ${bot.username} ${tpTarget}`);
                await new Promise(resolve => setTimeout(resolve, 3000));

                await new Promise(resolve => setTimeout(resolve, 500));
                for (let attempt = 0; attempt < 6; attempt++) {
                    const checkPos = bot.entity.position;
                    const atWater = bot.blockAt(checkPos)?.name?.includes('water');
                    const belowWater = bot.blockAt(checkPos.offset(0, -1, 0))?.name?.includes('water');
                    if (!atWater && !belowWater && bot.entity.onGround) break;
                    if (!atWater && !belowWater) break;
                    console.log(`[Actuator] In water after player tp (attempt ${attempt+1}). Teleporting up 5 blocks...`);
                    const emergPos = bot.entity.position;
                    bot.chat(`/tp ${bot.username} ${emergPos.x.toFixed(2)} ${(emergPos.y + 5).toFixed(2)} ${emergPos.z.toFixed(2)}`);
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }

                console.log(`[Actuator] Final position: (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}) onGround=${bot.entity.onGround}`);
            }
        }
    }

    // Legacy water escape block removed for cleanup

    })().catch(e => console.log('[Actuator] Background water escape error:', e.message));
});

function getEnvironmentContext() {
    const nearbyBlocks = [];
    if (bot.entity) {
        // Find interactive blocks in a single pass to prevent blocking the event loop
        const interactiveNames = ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel',
                                  'anvil', 'enchanting_table', 'brewing_stand', 'end_portal', 'end_portal_frame', 'nether_portal'];
        const interactiveIds = new Set();
        for (const name of interactiveNames) {
            const id = bot.registry.blocksByName[name]?.id;
            if (id !== undefined) interactiveIds.add(id);
        }

        // Also match any bed (which are suffixed with _bed)
        const isInteractive = b => b && (interactiveIds.has(b.type) || b.name.endsWith('_bed'));

        const foundInteractive = bot.findBlocks({ matching: isInteractive, maxDistance: 16, count: 24 });
        const addedInteractive = new Set();
        for (const pos of foundInteractive) {
            const b = bot.blockAt(pos);
            if (b && !addedInteractive.has(b.name)) {
                nearbyBlocks.push(b.name);
                addedInteractive.add(b.name);
            }
        }

        // Add a scan of surrounding blocks within a 8-block radius to help the LLM know what's available
        // Reduced from 16 to 8 to keep sync loop <1ms (17x17x17 = 4913 blocks instead of 35937)
        try {
            const pos = bot.entity.position.floored();
            const counts = {};
            for (let dx = -8; dx <= 8; dx++) {
                for (let dy = -8; dy <= 8; dy++) {
                    for (let dz = -8; dz <= 8; dz++) {
                        const b = bot.blockAt(pos.offset(dx, dy, dz));
                        if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
                            counts[b.name] = (counts[b.name] || 0) + 1;
                        }
                    }
                }
            }

            // Limit to top 20 most common blocks to save context length
            const sortedBlocks = Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([name, count]) => `${count}x ${name}`);

            if (sortedBlocks.length > 0) {
                nearbyBlocks.push(...sortedBlocks);
            }
        } catch(e) {}
    }
    // Issue 1: Detect what structure the bot is currently inside by scanning for signature blocks.
    // Gives the LLM accurate location context (e.g. "already in nether_fortress").
    const nearbyStructures = [];
    if (bot.entity) {
        const structureMarkers = [
            { name: 'nether_fortress', blocks: ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs'] },
            { name: 'stronghold',      blocks: ['end_portal_frame', 'mossy_stone_bricks'] },
            { name: 'ocean_monument',  blocks: ['prismarine', 'sea_lantern'] },
        ];

        const markerIdToStruct = new Map();
        for (const { name, blocks } of structureMarkers) {
            for (const blockName of blocks) {
                const id = bot.registry.blocksByName[blockName]?.id;
                if (id !== undefined) markerIdToStruct.set(id, name);
            }
        }

        const isMarker = b => b && markerIdToStruct.has(b.type);
        // Reduced maxDistance from 32 to 24 to keep the scan extremely fast and prevent event loop stalling
        const foundMarkers = bot.findBlocks({ matching: isMarker, maxDistance: 24, count: 20 });
        const addedStructures = new Set();

        for (const pos of foundMarkers) {
            const b = bot.blockAt(pos);
            if (b) {
                const structName = markerIdToStruct.get(b.type);
                if (structName && !addedStructures.has(structName)) {
                    nearbyStructures.push(structName);
                    addedStructures.add(structName);
                }
            }
        }
    }

    const nearbyEntities = [];
    if (bot.entity && bot.entities) {
        for (const ent of Object.values(bot.entities)) {
            if (ent === bot.entity || !ent.isValid) continue;
            // Expand distance to 128 blocks so the LLM doesn't incorrectly assume an entity
            // doesn't exist just because it is out of the previous 64-block radius
            if (bot.entity.position.distanceTo(ent.position) <= 128) {
                const name = (ent.name || ent.displayName || ent.username || '').toLowerCase();
                if (name && name !== 'item' && name !== 'experience_orb') {
                    nearbyEntities.push(name);
                }
            }
        }
    }
    // Deduplicate and count nearby entities
    const entityCounts = nearbyEntities.reduce((acc, name) => {
        acc[name] = (acc[name] || 0) + 1;
        return acc;
    }, {});
    const entitySummary = Object.entries(entityCounts).map(([name, count]) => `${count}x ${name}`);

    const inventoryItems = bot.inventory ? bot.inventory.items() : [];
    return {
        position: bot.entity ? {
            x: Math.round(bot.entity.position.x),
            y: Math.round(bot.entity.position.y),
            z: Math.round(bot.entity.position.z)
        } : null,
        dimension: bot.game?.dimension || null,
        health: bot.health ? Math.round(bot.health) : null,
        food: bot.food ? Math.round(bot.food) : null,
        players_nearby: Object.keys(bot.players).filter(p => p !== bot.username && bot.players[p].entity),
        inventory: inventoryItems.map(item => ({ name: item.name, count: item.count })),
        has_pickaxe: inventoryItems.some(i => i.name.endsWith('_pickaxe')),
        has_axe: inventoryItems.some(i => i.name.endsWith('_axe')),
        has_sword: inventoryItems.some(i => i.name.endsWith('_sword')),
        nearby_blocks: nearbyBlocks,
        nearby_structures: nearbyStructures,
        nearby_entities: entitySummary,
        blackboard: _readBlackboard()
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
    // Issue 3: Only treat messages prefixed with '-' as instructions.
    // All other chat (server notifications, player chatter) is ignored to prevent
    // system logs (e.g. difficulty changes) from accidentally triggering the AI.
    if (!message.startsWith('-')) return;

    const key = `${username}:${message}`;
    const now = Date.now();
    if (now - (_chatDedup.get(key) ?? 0) < 3000) return;
    _chatDedup.set(key, now);
    // Prune stale entries so the map doesn't grow unbounded
    if (_chatDedup.size > 64) {
        const cutoff = now - 5000;
        for (const [k, t] of _chatDedup) if (t < cutoff) _chatDedup.delete(k);
    }
    // Improvement 1: '-!' prefix = async (non-interrupting status query).
    // '-' prefix = normal instruction (interrupts current action).
    const isAsync = message.startsWith('-!');
    const cleanMessage = isAsync ? message.slice(2).trim() : message.slice(1).trim();
    process.send({ type: 'USER_CHAT', data: { username, message: cleanMessage, async: isAsync, environment: getEnvironmentContext() } });
});

// VDS-001: !mismatch chat command — detect and broadcast block registry mismatches.
bot.on('chat', (username, message) => {
    if (message.trim() !== '!mismatch') return;
    const { detectMismatches } = require('./debug_mismatch_detector');
    detectMismatches(bot).then((mismatches) => {
        debugWS.broadcast('mismatch', {
            botId,
            blocks: mismatches.map(m => [m.x, m.y, m.z, m.botStateId, m.realName])
        });
        bot.chat(`[System] Mismatch scan: ${mismatches.length} block(s) differ. Broadcasted to WebUI.`);
    }).catch((err) => {
        bot.chat(`[System] Mismatch scan failed: ${err.message}`);
    });
});

// ─── Internal Waypoint System ──────────────────────────────────────────────────
const WAYPOINTS_FILE = path.join(process.cwd(), 'data', 'waypoints.json');

function loadWaypoints() {
    try {
        if (fs.existsSync(WAYPOINTS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(WAYPOINTS_FILE, 'utf8'));
            if (!Array.isArray(raw)) return [];
            return raw.filter(w => {
                if (!w || !w.name || w.x === undefined || w.y === undefined || w.z === undefined || !w.dimension) {
                    console.warn(`[Actuator] Dropped invalid waypoint entry: ${JSON.stringify(w)}`);
                    return false;
                }
                return true;
            });
        }
    } catch (e) {}
    return [];
}

function saveWaypoints(waypoints) {
    try {
        const dir = path.dirname(WAYPOINTS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(WAYPOINTS_FILE, JSON.stringify(waypoints, null, 2));
    } catch (e) {
        console.error(`[Actuator] Failed to save waypoints: ${e.message}`);
    }
}

function findWaypoint(name) {
    const waypoints = loadWaypoints();
    return waypoints.find(w => w.name.toLowerCase() === name.toLowerCase()) || null;
}

// ─── Path Cache System ─────────────────────────────────────────────────────
// Caches the last successful set of XZ waypoints used to reach a destination.
// Reduces A* compute on repeated routes (e.g. base→mine, overworld→portal).
const PATH_CACHE_FILE = path.join(process.cwd(), 'data', 'path_cache.json');
const PATH_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

function loadPathCache() {
    try {
        if (fs.existsSync(PATH_CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(PATH_CACHE_FILE, 'utf8'));
        }
    } catch (e) {}
    return {};
}

function savePathCache(cache) {
    try {
        const dir = path.dirname(PATH_CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PATH_CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.error(`[Actuator] Failed to save path cache: ${e.message}`);
    }
}

function getPathCacheKey(destX, destZ, dimension) {
    // Quantize to 16-block grid so nearby-destination queries get a cache hit.
    return `${dimension || 'overworld'}:${Math.round(destX / 16) * 16}:${Math.round(destZ / 16) * 16}`;
}

// Structure name → minecraft:id mapping for /locate command
const STRUCTURE_NAMES = {
    'fortress': 'fortress', 'nether_fortress': 'fortress',
    'nether fortress': 'fortress', 'netherfortress': 'fortress',
    'stronghold': 'stronghold',
    'mansion': 'mansion', 'woodland_mansion': 'mansion',
    'woodland mansion': 'mansion',
    'village': 'village',
    'monument': 'monument', 'ocean_monument': 'monument',
    'ocean monument': 'monument',
    'desert_pyramid': 'desert_pyramid', 'desert_temple': 'desert_pyramid',
    'desert pyramid': 'desert_pyramid', 'desert temple': 'desert_pyramid',
    'jungle_pyramid': 'jungle_temple', 'jungle_temple': 'jungle_temple',
    'jungle pyramid': 'jungle_temple', 'jungle temple': 'jungle_temple',
    'ruined_portal': 'ruined_portal',
    'ruined portal': 'ruined_portal',
    'shipwreck': 'shipwreck',
    'pillager_outpost': 'pillager_outpost',
    'pillager outpost': 'pillager_outpost',
    'bastion_remnant': 'bastion_remnant',
    'bastion remnant': 'bastion_remnant',
    'end_city': 'end_city',
    'end city': 'end_city', 'endcity': 'end_city',
    'igloo': 'igloo',
    'swamp_hut': 'swamp_hut',
    'swamp hut': 'swamp_hut',
    'ocean_ruin': 'ocean_ruin',
    'ocean ruin': 'ocean_ruin',
    'buried_treasure': 'buried_treasure',
    'buried treasure': 'buried_treasure',
    'ancient_city': 'ancient_city',
    'ancient city': 'ancient_city',
    'trail_ruins': 'trail_ruins',
    'trail ruins': 'trail_ruins',
};

function normalizeStructureTarget(target) {
    return String(target || '')
        .toLowerCase()
        .replace(/^minecraft:/, '')
        .replace(/[\s-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .trim();
}

async function waitForLocateResult(timeoutMs = 12000) {
    return await new Promise((resolve) => {
        const done = (result) => {
            clearTimeout(timeout);
            bot.removeListener('messagestr', onMessageStr);
            bot.removeListener('message', onMessageJson);
            resolve(result);
        };
        const tryExtract = (text) => {
            const msg = String(text || '');
            const xz = msg.match(/\[X:\s*(-?\d+)[^\]]*Z:\s*(-?\d+)\]/i)
                || msg.match(/x\s*[:=]\s*(-?\d+).{0,40}z\s*[:=]\s*(-?\d+)/i);
            if (xz) {
                return { x: parseInt(xz[1], 10), z: parseInt(xz[2], 10) };
            }
            if (/could not find|not find|no structure|cannot locate/i.test(msg)) {
                return { error: msg };
            }
            return null;
        };
        const onMessageStr = (message) => {
            const found = tryExtract(message);
            if (found) done(found);
        };
        const onMessageJson = (jsonMsg) => {
            const text = typeof jsonMsg?.toString === 'function' ? jsonMsg.toString() : '';
            const found = tryExtract(text);
            if (found) done(found);
        };

        const timeout = setTimeout(() => done(null), timeoutMs);
        bot.on('messagestr', onMessageStr);
        bot.on('message', onMessageJson);
    });
}

// ─── Looted chest tracking (prevents re-looting same chest) ────────────────────
const _lootedChests = new Set();

// Issue 2: Fall-tracking state for MLG water-bucket and safe-landing maneuvers.
let _fallStartY = null;
let _mlgAttempted = false;
let _lavaEscapeActive = false;

// Body (Action)
let actionQueue = [];
let currentCancelToken = { cancelled: false };
let isExecuting = false;
let currentAction = null;
let movements = null; // initialized in 'spawn'
// Issue 6: _inStopMode prevents auto-idle-combat loop after explicit stop.
// Cleared on any new EXECUTE_ACTION that isn't pure stop.
let _inStopMode = false;

// ─── Bug Fix 10: Task Queue Checkpoint ────────────────────────────────────────
// Persist the action queue to disk so tasks survive ECONNRESET/crash restarts.
// Only resumable, side-effect-free action types are checkpointed (navigation,
// collection, combat). One-shot destructive actions (give, smelt, craft) are
// excluded because replaying them after a partial execution would be incorrect.
const QUEUE_CHECKPOINT_FILE = path.join(process.cwd(), 'data', `queue_checkpoint_${botId}.json`);
const NON_RESUMABLE_ACTIONS = new Set(['give', 'smelt', 'brew', 'enchant', 'activate_end_portal', 'place_pattern', 'place', 'sleep', 'find_land', 'find_and_equip', 'loot_chest_special']);

// ─── Aviation: Jetpack Mod Registry ───────────────────────────────────────────
// Maps mod namespace → control config. itemPattern matches the local item name
// (part after ':' in the full Minecraft item ID). ascendControl is the Mineflayer
// control state to hold for upward thrust. Add entries when new jetpack mods appear.
const JETPACK_MOD_REGISTRY = {
    simplyjetpacks2:  { itemPattern: /jetpack/i, ascendControl: 'jump' },
    simplerjetpacks2: { itemPattern: /jetpack/i, ascendControl: 'jump' },
    // Generic fallback: covers any mod item with "jetpack" in the local name.
    _generic:         { itemPattern: /jetpack/i, ascendControl: 'jump' },
};

// ─── Blackboard (Change 2) ────────────────────────────────────────────────────
const BLACKBOARD_FILE = path.join(process.cwd(), 'data', 'blackboard.json');

function _readBlackboard() {
    try {
        if (!fs.existsSync(BLACKBOARD_FILE)) return {};
        return JSON.parse(fs.readFileSync(BLACKBOARD_FILE, 'utf8'));
    } catch(e) { return {}; }
}

function _writeBlackboard(data) {
    try {
        const dir = path.dirname(BLACKBOARD_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(BLACKBOARD_FILE, JSON.stringify(data, null, 2));
    } catch(e) {}
}

// ─── Safe Zones (Change 3) ────────────────────────────────────────────────────
const SAFE_ZONES_FILE = path.join(process.cwd(), 'data', 'safezones.json');

function _loadSafeZones() {
    try {
        if (!fs.existsSync(SAFE_ZONES_FILE)) return [];
        return JSON.parse(fs.readFileSync(SAFE_ZONES_FILE, 'utf8'));
    } catch(e) { return []; }
}

function _isInSafeZone(pos, dimension) {
    try {
        const zones = _loadSafeZones();
        for (const zone of zones) {
            if (zone.dimension && zone.dimension !== dimension) continue;
            if (pos.x >= zone.minX && pos.x <= zone.maxX &&
                pos.y >= zone.minY && pos.y <= zone.maxY &&
                pos.z >= zone.minZ && pos.z <= zone.maxZ) {
                return true;
            }
        }
    } catch(e) {}
    return false;
}

function _saveQueueCheckpoint(queue) {
    try {
        const resumable = queue.filter(a => a && a.action && !NON_RESUMABLE_ACTIONS.has(a.action));
        if (resumable.length === 0) {
            // Nothing worth persisting — clear stale checkpoint
            if (fs.existsSync(QUEUE_CHECKPOINT_FILE)) fs.unlinkSync(QUEUE_CHECKPOINT_FILE);
            return;
        }
        const dir = path.dirname(QUEUE_CHECKPOINT_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(QUEUE_CHECKPOINT_FILE, JSON.stringify({ savedAt: new Date().toISOString(), queue: resumable }, null, 2));
    } catch (e) { /* non-fatal */ }
}

function _loadQueueCheckpoint() {
    try {
        if (!fs.existsSync(QUEUE_CHECKPOINT_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(QUEUE_CHECKPOINT_FILE, 'utf8'));
        // Only restore checkpoints that are less than 10 minutes old
        const age = Date.now() - new Date(raw.savedAt).getTime();
        if (age > 10 * 60 * 1000) {
            fs.unlinkSync(QUEUE_CHECKPOINT_FILE);
            return null;
        }
        return Array.isArray(raw.queue) && raw.queue.length > 0 ? raw.queue : null;
    } catch (e) { return null; }
}

function _clearQueueCheckpoint() {
    try { if (fs.existsSync(QUEUE_CHECKPOINT_FILE)) fs.unlinkSync(QUEUE_CHECKPOINT_FILE); } catch (e) {}
}

// ─── Boat Auto-Selection (Change 1) ──────────────────────────────────────────
// Returns true if the straight-line path to (destX, destZ) crosses >20 consecutive
// water blocks, the destination is >40 blocks away, and the bot is not in End/Nether.
function _shouldUseBoat(destX, destZ) {
    try {
        if (!bot.entity) return false;
        const dim = bot.game?.dimension || 'overworld';
        if (dim === 'the_nether' || dim === 'minecraft:the_nether' ||
            dim === 'the_end' || dim === 'minecraft:the_end') {
            return false;
        }
        const cx = bot.entity.position.x, cz = bot.entity.position.z;
        const dx = destX - cx, dz = destZ - cz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= 40) return false;
        // Sample every 4 blocks along the straight-line path
        const steps = Math.floor(dist / 4);
        if (steps === 0) return false;
        let consecutive = 0;
        let maxConsecutive = 0;
        const waterBlockId = bot.registry.blocksByName['water']?.id;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const sx = cx + dx * t;
            const sz = cz + dz * t;
            // Sample at the bot's current Y and Y-1 to detect water surface
            const bAt = bot.blockAt(new Vec3(Math.floor(sx), Math.floor(bot.entity.position.y), Math.floor(sz)));
            const bBelow = bot.blockAt(new Vec3(Math.floor(sx), Math.floor(bot.entity.position.y) - 1, Math.floor(sz)));
            const isWater = (b) => b && (b.name === 'water' || b.name === 'flowing_water' ||
                                         (waterBlockId !== undefined && b.type === waterBlockId));
            if (isWater(bAt) || isWater(bBelow)) {
                consecutive++;
                if (consecutive > maxConsecutive) maxConsecutive = consecutive;
            } else {
                consecutive = 0;
            }
        }
        return maxConsecutive > 20;
    } catch(e) {
        return false;
    }
}

// ─── Auto-Shredder ────────────────────────────────────────────────────────────
const JUNK_LIST_FILE = path.join(process.cwd(), 'data', 'junk_list.json');
const DEFAULT_JUNK_LIST = [
    'granite', 'diorite', 'andesite', 'tuff', 'calcite',
    'dirt', 'gravel', 'netherrack', 'rotten_flesh',
    'poisonous_potato', 'ink_sac'
];
let _junkList = new Set(DEFAULT_JUNK_LIST);

function _loadJunkList() {
    try {
        if (fs.existsSync(JUNK_LIST_FILE)) {
            _junkList = new Set(JSON.parse(fs.readFileSync(JUNK_LIST_FILE, 'utf8')));
        } else {
            _saveJunkList();
        }
    } catch (e) { _junkList = new Set(DEFAULT_JUNK_LIST); }
}

function _saveJunkList() {
    try {
        const dir = path.dirname(JUNK_LIST_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(JUNK_LIST_FILE, JSON.stringify([..._junkList], null, 2));
    } catch (e) {}
}

// Run only when inventory is nearly full (≤4 free slots)
async function _runAutoShredder() {
    if (!bot.inventory) return;
    const items = bot.inventory.items();
    // Count occupied 36-slot hotbar+main inventory slots
    const usedSlots = new Set(items.filter(i => i.slot >= 9 && i.slot <= 44).map(i => i.slot)).size;
    if (usedSlots < 32) return; // plenty of space, nothing to do
    for (const item of items) {
        if (_junkList.has(item.name) && item.slot >= 9) {
            try {
                await bot.toss(item.type, null, item.count);
                console.log(`[AutoShredder] Discarded ${item.count}x ${item.name}`);
            } catch (e) {}
        }
    }
}

_loadJunkList();

// ─── Self-defense ─────────────────────────────────────────────────────────────
// Always-hostile mobs: attack on sight.
const HOSTILE_MOBS = new Set([
    'zombie', 'skeleton', 'creeper', 'endermite', 'silverfish', 'witch',
    'pillager', 'vindicator', 'evoker', 'vex', 'ravager',
    'phantom', 'drowned', 'husk', 'stray', 'zombie_villager',
    'blaze', 'ghast', 'slime', 'magma_cube',
    'wither_skeleton', 'wither',
    'elder_guardian', 'guardian', 'shulker',
    'hoglin', 'zoglin', 'piglin_brute',
]);

// Neutral mobs: only aggro when provoked. Added to combat when they attack the bot.
const NEUTRAL_MOBS = new Set([
    'enderman', 'zombified_piglin', 'spider', 'cave_spider',
    'wolf', 'bee', 'polar_bear', 'llama', 'trader_llama', 'panda',
]);

// Entity IDs of neutral mobs that are currently aggro'd (have attacked the bot).
const _aggroedNeutrals = new Set();

function isNeutralAggro(ent) {
    return _aggroedNeutrals.has(ent.id);
}

function findNearestHostile(maxDist = 6) {
    if (!bot.entity) return null;
    let nearest = null, minDist = maxDist;
    // Clean up dead/despawned entities from the neutral aggro set
    for (const id of _aggroedNeutrals) {
        const e = Object.values(bot.entities).find(x => x.id === id);
        if (!e || !e.isValid) _aggroedNeutrals.delete(id);
    }
    for (const ent of Object.values(bot.entities)) {
        if (ent === bot.entity || !ent.isValid) continue;
        if (ent.type === 'player') continue;
        const name = (ent.name || '').toLowerCase();
        const isHostile = HOSTILE_MOBS.has(name) || (NEUTRAL_MOBS.has(name) && isNeutralAggro(ent));
        if (!isHostile) continue;
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

// Safety check before any blind forward movement.
// Returns false if lava, fire, magma, or a >3-block cliff lies within 3 steps in angleRad direction.
// Convention: angleRad = atan2(rdz, rdx) where cos(a)=dX, sin(a)=dZ (matches all movement code).
function isSafeForward(angleRad) {
    try {
        const pos = bot.entity.position;
        const fdx = Math.cos(angleRad), fdz = Math.sin(angleRad);
        for (let step = 1; step <= 3; step++) {
            const bx = Math.floor(pos.x + step * fdx);
            const bz = Math.floor(pos.z + step * fdz);
            const by = Math.floor(pos.y);
            for (let dy = 0; dy <= 1; dy++) {
                const b = bot.blockAt(new Vec3(bx, by + dy, bz));
                if (b && (b.name.includes('lava') || b.name.includes('fire') || b.name === 'magma_block')) return false;
            }
            // Require solid ground within 3 blocks below to prevent walking off cliffs
            let hasGround = false;
            for (let dy = -1; dy >= -3; dy--) {
                const b = bot.blockAt(new Vec3(bx, by + dy, bz));
                if (b && b.boundingBox === 'block' && !b.name.includes('lava')) { hasGround = true; break; }
            }
            if (!hasGround) return false;
        }
        return true;
    } catch (_) { return false; }
}

function isAirLikeBlock(b) {
    if (!b) return true;
    return b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
}

function isSolidBridgeSupport(b) {
    if (!b) return false;
    return b.boundingBox === 'block' && !b.name.includes('water') && !b.name.includes('lava');
}

function chooseBridgeBlock(preferredName) {
    const preferredNeedle = (preferredName || '').toLowerCase().trim();
    const items = bot.inventory.items();
    if (!items || items.length === 0) return null;

    const blockKeyFromItemName = (rawName) => {
        const n = (rawName || '').toLowerCase();
        if (!n) return null;
        if (bot.registry.blocksByName[n]) return n;
        const short = n.includes(':') ? n.split(':').pop() : n;
        if (short && bot.registry.blocksByName[short]) return short;
        return null;
    };

    const isClearlyNonPlaceable = (name) => {
        const n = (name || '').toLowerCase();
        if (!n) return true;
        if (n.includes('sword') || n.includes('pickaxe') || n.includes('axe') ||
            n.includes('shovel') || n.includes('hoe') || n.includes('helmet') ||
            n.includes('chestplate') || n.includes('leggings') || n.includes('boots') ||
            n.includes('elytra') || n.includes('jetpack') || n.includes('bow') || n.includes('crossbow') ||
            n.includes('trident') || n.includes('arrow') || n.includes('bucket') ||
            n.includes('boat') || n.includes('minecart') || n.includes('food') ||
            n.includes('potion') || n.includes('torch') || n.includes('rail')) {
            return true;
        }
        return false;
    };

    const isGoodBridgeBlock = (item) => {
        const name = (item?.name || '').toLowerCase();
        if (!name) return false;
        if (isClearlyNonPlaceable(name)) return false;
        const hasBlockMapping = !!blockKeyFromItemName(name);
        if (name.includes('slab') || name.includes('stair') || name.includes('wall') ||
            name.includes('fence') || name.includes('door') || name.includes('trapdoor') ||
            name.includes('pane') || name.includes('torch') || name.includes('carpet') ||
            name.includes('button') || name.includes('pressure_plate') || name.includes('rail') ||
            name.includes('bucket') || name.includes('bed') || name.includes('boat')) {
            return false;
        }
        // Prefer items known to map to a block, but allow modded unknowns as fallback.
        return hasBlockMapping || name.includes(':');
    };

    if (preferredNeedle) {
        const preferred = items
            .filter(isGoodBridgeBlock)
            .filter(i => i.name.toLowerCase().includes(preferredNeedle))
            .sort((a, b) => b.count - a.count)[0];
        if (preferred) return preferred;
    }

    const candidates = items
        .filter(isGoodBridgeBlock)
        .sort((a, b) => b.count - a.count);

    if (candidates.length > 0) return candidates[0];

    // Last-resort fallback: try any non-obviously-non-placeable stack, highest count first.
    const fallback = items
        .filter(i => !isClearlyNonPlaceable(i?.name))
        .sort((a, b) => b.count - a.count)[0] || null;

    if (!fallback) {
        const snapshot = items
            .slice(0, 12)
            .map(i => {
                const n = i?.name || 'unknown';
                return `${n}x${i?.count || 0}[blk:${blockKeyFromItemName(n) ? 'Y' : 'N'}]`;
            })
            .join(', ');
        console.log(`[Actuator] chooseBridgeBlock: no candidate found. Inventory snapshot: ${snapshot}`);
    }

    return fallback;
}

function hasForwardGap(angleRad) {
    try {
        const pos = bot.entity.position;
        const bx = Math.floor(pos.x + Math.cos(angleRad));
        const bz = Math.floor(pos.z + Math.sin(angleRad));
        const by = Math.floor(pos.y);
        const below1 = bot.blockAt(new Vec3(bx, by - 1, bz));
        const below2 = bot.blockAt(new Vec3(bx, by - 2, bz));
        return isAirLikeBlock(below1) && isAirLikeBlock(below2);
    } catch (_) {
        return false;
    }
}

// Broader bridge trigger for edge cases where ground shape confuses hasForwardGap().
function hasLikelyBridgeNeed(angleRad) {
    try {
        const pos = bot.entity.position;
        const by = Math.floor(pos.y);
        const ux = Math.cos(angleRad);
        const uz = Math.sin(angleRad);
        for (let step = 1; step <= 2; step++) {
            const bx = Math.floor(pos.x + step * ux);
            const bz = Math.floor(pos.z + step * uz);
            const foot = bot.blockAt(new Vec3(bx, by, bz));
            const below1 = bot.blockAt(new Vec3(bx, by - 1, bz));
            const below2 = bot.blockAt(new Vec3(bx, by - 2, bz));
            const below3 = bot.blockAt(new Vec3(bx, by - 3, bz));
            const noFooting = isAirLikeBlock(foot) && isAirLikeBlock(below1) && isAirLikeBlock(below2);
            const deepDrop = isAirLikeBlock(below1) && isAirLikeBlock(below2) && isAirLikeBlock(below3);
            if (noFooting || deepDrop) return true;
        }
    } catch (_) {}
    return false;
}

async function tryElytraGapCross(angleRad) {
    try {
        const torso = bot.inventory.slots[bot.getEquipmentDestSlot('torso')];
        if (!torso || torso.name !== 'elytra') return false;
        const rocket = bot.inventory.items().find(i => i.name === 'firework_rocket');
        if (!rocket) return false;

        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        try { await bot.equip(rocket, 'hand'); } catch (_) {}

        const tx = bot.entity.position.x + 18 * Math.cos(angleRad);
        const tz = bot.entity.position.z + 18 * Math.sin(angleRad);
        try { await bot.lookAt(new Vec3(tx, bot.entity.position.y + 2, tz), true); } catch (_) {}

        if (bot.entity.onGround) {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 220));
            bot.setControlState('jump', false);
            await new Promise(r => setTimeout(r, 120));
        }

        try {
            if (bot._client && bot.entity?.id !== undefined) {
                bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 8, jumpBoost: 0 });
            }
        } catch (_) {}

        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        try { bot.activateItem(); } catch (_) {}
        await new Promise(r => setTimeout(r, 900));
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        return true;
    } catch (_) {
        return false;
    }
}

// ── Aviation helpers ──────────────────────────────────────────────────────────

// Inspects the item currently in the torso slot and returns:
//   'elytra'                             → vanilla Elytra
//   { type:'jetpack', mod, config }      → modded Jetpack (dynamic dispatch via JETPACK_MOD_REGISTRY)
//   null                                 → no recognised aviation device
function detectAviationMethod(torsoItem) {
    if (!torsoItem) return null;
    if (torsoItem.name === 'elytra') return 'elytra';
    const rawName = torsoItem.name || '';
    const colonIdx = rawName.indexOf(':');
    const namespace = colonIdx >= 0 ? rawName.slice(0, colonIdx) : null;
    const localName = colonIdx >= 0 ? rawName.slice(colonIdx + 1) : rawName;
    // Explicit mod registry lookup.
    const cfg = namespace ? JETPACK_MOD_REGISTRY[namespace] : null;
    if (cfg && cfg.itemPattern.test(localName)) {
        return { type: 'jetpack', mod: namespace, config: cfg };
    }
    // Generic fallback — covers any mod whose namespace is not listed above.
    if (JETPACK_MOD_REGISTRY._generic.itemPattern.test(localName)) {
        return { type: 'jetpack', mod: namespace || 'unknown', config: JETPACK_MOD_REGISTRY._generic };
    }
    return null;
}

// Fly to (destX, destY, destZ) using a jetpack.
// Phase 1: rise to target altitude using the mod's ascendControl (default: jump).
// Phase 2: navigate horizontally while holding thrust.
// Phase 3: release thrust and descend.
async function flyWithJetpack(destX, destY, destZ, config, cancelToken) {
    const ctrl = config.ascendControl || 'jump';
    const targetY = destY !== null ? destY : bot.entity.position.y;

    bot.chat(`[System] Jetpack engaging — heading to X:${Math.round(destX)} Y:${Math.round(targetY)} Z:${Math.round(destZ)}.`);
    bot.pathfinder.setGoal(null);

    // Phase 1: Ascend to target altitude.
    bot.setControlState(ctrl, true);
    const riseDeadline = Date.now() + 15000;
    while (bot.entity.position.y < targetY - 0.5 && Date.now() < riseDeadline && !cancelToken.cancelled) {
        await new Promise(r => setTimeout(r, 100));
    }

    // Phase 2: Horizontal navigation while holding thrust.
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    const horizDeadline = Date.now() + 90000;
    while (Date.now() < horizDeadline && !cancelToken.cancelled) {
        const dx = destX - bot.entity.position.x;
        const dz = destZ - bot.entity.position.z;
        if (Math.sqrt(dx * dx + dz * dz) < 3) break;
        // Altitude regulation: release thrust briefly if above target, re-engage if below.
        if (bot.entity.position.y > targetY + 3) {
            bot.setControlState(ctrl, false);
        } else {
            bot.setControlState(ctrl, true);
        }
        try { await bot.lookAt(new Vec3(destX, bot.entity.position.y, destZ), true); } catch (_) {}
        await new Promise(r => setTimeout(r, 150));
    }

    // Phase 3: Release thrust and descend to ground.
    bot.setControlState(ctrl, false);
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    const landDeadline = Date.now() + 10000;
    while (!bot.entity.onGround && Date.now() < landDeadline && !cancelToken.cancelled) {
        await new Promise(r => setTimeout(r, 100));
    }
    bot.clearControlStates();
}

// Fly to (destX, destY, destZ) using an Elytra + firework rockets.
// Launches into glide, fires a rocket for propulsion, and steers toward the destination.
async function flyWithElytra(destX, destY, destZ, cancelToken) {
    const rocket = bot.inventory.items().find(i => i.name === 'firework_rocket');
    if (!rocket) {
        bot.chat('[System Error] No firework rockets — cannot launch Elytra.');
        return false;
    }

    bot.chat(`[System] Elytra launch — heading to X:${Math.round(destX)} Y:${Math.round(destY)} Z:${Math.round(destZ)}.`);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    try { await bot.lookAt(new Vec3(destX, destY, destZ), true); } catch (_) {}

    // Jump → open Elytra (entity_action id 8) → rocket boost.
    if (bot.entity.onGround) {
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 220));
        bot.setControlState('jump', false);
        await new Promise(r => setTimeout(r, 120));
    }
    try {
        if (bot._client && bot.entity?.id !== undefined) {
            bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 8, jumpBoost: 0 });
        }
    } catch (_) {}
    try { await bot.equip(rocket, 'hand'); } catch (_) {}
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    try { bot.activateItem(); } catch (_) {}

    // Glide toward destination, re-boosting when speed drops.
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !cancelToken.cancelled) {
        const dx = destX - bot.entity.position.x;
        const dz = destZ - bot.entity.position.z;
        if (Math.sqrt(dx * dx + dz * dz) < 5) break;
        try { await bot.lookAt(new Vec3(destX, destY, destZ), true); } catch (_) {}
        const vel = bot.entity.velocity;
        const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
        if (speed < 0.3) {
            const r2 = bot.inventory.items().find(i => i.name === 'firework_rocket');
            if (r2) { try { await bot.equip(r2, 'hand'); bot.activateItem(); } catch (_) {} }
        }
        await new Promise(r => setTimeout(r, 500));
    }

    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    const landDeadline = Date.now() + 10000;
    while (!bot.entity.onGround && Date.now() < landDeadline && !cancelToken.cancelled) {
        await new Promise(r => setTimeout(r, 100));
    }
    bot.clearControlStates();
    return true;
}

async function tryBridgeForward(angleRad, preferredName, maxPlacements = 3) {
    _lastBridgeFailureReason = null;
    const bridgeBlock = chooseBridgeBlock(preferredName);
    if (!bridgeBlock) {
        _lastBridgeFailureReason = 'no_block';
        bot.chat('[System Error] Cannot bridge: no placeable blocks in inventory.');
        return false;
    }

    // Stop pathfinder and all movement during placement to prevent bot from
    // walking into the void while awaiting async placeBlock calls.
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.setControlState('sneak', true);

    try {
        await bot.equip(bridgeBlock, 'hand');
    } catch (_) { /* equip might fail if already holding it */ }

    const base = bot.entity.position;
    const by = Math.floor(base.y);
    const ux = Math.cos(angleRad);
    const uz = Math.sin(angleRad);

    // Prioritise the face pointing back toward the bot (toward source solid ground).
    // For axis-aligned cardinal movement, the dominant backward cardinal face is tried first.
    // Then all other standard faces are tried as fallbacks.
    const dominantFace = () => {
        // Pick the axis with the larger component and invert it (backward direction).
        if (Math.abs(ux) >= Math.abs(uz)) {
            return new Vec3(ux > 0 ? -1 : 1, 0, 0);
        }
        return new Vec3(0, 0, uz > 0 ? -1 : 1);
    };
    const df = dominantFace();
    const backwardFaces = [
        df,
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1),
        new Vec3(0, 1, 0),
        new Vec3(0, -1, 0),
    ].filter((f, i, arr) =>
        i === 0 || !(f.x === arr[0].x && f.y === arr[0].y && f.z === arr[0].z)
    );

    let placedCount = 0;
    for (let step = 1; step <= maxPlacements; step++) {
        const tx = Math.floor(base.x + step * ux);
        const tz = Math.floor(base.z + step * uz);
        const target = new Vec3(tx, by - 1, tz);
        const existing = bot.blockAt(target);
        if (isSolidBridgeSupport(existing)) { placedCount++; continue; }

        let placed = false;
        for (const face of backwardFaces) {
            const refPos = target.minus(face);
            const refBlock = bot.blockAt(refPos);
            if (!isSolidBridgeSupport(refBlock)) continue;
            try {
                await withTimeout(bot.placeBlock(refBlock, face), 3000, 'bridge place');
                placed = true;
                placedCount++;
                break;
            } catch (_) {
                // Try next face
            }
        }

        if (!placed) break; // Can't place this step — stop here
        await new Promise(r => setTimeout(r, 150));
    }

    bot.setControlState('sneak', false);
    if (placedCount > 0) return true;
    _lastBridgeFailureReason = 'placement_failed';
    return false;
}

function _shortItemName(name) {
    if (!name) return '';
    const n = String(name).toLowerCase();
    return n.includes(':') ? n.split(':').pop() : n;
}

function resolveInventoryItemForTarget(targetName) {
    const wanted = String(targetName || '').toLowerCase().trim();
    if (!wanted) return null;
    const wantedShort = _shortItemName(wanted);
    const inventory = bot.inventory.items();
    if (!inventory.length) return null;

    let exact = inventory.find(i => String(i.name || '').toLowerCase() === wanted);
    if (exact) return exact;
    exact = inventory.find(i => _shortItemName(i.name) === wantedShort);
    if (exact) return exact;

    let fuzzy = inventory.find(i => String(i.name || '').toLowerCase().includes(wanted));
    if (fuzzy) return fuzzy;
    fuzzy = inventory.find(i => _shortItemName(i.name).includes(wantedShort));
    return fuzzy || null;
}

let debouncer = null; // initialized in 'spawn' — used for VeinMiner cascade detection

// ─── Module-level helpers ─────────────────────────────────────────────────────

async function placeItemIntelligently(bot, itemToPlace, timeoutMs) {
    const refs = bot.findBlocks({
        matching: b => b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava' && b.boundingBox === 'block',
        maxDistance: 4,
        count: 50
    });

    refs.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));

    const botPos = bot.entity.position;

    // 1. Try to find a block nearby that doesn't intersect the bot
    for (const refPos of refs) {
        const placePos = refPos.offset(0, 1, 0);
        const blockAbove = bot.blockAt(placePos);

        if (blockAbove && blockAbove.name === 'air') {
            const dx = Math.abs(botPos.x - (placePos.x + 0.5));
            const dz = Math.abs(botPos.z - (placePos.z + 0.5));
            const dy = placePos.y - botPos.y;

            const intersectsBot = dx < 0.8 && dz < 0.8 && dy > -1 && dy < 2;

            if (!intersectsBot) {
                const refBlock = bot.blockAt(refPos);
                try {
                    await bot.equip(itemToPlace, 'hand');
                    const promise = bot.placeBlock(refBlock, new Vec3(0, 1, 0));
                    if (timeoutMs) {
                        await withTimeout(promise, timeoutMs, 'place block');
                    } else {
                        await promise;
                    }
                    return true;
                } catch(e) {
                    console.log(`[Actuator] Intelligent place failed at ${refPos}: ${e.message}`);
                }
            }
        }
    }

    // 2. Fallback: Jump place directly under the bot
    try {
        const botFloored = bot.entity.position.floored();
        const blockBelow = bot.blockAt(botFloored.offset(0, -1, 0));
        if (blockBelow && blockBelow.boundingBox === 'block') {
            await bot.equip(itemToPlace, 'hand');
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 250)); // wait to reach peak jump
            const promise = bot.placeBlock(blockBelow, new Vec3(0, 1, 0));
            bot.setControlState('jump', false);
            if (timeoutMs) {
                await withTimeout(promise, timeoutMs, 'jump place block');
            } else {
                await promise;
            }
            return true;
        }
    } catch(e) {
        bot.setControlState('jump', false);
        console.log(`[Actuator] Jump place failed: ${e.message}`);
    }

    throw new Error('No valid location to place block');
}

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
    'netherite_axe', 'diamond_axe', 'iron_axe', 'netherite_sword', 'diamond_sword', 'iron_sword',
    'stone_axe', 'stone_sword', 'wooden_axe', 'wooden_sword', 'golden_axe', 'golden_sword'
];
async function equipBestWeapon() {
    for (const name of WEAPON_PRIORITY) {
        const w = bot.inventory.items().find(i => i.name === name);
        if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} break; }
    }
    const shield = bot.inventory.items().find(i => i.name === 'shield');
    if (shield) {
        try { await bot.equip(shield, 'off-hand'); } catch (e) {}
    }
}

const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'golden', 'chainmail', 'leather'];
const ARMOR_PIECES = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' };
async function equipBestArmor() {
    for (const [slot, piece] of Object.entries(ARMOR_PIECES)) {
        const destSlot = bot.getEquipmentDestSlot(slot);
        const currentEquipped = bot.inventory.slots[destSlot];
        // Keep Elytra or any jetpack equipped unless explicitly swapped by a direct equip action.
        if (slot === 'torso' && detectAviationMethod(currentEquipped)) continue;
        // Index of currently equipped tier (lower = better; ARMOR_TIERS.length = nothing equipped)
        const currentTierIdx = currentEquipped
            ? ARMOR_TIERS.findIndex(t => currentEquipped.name === `${t}_${piece}`)
            : ARMOR_TIERS.length;
        const effectiveIdx = currentTierIdx === -1 ? ARMOR_TIERS.length : currentTierIdx;

        for (let i = 0; i < effectiveIdx; i++) {
            const a = bot.inventory.items().find(itm => itm.name === `${ARMOR_TIERS[i]}_${piece}`);
            if (a) {
                try {
                    if (currentEquipped) await bot.unequip(slot);
                    await bot.equip(a, slot);
                } catch (e) {}
                break;
            }
        }
    }
}

// ─── Equipment-chest helpers ──────────────────────────────────────────────────

/** True if any armor slot is empty or no weapon exists in inventory. */
function isMissingGear() {
    for (const slot of ['head', 'torso', 'legs', 'feet']) {
        const eq = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
        if (!eq) return true;
    }
    return !WEAPON_PRIORITY.some(name => bot.inventory.items().find(i => i.name === name));
}

/** Block IDs for every equipment-container type: chest, barrel, and all shulker-box colours. */
function getEquipmentContainerIds() {
    const ids = [];
    const reg = bot.registry.blocksByName;
    for (const name of ['chest', 'barrel']) {
        if (reg[name]?.id !== undefined) ids.push(reg[name].id);
    }
    for (const key of Object.keys(reg)) {
        if (key === 'shulker_box' || key.endsWith('_shulker_box')) ids.push(reg[key].id);
    }
    return ids;
}

function _normalizeContainerKind(raw) {
    const t = String(raw || '').toLowerCase();
    if (t.includes('shulker') || t.includes('シュルカー')) return 'shulker';
    if (t.includes('barrel') || t.includes('バレル')) return 'barrel';
    if (t.includes('chest') || t.includes('チェスト') || t.includes('箱')) return 'chest';
    return 'container';
}

function _normalizeItemTargetName(raw) {
    const text = String(raw || '').toLowerCase().trim();
    if (!text) return '';
    const aliases = [
        { re: /(滑らかな石|smooth[_\s-]?stone|smoothstone)/i, id: 'smooth_stone' },
        { re: /(丸石|cobblestone|cobble)/i, id: 'cobblestone' },
        { re: /(石|stone)/i, id: 'stone' },
        { re: /(原木|log)/i, id: 'oak_log' }
    ];
    for (const a of aliases) {
        if (a.re.test(text)) return a.id;
    }
    return text.replace(/[\s-]+/g, '_');
}

function _isContainerBlockByName(name) {
    const n = String(name || '').toLowerCase();
    return n === 'chest' || n === 'trapped_chest' || n === 'barrel' ||
           n === 'shulker_box' || n.endsWith('_shulker_box');
}

function _getContainerBlockIds(kind = 'container') {
    const reg = bot.registry.blocksByName || {};
    const ids = new Set();
    const k = _normalizeContainerKind(kind);
    for (const [name, info] of Object.entries(reg)) {
        if (!info || info.id === undefined) continue;
        const n = String(name || '').toLowerCase();
        if (k === 'chest' && (n === 'chest' || n === 'trapped_chest')) ids.add(info.id);
        else if (k === 'barrel' && n === 'barrel') ids.add(info.id);
        else if (k === 'shulker' && (n === 'shulker_box' || n.endsWith('_shulker_box'))) ids.add(info.id);
        else if (k === 'container' && _isContainerBlockByName(n)) ids.add(info.id);
    }
    return [...ids];
}

function _resolveContainerCoords(action) {
    const candidates = _listContainerCandidates(action);
    return candidates.length > 0 ? candidates[0] : null;
}

function _listContainerCandidates(action) {
    const hasExplicit = [action.x, action.y, action.z].every(v => v !== undefined && v !== null && Number.isFinite(Number(v)));
    if (hasExplicit) {
        return [{ x: Number(action.x), y: Number(action.y), z: Number(action.z), via: 'explicit' }];
    }

    const kind = _normalizeContainerKind(action.container || action.target || 'container');
    const requestedMax = Number.isFinite(Number(action.distance)) ? Number(action.distance) : 96;
    const maxDistance = Math.max(16, Math.min(192, requestedMax));
    const ids = _getContainerBlockIds(kind);
    if (ids.length === 0) return [];

    const positions = [];
    const seen = new Set();
    const radii = [Math.min(32, maxDistance), Math.min(64, maxDistance), Math.min(96, maxDistance), maxDistance]
        .filter((v, i, arr) => v > 0 && arr.indexOf(v) === i)
        .sort((a, b) => a - b);
    for (const r of radii) {
        const found = bot.findBlocks({ matching: ids, maxDistance: r, count: 256 }) || [];
        for (const p of found) {
            const key = `${p.x},${p.y},${p.z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            positions.push(p);
        }
        // Collect more than one candidate so actions can continue when first chest misses.
        if (positions.length >= 8) break;
    }
    if (!positions.length) return [];

    return positions
        .map(p => ({
            x: p.x,
            y: p.y,
            z: p.z,
            via: `nearest_${kind}`,
            _dist: bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z))
        }))
        .sort((a, b) => a._dist - b._dist)
        .map(({ _dist, ...rest }) => rest);
}

function _resolveTargetItemIds(itemTargetName) {
    const normalized = _normalizeItemTargetName(itemTargetName);
    const ids = [];
    const targetGroup = MATERIAL_TAG_GROUPS[normalized];
    if (targetGroup) {
        for (const n of targetGroup) {
            const id = bot.registry.itemsByName[n]?.id || bot.registry.blocksByName[n]?.id;
            if (id !== undefined) ids.push(id);
        }
    } else {
        const id = bot.registry.itemsByName[normalized]?.id || bot.registry.blocksByName[normalized]?.id;
        if (id !== undefined) ids.push(id);
    }
    return ids;
}

async function _withdrawFromOpenedContainer(containerWindow, neededIds, quantity) {
    let taken = 0;
    while (taken < quantity && !currentCancelToken.cancelled) {
        const currentItems = containerWindow.containerItems();
        const match = currentItems.find(i => neededIds.includes(i.type));
        if (!match) break;
        const amountToTake = Math.min(match.count, quantity - taken);
        try {
            await containerWindow.withdraw(match.type, null, amountToTake);
            taken += amountToTake;
        } catch (_) {
            break;
        }
    }
    return taken;
}

async function _depositToOpenedContainer(containerWindow, neededIds, quantity, itemTargetName) {
    let moved = 0;
    while (moved < quantity && !currentCancelToken.cancelled) {
        const inv = bot.inventory.items();
        const stack = inv.find(i => neededIds.includes(i.type)) ||
            inv.find(i => String(i.name || '').toLowerCase().includes(String(itemTargetName || '').toLowerCase()));
        if (!stack) break;
        const amount = Math.min(stack.count, quantity - moved);
        try {
            await containerWindow.deposit(stack.type, null, amount);
            moved += amount;
        } catch (_) {
            break;
        }
    }
    return moved;
}

/**
 * From an already-open container window take at most 1 of each tool/weapon and
 * 1 of each armor piece that the bot is currently missing.  Returns items taken.
 */
async function withdrawNeededEquipment(containerWindow) {
    const equippedNames = new Set(
        ['head', 'torso', 'legs', 'feet']
            .map(s => bot.inventory.slots[bot.getEquipmentDestSlot(s)]?.name)
            .filter(Boolean)
    );
    // Use a mutable set so items taken during this session are not taken again
    const alreadyHaveNames = new Set(bot.inventory.items().map(i => i.name));
    let taken = 0;
    for (const item of containerWindow.containerItems()) {
        if (currentCancelToken.cancelled) break;
        const name = item.name;
        const isGear =
            TOOL_SUFFIXES.some(s => name.endsWith(s)) ||
            ARMOR_TIERS.some(t => Object.values(ARMOR_PIECES).some(p => name === `${t}_${p}`));
        if (!isGear) continue;
        if (equippedNames.has(name)) continue;
        if (alreadyHaveNames.has(name)) continue;
        try {
            await containerWindow.withdraw(item.type, null, 1);
            alreadyHaveNames.add(name); // Prevent taking a second copy this session
            taken++;
        } catch (e) {}
    }
    return taken;
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

    // Issue 5: Ensure graves use pickaxes to break properly
    if (name.includes('grave') || name.includes('tomb') || name.includes('crave') || name.includes('obituary') || name.includes('death')) {
        return 'pickaxe';
    }

    if (name.includes('log') || name.includes('_wood') || name.includes('plank') ||
        name.includes('bamboo_block') || name.includes('bamboo_mosaic') ||
        name.includes('fence') || name.includes('stem') || name.includes('hyphae') ||
        name.includes('chest') || name.includes('barrel') || name.includes('bookshelf') ||
        name.includes('crafting_table') || name.includes('jukebox') || name.includes('note_block') ||
        name.includes('door') || name.includes('trapdoor')) {
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
    'oak_wood', 'spruce_wood', 'birch_wood', 'jungle_wood', 'acacia_wood',
    'dark_oak_wood', 'mangrove_wood', 'cherry_wood',
    // Bamboo (1.20+): bamboo_block is the log-equivalent, bamboo is the plant item
    'bamboo_block', 'stripped_bamboo_block',
]);

// ── Material Tag Groups ─────────────────────────────────────────────────────
// When the bot can't find the exact requested item (e.g. "oak_log" in a birch
// forest), it falls back to any member of the same tag group. This prevents the
// "cannot find Oak logs" failure when other log types are available nearby.
// Issue 9: Use tags instead of hardcoded specific item names.
const _LOG_LIST   = [...LOG_NAMES];
const _PLANK_LIST = [...PLANK_NAMES];
const MATERIAL_TAG_GROUPS = {
    // Any log variant satisfies a request for any specific log type
    oak_log:         _LOG_LIST, spruce_log:    _LOG_LIST, birch_log:     _LOG_LIST,
    jungle_log:      _LOG_LIST, acacia_log:    _LOG_LIST, dark_oak_log:  _LOG_LIST,
    mangrove_log:    _LOG_LIST, cherry_log:    _LOG_LIST, oak_wood:      _LOG_LIST,
    bamboo_block:    _LOG_LIST, stripped_bamboo_block: _LOG_LIST,
    // Any plank variant satisfies a request for any specific plank type
    oak_planks:     _PLANK_LIST, spruce_planks:   _PLANK_LIST, birch_planks:    _PLANK_LIST,
    jungle_planks:  _PLANK_LIST, acacia_planks:   _PLANK_LIST, dark_oak_planks: _PLANK_LIST,
    mangrove_planks:_PLANK_LIST, cherry_planks:   _PLANK_LIST, bamboo_planks:   _PLANK_LIST,
    // Stone variants
    stone:       ['stone', 'andesite', 'granite', 'diorite', 'tuff', 'calcite', 'deepslate'],
    andesite:    ['stone', 'andesite', 'granite', 'diorite'],
    cobblestone: ['cobblestone', 'stone'],
};

// If a block strictly requires a harvest tool, ensureToolFor may obtain/craft one.
// For optional speed tools (for example axes for logs), we prefer to continue
// bare-handed rather than trigger long auto-craft/pathing sequences that can
// disconnect the bot on unstable terrain or busy Forge servers.
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

    const chestId = bot.registry.blocksByName.chest?.id;
    if (chestId !== undefined) {
        const chests = bot.findBlocks({ matching: chestId, maxDistance: 16, count: 5 });
        for (const cpos of chests) {
            if (currentCancelToken.cancelled) return;
            try {
                const chestBlock = bot.blockAt(cpos);
                if (chestBlock) {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(cpos.x, cpos.y, cpos.z, 2)), 10000, 'goto chest', () => bot.pathfinder.setGoal(null));
                    const chestWindow = await bot.openContainer(chestBlock);
                    const neededItems = [`iron_${toolCat}`, `stone_${toolCat}`, `wooden_${toolCat}`, 'iron_ingot', 'cobblestone'];
                    for (const item of chestWindow.containerItems()) {
                        if (neededItems.includes(item.name)) {
                            await chestWindow.withdraw(item.type, null, item.name.endsWith(toolCat) ? 1 : Math.min(item.count, 64));
                        }
                    }
                    bot.closeWindow(chestWindow);
                }
            } catch(e) {
                console.log(`[Actuator] ensureToolFor chest scan: ${e.message}`);
            }
            // Re-check if we now have a tool after looting
            const itemsPostChest = bot.inventory.items();
            if (itemsPostChest.some(i => (hasRequirement && block.harvestTools[i.type]) || (!hasRequirement && i.name.endsWith(toolSuffix)))) {
                await equipBestTool(block); return;
            }
        }
    }

    if (!hasRequirement) {
        console.log(`[Actuator] No ${toolCat} found for ${block.name}. Continuing without optional tool.`);
        return;
    }

    console.log(`[Actuator] No ${toolCat} found for ${block.name}. Auto-crafting tool...`);
    bot.chat(`[System] Need a ${toolCat}. Crafting one...`);

    const countBy = (set) => bot.inventory.items().filter(i => set.has(i.name)).reduce((s, i) => s + i.count, 0);

    // ── Step 1: Gather logs if short on planks ──────────────────────────────
    if (currentCancelToken.cancelled) return;
    const sticksHave = bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0);
    const planksNeeded = 3 + (sticksHave >= 2 ? 0 : 2);

    if (countBy(PLANK_NAMES) < planksNeeded) {
        const logsNeeded = Math.ceil((planksNeeded - countBy(PLANK_NAMES)) / 4);
        const logsHave = countBy(LOG_NAMES);
        console.log(`[auto-tool] planksNeeded=${planksNeeded} planksHave=${countBy(PLANK_NAMES)} logsNeeded=${logsNeeded} logsHave=${logsHave} inv=[${bot.inventory.items().map(i=>`${i.name}x${i.count}`).join(',')}]`);
        if (logsHave < logsNeeded) {
            for (const logName of LOG_NAMES) {
                if (currentCancelToken.cancelled) return;
                const logBlockId = bot.registry.blocksByName[logName]?.id;
                if (!logBlockId) continue;
                // Use function matcher (not numeric ID) to force full block-by-block scan.
                // Forge servers have palette state IDs that differ from prismarine-block's
                // vanilla expectations — numeric matching triggers a palette pre-check that
                // skips sections containing the block, returning 0 results even when blocks
                // are present. Function matcher bypasses palette pre-check entirely.
                // 32b: full function matcher scan (handles Forge block registry remapping).
                // 64b fallback: numeric palette matcher — safe radius (no EPIPE risk), works for
                // natural world logs which use standard vanilla palette IDs.
                // IMPORTANT: Never use function matcher + useExtraInfo beyond 32b — at 64b it
                // scans ~1.1M blocks, blocking the event loop long enough for server keepalive
                // to fire (EPIPE disconnection).
                const matchFn = b => b && b.type === logBlockId;
                let logBlocks = bot.findBlocks({ matching: matchFn, maxDistance: 32, count: logsNeeded * 4, useExtraInfo: true });
                if (logBlocks.length === 0) {
                    // Fallback: 64b numeric scan for natural world trees
                    logBlocks = bot.findBlocks({ matching: logBlockId, maxDistance: 64, count: logsNeeded * 4 });
                }
                if (logBlocks.length === 0) continue;
                // Prefer trunk-level logs (close to bot's y) over high canopy logs.
                // collectBlock can't easily navigate to logs 6+ blocks above ground.
                const botFloorY = Math.floor(bot.entity.position.y);
                const lowLogs = logBlocks.filter(p => Math.abs(p.y - botFloorY) <= 5);
                const sortedLogs = lowLogs.length > 0 ? lowLogs : logBlocks;
                // Limit to 2 candidates — spending too many timeouts here burns the
                // 120-s collect budget before the main collect loop even starts.
                for (const logPos of sortedLogs.slice(0, 2)) {
                    if (currentCancelToken.cancelled) return;
                    if (countBy(LOG_NAMES) >= logsNeeded) break;
                    // Use GoalNear(4)+dig instead of collectBlock.collect().
                    // collectBlock requires strict adjacency and its pathfinder hits thinkTimeout
                    // on hilly/canopy terrain. GoalNear(4) only needs to be within 4 blocks
                    // which is achievable from the base of the tree.
                    try {
                        await withTimeout(
                            bot.pathfinder.goto(new goals.GoalNear(logPos.x, logPos.y, logPos.z, 4)),
                            8000, `auto-goto ${logName}`, () => bot.pathfinder.setGoal(null)
                        );
                        const b = bot.blockAt(logPos);
                        if (b && b.type === logBlockId) {
                            await bot.dig(b, true);
                            // Wait briefly for the dropped item to auto-collect
                            await new Promise(r => setTimeout(r, 800));
                        }
                    } catch (e) { console.log(`[Actuator] auto-tool: ${e.message}`); }
                    if (movements) bot.pathfinder.setMovements(movements);
                }
                if (countBy(LOG_NAMES) >= logsNeeded) break;
            }
        }

        // ── Step 2: Craft planks ──────────────────────────────────────────────
        if (currentCancelToken.cancelled) return;
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
    if (currentCancelToken.cancelled) return;
    if (bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0) < 2) {
        const anyPlank = bot.inventory.items().find(i => PLANK_NAMES.has(i.name));
        if (anyPlank) {
            const stickId = bot.registry.itemsByName['stick']?.id;
            const r = stickId !== undefined ? bot.recipesFor(stickId, null, 1, false)[0] : null;
            if (r) try { await bot.craft(r, 1, null); } catch (e) { console.log(`[Actuator] auto-tool craft sticks: ${e.message}`); }
        }
    }

    // ── Step 4: Find or create crafting table, craft tool ───────────────────
    if (currentCancelToken.cancelled) return;
    const ctBlockId = bot.registry.blocksByName['crafting_table']?.id;
    let craftingTable = ctBlockId !== undefined ? bot.findBlock({ matching: ctBlockId, maxDistance: 32 }) : null;

    if (!craftingTable) {
        const ctItemId = bot.registry.itemsByName['crafting_table']?.id ?? ctBlockId;
        if (ctItemId !== undefined && !bot.inventory.items().find(i => i.name === 'crafting_table')) {
            const ctR = bot.recipesFor(ctItemId, null, 1, false)[0];
            if (ctR) try { await bot.craft(ctR, 1, null); } catch (e) { console.log(`[Actuator] auto-tool craft table: ${e.message}`); }
        }
        if (currentCancelToken.cancelled) return;
        const ctItem = bot.inventory.items().find(i => i.name === 'crafting_table');
        if (ctItem) {
            try {
                await placeItemIntelligently(bot, ctItem, null);
                craftingTable = ctBlockId !== undefined ? bot.findBlock({ matching: ctBlockId, maxDistance: 8 }) : null;
            } catch (e) { console.log(`[Actuator] auto-tool place table: ${e.message}`); }
        }
    }

    if (currentCancelToken.cancelled) return;
    if (craftingTable) {
        let toolName = `wooden_${toolCat}`;
        const invNames = new Set(bot.inventory.items().map(i => i.name));
        if (invNames.has('iron_ingot')) { toolName = `iron_${toolCat}`; }
        else if (invNames.has('cobblestone')) { toolName = `stone_${toolCat}`; }

        const toolId = bot.registry.itemsByName[toolName]?.id;
        if (toolId !== undefined) {
            const toolR = bot.recipesFor(toolId, null, 1, true)[0];
            if (toolR) {
                try {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 1)), 15000, 'goto table (auto-tool)', () => bot.pathfinder.setGoal(null));
                    if (currentCancelToken.cancelled) return;
                    await bot.craft(toolR, 1, craftingTable);
                    bot.chat(`[System] Crafted a ${toolName}!`);
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

// Issue 9: Use any burnable fuel tag, not just hardcoded oak/spruce.
const FUEL_PRIORITY = [
    'coal', 'charcoal', 'coal_block', 'blaze_rod',
    // All log variants (8 smelts each)
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
    'dark_oak_log', 'mangrove_log', 'cherry_log', 'bamboo_block',
    // All plank variants (1.5 smelts each)
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks',
    // Other burnables
    'stick', 'bamboo', 'dried_kelp_block', 'bookshelf', 'crafting_table',
];

const STRUCTURE_MARKERS = {
    nether_fortress: ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs'],
    ocean_monument:  ['prismarine', 'prismarine_bricks', 'dark_prismarine', 'sea_lantern'],
    stronghold:      ['end_portal_frame', 'mossy_stone_bricks', 'cracked_stone_bricks'],
    village:         ['hay_block', 'bell', 'villager_spawn_egg'],
    nether_portal:   ['nether_portal'],
};

// ─── Ender Dragon Special Combat ────────────────────────────────────────────
// Vanilla Ender Dragon fight strategy:
//   Phase 1 (flying): Destroy all end crystals first (they regenerate dragon HP).
//                     Use bow+arrows to shoot crystals from a distance.
//   Phase 2 (perching): Dragon lands on fountain — melee-attack its head.
//   Throughout: flee area_effect_cloud (dragon breath) entities.
async function _killEnderDragon(cancelToken, combatMs, combatStart) {
    bot.chat('[System] Initiating Ender Dragon combat protocol.');
    _inBossCombat = true; // Suppress generic AoE/passive-defense intervals during boss fight

    // --- Phase 1: Destroy end crystals ---
    // End Crystals sit atop obsidian pillars (y≈50-100). Approach their XZ base,
    // then shoot upward with a bow. Skip phase entirely if no crystals present.
    const hasCrystalsInitially = Object.values(bot.entities).some(e =>
        e.isValid && (e.name || '').toLowerCase() === 'end_crystal');
    if (!hasCrystalsInitially) {
        bot.chat('[System] No end crystals present — skipping Phase 1.');
    } else {
        bot.chat('[System] Phase 1: Destroying end crystals...');
        const crystalPhaseDeadline = combatStart + Math.min(combatMs * 0.6, 90000);
        while (Date.now() < crystalPhaseDeadline && !cancelToken.cancelled) {
            let crystal = null;
            let minCrystalDist = Infinity;
            for (const ent of Object.values(bot.entities)) {
                if (!ent.isValid) continue;
                if ((ent.name || '').toLowerCase() !== 'end_crystal') continue;
                const d = bot.entity.position.distanceTo(ent.position);
                if (d < minCrystalDist) { minCrystalDist = d; crystal = ent; }
            }
            if (!crystal) {
                console.log('[DragonCombat] No more end crystals. Proceeding to Phase 2.');
                break;
            }

            // Flee breath clouds
            const breathCloud = Object.values(bot.entities).find(e => {
                const n = (e.name || e.displayName || '').toLowerCase();
                return (n.includes('area_effect_cloud') || n.includes('dragon_breath')) &&
                    bot.entity.position.distanceTo(e.position) < 6;
            });
            if (breathCloud) {
                const bp = bot.entity.position;
                const fa = Math.atan2(bp.z - breathCloud.position.z, bp.x - breathCloud.position.x);
                bot.pathfinder.setGoal(new goals.GoalXZ(Math.round(bp.x + 8 * Math.cos(fa)), Math.round(bp.z + 8 * Math.sin(fa))), true);
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const hasBow = bot.inventory.items().some(i => i.name === 'bow');
            const hasArrows = bot.inventory.items().some(i => i.name === 'arrow');
            if (hasBow && hasArrows) {
                // Approach the base of the pillar (XZ only — don't try to pathfind to the top)
                const xzDist = Math.sqrt(
                    (bot.entity.position.x - crystal.position.x) ** 2 +
                    (bot.entity.position.z - crystal.position.z) ** 2);
                if (xzDist > 30) {
                    bot.pathfinder.setGoal(new goals.GoalXZ(Math.round(crystal.position.x), Math.round(crystal.position.z)), true);
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                // In range — shoot upward at the crystal
                const bow = bot.inventory.items().find(i => i.name === 'bow');
                try { await bot.equip(bow, 'hand'); } catch (_) {}
                try {
                    await bot.lookAt(crystal.position.offset(0, 0.5, 0));
                    bot.activateItem();
                    await new Promise(r => setTimeout(r, 1000));
                    bot.deactivateItem();
                } catch (_) {}
            } else {
                // No bow — approach XZ base and try melee (only works for low pillars)
                const xzDist2 = Math.sqrt(
                    (bot.entity.position.x - crystal.position.x) ** 2 +
                    (bot.entity.position.z - crystal.position.z) ** 2);
                if (xzDist2 > 4) {
                    bot.pathfinder.setGoal(new goals.GoalXZ(Math.round(crystal.position.x), Math.round(crystal.position.z)), true);
                    await new Promise(r => setTimeout(r, 3000));
                }
                if (bot.entity.position.distanceTo(crystal.position) <= 5) {
                    try { await bot.lookAt(crystal.position); bot.attack(crystal); } catch (_) {}
                    await new Promise(r => setTimeout(r, 400));
                    const bp2 = bot.entity.position;
                    const ea = Math.atan2(bp2.z - crystal.position.z, bp2.x - crystal.position.x);
                    bot.pathfinder.setGoal(new goals.GoalXZ(Math.round(bp2.x + 8 * Math.cos(ea)), Math.round(bp2.z + 8 * Math.sin(ea))), true);
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // --- Phase 2: Fight the dragon ---
    // Strategy: Stay near the CENTER of the End island (XZ≈0,0 — the fountain area).
    // The dragon circles overhead; shoot upward with a bow for the flying phase.
    // When the dragon perches (velocity≈0), it lands on the fountain at y≈64 —
    // move toward it and shoot/melee. Do NOT chase the dragon around the perimeter.
    bot.chat('[System] Phase 2: Moving to fountain center...');
    await equipBestWeapon();
    const hasBow2 = bot.inventory.items().some(i => i.name === 'bow');
    const hasArrows2 = bot.inventory.items().some(i => i.name === 'arrow');
    if (hasBow2 && hasArrows2) {
        const bow = bot.inventory.items().find(i => i.name === 'bow');
        try { await bot.equip(bow, 'hand'); } catch (_) {}
    }
    // Move to center for best overhead shooting coverage
    bot.pathfinder.setGoal(new goals.GoalXZ(0, 0), true);
    await new Promise(r => setTimeout(r, 3000));
    bot.chat('[System] Phase 2: Attacking Ender Dragon...');

    while (!cancelToken.cancelled && Date.now() - combatStart < combatMs) {
        let dragon = null;
        for (const ent of Object.values(bot.entities)) {
            if ((ent.name || '').toLowerCase() === 'ender_dragon' && ent.isValid) { dragon = ent; break; }
        }
        if (!dragon) {
            bot.chat('[System] Ender Dragon defeated!');
            return true;
        }

        // Flee breath clouds (priority)
        const breathCloud2 = Object.values(bot.entities).find(e => {
            const n = (e.name || e.displayName || '').toLowerCase();
            return (n.includes('area_effect_cloud') || n.includes('dragon_breath')) &&
                bot.entity.position.distanceTo(e.position) < 8;
        });
        if (breathCloud2) {
            const bp = bot.entity.position;
            const fa = Math.atan2(bp.z - breathCloud2.position.z, bp.x - breathCloud2.position.x);
            bot.pathfinder.setGoal(new goals.GoalXZ(Math.round(bp.x + 10 * Math.cos(fa)), Math.round(bp.z + 10 * Math.sin(fa))), true);
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        const dist = bot.entity.position.distanceTo(dragon.position);
        const dv = dragon.velocity;
        const isPerching = dv && Math.abs(dv.x) < 0.1 && Math.abs(dv.z) < 0.1 && Math.abs(dv.y) < 0.05;

        // Check for bow and arrows (Step 4)
        const hasBowNow = bot.inventory.items().some(i => i.name === 'bow');
        const hasArrowsNow = bot.inventory.items().some(i => i.name === 'arrow');

        if (!isPerching) {
            // Dragon is flying
            if (hasBowNow && hasArrowsNow && dist <= 80) {
                // Step 5: Attack with bow
                if (bot.heldItem?.name !== 'bow') {
                    const bow = bot.inventory.items().find(i => i.name === 'bow');
                    if (bow) try { await bot.equip(bow, 'hand'); } catch (_) {}
                }
                try {
                    await bot.lookAt(dragon.position.offset(0, (dragon.height || 8) * 0.5, 0));
                    bot.activateItem();
                    await new Promise(r => setTimeout(r, 1000));
                    bot.deactivateItem();
                } catch (_) {}
            } else {
                // Out of range or no bow: Wait ~20 blocks away from center to avoid breath blocking path
                const bp = bot.entity.position;
                const distToCenter = Math.sqrt(bp.x * bp.x + bp.z * bp.z);
                if (distToCenter < 15 || distToCenter > 25) {
                    // Try to stay on the outer edge of the fountain area (r≈20)
                    const angle = Math.atan2(bp.z, bp.x);
                    bot.pathfinder.setGoal(new goals.GoalXZ(Math.round(20 * Math.cos(angle)), Math.round(20 * Math.sin(angle))), true);
                } else {
                    bot.pathfinder.setGoal(null);
                }
            }
        } else {
            // Dragon is perching (Step 6)
            if (dist > 5) {
                // Ensure bot climbs up the fountain by using GoalNear to target the dragon's actual position rather than just the XZ base
                bot.pathfinder.setGoal(new goals.GoalNear(Math.round(dragon.position.x), Math.round(dragon.position.y), Math.round(dragon.position.z), 2), true);
                await new Promise(r => setTimeout(r, 800));
                continue;
            }

            bot.pathfinder.setGoal(null);

            // Equip axe
            const axes = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'];
            let axeEquipped = false;
            for (const axe of axes) {
                const found = bot.inventory.items().find(i => i.name === axe);
                if (found) {
                    try { await bot.equip(found, 'hand'); axeEquipped = true; } catch (_) {}
                    break;
                }
            }
            if (!axeEquipped) {
                await equipBestWeapon();
            }

            const headPos = dragon.position.offset(0, (dragon.height || 8) * 0.7, 0);
            try { await bot.lookAt(headPos); } catch (_) {}

            // Attack frequently, do not wait for jump crit timing as requested.
            try { bot.attack(dragon); } catch (_) {}
            // Axe cooldown is usually around ~1s, sword is ~0.625s. We'll swing every 600ms.
            await new Promise(r => setTimeout(r, 600));
        }

        // Eat if low health
        if (bot.health < 8) {
            const food = getBestFoodItem();
            if (food) {
                bot.pathfinder.setGoal(null);
                try { await bot.equip(food, 'hand'); await bot.consume(); } catch (_) {}
                if (hasBowNow && hasArrowsNow && !isPerching) {
                    const bow = bot.inventory.items().find(i => i.name === 'bow');
                    if (bow) try { await bot.equip(bow, 'hand'); } catch (_) {}
                } else { await equipBestWeapon(); }
            }
        }

        await new Promise(r => setTimeout(r, 150));
    }
    _inBossCombat = false; // Re-enable generic intervals
    return dragon ? false : true;
}

// ─── Idle Combat Loop ─────────────────────────────────────────────────────────
// Issue 6: Runs after completing all queued actions (and as the 'wait' action).
// Fights hostiles within 16 blocks and chases those within 12 blocks,
// until the cancel token is set (new instruction arrives or bot is stopped).
async function runWaitLoop() {
    while (!currentCancelToken.cancelled && !_inStopMode) {
        if (!bot.entity || bot.health <= 0) {
            await new Promise(r => setTimeout(r, 300));
            continue;
        }
        const hostile = findNearestHostile(16);
        if (hostile && hostile.isValid) {
            const dist = bot.entity.position.distanceTo(hostile.position);
            // Don't look at non-aggro'd Endermen — eye contact triggers aggro
            const isNonAggroEnderman = (hostile.name || '').toLowerCase() === 'enderman' && !_aggroedNeutrals.has(hostile.id);
            if (!isNonAggroEnderman) {
                try { await bot.lookAt(hostile.position.offset(0, (hostile.height || 1.8) * 0.5, 0)); } catch(e) {}
            }
            if (dist <= 3.5) {
                bot.attack(hostile);
                equipBestWeapon().catch(() => {});
                const offHand = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
                if (offHand?.name === 'shield') bot.activateItem(true);
            } else if (dist <= 12) {
                bot.pathfinder.setGoal(new goals.GoalFollow(hostile, 2), true);
            }
        } else {
            if (bot.pathfinder.isMoving()) bot.pathfinder.setGoal(null);
            bot.deactivateItem();
        }
        await new Promise(r => setTimeout(r, 300));
    }
    try { bot.pathfinder.setGoal(null); bot.deactivateItem(); } catch(e) {}
}

// ─── Main Action Processor ────────────────────────────────────────────────────

async function processActionQueue() {
    if (isExecuting) return;
    isExecuting = true;

    // Mid-air guard: wait for the bot to land before executing any actions.
    // Prevents the "flying" kick that occurs when pathfinder or equip calls
    // are issued while the bot is momentarily airborne (after a jump, knock-
    // back, or terrain transition). Waits at most 3 seconds.
    if (bot.entity && !bot.entity.onGround && !bot.entity.isInWater) {
        let landWait = 0;
        while (bot.entity && !bot.entity.onGround && !bot.entity.isInWater && landWait < 3000) {
            await new Promise(r => setTimeout(r, 50));
            landWait += 50;
        }
    }

    while (actionQueue.length > 0) {
        const action = actionQueue.shift();
        const timeoutMs = action.timeout ? action.timeout * 1000 : 30000;

        try {
            if (!action || !action.action) continue;
            currentAction = action.action;
            if (currentCancelToken.cancelled) break;
            // VDS-001: trace action start
            debugTrace.logEvent(botId, 'start', action.action, bot.entity?.position);

            // Guard: if the server connection is dead, don't try to send packets.
            // This prevents ECONNRESET errors when the server disconnected during LLM processing.
            if (bot._client?.socket?.writable !== true) {
                console.log(`[Actuator] Socket not writable — dropping action '${action.action}' and triggering recovery.`);
                currentCancelToken.cancelled = true;
                actionQueue = [];
                if (!_disconnectedNotified) {
                    _disconnectedNotified = true;
                    process.send({ type: 'ERROR', category: 'Disconnected', details: 'Socket not writable before action' });
                }
                break;
            }

            if (action.target && typeof action.target === 'string') {
                action.target = action.target.replace(/^[^:]+:/, '');
            }

            // ── chat ──────────────────────────────────────────────────────────
            if (action.action === 'chat') {
                bot.chat(action.message);

            // ── loot_chest_special ────────────────────────────────────────────
            } else if (action.action === 'loot_chest_special') {
                const targetPos = action.target;
                if (targetPos) {
                    try {
                        bot.chat(`[System] Heading to equipment chest...`);
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2)), 30000, 'goto equipment container', () => bot.pathfinder.setGoal(null));
                        const block = bot.blockAt(new Vec3(targetPos.x, targetPos.y, targetPos.z));
                        const bname = block?.name || '';
                        const isContainer = bname === 'chest' || bname === 'barrel' ||
                                            bname === 'shulker_box' || bname.endsWith('_shulker_box');
                        if (block && isContainer) {
                            const containerWindow = await bot.openContainer(block);
                            const taken = await withdrawNeededEquipment(containerWindow);
                            bot.closeWindow(containerWindow);
                            bot.chat(`[System] Geared up! Took ${taken} item(s) from the chest.`);
                            await equipBestArmor();
                            await equipBestWeapon();
                        }
                    } catch(e) {
                        console.log(`[Actuator] Failed to loot equipment container: ${e.message}`);
                    }
                }

            // ── withdraw_from_container ───────────────────────────────────────
            } else if (action.action === 'withdraw_from_container') {
                const candidates = _listContainerCandidates(action);
                const itemTargetName = _normalizeItemTargetName(action.item || action.target);
                const quantity = Math.max(1, parseInt(action.quantity, 10) || 1);

                if (candidates.length === 0 || !itemTargetName) {
                    bot.chat(`[System Error] Missing target, item, or coordinates for withdraw_from_container.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'Missing target, item, or coordinates for withdraw_from_container.', environment: getEnvironmentContext() } });
                } else {
                    bot.chat(`[System] Checking nearby containers for ${quantity} ${itemTargetName}...`);
                    try {
                        const neededIds = _resolveTargetItemIds(itemTargetName);
                        let takenTotal = 0;
                        let checked = 0;
                        for (const c of candidates) {
                            if (currentCancelToken.cancelled || takenTotal >= quantity) break;
                            checked++;
                            await withTimeout(bot.pathfinder.goto(new goals.GoalNear(c.x, c.y, c.z, 2)), 30000, 'goto container', () => bot.pathfinder.setGoal(null));
                            const block = bot.blockAt(new Vec3(c.x, c.y, c.z));
                            const bname = block?.name || '';
                            const isContainer = _isContainerBlockByName(bname);
                            if (!block || !isContainer) continue;
                            const containerWindow = await bot.openContainer(block);
                            const taken = await _withdrawFromOpenedContainer(containerWindow, neededIds, quantity - takenTotal);
                            bot.closeWindow(containerWindow);
                            takenTotal += taken;
                        }

                        if (takenTotal > 0) {
                            bot.chat(`[System] Took ${takenTotal}/${quantity} ${itemTargetName} after checking ${checked} container(s).`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully withdrew ${takenTotal}/${quantity} ${itemTargetName}.`, environment: getEnvironmentContext() } });
                        } else {
                            bot.chat(`[System Error] Nearby containers did not have ${itemTargetName}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Nearby containers did not contain ${itemTargetName}.`, environment: getEnvironmentContext() } });
                        }
                    } catch(e) {
                        console.log(`[Actuator] Failed to withdraw from container: ${e.message}`);
                        bot.chat(`[System Error] Could not reach container.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Could not reach container: ${e.message}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── deposit_to_container / store_in_container ───────────────────
            } else if (action.action === 'deposit_to_container' || action.action === 'store_in_container') {
                const candidates = _listContainerCandidates(action);
                const itemTargetName = _normalizeItemTargetName(action.item || action.target);
                const quantity = Math.max(1, parseInt(action.quantity, 10) || 1);

                if (candidates.length === 0 || !itemTargetName) {
                    bot.chat('[System Error] Missing item or container coordinates for deposit_to_container.');
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'Missing item or container coordinates for deposit_to_container.', environment: getEnvironmentContext() } });
                } else {
                    bot.chat(`[System] Checking nearby containers to deposit ${quantity} ${itemTargetName}...`);
                    try {
                        const neededIds = _resolveTargetItemIds(itemTargetName);
                        let movedTotal = 0;
                        let checked = 0;
                        for (const c of candidates) {
                            if (currentCancelToken.cancelled || movedTotal >= quantity) break;
                            checked++;
                            await withTimeout(bot.pathfinder.goto(new goals.GoalNear(c.x, c.y, c.z, 2)), 30000, 'goto container for deposit', () => bot.pathfinder.setGoal(null));
                            const block = bot.blockAt(new Vec3(c.x, c.y, c.z));
                            const bname = block?.name || '';
                            const isContainer = _isContainerBlockByName(bname);
                            if (!block || !isContainer) continue;
                            const containerWindow = await bot.openContainer(block);
                            const moved = await _depositToOpenedContainer(containerWindow, neededIds, quantity - movedTotal, itemTargetName);
                            bot.closeWindow(containerWindow);
                            movedTotal += moved;
                        }

                        if (movedTotal > 0) {
                            bot.chat(`[System] Deposited ${movedTotal}/${quantity} ${itemTargetName} after checking ${checked} container(s).`);
                            process.send({ type: 'USER_CHAT', data: { username: 'System', message: `Deposited ${movedTotal}/${quantity} ${itemTargetName}.`, environment: getEnvironmentContext() } });
                        } else {
                            bot.chat(`[System Error] I could not deposit ${itemTargetName} into nearby containers.`);
                            process.send({ type: 'USER_CHAT', data: { username: 'System', message: `Could not deposit ${itemTargetName} into nearby containers.`, environment: getEnvironmentContext() } });
                        }
                    } catch (e) {
                        bot.chat('[System Error] Could not deposit into container.');
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: `deposit_to_container failed: ${e.message}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── transfer_between_containers (multi-trip) ───────────────────
            } else if (action.action === 'transfer_between_containers') {
                const itemTargetName = _normalizeItemTargetName(action.item || action.target);
                const quantity = Math.max(1, parseInt(action.quantity, 10) || 1);
                const from = action.from || {};
                const to = action.to || {};
                const fromAction = {
                    target: from.target || from.container || action.fromTarget || 'container',
                    container: from.container,
                    x: from.x,
                    y: from.y,
                    z: from.z,
                    distance: from.distance || action.distance
                };
                const toAction = {
                    target: to.target || to.container || action.toTarget || 'container',
                    container: to.container,
                    x: to.x,
                    y: to.y,
                    z: to.z,
                    distance: to.distance || action.distance
                };

                const srcCandidates = _listContainerCandidates(fromAction);
                const dstCandidates = _listContainerCandidates(toAction);
                if (srcCandidates.length === 0 || dstCandidates.length === 0 || !itemTargetName) {
                    bot.chat('[System Error] transfer_between_containers requires source, destination, and item.');
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'transfer_between_containers missing source/destination/item.', environment: getEnvironmentContext() } });
                    continue;
                }

                const neededIds = _resolveTargetItemIds(itemTargetName);
                let remaining = quantity;
                let movedTotal = 0;
                let trip = 0;
                const maxTrips = Math.max(1, parseInt(action.maxTrips, 10) || 64);

                while (remaining > 0 && !currentCancelToken.cancelled && trip < maxTrips) {
                    trip++;
                    let taken = 0;
                    for (const src of srcCandidates) {
                        if (taken > 0 || currentCancelToken.cancelled) break;
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(src.x, src.y, src.z, 2)), 30000, 'goto source container', () => bot.pathfinder.setGoal(null));
                        const srcBlock = bot.blockAt(new Vec3(src.x, src.y, src.z));
                        if (!srcBlock || !_isContainerBlockByName(srcBlock.name)) continue;
                        const srcWin = await bot.openContainer(srcBlock);
                        const takeTarget = Math.min(remaining, 1024);
                        taken = await _withdrawFromOpenedContainer(srcWin, neededIds, takeTarget);
                        bot.closeWindow(srcWin);
                    }
                    if (taken <= 0) break;

                    let moved = 0;
                    for (const dst of dstCandidates) {
                        if (moved > 0 || currentCancelToken.cancelled) break;
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(dst.x, dst.y, dst.z, 2)), 30000, 'goto destination container', () => bot.pathfinder.setGoal(null));
                        const dstBlock = bot.blockAt(new Vec3(dst.x, dst.y, dst.z));
                        if (!dstBlock || !_isContainerBlockByName(dstBlock.name)) continue;
                        const dstWin = await bot.openContainer(dstBlock);
                        moved = await _depositToOpenedContainer(dstWin, neededIds, taken, itemTargetName);
                        bot.closeWindow(dstWin);
                    }

                    movedTotal += moved;
                    remaining -= moved;
                    if (moved <= 0) break;
                }

                bot.chat(`[System] Transfer complete: moved ${movedTotal}/${quantity} ${itemTargetName} in ${trip} trip(s).`);
                process.send({ type: 'USER_CHAT', data: { username: 'System', message: `Transferred ${movedTotal}/${quantity} ${itemTargetName} in ${trip} trip(s).`, environment: getEnvironmentContext() } });

            // ── find_and_equip ────────────────────────────────────────────────
            } else if (action.action === 'find_and_equip') {
                try {
                    const containerIds = getEquipmentContainerIds();
                    if (containerIds.length === 0) throw new Error('No container types in registry.');
                    const radius = action.distance || 32;
                    const found = bot.findBlocks({ matching: containerIds, maxDistance: radius, count: 20 });
                    const equipContainers = found.filter(cpos => {
                        const below = bot.blockAt(cpos.offset(0, -1, 0));
                        return below && below.name === 'smooth_stone';
                    });
                    if (equipContainers.length === 0) {
                        const msg = `No equipment chests found within ${radius} blocks.`;
                        bot.chat(`[System] ${msg}`);
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: msg, environment: getEnvironmentContext() } });
                    } else {
                        let totalTaken = 0;
                        for (const cpos of equipContainers) {
                            if (currentCancelToken.cancelled) break;
                            try {
                                await withTimeout(bot.pathfinder.goto(new goals.GoalNear(cpos.x, cpos.y, cpos.z, 2)), 30000, 'goto equipment container', () => bot.pathfinder.setGoal(null));
                                const block = bot.blockAt(new Vec3(cpos.x, cpos.y, cpos.z));
                                if (block) {
                                    const win = await bot.openContainer(block);
                                    totalTaken += await withdrawNeededEquipment(win);
                                    bot.closeWindow(win);
                                    _lootedChests.add(`${cpos.x},${cpos.y},${cpos.z}`);
                                }
                            } catch (e) {
                                console.log(`[Actuator] find_and_equip: error at ${cpos}: ${e.message}`);
                            }
                        }
                        await equipBestArmor();
                        await equipBestWeapon();
                        const msg = `Geared up from ${equipContainers.length} chest(s). Took ${totalTaken} item(s).`;
                        bot.chat(`[System] ${msg}`);
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: msg, environment: getEnvironmentContext() } });
                    }
                } catch (e) {
                    console.log(`[Actuator] find_and_equip failed: ${e.message}`);
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: `find_and_equip failed: ${e.message}`, environment: getEnvironmentContext() } });
                }

            // ── recover_gravestone ────────────────────────────────────────────
            } else if (action.action === 'recover_gravestone') {
                const targetPos = action.target;
                if (targetPos) {
                    try {
                        // Issue 3: cross-dimension recovery — if death was in a different dimension,
                        // navigate to the appropriate portal first, then retry recovery there.
                        const deathDim = targetPos.dimension || 'overworld';
                        const currentDim = bot.game?.dimension || 'overworld';
                        if (deathDim !== currentDim) {
                            bot.chat(`[System] I need to travel to ${deathDim} to recover my grave.`);
                            const portalTarget = (deathDim === 'the_nether' || deathDim === 'nether') ? 'nether' : 'end';
                            actionQueue.unshift(
                                { action: 'navigate_portal', target: portalTarget },
                                { action: 'recover_gravestone', target: targetPos }
                            );
                            continue;
                        }

                        bot.chat(`[System] Navigating to death coordinates X:${Math.round(targetPos.x)} Y:${Math.round(targetPos.y)} Z:${Math.round(targetPos.z)}...`);
                        // Issue 1: Nether has complex terrain (lava, ceiling) so a single GoalNear
                        // fails with "no path". Use the same 32-block XZ step loop as goto to
                        // approach incrementally — each small hop is within pathfinder budget.
                        {
                            const REC_STEP = 32;
                            const wpTimeout = Math.max(timeoutMs, 90000);
                            let recRem = Math.sqrt(
                                (targetPos.x - bot.entity.position.x) ** 2 +
                                (targetPos.z - bot.entity.position.z) ** 2
                            );
                            let recStuck = 0;
                            while (recRem > 2 && !currentCancelToken.cancelled) {
                                const cx = bot.entity.position.x, cz = bot.entity.position.z;
                                const rdx = targetPos.x - cx, rdz = targetPos.z - cz;
                                const a = Math.atan2(rdz, rdx);
                                const wx = recRem > REC_STEP ? cx + REC_STEP * Math.cos(a) : targetPos.x;
                                const wz = recRem > REC_STEP ? cz + REC_STEP * Math.sin(a) : targetPos.z;
                                try {
                                    await withTimeout(
                                        bot.pathfinder.goto(new goals.GoalXZ(Math.round(wx), Math.round(wz))),
                                        wpTimeout, 'recover step', () => bot.pathfinder.setGoal(null)
                                    );
                                } catch (stepErr) {
                                    console.log(`[Actuator] recover step err: ${stepErr.message}`);
                                    if (stepErr.message?.toLowerCase().includes('no path')) { recStuck++; }
                                }
                                const newRem = Math.sqrt(
                                    (targetPos.x - bot.entity.position.x) ** 2 +
                                    (targetPos.z - bot.entity.position.z) ** 2
                                );
                                if (newRem <= 2) break;
                                if (newRem >= recRem - 0.5) { recStuck++; } else { recStuck = 0; }
                                if (recStuck >= 3) { console.log('[Actuator] recover stuck 3× — aborting nav, searching nearby'); break; }
                                recRem = newRem;
                            }
                            // Final precise approach
                            try {
                                await withTimeout(
                                    bot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2)),
                                    30000, 'recover final', () => bot.pathfinder.setGoal(null)
                                );
                            } catch (_) {}
                        }

                        // Wait for chunks to load — grave may be just outside loaded range on arrival
                        try { await bot.waitForChunksToLoad(); } catch (e) {}
                        await new Promise(r => setTimeout(r, 1000));

                        // Issue 3: search a 32-block radius (was 10) and include 'soul' containers
                        // as well as any block whose name includes 'grave', 'tomb', or 'crave'
                        const graveIds = Object.values(bot.registry.blocksByName)
                            .filter(b => {
                                const n = b.name.toLowerCase();
                                return n.includes('grave') || n.includes('tomb') || n.includes('crave') || n.includes('obituary') || n.includes('death');
                            })
                            .map(b => b.id);

                        let recovered = false;
                        for (const radius of [8, 16, 32]) {
                            if (graveIds.length > 0) {
                                const graveBlocks = bot.findBlocks({ matching: graveIds, maxDistance: radius, count: 10 });
                                if (graveBlocks.length > 0) {
                                    bot.chat(`[System] Found GraveStone at distance ${radius}. Moving to it...`);
                                    const graveBlock = bot.blockAt(graveBlocks[0]);
                                    await withTimeout(
                                        bot.pathfinder.goto(new goals.GoalNear(graveBlock.position.x, graveBlock.position.y, graveBlock.position.z, 1)),
                                        60000, 'goto grave', () => bot.pathfinder.setGoal(null)
                                    );
                                    // Break the gravestone to drop items as the mod expects it to be destroyed
                                    await equipBestTool(graveBlock);
                                    try { await bot.dig(graveBlock, 'ignore'); } catch(e) { console.log(`[Actuator] dig grave error: ${e.message}`); }
                                    await new Promise(r => setTimeout(r, 1500));
                                    bot.chat(`[System] Recovered items from GraveStone.`);
                                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'Successfully recovered GraveStone items.', environment: getEnvironmentContext() } });
                                    await equipBestArmor();
                                    await equipBestWeapon();
                                    recovered = true;

                                    // Issue 2: Mark death as recovered
                                    try {
                                        if (fs.existsSync(DEATHS_FILE)) {
                                            const deaths = JSON.parse(fs.readFileSync(DEATHS_FILE, 'utf8'));
                                            // Find the specific death to mark as recovered. Since we are targeting targetPos, we can match time or just the latest pending.
                                            let updated = false;
                                            for (let i = deaths.length - 1; i >= 0; i--) {
                                                if (deaths[i].status === 'pending' && deaths[i].x === targetPos.x && deaths[i].y === targetPos.y && deaths[i].z === targetPos.z) {
                                                    deaths[i].status = 'recovered';
                                                    updated = true;
                                                    break;
                                                }
                                            }
                                            // Fallback: just mark latest pending as recovered
                                            if (!updated) {
                                                for (let i = deaths.length - 1; i >= 0; i--) {
                                                    if (deaths[i].status === 'pending') {
                                                        deaths[i].status = 'recovered';
                                                        break;
                                                    }
                                                }
                                            }
                                            fs.writeFileSync(DEATHS_FILE, JSON.stringify(deaths, null, 2));
                                        }
                                    } catch (_) {}

                                    console.log('[Actuator] Recovery complete. Death marker should be gone.');
                                    break;
                                }
                            }
                        }
                        if (!recovered) {
                            bot.chat(`[System Error] Could not find a GraveStone block within 32 blocks.`);
                            process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'GraveStone not found. Items may have despawned.', environment: getEnvironmentContext() } });

                            // Issue 2: Mark as incomplete
                            try {
                                if (fs.existsSync(DEATHS_FILE)) {
                                    const deaths = JSON.parse(fs.readFileSync(DEATHS_FILE, 'utf8'));
                                    for (let i = deaths.length - 1; i >= 0; i--) {
                                        if (deaths[i].status === 'pending' && deaths[i].x === targetPos.x && deaths[i].y === targetPos.y && deaths[i].z === targetPos.z) {
                                            deaths[i].status = 'incomplete';
                                            break;
                                        }
                                    }
                                    fs.writeFileSync(DEATHS_FILE, JSON.stringify(deaths, null, 2));
                                }
                            } catch (_) {}
                        }
                    } catch (e) {
                        console.log(`[Actuator] Failed to recover grave: ${e.message}`);
                        bot.chat(`[System Error] Failed to reach GraveStone.`);

                        // Issue 2: Mark as incomplete
                        try {
                            if (fs.existsSync(DEATHS_FILE)) {
                                const deaths = JSON.parse(fs.readFileSync(DEATHS_FILE, 'utf8'));
                                for (let i = deaths.length - 1; i >= 0; i--) {
                                    if (deaths[i].status === 'pending' && deaths[i].x === targetPos.x && deaths[i].y === targetPos.y && deaths[i].z === targetPos.z) {
                                        deaths[i].status = 'incomplete';
                                        break;
                                    }
                                }
                                fs.writeFileSync(DEATHS_FILE, JSON.stringify(deaths, null, 2));
                            }
                        } catch (_) {}
                    }
                }

            // ── dump_chunks ───────────────────────────────────────────────────
            } else if (action.action === 'dump_chunks') {
                bot.chat("[System] Dumping loaded chunks to chunk_dump.json...");
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
            } else if (action.action === 'patch_config') {
                // Issue 12: Runtime config patch — supports preset name or key/value object
                // Examples: { action:'patch_config', preset:'combat_aggressive' }
                //           { action:'patch_config', values:{ MELEE_RANGE:5 } }
                //           { action:'patch_config', save:'my_preset' }
                //           { action:'patch_config', list:true }
                if (action.list) {
                    const names = listPresets();
                    bot.chat(`[Config] Saved presets: ${names.length > 0 ? names.join(', ') : '(none)'}`);
                } else if (action.save) {
                    const result = savePreset(action.save, action.values || null);
                    bot.chat(`[Config] ${result.message}`);
                } else {
                    const target = action.preset || action.values;
                    if (!target) {
                        bot.chat('[Config] Error: provide preset name or values object.');
                    } else {
                        const result = patchConfig(target);
                        if (result.ok) {
                            const desc = Object.entries(result.applied).map(([k,v]) => `${k}=${v}`).join(', ');
                            bot.chat(`[Config] Applied: ${desc}`);
                        } else {
                            bot.chat(`[Config] ${result.message}`);
                        }
                    }
                }

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

                bot.chat(`[System] ${message}`);
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
                const tracked = getTrackedPlayerSnapshot(action.target);
                if (targetEntity || tracked) {
                    // Improvement 2: Disable digging during follow to prevent erratic block mining
                    // while moving. The bot should navigate around obstacles, not through them.
                    const savedCanDigCome = movements ? movements.canDig : true;
                    if (movements) {
                        movements.canDig = false;
                        bot.pathfinder.setMovements(movements);
                    }

                    bot.chat(`[System] Following ${action.target}!`);
                    if (targetEntity?.isValid) {
                        bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, 2), true);
                    } else {
                        bot.pathfinder.setGoal(new goals.GoalNear(tracked.x, tracked.y, tracked.z, 3), true);
                    }
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Now following ${action.target}.`, environment: getEnvironmentContext() } });

                    // Hold the queue slot until a 'stop' command cancels the token.
                    // Also monitor the goal — if something external clears it (e.g. the
                    // pathfinder's own stop(), or a bug), re-set it so following continues.
                    await new Promise(resolve => {
                        let lastKnown = tracked ? { ...tracked } : null;
                        let lastSeenAt = tracked ? Date.now() : 0;
                        let missingSince = 0;
                        const check = setInterval(async () => {
                            if (currentCancelToken.cancelled) {
                                clearInterval(check);
                                bot.pathfinder.setGoal(null);
                                resolve();
                                return;
                            }
                            // Re-validate: target still visible?
                            const t = bot.players[action.target]?.entity;
                            let p = getTrackedPlayerSnapshot(action.target);
                            if (t && t.isValid) {
                                lastKnown = {
                                    x: t.position.x,
                                    y: t.position.y,
                                    z: t.position.z,
                                    dimension: bot.game?.dimension || null,
                                    updatedAt: Date.now()
                                };
                                lastSeenAt = Date.now();
                                missingSince = 0;
                                const dxNow = t.position.x - bot.entity.position.x;
                                const dzNow = t.position.z - bot.entity.position.z;
                                const distNow = Math.hypot(dxNow, dzNow);
                                if (distNow > 2.5) {
                                    const afNow = Math.atan2(dzNow, dxNow);
                                    if (!isSafeForward(afNow) && (hasForwardGap(afNow) || hasLikelyBridgeNeed(afNow))) {
                                        try { await tryBridgeForward(afNow, action.block || action.material, 2); } catch (_) {}
                                    }
                                }
                                if (!(bot.pathfinder.goal instanceof goals.GoalFollow)) {
                                    bot.pathfinder.setGoal(new goals.GoalFollow(t, 2), true);
                                }
                                return;
                            }
                            if (p && Date.now() - (p.updatedAt || 0) > 120000) {
                                for (const [k, v] of _externalPlayerPositions.entries()) {
                                    if (v === p || _normPlayerName(k) === _normPlayerName(action.target)) {
                                        _externalPlayerPositions.delete(k);
                                    }
                                }
                                p = null;
                            }
                            if (p) {
                                lastKnown = p;
                                lastSeenAt = Date.now();
                                missingSince = 0;
                            }

                            if (!p && lastKnown && Date.now() - lastSeenAt <= 30000) {
                                p = lastKnown;
                            }

                            if (!p) {
                                if (!missingSince) missingSince = Date.now();
                                if (Date.now() - missingSince < 15000) {
                                    return;
                                }
                                clearInterval(check);
                                bot.pathfinder.setGoal(null);
                                bot.chat(`[System Error] Lost sight of ${action.target}.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Lost sight of ${action.target}.`, environment: getEnvironmentContext() } });
                                resolve();
                                return;
                            }

                            if (bot.game?.dimension && p.dimension && bot.game.dimension !== p.dimension) {
                                clearInterval(check);
                                bot.pathfinder.setGoal(null);
                                bot.chat(`[System] ${action.target} moved to ${p.dimension}; come finished in current dimension.`);
                                resolve();
                                return;
                            }

                            const dx = p.x - bot.entity.position.x;
                            const dz = p.z - bot.entity.position.z;
                            const dist = Math.hypot(dx, dz);
                            if (dist > 2.5) {
                                const af = Math.atan2(dz, dx);
                                if (!isSafeForward(af) && (hasForwardGap(af) || hasLikelyBridgeNeed(af))) {
                                    try { await tryBridgeForward(af, action.block || action.material, 2); } catch (_) {}
                                }
                            }

                            // If the goal was cleared externally, restore it
                            if (!bot.pathfinder.goal || !(bot.pathfinder.goal instanceof goals.GoalNear)) {
                                bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 3), true);
                            }
                        }, 700);
                    });

                    // Restore canDig after come action ends
                    if (movements) {
                        movements.canDig = savedCanDigCome;
                        bot.pathfinder.setMovements(movements);
                    }
                } else {
                    bot.chat(`[System Error] I cannot see ${action.target}.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to find ${action.target}.`, environment: getEnvironmentContext() } });
                }

            // ── goto (waypoints, internal, journeyMap, /locate, no distance cap) ─
            } else if (action.action === 'goto') {
                // Issue 1: 32-block steps halve the A* search space vs the previous 64,
                // eliminating the "Took too long to decide path" timeout on complex terrain.
                const WAYPOINT_STEP = 32;
                let destX = action.x;
                let destY = action.y;
                let destZ = action.z;
                let destDimension = action.dimension || null;
                let gotoAborted = false;
                let gotoAbortReason = '';
                const gotoRetryCount = Number(action._gotoRetryCount || 0);

                if (action.target && typeof action.target === 'string') {
                    const targetName = action.target.toLowerCase();
                    const normalizedTarget = normalizeStructureTarget(action.target);

                    // 1. Check internal waypoints first
                    const internalWP = findWaypoint(action.target);
                    if (internalWP) {
                        destX = internalWP.x;
                        destY = internalWP.y;
                        destZ = internalWP.z;
                        destDimension = internalWP.dimension || null;
                        bot.chat(`[System] Going to waypoint "${internalWP.name}" at X:${destX}, Y:${destY}, Z:${destZ}${destDimension ? ` (${destDimension})` : ''}`);

                    // 2. Check structure names → use /locate
                    } else if (STRUCTURE_NAMES[normalizedTarget] || STRUCTURE_NAMES[targetName]) {
                        const structureId = STRUCTURE_NAMES[normalizedTarget] || STRUCTURE_NAMES[targetName];
                        bot.chat(`[System] Locating ${action.target}...`);
                        bot.chat(`/locate structure minecraft:${structureId}`);

                        const locateResult = await waitForLocateResult(12000);

                        if (!locateResult || locateResult.error) {
                            const details = locateResult?.error ? ` (${locateResult.error.slice(0, 120)})` : '';
                            bot.chat(`[System Error] Could not locate ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Could not locate structure ${action.target}${details}. Try alias names like end_city or nether_fortress.`, environment: getEnvironmentContext() } });
                            continue;
                        }
                        destX = locateResult.x;
                        destZ = locateResult.z;
                        destY = undefined;
                        bot.chat(`[System] ${action.target} found at X:${destX}, Z:${destZ}. Navigating...`);

                    // 3. Fall back to JourneyMap waypoints
                    } else {
                        const wpPath = path.join(process.cwd(), 'data', 'journeymap', 'waypoints');
                        let foundWaypoint = false;
                        if (fs.existsSync(wpPath)) {
                            const files = fs.readdirSync(wpPath).filter(f => f.endsWith('.json'));
                            for (const file of files) {
                                try {
                                    const data = JSON.parse(fs.readFileSync(path.join(wpPath, file), 'utf8'));
                                    if (data.name && data.name.toLowerCase() === targetName) {
                                        destX = data.x;
                                        destY = data.y;
                                        destZ = data.z;
                                        foundWaypoint = true;
                                        bot.chat(`[System] Found JourneyMap waypoint ${data.name} at X:${destX}, Y:${destY}, Z:${destZ}`);
                                        break;
                                    }
                                } catch(e) {}
                            }
                        }
                        if (!foundWaypoint) {
                            bot.chat(`[System Error] Could not find waypoint or coordinates for ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Waypoint ${action.target} not found.`, environment: getEnvironmentContext() } });
                            continue;
                        }
                    }
                }

                // Goal 5: Cross-dimension travel — navigate to the right portal first
                if (destDimension && bot.game && bot.game.dimension !== destDimension) {
                    const currentDim = bot.game.dimension;
                    let neededPortal;
                    if (destDimension === 'the_nether' || destDimension === 'nether') {
                        neededPortal = 'nether_portal';
                    } else if (destDimension === 'the_end' || destDimension === 'end') {
                        neededPortal = 'end_portal';
                    } else {
                        neededPortal = 'nether_portal'; // return from nether
                    }
                    bot.chat(`[System] Cross-dimension travel required. Searching for ${neededPortal}...`);
                    actionQueue.unshift(
                        { action: 'navigate_portal', target: neededPortal === 'nether_portal' ? 'nether' : 'end' },
                        { action: 'goto', x: destX, y: destY, z: destZ, dimension: destDimension }
                    );
                    continue;
                }

                // Per-waypoint timeout: 120s minimum.
                // At worst-case movement speed (~2 b/s through water/climbing) a 64-block
                // step takes 32s; 120s gives 3.7× safety margin without masking real hangs.
                const wpTimeout = Math.max(timeoutMs, 120000);

                // Change 1: Increase liquidCost to discourage long-distance water pathfinding.
                if (movements) {
                    movements.liquidCost = 8;
                    bot.pathfinder.setMovements(movements);
                }

                // Change 1: Boat auto-selection — if the path crosses >20 consecutive water blocks
                // and the destination is >40 blocks away, use boat action instead.
                if (destX !== undefined && destZ !== undefined && _shouldUseBoat(destX, destZ)) {
                    const hasBoat = bot.inventory.items().some(i => i.name.includes('boat'));
                    const hasOakPlanks = bot.inventory.items().some(i => i.name === 'oak_planks');
                    const hasOakLog = bot.inventory.items().some(i => i.name === 'oak_log' || i.name.endsWith('_log'));
                    const canCraftBoat = hasBoat || hasOakPlanks || hasOakLog;
                    if (canCraftBoat) {
                        console.log(`[Actuator] goto: detected water-heavy path to (${Math.round(destX)},${Math.round(destZ)}). Switching to boat action.`);
                        bot.chat('[System] Detected large water body ahead. Using boat for travel.');
                        actionQueue.unshift({ action: 'boat', x: destX, z: destZ, timeout: action.timeout || 120 });
                        continue;
                    }
                }

                // Change 3: Warn if goto destination is inside a safe zone.
                if (destX !== undefined && destZ !== undefined && bot.entity) {
                    const currentDimForSZ = bot.game?.dimension || 'overworld';
                    const destPosForSZ = new Vec3(destX, destY !== undefined ? destY : bot.entity.position.y, destZ);
                    if (_isInSafeZone(destPosForSZ, currentDimForSZ)) {
                        console.log(`[Actuator] goto: destination (${Math.round(destX)}, ${Math.round(destZ)}) is inside a safe zone. Movement allowed but warning issued.`);
                        bot.chat('[System] Warning: destination is inside a safe zone.');
                    }
                }

                if (destY !== undefined) {
                    bot.chat(`[System] Moving to X:${Math.round(destX)}, Y:${destY}, Z:${Math.round(destZ)}.`);
                    const curY = bot.entity.position.y;
                    const xzDist3 = Math.sqrt((destX - bot.entity.position.x) ** 2 + (destZ - bot.entity.position.z) ** 2);

                    // Issue 3: For distant XYZ targets, use XZ stepping first to avoid
                    // trying to A*-plan a single huge 3D route (which times out).
                    // Only do the precise XYZ approach for the last 32 blocks.
                    if (xzDist3 > 64) {
                        // Phase 1: navigate to XZ vicinity using step loop
                        let lr3 = xzDist3, sk3 = 0;
                        // Issue 4: Discourage tunneling on long trips
                        const savedCanDig = movements.canDig;
                        movements.canDig = false;
                        bot.pathfinder.setMovements(movements);

                        while (!currentCancelToken.cancelled) {
                            const cx3 = bot.entity.position.x, cz3 = bot.entity.position.z;
                            const rdx3 = destX - cx3, rdz3 = destZ - cz3;
                            const rem3 = Math.sqrt(rdx3 * rdx3 + rdz3 * rdz3);
                            if (rem3 <= 32) break;
                            if (rem3 >= lr3 - 3) {
                                if (++sk3 >= 4) {
                                    bot.setControlState('jump', true);
                                    await new Promise(r => setTimeout(r, 400));
                                    bot.setControlState('jump', false);
                                    sk3 = 0; lr3 = rem3;
                                    // If stuck, briefly allow digging to escape
                                    movements.canDig = true;
                                    bot.pathfinder.setMovements(movements);
                                }
                            } else {
                                sk3 = 0;
                                if (movements.canDig !== false) {
                                    movements.canDig = false;
                                    bot.pathfinder.setMovements(movements);
                                }
                            }
                            lr3 = rem3;
                            const a3 = Math.atan2(rdz3, rdx3);
                            const wx3 = rem3 > WAYPOINT_STEP ? cx3 + WAYPOINT_STEP * Math.cos(a3) : destX;
                            const wz3 = rem3 > WAYPOINT_STEP ? cz3 + WAYPOINT_STEP * Math.sin(a3) : destZ;
                            try {
                                await withTimeout(bot.pathfinder.goto(new goals.GoalXZ(wx3, wz3)), wpTimeout, 'goto XYZ step', () => bot.pathfinder.setGoal(null));
                            } catch (e) {
                                console.log(`[Actuator] XYZ step error: ${e.message}`);
                                movements.canDig = true;
                                bot.pathfinder.setMovements(movements);
                                // Issue 3: half-step fallback — try 16-block step with a lower
                                // thinkTimeout so the bot pauses at most 3s instead of 15s.
                                const cx3f = bot.entity.position.x, cz3f = bot.entity.position.z;
                                const a3f = Math.atan2(destZ - cz3f, destX - cx3f);
                                const hx3 = cx3f + 16 * Math.cos(a3f);
                                const hz3 = cz3f + 16 * Math.sin(a3f);
                                const prevThink3 = bot.pathfinder.thinkTimeout;
                                bot.pathfinder.thinkTimeout = 3000;
                                try {
                                    await withTimeout(bot.pathfinder.goto(new goals.GoalXZ(hx3, hz3)), 6000, 'XYZ half-step', () => bot.pathfinder.setGoal(null));
                                } catch (_) {
                                    // Last resort: force-walk toward destination for 1.5s.
                                    // Only execute if the path ahead is free of lava and cliffs.
                                    if (isSafeForward(a3f)) {
                                        bot.pathfinder.setGoal(null);
                                        try {
                                            await bot.lookAt(new Vec3(cx3f + 100 * Math.cos(a3f), bot.entity.position.y, cz3f + 100 * Math.sin(a3f)));
                                        } catch (_2) {}
                                        bot.setControlState('forward', true);
                                        bot.setControlState('sprint', true);
                                        await new Promise(r => setTimeout(r, 1500));
                                        bot.setControlState('forward', false);
                                        bot.setControlState('sprint', false);
                                    } else {
                                        const bridgeHint = action.bridge_block || action.block || action.material;
                                        if (hasForwardGap(a3f) && await tryBridgeForward(a3f, bridgeHint, 2)) {
                                            bot.chat('[System] Bridged over a gap. Continuing movement...');
                                        } else {
                                            console.log('[Actuator] XYZ force-walk aborted: hazard ahead.');
                                        }
                                    }
                                }
                                bot.pathfinder.thinkTimeout = prevThink3;
                            }
                        }
                        movements.canDig = savedCanDig;
                        bot.pathfinder.setMovements(movements);
                        // Phase 2: final XYZ approach (with no-dig preference if going down)
                        if (!currentCancelToken.cancelled) {
                            if (destY < curY - 10 && movements) {
                                const savedCanDig = movements.canDig;
                                movements.canDig = false;
                                bot.pathfinder.setMovements(movements);
                                try {
                                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(destX, destY, destZ, 2)), wpTimeout, 'final XYZ no-dig', () => bot.pathfinder.setGoal(null));
                                } catch (e) {}
                                movements.canDig = savedCanDig;
                                bot.pathfinder.setMovements(movements);
                            } else if (!currentCancelToken.cancelled) {
                                await withTimeout(bot.pathfinder.goto(new goals.GoalNear(destX, destY, destZ, 2)), wpTimeout, 'final XYZ', () => bot.pathfinder.setGoal(null)).catch(() => {});
                            }
                        }
                    } else if (destY < curY - 10 && movements) {
                        const savedCanDig = movements.canDig;
                        movements.canDig = false;
                        bot.pathfinder.setMovements(movements);
                        try {
                            await withTimeout(bot.pathfinder.goto(new goals.GoalNear(destX, destY, destZ, 2)), Math.min(wpTimeout, 45000), 'goto XYZ no-dig', () => bot.pathfinder.setGoal(null));
                        } catch (e) {}
                        movements.canDig = savedCanDig;
                        bot.pathfinder.setMovements(movements);
                    } else {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(destX, destY, destZ, 2)), wpTimeout, 'goto XYZ', () => bot.pathfinder.setGoal(null));
                    }
                } else {
                    const dx0 = destX - bot.entity.position.x, dz0 = destZ - bot.entity.position.z;
                    const total = Math.sqrt(dx0 * dx0 + dz0 * dz0);
                    bot.chat(`[System] Moving to X:${Math.round(destX)}, Z:${Math.round(destZ)}${total > WAYPOINT_STEP ? ` (~${Math.round(total)} blocks)` : ''}.`);

                    // Issue 2: Path cache — try to reuse the last successful route to this dest.
                    const _dim = bot.game?.dimension || 'overworld';
                    const _cacheKey = getPathCacheKey(destX, destZ, _dim);
                    const _pathCache = loadPathCache();
                    const _cachedEntry = _pathCache[_cacheKey];
                    let _cacheWps = (_cachedEntry && Date.now() - _cachedEntry.ts < PATH_CACHE_MAX_AGE_MS)
                        ? [..._cachedEntry.waypoints] : null;
                    let _cacheIdx = 0;
                    const _visitedWps = []; // track for saving on success
                    let _bridgeLock = null; // Keep heading after bridging to avoid repeated micro-reroutes.
                    let _lastBridgeNoticeAt = 0;

                    // Issue 4: Discourage tunneling on long trips
                    const savedCanDig = movements.canDig;
                    // Note: Do not disable digging in the End dimension because End Stone is harder to navigate around without digging,
                    // and disabling it causes the bot to spasm click End Stone instead of mining it.
                    const isEndDimension = bot.game?.dimension === 'the_end' || bot.game?.dimension === 'minecraft:the_end';
                    if (total > 64 && !isEndDimension) {
                        movements.canDig = false;
                        bot.pathfinder.setMovements(movements);
                    }

                    // ── Streaming lookahead goto ─────────────────────────────────────────────
                    // Computes the next 32-block waypoint from the current position.
                    // Uses the path cache if available, else fresh A* direction.
                    // Returns null when already within 4 blocks of the destination.
                    const _computeNextStreamWp = (cx, cz) => {
                        // Bridge lock: keep advancing in a fixed direction for a few handoffs
                        // after a bridge placement so pathfinder doesn't keep detouring to
                        // tiny nearby islands every 2-3 blocks.
                        if (_bridgeLock && _bridgeLock.stepsLeft > 0) {
                            const remLock = Math.sqrt((destX - cx) ** 2 + (destZ - cz) ** 2);
                            if (remLock <= 4) return null;
                            _bridgeLock.stepsLeft--;
                            const stepLen = Math.min(WAYPOINT_STEP, Math.max(12, remLock));
                            return {
                                x: cx + stepLen * Math.cos(_bridgeLock.angle),
                                z: cz + stepLen * Math.sin(_bridgeLock.angle)
                            };
                        }

                        if (_cacheWps) {
                            const rdx = destX - cx, rdz = destZ - cz;
                            // Advance past cache entries the bot has already passed
                            while (_cacheIdx < _cacheWps.length) {
                                const cw = _cacheWps[_cacheIdx];
                                const cdist = Math.sqrt((cw.x - cx) ** 2 + (cw.z - cz) ** 2);
                                const isAhead = (cw.x - cx) * rdx + (cw.z - cz) * rdz > 0;
                                if (cdist > 8 && isAhead) break;
                                _cacheIdx++;
                            }
                            if (_cacheIdx < _cacheWps.length) {
                                return { x: _cacheWps[_cacheIdx].x, z: _cacheWps[_cacheIdx].z };
                            }
                            // Cache exhausted — fall through to fresh A*
                            _cacheWps = null;
                        }
                        const rdx = destX - cx, rdz = destZ - cz;
                        const rem = Math.sqrt(rdx * rdx + rdz * rdz);
                        if (rem <= 4) return null;
                        if (rem > WAYPOINT_STEP) {
                            const a = Math.atan2(rdz, rdx);
                            return { x: cx + WAYPOINT_STEP * Math.cos(a), z: cz + WAYPOINT_STEP * Math.sin(a) };
                        }
                        return { x: destX, z: destZ };
                    };

                    // HANDOFF_DIST: hand off to the next waypoint goal this many blocks early.
                    // The pathfinder starts computing the next segment while the bot is still
                    // moving — eliminating any inter-segment stop.
                    const HANDOFF_DIST = 14;
                    // STALL_MS: ms without movement before triggering stuck recovery.
                    const STALL_MS = 4000;

                    // Start the first segment immediately (streaming/dynamic goal)
                    let _sw = _computeNextStreamWp(bot.entity.position.x, bot.entity.position.z);
                    if (_sw) {
                        bot.pathfinder.setGoal(new goals.GoalXZ(_sw.x, _sw.z), true);
                    }

                    let _stLastPos  = bot.entity.position.clone();
                    let _stLastTime = Date.now();
                    let _stuckCount = 0;

                    while (!currentCancelToken.cancelled) {
                        await new Promise(r => setTimeout(r, 250)); // poll at ~4 Hz

                        const cx = bot.entity.position.x, cz = bot.entity.position.z;
                        const rdx = destX - cx, rdz = destZ - cz;
                        const rem = Math.sqrt(rdx * rdx + rdz * rdz);
                        if (rem <= 4) break;

                        // Re-enable digging when close to destination
                        if (rem <= 32 && movements.canDig === false) {
                            movements.canDig = savedCanDig;
                            bot.pathfinder.setMovements(movements);
                        }

                        // Proactive bridge extension: when a void gap is directly ahead,
                        // place bridge blocks immediately instead of waiting for STALL_MS.
                        // This removes the repeated "wait 4s -> place 2-3 blocks" cadence.
                        {
                            const afNow = Math.atan2(rdz, rdx);
                            if (!isSafeForward(afNow) && (hasForwardGap(afNow) || hasLikelyBridgeNeed(afNow))) {
                                const bridgeHintNow = action.bridge_block || action.block || action.material;
                                if (await tryBridgeForward(afNow, bridgeHintNow, 6)) {
                                    _bridgeLock = { angle: afNow, stepsLeft: 4 };
                                    if (Date.now() - _lastBridgeNoticeAt > 5000) {
                                        bot.chat('[System] Void gap detected. Bridged forward. Continuing...');
                                        _lastBridgeNoticeAt = Date.now();
                                    }
                                    _stLastPos = bot.entity.position.clone();
                                    _stLastTime = Date.now();
                                    _stuckCount = 0;
                                    _sw = _computeNextStreamWp(bot.entity.position.x, bot.entity.position.z);
                                    if (!_sw) break;
                                    bot.pathfinder.setGoal(new goals.GoalXZ(_sw.x, _sw.z), true);
                                    continue;
                                }
                            }
                        }

                        // Movement progress tracking (time-based instead of per-step)
                        const moved = Math.sqrt((cx - _stLastPos.x) ** 2 + (cz - _stLastPos.z) ** 2);
                        if (moved > 0.5) {
                            _stLastPos = bot.entity.position.clone();
                            _stLastTime = Date.now();
                            _stuckCount = 0;
                        }

                        const stalled = Date.now() - _stLastTime;
                        if (stalled > STALL_MS) {
                            _stLastTime = Date.now();
                            _stLastPos  = bot.entity.position.clone();
                            _stuckCount++;

                            // Priority: void/gap ahead — bridge immediately regardless of stuck tier.
                            // This prevents the jump→sidestep→reset cycle that stops bridge recovery
                            // from ever being reached when stuckCount keeps resetting from sidestep motion.
                            {
                                const af0 = Math.atan2(rdz, rdx);
                                const bridgeHint0 = action.bridge_block || action.block || action.material;
                                if (!isSafeForward(af0) && (hasForwardGap(af0) || hasLikelyBridgeNeed(af0))) {
                                    if (await tryBridgeForward(af0, bridgeHint0, 8)) {
                                        _bridgeLock = { angle: af0, stepsLeft: 4 };
                                        if (Date.now() - _lastBridgeNoticeAt > 5000) {
                                            bot.chat('[System] Void gap detected. Bridged forward. Retrying route...');
                                            _lastBridgeNoticeAt = Date.now();
                                        }
                                        _stuckCount = 0;
                                    } else {
                                        if (await tryElytraGapCross(af0)) {
                                            bot.chat('[System] Bridging failed. Crossing gap with Elytra boost.');
                                            _stLastPos = bot.entity.position.clone();
                                            _stLastTime = Date.now();
                                            _stuckCount = 0;
                                            _sw = _computeNextStreamWp(bot.entity.position.x, bot.entity.position.z);
                                            if (!_sw) break;
                                            bot.pathfinder.setGoal(new goals.GoalXZ(_sw.x, _sw.z), true);
                                            continue;
                                        }
                                        if (_lastBridgeFailureReason === 'no_block') {
                                            bot.chat('[System] Cannot bridge void gap: no solid placeable blocks in inventory.');
                                        } else {
                                            bot.chat('[System] Bridge placement failed on this edge. Retrying a new approach...');
                                        }
                                        if (_stuckCount >= 7) {
                                            gotoAborted = true;
                                            gotoAbortReason = 'bridge attempts exhausted';
                                            console.log('[Actuator] Bridge attempts exhausted. Aborting goto.');
                                            break;
                                        }
                                    }
                                    _sw = _computeNextStreamWp(bot.entity.position.x, bot.entity.position.z);
                                    if (!_sw) break;
                                    bot.pathfinder.setGoal(new goals.GoalXZ(_sw.x, _sw.z), true);
                                    continue;
                                }
                            }

                            if (_stuckCount <= 2) {
                                // Mild: jump to escape single-block lip catches
                                bot.chat('[System] I am stuck. Trying jump escape...');
                                _cacheWps = null; // stale cache may be guiding into a dead end
                                if (movements.canDig === false) {
                                    movements.canDig = true;
                                    bot.pathfinder.setMovements(movements);
                                }
                                bot.setControlState('jump', true);
                                await new Promise(r => setTimeout(r, 400));
                                bot.setControlState('jump', false);
                                _sw = _computeNextStreamWp(cx, cz);
                                if (!_sw) break;
                                bot.pathfinder.setGoal(new goals.GoalXZ(_sw.x, _sw.z), true);

                            } else if (_stuckCount <= 4) {
                                // Moderate: perpendicular sidestep
                                bot.chat('[System] Still stuck. Trying sidestep...');
                                const af = Math.atan2(rdz, rdx);
                                const perpX = cx + 5 * Math.cos(af + Math.PI / 2);
                                const perpZ = cz + 5 * Math.sin(af + Math.PI / 2);
                                bot.pathfinder.setGoal(null);
                                try {
                                    await withTimeout(
                                        bot.pathfinder.goto(new goals.GoalXZ(perpX, perpZ)),
                                        6000, 'escape sidestep', () => bot.pathfinder.setGoal(null)
                                    );
                                } catch (_e) { /* other side next attempt */ }
                                _sw = _computeNextStreamWp(bot.entity.position.x, bot.entity.position.z);
                                if (!_sw) break;
                                bot.pathfinder.setGoal(new goals.GoalXZ(_sw.x, _sw.z), true);

                            } else {
                                // Severe: force-walk only if safe ahead (no lava/cliff)
                                const af = Math.atan2(rdz, rdx);
                                if (isSafeForward(af)) {
                                    bot.pathfinder.setGoal(null);
                                    try { await bot.lookAt(new Vec3(cx + 100 * Math.cos(af), bot.entity.position.y, cz + 100 * Math.sin(af))); } catch (_e) {}
                                    bot.setControlState('forward', true);
                                    bot.setControlState('sprint', true);
                                    await new Promise(r => setTimeout(r, 1500));
                                    bot.setControlState('forward', false);
                                    bot.setControlState('sprint', false);
                                } else {
                                    const bridgeHint = action.bridge_block || action.block || action.material;
                                    if ((hasForwardGap(af) || hasLikelyBridgeNeed(af)) && await tryBridgeForward(af, bridgeHint, 6)) {
                                        _bridgeLock = { angle: af, stepsLeft: 3 };
                                        if (Date.now() - _lastBridgeNoticeAt > 5000) {
                                            bot.chat('[System] Gap detected. Bridged forward and retrying route...');
                                            _lastBridgeNoticeAt = Date.now();
                                        }
                                    } else {
                                        if (await tryElytraGapCross(af)) {
                                            bot.chat('[System] Using Elytra boost to bypass hazardous gap.');
                                        } else {
                                            bot.chat('[System] Blocked by hazard ahead. Cannot force-walk.');
                                        }
                                        console.log('[Actuator] Goto force-walk aborted: hazard ahead.');
                                    }
                                }
                                if (_stuckCount >= 7) {
                                    gotoAborted = true;
                                    gotoAbortReason = 'stuck recovery exhausted';
                                    console.log('[Actuator] Stuck recovery exhausted (7 attempts). Aborting goto.');
                                    break;
                                }
                                _sw = _computeNextStreamWp(bot.entity.position.x, bot.entity.position.z);
                                if (!_sw) break;
                                bot.pathfinder.setGoal(new goals.GoalXZ(_sw.x, _sw.z), true);
                            }
                            continue;
                        }

                        // ── Lookahead handoff ────────────────────────────────────────────────
                        // When HANDOFF_DIST blocks away from the current streaming waypoint,
                        // immediately switch goal to the next one. The pathfinder recomputes
                        // the next segment while the bot is still moving forward — zero pause.
                        if (_sw) {
                            const d2sw = Math.sqrt((cx - _sw.x) ** 2 + (cz - _sw.z) ** 2);
                            if (d2sw < HANDOFF_DIST) {
                                _visitedWps.push({ x: Math.round(_sw.x), z: Math.round(_sw.z) });
                                const nextSw = _computeNextStreamWp(cx, cz);
                                if (!nextSw) break; // reached destination vicinity
                                _sw = nextSw;
                                // Switch goal while still in motion — no inter-segment stop
                                bot.pathfinder.setGoal(new goals.GoalXZ(_sw.x, _sw.z), true);
                            }
                        }
                    }

                    // Stop streaming goal and restore settings
                    try { bot.pathfinder.setGoal(null); bot.clearControlStates(); } catch (_e) {}
                    movements.canDig = savedCanDig;
                    bot.pathfinder.setMovements(movements);

                    // Issue 2: save successful path to cache (only if we made meaningful progress).
                    if (!currentCancelToken.cancelled && _visitedWps.length >= 2) {
                        const updatedCache = loadPathCache();
                        updatedCache[_cacheKey] = { waypoints: _visitedWps, ts: Date.now() };
                        // Evict entries older than max age to keep cache file small.
                        for (const k of Object.keys(updatedCache)) {
                            if (Date.now() - updatedCache[k].ts > PATH_CACHE_MAX_AGE_MS) delete updatedCache[k];
                        }
                        savePathCache(updatedCache);
                    }
                }
                if (!currentCancelToken.cancelled) {
                    const finalDist = Math.sqrt(
                        Math.pow(destX - bot.entity.position.x, 2) +
                        Math.pow(destZ - bot.entity.position.z, 2)
                    );
                    const reachedThreshold = 24;

                    // Do not report success when movement aborted or clearly stopped far away.
                    if (gotoAborted || finalDist > reachedThreshold) {
                        const reason = gotoAborted
                            ? gotoAbortReason
                            : `insufficient progress (${Math.round(finalDist)} blocks remaining)`;

                        // Auto-retry long-distance goto a few times to recover from transient
                        // pathfinder stalls / temporary reroutes without requiring new user input.
                        if (gotoRetryCount < 3 && finalDist > 40) {
                            bot.chat(`[System] Goto interrupted (${reason}). Retrying... (${gotoRetryCount + 1}/3)`);
                            actionQueue.unshift({ ...action, _gotoRetryCount: gotoRetryCount + 1 });
                        } else {
                            bot.chat(`[System Error] Could not reach destination (${Math.round(finalDist)} blocks remaining). Reason: ${reason}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to reach destination (${Math.round(finalDist)} blocks remaining). Reason: ${reason}.`, environment: getEnvironmentContext() } });
                        }
                        continue;
                    }

                    // Issue 4: status feedback on completion
                    bot.chat(`[System] Reached destination (${Math.round(finalDist)} blocks from target).`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Reached destination (${Math.round(finalDist)} blocks from target).`, environment: getEnvironmentContext() } });

                    // Issue 1: auto-register nearby structures as waypoints.
                    const ctx = getEnvironmentContext();
                    if (ctx.nearby_structures && ctx.nearby_structures.length > 0) {
                        const wps = loadWaypoints();
                        const dim = bot.game?.dimension || 'overworld';
                        let saved = false;
                        for (const struct of ctx.nearby_structures) {
                            const wpName = struct.toLowerCase().replace(/\s+/g, '_');
                            if (!wps.find(w => w.name === wpName)) {
                                const pos = bot.entity.position;
                                wps.push({ name: wpName, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), dimension: dim });
                                bot.chat(`[System] Auto-registered waypoint "${wpName}".`);
                                saved = true;
                            }
                        }
                        if (saved) saveWaypoints(wps);
                    }
                }

            // ── collect (3× candidate pool + progressive radius fallback) ─────
            } else if (action.action === 'collect') {
                // Resolve which blocks to search for.
                // Some items only exist as drops, not as placed blocks (e.g. cobblestone comes
                // from mining stone; flint comes from gravel). DROP_TO_SOURCE maps the requested
                // item to the actual block(s) to find with findBlocks().
                const sourceSNames = DROP_TO_SOURCE[action.target];
                let directBlockId = bot.registry.blocksByName[action.target]?.id;
                let searchIds = sourceSNames
                    ? sourceSNames.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
                    : (directBlockId !== undefined ? [directBlockId] : []);

                // Issue 9: Tag-group expansion — if exact block is unknown, try all variants.
                // This prevents "cannot find oak_log" in a birch/spruce forest.
                if (searchIds.length === 0) {
                    const tagGroup = MATERIAL_TAG_GROUPS[action.target];
                    if (tagGroup) {
                        const tagIds = tagGroup
                            .map(n => bot.registry.blocksByName[n]?.id)
                            .filter(id => id !== undefined);
                        if (tagIds.length > 0) {
                            console.log(`[collect] '${action.target}' not in registry — expanding to tag group: [${tagGroup.join(',')}]`);
                            searchIds = tagIds;
                            // Override countInInventory to count any variant of the group
                            action._tagGroupNames = tagGroup;
                        }
                    }
                }

                if (searchIds.length === 0) { bot.chat(`[System Error] I don't know what ${action.target} is.`); }
                else {
                    const quantity = parseInt(action.quantity, 10) || 1;
                    let collected = 0;

                    // Count actual drops via inventory delta (accurate even for stone→cobblestone,
                    // gravel→flint, ore→raw_iron, etc. where the block ID ≠ drop item ID).
                    // If tag group expansion was used, count any variant of the group.
                    const countInInventory = () => {
                        const names = action._tagGroupNames || [action.target];
                        return bot.inventory.items()
                            .filter(i => names.includes(i.name))
                            .reduce((s, i) => s + i.count, 0);
                    };

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
                    let consecutiveProtected = 0; // track consecutive dig-rejected blocks

                    if (searchIds.length > 0) {
                        console.log(`[collect] ${action.target}: searchIds=[${searchIds}] from pos (${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)})`);
                    }
                    for (const pass of SEARCH_PASSES) {
                        if (collected >= quantity || currentCancelToken.cancelled) break;

                        // useExtraInfo:true bypasses the palette-based section skip optimisation.
                        // On Forge servers the palette contains server-side state IDs that may
                        // differ from what prismarine-block's Block.fromStateId() expects, causing
                        // sections with valid blocks to be skipped during the palette pre-check.
                        // useExtraInfo:true forces a full block-by-block scan via bot.blockAt(),
                        // which correctly resolves types through the DynamicRegistryInjector proxy.
                        // Only use for the close-range pass (32b) where the placed test blocks live;
                        // wider passes (64b, 128b) use the faster palette optimisation for world trees.
                        // IMPORTANT: 64b with useExtraInfo scans ~1.1M blocks, blocking the event loop
                        // long enough for the server's 30s keepalive to fire → EPIPE disconnect.
                        // 32b: full function matcher (bypasses Forge palette pre-check, ~17K blocks, safe).
                        // 64b/128b: numeric matcher for single-ID searches, function for multi-ID —
                        // palette optimisation is fast enough at these radii and avoids EPIPE.
                        const useFull = pass.maxDistance <= 32;
                        const candidates = bot.findBlocks(useFull ? {
                            matching: b => b && searchIds.includes(b.type),
                            maxDistance: pass.maxDistance,
                            count: pass.count,
                            useExtraInfo: true
                        } : {
                            matching: searchIds.length === 1 ? searchIds[0] : (b => b && searchIds.includes(b.type)),
                            maxDistance: pass.maxDistance,
                            count: pass.count
                        });
                        if (action.target === 'oak_log') {
                            console.log(`[collect] oak_log pass r=${pass.maxDistance} (full=${useFull}): found ${candidates.length} candidates`);
                        }

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
                                // Log whether we have the optimal tool. We no longer abort
                                // here — most blocks (wood, dirt, sand) can be collected
                                // bare-handed; only hard ores truly require a specific tool,
                                // but aborting would prevent any recovery path. Instead let
                                // the dig attempt fail/timeout naturally if the tool is truly
                                // required (the block won't drop, but no crash).
                                if (firstBlock.harvestTools && Object.keys(firstBlock.harvestTools).length > 0) {
                                    const heldItem = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
                                    if (!heldItem || !firstBlock.harvestTools[heldItem.type]) {
                                        const toolCat = inferToolCategory(firstBlock);
                                        console.log(`[collect] No ${toolCat} for ${action.target} after ensureToolFor — attempting bare-hand collection.`);
                                    }
                                }
                            }
                            bot.chat(`[System] Collecting ${action.target}...`);
                        } else if (pass.maxDistance === 64) {
                            bot.chat(`[System] Expanding search for more ${action.target}...`);
                        }

                        bot.chat(`[System] I am mining ${action.quantity || 1} ${action.target}...`);

                        for (const blockPos of fresh) {
                            if (currentCancelToken.cancelled || collected >= quantity) break;
                            // If 3 consecutive digs are server-rejected, assume we're in a
                            // protected zone — skip remaining candidates in this pass.
                            if (consecutiveProtected >= 3) {
                                console.log(`[collect] 3 consecutive protected digs — skipping rest of r=${pass.maxDistance} pass.`);
                                consecutiveProtected = 0;
                                break;
                            }
                            // Change 3: Skip blocks inside safe zones.
                            {
                                const currentDimForCollect = bot.game?.dimension || 'overworld';
                                if (_isInSafeZone(blockPos, currentDimForCollect)) {
                                    console.log(`[collect] Skipping block at (${blockPos.x},${blockPos.y},${blockPos.z}) — inside safe zone.`);
                                    continue;
                                }
                            }
                            triedSet.add(`${blockPos.x},${blockPos.z}`);

                            try {
                                if (action.target === 'oak_log') {
                                    console.log(`[collect] oak_log: trying (${blockPos.x},${blockPos.y},${blockPos.z}) bot@(${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)})`);
                                }
                                bot.pathfinder.setGoal(null);
                                try {
                                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(blockPos.x, blockPos.y, blockPos.z, 4)), 20000, `goto ${action.target}`, () => bot.pathfinder.setGoal(null));
                                } catch (gotoErr) {
                                    throw new Error(`Failed to reach block: ${gotoErr.message}`);
                                }

                                const targetBlock = bot.blockAt(blockPos);
                                if (action.target === 'oak_log') {
                                    console.log(`[collect] oak_log: at block pos type=${targetBlock?.type} name=${targetBlock?.name} searchIds=${JSON.stringify(searchIds)}`);
                                }
                                if (!targetBlock || !searchIds.includes(targetBlock.type)) continue;

                                const bname = targetBlock.name.toLowerCase();
                                const isContainer = bname === 'chest' || bname === 'barrel' ||
                                                    bname === 'shulker_box' || bname.endsWith('_shulker_box');
                                if (isContainer) {
                                    bot.chat(`[System Error] I am not allowed to break containers to collect items.`);
                                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'Use withdraw_from_container to get items from chests, do not mine them.', environment: getEnvironmentContext() } });
                                    currentCancelToken.cancelled = true;
                                    break;
                                }

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

                                // Protection check: if the block is still there after 200ms,
                                // the server rejected the dig (protected zone). Skip this area.
                                await new Promise(r => setTimeout(r, 200));
                                const blockAfterDig = bot.blockAt(blockPos);
                                if (blockAfterDig && searchIds.includes(blockAfterDig.type)) {
                                    consecutiveProtected++;
                                    console.log(`[collect] dig rejected at (${blockPos.x},${blockPos.y},${blockPos.z}) — protected zone (${consecutiveProtected}/3).`);
                                    throw new Error('Dig rejected by server — protected zone.');
                                }
                                consecutiveProtected = 0; // successful dig resets counter

                                let veinMined = 1;
                                const queue = [blockPos];
                                const visited = new Set([`${blockPos.x},${blockPos.y},${blockPos.z}`]);
                                const offsets = [{x:1,y:0,z:0}, {x:-1,y:0,z:0}, {x:0,y:1,z:0}, {x:0,y:-1,z:0}, {x:0,y:0,z:1}, {x:0,y:0,z:-1}];

                                while(queue.length > 0 && veinMined < 64 && collected + veinMined < quantity && !currentCancelToken.cancelled) {
                                    const curr = queue.shift();
                                    for (const off of offsets) {
                                        const nx = curr.x + off.x, ny = curr.y + off.y, nz = curr.z + off.z;
                                        const key = `${nx},${ny},${nz}`;
                                        if (!visited.has(key)) {
                                            visited.add(key);
                                            const adjBlock = bot.blockAt(new Vec3(nx, ny, nz));
                                            if (adjBlock && searchIds.includes(adjBlock.type)) {
                                                const held = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
                                                if (held && held.maxDurability) {
                                                    const usesLeft = held.maxDurability - (held.durabilityUsed || 0);
                                                    if (usesLeft <= 5) break;
                                                }
                                                try {
                                                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(nx, ny, nz, 2)), 5000, 'vein goto', () => bot.pathfinder.setGoal(null));
                                                    await bot.lookAt(adjBlock.position.offset(0.5, 0.5, 0.5));
                                                    await withTimeout(bot.dig(adjBlock, true), maxDigMs, 'vein dig', () => {});
                                                    queue.push(adjBlock.position);
                                                    veinMined++;
                                                } catch(e) {}
                                            }
                                        }
                                    }
                                }

                                await new Promise(r => setTimeout(r, 600)); // pause for item drop + auto-collect

                                // Issue 4: count via inventory delta, not dig calls.
                                // This correctly handles stone→cobblestone, gravel→flint, etc.
                                const gained = countInInventory() - countBefore;
                                if (gained > 0) {
                                    collected += gained;
                                    consecutiveProtected = 0;
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
                        bot.chat(`[System] Completed mining ${action.target}. Processing next step...`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully collected ${collected} ${action.target}.`, environment: getEnvironmentContext() } });
                    } else if (collected > 0) {
                        actionQueue = []; // Clear queue on partial success to re-evaluate
                        bot.chat(`[System] Completed mining ${collected} ${action.target}. Processing next step...`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Partially collected ${collected}/${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                    } else {
                        actionQueue = []; // Clear queue on failure
                        bot.chat(`[System Error] Could not find any ${action.target} nearby.`);
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
                const inventoryItem = resolveInventoryItemForTarget(itemTargetName);
                if (targetPlayer && inventoryItem) {
                    const quantity = Math.max(1, parseInt(action.quantity, 10) || 1);
                    bot.chat(`[System] Giving ${quantity} ${itemTargetName} to ${action.target}...`);
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(targetPlayer.position.x, targetPlayer.position.y, targetPlayer.position.z, 2)), timeoutMs, 'goto player for give', () => bot.pathfinder.setGoal(null));
                    await bot.lookAt(targetPlayer.position.offset(0, 1.6, 0));
                    if (bot.tossStack && quantity >= inventoryItem.count) {
                        await bot.tossStack(inventoryItem);
                    } else if (bot.tossStack && quantity === 1) {
                        await bot.tossStack(inventoryItem);
                    } else {
                        await bot.toss(inventoryItem.type, inventoryItem.metadata ?? null, quantity);
                    }
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully gave ${Math.min(quantity, inventoryItem.count)} ${inventoryItem.name} to ${action.target}.`, environment: getEnvironmentContext() } });
                } else if (!targetPlayer) {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`[System Error] I cannot see ${action.target}.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot see ${action.target}.`, environment: getEnvironmentContext() } });
                } else {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`[System Error] I don't have ${itemTargetName} in inventory.`);
                }

            // ── craft ─────────────────────────────────────────────────────────
            } else if (action.action === 'craft') {
                const itemId = bot.registry.itemsByName[action.target]?.id || bot.registry.blocksByName[action.target]?.id;
                if (itemId !== undefined) {
                    const quantity = parseInt(action.quantity, 10) || 1;
                    // _craftPath tracks the call chain to detect cycles (e.g. planks→boat→planks)
                    const craftPath = action._craftPath || [];

                    if (craftPath.includes(action.target)) {
                        bot.chat(`[System Error] Crafting cycle detected for ${action.target}.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Crafting cycle: cannot craft ${action.target} (in ${craftPath.join(' → ')}).`, environment: getEnvironmentContext() } });
                        continue;
                    }

                    const inventoryMap = {};
                    if (bot.inventory) {
                        for (const item of bot.inventory.items()) {
                            inventoryMap[item.name] = (inventoryMap[item.name] || 0) + item.count;
                        }
                    }

                    // 1. Dependency Tree — check raw materials are available
                    const requiredTree = resolveRequiredMaterials(bot.registry, action.target, quantity, inventoryMap);
                    const missing = [];
                    for (const [name, qty] of Object.entries(requiredTree)) {
                        if (qty > 0) missing.push({ name, quantity: qty });
                    }

                    if (missing.length > 0) {
                        actionQueue = []; // Clear queue on failure
                        bot.chat(`[System Error] Cannot craft ${action.target}: missing materials.`);
                        const missingStr = missing.map(m => `${m.quantity}x ${m.name}`).join(', ');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot craft ${action.target}: missing materials. You strictly need to collect: ${missingStr}. Generate actions to collect these specific materials before retrying.`, environment: getEnvironmentContext() } });
                        continue;
                    }

                    // 2. Get recipe (always fetch; `true` = include table recipes)
                    const recipe = bot.recipesFor(itemId, null, 1, true)[0];
                    if (!recipe) {
                        actionQueue = [];
                        bot.chat(`[System Error] Cannot craft ${action.target}: recipe not found.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot craft ${action.target}: recipe not found.`, environment: getEnvironmentContext() } });
                        continue;
                    }

                    // 3. Check direct ingredients — auto-prepend sub-crafts for any that are missing
                    //    This handles intermediate materials (e.g. oak_log → planks → boat) without
                    //    requiring the LLM to enumerate every step.
                    const ingCounts = {};
                    const addIng = (id) => {
                        if (id == null) return;
                        const itm = bot.registry.items[id] || bot.registry.blocks[id];
                        if (!itm) return;
                        ingCounts[itm.name] = (ingCounts[itm.name] || 0) + 1;
                    };
                    if (recipe.ingredients) {
                        for (const ing of recipe.ingredients) addIng(Array.isArray(ing) ? ing[0] : ing);
                    } else if (recipe.inShape) {
                        for (const row of recipe.inShape) for (const ing of row) addIng(Array.isArray(ing) ? ing[0] : ing);
                    }

                    const recipeYield = recipe.result ? recipe.result.count : 1;
                    const craftsNeeded = Math.ceil(quantity / recipeYield);
                    const preCrafts = [];

                    for (const [ingName, ingPerCraft] of Object.entries(ingCounts)) {
                        const needed = ingPerCraft * craftsNeeded;
                        const have = inventoryMap[ingName] || 0;

                        // Issue 6/9: Variant-aware ingredient check — if the recipe asks for
                        // 'oak_planks' but the bot has 'birch_planks', count those too.
                        let effectiveHave = have;
                        const ingTagGroup = MATERIAL_TAG_GROUPS[ingName];
                        if (ingTagGroup && effectiveHave < needed) {
                            effectiveHave = ingTagGroup.reduce((sum, n) => sum + (inventoryMap[n] || 0), 0);
                        }

                        if (effectiveHave < needed) {
                            // Only pre-craft if even with variants we're short
                            preCrafts.push({
                                action: "craft",
                                target: ingName,
                                quantity: needed - effectiveHave,
                                _craftPath: [...craftPath, action.target]
                            });
                        }
                    }

                    if (preCrafts.length > 0) {
                        // Prepend intermediate craft steps, then retry this craft action
                        bot.chat(`[System] Preparing ${preCrafts.map(c => c.target).join(', ')} before crafting ${action.target}...`);
                        actionQueue = [...preCrafts, action, ...actionQueue];
                        continue;
                    }

                    // 4. All direct ingredients present — craft now
                    bot.chat(`[System] Crafting ${action.target}...`);
                    if (recipe.requiresTable) {
                        const ctId = bot.registry.blocksByName.crafting_table.id;
                        const ct = ctId !== undefined ? bot.findBlock({ matching: ctId, maxDistance: 32 }) : null;

                        if (ct) {
                            await withTimeout(bot.pathfinder.goto(new goals.GoalNear(ct.position.x, ct.position.y, ct.position.z, 1)), timeoutMs, 'goto crafting table', () => bot.pathfinder.setGoal(null));
                            try {
                                await withTimeout(bot.craft(recipe, quantity, ct), timeoutMs, 'craft at table');
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully crafted ${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                            } catch (err) {
                                bot.chat(`[System Error] Failed to craft ${action.target}.`);
                                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to craft: ${err.message}`, environment: getEnvironmentContext() } });
                            }
                        } else {
                            bot.chat(`[System] Need a crafting table for ${action.target}. Preparing one...`);
                            const logs = bot.inventory.items().filter(i => i.name.endsWith('_log') || i.name.endsWith('_wood'));
                            const bestLog = logs.length > 0 ? logs[0].name : "oak_log";
                            const bestPlank = bestLog.replace(/_log$|_wood$/, '_planks');
                            actionQueue = [
                                { action: "collect", target: bestLog, quantity: 1, timeout: 60 },
                                { action: "craft", target: bestPlank, quantity: 4, _craftPath: [...craftPath, action.target] },
                                { action: "craft", target: "crafting_table", quantity: 1, _craftPath: [...craftPath, action.target] },
                                { action: "place", target: "crafting_table" },
                                action, // retry original craft
                                ...actionQueue
                            ];
                        }
                    } else {
                        try {
                            await withTimeout(bot.craft(recipe, quantity, null), timeoutMs, 'craft in inventory');
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully crafted ${quantity} ${action.target}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            actionQueue = [];
                            bot.chat(`[System Error] Failed to craft ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to craft: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    }
                } else {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`[System Error] I don't know what ${action.target} is.`);
                }

            // ── place ─────────────────────────────────────────────────────────
            } else if (action.action === 'place') {
                const blockId = bot.registry.blocksByName[action.target]?.id;
                const itemId = bot.registry.itemsByName[action.target]?.id;
                if (blockId !== undefined || itemId !== undefined) {
                    const itemToPlace = bot.inventory.items().find(item => item.name === action.target || (itemId !== undefined && item.type === itemId));
                    if (itemToPlace) {
                        try {
                            await placeItemIntelligently(bot, itemToPlace, timeoutMs);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully placed ${action.target}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            actionQueue = []; // Clear queue on failure
                            bot.chat(`[System Error] Failed to place ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Place failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    } else {
                        actionQueue = []; // Clear queue on failure
                        bot.chat(`[System Error] No ${action.target} in inventory.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${action.target} in inventory.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`[System Error] I don't know what ${action.target} is.`);
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
                            // Auto-detect destination slot from item name unless caller specifies one
                            let destSlotName = action.slot || 'hand';
                            if (!action.slot) {
                                const n = itemName;
                                if (n.endsWith('_helmet') || n === 'carved_pumpkin' || n === 'pumpkin'
                                    || n.endsWith('_head') || n.endsWith('_skull')) {
                                    destSlotName = 'head';
                                } else if (n.endsWith('_chestplate') || n === 'elytra' || /jetpack/i.test(n)) {
                                    destSlotName = 'torso';
                                } else if (n.endsWith('_leggings')) {
                                    destSlotName = 'legs';
                                } else if (n.endsWith('_boots')) {
                                    destSlotName = 'feet';
                                } else if (n === 'shield' || n.endsWith('_shield') || n === 'totem_of_undying') {
                                    destSlotName = 'off-hand';
                                }
                            }
                            // Unequip whatever is currently in that slot so bot.equip never fails
                            if (['head', 'torso', 'legs', 'feet', 'off-hand'].includes(destSlotName)) {
                                try {
                                    const occupiedSlot = bot.inventory.slots[bot.getEquipmentDestSlot(destSlotName)];
                                    if (occupiedSlot) await bot.unequip(destSlotName);
                                } catch (_) {}
                            }
                            await bot.equip(item, destSlotName);
                            bot.chat(`[System] Equipped ${itemName} to ${destSlotName}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equipped ${itemName} to ${destSlotName}.`, environment: getEnvironmentContext() } });
                        } catch (err) {
                            actionQueue = []; // Clear queue on failure
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equip failed: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    } else {
                        actionQueue = []; // Clear queue on failure
                        bot.chat(`[System Error] No ${action.target} to equip.`);
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${action.target} in inventory.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    actionQueue = []; // Clear queue on failure
                    bot.chat(`[System Error] I don't know what ${action.target} is.`);
                }

            // ── equip_armor ───────────────────────────────────────────────────
            } else if (action.action === 'equip_armor') {
                await equipBestArmor();
                process.send({ type: 'USER_CHAT', data: { username: "System", message: `Equipped best available armor.`, environment: getEnvironmentContext() } });

            // ── shredder_add / shredder_remove ────────────────────────────────
            } else if (action.action === 'shredder_add') {
                const junkName = (action.target || '').replace(/^[a-z_]+:/, '').trim();
                if (junkName) {
                    _junkList.add(junkName);
                    _saveJunkList();
                    bot.chat(`[System] Added ${junkName} to auto-shredder list.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `${junkName} added to junk list (${_junkList.size} total).`, environment: getEnvironmentContext() } });
                }
            } else if (action.action === 'shredder_remove') {
                const junkName = (action.target || '').replace(/^[a-z_]+:/, '').trim();
                if (junkName) {
                    _junkList.delete(junkName);
                    _saveJunkList();
                    bot.chat(`[System] Removed ${junkName} from auto-shredder list.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `${junkName} removed from junk list.`, environment: getEnvironmentContext() } });
                }

            // ── boat ──────────────────────────────────────────────────────────
            // Travel by boat across a river or ocean. Requires a destination (x/z) and nearby water.
            // Issue 6: Fixed placement when already in/on water; wider entity search; longer spawn wait.
            } else if (action.action === 'boat') {
                const destX = action.x !== undefined ? parseFloat(action.x) : null;
                const destZ = action.z !== undefined ? parseFloat(action.z) : null;

                // 1. Ensure we have a boat in inventory
                let boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat'));
                if (!boatItem) {
                    bot.chat('[System] No boat in inventory. Crafting one...');
                    actionQueue = [
                        { action: "craft", target: "oak_boat", quantity: 1 },
                        action,
                        ...actionQueue
                    ];
                    continue;
                }

                // 2. Find nearest water surface within 48 blocks
                const waterBlock = bot.findBlock({
                    matching: b => b && b.name === 'water',
                    maxDistance: 48
                });
                if (!waterBlock) {
                    bot.chat('[System Error] No water nearby for boat travel.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: "No water found within 48 blocks for boat travel.", environment: getEnvironmentContext() } });
                    continue;
                }

                try {
                    // Issue 6: Skip navigation if already in or adjacent to water
                    const alreadyInWater = bot.entity.isInWater;
                    const distToWater = bot.entity.position.distanceTo(waterBlock.position);
                    if (!alreadyInWater && distToWater > 3) {
                        // Navigate to the water edge
                        await withTimeout(
                            bot.pathfinder.goto(new goals.GoalNear(waterBlock.position.x, waterBlock.position.y, waterBlock.position.z, 2)),
                            timeoutMs, 'goto water for boat', () => bot.pathfinder.setGoal(null)
                        );
                    }

                    // Equip boat and look at the water surface before placing
                    boatItem = bot.inventory.items().find(i => i.name.endsWith('_boat'));
                    if (!boatItem) throw new Error('Boat disappeared from inventory');
                    await bot.equip(boatItem, 'hand');

                    // Look at the water surface (face = top) and activate item to place boat
                    const placeTarget = bot.blockAt(waterBlock.position);
                    let placedOk = false;
                    if (placeTarget) {
                        try {
                            await bot.lookAt(waterBlock.position.offset(0.5, 1, 0.5), true);
                            await bot.placeBlock(placeTarget, new Vec3(0, 1, 0));
                            placedOk = true;
                        } catch (_) {}
                    }
                    if (!placedOk) {
                        // Fallback: activateItem while looking at water (right-click in hand)
                        try {
                            await bot.lookAt(waterBlock.position.offset(0.5, 1, 0.5), true);
                            await bot.activateItem();
                            placedOk = true;
                        } catch (_) {}
                    }

                    // Issue 6: Wait longer for boat entity to spawn (1.5s instead of 0.6s)
                    await new Promise(r => setTimeout(r, 1500));

                    // Issue 6: Search near bot position, not waterBlock (bot may have moved slightly)
                    const botPosForBoat = bot.entity.position;
                    const boatEntity = Object.values(bot.entities).find(e => {
                        if (!e.name || !e.position) return false;
                        const n = e.name.toLowerCase();
                        return (n === 'boat' || n.endsWith('_boat') || n.includes('boat')) &&
                               e.position.distanceTo(botPosForBoat) < 10;
                    });

                    if (boatEntity) {
                        await bot.mount(boatEntity);
                        bot.chat('[System] Mounted boat. Navigating...');

                        if (destX !== null && destZ !== null) {
                            const deadline = Date.now() + timeoutMs;
                            while (Date.now() < deadline && !currentCancelToken.cancelled) {
                                const pos = bot.entity.position;
                                const dist = Math.sqrt((pos.x - destX) ** 2 + (pos.z - destZ) ** 2);
                                if (dist < 5) break;
                                const yaw = Math.atan2(-(destX - pos.x), -(destZ - pos.z));
                                await bot.look(yaw, 0, true);
                                bot.setControlState('forward', true);
                                await new Promise(r => setTimeout(r, 500));
                            }
                            bot.setControlState('forward', false);
                        }

                        await bot.dismount();
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Arrived at destination via boat.`, environment: getEnvironmentContext() } });
                    } else {
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: "Boat placed but could not find entity to mount.", environment: getEnvironmentContext() } });
                    }
                } catch (err) {
                    bot.setControlState('forward', false);
                    try { await bot.dismount(); } catch (_) {}
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Boat travel failed: ${err.message}`, environment: getEnvironmentContext() } });
                }

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
                    bot.chat('[System Error] No food in inventory.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No food available.', environment: getEnvironmentContext() } });
                }

            // ── smelt ─────────────────────────────────────────────────────────
            } else if (action.action === 'smelt') {
                const inputName = action.target;
                const quantity = parseInt(action.quantity, 10) || 1;
                const inputItem = bot.inventory.items().find(i => i.name === inputName);

                if (!inputItem) {
                    bot.chat(`[System Error] No ${inputName} to smelt.`);
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
                                await placeItemIntelligently(bot, fi, null);
                                furnaceBlock = furnaceBlockId !== undefined ? bot.findBlock({ matching: furnaceBlockId, maxDistance: 8 }) : null;
                            } catch (e) { console.log(`[Actuator] smelt place furnace: ${e.message}`); }
                        }
                    }

                    if (!furnaceBlock) {
                        bot.chat('[System Error] Cannot find or create a furnace.');
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

                            bot.chat(`[System] Smelting ${quantity} ${inputName}...`);
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

                // Issue 5: Special boss combat — Ender Dragon uses a dedicated phase-based routine.
                if ((action.target || '').toLowerCase() === 'ender_dragon') {
                    const dragonResult = await _killEnderDragon(currentCancelToken, combatMs, combatStart);
                    if (dragonResult) {
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'Ender Dragon defeated!', environment: getEnvironmentContext() } });
                    } else {
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'Ender Dragon combat ended (timeout or interrupted).', environment: getEnvironmentContext() } });
                    }
                    continue; // skip normal kill loop
                }

                // Issues 4 & 5: Classify target and select weapon before combat.
                const RANGED_ENEMIES = new Set(['blaze', 'ghast', 'phantom', 'ender_dragon', 'end_crystal']);
                const isRanged = RANGED_ENEMIES.has(action.target.toLowerCase());

                // Equip bow for aerial enemies if we have one + arrows; sword otherwise.
                const hasBow = bot.inventory.items().some(i => i.name === 'bow');
                const hasArrows = bot.inventory.items().some(i => i.name === 'arrow');
                if (isRanged && hasBow && hasArrows) {
                    const bow = bot.inventory.items().find(i => i.name === 'bow');
                    try { await bot.equip(bow, 'hand'); } catch (e) {}
                }
                // Ensure shield is in off-hand
                for (let attempt = 0; attempt < 3; attempt++) {
                    const shield = bot.inventory.items().find(i => i.name === 'shield');
                    if (!shield) break;
                    const offSlot = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
                    if (offSlot?.name === 'shield') break;
                    try { await bot.equip(shield, 'off-hand'); break; } catch (e) {
                        await new Promise(r => setTimeout(r, 200));
                    }
                }

                // Pre-combat: use fire resistance potion if fighting in nether or vs fire mobs
                const FIRE_MOBS = new Set(['blaze', 'ghast', 'magma_cube', 'wither_skeleton', 'wither']);
                if (FIRE_MOBS.has((action.target || '').toLowerCase())) {
                    const fireResPotion = bot.inventory.items().find(i =>
                        i.name && (i.name.includes('fire_resistance') || i.name.includes('fireresistance')));
                    if (fireResPotion) {
                        try { await bot.equip(fireResPotion, 'hand'); await bot.consume(); } catch (e) {}
                        await equipBestWeapon();
                    }
                    // Prefer snowballs vs blazes (3 hearts per throw, no fire risk)
                    if ((action.target || '').toLowerCase() === 'blaze') {
                        const snowball = bot.inventory.items().find(i => i.name === 'snowball');
                        if (snowball) {
                            try { await bot.equip(snowball, 'hand'); } catch (e) {}
                        }
                    }
                }

                bot.chat(`[System] Engaging ${action.target}...`);

                // Bow charge state tracking (non-blocking)
                let _bowChargeStart = 0;
                let _bowCharging = false;
                let _notFoundReported = false; // track early "X not found" send to avoid duplicate final message

                // Passive mobs (non-hostile) can wander far before kill action starts.
                // Use a generous search radius (60 blocks) and yDiff (15) for them.
                const HOSTILE_MOBS = new Set([
                    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
                    'blaze', 'ghast', 'witch', 'guardian', 'elder_guardian', 'wither',
                    'ender_dragon', 'phantom', 'drowned', 'husk', 'stray', 'vindicator',
                    'pillager', 'ravager', 'vex', 'shulker', 'slime', 'magma_cube',
                    'hoglin', 'zoglin', 'piglin_brute', 'zombified_piglin',
                ]);
                const isHostile = HOSTILE_MOBS.has(action.target.toLowerCase());
                const MAX_KILL_DIST = isHostile ? 30 : 60;
                const MAX_KILL_YDIFF = isHostile ? 8 : 15;

                while (killed < killQty && !currentCancelToken.cancelled && Date.now() - combatStart < combatMs) {
                    // Find nearest reachable living target
                    let target = null, minDist = Infinity;
                    for (const ent of Object.values(bot.entities)) {
                        if (ent === bot.entity) continue;
                        const eName = (ent.name || ent.username || '').toLowerCase();
                        if (eName === action.target.toLowerCase()) {
                            const d = bot.entity.position.distanceTo(ent.position);
                            const yDiff = bot.entity.position.y - ent.position.y;
                            // Skip mobs that fell off cliffs or are out of reach
                            if (d > MAX_KILL_DIST || yDiff > MAX_KILL_YDIFF) continue;
                            if (d < minDist) { minDist = d; target = ent; }
                        }
                    }
                    if (!target) {
                        // Debug: log all nearby entities to help diagnose "not found"
                        const allNearby = Object.values(bot.entities)
                            .filter(e => e !== bot.entity)
                            .map(e => {
                                const d = bot.entity.position.distanceTo(e.position);
                                return `${e.name||'?'}@${d.toFixed(1)}b(y${(bot.entity.position.y-e.position.y).toFixed(1)})`;
                            })
                            .filter(s => !s.startsWith('?@'))
                            .slice(0, 10);
                        console.log(`[kill] ${action.target} not found. Nearby: [${allNearby.join(', ')}]`);
                        if (!isHostile && killed === 0 && Date.now() - combatStart < combatMs - 15000) {
                            // Passive mob not found — wander in 4 cardinal directions (60b each) to
                            // load new chunks where the mob may have spawned, then re-scan.
                            // NOTE: threshold was combatMs-60000 which was 0 for a 60s timeout (never triggered).
                            // Changed to combatMs-15000 so wandering triggers whenever >15s remains.
                            console.log(`[kill] Passive ${action.target} not found — wandering to expand search area.`);
                            const basePos = bot.entity.position.clone();
                            const dirs = [[60,0],[-60,0],[0,60],[0,-60]];
                            for (const [dx, dz] of dirs) {
                                if (currentCancelToken.cancelled) break;
                                if (Date.now() - combatStart >= combatMs - 10000) break;
                                const wx = basePos.x + dx, wz = basePos.z + dz;
                                try {
                                    await withTimeout(bot.pathfinder.goto(new goals.GoalXZ(wx, wz)), 12000, `wander for ${action.target}`, () => bot.pathfinder.setGoal(null));
                                } catch(e) {
                                    console.log(`[kill] Wander to (${wx},${wz}): ${e.message}`);
                                }
                                // Check if target visible now
                                const found = Object.values(bot.entities).some(e => {
                                    const eName = (e.name || e.username || '').toLowerCase();
                                    return eName === action.target.toLowerCase() &&
                                        bot.entity.position.distanceTo(e.position) <= MAX_KILL_DIST;
                                });
                                if (found) break;
                            }
                            continue; // re-enter outer while to try finding target again
                        }
                        if (killed === 0) {
                            bot.chat(`[System Error] Cannot find ${action.target}.`);
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `${action.target} not found.`, environment: getEnvironmentContext() } });
                            _notFoundReported = true;
                        }
                        break;
                    }

                    // Issues 4 & 5: Combat sub-loop — non-blocking movement + reactive defense.
                    let _shieldUntil = 0;
                    let _lastStrafe = 0;
                    let _strafeSign = 1;
                    let _lastAttack = 0; // Issue 4: track attack cooldown
                    while (target.isValid && !currentCancelToken.cancelled && Date.now() - combatStart < combatMs) {
                        const now = Date.now();
                        // Issue 4 fix: declare botPos at top of loop iteration to avoid TDZ.
                        // Previously declared at line ~2631 but referenced earlier in the health check block.
                        const botPos = bot.entity.position;

                        // ── Health check: eat or flee (hostile only) ──────────────────
                        // Passive mobs don't attack back; skip eating/retreating for them.
                        if (isHostile && bot.health < 10) {
                            const food = getBestFoodItem();
                            if (food) {
                                bot.pathfinder.setGoal(null);
                                if (_bowCharging) { bot.deactivateItem(); _bowCharging = false; }
                                // Back away while eating
                                const retreatAngle = Math.atan2(botPos.z - target.position.z, botPos.x - target.position.x);
                                const rx = botPos.x + 8 * Math.cos(retreatAngle);
                                const rz = botPos.z + 8 * Math.sin(retreatAngle);
                                bot.pathfinder.goto(new goals.GoalXZ(rx, rz)).catch(() => {});
                                try {
                                    await bot.equip(food, 'hand');
                                    await bot.consume();
                                } catch (e) {}
                                if (isRanged && hasBow && hasArrows) {
                                    const bow = bot.inventory.items().find(i => i.name === 'bow');
                                    if (bow) try { await bot.equip(bow, 'hand'); } catch(e) {}
                                } else {
                                    await equipBestWeapon();
                                }
                            }
                        }

                        const dist = bot.entity.position.distanceTo(target.position);

                        // ── Issues 4 & 5: Projectile detection (extended to 20 blocks) ──
                        const incomingProj = Object.values(bot.entities).find(e => {
                            if (e === bot.entity || e === target) return false;
                            const n = (e.name || e.displayName || '').toLowerCase();
                            const isProj = n.includes('arrow') || n.includes('fireball') ||
                                           n.includes('snowball') || n.includes('shulker_bullet');
                            if (!isProj) return false;
                            if (e.position.distanceTo(botPos) > 20) return false; // Issue 5: was 10
                            const vel = e.velocity;
                            if (!vel) return true;
                            const toBot = botPos.minus(e.position).normalize();
                            const dot = vel.x * toBot.x + vel.y * toBot.y + vel.z * toBot.z;
                            return dot > 0;
                        });

                        if (incomingProj) {
                            const offSlot = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
                            if (offSlot?.name === 'shield') {
                                bot.activateItem(true);
                                _shieldUntil = now + 1000;
                            } else {
                                // No shield — strafe perpendicular (Issue 5: use setGoal, not goto)
                                if (now - _lastStrafe > 600) {
                                    _strafeSign *= -1;
                                    _lastStrafe = now;
                                }
                                const dodgeYaw = bot.entity.yaw + (_strafeSign * Math.PI / 2);
                                const sx = botPos.x + 4 * Math.sin(dodgeYaw);
                                const sz = botPos.z + 4 * Math.cos(dodgeYaw);
                                bot.pathfinder.setGoal(new goals.GoalXZ(sx, sz), true);
                            }
                        } else if (now > _shieldUntil) {
                            bot.deactivateItem();
                        }

                        // ── Issue 5: Movement / attack decision ─────────────────────
                        if (isRanged) {
                            const IDEAL_MIN = 6, IDEAL_MAX = 16;
                            const _heldSnowball = bot.heldItem?.name === 'snowball';
                            const _hasSnowball  = bot.inventory.items().some(i => i.name === 'snowball');
                            const _currentBow   = bot.heldItem?.name === 'bow';
                            const _currentArrows = bot.inventory.items().some(i => i.name === 'arrow');
                            // Issue 2: re-equip snowball if it fell out of hand (e.g. after eating)
                            if (_hasSnowball && !_heldSnowball && !_bowCharging) {
                                const sb = bot.inventory.items().find(i => i.name === 'snowball');
                                if (sb) try { await bot.equip(sb, 'hand'); } catch(_) {}
                            }
                            // Issue 2: if no ranged weapon available, fall back to melee approach
                            const canRanged = _heldSnowball || _hasSnowball || (_currentBow && _currentArrows);
                            if (!canRanged) {
                                // Melee fallback for ranged-classified mobs when ammo runs out
                                if (dist > 3.5) {
                                    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
                                } else {
                                    bot.pathfinder.setGoal(null);
                                    await bot.lookAt(target.position.offset(0, (target.height || 1.8) * 0.5, 0));
                                    if (bot.entity.onGround) {
                                        bot.setControlState('jump', true);
                                        await new Promise(r => setTimeout(r, 80));
                                        bot.setControlState('jump', false);
                                    }
                                    bot.attack(target);
                                }
                            } else if (dist > IDEAL_MAX) {
                                // Issue 2: chase AND throw snowballs within extended range (up to 20 blocks)
                                bot.pathfinder.setGoal(new goals.GoalFollow(target, IDEAL_MAX), true);
                                if ((_heldSnowball || (_hasSnowball && bot.heldItem?.name === 'snowball')) && dist <= 20 && !_bowCharging) {
                                    const targetEye2 = target.position.offset(0, (target.height || 1.8) * 0.9, 0);
                                    try { await bot.lookAt(targetEye2); await bot.activateItem(); } catch(_) {}
                                }
                            } else if (dist < IDEAL_MIN) {
                                // Issue 5: use setGoal (streaming) instead of goto (one-shot blocking)
                                const angle = Math.atan2(botPos.z - target.position.z, botPos.x - target.position.x);
                                const bx = botPos.x + 8 * Math.cos(angle);
                                const bz = botPos.z + 8 * Math.sin(angle);
                                bot.pathfinder.setGoal(new goals.GoalXZ(bx, bz), true);
                            } else {
                                bot.pathfinder.setGoal(null);
                                const targetEye = target.position.offset(0, (target.height || 1.8) * 0.9, 0);
                                await bot.lookAt(targetEye);
                                if (_heldSnowball && !_bowCharging) {
                                    try { await bot.activateItem(); } catch (e) {}
                                } else if (_currentBow && _currentArrows && !_bowCharging) {
                                    bot.activateItem();
                                    _bowChargeStart = now;
                                    _bowCharging = true;
                                }
                                if (_bowCharging && now - _bowChargeStart >= 900) {
                                    bot.deactivateItem();
                                    _bowCharging = false;
                                }
                            }
                        } else {
                            // ── Melee combat: kite-attack pattern ─────────────────────
                            // Issue 4: Tactical sequence — approach → jump-crit → retreat
                            // directly away from mob → wait for attack cooldown → re-engage.
                            // Issue 5: All movement uses setGoal(..., true) so there are
                            // no blocking await goto() calls competing with health/projectile
                            // checks on the same 150ms loop tick.
                            const MELEE_ATTACK_RANGE = 2.8; // max dist to swing (1 block arm reach + buffer)
                            const MELEE_FOLLOW_STOP  = 2;   // GoalFollow keeps bot this far from mob
                            const RETREAT_DIST       = 7;   // blocks to flee after each attack
                            const ATTACK_COOLDOWN_MS = 625; // sword = 1.6 attacks/s → 625ms between hits

                            if (isHostile && bot.health < 6) {
                                // Critical HP: flee from hostile mobs only. Passive mobs (cow/pig/chicken)
                                // don't attack back so we can kill them even at 1 HP.
                                const fleeAngle = Math.atan2(botPos.z - target.position.z, botPos.x - target.position.x);
                                const fx = botPos.x + 14 * Math.cos(fleeAngle);
                                const fz = botPos.z + 14 * Math.sin(fleeAngle);
                                bot.pathfinder.setGoal(new goals.GoalXZ(fx, fz), true);
                            } else if (dist <= MELEE_ATTACK_RANGE && now - _lastAttack >= ATTACK_COOLDOWN_MS) {
                                // In melee range and cooldown ready: stop, jump-crit, retreat.
                                // Critical hit = attack while falling (velocity.y < 0).
                                // Timing: jump=true → wait 80ms (near apex) → jump=false →
                                // wait 200ms (falling phase begins) → attack = guaranteed crit.
                                bot.pathfinder.setGoal(null);
                                try {
                                    await bot.lookAt(target.position.offset(0, (target.height || 1.8) * 0.5, 0));
                                    if (bot.entity.onGround && !incomingProj) {
                                        // Jump for critical hit — only if no incoming projectile
                                        // (jumping while blocking a projectile breaks shield)
                                        bot.setControlState('jump', true);
                                        await new Promise(r => setTimeout(r, 80));
                                        bot.setControlState('jump', false);
                                        await new Promise(r => setTimeout(r, 200)); // fall phase = crit
                                    }
                                    bot.attack(target);
                                    _lastAttack = now;
                                } catch (_) {}

                                // Shield up after attack to absorb any counter-hit.
                                const offSlotM = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
                                if (offSlotM?.name === 'shield') {
                                    bot.activateItem(true);
                                    _shieldUntil = now + 700;
                                }

                                // Retreat directly away from mob — creates real spacing.
                                // (Previous strafe-perpendicular only side-stepped, keeping
                                // the bot at close range where the mob could immediately re-hit.)
                                const retreatAngle = Math.atan2(botPos.z - target.position.z, botPos.x - target.position.x);
                                const rx = botPos.x + RETREAT_DIST * Math.cos(retreatAngle);
                                const rz = botPos.z + RETREAT_DIST * Math.sin(retreatAngle);
                                bot.pathfinder.setGoal(new goals.GoalXZ(rx, rz), true);
                            } else if (dist > MELEE_ATTACK_RANGE) {
                                // Not in range yet — follow the target.
                                bot.pathfinder.setGoal(new goals.GoalFollow(target, MELEE_FOLLOW_STOP), true);
                            }
                            // else: in range but cooldown not ready — hold; next tick will attack.
                        }
                        await new Promise(r => setTimeout(r, 150)); // 150ms tick for faster reaction
                    }

                    if (!target.isValid) {
                        killed++;
                        bot.pathfinder.setGoal(null);
                        bot.deactivateItem();

                        // Short pause to let drops appear
                        await new Promise(r => setTimeout(r, 800));

                        // Pick up drops: find dropped items near the death position
                        const deathPos = target.position;
                        const droppedItems = Object.values(bot.entities).filter(e => e.type === 'object' && e.position.distanceTo(deathPos) < 5);
                        for (const item of droppedItems) {
                            try {
                                await withTimeout(bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1)), 3000, 'pickup combat drop', () => bot.pathfinder.setGoal(null));
                            } catch (e) {}
                        }
                    }
                }

                if (killed >= killQty) {
                    // Issue 4: status feedback on completion
                    bot.chat(`[System] Eliminated ${killed} ${action.target}.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Successfully killed ${killed} ${action.target}.`, environment: getEnvironmentContext() } });
                } else if (killed > 0) {
                    actionQueue = []; // Clear queue on partial success to re-evaluate
                    bot.chat(`[System] Partially eliminated ${killed}/${killQty} ${action.target}.`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Partially killed ${killed}/${killQty} ${action.target}.`, environment: getEnvironmentContext() } });
                } else if (!_notFoundReported) {
                    actionQueue = []; // Clear queue on failure
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Failed to kill ${action.target}.`, environment: getEnvironmentContext() } });
                }

            // ── sleep / set_respawn ───────────────────────────────────────────
            // Issue 2: Sequential access — stagger bed use by bot name lex order to avoid
            // multiple bots racing to the same bed simultaneously.
            // Issue 2: Instant wake-up — wake immediately after lying down so the bed is
            // free for the next bot and we don't sleep through the night unexpectedly.
            } else if (action.action === 'sleep' || action.action === 'set_respawn') {
                // Staggered delay based on alphabetical bot name position (0-indexed × 4 seconds)
                const BED_LOCK_FILE = path.join(process.cwd(), 'data', 'bed_lock.json');
                let bedLockDelay = 0;
                try {
                    const lockData = fs.existsSync(BED_LOCK_FILE) ? JSON.parse(fs.readFileSync(BED_LOCK_FILE, 'utf8')) : null;
                    if (lockData && lockData.botId && lockData.botId !== botId) {
                        const elapsed = Date.now() - (lockData.timestamp || 0);
                        if (elapsed < 8000) { // another bot used bed <8s ago — wait
                            bedLockDelay = 8000 - elapsed;
                        }
                    }
                } catch (_) {}
                if (bedLockDelay > 0) {
                    bot.chat(`[System] Waiting ${Math.ceil(bedLockDelay/1000)}s for bed to be free...`);
                    await new Promise(r => setTimeout(r, bedLockDelay));
                }

                const bedBlock = bot.findBlock({
                    matching: b => b && b.name.endsWith('_bed'),
                    maxDistance: 32
                });
                if (!bedBlock) {
                    bot.chat('[System Error] No bed nearby.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No bed found within 32 blocks.', environment: getEnvironmentContext() } });
                } else {
                    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2)), timeoutMs, 'goto bed', () => bot.pathfinder.setGoal(null));
                    try {
                        // Write bed lock before sleeping so other bots wait
                        try { fs.writeFileSync(BED_LOCK_FILE, JSON.stringify({ botId, timestamp: Date.now() })); } catch (_) {}

                        // Even if it's day, attempting to sleep on a bed sets the respawn point
                        await withTimeout(bot.sleep(bedBlock), timeoutMs, 'sleep');
                        // Issue 2: Wake up immediately — respawn point is now set; no need to
                        // stay in bed. This also frees the bed for other bots right away.
                        await new Promise(r => setTimeout(r, 300));
                        try { await bot.wake(); } catch (_) {}
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: 'Respawn point set. Woke up immediately.', environment: getEnvironmentContext() } });
                    } catch (err) {
                        try { fs.unlinkSync(BED_LOCK_FILE); } catch (_) {}
                        // Sleep fails if it's day, but the respawn point should still be set.
                        if (err.message && (err.message.includes('day') || err.message.includes('time'))) {
                            bot.chat('[System] Respawn point set!');
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: 'Respawn point set (cannot sleep during day).', environment: getEnvironmentContext() } });
                        } else {
                            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Cannot sleep: ${err.message}`, environment: getEnvironmentContext() } });
                        }
                    }
                }

            // ── brew ──────────────────────────────────────────────────────────
            } else if (action.action === 'brew') {
                const potionKey = (action.potion || action.target || '').replace('potion_of_', '').replace('_potion', '');
                const recipe = POTION_RECIPES[potionKey];

                if (!recipe) {
                    bot.chat(`[System Error] Unknown potion type: ${potionKey}`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Unknown potion: ${potionKey}`, environment: getEnvironmentContext() } });
                } else {
                    const standId = bot.registry.blocksByName['brewing_stand']?.id;
                    const stand = standId !== undefined ? bot.findBlock({ matching: standId, maxDistance: 32 }) : null;
                    if (!stand) {
                        bot.chat('[System Error] No brewing stand nearby.');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No brewing stand found.', environment: getEnvironmentContext() } });
                    } else {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(stand.position.x, stand.position.y, stand.position.z, 1)), timeoutMs, 'goto brewing stand', () => bot.pathfinder.setGoal(null));
                        const brewingStand = await bot.openBrewingStand(stand);
                        try {
                            // Ensure blaze powder fuel
                            const blazePowder = bot.inventory.items().find(i => i.name === 'blaze_powder');
                            if (blazePowder) await brewingStand.putFuel(blazePowder.type, null, 1);

                            // Place base (water bottles or base potions) into the three potion slots.
                            // In Minecraft, water_bottle and awkward_potion are both stored as the
                            // 'potion' item with different NBT {Potion:"minecraft:water/awkward"}.
                            // We search by the base name first; if not found, fall back to 'potion'.
                            const baseItemId = bot.registry.itemsByName[recipe.base]?.id
                                             ?? bot.registry.itemsByName['potion']?.id;
                            if (baseItemId !== undefined) {
                                const baseItems = bot.inventory.items().filter(i => i.type === baseItemId);
                                const toDeposit = Math.min(baseItems.reduce((s, i) => s + i.count, 0), 3);
                                if (toDeposit > 0) {
                                    await brewingStand.deposit(baseItemId, null, toDeposit);
                                } else {
                                    console.log(`[Actuator] brew: no base item (${recipe.base}) in inventory`);
                                }
                            }

                            // Add ingredient (top slot)
                            const ingredientId = bot.registry.itemsByName[recipe.ingredient]?.id;
                            const ingredient = ingredientId !== undefined ? bot.inventory.items().find(i => i.type === ingredientId) : null;
                            if (ingredient) await brewingStand.putIngredient(ingredient.type, null, 1);

                            bot.chat(`[System] Brewing ${potionKey} potion...`);
                            // Wait for brewing to complete (~20 seconds per cycle, Minecraft spec)
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
                    bot.chat('[System Error] No enchanting table nearby.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'No enchanting table found.', environment: getEnvironmentContext() } });
                } else if (!targetItem) {
                    bot.chat(`[System Error] No ${action.target} to enchant.`);
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

                bot.chat(`[System] Exploring ${action.direction || 'east'}${action.target ? ` for ${action.target}` : ''}...`);

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
                    bot.chat(`[System] Found ${action.target}!`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Found ${action.target} at ${found.position}.`, environment: getEnvironmentContext() } });
                } else if (!currentCancelToken.cancelled) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Explored ${traveled} blocks. ${action.target ? `${action.target} not found.` : 'Done.'}`, environment: getEnvironmentContext() } });
                }

            // ── navigate_portal ───────────────────────────────────────────────
            } else if (action.action === 'navigate_portal') {
                const portalName = action.target === 'end' ? 'end_portal' : 'nether_portal';
                const portalBlockId = bot.registry.blocksByName[portalName]?.id;
                const portalLabel = action.target === 'end' ? 'End' : 'Nether';

                // isConnected: guard before any network write
                const isConnected = () => bot._client?.socket?.writable === true;

                // Scan all currently loaded chunks for the portal block.
                // Max distance 64 to prevent blocking the event loop for too long.
                const findPortalAll = () => portalBlockId !== undefined
                    ? bot.findBlock({ matching: portalBlockId, maxDistance: 64 })
                    : null;

                // Yield to the event loop before the synchronous findBlock scan.
                // findBlock iterates millions of blocks; without this yield, any pending
                // keepalive ACK packets can't be sent during the scan, causing server timeout.
                await new Promise(resolve => setImmediate(resolve));

                let portalBlock = findPortalAll();

                // Step via a known portal waypoint (name must contain 'portal' or 'gate')
                if (!portalBlock && !currentCancelToken.cancelled) {
                    const targetKey = action.target || 'nether';
                    const wp = loadWaypoints().find(w => {
                        const n = w.name.toLowerCase();
                        return (n.includes('portal') || n.includes('gate')) && n.includes(targetKey);
                    });
                    if (wp) {
                        if (isConnected()) bot.chat(`[System] Traveling to saved portal waypoint "${wp.name}"...`);
                        const wpDist = Math.sqrt((wp.x - bot.entity.position.x) ** 2 + (wp.z - bot.entity.position.z) ** 2);
                        const wpTimeout = Math.max(60000, wpDist * 600); // 600ms/block
                        // Segmented walk — no digging to avoid VeinMiner chain reactions
                        const wpMovements = new Movements(bot, mcData);
                        wpMovements.canDig = false;
                        wpMovements.allowSprinting = true;
                        wpMovements.liquidCost = 3;
                        wpMovements.maxDropDown = 4;
                        bot.pathfinder.setMovements(wpMovements);
                        const STEP = 64;
                        let wpReached = false;
                        while (!currentCancelToken.cancelled && !wpReached) {
                            if (!isConnected()) break;
                            const cx = bot.entity.position.x, cz = bot.entity.position.z;
                            const rdx = wp.x - cx, rdz = wp.z - cz;
                            const rem = Math.sqrt(rdx * rdx + rdz * rdz);
                            if (rem <= 5) { wpReached = true; break; }
                            const a = Math.atan2(rdz, rdx);
                            const stepX = rem > STEP ? cx + STEP * Math.cos(a) : wp.x;
                            const stepZ = rem > STEP ? cz + STEP * Math.sin(a) : wp.z;
                            const stepTimeout = Math.max(30000, Math.min(rem, STEP) * 600);
                            try {
                                await withTimeout(
                                    bot.pathfinder.goto(new goals.GoalXZ(stepX, stepZ)),
                                    stepTimeout, 'portal waypoint step',
                                    () => { try { bot.pathfinder.setGoal(null); bot.clearControlStates(); } catch (_) {} }
                                );
                            } catch (e) {
                                console.log(`[Actuator] Portal waypoint step: ${e.message}`);
                                bot.clearControlStates();
                                // Issue 4: break immediately if there is genuinely no path — retrying
                                // costs another 38400ms per step and eventually triggers a keepalive timeout.
                                if (e.message && e.message.toLowerCase().includes('no path')) break;
                            }
                            portalBlock = findPortalAll();
                            if (portalBlock) break;
                        }
                        if (!portalBlock) portalBlock = findPortalAll();
                        // Restore normal movements
                        bot.pathfinder.setMovements(movements);
                    }
                }

                // Exhaustive expanding grid scan — move to grid points and scan all loaded chunks.
                // Grid spacing = 128 blocks (≈ server view distance). No artificial radius cap.
                // Each move loads a fresh set of chunks; findPortalAll() searches every loaded block.
                if (!portalBlock && isConnected() && !currentCancelToken.cancelled) {
                    if (isConnected()) bot.chat(`[System] No ${portalLabel} portal in loaded area. Starting exhaustive grid scan...`);
                    const origin = bot.entity.position.clone();
                    const GRID_STEP = 128;
                    let layer = 1;

                    // Use a no-dig copy of movements for the portal search.
                    // canDig=true causes the pathfinder to break blocks during navigation,
                    // which triggers VeinMiner chain-reactions (mass block destruction),
                    // rapid terrain changes, movement desync, and ultimately ECONNRESET.
                    const scanMovements = new Movements(bot, mcData);
                    scanMovements.canDig = false;
                    scanMovements.allowSprinting = true;
                    scanMovements.liquidCost = 3;
                    scanMovements.maxDropDown = 4;
                    bot.pathfinder.setMovements(scanMovements);

                    gridScan: while (!currentCancelToken.cancelled && isConnected()) {
                        // If VeinMiner/terrain churn is active, wait for it to settle before
                        // sending more movement packets — prevents position desync kicks.
                        if (debouncer && debouncer.isCascadingWait) {
                            await new Promise(resolve => {
                                const done = () => resolve();
                                debouncer.once('cascading_wait_end', done);
                                // Safety timeout: don't wait more than 3 seconds
                                setTimeout(done, 3000);
                            });
                        }
                        if (currentCancelToken.cancelled || !isConnected()) break gridScan;

                        // Expanding square shell at Manhattan distance `layer`
                        const ring = [];
                        for (let i = -layer; i <= layer; i++) {
                            ring.push([i, -layer]);
                            ring.push([i,  layer]);
                        }
                        for (let j = -layer + 1; j < layer; j++) {
                            ring.push([-layer, j]);
                            ring.push([ layer, j]);
                        }
                        for (const [gi, gj] of ring) {
                            if (currentCancelToken.cancelled || !isConnected()) break gridScan;
                            const gx = origin.x + gi * GRID_STEP;
                            const gz = origin.z + gj * GRID_STEP;
                            // Segmented step to grid point
                            const gdist = Math.sqrt((gx - bot.entity.position.x) ** 2 + (gz - bot.entity.position.z) ** 2);
                            const gTimeout = Math.max(30000, gdist * 600);
                            try {
                                await withTimeout(
                                    bot.pathfinder.goto(new goals.GoalXZ(gx, gz)),
                                    gTimeout, 'portal grid scan step',
                                    () => { try { bot.pathfinder.setGoal(null); bot.clearControlStates(); } catch (_) {} }
                                );
                            } catch (e) {
                                bot.clearControlStates();
                            }
                            if (!isConnected() || currentCancelToken.cancelled) break gridScan;
                            portalBlock = findPortalAll();
                            if (portalBlock) {
                                console.log(`[Actuator] Found ${portalLabel} portal at grid point (${gi},${gj}) layer ${layer}.`);
                                break gridScan;
                            }
                        }
                        if (portalBlock) break gridScan;
                        layer++;
                        // Absolute safety cap: ~6400 blocks radius (layer 50)
                        if (layer > 50) {
                            if (isConnected()) process.send({ type: 'USER_CHAT', data: { username: "System", message: `No ${portalLabel} portal found within 6400 blocks. You must build one.`, environment: getEnvironmentContext() } });
                            break gridScan;
                        }
                    }
                    // Restore normal movements (canDig=true) after scan
                    bot.pathfinder.setMovements(movements);
                }

                if (!portalBlock) {
                    if (isConnected()) bot.chat(`[System Error] ${portalLabel} portal not found.`);
                } else {
                    if (!isConnected()) {
                        console.log(`[Actuator] navigate_portal: portal found but socket dead, aborting.`);
                    } else {
                    bot.chat(`[System] Found ${portalLabel} portal. Entering...`);
                    try {
                        await withTimeout(bot.pathfinder.goto(new goals.GoalNear(portalBlock.position.x, portalBlock.position.y, portalBlock.position.z, 1)), Math.max(timeoutMs, 60000), 'goto portal', () => bot.pathfinder.setGoal(null));
                    } catch (e) { /* close enough */ }
                    const currentDim = bot.game.dimension;
                    try {
                        bot.lookAt(portalBlock.position.offset(0.5, 0.5, 0.5));
                        bot.setControlState('forward', true);
                        await withTimeout(new Promise(resolve => {
                            const check = setInterval(() => {
                                if (bot.game.dimension !== currentDim) {
                                    clearInterval(check);
                                    // Bug Fix 1: Hard-flush all movement state on dimension change.
                                    // clearControlStates() stops every key (forward, sprint, jump, sneak,
                                    // back, left, right) so the bot cannot drift on the obsidian platform
                                    // or in the End void while waiting for chunks to load.
                                    bot.clearControlStates();
                                    try { bot.pathfinder.setGoal(null); } catch (e) {}
                                    resolve();
                                }
                            }, 500);
                        }), 12000, 'portal teleport');

                        // Bug Fix 1: Give the new dimension time to load chunks and for the bot to
                        // land on the obsidian platform (End) or Nether floor before any further
                        // pathfinding. Without this, the pathfinder immediately tries to compute
                        // routes using stale/unloaded chunk data, producing phantom movement.
                        const newDim = bot.game.dimension;
                        const enteringEnd = newDim === 'the_end' || newDim === 'minecraft:the_end';
                        const settleMs = enteringEnd ? 2000 : 1000;
                        await new Promise(r => setTimeout(r, settleMs));
                        // Extra guard: if still airborne after the settle delay (e.g. spawning above
                        // the obsidian platform in the End), wait up to 3s more to land.
                        if (bot.entity && !bot.entity.onGround && !bot.entity.isInWater) {
                            let airWait = 0;
                            while (bot.entity && !bot.entity.onGround && !bot.entity.isInWater && airWait < 3000) {
                                await new Promise(r => setTimeout(r, 100));
                                airWait += 100;
                            }
                        }
                        // Final pathfinder flush after landing — clears any internal path state
                        // that built up while the bot was airborne on the platform.
                        try { bot.pathfinder.setGoal(null); bot.clearControlStates(); } catch (e) {}

                        // CLEAR the action queue to avoid carrying overworld coordinates or old tasks into the new dimension
                        actionQueue = [];

                        // Save portal location as waypoint for future use
                        const waypoints = loadWaypoints();
                        const wpName = `${action.target || 'nether'}_portal`;
                        if (!waypoints.find(w => w.name === wpName)) {
                            waypoints.push({ name: wpName, x: Math.round(portalBlock.position.x), y: Math.round(portalBlock.position.y), z: Math.round(portalBlock.position.z), dimension: bot.game.dimension });
                            saveWaypoints(waypoints);
                        }
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Entered portal. Now in ${bot.game.dimension}. Actions cleared.`, environment: getEnvironmentContext() } });
                    } catch (e) {
                        bot.clearControlStates();
                        try { bot.pathfinder.setGoal(null); } catch (err) {}
                        actionQueue = [];
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: `Portal transit timeout: ${e.message}`, environment: getEnvironmentContext() } });
                    }
                    } // close isConnected else
                } // close outer portalBlock else

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
                        if (!eye) { bot.chat('[System Error] Out of Eyes of Ender.'); break; }

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
                    bot.chat(`[System Error] Unknown pattern: ${patternName}`);
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
                        if (!blockItem) { bot.chat(`[System Error] Missing ${entry.name}.`); missing++; continue; }

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

            // ── add_waypoint ──────────────────────────────────────────────────────
            } else if (action.action === 'add_waypoint') {
                const wpName = action.name || action.target;
                if (!wpName) {
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'add_waypoint requires a name.', environment: getEnvironmentContext() } });
                } else {
                    const pos = bot.entity.position;
                    const dim = bot.game?.dimension || 'overworld';
                    const waypoints = loadWaypoints();
                    const existing = waypoints.findIndex(w => w.name.toLowerCase() === wpName.toLowerCase());
                    const entry = { name: wpName, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), dimension: dim };
                    if (existing >= 0) {
                        waypoints[existing] = entry;
                    } else {
                        waypoints.push(entry);
                    }
                    saveWaypoints(waypoints);
                    bot.chat(`[System] Waypoint "${wpName}" saved at X:${entry.x}, Y:${entry.y}, Z:${entry.z} (${dim}).`);
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: `Waypoint "${wpName}" saved at X:${entry.x}, Y:${entry.y}, Z:${entry.z} (${dim}).`, environment: getEnvironmentContext() } });
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
                    if (DEBUG) {
                        // Check player Y before teleporting — if they're on high terrain
                        // (mountain, cliff), TP would strand the bot far from test targets.
                        // Only TP when player is at navigable ground level (Y < 90).
                        const tpPlayerEnt = bot.players[tpTargetName]?.entity;
                        const playerOnHighTerrain = tpPlayerEnt && tpPlayerEnt.position.y > 90;
                        if (playerOnHighTerrain) {
                            console.log(`[find_land] DEBUG: Player at high terrain (Y=${Math.round(tpPlayerEnt.position.y)}) — skipping TP, navigating toward flat land instead.`);
                            // Bot may also be on high terrain from previous test. If so, pathfind
                            // toward world origin (0,0) which is typically at lower elevation.
                            if (bot.entity.position.y > 90) {
                                console.log(`[find_land] DEBUG: Bot also at high terrain (Y=${Math.round(bot.entity.position.y)}) — navigating toward (0,0) flat zone for up to 60s...`);
                                bot.chat(`/effect give ${bot.username} minecraft:resistance 600 10 true`);
                                await new Promise(r => setTimeout(r, 600));
                                try {
                                    await withTimeout(
                                        bot.pathfinder.goto(new goals.GoalXZ(0, 0)),
                                        60000, 'find_land descent to flat zone', () => bot.pathfinder.setGoal(null)
                                    );
                                } catch (e) {
                                    console.log(`[find_land] DEBUG: Descent navigation ended (${e.message}) — continuing from Y=${Math.round(bot.entity.position.y)}`);
                                }
                            }
                            tpTargetName = null; // use no-player path for effects/items
                        } else {
                        // Apply resistance BEFORE TP so the bot can't die if player is
                        // in a dangerous area (underground, lava, etc.)
                        console.log(`[find_land] DEBUG: Applying resistance before TP...`);
                        bot.chat(`/effect give ${bot.username} minecraft:resistance 600 10 true`);
                        await new Promise(r => setTimeout(r, 600));
                        bot.chat(`/effect give ${bot.username} minecraft:saturation 600 10 true`);
                        await new Promise(r => setTimeout(r, 600));
                        bot.chat(`/effect give ${bot.username} minecraft:water_breathing 600 10 true`);
                        await new Promise(r => setTimeout(r, 600));
                        console.log(`[find_land] DEBUG: Teleporting to player: ${tpTargetName}`);
                        bot.chat(`/tp ${bot.username} ${tpTargetName}`);
                        await new Promise(r => setTimeout(r, 3000));
                        } // end else (player not on high terrain)
                    } else {
                        console.log(`[find_land] Pathfinding to player: ${tpTargetName}`);
                        const targetPlayer = bot.players[tpTargetName];
                        if (targetPlayer?.entity) {
                            // Step-loop: re-evaluate player position every 15s for up to 90s
                            // This handles moving targets and avoids pathfinder giving up on
                            // complex mountain terrain with a single long-lived goal.
                            const findLandDeadline = Date.now() + 90000;
                            let reached = false;
                            while (!reached && Date.now() < findLandDeadline && !currentCancelToken.cancelled) {
                                const playerEnt = bot.players[tpTargetName]?.entity;
                                if (!playerEnt) break;
                                const dist3d = bot.entity.position.distanceTo(playerEnt.position);
                                if (dist3d < 5) { reached = true; break; }
                                const stepTimeout = Math.min(15000, findLandDeadline - Date.now());
                                if (stepTimeout <= 0) break;
                                try {
                                    await withTimeout(
                                        bot.pathfinder.goto(new goals.GoalNear(playerEnt.position.x, playerEnt.position.y, playerEnt.position.z, 4)),
                                        stepTimeout, 'find_land step', () => bot.pathfinder.setGoal(null)
                                    );
                                    reached = true;
                                } catch (e) {
                                    // Partial progress is fine — loop and re-target
                                    console.log(`[find_land] Step timeout/error: ${e.message}`);
                                }
                            }
                            if (!reached) console.log('[find_land] Could not fully reach player — continuing from current position');
                        }
                    }
                    try { await bot.waitForChunksToLoad(); } catch (e) {}
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    console.log('[find_land] No players online — using current position.');
                }

                // ── Post-positioning water check ─────────────────────────────────────
                // If the bot ended up in water (e.g. player was in an ocean), use
                // /spreadplayers to land on dry ground before setting up the test area.
                // This runs for both the player-TP path and the no-player path.
                if (DEBUG) {
                    let recoveredToDryLand = false;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        const posCheck = bot.entity.position;
                        const blockAtFeet = bot.blockAt(posCheck);
                        const blockBelowFeet = bot.blockAt(posCheck.offset(0, -1, 0));
                        const isInWater = blockAtFeet?.name?.includes('water') || blockBelowFeet?.name?.includes('water') || !bot.entity.onGround;

                        // Detect phantom modded-block collision on each attempt. This catches
                        // "air but stuck" states where the server keeps correcting position.
                        _serverPosCount = 0;
                        const testGoalPos = posCheck.offset(5, 0, 0);
                        bot.pathfinder.goto(new goals.GoalXZ(testGoalPos.x, testGoalPos.z)).catch(() => {});
                        await new Promise(r => setTimeout(r, 2000));
                        bot.pathfinder.setGoal(null);
                        const isPhantomBlock = _serverPosCount > 15;

                        if (!isInWater && !isPhantomBlock) {
                            recoveredToDryLand = true;
                            break;
                        }

                        if (isPhantomBlock) {
                            console.log(`[find_land] Phantom block detected (${_serverPosCount} corrections) — spreadplayers attempt ${attempt}/3.`);
                        } else {
                            console.log(`[find_land] In water/air or unstable ground — spreadplayers attempt ${attempt}/3...`);
                        }

                        bot.chat(`/spreadplayers 0 0 5 500 false ${bot.username}`);
                        await new Promise(r => setTimeout(r, 5500));
                        try { await bot.waitForChunksToLoad(); } catch (e) {}
                        await new Promise(r => setTimeout(r, 1200));
                    }

                    if (!recoveredToDryLand) {
                        console.log('[find_land] WARNING: still not on dry stable ground after 3 spreadplayers attempts. Continuing with fallback setup.');
                    }
                }

                // ── Step 2: Survival buffs + give oak_log for crafting test ───────
                // Helper: send a chat command only when the socket is still alive.
                // Returns false if the connection was lost (caller should abort).
                const safeSend = async (cmd) => {
                    if (bot._client?.socket?.writable !== true) return false;
                    bot.chat(cmd);
                    await new Promise(r => setTimeout(r, 900));
                    return bot._client?.socket?.writable === true;
                };

                // "Forge AI Player Ready." was sent right before find_land was queued.
                // 2-second cooldown (no-player path) or 0s (player path: pre-TP effects gave ~5s gap).
                // 600ms between each command (< 1.7/s, safely below any 3/s limit).
                if (DEBUG) {
                    // No-player path needs initial cooldown; player path already has 4s+ gap from TP wait.
                    if (!tpTargetName) await new Promise(r => setTimeout(r, 2000));
                    let ok = true;
                    // resistance/saturation already sent in player-found path; only re-send for no-player path
                    if (!tpTargetName) {
                        ok = await safeSend(`/effect give ${bot.username} minecraft:resistance 600 10 true`);
                        if (ok) ok = await safeSend(`/effect give ${bot.username} minecraft:saturation 600 10 true`);
                    }
                    if (ok) ok = await safeSend(`/effect give ${bot.username} minecraft:regeneration 600 10 true`);
                    // Free inventory slots so /give has room.
                    // Must eat ENTIRE stacks (not just one item) to actually free a slot.
                    // Include rotten_flesh because that's a common loot-chest drop.
                    {
                        const FOOD_NAMES = new Set(['beef', 'cooked_beef', 'pork_chop', 'cooked_porkchop',
                            'chicken', 'cooked_chicken', 'mutton', 'cooked_mutton', 'bread',
                            'apple', 'cookie', 'carrot', 'potato', 'cooked_potato', 'melon_slice',
                            'pumpkin_pie', 'baked_potato', 'rabbit', 'cooked_rabbit', 'salmon',
                            'cooked_salmon', 'cod', 'cooked_cod', 'dried_kelp', 'rotten_flesh']);
                        // Sort ascending by count so we exhaust small stacks first (fewer consumes needed)
                        const foodItems = bot.inventory.items()
                            .filter(i => FOOD_NAMES.has(i.name))
                            .sort((a, b) => a.count - b.count);
                        let slotsFreed = 0;
                        for (const item of foodItems) {
                            if (slotsFreed >= 2) break;
                            const stackCount = item.count;
                            for (let i = 0; i < stackCount; i++) {
                                const cur = bot.inventory.items().find(ii => ii.type === item.type);
                                if (!cur) break; // stack exhausted
                                try { await bot.equip(cur, 'hand'); await bot.consume(); } catch(e) { break; }
                            }
                            // Check if the slot is now free
                            const stillHas = bot.inventory.items().some(ii => ii.type === item.type);
                            if (!stillHas) slotsFreed++;
                        }
                        if (slotsFreed < 2) {
                            // Fallback: toss cheap items — bot may re-pick them up but we only need
                            // the slot free for a moment while /give fires.
                            const cheapTypes = new Set(['leather', 'cobblestone', 'gravel', 'dirt', 'sand', 'rotten_flesh', 'arrow']);
                            for (const item of [...bot.inventory.items()]) {
                                if (slotsFreed >= 2) break;
                                if (!cheapTypes.has(item.name)) continue;
                                try { await bot.toss(item.type, null, item.count); slotsFreed++; } catch(e) {}
                            }
                        }
                        console.log(`[find_land] slotsFreed=${slotsFreed} inv now ${bot.inventory.items().length}/36`);
                    }
                    if (ok) ok = await safeSend(`/give ${bot.username} minecraft:oak_log 16`);
                    await new Promise(r => setTimeout(r, 2000));
                    console.log(`[find_land] inv 2s after /give oak_log (ok=${ok}): slots=${bot.inventory.items().length} ALL=[${bot.inventory.items().map(i=>`${i.name}x${i.count}`).join(',')||'(empty)'}]`);
                    // Iron sword for faster kills + wooden axe as fallback for collect_oak_log
                    // (iron_axe is normally provided by the equipment chest, but if the bot spawns
                    // far from the chest it may have none — wooden_axe prevents auto-craft failure)
                    if (ok) ok = await safeSend(`/give ${bot.username} minecraft:iron_sword 1`);
                    if (ok) {
                        const hasAxe = bot.inventory.items().some(i => i.name.endsWith('_axe'));
                        if (!hasAxe) ok = await safeSend(`/give ${bot.username} minecraft:wooden_axe 1`);
                    }
                    if (!ok) {
                        console.log('[find_land] Disconnected during buffs — aborting find_land.');
                        process.send({ type: 'USER_CHAT', data: { username: "System", message: 'find_land: disconnected during setup.', environment: getEnvironmentContext() } });
                        return;
                    }
                }

                // ── Step 3: Find the ground Y from actual position post-TP ─────────
                // Helper: (re)compute gx/gz/groundY/logY from current bot position.
                // Called once here and again after death+respawn if needed.
                const computeGround = () => {
                    const p = bot.entity.position;
                    const cx = Math.round(p.x), cz = Math.round(p.z);
                    let gy = Math.floor(p.y) - 1;
                    if (!bot.entity.onGround) {
                        for (let dy = 0; dy >= -15; dy--) {
                            const b = bot.blockAt(new Vec3(cx, Math.floor(p.y) + dy, cz));
                            if (b && b.boundingBox === 'block' && !b.name.includes('water')) {
                                gy = Math.floor(p.y) + dy; break;
                            }
                        }
                    }
                    return { cx, cz, gy, ly: gy + 1 };
                };
                let { cx: gx, cz: gz, gy: groundY, ly: logY } = computeGround();
                console.log(`[find_land] Step3 pos: (${gx},${groundY+1},${gz}) groundY=${groundY} logY=${logY}`);

                // ── Step 3.5: Drain water if the setup area is submerged ────────────
                // Bot may have TP'd to a player standing on a lake/ocean bed.
                // /fill replaces water with air so placed logs and summoned animals
                // are on dry ground and the pathfinder can reach them without swimming.
                const waterCheckBlock = bot.blockAt(new Vec3(gx, logY, gz));
                if (waterCheckBlock && waterCheckBlock.name.includes('water')) {
                    console.log(`[find_land] logY=${logY} is in water — draining setup area...`);
                    await safeSend(`/fill ${gx - 2} ${logY} ${gz - 2} ${gx + 10} ${logY + 4} ${gz + 10} air replace water`);
                    await new Promise(r => setTimeout(r, 1000)); // wait for terrain update
                    // Wait until bot is on solid ground — after death/respawn the position packet
                    // may arrive several seconds late; if we call computeGround() too early we still
                    // get the death coordinates and the recapture condition never triggers.
                    // BUG FIX: onGround=true can fire briefly at the death position (bot standing
                    // on the riverbed) before the respawn position packet arrives. Add a check that
                    // the bot has actually moved away from gx/gz before breaking out of the loop.
                    for (let attempt = 0; attempt < 14; attempt++) {
                        const belowRe = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                        const movedFromDeath = Math.abs(bot.entity.position.x - gx) > 5 ||
                                              Math.abs(bot.entity.position.z - gz) > 5;
                        if (movedFromDeath && bot.entity.onGround && belowRe &&
                            belowRe.boundingBox === 'block' && !belowRe.name.includes('water')) {
                            break;
                        }
                        await new Promise(r => setTimeout(r, 500));
                    }
                    // Re-capture position in case bot died and respawned during the drain wait
                    const rePos = computeGround();
                    if (Math.abs(rePos.cx - gx) > 5 || Math.abs(rePos.cz - gz) > 5) {
                        console.log(`[find_land] Bot moved after drain (death/respawn). Recapturing position: (${rePos.cx},${rePos.ly},${rePos.cz})`);
                        ({ cx: gx, cz: gz, gy: groundY, ly: logY } = rePos);
                    }
                }

                // ── Step 4: Place 5 oak_log columns (separate XZ → collect dedup OK) ─
                // Use /fill for the stone platform + air clearing (1 cmd each vs 25 setblocks)
                // to stay well below the server's chat rate limit and avoid disconnect.spam.
                let landOk = true;
                // Stone floor under log positions + 1-block approach strip in front
                if (landOk) landOk = await safeSend(`/fill ${gx+3} ${groundY} ${gz+2} ${gx+7} ${groundY} ${gz+3} minecraft:stone`);
                await new Promise(r => setTimeout(r, 300));
                // Clear any obstructing blocks at log level + 1 above (overhangs / tall grass)
                if (landOk) await safeSend(`/fill ${gx+3} ${logY} ${gz+2} ${gx+7} ${logY+1} ${gz+3} minecraft:air`);
                await new Promise(r => setTimeout(r, 300));
                // Place all 5 logs in one fill command
                if (landOk) landOk = await safeSend(`/fill ${gx+3} ${logY} ${gz+3} ${gx+7} ${logY} ${gz+3} minecraft:oak_log`);

                // Verify log placement is reflected in client world state.
                // Block updates can lag up to 2s on busy Forge servers.
                await new Promise(r => setTimeout(r, 3000));
                const logVerify = [];
                for (let dx = 3; dx <= 7; dx++) {
                    const b = bot.blockAt(new Vec3(gx + dx, logY, gz + 3));
                    logVerify.push(`(${gx+dx},${logY},${gz+3})=${b?.name}(t=${b?.type})`);
                }
                console.log(`[find_land] log verify: ${logVerify.join(' ')}`);

                // ── Step 4b: If /fill didn't place any oak_log (e.g. bot lacks OP),
                // navigate toward the nearest natural oak trees on DRY LAND so the
                // collect test can find them within 32b of the bot's final position.
                const placedLogsVisible = logVerify.some(s => s.includes('oak_log'));
                if (!placedLogsVisible) {
                    console.log('[find_land] No placed oak_log visible — /fill may have failed. Scanning for natural trees...');
                    const oakLogBlockId = bot.registry.blocksByName['oak_log']?.id;
                    if (oakLogBlockId) {
                        const farLogs = bot.findBlocks({ matching: b => b && b.type === oakLogBlockId, maxDistance: 128, count: 30, useExtraInfo: true });
                        console.log(`[find_land] Natural oak trees within 128b: ${farLogs.length}`);
                        if (farLogs.length > 0) {
                            // Prefer trees on dry land — check 3 blocks below the log for water.
                            // Logs with water 3 below are likely in an ocean biome or just above sea.
                            const dryLogs = farLogs.filter(pos => {
                                const b = bot.blockAt(new Vec3(pos.x, pos.y - 3, pos.z));
                                return b && !b.name.includes('water');
                            });
                            // Deduplicate by XZ column — keep only the lowest log per tree trunk.
                            // Without this, the first 5 candidates can all be different Y-levels
                            // of the SAME tree, causing 5 failed navigation attempts to one tree.
                            const dedupMap = new Map();
                            for (const pos of (dryLogs.length > 0 ? dryLogs : farLogs)) {
                                const key = `${pos.x},${pos.z}`;
                                if (!dedupMap.has(key) || pos.y < dedupMap.get(key).y) {
                                    dedupMap.set(key, pos);
                                }
                            }
                            const candidates = [...dedupMap.values()];
                            candidates.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
                            console.log(`[find_land] Dry-land tree candidates (deduped): ${candidates.length}`);
                            let reached = false;
                            for (const treeTarget of candidates.slice(0, 5)) {
                                console.log(`[find_land] Trying to reach oak tree at (${treeTarget.x},${treeTarget.y},${treeTarget.z})`);
                                try {
                                    // Use GoalNear radius 8 so the bot approaches from land
                                    // without requiring it to stand directly below the log.
                                    await withTimeout(
                                        bot.pathfinder.goto(new goals.GoalNear(treeTarget.x, treeTarget.y, treeTarget.z, 8)),
                                        12000, 'goto natural trees', () => bot.pathfinder.setGoal(null)
                                    );
                                    const tp = bot.entity.position;
                                    console.log(`[find_land] Reached near oak trees at (${Math.round(tp.x)},${Math.round(tp.y)},${Math.round(tp.z)})`);
                                    // Record tree direction from gx/gz for goto test use
                                    const tdx = tp.x - gx, tdz = tp.z - gz;
                                    const tmag = Math.sqrt(tdx * tdx + tdz * tdz);
                                    if (tmag > 5) _treeDir = { dx: tdx / tmag, dz: tdz / tmag };
                                    reached = true;
                                    break;
                                } catch(e) {
                                    console.log(`[find_land] Could not reach (${treeTarget.x},${treeTarget.z}): ${e.message}`);
                                }
                            }
                            if (!reached) console.log('[find_land] Could not reach any oak tree — collect test may be slower.');
                        } else {
                            console.log('[find_land] No oak trees within 128b — collect test may fail.');
                        }
                    }
                }

                // ── Step 5: Summon test animals with guaranteed solid ground ────────
                // Mountain terrain means any offset > 1 block risks a cliff edge.
                // Place a stone platform under each spawn point first, then summon.
                // IMPORTANT: Navigate back to gx/gz before summoning. Step 4b may have
                // moved the bot to a tree position far from the land base. Kill tests
                // always run from the land base (gx/gz), so animals must be there.
                const animalSpawns = [
                    { dx: 2, dz: 0, mob: 'cow' },
                    { dx: 0, dz: 2, mob: 'pig' },
                    { dx: 2, dz: 2, mob: 'chicken' },
                ];
                await new Promise(r => setTimeout(r, 300));
                {
                    // Navigate back to land base (gx/gz) if step 4b moved us far away
                    const preSpawnPos = bot.entity.position;
                    const driftX = Math.abs(preSpawnPos.x - gx);
                    const driftZ = Math.abs(preSpawnPos.z - gz);
                    if (driftX > 10 || driftZ > 10) {
                        console.log(`[find_land] Step4b moved bot ${Math.round(Math.sqrt(driftX*driftX+driftZ*driftZ))}b from base. Returning to (${gx},${gz}) before summon.`);
                        try {
                            await withTimeout(
                                bot.pathfinder.goto(new goals.GoalXZ(gx, gz)),
                                30000, 'find_land return-to-base', () => bot.pathfinder.setGoal(null)
                            );
                        } catch(e) {
                            console.log(`[find_land] Return-to-base partial: ${e.message}`);
                        }
                        // Recompute gx/gz from actual landing position
                        const rp = computeGround();
                        gx = rp.cx; gz = rp.cz; groundY = rp.gy; logY = rp.ly;
                    }
                    const sp = bot.entity.position;
                    const spawnX = Math.round(sp.x), spawnZ = Math.round(sp.z);
                    // Find ground Y at current bot position
                    let spawnGroundY = Math.floor(sp.y) - 1;
                    for (let dy = 0; dy >= -10; dy--) {
                        const b = bot.blockAt(new Vec3(spawnX, Math.floor(sp.y) + dy, spawnZ));
                        if (b && b.boundingBox === 'block' && !b.name.includes('water')) {
                            spawnGroundY = Math.floor(sp.y) + dy; break;
                        }
                    }
                    console.log(`[find_land] Summoning animals near (${spawnX},${spawnGroundY + 1},${spawnZ})`);
                    for (const { dx, dz, mob } of animalSpawns) {
                        if (!landOk) break;
                        const ax = spawnX + dx, az = spawnZ + dz;
                        // Independently find the actual ground Y at this spawn offset.
                        // In all-ocean worlds even a 2-block offset can be sea surface.
                        let actualGroundY = spawnGroundY;
                        for (let ay = spawnGroundY + 3; ay >= spawnGroundY - 30; ay--) {
                            const b2 = bot.blockAt(new Vec3(ax, ay, az));
                            if (b2 && b2.boundingBox === 'block' && !b2.name.includes('water')) {
                                actualGroundY = ay; break;
                            }
                        }
                        // Fill a 2-high solid platform at this offset so animals don't fall
                        // into sea even if the edge is a cliff or open water.
                        landOk = await safeSend(`/fill ${ax - 1} ${actualGroundY} ${az - 1} ${ax + 1} ${actualGroundY} ${az + 1} minecraft:stone`);
                        if (landOk) landOk = await safeSend(`/fill ${ax - 1} ${actualGroundY + 1} ${az - 1} ${ax + 1} ${actualGroundY + 2} ${az + 1} minecraft:air replace`);
                        if (landOk) landOk = await safeSend(`/summon minecraft:${mob} ${ax} ${actualGroundY + 1} ${az}`);
                        await new Promise(r => setTimeout(r, 200)); // space out summons to avoid spam kick
                    }
                }

                if (movements) bot.pathfinder.setMovements(movements);

                if (!landOk) {
                    console.log('[find_land] Disconnected during setblock/summon — aborting.');
                    process.send({ type: 'USER_CHAT', data: { username: "System", message: 'find_land: disconnected during platform setup.', environment: getEnvironmentContext() } });
                    return;
                }

                const landPos = bot.entity.position;
                const blockBelow = bot.blockAt(landPos.offset(0, -1, 0));
                // Accept modded blocks: they appear as air/bb=empty to vanilla registry but
                // the server physics knows the bot is on solid ground (onGround=true).
                const onLand = bot.entity.onGround &&
                    blockBelow && !blockBelow.name.includes('water');
                const msg = onLand
                    ? `Platform ready. Bot at (${Math.round(landPos.x)},${Math.round(landPos.y)},${Math.round(landPos.z)}). Logs+animals placed.`
                    : `find_land: At (${Math.round(landPos.x)},${Math.round(landPos.y)},${Math.round(landPos.z)}) onGround=${bot.entity.onGround} below=${blockBelow?.name}.`;
                const invDebug = bot.inventory.items().map(i=>`${i.name}x${i.count}`).join(',') || '(empty)';
                console.log(`[find_land] ${msg} inv=[${invDebug}]`);
                process.send({ type: 'USER_CHAT', data: { username: "System", message: msg, environment: getEnvironmentContext() } });

            // ── blackboard_set ────────────────────────────────────────────────
            // Change 2: write a key/value pair to the shared blackboard file.
            } else if (action.action === 'blackboard_set') {
                const bbKey = action.key;
                const bbValue = action.value;
                if (bbKey !== undefined) {
                    const bbData = _readBlackboard();
                    bbData[bbKey] = bbValue;
                    _writeBlackboard(bbData);
                    const msg = `Blackboard: set "${bbKey}" = ${JSON.stringify(bbValue)}`;
                    bot.chat(`[System] ${msg}`);
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: msg, environment: getEnvironmentContext() } });
                } else {
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'blackboard_set: missing key.', environment: getEnvironmentContext() } });
                }

            // ── blackboard_get ────────────────────────────────────────────────
            // Change 2: read a key from the shared blackboard file.
            } else if (action.action === 'blackboard_get') {
                const bbKey = action.key;
                if (bbKey !== undefined) {
                    const bbData = _readBlackboard();
                    const bbVal = bbData.hasOwnProperty(bbKey) ? bbData[bbKey] : null;
                    const msg = `Blackboard: "${bbKey}" = ${JSON.stringify(bbVal)}`;
                    bot.chat(`[System] ${msg}`);
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: msg, environment: getEnvironmentContext() } });
                } else {
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'blackboard_get: missing key.', environment: getEnvironmentContext() } });
                }

            // ── fly ───────────────────────────────────────────────────────────
            // Fly to (x, y, z) using an Elytra or modded Jetpack.
            // The aviation device is auto-detected from the torso slot; if none is
            // equipped the bot searches inventory for one and equips it first.
            // Supported params: x, z (required), y (optional — defaults to +20 above current).
            } else if (action.action === 'fly') {
                const destX = action.x !== undefined ? parseFloat(action.x) : bot.entity.position.x;
                const destZ = action.z !== undefined ? parseFloat(action.z) : bot.entity.position.z;
                const destY = action.y !== undefined ? parseFloat(action.y) : null;

                // Auto-equip an aviation device if the torso slot has none.
                const torsoSlotIdx = bot.getEquipmentDestSlot('torso');
                let torsoItem = bot.inventory.slots[torsoSlotIdx];
                if (!detectAviationMethod(torsoItem)) {
                    // Prefer elytra; fall back to any jetpack.
                    const elytra = bot.inventory.items().find(i => i.name === 'elytra');
                    const jetpack = !elytra && bot.inventory.items().find(i => detectAviationMethod(i));
                    const toEquip = elytra || jetpack;
                    if (toEquip) {
                        try {
                            if (torsoItem) await bot.unequip('torso');
                            await bot.equip(toEquip, 'torso');
                            torsoItem = bot.inventory.slots[torsoSlotIdx];
                            bot.chat(`[System] Equipped ${toEquip.name} for flight.`);
                        } catch (e) {
                            bot.chat(`[System Error] Could not equip aviation device: ${e.message}`);
                        }
                    }
                }

                const aviation = detectAviationMethod(bot.inventory.slots[torsoSlotIdx]);
                if (!aviation) {
                    bot.chat('[System Error] No Elytra or Jetpack available for flight.');
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'No aviation device found in torso slot or inventory.', environment: getEnvironmentContext() } });
                } else if (aviation === 'elytra') {
                    const yTarget = destY !== null ? destY : Math.max(bot.entity.position.y + 30, 128);
                    await flyWithElytra(destX, yTarget, destZ, currentCancelToken);
                    if (!currentCancelToken.cancelled) {
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: `Elytra flight to X:${Math.round(destX)} Y:${Math.round(yTarget)} Z:${Math.round(destZ)} complete.`, environment: getEnvironmentContext() } });
                    }
                } else {
                    // Jetpack — dynamic config from JETPACK_MOD_REGISTRY.
                    const yTarget = destY !== null ? destY : bot.entity.position.y + 20;
                    await flyWithJetpack(destX, yTarget, destZ, aviation.config, currentCancelToken);
                    if (!currentCancelToken.cancelled) {
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: `Jetpack (${aviation.mod}) flight to X:${Math.round(destX)} Y:${Math.round(yTarget)} Z:${Math.round(destZ)} complete.`, environment: getEnvironmentContext() } });
                    }
                }

            // ── stop ──────────────────────────────────────────────────────────
            } else if (action.action === 'stop') {
                // Issue 6: explicit stop — halt everything and disable idle combat
                _inStopMode = true;
                bot.pathfinder.setGoal(null);
                try { bot.clearControlStates(); } catch(e) {}
                bot.deactivateItem();

            // ── wait ──────────────────────────────────────────────────────────
            // ── activate_block ─────────────────────────────────────────────────
            // Right-click (optionally while sneaking) on a block.
            // Supports equipping a specific item and choosing which block face to use.
            // Primary use: Create MOD wrench (sneak+right-click = pickup,
            // right-click = rotate), industrial MOD interactions, etc.
            //
            //   { action:"activate_block", x:10, y:65, z:20,
            //     item:"create:wrench",   -- optional: equip before clicking
            //     sneak:true,             -- optional: hold sneak during click
            //     face:"top"             -- optional: "top"|"bottom"|"north"|"south"|"east"|"west"
            //   }
            } else if (action.action === 'activate_block') {
                const { x, y, z } = action;
                if (x === undefined || y === undefined || z === undefined) {
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'activate_block requires x, y, z.', environment: getEnvironmentContext() } });
                } else {
                    // Navigate near the block
                    await withTimeout(
                        bot.pathfinder.goto(new goals.GoalNear(Number(x), Number(y), Number(z), 3)),
                        timeoutMs, 'goto for activate_block', () => bot.pathfinder.setGoal(null)
                    ).catch(() => {});

                    // Equip specified item
                    if (action.item) {
                        const itemName = String(action.item);
                        const item = bot.inventory.items().find(i =>
                            i.name === itemName ||
                            i.name.endsWith(':' + itemName) ||
                            i.name.includes(itemName)
                        );
                        if (item) {
                            try { await bot.equip(item, 'hand'); } catch (e) {}
                        } else {
                            process.send({ type: 'USER_CHAT', data: { username: 'System', message: `activate_block: item "${itemName}" not in inventory.`, environment: getEnvironmentContext() } });
                        }
                    }

                    const block = bot.blockAt(new Vec3(Number(x), Number(y), Number(z)));
                    if (!block || block.name === 'air') {
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: `No block at (${x},${y},${z}).`, environment: getEnvironmentContext() } });
                    } else {
                        const wasSneak = bot.getControlState('sneak');
                        if (action.sneak) bot.setControlState('sneak', true);
                        const { FACE_VECTORS } = require('./mod_interaction_executor');
                        const faceVec = FACE_VECTORS[action.face] || null;
                        try {
                            await bot.activateBlock(block, faceVec);
                            process.send({ type: 'USER_CHAT', data: { username: 'System', message: `Successfully activated block ${block.name} at (${x},${y},${z}).`, environment: getEnvironmentContext() } });
                        } catch (e) {
                            process.send({ type: 'USER_CHAT', data: { username: 'System', message: `activate_block failed: ${e.message}`, environment: getEnvironmentContext() } });
                        } finally {
                            if (action.sneak && !wasSneak) bot.setControlState('sneak', false);
                        }
                    }
                }

            // ── macro ──────────────────────────────────────────────────────────
            // Execute a sequence of primitive interaction steps generated by the LLM.
            // This is the main building block for MOD-specific interactions where
            // the LLM has looked up wiki information and constructed the exact steps.
            //
            // Example (Create MOD wrench pickup):
            //   { action: "macro", description: "Pick up Create block with wrench",
            //     steps: [
            //       { primitive: "equip",          item: "create:wrench" },
            //       { primitive: "goto",            x: 10, y: 64, z: 20, tolerance: 3 },
            //       { primitive: "look_at",         x: 10, y: 65, z: 20 },
            //       { primitive: "sneak",           value: true },
            //       { primitive: "activate_block",  x: 10, y: 65, z: 20 },
            //       { primitive: "sneak",           value: false }
            //     ]
            //   }
            //
            // Available primitives: equip, goto, look_at, sneak, sprint,
            //   activate_block, activate_item, swing_arm, attack_block,
            //   wait, send_packet, chat
            } else if (action.action === 'macro') {
                const steps = Array.isArray(action.steps) ? action.steps : [];
                const desc = action.description || 'macro';
                if (steps.length === 0) {
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'macro: no steps provided.', environment: getEnvironmentContext() } });
                } else {
                    console.log(`[Actuator] Executing macro "${desc}" (${steps.length} steps)`);
                    bot.chat(`[System] Running macro: ${desc}`);
                    const continueOnError = !!action.continue_on_error;
                    const result = await executeMacro(bot, steps, currentCancelToken, continueOnError);
                    if (result.ok) {
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: `Macro "${desc}" completed successfully (${result.stepsRun} steps).`, environment: getEnvironmentContext() } });
                    } else {
                        const errSummary = result.errors.slice(0, 3).join('; ');
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: `Macro "${desc}" failed after ${result.stepsRun} steps: ${errSummary}`, environment: getEnvironmentContext() } });
                    }
                }

            // ── wiki_search ────────────────────────────────────────────────────
            // Search the local wiki index for MOD interaction info and return
            // the results to the LLM as a SYSTEM message.
            // The LLM uses the results to construct a macro or activate_block action.
            //
            //   { action: "wiki_search", query: "create mod wrench usage pickup block" }
            } else if (action.action === 'wiki_search') {
                const query = String(action.query || action.target || '');
                if (!query) {
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'wiki_search: query is empty.', environment: getEnvironmentContext() } });
                } else {
                    let wikiResult = '';
                    try {
                        const topN = Math.min(Number(action.top_n) || 5, 10);
                        const results = wikiRag.search(query, topN);
                        if (results.length === 0) {
                            wikiResult = `[Wiki] No results found for "${query}". Try rephrasing or use activate_block/macro directly.`;
                        } else {
                            const lines = results.map((r, i) => `[${i+1}] (${r.file}:${r.line}) ${r.text}`);
                            wikiResult = `[Wiki results for "${query}"]:\n${lines.join('\n')}\n\nBased on this, construct a macro or activate_block action to perform the interaction.`;
                        }
                    } catch (e) {
                        wikiResult = `[Wiki] Search error: ${e.message}`;
                    }
                    console.log(`[Actuator] wiki_search "${query}" → ${wikiResult.length} chars`);
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: wikiResult, environment: getEnvironmentContext() } });
                }

            // ── send_custom_payload ────────────────────────────────────────────
            // Send a Forge custom payload packet (ServerboundCustomPayloadPacket).
            // Used for MOD keybinding events that require a server-side packet.
            // Example: remote storage access, tool mode toggle, etc.
            //
            //   { action: "send_custom_payload",
            //     channel: "modname:channel_name",
            //     data: "0100ff"   -- optional hex string
            //   }
            } else if (action.action === 'send_custom_payload') {
                const channel = String(action.channel || '');
                if (!channel || !channel.includes(':')) {
                    process.send({ type: 'USER_CHAT', data: { username: 'System', message: 'send_custom_payload: channel must be "modname:channel_name".', environment: getEnvironmentContext() } });
                } else {
                    try {
                        let dataBuf = Buffer.alloc(0);
                        if (action.data) {
                            const hexStr = String(action.data).replace(/\s+/g, '');
                            if (hexStr.length % 2 !== 0) throw new Error('data hex string must have even length');
                            dataBuf = Buffer.from(hexStr, 'hex');
                        }
                        bot._client.write('custom_payload', { channel, data: dataBuf });
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: `Sent custom packet to channel "${channel}" (${dataBuf.length} bytes).`, environment: getEnvironmentContext() } });
                    } catch (e) {
                        process.send({ type: 'USER_CHAT', data: { username: 'System', message: `send_custom_payload failed: ${e.message}`, environment: getEnvironmentContext() } });
                    }
                }

            // Issue 6: enter idle-combat mode immediately (fights nearby threats
            // until a new instruction cancels the token).
            } else if (action.action === 'wait') {
                bot.chat('[System] On standby. Monitoring for threats...');
                await runWaitLoop();

            } // end action dispatch

            // VDS-001: trace action complete
            debugTrace.logEvent(botId, 'complete', action.action, bot.entity?.position);

        } catch (err) {
            // VDS-001: trace action fail
            debugTrace.logEvent(botId, 'fail', action ? action.action : 'unknown', bot.entity?.position, { reason: err.message });
            console.error(`[Actuator] Action execution failed: ${err.message}`);
            if (bot._client.chat) bot.chat("[System Error] An error occurred.");
            bot.pathfinder.setGoal(null);
            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Action failed: ${err.message}`, environment: getEnvironmentContext() } });
        }
    }

    // Issue 6: Auto-transition to idle combat after completing all queued actions.
    // This loop runs until a new EXECUTE_ACTION arrives (sets currentCancelToken.cancelled)
    // or the bot was explicitly stopped (_inStopMode = true).
    if (!currentCancelToken.cancelled && !_inStopMode) {
        await runWaitLoop();
    }

    // Bug Fix 10: All actions completed normally — clear the checkpoint so stale
    // tasks are not re-queued on the next restart.
    _clearQueueCheckpoint();

    currentAction = null;
    isExecuting = false;
}

process.on('message', async (msg) => {
    // Improvement 1: ASYNC_CHAT delivers a response immediately without cancelling the current action.
    // Used for '-!' prefixed queries (e.g. status checks while bot is busy with another task).
    if (msg.type === 'ASYNC_CHAT') {
        try {
            if (bot._client?.socket?.writable === true && msg.text) {
                bot.chat(msg.text);
            }
        } catch (e) {}
        return;
    }

    if (msg.type === 'EXECUTE_ACTION') {
        let actions = msg.action;
        if (!Array.isArray(actions)) actions = [actions];

        // Bug Fix 2: queue_op controls how incoming actions relate to the current queue.
        //   replace (default) — cancel current tasks and start fresh (previous behaviour)
        //   append            — add new actions to the end of the current queue
        //   ignore            — do nothing if the bot is currently executing a task
        const queueOp = (msg.queue_op || 'replace').toLowerCase();

        // If bot hasn't finished login/spawn yet, buffer the action
        if (!_botReady) {
            console.log(`[Actuator] Bot not ready yet — buffering ${actions.length} action(s).`);
            _pendingIpcActions.push(actions);
            return;
        }

        // ── ignore: discard new actions while busy ───────────────────────────
        if (queueOp === 'ignore' && (isExecuting || actionQueue.length > 0)) {
            console.log(`[Actuator] queue_op=ignore: bot is busy, discarding ${actions.length} incoming action(s).`);
            return;
        }

        // ── append: tack onto the current queue without cancelling ───────────
        if (queueOp === 'append') {
            _inStopMode = false;
            actionQueue.push(...actions);
            console.log(`[Actuator] queue_op=append: added ${actions.length} action(s). Queue length now ${actionQueue.length}.`);
            if (!isExecuting) processActionQueue();
            return;
        }

        // ── replace (default): cancel current tasks and start fresh ──────────

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
            _inStopMode = true; // Issue 6: prevent auto-idle-combat after stop
            return;
        }

        // Any non-stop instruction clears stop mode
        _inStopMode = false;

        if (remaining.length > 0) {
            process.send({ type: 'USER_CHAT', data: { username: "System", message: `Task interrupted. Remaining actions in queue: ${JSON.stringify(remaining)}`, environment: getEnvironmentContext() } });
        }

        // 4. Fresh token + queue for the new command
        currentCancelToken = { cancelled: false };
        actionQueue.push(...actions);
        // Bug Fix 10: Persist the incoming queue so a crash/disconnect can resume it.
        _saveQueueCheckpoint(actionQueue);
        processActionQueue();
        return;
    }

    if (msg.type === 'EXTERNAL_ENTITY_UPDATE' && msg.data) {
        const data = msg.data;
        if (data.playerName && data.position && Number.isFinite(data.position.x) && Number.isFinite(data.position.y) && Number.isFinite(data.position.z)) {
            _externalPlayerPositions.set(data.playerName, {
                x: data.position.x,
                y: data.position.y,
                z: data.position.z,
                dimension: data.dimension || null,
                updatedAt: Date.now()
            });
        }
        if (Array.isArray(data.players)) {
            for (const player of data.players) {
                if (!player || (!player.name && !player.playerName)) continue;
                if (!Number.isFinite(player.x) || !Number.isFinite(player.y) || !Number.isFinite(player.z)) continue;
                const name = player.name || player.playerName;
                _externalPlayerPositions.set(name, {
                    x: player.x,
                    y: player.y,
                    z: player.z,
                    dimension: data.dimension || null,
                    updatedAt: Date.now()
                });
            }
        }
        if (Array.isArray(data.nearbyEntities)) {
            for (const ent of data.nearbyEntities) {
                const name = ent?.name;
                const type = String(ent?.type || '').toLowerCase();
                if (!name || (!type.includes('player') && !type.includes('minecraft.player'))) continue;
                if (!Number.isFinite(ent.x) || !Number.isFinite(ent.y) || !Number.isFinite(ent.z)) continue;
                _externalPlayerPositions.set(name, {
                    x: ent.x,
                    y: ent.y,
                    z: ent.z,
                    dimension: data.dimension || null,
                    updatedAt: Date.now()
                });
            }
        }
    }
});

// Global Error Handling
// Track whether we already notified AgentManager of a disconnect to avoid double-recovery.
let _disconnectedNotified = false;
bot.on('kicked', (reason) => {
    console.log(`[Actuator] Kicked: ${reason}`);
    _disconnectedNotified = true;
    currentCancelToken.cancelled = true;
    actionQueue = [];
    try { bot.pathfinder.setGoal(null); } catch (_) {}
    process.send({ type: 'ERROR', category: 'Kicked', details: reason });
});
bot.on('error', (err) => {
    console.error(`[Actuator] Bot Error: ${err.message}`);
    _disconnectedNotified = true;
    currentCancelToken.cancelled = true;
    actionQueue = [];
    try { bot.pathfinder.setGoal(null); } catch (_) {}
    process.send({ type: 'ERROR', category: 'BotError', details: err.message });
});
// Fix: 'end' fires when the server closes the connection gracefully (FIN, not RST).
// Without this, AgentManager never learns the bot died and never restarts it.
bot.on('end', () => {
    console.log('[Actuator] Disconnected from server.');
    if (!_disconnectedNotified) {
        _disconnectedNotified = true;
        currentCancelToken.cancelled = true;
        actionQueue = [];
        try { bot.pathfinder.setGoal(null); } catch (_) {}
        process.send({ type: 'ERROR', category: 'Disconnected', details: 'Server closed connection' });
    }
});
