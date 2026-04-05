const AgentManager  = require('./src/agent_manager');
const ConfigRAGParser = require('./src/config_rag_parser');
const WebUIServer   = require('./src/web_ui_server');
const sentry        = require('./src/sentry_reporter');
const path = require('path');
const readline = require('readline');
const fs = require('fs');
const net = require('net');

require('dotenv').config();

// Retrieve connection options from environment variables or use defaults
const host = process.env.MC_HOST || 'localhost';
const port = parseInt(process.env.MC_PORT || '25565', 10);
const botNamesStr = process.env.BOT_NAMES || process.env.BOT_NAME || 'AI_Bot_01';
const botNames = botNamesStr.split(',').map(n => n.trim());
const configDir = process.env.MC_CONFIG_DIR || path.join(__dirname, 'data/sample/configs');

// ── Sentry consent (CLI) ──────────────────────────────────────────────────────
// Show a one-time CLI prompt to obtain crash-reporting consent before anything else starts.
async function askSentryConsentCLI() {
    sentry.loadPrefs();
    const prefs = sentry.getPrefs();

    // Already decided: honour the saved choice silently
    if (!sentry.needsConsent()) {
        if (prefs.opted === 'yes') sentry.initSentry(process.env.SENTRY_DSN);
        return;
    }

    // Non-interactive environment (piped stdin) — defer to WebUI
    if (!process.stdin.isTTY) return;

    const hr = '─'.repeat(62);
    process.stdout.write(`\n${hr}\n`);
    process.stdout.write(`  ANONYMOUS CRASH REPORTING  (Powered by Sentry)\n`);
    process.stdout.write(`${hr}\n`);
    process.stdout.write(`  Help improve this system by sharing anonymous crash reports.\n\n`);
    process.stdout.write(`  ✔  Only stack traces & error codes are collected.\n`);
    process.stdout.write(`  ✔  No server addresses, API keys, usernames, chat messages,\n`);
    process.stdout.write(`     or any other personally identifiable information (PII).\n`);
    process.stdout.write(`  ✔  Sentry (sentry.io) is an industry-standard, SOC 2-certified\n`);
    process.stdout.write(`     monitoring service — all data is encrypted in transit (TLS).\n`);
    process.stdout.write(`${hr}\n`);

    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

        rl.question('  Enable crash reporting? [y/n] (Enter = skip for now): ', ans => {
            rl.question('  Remember this choice (don\'t ask again)? [y/n]: ', dontAsk => {
                rl.close();
                const opted        = ans.trim().toLowerCase().startsWith('y') ? 'yes'
                                   : ans.trim().toLowerCase().startsWith('n') ? 'no'
                                   : null;
                const dontAskAgain = dontAsk.trim().toLowerCase().startsWith('y');
                sentry.savePrefs({ opted, dontAskAgain });

                const label = opted === 'yes' ? 'ENABLED' : opted === 'no' ? 'DISABLED' : 'skipped (will ask again)';
                process.stdout.write(`  Crash reporting: ${label}\n${hr}\n\n`);

                if (opted === 'yes') sentry.initSentry(process.env.SENTRY_DSN);
                resolve();
            });
        });
    });
}

async function findAvailablePort(startPort, maxAttempts = 20) {
    const checkPort = (port) => new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
            tester.close(() => resolve(true));
        });
        tester.listen(port, '::');
    });

    for (let i = 0; i < maxAttempts; i++) {
        const port = startPort + i;
        // eslint-disable-next-line no-await-in-loop
        const ok = await checkPort(port);
        if (ok) return port;
    }
    return startPort;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    // 1. Sentry consent must happen before anything else writes to console
    await askSentryConsentCLI();

    console.log('--- Minecraft Forge 1.20.1 AI Player System ---');

    // 2. Parse server configs
    const configParser = new ConfigRAGParser(configDir);
    configParser.parseServerConfigs();
    console.log(configParser.generateLLMPromptContext());

    console.log(`Starting Agent Manager...`);
    console.log(`Target Server: ${host}:${port}`);

    const manager = new AgentManager();

    // Hook Sentry into AgentManager ERROR IPC so bot crashes get captured automatically
    if (sentry.isEnabled()) {
        const origHandle = manager.handleIPCMessage.bind(manager);
        manager.handleIPCMessage = function(botId, message) {
            if (message.type === 'ERROR' && message.details) {
                sentry.captureException(
                    new Error(`[${botId}] ${message.details}`),
                    { category: message.category || 'BotError' }
                );
            }
            return origHandle(botId, message);
        };
    }

    // 3. WebUI dashboard
    const requestedWebuiPort = parseInt(process.env.WEBUI_PORT || '3000', 10);
    const webuiPort = await findAvailablePort(requestedWebuiPort, 50);
    if (webuiPort !== requestedWebuiPort) {
        console.warn(`[Main] WEBUI_PORT ${requestedWebuiPort} is in use. Using ${webuiPort} instead.`);
    }
    const webui = new WebUIServer(manager, { host, port, mode: process.env.MODE || 'full_auto' }, sentry);
    webui.start(webuiPort);

    // 4. Start bot instances
    const mode = process.env.MODE || 'full_auto';
    console.log(`[Main] Operating in ${mode} mode.`);
    for (const name of botNames) {
        manager.startBot(name, { host, port, mode });
    }

    // 5. CLI Command Interpreter
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> '
    });

    console.log("CLI active. Commands: action <botId> <json>, del_waypoint <name>, clear_chat <botId>, clear_deaths, add_bot <botId>, spawn_bots <count>");

    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const parts = trimmed.split(' ');
        const cmd = parts[0];

        try {
            if (cmd === 'action') {
                const botId = parts[1];
                const jsonStr = parts.slice(2).join(' ');
                const botProc = manager.bots.get(botId);
                if (botProc) {
                    const actionObj = JSON.parse(jsonStr);
                    botProc.send({ type: 'EXECUTE_ACTION', action: actionObj });
                    console.log(`[CLI] Sent action to ${botId}`);
                } else {
                    console.log(`[CLI] Bot ${botId} not found.`);
                }
            } else if (cmd === 'del_waypoint') {
                const name = parts[1];
                const wpPath = path.join(process.cwd(), 'data', 'waypoints.json');
                if (fs.existsSync(wpPath)) {
                    let wps = JSON.parse(fs.readFileSync(wpPath, 'utf8'));
                    const startLen = wps.length;
                    wps = wps.filter(w => w.name.toLowerCase() !== name.toLowerCase());
                    fs.writeFileSync(wpPath, JSON.stringify(wps, null, 2));
                    console.log(`[CLI] Deleted ${startLen - wps.length} waypoints named "${name}".`);
                } else {
                    console.log(`[CLI] waypoints.json not found.`);
                }
            } else if (cmd === 'clear_chat') {
                const botId = parts[1];
                if (manager.chatQueue.has(botId)) {
                    manager.chatQueue.set(botId, []);
                    console.log(`[CLI] Cleared chat queue for ${botId}.`);
                } else {
                    console.log(`[CLI] Bot ${botId} not found in manager.`);
                }
            } else if (cmd === 'clear_deaths') {
                const deathsPath = path.join(process.cwd(), 'data', 'deaths.json');
                if (fs.existsSync(deathsPath)) {
                    fs.writeFileSync(deathsPath, '[]');
                    console.log(`[CLI] Cleared deaths.json.`);
                } else {
                    console.log(`[CLI] deaths.json not found.`);
                }
            } else if (cmd === 'add_bot') {
                const botId = parts[1];
                if (botId) {
                    console.log(`[CLI] Adding bot: ${botId}`);
                    manager.startBot(botId, { host, port, mode });
                } else {
                    console.log(`[CLI] Usage: add_bot <botId>`);
                }
            } else if (cmd === 'spawn_bots') {
                const count = parseInt(parts[1], 10);
                if (!count || count < 1) { console.log(`[CLI] Usage: spawn_bots <count>`); return; }
                const ids = nextBotNames(manager, count);
                for (const id of ids) manager.startBot(id, { host, port, mode });
                console.log(`[CLI] Spawned ${ids.length} bots: ${ids.join(', ')}`);
            } else {
                console.log(`[CLI] Unknown command: ${cmd}`);
            }
        } catch (e) {
            console.error(`[CLI Error] ${e.message}`);
        }
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[Main] Shutting down AI Player System...');
        for (const [id, botProcess] of manager.bots.entries()) {
            console.log(`[Main] Killing bot process ${id}`);
            botProcess.kill('SIGINT');
        }
        process.exit(0);
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns N auto-generated bot names following AI_Bot_XX convention,
 * skipping names that are already running in the manager.
 */
function nextBotNames(manager, count) {
    const used = new Set(manager.bots.keys());
    // Find highest existing AI_Bot_NN number
    let max = 0;
    for (const id of used) {
        const m = id.match(/^AI_Bot_(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    const names = [];
    let n = max + 1;
    while (names.length < count) {
        const candidate = `AI_Bot_${String(n).padStart(2, '0')}`;
        if (!used.has(candidate)) names.push(candidate);
        n++;
    }
    return names;
}

main().catch(err => {
    console.error('[Main] Fatal startup error:', err);
    process.exit(1);
});
