const AgentManager = require('./src/agent_manager');
const ConfigRAGParser = require('./src/config_rag_parser');
const path = require('path');

// Retrieve connection options from environment variables or use defaults
const host = process.env.MC_HOST || 'localhost';
const port = parseInt(process.env.MC_PORT || '25565', 10);
const botNamesStr = process.env.BOT_NAMES || process.env.BOT_NAME || 'AI_Bot_01';
const botNames = botNamesStr.split(',').map(n => n.trim());
const configDir = process.env.MC_CONFIG_DIR || path.join(__dirname, 'data/sample/configs');

console.log('--- Minecraft Forge 1.20.1 AI Player System ---');

// Initialize and parse server configs
const configParser = new ConfigRAGParser(configDir);
configParser.parseServerConfigs();
console.log(configParser.generateLLMPromptContext());

console.log(`Starting Agent Manager...`);
console.log(`Target Server: ${host}:${port}`);

const manager = new AgentManager();

// Goal 4: Disable commands in normal start
const mode = process.env.MODE || 'full_auto';
console.log(`[Main] Operating in ${mode} mode.`);

// Start bot instances
for (const name of botNames) {
    manager.startBot(name, { host, port, mode });
}

// Goal 11: Setup CLI Command Interpreter
const readline = require('readline');
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
});

console.log("CLI active. Available commands: action <botId> <json>, del_waypoint <name>, clear_chat <botId>, clear_deaths, add_bot <botId>");

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
            const fs = require('fs');
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
            const fs = require('fs');
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
        } else {
            console.log(`[CLI] Unknown command: ${cmd}`);
        }
    } catch (e) {
        console.error(`[CLI Error] ${e.message}`);
    }
});


// Keep the process alive and listen for graceful shutdowns
process.on('SIGINT', () => {
    console.log('\n[Main] Shutting down AI Player System...');
    for (const [id, botProcess] of manager.bots.entries()) {
        console.log(`[Main] Killing bot process ${id}`);
        botProcess.kill('SIGINT');
    }
    process.exit(0);
});
