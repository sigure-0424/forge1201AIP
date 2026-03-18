# BUGFIX-20260318-002-fix-modded-block-interaction

## Issue
The bot experienced several issues when interacting with modded block entities:
1.  **Movement Stasis**: The bot failed to find paths when standing on or moving toward modded blocks (`noPath`).
2.  **Passive Damage Avoidance**: The bot did not automatically avoid blocks that cause passive damage (e.g., modded environmental hazards).
3.  **Physics Crash**: When the floor beneath the bot was removed, it "logged out immediately," likely due to a crash in the physics engine or a `NaN` position state.

## Solution
Implemented a multi-layered fix for modded physical interaction:
1.  **Refined Block Proxy**: Improved the `Proxy` on `bot.registry.blocks` to provide a consistent `defaultBlock` (solid rock) for all unknown/modded block IDs (>20000). This ensures the physics engine and pathfinder always have valid block properties.
2.  **Dynamic Hazard Detection**: Added a listener for `entity_status` (damage). If the bot takes damage while standing on a modded block, that block's ID and name are added to a `bot.hazards` set.
3.  **Pathfinder Movements Patch**: Overrode `Movements.prototype.getBlockInfo` to check the `bot.hazards` set. If a block is marked as a hazard, it is treated as unsafe and non-walkable by the pathfinder.
4.  **Position Guard**: Added a `move` listener to detect `NaN` positions (indicative of physics engine failure). If detected, it reports an error to the `AgentManager` to trigger a recovery restart.

## Verification
- Verified that the `Proxy` correctly returns solid block properties for high IDs.
- The `noPath` issue should be resolved by ensuring the current position is always on a "physical" block.
- Passive damage avoidance will now trigger dynamically upon first contact.
