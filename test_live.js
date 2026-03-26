/**
 * Live integration test script.
 * Connects to the running bot process by creating its own AgentManager
 * and sends IPC commands directly.  Monitors ai_debug_<botId>.json for position
 * updates to measure movement speed and accuracy.
 *
 * Usage: MC_HOST=172.24.96.1 node test_live.js
 */
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const host = process.env.MC_HOST || '172.24.96.1';
const port = parseInt(process.env.MC_PORT || '25565', 10);

// Each test bot gets a unique name
const BOTS = {};
let testResults = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readDebug(botId) {
    try { return JSON.parse(fs.readFileSync(`ai_debug_${botId}.json`, 'utf8')); }
    catch { return null; }
}

/**
 * Wait until the debug file has a timestamp newer than afterMs.
 * The file is written every 5 s, so worst-case wait is ~5 s.
 */
async function waitForFreshDebug(botId, afterMs, maxWait = 8000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        const d = readDebug(botId);
        if (d && d.timestamp && new Date(d.timestamp).getTime() > afterMs) return d;
        await sleep(500);
    }
    return readDebug(botId); // fallback — may still be slightly stale
}

function spawnBot(botId) {
    console.log(`[Test] Spawning bot: ${botId}`);
    const botProcess = fork(path.join(__dirname, 'src/bot_actuator.js'), [], {
        // DEBUG=true: find_land uses /tp + /effect + /give instead of pathfinding,
        // ensuring bots start on dry land with full health and stocked with oak_log.
        env: { ...process.env, BOT_ID: botId, BOT_OPTIONS: JSON.stringify({ host, port }), DEBUG: 'true' }
    });

    BOTS[botId] = { process: botProcess, messages: [], ready: false };

    botProcess.on('message', (msg) => {
        msg._receivedAt = Date.now(); // timestamp for filtering stale messages
        BOTS[botId].messages.push(msg);
        if (msg.type === 'USER_CHAT') {
            console.log(`[${botId}] ${msg.data.username}: ${msg.data.message}`);
        }
    });

    botProcess.on('exit', (code) => {
        console.log(`[Test] Bot ${botId} exited with code ${code}`);
    });

    return botProcess;
}

function sendAction(botId, actions) {
    if (!Array.isArray(actions)) actions = [actions];
    BOTS[botId].process.send({ type: 'EXECUTE_ACTION', action: actions });
}

async function waitForMessage(botId, filter, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        // Only match messages that arrived at or after this wait started (avoids
        // stale messages from a previous timed-out test bleeding into the next one).
        const idx = BOTS[botId].messages.findIndex(m => (m._receivedAt || 0) >= start && filter(m));
        if (idx !== -1) {
            return BOTS[botId].messages.splice(idx, 1)[0];
        }
        await sleep(500);
    }
    return null;
}

/**
 * Wait until the bot's debug health is above minHp. With /effect regeneration applied
 * during find_land, the bot heals fast but bot.health lags behind the server value.
 * Polling the debug file gives the authoritative value once it's written.
 */
async function waitForHealth(botId, minHp = 10, maxWaitMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const d = readDebug(botId);
        if (d && d.health >= minHp) return d.health;
        await sleep(1000);
    }
    const d = readDebug(botId);
    console.log(`[Test] ${botId} health after wait: ${d?.health ?? 'unknown'}`);
    return d?.health ?? 0;
}

async function waitForReady(botId, timeoutMs = 120000) {
    console.log(`[Test] Waiting for ${botId} to connect and spawn...`);
    // Delete stale debug file so we wait for a genuinely fresh entry
    try { fs.unlinkSync(`ai_debug_${botId}.json`); } catch (e) {}
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const debug = readDebug(botId);
        if (debug && debug.timestamp) {
            const age = Date.now() - new Date(debug.timestamp).getTime();
            // Accept if the file was written after we started waiting AND is recent
            const fileCreated = new Date(debug.timestamp).getTime() > start;
            if (fileCreated && age < 10000 && debug.health > 0 && debug.ready === true) {
                console.log(`[Test] ${botId} is ready at (${debug.position.x}, ${debug.position.y}, ${debug.position.z})`);
                BOTS[botId].ready = true;
                // Extra wait to let the bot fully settle before sending commands
                await sleep(5000);
                return;
            }
        }
        await sleep(2000);
    }
    console.log(`[Test] WARNING: ${botId} did not become ready within timeout`);
}

async function measureSpeed(botId, targetX, targetZ, label) {
    // Record start position from debug file
    const startDebug = readDebug(botId);
    if (!startDebug) { console.log('[Test] No debug data'); return null; }

    const startPos = { x: startDebug.position.x, z: startDebug.position.z };
    const startTime = Date.now();

    sendAction(botId, { action: 'goto', x: targetX, z: targetZ, timeout: 120 });

    // Wait for completion message
    const result = await waitForMessage(botId, m =>
        m.type === 'USER_CHAT' && m.data.username === 'System' &&
        (m.data.message.includes('Reached') || m.data.message.includes('Cannot') || m.data.message.includes('failed')),
        120000
    );

    const endTime = Date.now();

    // Wait for a fresh debug file write that reflects the post-goto position.
    // The file is updated every 5 s; without this wait the measured accuracy can
    // be off by a full 5-second window of drift.
    const endDebug = await waitForFreshDebug(botId, endTime - 1000);

    if (endDebug) {
        const dx = endDebug.position.x - startPos.x;
        const dz = endDebug.position.z - startPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const elapsedSec = (endTime - startTime) / 1000;
        const speed = dist / elapsedSec;

        const endDist = Math.sqrt(
            Math.pow(targetX - endDebug.position.x, 2) +
            Math.pow(targetZ - endDebug.position.z, 2)
        );

        // Pass criteria differ by test:
        //   short (32b):  bot must reach within 10b (accuracy primary, speed secondary)
        //   medium (100b): bot must reach within 15b at reasonable speed
        //   long (200b):  bot must reach within 40b (longer path = more lateral drift)
        //   return:       same as medium
        let pass;
        if (label.includes('short')) {
            pass = endDist < 10 && speed > 0.7; // 0.7 b/s: water near anchor can slow to ~0.85
        } else if (label.includes('long')) {
            pass = endDist < 40 && speed > 1.2;
        } else {
            pass = endDist < 15 && speed > 1.5;
        }
        const resultObj = {
            test: label,
            distance: Math.round(dist * 10) / 10,
            time: Math.round(elapsedSec * 10) / 10,
            speed: Math.round(speed * 100) / 100,
            accuracy: Math.round(endDist * 10) / 10,
            status: result ? result.data.message : 'timeout',
            pass
        };

        console.log(`[Test Result] ${label}: ${dist.toFixed(1)} blocks in ${elapsedSec.toFixed(1)}s = ${speed.toFixed(2)} b/s, accuracy: ${endDist.toFixed(1)} blocks from target | ${resultObj.pass ? 'PASS' : 'FAIL'}`);
        testResults.push(resultObj);
        return resultObj;
    }
    return null;
}

async function testFollow(botId, playerName, durationSec = 20) {
    console.log(`\n=== TEST: Follow ${playerName} for ${durationSec}s ===`);
    const startDebug = readDebug(botId);
    const startTime = Date.now();

    sendAction(botId, { action: 'come', target: playerName });

    // Let it follow for durationSec
    await sleep(durationSec * 1000);

    // Stop following
    sendAction(botId, { action: 'stop' });
    await sleep(2000);

    const endDebug = await waitForFreshDebug(botId, startTime + durationSec * 1000);
    if (startDebug && endDebug) {
        const dx = endDebug.position.x - startDebug.position.x;
        const dz = endDebug.position.z - startDebug.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const speed = dist / durationSec;

        const resultObj = {
            test: `follow_${playerName}`,
            distance: Math.round(dist * 10) / 10,
            time: durationSec,
            speed: Math.round(speed * 100) / 100,
            status: dist > 2 ? 'moved' : 'barely moved',
            pass: speed > 2.0  // At least 2 b/s while following a moving player
        };

        console.log(`[Test Result] Follow: moved ${dist.toFixed(1)} blocks in ${durationSec}s = ${speed.toFixed(2)} b/s | ${resultObj.pass ? 'PASS' : 'FAIL'}`);
        testResults.push(resultObj);
    }
}

async function testCollect(botId, target, quantity, label) {
    console.log(`\n=== TEST: Collect ${quantity} ${target} ===`);
    const startTime = Date.now();

    sendAction(botId, { action: 'collect', target, quantity, timeout: 120 });

    const result = await waitForMessage(botId, m =>
        m.type === 'USER_CHAT' && m.data.username === 'System' &&
        (m.data.message.includes('collected') || m.data.message.includes('Could not') || m.data.message.includes('need')),
        120000
    );

    const elapsed = (Date.now() - startTime) / 1000;
    const msg = result ? result.data.message : 'timeout';

    const resultObj = {
        test: label,
        time: Math.round(elapsed * 10) / 10,
        status: msg,
        pass: msg.includes('Successfully') || msg.includes('Partially collected')
    };

    console.log(`[Test Result] ${label}: ${elapsed.toFixed(1)}s - ${msg} | ${resultObj.pass ? 'PASS' : 'FAIL'}`);
    testResults.push(resultObj);
}

async function testCraft(botId, target, quantity, label) {
    console.log(`\n=== TEST: Craft ${quantity} ${target} ===`);
    sendAction(botId, { action: 'craft', target, quantity, timeout: 60 });

    const result = await waitForMessage(botId, m =>
        m.type === 'USER_CHAT' && m.data.username === 'System' &&
        (m.data.message.includes('craft') || m.data.message.includes('Craft')),
        60000
    );

    const msg = result ? result.data.message : 'timeout';
    const resultObj = {
        test: label,
        status: msg,
        pass: msg.includes('Successfully')
    };

    console.log(`[Test Result] ${label}: ${msg} | ${resultObj.pass ? 'PASS' : 'FAIL'}`);
    testResults.push(resultObj);
}

async function testKill(botId, target, quantity, label) {
    console.log(`\n=== TEST: Kill ${quantity} ${target} ===`);
    sendAction(botId, { action: 'kill', target, quantity, timeout: 60 });

    const result = await waitForMessage(botId, m =>
        m.type === 'USER_CHAT' && m.data.username === 'System' &&
        (m.data.message.includes('killed') || m.data.message.includes('not found') || m.data.message.includes('Failed to kill')),
        80000
    );

    const msg = result ? result.data.message : 'timeout';
    const resultObj = {
        test: label,
        status: msg,
        pass: msg.includes('Successfully') || msg.includes('Partially')
    };

    console.log(`[Test Result] ${label}: ${msg} | ${resultObj.pass ? 'PASS' : 'FAIL'}`);
    testResults.push(resultObj);
}

async function testFindLand(botId) {
    console.log(`\n=== SETUP: find_land for ${botId} ===`);
    sendAction(botId, { action: 'find_land' });

    // Up to 180s: TP + buffs + chunk load + navigate to natural trees (up to 150b)
    const result = await waitForMessage(botId, m =>
        m.type === 'USER_CHAT' && m.data.username === 'System' &&
        (m.data.message.includes('Platform ready') || m.data.message.includes('find_land:') ||
         m.data.message.includes('disconnected during')),
        180000
    );

    const msg = result ? result.data.message : 'timeout - proceeding with current position';
    console.log(`[Test Setup] ${msg}`);
    if (msg.includes('disconnected')) {
        console.log('[Test] WARNING: Bot disconnected during find_land setup. Subsequent tests will fail.');
    }
    // Extra settle time after large teleport
    await sleep(3000);
    return result;
}

async function testStatus(botId) {
    console.log(`\n=== TEST: Status ===`);
    sendAction(botId, { action: 'status' });

    const result = await waitForMessage(botId, m =>
        m.type === 'USER_CHAT' && m.data.username === 'System' &&
        m.data.message.includes('Status:'),
        10000
    );

    const msg = result ? result.data.message : 'timeout';
    const resultObj = {
        test: 'status',
        status: msg,
        pass: msg.includes('HP')
    };

    console.log(`[Test Result] Status: ${msg} | ${resultObj.pass ? 'PASS' : 'FAIL'}`);
    testResults.push(resultObj);
}

// ─── Main test sequence ──────────────────────────────────────────────────────
async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  Minecraft AI Bot Live Integration Test Suite       ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // Clean up stale debug files from previous runs
    for (const id of ['AI_Bot_01', 'AI_Bot_02']) {
        try { fs.unlinkSync(`ai_debug_${id}.json`); } catch (e) {}
    }
    await sleep(1000);

    // ── Spawn and initialise Test Bot 1 ────────────────────────────────────
    spawnBot('AI_Bot_01');
    await waitForReady('AI_Bot_01', 90000);

    // ── Setup: Teleport to land so movement/collect/craft/kill tests can run ──
    await testFindLand('AI_Bot_01');
    // Capture the land base position for the return test
    const landBase = readDebug('AI_Bot_01');

    // ── Test 1: Status ──────────────────────────────────────────────────────
    await testStatus('AI_Bot_01');

    // After find_land, the bot may have died and respawned far away (e.g., if it was
    // TP'd to a player in a dangerous area). If so, navigate back to the land base
    // so kill/collect tests run from the right position.
    const postFindDebug = readDebug('AI_Bot_01');
    if (landBase && postFindDebug) {
        const dx = postFindDebug.position.x - landBase.position.x;
        const dz = postFindDebug.position.z - landBase.position.z;
        const distFromBase = Math.sqrt(dx * dx + dz * dz);
        if (distFromBase > 20) {
            console.log(`[Test] Bot drifted ${distFromBase.toFixed(0)}b from find_land base — navigating back.`);
            sendAction('AI_Bot_01', { action: 'goto', x: landBase.position.x, z: landBase.position.z, timeout: 90 });
            await waitForMessage('AI_Bot_01', m =>
                m.type === 'USER_CHAT' && m.data.username === 'System' &&
                (m.data.message.includes('Reached') || m.data.message.includes('Cannot') || m.data.message.includes('failed')),
                100000
            );
            await sleep(2000);
        }
    }

    // Wait for the bot to heal before kill tests. find_land applies /effect regeneration
    // but bot.health lags the server value. Waiting ensures the bot is above the flee
    // threshold (health < 6 triggers permanent flee instead of attacking).
    await waitForHealth('AI_Bot_01', 10, 15000);

    // ── Test 2: Kill animal — run early while summoned animals are still nearby ─
    // find_land summons cow/pig/chicken ~8 blocks away; run kills before gotos
    // move the bot far from the spawn area.
    // Navigate back to land base between kill attempts: kill_cow wander can move
    // the bot 60b away, putting it far from summoned pig/chicken.
    async function returnToLandBaseForKill() {
        if (!landBase) return;
        const d = readDebug('AI_Bot_01');
        if (!d) return;
        const dist = Math.sqrt((d.position.x - landBase.position.x) ** 2 + (d.position.z - landBase.position.z) ** 2);
        if (dist > 15) {
            console.log(`[Test] Returning to land base (${dist.toFixed(0)}b drift) before next kill...`);
            sendAction('AI_Bot_01', { action: 'goto', x: landBase.position.x, z: landBase.position.z, timeout: 60 });
            await waitForMessage('AI_Bot_01', m =>
                m.type === 'USER_CHAT' && m.data.username === 'System' &&
                (m.data.message.includes('Reached') || m.data.message.includes('Cannot') || m.data.message.includes('failed')),
                70000
            );
        }
    }
    await testKill('AI_Bot_01', 'cow', 1, 'kill_cow');
    const firstKill = testResults[testResults.length - 1];
    if (!firstKill.pass) {
        await returnToLandBaseForKill();
        await testKill('AI_Bot_01', 'pig', 1, 'kill_pig');
        const pigResult = testResults[testResults.length - 1];
        if (!pigResult.pass) {
            await returnToLandBaseForKill();
            await testKill('AI_Bot_01', 'chicken', 1, 'kill_chicken');
        }
    }

    // ── Test 3: Collect oak_log ─────────────────────────────────────────────
    // find_land places logs at (+3..+7, +3) from base.
    // Kill tests may chase animals 30-50b away; navigate back so the placed
    // logs are within the 32-block search radius (avoids triggering auto-craft).
    if (landBase) {
        const postKillDebug = readDebug('AI_Bot_01');
        if (postKillDebug) {
            const dk = Math.sqrt(
                (postKillDebug.position.x - landBase.position.x) ** 2 +
                (postKillDebug.position.z - landBase.position.z) ** 2
            );
            if (dk > 10) {
                console.log(`[Test] Returning to log area (${dk.toFixed(0)}b drift) before collect...`);
                sendAction('AI_Bot_01', { action: 'goto', x: landBase.position.x, z: landBase.position.z, timeout: 60 });
                await waitForMessage('AI_Bot_01', m =>
                    m.type === 'USER_CHAT' && m.data.username === 'System' &&
                    (m.data.message.includes('Reached') || m.data.message.includes('Cannot') || m.data.message.includes('failed')),
                    70000
                );
                await sleep(1000);
            }
        }
    }
    await testCollect('AI_Bot_01', 'oak_log', 3, 'collect_oak_log');

    // Navigate back to landBase after collect — the collect action may have taken
    // the bot far from the base (60+ blocks to reach distant trees), putting it in
    // dangerous terrain. Return to safe ground before craft to avoid death + item loss.
    // Also: capture post-collect position for terrain direction. The bot navigated to
    // oak trees, which are in navigable terrain. This gives a reliable terrain direction
    // for goto tests (better than the always-west (-1,0) fallback).
    let collectTerrainDir = null;
    if (landBase) {
        const postCollectDebug = readDebug('AI_Bot_01');
        if (postCollectDebug) {
            const rdx = postCollectDebug.position.x - landBase.position.x;
            const rdz = postCollectDebug.position.z - landBase.position.z;
            const dc = Math.sqrt(rdx * rdx + rdz * rdz);
            // Capture collect terrain direction if bot navigated significantly from base
            if (dc > 20) {
                collectTerrainDir = { dx: rdx / dc, dz: rdz / dc };
                console.log(`[Test] Collect terrain dir: (${collectTerrainDir.dx.toFixed(2)}, ${collectTerrainDir.dz.toFixed(2)}) (${dc.toFixed(0)}b to logs)`);
            }
            if (dc > 10) {
                console.log(`[Test] Returning to safe area after collect (${dc.toFixed(0)}b drift)...`);
                sendAction('AI_Bot_01', { action: 'goto', x: landBase.position.x, z: landBase.position.z, timeout: 60 });
                await waitForMessage('AI_Bot_01', m =>
                    m.type === 'USER_CHAT' && m.data.username === 'System' &&
                    (m.data.message.includes('Reached') || m.data.message.includes('Cannot') || m.data.message.includes('failed')),
                    70000
                );
                await sleep(1000);
            }
        }
    }

    // ── Test 4: Craft planks — bot has logs from collect ────────────────────
    await testCraft('AI_Bot_01', 'oak_planks', 1, 'craft_oak_planks');

    // Return to land base before goto tests. Kill/collect tests may have moved the bot
    // far from the find_land position (e.g. chasing animals into water or off structures).
    // Goto tests from a known good terrain position gives consistent speed measurements.
    if (landBase) {
        console.log(`[Test] Returning to land base (${landBase.position.x}, ${landBase.position.z}) before goto tests...`);
        sendAction('AI_Bot_01', { action: 'goto', x: landBase.position.x, z: landBase.position.z, timeout: 90 });
        await waitForMessage('AI_Bot_01', m =>
            m.type === 'USER_CHAT' && m.data.username === 'System' &&
            (m.data.message.includes('Reached') || m.data.message.includes('Cannot') || m.data.message.includes('failed')),
            100000
        );
        await sleep(2000);
    }

    // ── Compute terrain-safe direction once for all goto tests ──────────────
    // Priority: treeDir (find_land step 4b) > collectTerrainDir > heuristic > -X fallback.
    // treeDir = direction from land base toward oak trees (validated navigable terrain).
    // collectTerrainDir = direction bot navigated during collect (also validated terrain).
    // Both are better than blindly going west (-1,0) which often hits mountains.
    const startDebug = readDebug('AI_Bot_01');
    let terrainDx = -1, terrainDz = 0; // fallback: -X
    if (startDebug && startDebug.treeDir) {
        // Recorded during find_land step 4b — most reliable
        terrainDx = startDebug.treeDir.dx;
        terrainDz = startDebug.treeDir.dz;
    } else if (collectTerrainDir) {
        // Direction bot navigated to reach oak logs — also navigable terrain
        terrainDx = collectTerrainDir.dx;
        terrainDz = collectTerrainDir.dz;
    } else if (startDebug && landBase) {
        const rawDx = startDebug.position.x - landBase.position.x;
        const rawDz = startDebug.position.z - landBase.position.z;
        const mag = Math.sqrt(rawDx * rawDx + rawDz * rawDz);
        if (mag > 5) { terrainDx = rawDx / mag; terrainDz = rawDz / mag; }
    }
    // Anchor: the position BEFORE goto_short. All goto distances are relative to this.
    const gotoAnchorX = startDebug ? startDebug.position.x : (landBase ? landBase.position.x : 0);
    const gotoAnchorZ = startDebug ? startDebug.position.z : (landBase ? landBase.position.z : 0);
    console.log(`[Test] Goto anchor: (${Math.round(gotoAnchorX)}, ${Math.round(gotoAnchorZ)}), terrain dir: (${terrainDx.toFixed(2)}, ${terrainDz.toFixed(2)})`);

    // ── Test 5: Short goto (32 blocks) — measures base movement speed ───────
    if (startDebug) {
        const shortTargetX = Math.round(gotoAnchorX + terrainDx * 32);
        const shortTargetZ = Math.round(gotoAnchorZ + terrainDz * 32);
        console.log(`[Test] goto_short_32b target: (${shortTargetX}, ${shortTargetZ})`);
        await measureSpeed('AI_Bot_01', shortTargetX, shortTargetZ, 'goto_short_32b');
    }

    // ── Test 6: Medium goto (100 blocks) — tests waypoint system ────────────
    if (startDebug) {
        const medTargetX = Math.round(gotoAnchorX + terrainDx * 100);
        const medTargetZ = Math.round(gotoAnchorZ + terrainDz * 100);
        console.log(`[Test] goto_medium_100b target: (${medTargetX}, ${medTargetZ})`);
        await measureSpeed('AI_Bot_01', medTargetX, medTargetZ, 'goto_medium_100b');
        // If medium failed (likely due to terrain obstacle in initial direction),
        // flip direction for long-distance test so it tries the opposite way.
        const medResult = testResults[testResults.length - 1];
        if (!medResult.pass) {
            terrainDx = -terrainDx;
            terrainDz = -terrainDz;
            console.log(`[Test] goto_medium failed — flipping direction for long: (${terrainDx.toFixed(2)}, ${terrainDz.toFixed(2)})`);
        }
    }

    // ── Test 5: Follow — spawn AI_Bot_02 as the moving player ───────────────
    // AI_Bot_02 acts as the human player for the follow test.
    // It does find_land (which will pathfind to AI_Bot_01's position),
    // then walks in a line so AI_Bot_01 has something to chase.
    console.log('\n=== SETUP: Spawning player bot (AI_Bot_02) for follow test ===');
    spawnBot('AI_Bot_02');
    await waitForReady('AI_Bot_02', 90000);

    // find_land on Bot02 (pathfinds toward any online player)
    await testFindLand('AI_Bot_02');
    await sleep(2000);

    // Explicitly navigate Bot02 to Bot01's current position so both bots are
    // co-located before the follow test. Without this, independent find_land
    // calls can land them >100 blocks apart.
    const bot01Pos = readDebug('AI_Bot_01');
    if (bot01Pos) {
        console.log(`[Test] Moving AI_Bot_02 to AI_Bot_01 position (${bot01Pos.position.x}, ${bot01Pos.position.z})`);
        sendAction('AI_Bot_02', { action: 'goto',
            x: bot01Pos.position.x,
            z: bot01Pos.position.z,
            timeout: 90 });
        await waitForMessage('AI_Bot_02', m =>
            m.type === 'USER_CHAT' && m.data.username === 'System' &&
            (m.data.message.includes('Reached') || m.data.message.includes('Cannot') || m.data.message.includes('failed')),
            100000
        );
        await sleep(1000);
    }

    // Now Bot02 is next to Bot01 — have it walk 60 blocks away as the follow target
    const bot02PreFollow = readDebug('AI_Bot_02');
    if (bot02PreFollow) {
        sendAction('AI_Bot_02', { action: 'goto',
            x: bot02PreFollow.position.x + 60,
            z: bot02PreFollow.position.z,
            timeout: 60 });
    }
    await sleep(2000); // let Bot02 start moving before Bot01 begins following

    await testFollow('AI_Bot_01', 'AI_Bot_02', 20);

    // Stop Bot02 after follow test
    sendAction('AI_Bot_02', { action: 'stop' });
    await sleep(1000);

    // ── Test 8: Long distance goto (200 blocks) ─────────────────────────────
    // Use the same anchor+direction from before goto_short so the follow test
    // doesn't change the direction vector (follow moves the bot in a potentially
    // different and water-prone direction).
    if (startDebug) {
        const longTargetX = Math.round(gotoAnchorX + terrainDx * 200);
        const longTargetZ = Math.round(gotoAnchorZ + terrainDz * 200);
        console.log(`[Test] goto_long_200b target: (${longTargetX}, ${longTargetZ})`);
        await measureSpeed('AI_Bot_01', longTargetX, longTargetZ, 'goto_long_200b');
    }

    // ── Test 9: Return to land base (avoids hardcoded ocean spawn) ──────────
    const returnX = landBase ? landBase.position.x : -10;
    const returnZ = landBase ? landBase.position.z : -28;
    await measureSpeed('AI_Bot_01', returnX, returnZ, 'goto_return_land');

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  TEST RESULTS SUMMARY                                ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    const passed = testResults.filter(r => r.pass).length;
    const total = testResults.length;
    for (const r of testResults) {
        const tag = r.pass ? '✓ PASS' : '✗ FAIL';
        const speedStr = r.speed !== undefined ? ` (${r.speed} b/s)` : '';
        console.log(`║  ${tag} | ${r.test}${speedStr}`);
    }
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Total: ${passed}/${total} passed                   `);
    console.log('╚══════════════════════════════════════════════════════╝');

    // Save results
    fs.writeFileSync('test_live_results.json', JSON.stringify(testResults, null, 2));

    // Cleanup
    for (const [id, bot] of Object.entries(BOTS)) {
        bot.process.kill('SIGINT');
    }

    setTimeout(() => process.exit(0), 3000);
}

main().catch(err => {
    console.error('[Test] Fatal error:', err);
    process.exit(1);
});
