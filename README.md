# Minecraft Forge 1.20.1 AI Player System

This framework provides an autonomous AI player system using Mineflayer designed specifically for Minecraft 1.20.1 Forge environments. It resolves the fundamental protocol and registry incompatibilities between standard Mineflayer and Forge servers.

## Core Architecture

The system is split into an **Agent Manager** (main process) and isolated **Bot Actuators** (child processes). This ensures stability and prevents pathfinding loops from crashing the main orchestrator.

### Key Components

| Component | Responsibility |
| :--- | :--- |
| `forge_handshake_state_machine.js` | **FML3 Protocol Bridge**: Handles the complex Forge Mod Loader (FML3) handshake, spoofing mod lists and registry acknowledgments to allow standard Mineflayer login. |
| `dynamic_registry_injector.js` | **Vanilla-First Mapping**: Intercepts dynamic registry synchronization packets and maps Forge-specific ID shifts back to valid Vanilla block definitions. This prevents crashes in the Pathfinder and Physics engine. |
| `bot_actuator.js` | **Autonomous Execution**: Manages the bot instance, Mineflayer plugins (Pathfinder), and physics stabilization. |
| `agent_manager.js` | **Lifecycle Management**: Orchestrates multiple bot processes and handles automatic recovery from kicks or crashes. |

## Forge 1.20.1 Compatibility (Final Resolution)

The system achieves stability in modded environments through a **Vanilla-Mapping strategy**:
- **Protocol Bypasses**: Problematic modded packets (recipes, tags, advancements) are intercepted and ignored at the protocol level to prevent stream desync.
- **Pathfinder Stability**: Uses a strictly validated block mapping that prevents the common `TypeError: reading 'length'` crash in `mineflayer-pathfinder`.
- **Physics Synchronization**: Resolves "floating mid-air" issues by ensuring the bot's internal registry accurately reflects the server's solid ground, even when block IDs are shifted by mods.
- **Server as Truth**: Implements logic to immediately synchronize position and velocity with the server, ensuring natural knockback and gravity.

## Getting Started

1.  **Configure**: Set your server details in environment variables or `index.js`.
2.  **Install**: `npm install`
3.  **Run**: `node index.js`

## WebUI Dashboard

A local WebUI is available at `http://localhost:3000` after starting the bot. You can use this dashboard to view bot health, inventory, active tasks, and send chat commands directly without in-game access.

## Configuration & Requirements

- **Node.js**: Requires Node.js v18+. [Download here](https://nodejs.org/)
- **Ollama (Local LLM)**: For local hosting, install [Ollama](https://ollama.com/) and run `ollama run gpt-oss:20b` (recommended model).
- **Model Switching**: Edit `OLLAMA_MODEL` and `OLLAMA_URL` in `.env` or configuration files to switch between cloud APIs (like OpenAI/Anthropic via proxies) and local hosting.
- **Hardware Requirements**:
  - 1 Bot (Local LLM): 16GB RAM, modern 6-core CPU, 8GB+ VRAM GPU (for 20B models).
  - 3+ Bots: 32GB RAM, 12GB+ VRAM.
  - Cloud API: Minimal requirements (4GB RAM).

## Streamlined Startup

Windows users can simply double-click `run.bat` to launch the system. Linux/Mac users can run `./run.sh`.

## Commands

Once the bot is online, you can use the following in-game chat commands:
- `come`: Calculates a path and moves to your position.
- `goto <x> <z>` / `goto <x> <y> <z>`: Move to specific coordinates.
- `goto <waypoint_name>`: Travel to a named internal waypoint (cross-dimension supported).
- `goto <structure>`: Use `/locate` to find a structure (e.g. `fortress`, `village`, `stronghold`) and navigate to it.
- `status`: Reports current coordinates, health, and ground state.
- `dump_chunks`: Dumps all currently loaded blocks around the bot to a file `chunk_dump.json`.
- `stop`: Immediately cancels all current goals.

## Action Reference

Actions are sent via IPC as `EXECUTE_ACTION` messages. Key action types:

| Action | Parameters | Description |
| :--- | :--- | :--- |
| `come` | — | Follow the nearest player. |
| `goto` | `x, z` or `x, y, z` | Move to coordinates. If `y` is below current by 10+, prefers natural paths before digging. |
| `goto` | `target: "<name>"` | Travel to a named internal waypoint, JourneyMap waypoint, or run `/locate` for structures. Cross-dimension travel is handled automatically. |
| `add_waypoint` | `name: "<name>"` | Save current position + dimension as a named waypoint to `data/waypoints.json`. |
| `collect` | `target, quantity` | Collect items by mining nearby blocks. |
| `craft` | `target, quantity` | Craft items using available materials. |
| `give` | `item, target` | Give items to a player. |
| `place` | `target, x, y, z` | Place a block at coordinates. |
| `equip` | `target` | Equip an item from inventory. |
| `eat` | `target` | Eat a food item. |
| `smelt` | `target, quantity` | Smelt items in a furnace. |
| `kill` | `target, quantity` | Hunt and kill entities. |
| `sleep` | — | Sleep in a nearby bed. |
| `brew` | `potion` | Brew a potion. |
| `enchant` | `target` | Enchant an item. |
| `explore` | `direction, distance, target` | Explore in a direction, optionally scanning for a structure. |
| `navigate_portal` | `target: "nether"\|"end"` | Find and enter a portal. |
| `activate_end_portal` | — | Insert Eyes of Ender and activate the End portal. |
| `place_pattern` | `target, x, y, z` | Place a named block pattern. |
| `status` | — | Report position, health, and environment. |
| `stop` | — | Cancel all active goals. |

## Waypoint System

The bot maintains a persistent waypoint file at `data/waypoints.json`. Each entry stores:
```json
{ "name": "base", "x": 100, "y": 64, "z": 200, "dimension": "overworld" }
```

**Adding waypoints:**
- Via action: `{ "action": "add_waypoint", "name": "my_base" }`
- Manually edit `data/waypoints.json`

**Using waypoints:**
- `{ "action": "goto", "target": "my_base" }` — navigates there, crossing dimensions if needed.

Dimensions: `overworld`, `the_nether`, `the_end`.

## AI Debugging (WSL/Local CLI)

If you are an AI agent (like geminiCLI) running in a WSL environment or interacting with the system locally, **do not** run testing commands or the bot directly in the shell as the high volume of stream output can crash your session.
Instead:
1. **Execution:** Execute all commands via Windows PowerShell.
2. **Logs:** Read from `bot_system.log` instead of standard output.
3. **State Tracking:** Read the `ai_debug.json` file. It updates every 5 seconds with the bot's current timestamp, health, coordinates, and action queue to detect if the bot is stuck or running in place.
4. **Vision/Memory:** Use the `dump_chunks` command in-game, then read `chunk_dump.json` to see exactly what blocks the bot's internal memory has loaded.

## Recording the Bot's Perspective

There is no built-in screen recorder, but there are two practical approaches:

1. **OBS Studio (recommended):** Add a "Game Capture" or "Window Capture" source pointed at the Minecraft window. This records exactly what the client renders, including the bot's POV if you spectate it (`/spectate <botName>`).

2. **ReplayMod (Forge mod):** Install [ReplayMod](https://replaymod.com/) on the Forge client. It records the full session from any spectated angle and lets you render it afterwards. It works with Forge 1.20.1.

> **Note:** The bot itself runs headlessly via Node.js (no rendered client). To record visually, you must spectate the bot from a separate Minecraft client and capture that window.

---
*Note: This framework is optimized for reliability on vanilla blocks within a Forge environment. Modded block entities are treated as non-solid by default to ensure safe gravity and movement.*
