# System Improvement Areas

Generated: 2026-03-27 | Based on full codebase audit of Forge1201AIP.

---

## Priority Summary

| # | Category | Severity | Impact |
|---|----------|----------|--------|
| 1 | Log Management | CRITICAL | Unbounded disk growth (~90 MB/day with 3 bots) |
| 2 | Memory Leaks | HIGH | 50+ MB/day from intervals and unbounded Maps |
| 3 | Race Conditions | HIGH | Action queue corruption, lost LLM responses |
| 4 | Error Handling | MEDIUM | Silent failures, hard debugging |
| 5 | Security | MEDIUM | Chat injection, env-var injection, IP leaks |
| 6 | Test Coverage | MEDIUM | ~70% of bot_actuator.js is untested |
| 7 | Data Persistence | MEDIUM | JSON corruption on crash, multi-bot file races |
| 8 | Performance | MEDIUM | 15 s event-loop stalls, A* thrashing |
| 9 | LLM Prompt | LOW | Vague completion rules, PVP assumption |
| 10 | Technical Debt | LOW | Magic numbers, missing constants |
| 11 | Missing Features | LOW | Rate limiting, metrics, idle timeout |
| 12 | Config / Docs | LOW | Undocumented env vars |

---

## 1. Log Management (CRITICAL)

### Problem
`bot_system.log` and `ai_history_<botId>.log` are appended without any rotation or size cap.

- `bot_system.log` — all stdout/stderr from every actuator process.
- `ai_history_<botId>.log` — 5-second interval snapshots of bot state per bot.

At ~5 MB per 6-hour session × 3 bots = **90 MB/day**. On WSL2, this can exhaust the virtual disk silently.

**Files**: `src/bot_actuator.js:16,23,30,833`

### Fix
Implement log rotation:
- Max 10 MB per file; keep 5 archives → 50 MB total cap per log stream.
- Compress rotated files to `.gz` to recover ~80% space.
- Weekly cleanup task: delete archives older than 7 days.
- Consider using the `winston` or `rotating-file-stream` npm package.

---

## 2. Memory Leaks & Unbounded Data Structures (HIGH)

### 2a. Uncleared setInterval IDs

Six `setInterval` handlers are registered inside `bot.on('spawn', ...)`. The `_spawnInitDone` guard prevents duplicate registration, but interval IDs are never stored or cleared on disconnect/reload.

**File**: `src/bot_actuator.js` — spawn block (passive defense, auto-AFK, safe-pos tracker, debug writer, auto-shredder, status broadcaster)

**Fix**: Store each interval in a module-level Set (`_activeIntervals`). In `bot.on('end', ...)` and `bot.on('kicked', ...)`, call `clearInterval` on all entries and clear the Set.

### 2b. `_chatDedup` Map size

`_chatDedup` prunes entries older than 5 s only when `size > 64`. At high chat volume the Map can briefly reach 100+ entries.

**File**: `src/bot_actuator.js:1026`

**Fix**: Add a periodic `setInterval` (every 10 s) to unconditionally prune entries older than 5 s, independent of size.

### 2c. `llmCooldown` Map never pruned

`agent_manager.js` sets a cooldown timestamp per bot but never deletes the entry after it expires. Entries accumulate across bot restarts.

**File**: `src/agent_manager.js:36`

**Fix**: Delete the map entry immediately after checking that the cooldown has elapsed.

### 2d. `chatLog` cap

`chatLog` stores the last 200 messages per bot. With 10 bots this is 2,000 objects permanently in RAM. The cap should match actual UI needs.

**File**: `src/agent_manager.js:48`

**Fix**: Reduce to 100 entries per bot and ensure `_appendChatLog` enforces it with a splice rather than an unbounded push.

---

## 3. Race Conditions & Async Issues (HIGH)

### 3a. Cancel-token swap window

`processActionQueue()` checks `isExecuting`, then drains the queue, then assigns a new `currentCancelToken`. A second `EXECUTE_ACTION` IPC that arrives between the drain and the assignment will overwrite the token, but the first action has already captured the old reference — the first action will never see cancellation.

**File**: `src/bot_actuator.js` — `processActionQueue` entry (~line 2135)

**Fix**: Wrap the token swap and queue drain in a single synchronous block before the first `await`.

### 3b. `ask_bot` async query never times out

When one bot sends `ask_bot` to another, the parent routes it as `USER_CHAT` to the target bot and awaits a reply. If the target bot is busy executing a long action and never responds, the originating bot's LLM is blocked indefinitely.

**File**: `src/agent_manager.js:653-684` (multi-bot routing block)

**Fix**: Wrap the await in `Promise.race([replyPromise, timeout(10_000)])`. On timeout, send a synthetic `"<botId> did not respond"` reply to unblock the queue.

### 3c. Recovery choice awaits forever

`awaitingRecoveryChoice` blocks all further LLM calls until the player types `y` or `n`. If the player ignores it or goes offline, the bot sits idle indefinitely.

**File**: `src/agent_manager.js:180-241`

**Fix**: Add a 30-second countdown. On expiry, auto-select `n` (cancel recovery) and log a warning.

---

## 4. Error Handling Gaps (MEDIUM)

### 4a. `waitForChunksToLoad` failure is silent

If chunks never load on spawn, the bot continues with an empty world view, causing immediate pathfinder failures.

**File**: `src/bot_actuator.js:182-184`

**Fix**: Retry up to 3 times with 2 s delay; if all retries fail, send `ERROR` IPC so AgentManager can schedule a reconnect.

### 4b. Uncaught exception misses Sentry

`process.on('uncaughtException')` sends `ERROR` IPC only for non-mod errors but does not call `captureException()` from `sentry_reporter.js`. The Sentry hook in `index.js` captures only errors forwarded via IPC.

**File**: `src/bot_actuator.js:35-44`

**Fix**: Import `sentry_reporter` in `bot_actuator.js` and call `captureException(err)` before deciding to suppress or exit.

### 4c. `bot.on('error')` drops non-mod errors silently

Unknown bot errors that don't match the `unknown|unverified` pattern are only `console.error`-logged. No IPC `ERROR` message is sent, so AgentManager never triggers recovery.

**File**: `src/bot_actuator.js:85-91`

**Fix**: For unrecognized errors, call `process.send({ type: 'ERROR', ... })` so recovery pipeline activates.

### 4d. LLM client returns opaque `null`

`llm_client.js` returns `null` for every failure (network timeout, JSON parse error, model overload). The caller cannot distinguish these cases.

**File**: `src/llm_client.js:116-119`

**Fix**: Return `{ error: 'network' | 'json' | 'auth' | 'model', raw: string }` instead of `null`. Update callers to log the specific category and apply different retry policies (e.g., auth errors should not retry).

---

## 5. Security Issues (MEDIUM)

### 5a. Chat rate limiting absent

The chat handler applies only a dedup window. A malicious player could send thousands of `-`-prefixed messages per second to flood the LLM queue.

**File**: `src/bot_actuator.js:714`

**Fix**: Track per-sender message timestamps; ignore messages arriving faster than once per 2 seconds from the same username.

### 5b. Env-var injection via WebUI config

`PUT /api/config` copies arbitrary keys from the request body into `process.env`. An attacker with WebUI access could set `NODE_OPTIONS`, `LD_PRELOAD`, or other dangerous variables.

**File**: `src/web_ui_server.js:116-124`

**Fix**: Maintain an explicit allowlist: `['OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_API_KEY', 'OLLAMA_AUTH_SCHEME', 'WEBUI_PORT']`. Reject any key not in the list with 400 Bad Request.

### 5c. Bot name not validated

The bulk spawn endpoint and the WebUI bot creation both pass bot names directly to `fork()` env and to Minecraft's username field. Special characters or very long names could cause protocol-level issues.

**File**: `src/web_ui_server.js` — `/api/bots/bulk`, `POST /api/bots`

**Fix**: Validate names against `/^[a-zA-Z0-9_]{1,32}$/` before spawning.

### 5d. Sentry PII scrubber misses RFC1918 ranges

The current scrubber only strips dotted-decimal IPv4 and the string `localhost`. Private hostnames like `192.168.x.x`, `10.x.x.x`, `172.16.x.x`, or custom `.local` domains leak through.

**File**: `src/sentry_reporter.js:66-72`

**Fix**: Add regex for all RFC1918 prefixes (`10\.`, `172\.(1[6-9]|2\d|3[01])\.`, `192\.168\.`) and for `.local` / `.internal` domain suffixes.

### 5e. Bulk spawn has no count cap

`POST /api/bots/bulk` accepts any `count` value. Sending `{count: 1000}` would fork 1000 processes instantly.

**File**: `src/web_ui_server.js` — bulk spawn handler

**Fix**: Clamp `count` to `Math.min(count, 10)` and return an error if the request exceeds the limit.

---

## 6. Test Coverage (MEDIUM)

### Current state
- 5/6 unit tests pass; E2E has a pre-existing failure.
- `bot_actuator.js` (~1,155 lines) has **zero unit tests**. All coverage comes from the E2E integration test, which is fragile and environment-dependent.

### Missing test scenarios

| Scenario | File to add test |
|----------|-----------------|
| `withTimeout()` wraps promises correctly and rejects on timeout | `tests/test_bot_actuator_utils.js` |
| `ensureToolFor()` returns without crafting when correct tool is in inventory | `tests/test_bot_actuator_utils.js` |
| Auto-shredder correctly filters junk list | `tests/test_bot_actuator_utils.js` |
| LLM returns null → AgentManager retries after cooldown | `tests/test_agent_manager_recovery.js` |
| Task mode advances index after task completes | `tests/test_agent_manager_recovery.js` |
| `ask_bot` times out when target bot is unresponsive | `tests/test_agent_manager_recovery.js` |
| Death recovery → gravestone recovery chain (full flow) | `tests/test_e2e_integration.js` |
| Multi-bot coordination with 2 bots | `tests/test_e2e_integration.js` |

### Recommended approach
Create a `MockMineflayerBot` helper (in `tests/mock_mineflayer_bot.js`) that stubs `bot.findBlock`, `bot.dig`, `bot.craft`, `bot.pathfinder`, and `bot.entity`. Use it to write isolated unit tests for `bot_actuator.js` logic extracted into pure functions.

---

## 7. Data Persistence (MEDIUM)

### 7a. Non-atomic JSON writes

`saveWaypoints()`, the tasks writer, and `deaths.json` writer all use `fs.writeFile`. A process crash mid-write produces a truncated/corrupt JSON file that permanently breaks on next load.

**File**: `src/bot_actuator.js` — all `saveWaypoints`, `fs.writeFile('data/deaths.json')`, `fs.writeFile('data/tasks.json')` calls

**Fix**: Write to `<file>.tmp`, then `fs.rename(<file>.tmp, <file>)`. Rename is atomic on POSIX; on crash the `.tmp` file is discarded and the old file is intact.

### 7b. Concurrent multi-bot death-record writes

Two bots dying simultaneously both write `data/deaths.json`. The second write overwrites the first.

**File**: `src/bot_actuator.js` — death event handler

**Fix**: Write to `data/deaths_<botId>.json` per-bot and merge at read time, or use an append-only NDJSON format (`data/deaths.ndjson`).

### 7c. No waypoint schema validation on load

`loadWaypoints()` does not validate required fields (`name`, `x`, `y`, `z`, `dimension`). A corrupt entry causes silent `undefined` errors at navigation time.

**Fix**: After loading, filter out entries missing required fields and `console.warn` each dropped entry.

---

## 8. Performance Bottlenecks (MEDIUM)

### 8a. `thinkTimeout` allows 15-second event-loop stalls

A* pathfinder can run for up to 15 seconds (`thinkTimeout = 15000`) blocking physics ticks. Server keepalive ACKs are missed, causing ECONNRESET.

**File**: `src/bot_actuator.js` — Movements setup (~line 257)

**Fix**: Set `thinkTimeout = 5000` (as it was originally). Implement retry with smaller step sizes when `No path found` is returned, rather than allowing longer computation time.

### 8b. `otherBotLines` rebuilt on every LLM call

The multi-bot context string (positions, inventory summaries for all other bots) is formatted fresh for every LLM invocation. With 10+ bots this is O(N) string work per call.

**File**: `src/agent_manager.js:512-516`

**Fix**: Cache the string in a `Map<botId, string>`, invalidate on `BOT_STATUS` IPC events. Refresh at most once per second.

### 8c. `tasks.json` read from disk on every LLM response

Task mode reads `data/tasks.json` from disk every time a response is processed.

**File**: `src/agent_manager.js:500-509` (approximate)

**Fix**: Cache parsed tasks per bot in a `Map<botId, tasks[]>` with a dirty flag. Write-through on task updates, read from cache otherwise.

---

## 9. LLM Prompt Quality (LOW)

### 9a. "Task complete" definition is vague

Task mode instructs the LLM not to mark a task complete just because an action ran. But no concrete completion criterion is given, so the LLM uses guesswork.

**File**: `src/agent_manager.js` — system prompt

**Fix**: Add explicit completion rules:
- Item-collection tasks: complete when `inventory.count(item) >= target`.
- Kill tasks: complete when target entity no longer exists in `environment.nearby_entities`.
- Construction tasks: complete when all blocks are placed (use `bot.findBlock` to verify).
Include these checks in the status action payload.

### 9b. PVP always-on assumption

The prompt states "PVP combat is fully permitted and expected." This conflicts with servers where PVP is disabled.

**Fix**: Remove the blanket PVP statement. Replace with: "Respect server PVP rules. If a kill action on a player fails, do not retry."

### 9c. Prompt organization

The 84-line system prompt is flat and dense. The LLM must scan the whole prompt to find the most critical rules.

**Fix**: Reorganize with sections: `## CRITICAL` (3 rules max), `## BEHAVIOR`, `## ACTIONS`, `## EXAMPLES`. Add a brief `## QUICK REFERENCE` at the top.

---

## 10. Technical Debt & Magic Numbers (LOW)

All of the following should be extracted to named constants with explanatory comments:

| Value | Current location | Suggested constant |
|-------|-----------------|-------------------|
| `25000` (anti-AFK interval ms) | `bot_actuator.js` spawn block | `ANTI_AFK_INTERVAL_MS` |
| `3` (maxDropDown blocks) | `bot_actuator.js:199` | `MAX_SAFE_DROP_BLOCKS` |
| `5` (fall damage threshold) | multiple locations | `FALL_DAMAGE_THRESHOLD_BLOCKS` |
| `15000` (thinkTimeout) | `bot_actuator.js` | `PATHFINDER_THINK_TIMEOUT_MS` |
| `20` (full-auto action limit) | `agent_manager.js` | `FULL_AUTO_ACTION_LIMIT` |
| `2` (queue spam threshold) | `agent_manager.js` | `QUEUE_SPAM_THRESHOLD` |
| `32` (chest scan radius) | `bot_actuator.js` | `EQUIPMENT_SCAN_RADIUS_BLOCKS` |
| `500` (mid-block debounce ms) | `event_debouncer.js` | `VEINMINER_DEBOUNCE_MS` |

---

## 11. Missing Features & Robustness (LOW)

### 11a. Bot performance metrics endpoint

No way to inspect pathfinder queue depth, LLM latency, or heap usage without reading raw logs.

**Fix**: Add `GET /api/bots/:id/perf` returning:
```json
{
  "heapUsedMB": 142,
  "llmAvgLatencyMs": 1240,
  "pathfinderQueueDepth": 3,
  "actionsExecutedToday": 88
}
```

### 11b. Idle timeout

A bot left unattended will run indefinitely even if no player is online to issue commands.

**Fix**: Add `IDLE_TIMEOUT_MINUTES` env var (default: no timeout). If no chat or action is received for that duration, the bot disconnects and logs a reason.

### 11c. Waypoint auto-backup

`data/waypoints.json` is the primary user-generated dataset. It has no backup mechanism.

**Fix**: On every save, copy current file to `data/backups/waypoints_<ISO-date>.json`. Keep the last 7 dated backups and delete older ones.

### 11d. Bot name collision on bulk spawn

Bulk spawn auto-generates names like `AI_Bot_01`, but only skips names of *running* bots. If a bot crashes and is being restarted, the name could be reused by a new bulk spawn.

**File**: `src/web_ui_server.js` — `_nextBotNames()`

**Fix**: Skip names present in `bots` Map OR in `restartingBots` Set.

---

## 12. Configuration & Documentation (LOW)

The following env vars are referenced in code but absent from any README or `.env.example`:

| Variable | File | Description |
|----------|------|-------------|
| `WEBUI_PORT` | `src/web_ui_server.js` | HTTP port for dashboard (default: 3000) |
| `DEBUG` | `src/bot_actuator.js` | Enables `/tp`, `/spreadplayers`, verbose logs |
| `SENTRY_DSN` | `src/sentry_reporter.js` | Sentry project DSN for crash reporting |
| `OLLAMA_AUTH_SCHEME` | `src/llm_client.js` | Auth prefix (Bearer / ApiKey / "" for none) |
| `IDLE_TIMEOUT_MINUTES` | (proposed) | Auto-disconnect bots after N idle minutes |

**Fix**: Create `.env.example` with all variables, types, defaults, and a one-line description. Reference it in the README.

---

## Appendix: Quick Win Checklist

Items that can be completed in < 30 minutes each:

- [x] Add `count` cap (≤ 10) to bulk spawn endpoint
- [x] Add env-var allowlist to `PUT /api/config`
- [x] Add bot name regex validation
- [x] Delete expired `llmCooldown` entries after use
- [x] Reduce `chatLog` cap from 200 to 100 per bot
- [x] Create `.env.example` with all env vars documented
- [x] Add schema validation to `loadWaypoints()` (filter bad entries, warn)
- [x] Replace death-record write with per-bot file (`deaths_<botId>.json`)
