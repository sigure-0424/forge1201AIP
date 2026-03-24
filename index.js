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

// Keep the process alive and listen for graceful shutdowns
process.on('SIGINT', () => {
    console.log('\n[Main] Shutting down AI Player System...');
    for (const [id, botProcess] of manager.bots.entries()) {
        console.log(`[Main] Killing bot process ${id}`);
        botProcess.kill('SIGINT');
    }
    process.exit(0);
});
