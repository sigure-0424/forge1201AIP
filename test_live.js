/**
 * Live integration test script.
 * Connects to the running bot process by creating its own AgentManager
 * and sends IPC commands directly.  Monitors ai_debug.json for position
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

function readDebug() {
    try { return JSON.parse(fs.readFileSync('ai_debug.json', 'utf8')); }
    catch { return null; }
}

function spawnBot(botId) {
    console.log(`[Test] Spawning bot: ${botId}`);
    const botProcess = fork(path.join(__dirname, 'src/bot_actuator.js'), [], {
        env: { ...process.env, BOT_ID: botId, BOT_OPTIONS: JSON.stringify({ host, port }) }
    });

    BOTS[botId] = { process: botProcess, messages: [], ready: false };

    botProcess.on('message', (msg) => {
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
        const idx = BOTS[botId].messages.findIndex(filter);
        if (idx !== -1) {
            return BOTS[botId].messages.splice(idx, 1)[0];
        }
        await sleep(500);
    }
    return null;
}

async function waitForReady(botId, timeoutMs = 120000) {
    console.log(`[Test] Waiting for ${botId} to connect and spawn...`);
    // Delete stale ai_debug.json so we wait for a genuinely fresh entry
    try { fs.unlinkSync('ai_debug.json'); } catch (e) {}
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const debug = readDebug();
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
    const startDebug = readDebug();
    if (!startDebug) { console.log('[Test] No debug data'); return null; }

    const startPos = { x: startDebug.position.x, z: startDebug.position.z };
    const startTime = Date.now();

    sendAction(botId, { action: 'goto', x: targetX, z: targetZ, timeout: 120 });

    // Wait for completion
    const result = await waitForMessage(botId, m =>
        m.type === 'USER_CHAT' && m.data.username === 'System' &&
        (m.data.message.includes('Reached') || m.data.message.includes('Cannot') || m.data.message.includes('failed')),
        120000
    );

    const endTime = Date.now();
    const endDebug = readDebug();
    await sleep(1000); // let debug file update

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

        const resultObj = {
            test: label,
            distance: Math.round(dist * 10) / 10,
            time: Math.round(elapsedSec * 10) / 10,
            speed: Math.round(speed * 100) / 100,
            accuracy: Math.round(endDist * 10) / 10,
            status: result ? result.data.message : 'timeout',
            pass: speed > 3.0 && endDist < 10
        };

        console.log(`[Test Result] ${label}: ${dist.toFixed(1)} blocks in ${elapsedSec.toFixed(1)}s = ${speed.toFixed(2)} b/s, accuracy: ${endDist.toFixed(1)} blocks from target | ${resultObj.pass ? 'PASS' : 'FAIL'}`);
        testResults.push(resultObj);
        return resultObj;
    }
    return null;
}

async function testFollow(botId, playerName, durationSec = 20) {
    console.log(`\n=== TEST: Follow ${playerName} for ${durationSec}s ===`);
    const startDebug = readDebug();
    const startTime = Date.now();

    sendAction(botId, { action: 'come', target: playerName });

    // Let it follow for durationSec
    await sleep(durationSec * 1000);

    // Check positions during follow
    const midDebug = readDebug();

    // Stop following
    sendAction(botId, { action: 'stop' });
    await sleep(2000);

    const endDebug = readDebug();
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
        65000
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
    console.log('\n=== SETUP: Building test platform via OP commands ===');
    sendAction(botId, { action: 'find_land' });

    // Up to 45s: fill poll (20s) + setblocks + summon + TP + chunk load
    const result = await waitForMessage(botId, m =>
        m.type === 'USER_CHAT' && m.data.username === 'System' &&
        (m.data.message.includes('Platform ready') || m.data.message.includes('find_land:')),
        90000
    );

    const msg = result ? result.data.message : 'timeout - proceeding with current position';
    console.log(`[Test Setup] ${msg}`);
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

    // Kill any stale ai_debug.json and linger a moment so orphaned bot processes can exit
    try { fs.unlinkSync('ai_debug.json'); } catch (e) {}
    await sleep(1000);

    // Spawn Test Bot 1
    spawnBot('AI_Bot_01');
    await waitForReady('AI_Bot_01', 90000);

    // ── Setup: Teleport to land so movement/collect/craft/kill tests can run ──
    await testFindLand('AI_Bot_01');
    // Capture the land base position for the return test
    const landBase = readDebug();

    // ── Test 1: Status ──────────────────────────────────────────────────
    await testStatus('AI_Bot_01');

    // ── Test 2: Short goto (32 blocks) — measures base movement speed ──
    const startDebug = readDebug();
    if (startDebug) {
        await measureSpeed('AI_Bot_01',
            startDebug.position.x + 32,
            startDebug.position.z,
            'goto_short_32b'
        );
    }

    // ── Test 3: Medium goto (100 blocks) — tests waypoint system ───────
    const midDebug = readDebug();
    if (midDebug) {
        await measureSpeed('AI_Bot_01',
            midDebug.position.x,
            midDebug.position.z + 100,
            'goto_medium_100b'
        );
    }

    // ── Test 4: Follow player (skip if bot is > 256 blocks from player) ─
    await testFollow('AI_Bot_01', 'Seia_Y', 20);

    // ── Test 5: Collect oak_log ────────────────────────────────────────
    await testCollect('AI_Bot_01', 'oak_log', 3, 'collect_oak_log');

    // ── Test 6: Craft planks ──────────────────────────────────────────
    await testCraft('AI_Bot_01', 'oak_planks', 1, 'craft_oak_planks');

    // ── Test 7: Kill animal ───────────────────────────────────────────
    await testKill('AI_Bot_01', 'cow', 1, 'kill_cow');
    // If cow not found, try pig or chicken
    const lastKill = testResults[testResults.length - 1];
    if (!lastKill.pass) {
        await testKill('AI_Bot_01', 'pig', 1, 'kill_pig');
        const pigResult = testResults[testResults.length - 1];
        if (!pigResult.pass) {
            await testKill('AI_Bot_01', 'chicken', 1, 'kill_chicken');
        }
    }

    // ── Test 8: Long distance goto (200 blocks) ──────────────────────
    const preLD = readDebug();
    if (preLD) {
        await measureSpeed('AI_Bot_01',
            preLD.position.x - 200,
            preLD.position.z,
            'goto_long_200b'
        );
    }

    // ── Test 9: Return to land base (avoids hardcoded ocean spawn) ────
    const returnX = landBase ? landBase.position.x : -10;
    const returnZ = landBase ? landBase.position.z : -28;
    await measureSpeed('AI_Bot_01', returnX, returnZ, 'goto_return_land');

    // ── Summary ──────────────────────────────────────────────────────
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
