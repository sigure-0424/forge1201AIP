1. **Handle unbreakable/dangerous mod blocks:** Add logic in `bot_actuator.js` and `dynamic_registry_injector.js` to mark magma blocks and potentially dangerous mod blocks to the `movements.blocksCantBreak` and `movements.blocksToAvoid` so the bot avoids or doesn't mine them. Only construct/terrain blocks can be broken. Update block mapping fallback logic to prevent getting stuck mining things it shouldn't.

2. **Handle journeyMap waypoints:** Add logic to read from `journeymap` directory and allow the bot to process coordinates from waypoints. Introduce logic in `agent_manager.js` to parse `journeyMap 5.10.3` waypoints by loading `data/journeymap/waypoints/*.json` when the user instructs to go to a waypoint name.

3. **Shield, Axe, Sword usage and Drop Item Collection:** Update `bot_actuator.js` to handle combat efficiently using shield (off-hand), and prefer axe/sword. Add an explicit check in `bot.on('health')` and `passiveDefenseInterval` for shield usage/blocking logic and to ensure dropped items after kills are collected using pathfinder to the drops.

4. **Disable commands in normal start:** Add an environment variable or config check `process.env.MODE` or similar in `index.js`. If started normally via `node index.js`, the bot shouldn't automatically run tasks unless specific conditions are met.

5. **Respawn Point Setting:** Add an action or logic to set a respawn point (using a bed).

6. **Nether Portal Passage:** Fix the `navigate_portal` logic. Currently, it stops at the portal edge. We need to force it to step *into* the portal block (the `nether_portal` block) using explicit control states (forward=true) when standing next to it to cross dimensions successfully.

7. **Initial Equipment Chest:** Add logic to locate the specific chest (the one with smooth stone underneath it) as an initial equipment chest, allowing the bot to freely loot and equip from it. Add this to `getEnvironmentContext` or initialization phase.

8. **GraveStone Mod Recovery:** Implement recovery sequence for the graveStone mod. Upon death (if not abyss), bot pathfinds to the death location and breaks the grave block to collect items.

9. **Task Modes & Chat Processing:**
   - Define execution modes: `Full Auto` (no break), `Auto` (conditional break), and `Task Mode`.
   - Implement chat parsing to detect `mode: [ModeName]`.
   - If in Task Mode or a mode is set, don't ping LLM, but process commands directly via internal logic or loaded JSON tasks.
   - Set up reading from a pre-configured JSON file for Task Mode execution.

10. **Pre-configured JSON Tasks:** Enhance Agent Manager to read a JSON file with an array of actions and dispatch them without LLM when in "Task Mode".

11. **Auto to Task Mode switch:** Add logic to keep track of action count. If in `Full Auto` and actions exceed a threshold, automatically switch to `Task Mode` and begin executing from the pre-defined JSON.
