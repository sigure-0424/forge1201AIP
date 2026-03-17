# TASK-20260317-003-implement-middlewares

## 1. Overview and Problem Statement
The current middleware components (`event_debouncer.js`, `inventory_nbt_patch.js`, `create_contraption_hazard.js`) are basic stubs. To achieve the project goal, these must be fully implemented to handle mod-specific behaviors like VeinMiner terrain updates, large stack sizes in modded storage, and Create Mod contraption avoidance.

## 2. Success Criteria
- [ ] Implement `event_debouncer.js` with a 500ms debounce timer for block updates.
- [ ] Implement `inventory_nbt_patch.js` to override stack limits and parse NBT for true item counts.
- [ ] Implement `create_contraption_hazard.js` to set infinite cost zones for Create Mod contraptions in pathfinding.
- [ ] Verify each middleware with a unit test.

## 3. Implementation Plan
1.  **Event Debouncer**: Implement the logic to delay LLM callbacks during cascading block updates.
2.  **Inventory NBT Patch**: Implement the `prismarine-item` override and NBT parsing.
3.  **Create Contraption Hazard**: Implement the `mineflayer-pathfinder` heuristic override.
4.  **Testing**: Create `tests/test_middlewares.js` to verify all three components.

## 4. Risks and Mitigations
- **Pathfinder Internal Changes**: Overriding pathfinder heuristics can be brittle. Mitigation: Use documented `pathfinder.setMovements` or well-known override points.
- **NBT Complexity**: Different mods use different NBT structures. Mitigation: Focus on common patterns or provide a extensible parser.

## 5. Execution Mode
- `local`
