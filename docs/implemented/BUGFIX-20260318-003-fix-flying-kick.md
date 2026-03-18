# BUGFIX-20260318-003-fix-flying-kick

## Issue
The bot was being kicked for "flying" immediately after login or when the floor beneath it was removed. This was caused by several factors:
1.  **Registry Proxy Over-reach**: The `Proxy` on `bot.registry.blocks` was returning a solid block for *any* unknown ID, including ID 0 (air) if it was missing from the target object. This caused the bot to believe it was standing on solid ground even when in mid-air.
2.  **Collision Shape Desync**: The collision shape proxy was defaulting to a solid cube (ID 1) for unknown block names, which occasionally included `air` or related variants.
3.  **Race Condition**: Registry proxies were applied with a 100ms delay, causing a potential desync between the bot's state at spawn and its belief system a moment later.
4.  **ReferenceError**: The `AgentManager` had a `ReferenceError` in its recovery pipeline, preventing it from automatically restarting the bot after a kick.

## Solution
1.  **Surgical Proxies**: 
    - Restricted the `blockHandler` to only proxy IDs > 20000 (modded range). Vanilla IDs and ID 0 (air) are now never proxied to solid.
    - Added explicit air-name handling in `shapeHandler` to ensure it always returns collision shape 0 (empty).
    - Removed the `setTimeout` to apply proxies immediately upon handshake completion.
2.  **Physics Hard-Fix**: Added a `physicsTick` listener that manually forces `bot.entity.onGround = false` if the block 5cm below the bot is `air`. This ensures gravity always applies correctly regardless of registry state.
3.  **Gravity Stabilization**: Implemented aggressive vertical velocity damping for airborne bots that are not actively moving, preventing upward "jitter" that triggers server-side fly detection.
4.  **AgentManager Fix**: Resolved the `ReferenceError` in `src/agent_manager.js` to enable automated recovery from kicks.

## Verification
- Bots standing on modded blocks should now see them as solid IF they are correctly injected.
- Bots standing on air will now correctly fall.
- "Flying" kicks should be caught and recovered by the AgentManager.
