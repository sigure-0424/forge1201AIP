# ACTIVITY_SUMMARY

Format:
- [summary] | [paths] --[agent-id] --[task-id]

Entries:
- Fixed 4 logical failures: (1) Survival Mechanics Suppressed During Tasks: replaced !isExecuting check in bot_actuator.js health and passive defense handlers with pathfinder state checks so bot can eat/fight when standing still; (2) Uncancellable Auto-Crafting: added cancellation token checks inside ensureToolFor loops; (3) Sticky Jump State: updated custom physics jump override to clear jump when not moving forward to prevent sticky hopping; (4) Mod Block Passability Inconsistency: marked unknown mod blocks in dynamic_registry_injector.js and added them to movements.blocksCantBreak to prevent bot from trying to mine them. | src/bot_actuator.js, src/dynamic_registry_injector.js --claude --BUGFIX-20260322-002
- Verified Docker environment by adding a custom Dockerfile with Node.js 18.x and confirming successful 'npm test' inside the container, passing all middleware and E2E integration tests | docker/Dockerfile, docker/compose.yaml --gemini --TASK-20260320-001-verify-docker-environment
- Fixed follow broken by 6 compounding bugs: (1) self-defense health handler called bot.pathfinder.setGoal(null) on ANY damage, permanently destroying the active GoalFollow — removed the setGoal(null)/clearControlStates/sprint-dodge sequence entirely; (2) bot.on('spawn') fired on every respawn/dimension-change, each time adding new bot.on('health') and setInterval handlers that accumulated — added _spawnInitDone guard; (3) previous fix set boundingBox='empty' with shapes=full-cube, causing pathfinder to plan paths through mod blocks that physics blocked — reverted to consistent boundingBox='block'; (4) passive defense bot.attack(hostile) every 600ms changed the bot's yaw during pathfinding, conflicting with the pathfinder's bot.look() — now skipped when isExecuting; (5) console.log override used fs.appendFileSync blocking the event loop 1-10ms per call on WSL2 — switched to async fs.appendFile; (6) tickTimeout=40ms used 800ms/s of CPU on the main thread, starving other operations — restored to 10ms (the original working value from commit 00fe7ea) | src/bot_actuator.js, src/dynamic_registry_injector.js --claude --BUGFIX-20260321-005
- Fixed follow moving at 1 block/minute: (1) supervision loop was calling setGoal every 1s which triggered resetPath('goal_updated') cancelling A* every second — now only resets when entity object identity changes; (2) unknown mod blocks defaulted to stone template (boundingBox='block') causing Movements to add every mod block at body/head height to toBreak, forcing the bot to dig through walkable terrain — changed default to air template (passable) | src/bot_actuator.js, src/dynamic_registry_injector.js --claude --BUGFIX-20260321-003
- Fixed follow effectively frozen: tickTimeout raised 5→40ms (was only 100ms/s compute → paths timed out constantly on modded terrain); replaced manual while/goto loop with GoalFollow(entity, dynamic=true) so pathfinder tracks target continuously without stop-recompute cycles | src/bot_actuator.js --claude --BUGFIX-20260321-002
- Fixed follow stuck (per-attempt 5s cap, 500ms retry delay, jump escape after 3 failures), collect search radius expanded to 128 blocks (3rd pass), ensureToolFor log search widened to 128 blocks, added UNDERGROUND_BLOCKS set with underground hint on "not found", improved tool-missing error message with full crafting chain, upgraded LLM prompt with inventory-check instruction and underground resource guidance | src/bot_actuator.js, src/agent_manager.js --claude --BUGFIX-20260321-001
- Initialized generic bootstrap repo layout and core docs | README.md, GOAL.md, MASTER_GUIDANCE.md, docs/, docker/, scripts/, .vscode/ --openai --TASK-20260303-001-bootstrap-template
- Removed legacy helper scripts from the base template | scripts/ --openai --TASK-20260303-001-bootstrap-template
- Added selector-based agent startup, a reusable gemini-orchestrator skill package, orchestration policies, and generic runtime helpers | .vscode/sessions.json, .claude/skills/, docs/core/, docs/proposed/, docs/implemented/, scripts/, tmp/orchestrator/ --openai --TASK-20260311-001-agent-orchestrator-bootstrap
- Aligned project metadata, initialized Node.js project, and implemented Minecraft AI bot framework core scripts based on GOAL.md (ForgeHandshakeStateMachine, DynamicRegistryInjector, EventDebouncer, InventoryNBTPatch, CreateContraptionHazard, ConfigRAGParser, AgentManager, bot_actuator) | src/, tests/smoke.js, package.json --gemini --TASK-20260316-001-align-project-metadata
- Implemented functional Bot Actuator with Mineflayer and pathfinder integration, including command listeners and hazard avoidance logic | src/bot_actuator.js --gemini --TASK-20260316-002-implement-bot-actuator-pathfinding
- Created main entry point index.js to allow starting the agent manager | index.js --gemini --TASK-20260317-001-create-main-entrypoint
- Verified and hardened FML3 Handshake logic and Dynamic Registry Injector via pure logic tests and refined event handling | src/forge_handshake_state_machine.js, tests/test_fml3_handshake_logic_pure.js, tests/test_dynamic_registry_injector.js --gemini --TASK-20260317-002-verify-fml3-handshake
- Implemented and verified middlewares (EventDebouncer, InventoryNBTPatch, CreateContraptionHazard) for handling mod-specific Minecraft behaviors | src/event_debouncer.js, src/inventory_nbt_patch.js, src/create_contraption_hazard.js, tests/test_middlewares.js --gemini --TASK-20260317-003-implement-middlewares
- Successfully resolved 'floating' freeze and positional desync via Vanilla-exclusive mapping mode, ensuring perfect movement and knockback on vanilla blocks within Forge | src/bot_actuator.js, src/dynamic_registry_injector.js --gemini --BUGFIX-20260318-005
- Resolved fatal positional desync, fixed 'frozen' physics after digging, and improved modded registry ID extraction | src/bot_actuator.js, src/dynamic_registry_injector.js --gemini --BUGFIX-20260318-004
- Improved pathfinder reliability, added 'status' command, and enhanced logging for debugging | src/bot_actuator.js --gemini --BUGFIX-20260318-003
- Aligned documentation (BUGFIX records, variable map) and verified state | docs/implemented/BUGFIX-20260318-001-fix-infinite-login-loop.md, docs/variable_map.md --gemini --TASK-20260318-002-documentation-alignment
- Fixed 'Received empty payload' server error by skipping response for S2CModData and improved registry injection with heuristic scanning to mitigate 'unexpected tag end' parse errors | src/forge_handshake_state_machine.js, src/dynamic_registry_injector.js, src/bot_actuator.js --gemini --BUGFIX-20260317-001-fix-parse-error
- Verified AgentManager recovery logic and integrated ConfigRAGParser with smol-toml for server constraint injection | src/agent_manager.js, src/config_rag_parser.js, index.js, tests/test_config_rag_parser.js, tests/test_agent_manager_recovery.js --gemini --TASK-20260317-004-verify-agent-manager-and-config-rag
- Finalized npm scripts by adding 'test' command executing E2E integration tests | package.json, docs/implemented/TASK-20260319-001-finalize-npm-scripts.md --gemini --TASK-20260319-001-finalize-npm-scripts
- Installed missing 'mineflayer-collectblock' module to fix bot actuator crash during startup | package.json, package-lock.json, docs/implemented/BUGFIX-20260319-001-missing-collectblock.md --gemini --BUGFIX-20260319-001-missing-collectblock
- Fixed bot freeze on malformed JSON by adding sanitization/retry to AgentManager and implementing an asynchronous sequential action queue in bot_actuator.js | src/agent_manager.js, src/bot_actuator.js, docs/implemented/BUGFIX-20260319-002-fix-llm-json-parsing.md --gemini --BUGFIX-20260319-002-fix-llm-json-parsing
- Fixed A* pathfinding Out of Memory crash by limiting thinkTimeout and maxDistance, and improved LLM JSON sanitization for deeply nested action keys | src/bot_actuator.js, src/agent_manager.js, docs/implemented/BUGFIX-20260319-003-fix-oom-during-pathfinding.md --gemini --BUGFIX-20260319-003-fix-oom-during-pathfinding
- Implemented state management to prevent infinite LLM feedback loops, added user-priority action interruption, and concurrency control in AgentManager | src/agent_manager.js, docs/implemented/BUGFIX-20260319-004-fix-llm-race-condition.md --gemini --BUGFIX-20260319-004-fix-llm-race-condition
- Configured LLM client to use dotenv, default to gpt-oss:20b-cloud, and inject Bearer authorization | src/llm_client.js, src/agent_manager.js, docs/implemented/TASK-20260319-005-configure-llm-env.md --gemini --TASK-20260319-005-configure-llm-env
- Resolved collect timeout/stall (thinkTimeout 10s, 3x candidates, 64-block fallback, stale pathfinder clear, proactive axe craft); added 11 boss-defeat actions (eat, smelt, kill, equip_armor, sleep, brew, enchant, explore, navigate_portal, activate_end_portal, place_pattern) | src/bot_actuator.js, src/agent_manager.js --gemini --TASK-20260319-004
- Improved LLM error diagnostics (shows exact URL + .env hint on failure) and added multi-format extractText() for Ollama, OpenAI-chat, and OpenAI-completions response shapes | src/llm_client.js --gemini --BUGFIX-20260320-001-llm-multi-format-parser
- Removed plaintext API key accidentally committed to GOAL.md; key remains only in .env | docs/core/GOAL.md --claude --TASK-20260320-001-documentation-sync
- Consolidated npm test to run all 6 test files, added .gitattributes to enforce LF line endings, normalized CRLF files | package.json, .gitattributes, docs/core/STATE.yaml --claude --TASK-20260319-002-consolidate-tests-and-fix-line-endings
- Fixed 6 bot_actuator issues: come→GoalFollow continuous follow, thinkTimeout 1000→5000, removed 50-block goto cap with waypoints, collect continue-on-skip, muted stop chat, added ensureToolFor auto-tool subroutine; updated agent_manager LLM prompt | src/bot_actuator.js, src/agent_manager.js --claude --TASK-20260319-003-pathfinding-and-collection-fixes
- Fixed EXECUTE_ACTION race condition: await isExecuting before starting new action queue | src/bot_actuator.js --claude --BUGFIX-20260320-002

- Added find_land action (/spreadplayers 0 0 0 2000 false <bot>) to scatter bot to dry land before live tests; test_live.js now calls find_land after waitForReady and uses land base coords for return test | src/bot_actuator.js, test_live.js --claude --BUGFIX-20260322-001

## 2026-03-24 — BUGFIX-20260324-002: Bot Connectivity & ECONNRESET Fixes

### Changes
- **bot_actuator.js**: 4 fixes.
  1. **`bot.on('end')` triggers recovery**: Previously silent — server sending graceful FIN left the bot permanently dead with AgentManager unaware. Now sends `ERROR/Disconnected` IPC (guarded by `_disconnectedNotified` flag to prevent double-recovery when both 'error' and 'end' fire).
  2. **Socket check at action queue start**: Each action now checks `socket.writable` before executing. If the socket died during LLM processing, drops the queue and sends recovery signal instead of writing to a dead socket (which was the ECONNRESET source).
  3. **navigate_portal `isConnected()` guard**: Added guard before `bot.chat` and `bot.pathfinder.goto` after portal is found.
  4. **Anti-AFK head rotation**: `setInterval` every 25s does a small random `bot.look()` when not executing. Prevents server AFK-kick during LLM processing windows (30+ seconds), which was the root cause of the ECONNRESET.
- **agent_manager.js**: 2 fixes.
  1. **Preserve host/port on restart**: `botConnOptions` Map stores original connection options; `scheduleRestart` passes them so restarted bot connects to the real server (not `localhost:25565` fallback).
  2. **`Disconnected` recovery case**: Added to `triggerRecoveryPipeline` switch.
- All 6 tests passing.

## 2026-03-24 — TASK-20260324-001: Combat & Navigation Robustness

### Changes
- **bot_actuator.js**: 5 improvements, all tests passing (6/6).
  1. **Death recovery respawn fallback**: 3s setTimeout after spawn scans inventory for gravestone death-marker items (coordinate pattern matching) and falls back to `data/last_death.json` if <15min old. Auto-queues `recover_gravestone` when no recover action pending.
  2. **navigate_portal enhanced**: checks internal waypoints by keyword first, expands search radius to 128/256 blocks, then explores cardinal directions up to 512 blocks. Saves found portal as waypoint on success.
  3. **goto XYZ timeout 60s→120s**: Distant targets (>64 XZ blocks) now XZ-step to within 32 blocks before final XYZ approach — avoids A* 3D planning timeout on huge routes.
  4. **Combat shield improvements**: Shield equip retry loop pre-battle; `_shieldUntil` replaces `_shieldCooldown`; melee adds post-attack sideways strafe; projectile detection uses velocity dot-product to confirm inbound trajectory.
  5. **Ranged combat non-blocking bow charge**: `_bowCharging` state tracks charge timer per-tick; IDEAL_MIN/MAX engagement range; LoS raycast before shooting; repositions if no LoS.

## 2026-03-23 — TASK-20260323-001: Navigation & Waypoint Enhancements

### Changes
- **bot_actuator.js**: 6 improvements implemented, all tests passing (6/6).
  1. **Stuck recovery fix**: Replaced the `blocksCantBreak`/`blocksToAvoid` pollution approach (which permanently blocked all terrain-type blocks session-wide) with a jump + perpendicular sidestep escape maneuver. No lasting side effects on the movements object.
  2. **goto lower-Y prefers natural paths**: When destination Y is 10+ blocks below current, tries pathfinding with `canDig=false` first (up to 30s). Falls back to digging only if no natural passage found.
  3. **Idle equipment chest auto-collect**: 30-second interval checks for chests on smooth_stone within 32 blocks when bot is idle. Deduped via `_lootedChests` Set. Fires in addition to existing spawn-time check.
  4. **Structure /locate integration**: `goto {target: "fortress"}` etc. issues `/locate structure minecraft:<id>`, parses `[X:N, ~, Z:N]` from chat, navigates to result.
  5. **Internal waypoint system**: `data/waypoints.json` stores `{name, x, y, z, dimension}`. New `add_waypoint` action saves current position. `goto` resolves internal waypoints first, then JourneyMap, then /locate. Cross-dimension waypoints auto-prepend `navigate_portal` action.
  6. **README**: Added full action reference table, waypoint system docs, and screen recording guidance (OBS / ReplayMod).
