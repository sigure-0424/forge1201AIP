const AgentManager = require('./src/agent_manager');

// Retrieve connection options from environment variables or use defaults
const host = process.env.MC_HOST || 'localhost';
const port = parseInt(process.env.MC_PORT || '25565', 10);
const botId = process.env.BOT_NAME || 'AI_Bot_01';

console.log('--- Minecraft Forge 1.20.1 AI Player System ---');
console.log(`Starting Agent Manager...`);
console.log(`Target Server: ${host}:${port}`);

const manager = new AgentManager();

// Start a single bot instance for now
manager.startBot(botId, { host, port });

// Keep the process alive and listen for graceful shutdowns
process.on('SIGINT', () => {
    console.log('\n[Main] Shutting down AI Player System...');
    for (const [id, botProcess] of manager.bots.entries()) {
        console.log(`[Main] Killing bot process ${id}`);
        botProcess.kill('SIGINT');
    }
    process.exit(0);
});
