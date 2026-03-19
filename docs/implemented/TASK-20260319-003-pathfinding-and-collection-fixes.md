# TASK-20260319-003: Pathfinding and Collection Fixes

## Goal
Resolve pathfinding limitations, task execution failures, and logic loops in bot_actuator.js and agent_manager.js.

## Fixes Implemented

### Fix 1 — Continuous Follow (`come` action)
- Changed from `GoalNear(staticCoord)` to `GoalFollow(entity, 2)` with `dynamic=true`.
- Bot now tracks the player's live position rather than navigating to a snapshot coordinate.
- `come` blocks the action queue via a cancel-token polling loop; cleared by `stop`.

### Fix 2 — Pathfinder Timeout Relaxed
- `bot.pathfinder.thinkTimeout` raised from `1000` → `5000` ms.
- Prevents immediate failures on slight elevation changes or moderately complex terrain.

### Fix 3 — Removed 50-Block `goto` Cap
- Deleted the hardcoded 50-block distance override.
- Replaced with a waypoint loop (64-block segments) for XZ navigation; stuck-detection aborts after 3 non-progress waypoints.
- XYZ goto navigates directly (Y-constraint naturally limits the A* search tree).

### Fix 4 — Skip Failed Block in `collect`
- Changed `break` → `continue` in the collect loop's catch block.
- Unreachable or timed-out blocks are skipped; collection continues with remaining blocks.

### Fix 5 — Muted `stop` Chat Spam
- Removed `bot.chat("Stopped.")` from the `stop` handler.
- Prevents the bot from echoing a chat message every time the user speaks (agent_manager sends stop on every user utterance).

### Fix 6 — Auto-Tool Verification (`ensureToolFor`)
- New module-level subroutine `ensureToolFor(block)` called once before each `collect` loop.
- Flow: check harvestTools → infer tool category → collect logs → craft planks → craft sticks → find/place crafting table → craft wooden tool → equip.
- `inferToolCategory(block)` maps block names to pickaxe/axe/shovel via name pattern matching.
- `equipBestTool` moved from inner function to module level to be shared by both routines.

### agent_manager.js — Prompt Update
- Added inline notes to the LLM prompt clarifying `come` is a continuous follow and `goto` supports any distance.
- Added critical note that the bot auto-crafts tools, preventing the LLM from looping on manual tool-craft commands.

## Definition of Done
- All 6 npm tests pass.
- No regressions in existing behavior.
