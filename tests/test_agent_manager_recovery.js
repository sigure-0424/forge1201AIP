const AgentManager = require('../src/agent_manager');
const path = require('path');
const assert = require('assert');
const { fork } = require('child_process');

console.log('--- Testing AgentManager Recovery ---');

class MockAgentManager extends AgentManager {
    startBot(botId, options) {
        console.log(`[MockAgentManager] Starting mock bot process for ${botId}...`);
        
        // Use the mock bot script instead of bot_actuator.js
        const botProcess = fork(path.join(__dirname, 'mock_bot_error.js'), [], {
            env: { ...process.env, BOT_ID: botId, BOT_OPTIONS: JSON.stringify(options) }
        });

        this.bots.set(botId, botProcess);

        botProcess.on('message', (message) => {
            this.handleIPCMessage(botId, message);
        });

        botProcess.on('exit', (code, signal) => {
            console.log(`[MockAgentManager] Bot process ${botId} exited.`);
        });

        return botProcess;
    }
}

const manager = new MockAgentManager();
let restartCalled = false;

// Override restartBot to verify it was called
manager.restartBot = (botId) => {
    console.log(`[Test] restartBot called for ${botId}`);
    restartCalled = true;
};

manager.startBot('test-bot', {});

setTimeout(() => {
    assert(restartCalled, 'restartBot should have been called upon HandshakeTimeout error');
    console.log('AgentManager recovery test PASSED!');
    process.exit(0);
}, 1500);
