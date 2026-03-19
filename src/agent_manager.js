// agent_manager.js
const { fork } = require('child_process');
const path = require('path');
const LLMClient = require('./llm_client');

class AgentManager {
    constructor() {
        this.bots = new Map(); // Map of botId to ChildProcess
        this.restartingBots = new Set();
        this.llm = new LLMClient(process.env.OLLAMA_MODEL || 'llama3');
    }

    startBot(botId, options) {
        if (this.restartingBots.has(botId)) {
            this.restartingBots.delete(botId);
        }
        console.log(`[AgentManager] Starting bot process for ${botId}...`);

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
        }
    }

    handleIPCMessage(botId, message) {
        if (message.type === 'ERROR') {
            console.error(`[AgentManager] Received ERROR from bot ${botId}: ${message.category} - ${message.details}`);
            this.triggerRecoveryPipeline(botId, message);
        } else if (message.type === 'LOG') {
            console.log(`[Bot ${botId}] ${message.data}`);
        } else if (message.type === 'USER_CHAT') {
            this.processChatWithLLM(botId, message.data);
        }
    }

    sanitizeLLMAction(action) {
        if (Array.isArray(action)) {
            return action;
        }
        if (action && typeof action === 'object') {
            if (action.actions && Array.isArray(action.actions)) {
                return action.actions;
            }
            if (action.value && Array.isArray(action.value)) {
                return action.value;
            }
            if (action.action) {
                return [action];
            }
            const keys = Object.keys(action);
            for (const key of keys) {
                // Handle malformed JSON where the array string is the key (e.g. from user logs)
                try {
                    const parsedKey = JSON.parse(key);
                    if (Array.isArray(parsedKey) && parsedKey.length > 0 && parsedKey[0].action) {
                        return parsedKey;
                    }
                } catch (e) {
                    // key is not a JSON array
                }

                if (action[key] && action[key].action) {
                    return [action[key]];
                }
                if (Array.isArray(action[key])) {
                    return action[key];
                }
            }
        }
        return null;
    }

    async processChatWithLLM(botId, data, retryCount = 0) {
        console.log(`[AgentManager] Thinking about what ${data.username} said: "${data.message}"...`);

        let prompt = `You are a Minecraft AI bot named ${botId}.
User '${data.username}' said: "${data.message}"
Current Environment: ${JSON.stringify(data.environment)}

Decide your next action based on the user's command and your environment.
*CRITICAL*: You MUST prioritize taking action over conversation. Only use the 'chat' action to report unrecoverable errors or answer direct questions.
*CRITICAL*: You will receive follow-up 'System' messages letting you know if an action succeeded or failed. If you fail to collect a block, ask the user to provide a proper tool or try an alternative.
Respond ONLY with a valid JSON array containing one or more action objects.
If the user provides only two numbers for coordinates, assign them to X and Z respectively, and omit Y.
You may add a 'timeout' parameter (in seconds) to any action (default is 30s).
Supported actions:
[{"action": "chat", "message": "text"}]
[{"action": "come", "target": "player_name"}]
[{"action": "goto", "x": 10, "z": 20, "timeout": 60}]
[{"action": "goto", "x": 10, "y": 64, "z": 20}]
[{"action": "stop"}]
[{"action": "collect", "target": "oak_log", "quantity": 64, "timeout": 120}]
[{"action": "give", "target": "player_name", "item": "oak_log", "quantity": 64}]
[{"action": "equip", "target": "diamond_pickaxe"}]
`;

        if (retryCount > 0) {
            prompt += `\n\nYour previous response was incorrectly formatted. Please ensure you respond ONLY with a valid JSON array containing action objects.`;
        }

        let action = await this.llm.generateAction(prompt);
        console.log(`[AgentManager] LLM decided action:`, action);

        let sanitizedActions = this.sanitizeLLMAction(action);

        if (!sanitizedActions || sanitizedActions.length === 0) {
            if (retryCount < 2) {
                console.log(`[AgentManager] Invalid JSON format received from LLM. Retrying (${retryCount + 1}/2)...`);
                return this.processChatWithLLM(botId, data, retryCount + 1);
            } else {
                console.log(`[AgentManager] Failed to get valid JSON from LLM after retries.`);
                sanitizedActions = [{"action": "chat", "message": "I could not understand that or my brain failed to format the response."}];
            }
        }

        const botProcess = this.bots.get(botId);
        if (botProcess) {
            botProcess.send({ type: 'EXECUTE_ACTION', action: sanitizedActions });
        }
    }

    triggerRecoveryPipeline(botId, message) {
        const category = message.category;
        if (this.restartingBots.has(botId)) {
            console.log(`[AgentManager] Bot ${botId} is already restarting. Ignoring duplicate recovery trigger.`);
            return;
        }

        console.log(`[AgentManager] Triggering recovery pipeline for ${botId}, category: ${category}`);

        switch (category) {
            case 'ParseError':
                console.log(`[Recovery] Detected protocol parse error. This often happens with modded recipes in Forge 1.20.1.`);
                this.scheduleRestart(botId);
                break;
            case 'BotError':
                console.log(`[Recovery] General bot error. Attempting restart...`);
                this.scheduleRestart(botId);
                break;
            case 'HandshakeTimeout':
                console.log(`[Recovery] Restarting process for ${botId} and updating proxy rules.`);
                this.scheduleRestart(botId);
                break;
            case 'UndefinedReference':
                console.log(`[Recovery] Instructing ${botId} to inject dummy block...`);
                const botProcess = this.bots.get(botId);
                if (botProcess) botProcess.send({ command: 'inject_dummy_block' });
                break;
            case 'StackOverflow':
                console.log(`[Recovery] Updating LLM prompt for ${botId} with 'Inaccessible Area' rule.`);
                break;
            case 'Kicked':
                if (message.details.includes('flying')) {
                    console.log(`[Recovery] Bot kicked for flying. This is common in modded environments. Restarting with delay...`);
                    this.scheduleRestart(botId);
                } else {
                    console.log(`[Recovery] Bot kicked: ${message.details}. Attempting restart...`);
                    this.scheduleRestart(botId);
                }
                break;
            default:
                console.log(`[Recovery] Unknown error category. Attempting generic restart...`);
                this.scheduleRestart(botId);
        }
    }

    scheduleRestart(botId) {
        this.restartingBots.add(botId);
        const existingProcess = this.bots.get(botId);
        if (existingProcess) {
            existingProcess.kill('SIGKILL');
        }

        setTimeout(() => {
            console.log(`[AgentManager] Restarting ${botId}...`);
            this.startBot(botId, { isRestart: true });
        }, 5000); // Increased delay to prevent rapid crash loops
    }

    restartBot(botId) {
        this.scheduleRestart(botId);
    }
}

module.exports = AgentManager;
