// agent_manager.js
const { fork } = require('child_process');
const path = require('path');
const LLMClient = require('./llm_client');

class AgentManager {
    constructor() {
        this.bots = new Map(); // Map of botId to ChildProcess
        this.restartingBots = new Set();
        this.llm = new LLMClient(process.env.OLLAMA_MODEL || 'gpt-oss:20b-cloud');
        this.activeLlmRequests = new Map(); // Concurrency control
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
            this.activeLlmRequests.delete(botId);
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
            const data = message.data;
            const isSystem = data.username === 'System';

            // 1. Priority interruption: If user speaks, abort any current LLM requests and cancel any bot actions.
            if (!isSystem) {
                if (this.activeLlmRequests.has(botId)) {
                    console.log(`[AgentManager] User command overrides existing thought process for ${botId}.`);
                    // Note: fetch cancellation could be implemented here via AbortController, but logic-wise we just ignore it.
                }
                const botProcess = this.bots.get(botId);
                if (botProcess) {
                    botProcess.send({ type: 'EXECUTE_ACTION', action: [{ action: "stop" }] }); // Immediately halt current action queue
                }
                // Generate new thought ID to invalidate older ones
                const thoughtId = Date.now();
                this.activeLlmRequests.set(botId, thoughtId);
                this.processChatWithLLM(botId, data, 0, thoughtId);
            } else {
                // 2. State Management: Only respond to system events if it implies a failure that needs a workaround or if the user explicitly asked for continuous reporting.
                // For now, if the action was successful, transition to 'Idle' (do not ask LLM).
                if (data.message.includes("Successfully")) {
                    console.log(`[AgentManager] Task completed for ${botId}: ${data.message}. Entering Idle state.`);
                    // Do not prompt LLM. Just wait for the next user command.
                    return; 
                } else if (data.message.includes("Failed") || data.message.includes("Cannot")) {
                    // It's a failure. Allow LLM to reconsider, but only if we aren't already thinking about something else.
                    if (!this.activeLlmRequests.has(botId)) {
                        const thoughtId = Date.now();
                        this.activeLlmRequests.set(botId, thoughtId);
                        this.processChatWithLLM(botId, data, 0, thoughtId);
                    } else {
                        console.log(`[AgentManager] Ignoring system failure for ${botId} because another thought is active.`);
                    }
                }
            }
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
                if (typeof action.action === 'string') {
                    return [action];
                } else if (typeof action.action === 'object' && !Array.isArray(action.action)) {
                    const keys = Object.keys(action.action);
                    if (keys.length > 0) {
                        const actName = keys[0];
                        return [{ action: actName, ...action.action[actName] }];
                    }
                }
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
                    if (typeof action[key].action === 'string') {
                        return [action[key]];
                    } else if (typeof action[key].action === 'object' && !Array.isArray(action[key].action)) {
                        const subKeys = Object.keys(action[key].action);
                        if (subKeys.length > 0) {
                            return [{ action: subKeys[0], ...action[key].action[subKeys[0]] }];
                        }
                    }
                }
                if (Array.isArray(action[key])) {
                    return action[key];
                }
            }
        }
        return null;
    }

    async processChatWithLLM(botId, data, retryCount = 0, thoughtId) {
        // If a new thought has replaced this one, abort.
        if (this.activeLlmRequests.get(botId) !== thoughtId) {
            console.log(`[AgentManager] Thought ${thoughtId} for ${botId} was superseded. Aborting.`);
            return;
        }

        console.log(`[AgentManager] Thinking about what ${data.username} said: "${data.message}"...`);

        let prompt = `You are a Minecraft AI bot named ${botId}.
User '${data.username}' said: "${data.message}"
Current Environment: ${JSON.stringify(data.environment)}

━━━ CORE RULES ━━━
*CRITICAL*: Respond ONLY with a valid JSON array of action objects. No prose, no explanations.
*CRITICAL*: Chain multiple actions in one array. If the user says "give me 10 oak logs", respond with BOTH collect AND give: [{"action":"collect","target":"oak_log","quantity":10},{"action":"give","target":"${data.username}","item":"oak_log","quantity":10}]
*CRITICAL*: The bot auto-crafts the required tool before any collect action — do NOT pre-craft tools manually.
*CRITICAL*: Always use the longest timeout that makes sense. Collection of many blocks needs timeout:120 or more.
*CRITICAL*: If the user provides only two numbers for coordinates, assign them to X and Z, omit Y.

━━━ BASIC ACTIONS ━━━
[{"action": "chat", "message": "text"}]
[{"action": "come", "target": "player_name"}]                                    -- follows continuously until stopped
[{"action": "stop"}]                                                              -- halts all current actions
[{"action": "goto", "x": 10, "z": 20, "timeout": 60}]                           -- any distance, auto-waypoints
[{"action": "goto", "x": 10, "y": 64, "z": 20}]
[{"action": "collect", "target": "oak_log", "quantity": 64, "timeout": 120}]
[{"action": "give", "target": "player_name", "item": "oak_log", "quantity": 64}]
[{"action": "equip", "target": "diamond_pickaxe"}]
[{"action": "equip_armor"}]                                                       -- equips best armor in inventory
[{"action": "craft", "target": "wooden_pickaxe", "quantity": 1}]
[{"action": "place", "target": "crafting_table"}]

━━━ SURVIVAL & UTILITY ACTIONS ━━━
[{"action": "eat"}]                                                               -- eats best available food
[{"action": "eat", "target": "cooked_beef"}]                                     -- eats specific food/drinks milk
[{"action": "smelt", "target": "raw_iron", "quantity": 16, "timeout": 200}]      -- smelts items (auto-places furnace)
[{"action": "sleep"}]                                                             -- sleeps in nearby bed
[{"action": "brew", "potion": "healing", "timeout": 30}]                         -- brews a potion (needs stand + blaze_powder + ingredient)
[{"action": "enchant", "target": "diamond_sword", "timeout": 30}]                -- enchants item (needs table + lapis + XP)
[{"action": "explore", "direction": "north", "distance": 500, "target": "nether_fortress"}]  -- explore to find structure
[{"action": "navigate_portal", "target": "nether"}]                              -- enter nether or end portal
[{"action": "activate_end_portal"}]                                               -- place eyes in end portal frames
[{"action": "place_pattern", "target": "wither"}]                                 -- place Wither summon structure

━━━ COMBAT ACTIONS ━━━
[{"action": "kill", "target": "zombie", "quantity": 1, "timeout": 120}]          -- auto-equips armor+weapon, fights until dead
[{"action": "kill", "target": "wither", "timeout": 300}]
[{"action": "kill", "target": "ender_dragon", "timeout": 600}]
[{"action": "kill", "target": "elder_guardian", "quantity": 3, "timeout": 300}]
[{"action": "kill", "target": "end_crystal", "quantity": 8, "timeout": 120}]     -- destroy End Crystals before fighting dragon

━━━ BOSS DEFEAT SEQUENCES (use multi-action arrays) ━━━
WITHER: collect soul_sand(4) + kill wither_skeleton(many) for skulls → place_pattern(wither) → kill(wither,timeout:300)
ENDER DRAGON: craft eye_of_ender → explore for stronghold → activate_end_portal → navigate_portal(end) → kill(end_crystal,qty:8) → kill(ender_dragon,timeout:600)
ELDER GUARDIAN: brew(water_breathing) + brew(night_vision) → explore for ocean_monument → eat(milk) → kill(elder_guardian,qty:3,timeout:300)
`;


        if (retryCount > 0) {
            prompt += `\n\nYour previous response was incorrectly formatted. Please ensure you respond ONLY with a valid JSON array containing action objects.`;
        }

        let action = await this.llm.generateAction(prompt);

        // LLM unreachable or returned an API error — stay silent, do not send anything to the bot.
        // Guard: only release the lock if this thought still owns it; a newer user message
        // may have already overwritten the thoughtId while the request was in flight.
        if (action === null) {
            if (this.activeLlmRequests.get(botId) === thoughtId) {
                this.activeLlmRequests.delete(botId);
            }
            return;
        }

        // Check again after await
        if (this.activeLlmRequests.get(botId) !== thoughtId) {
            console.log(`[AgentManager] Thought ${thoughtId} for ${botId} was superseded after LLM response. Aborting.`);
            return;
        }

        console.log(`[AgentManager] LLM decided action:`, action);

        let sanitizedActions = this.sanitizeLLMAction(action);

        if (!sanitizedActions || sanitizedActions.length === 0) {
            if (retryCount < 2) {
                console.log(`[AgentManager] Invalid JSON format received from LLM. Retrying (${retryCount + 1}/2)...`);
                return this.processChatWithLLM(botId, data, retryCount + 1, thoughtId);
            } else {
                console.log(`[AgentManager] Failed to get valid JSON from LLM after retries.`);
                sanitizedActions = [{"action": "chat", "message": "I could not understand that or my brain failed to format the response."}];
            }
        }

        // Action determined. Clear active request lock.
        this.activeLlmRequests.delete(botId);

        const botProcess = this.bots.get(botId);
        if (botProcess) {
            // Remove the 'stop' action we might have injected if the LLM also happens to send one
            const filteredActions = sanitizedActions.filter(a => a.action !== "stop");
            if (filteredActions.length > 0) {
                 botProcess.send({ type: 'EXECUTE_ACTION', action: filteredActions });
            }
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
