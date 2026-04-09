# TASK_INDEX

## Active
- TASK-20260409-004-experimental-world-exhaustive-validation: Execute full zone-by-zone E2E validation in generated experimental world via direct action API and collect evidence

## Completed
- TASK-20260409-003-test-world-auto-generation: Add automated 9-zone test world generator from forgeaip_registry.json, clean-world Docker boot path, queued direct -goto parsing, and integration validation with Forge+bot containers
- BUGFIX-20260409-002-come-landing-goto-hollow-escape: Remove onGround from come ACTIVE→IDLE (PID hover deadlock causes permanent airborne), add goto severe-stuck jetpack escape for hollow-below-hill terrain obstacles
- BUGFIX-20260409-001-come-fall-goto-jetpack-llm-portal: Fix come jetpack bounce-fall loop (PID+onGround), goto vertical jetpack promotion (dy>=30), LLM portal misfire guard after goto failure
- BUGFIX-20260408-005-come-jetpack-follow-redesign: Replace flyWithJetpack() delegation with inline _jActive state machine in come interval; physicsTick hook for constant vertical thrust; no landing phase; dy-driven IDLE/ACTIVE transitions
- BUGFIX-20260408-004-come-jetpack-follow-deadlock: Prevent come follow stalls after jetpack assist by skipping setGoal during aerial busy state, widening vertical-assist trigger, and using GoalXZ for large Y gaps
- BUGFIX-20260408-003-follow-jetpack-descent-path-detail: Add path_update detailed route broadcasting and guard stale/over-eager come jetpack ascents
- BUGFIX-20260408-002-follow-vertical-path-overlay: Fix airborne follow Y convergence with jetpack assist and restore path overlay by broadcasting setGoal paths
- BUGFIX-20260406-002-auxmod-minimal-player-telemetry: Simplify aux-mod entity update payload to playerName/dimension/position only (no viewport-derived data)
- BUGFIX-20260406-001-follow-visibility-flight-intent: Harden come/follow out-of-view continuity and normalize jetpack/elytra flight intent to fly action
- TASK-20260404-002-knowledge-ui-ops: Add WebUI knowledge operations (crawl status + local search), run crawl continuation, and validate with npm test
- TASK-20260320-002-post-fix-smoke-sync: Run npm test and update STATE.yaml and ACTIVITY_SUMMARY.md for race-condition fix
- TASK-20260320-001-verify-docker-environment: Verify Docker environment and run npm test suite inside container
- TASK-20260320-001-documentation-sync: Sync docs for boss-defeat actions, LLM multi-format parser, and GOAL.md key removal
- BUGFIX-20260320-001-llm-multi-format-parser: Multi-format extractText() + better connection error diagnostics in LLM client
- TASK-20260319-004: Collect reliability fixes + 11 boss-defeat actions (eat, smelt, kill, equip_armor, sleep, brew, enchant, explore, navigate_portal, activate_end_portal, place_pattern)
- TASK-20260319-005-configure-llm-env: Configure dotenv, model defaults, and API key auth for LLM Client
- TASK-20260319-003-pathfinding-and-collection-fixes: 6 fixes — GoalFollow come, relaxed thinkTimeout, waypoint goto, collect skip-on-fail, silent stop, auto-tool subroutine
- TASK-20260319-002-consolidate-tests-and-fix-line-endings: Consolidated npm test to run all 6 test files; added .gitattributes for LF enforcement
- BUGFIX-20260319-004-fix-llm-race-condition: Fixed infinite LLM feedback loops and added command interruption and concurrency control
- BUGFIX-20260319-003-fix-oom-during-pathfinding: Fixed A* pathfinding Memory leak and JSON unwrapping
- BUGFIX-20260319-002-fix-llm-json-parsing: Fixed bot freeze by adding JSON sanitization/retry in AgentManager and action task queue in bot_actuator.js
- BUGFIX-20260319-001-missing-collectblock: Installed missing 'mineflayer-collectblock' to resolve crash on launch
- TASK-20260319-001-finalize-npm-scripts: Finalize package.json npm scripts to run test suite
- BUGFIX-20260318-002-fix-modded-block-interaction: Fix modded block interaction issues
- TASK-20260318-002-documentation-alignment: Documentation Alignment and Finalization
- BUGFIX-20260318-001-fix-infinite-login-loop: Fix 'unexpected tag end' crash and infinite login loop
- TASK-20260318-001-e2e-integration-test: Implement e2e integration testing using MockForgeServer
- TASK-20260317-004-verify-agent-manager-and-config-rag: Verify Agent Manager and Config RAG Parser
- TASK-20260317-003-implement-middlewares: Implement and Verify Middlewares (Debouncer, NBT, Hazard)
- TASK-20260317-002-verify-fml3-handshake: Verify and Harden FML3 Handshake logic
- TASK-20260316-001-align-project-metadata: Align project metadata, init Node.js and implement framework
- TASK-20260316-002-implement-bot-actuator-pathfinding: Implement bot actuator pathfinding
- TASK-20260317-001-create-main-entrypoint: Create main entry point to start the bot

## Proposed
\