# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Boot Protocol

At the start of every session, read **all files in `docs/core/`** before reasoning or taking action. The authoritative runtime state is in `docs/core/STATE.yaml` — quote it directly, never invent values. If `active_tasks` is empty, enumerate `docs/proposed/` and select the best next task.

## Commands

```bash
# Run all tests (6 files, must all pass before any docs update)
npm test

# Run only the E2E integration test
npm run test:e2e

# Run a single test file
node tests/test_fml3_handshake_logic_pure.js

# Start the bot system
node index.js
```

## Environment Setup

Copy `.env` values needed:
- `OLLAMA_URL` — full endpoint URL (e.g. `http://172.24.96.1:11434/api/generate`). In WSL2, `localhost` points to the Linux VM, not the Windows host; use the Windows gateway IP.
- `OLLAMA_MODEL` — default `gpt-oss:20b-cloud`
- `OLLAMA_API_KEY` — Bearer token for Ollama authentication
- `OLLAMA_AUTH_SCHEME` — optional, defaults to `Bearer`; set to empty string to send key without prefix

## Architecture

The system connects a Mineflayer bot to a Minecraft 1.20.1 Forge server, bridging the incompatible FML3 protocol, and drives the bot using an LLM via a parent-process orchestrator.

### Process Model

`index.js` → `AgentManager` (parent process) → `bot_actuator.js` (child process via `fork()`)

Communication is via Node.js IPC:
- Parent→Child: `EXECUTE_ACTION` (array of action objects)
- Child→Parent: `USER_CHAT`, `ERROR`, `STATUS`

`AgentManager` queues incoming chat messages, enforces a 5-second LLM cooldown between requests, and tracks in-flight LLM calls per bot with `activeLlmRequests` (Map keyed by botId). When a new `EXECUTE_ACTION` arrives, the actuator sets `currentCancelToken.cancelled = true`, drains the queue, then `await`s `isExecuting` before assigning a new token — preventing race conditions.

### Forge Protocol Bridge (`src/forge_handshake_state_machine.js`)

Intercepts `login_plugin_request` packets and acts as a transparent proxy. The FML3 `fml:loginwrapper` channel wraps an inner `fml:handshake` channel. Discriminator values drive dispatch:
- Disc 1 → send mod list reply
- Disc 3 → buffer registry sync data
- Disc 4 → send Ack
- Disc 6 → complete registry sync

Emits `handshake_complete` with buffered registry payload when done.

### Modded Block Registry (`src/dynamic_registry_injector.js`)

Forge remaps block state IDs at runtime, breaking Prismarine's vanilla registry. This module:
1. Loads a static dictionary of known mod blocks from `data/sample/configs/mod_blocks_dictionary.json`
2. Parses `namespace:blockname` patterns from the Forge handshake payload buffers
3. Deep-copies vanilla block templates (stone/air) and injects mod blocks with appropriate fallback properties
4. **Installs a Proxy on `registry.blocksByStateId`** — unknown state IDs are resolved via binary search fallback to their parent block, preventing pathfinder crashes on modded terrain

### Bot Actuator (`src/bot_actuator.js`)

The largest file (~1,155 lines). Initializes Mineflayer with pathfinder, collectblock, DynamicRegistryInjector, and all middleware. Key design points:

- **Chat dedup**: 3-second window Map (`_chatDedup`) prevents double-firing from Forge's dual `player_chat`+`system_chat` packets
- **`ensureToolFor(block)`**: Guards against fluid/air blocks at the top; only crafts tools for diggable solid blocks
- **`withTimeout(ms, promise)`**: All async actions are wrapped; per-block collect cap is `Math.min(timeoutMs, 20000)` to prevent OOM from pathfinder retrying indefinitely
- **Pathfinder limits**: `thinkTimeout = 5000`, `tickTimeout = 5` — prevents heap exhaustion on complex mod terrain
- **Action types**: come, goto, collect, give, place, craft, equip, eat, smelt, kill, sleep, brew, enchant, explore, navigate_portal, activate_end_portal, place_pattern, status, stop

### LLM Client (`src/llm_client.js`)

Supports Ollama, OpenAI-chat, and OpenAI-completions response shapes via `extractText()`. Returns `null` on any error (caller must check before sending to bot). API key is stripped of BOM and control characters before use.

### Middleware Modules

- **`event_debouncer.js`**: Detects cascading block breaks (VeinMiner) via 500ms debounce; emits `cascading_wait_start/end`
- **`inventory_nbt_patch.js`**: Overrides all item `stackSize` to INT_MAX and reads true count from `StorageCount` NBT tag
- **`create_contraption_hazard.js`**: Patches `pathfinder.getBlockInfo()` to mark Create Mod contraption AABBs as non-walkable

## Task and Docs Workflow

- Proposed tasks live in `docs/proposed/`, completed in `docs/implemented/`
- After every code change: update `docs/core/STATE.yaml` (`recent_changes`, `smoke_status`) and append to `docs/core/ACTIVITY_SUMMARY.md`
- `smoke_status` must reflect the actual last `npm test` run date and result
- Commit message format: `TASK:<task-id> <type>: <description>`
- Do not modify `src/` or `tests/` files as part of documentation-only tasks

## Orchestration

The gemini-orchestrator skill (`.claude/skills/gemini-orchestrator/`) delegates implementation tasks to Gemini CLI. Runtime job state goes under `tmp/orchestrator/jobs/<job-id>/`, never in `docs/core/`. A task is only complete when validation commands pass — not from exit code alone.
