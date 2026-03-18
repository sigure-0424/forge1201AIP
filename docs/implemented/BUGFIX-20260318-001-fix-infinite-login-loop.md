# BUGFIX-20260318-001-fix-infinite-login-loop

## Issue
The bot was experiencing an "unexpected tag end" crash during the login/play transition and getting stuck in an infinite login loop. This was caused by:
1.  Modded Forge 1.20.1 servers sending complex packets (`declare_recipes`, `tags`, `advancements`, etc.) that standard `node-minecraft-protocol` and `mineflayer` cannot correctly parse due to schema mismatches or missing mod definitions.
2.  Corrupted or unexpected NBT data in some handshake/registry packets.

## Solution
Implemented a multi-layered bypass and leniency strategy:
1.  **Protocol Bypass**: In `src/bot_actuator.js`, several problematic S2C packets are intercepted and redirected to a `restBuffer` type at the protocol level. This prevents the parser from attempting to decode complex modded schemas that it doesn't recognize.
    - Bypassed packets: `declare_recipes`, `tags`, `advancements`, `declare_commands`, `unlock_recipes`, `craft_recipe_response`, `nbt_query_response`.
2.  **NBT Leniency Patch**: Overrode the `prismarine-nbt` read function to catch errors and fallback to anonymous reading, preventing "unexpected tag end" crashes when parsing non-standard NBT structures.
3.  **Forge Handshake Detachment**: Refined the `ForgeHandshakeStateMachine` to detach its packet listener after the bot successfully spawns, ensuring no late-arriving login-phase packets interfere with the play state.

## Verification
- Verified using `tests/test_e2e_integration.js` against `MockForgeServer`.
- The bot successfully completes the handshake and reaches the 'play' state without crashing.
- Verified that the "unexpected tag end" error no longer occurs.
