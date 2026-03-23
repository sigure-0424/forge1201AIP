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
        this.chatQueue = new Map(); // Map of botId to array of queued messages
        this.llmCooldown = new Map(); // Map of botId to timestamp of next allowed LLM request
        this.awaitingCancellationChoice = new Map(); // Map of botId to boolean waiting for user cancellation confirm

        // Goals 4, 9, 10, 11: Task modes execution tracking
        this.botModes = new Map(); // Map of botId to 'normal' | 'full_auto' | 'auto_conditional' | 'task_mode'
        this.botActionCounts = new Map(); // Map of botId to number of actions executed (for full auto to task mode switch)
    }

    startBot(botId, options) {
        if (this.restartingBots.has(botId)) {
            this.restartingBots.delete(botId);
        }
        console.log(`[AgentManager] Starting bot process for ${botId}...`);

        // Save the bot's mode for later use
        if (options && options.mode) {
            this.botModes.set(botId, options.mode);
            this.botActionCounts.set(botId, 0); // reset count
            console.log(`[AgentManager] Bot ${botId} initialized with mode: ${options.mode}`);
        } else {
            this.botModes.set(botId, 'normal');
        }

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

            // Allow modes to be toggled via chat (Goal 9)
            if (!isSystem && data.message.toLowerCase().startsWith('mode:')) {
                const newModeMatch = data.message.match(/mode:\s*([a-zA-Z_0-9]+)/i);
                if (newModeMatch && newModeMatch[1]) {
                    const mode = newModeMatch[1].toLowerCase();
                    this.botModes.set(botId, mode);
                    console.log(`[AgentManager] Bot ${botId} mode changed via chat to: ${mode}`);

                    if (mode === 'task_mode') {
                        this.executeTaskModeTasks(botId);
                    }
                    return; // Intercepted as an internal command, don't ping LLM
                }
            }

            let currentMode = this.botModes.get(botId) || 'normal';

            // Normal mode bypasses automatic LLM tasks (Goal 4) unless forced,
            // but for safety, we'll allow normal chatting to work unless specified otherwise.
            // If the user means normal node index.js should NOT run tasks, we check currentMode.
            if (!isSystem && currentMode === 'normal') {
                 console.log(`[AgentManager] Ignoring chat command in normal mode: "${data.message}"`);
                 return; // Silently ignore to avoid doing tasks
            }

            if (!isSystem) {
                const isCancellationResponse = this.awaitingCancellationChoice.get(botId);
                const queue = this.chatQueue.get(botId) || [];

                if (isCancellationResponse) {
                    this.awaitingCancellationChoice.set(botId, false);
                    if (data.message.toLowerCase().startsWith('y')) {
                        console.log(`[AgentManager] User confirmed cancellation for ${botId}.`);
                        this.chatQueue.set(botId, []);
                        const botProcess = this.bots.get(botId);
                        if (botProcess) {
                            botProcess.send({ type: 'EXECUTE_ACTION', action: [{ action: "stop" }] });
                            botProcess.send({ type: 'EXECUTE_ACTION', action: [{ action: "chat", message: "Tasks cancelled. Waiting for instructions." }] });
                        }
                        return; // Done
                    } else {
                        console.log(`[AgentManager] User declined cancellation for ${botId}.`);
                        // Keep the queue as is, just return.
                        return;
                    }
                }

                if (this.activeLlmRequests.has(botId) || queue.length >= 2) {
                    this.awaitingCancellationChoice.set(botId, true);
                    const botProcess = this.bots.get(botId);
                    if (botProcess) {
                        botProcess.send({ type: 'EXECUTE_ACTION', action: [{ action: "chat", message: `I have ${queue.length + (this.activeLlmRequests.has(botId) ? 1 : 0)} pending requests. Cancel them to prioritize this? (y/n)` }] });
                    }
                    // Wait for the next message to process the choice
                    queue.push(data); // Push it so if they say no, it gets processed
                    this.chatQueue.set(botId, queue);
                    return;
                }

                // Normal addition
                queue.push(data);
                this.chatQueue.set(botId, queue);
                this.processNextQueueItem(botId);
            } else {
                // System messages
                if (data.message.includes("Successfully") || data.message.includes("Explored") || data.message.includes("Entered portal")) {
                    console.log(`[AgentManager] Task completed for ${botId}: ${data.message}.`);
                    // We finished a task, process the next in queue if any
                    this.processNextQueueItem(botId);
                    return; 
                } else if (data.message.includes("Failed") || data.message.includes("Cannot") || data.message.includes("No ")) {
                    const queue = this.chatQueue.get(botId) || [];
                    queue.unshift(data);
                    this.chatQueue.set(botId, queue);
                    this.processNextQueueItem(botId);
                }
            }
        }
    }

    // Goal 10: Task mode execution logic
    executeTaskModeTasks(botId) {
        const fs = require('fs');
        const path = require('path');
        const tasksPath = path.join(process.cwd(), 'data', 'tasks.json');

        if (!fs.existsSync(tasksPath)) {
            console.error(`[AgentManager] tasks.json not found at ${tasksPath}`);
            const botProcess = this.bots.get(botId);
            if (botProcess) {
                botProcess.send({ type: 'EXECUTE_ACTION', action: [{ action: "chat", message: "Task Mode error: tasks.json not found." }] });
            }
            return;
        }

        try {
            const data = fs.readFileSync(tasksPath, 'utf8');
            const tasks = JSON.parse(data);
            if (Array.isArray(tasks) && tasks.length > 0) {
                console.log(`[AgentManager] Dispatching ${tasks.length} tasks for Task Mode.`);
                const botProcess = this.bots.get(botId);
                if (botProcess) {
                    botProcess.send({ type: 'EXECUTE_ACTION', action: tasks });
                }
            } else {
                console.log(`[AgentManager] tasks.json is empty or not an array.`);
            }
        } catch(e) {
            console.error(`[AgentManager] Error parsing tasks.json: ${e.message}`);
        }
    }

    processNextQueueItem(botId) {
        if (this.activeLlmRequests.has(botId) || this.awaitingCancellationChoice.get(botId)) {
            return; // Busy
        }

        const now = Date.now();
        const nextAllowedTime = this.llmCooldown.get(botId) || 0;

        if (now < nextAllowedTime) {
            setTimeout(() => this.processNextQueueItem(botId), nextAllowedTime - now + 100);
            return;
        }

        const queue = this.chatQueue.get(botId) || [];
        if (queue.length === 0) return;

        const nextData = queue.shift();
        this.chatQueue.set(botId, queue);

        const thoughtId = Date.now();
        this.activeLlmRequests.set(botId, thoughtId);

        // 5 second cooldown between LLM requests to prevent spam
        this.llmCooldown.set(botId, Date.now() + 5000);

        this.processChatWithLLM(botId, nextData, 0, thoughtId);
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

        const isSystemFailure = data.username === 'System' || data.username === 'system';
        let prompt = `You are a Minecraft AI bot named ${botId}.
${isSystemFailure ? `SYSTEM FEEDBACK (previous action result): "${data.message}"` : `User '${data.username}' said: "${data.message}"`}
Current Environment: ${JSON.stringify(data.environment)}

━━━ CORE RULES ━━━
*CRITICAL*: Respond ONLY with a valid JSON array of action objects. No prose, no explanations.
*CRITICAL*: Chain multiple actions in one array. If the user says "give me 10 oak logs", respond with BOTH collect AND give: [{"action":"collect","target":"oak_log","quantity":10},{"action":"give","target":"${data.username}","item":"oak_log","quantity":10}]
*CRITICAL*: For complex tasks like "gather 10 wood and make a sword", chain all steps: [{"action":"collect","target":"oak_log","quantity":10},{"action":"craft","target":"wooden_sword","quantity":1}]
*CRITICAL*: ALWAYS check inventory before deciding what to collect or craft. If something is already there, skip that step.
*CRITICAL*: To collect any stone-type block or ore you NEED a pickaxe first. ALWAYS check "has_pickaxe" in Current Environment. If "has_pickaxe" is false, craft one first.
*CRITICAL*: Stone-type blocks (stone, andesite, granite, diorite) and ores are UNDERGROUND. If the system reports "not found within 128 blocks", you must dig down first: [{"action":"collect","target":"stone","quantity":16,"timeout":60}] will open a shaft. Then retry the original target.
*CRITICAL*: If a SYSTEM FEEDBACK message describes a failure, respond with the corrective action chain — do NOT just repeat the failed action.
*CRITICAL*: If a SYSTEM FEEDBACK message lists missing raw materials for a craft, you must generate actions to ONLY collect those specific raw materials.
*CRITICAL*: Always use the longest timeout that makes sense. Collection of many blocks needs timeout:120 or more.
*CRITICAL*: If the user provides only two numbers for coordinates, assign them to X and Z, omit Y.

━━━ BASIC ACTIONS ━━━
[{"action": "chat", "message": "text"}]
[{"action": "come", "target": "player_name"}]                                    -- follows continuously until stopped
[{"action": "stop"}]                                                              -- halts all current actions
[{"action": "goto", "x": 10, "z": 20, "timeout": 60}]                           -- any distance, auto-waypoints
[{"action": "goto", "x": 10, "y": 64, "z": 20}]
[{"action": "goto", "target": "WaypointName"}]                                  -- travel to journeymap waypoint by name
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
            this.processNextQueueItem(botId);
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
            // Send the full sanitized array, including 'stop', to the bot actuator
            // so it can clear its current goals if 'stop' is part of a chained command.
            if (sanitizedActions.length > 0) {
                 botProcess.send({ type: 'EXECUTE_ACTION', action: sanitizedActions });
            }
        }

        // Goals 10 & 11: Action tracking for Full Auto transition to Task Mode
        if (this.botModes.get(botId) === 'full_auto') {
            let count = (this.botActionCounts.get(botId) || 0) + sanitizedActions.length;
            this.botActionCounts.set(botId, count);
            console.log(`[AgentManager] Bot ${botId} (Full Auto) action count: ${count}`);

            if (count >= 20) {
                console.log(`[AgentManager] Bot ${botId} reached action limit in Full Auto. Switching to Task Mode.`);
                botProcess.send({ type: 'EXECUTE_ACTION', action: [{ action: "chat", message: "Action limit reached. Switching to Task Mode." }] });
                this.botModes.set(botId, 'task_mode');

                // Clear active requests to make way for task mode
                this.activeLlmRequests.delete(botId);
                this.chatQueue.set(botId, []);

                setTimeout(() => {
                    this.executeTaskModeTasks(botId);
                }, 2000);
                return;
            }
        }

        // Check for more items in the queue
        this.processNextQueueItem(botId);
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
