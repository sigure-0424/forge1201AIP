// agent_manager.js
const { fork } = require('child_process');
const path = require('path');

class AgentManager {
    constructor() {
        this.bots = new Map(); // Map of botId to ChildProcess
    }

    startBot(botId, options) {
        console.log(`[AgentManager] Starting bot process for ${botId}...`);
        
        // Isolate each bot in a separate child_process
        const botProcess = fork(path.join(__dirname, 'bot_actuator.js'), [], {
            env: { ...process.env, BOT_ID: botId, BOT_OPTIONS: JSON.stringify(options) }
        });

        this.bots.set(botId, botProcess);

        botProcess.on('message', (message) => {
            this.handleIPCMessage(botId, message);
        });

        botProcess.on('exit', (code, signal) => {
            console.log(`[AgentManager] Bot process ${botId} exited with code ${code} and signal ${signal}`);
            this.bots.delete(botId);
            this.handleProcessCrash(botId, code);
        });

        return botProcess;
    }

    handleProcessCrash(botId, code) {
        if (code !== 0 && code !== null) {
            console.error(`[AgentManager] Bot process ${botId} crashed with code ${code}.`);
            // Add to recovery logic if needed
        }
    }

    handleIPCMessage(botId, message) {
        if (message.type === 'ERROR') {
            console.error(`[AgentManager] Received ERROR from bot ${botId}: ${message.category} - ${message.details}`);
            this.triggerRecoveryPipeline(botId, message.category);
        } else if (message.type === 'LOG') {
            console.log(`[Bot ${botId}] ${message.data}`);
        }
    }

    triggerRecoveryPipeline(botId, category) {
        console.log(`[AgentManager] Triggering recovery pipeline for ${botId}, category: ${category}`);
        
        switch (category) {
            case 'ParseError':
                console.log(`[Recovery] Detected protocol parse error. This often happens with modded recipes in Forge 1.20.1.`);
                console.log(`[Recovery] Restarting bot ${botId} with relaxed protocol rules.`);
                this.restartBot(botId);
                break;
            case 'BotError':
                console.log(`[Recovery] General bot error. Attempting restart...`);
                this.restartBot(botId);
                break;
            case 'HandshakeTimeout':
                console.log(`[Recovery] Restarting process for ${botId} and updating proxy rules.`);
                this.restartBot(botId);
                break;
            case 'UndefinedReference':
                console.log(`[Recovery] Instructing ${botId} to inject dummy block...`);
                // Send IPC message to bot to inject
                const botProcess = this.bots.get(botId);
                if (botProcess) {
                    botProcess.send({ command: 'inject_dummy_block' });
                }
                break;
            case 'StackOverflow':
                console.log(`[Recovery] Updating LLM prompt for ${botId} with 'Inaccessible Area' rule.`);
                // In a real system, you would update the RAG context or system prompt
                break;
            case 'NBTError':
                console.log(`[Recovery] Instructing ${botId} to re-open inventory to refresh packets.`);
                // Send IPC message to bot to execute re-open
                break;
            default:
                console.log(`[Recovery] Unknown error category. No automated recovery.`);
        }
    }

    restartBot(botId) {
        // Kill existing if stuck, then restart
        const existingProcess = this.bots.get(botId);
        if (existingProcess) {
            existingProcess.kill('SIGKILL');
        }
        
        // Mock restarting after a brief delay
        setTimeout(() => {
            console.log(`[AgentManager] Restarting ${botId}...`);
            this.startBot(botId, { isRestart: true });
        }, 1000);
    }
}

module.exports = AgentManager;
