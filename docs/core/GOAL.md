# Minecraft Forge 1.20.1 AI Player System Architecture and Implementation Specification

Note: Documents such as MASTER_GUIDANCE are designed for ML. They are not intended for mod development, so the directory structure can be overwritten by GOAL.md and user instructions.

## 1. Overview and Problem Statement
This document defines the technical specifications for an autonomous AI player framework using Mineflayer and Large Language Models (LLM) within a Minecraft 1.20.1 (Forge) environment. Standard Mineflayer architectures designed for Vanilla environments cannot process the strict protocol requirements and dynamic data structures of Forge. Specifically:
* **FML3 Handshake**: Modern Forge environments require FML3 (Forge Mod Loader) handshake packets that standard libraries (node-minecraft-protocol) do not support.
* **Dynamic Registries**: 1.20.1 Forge servers use dynamic registry synchronization that causes packet parsing errors in standard clients.
* **Modded Physics**: Vanilla libraries cannot account for mod-specific logic like "Vein Miner" asynchronous updates or "Create Mod" dynamic entities (Contraptions).

## 2. System Pipeline and File Configuration
The system utilizes a distributed processing model split between an **Agent Manager** (main process) and **Bot Actuators** (isolated child processes).

### Core File Definitions
| Filename | Layer | Primary Responsibility |
| :--- | :--- | :--- |
| `forge_handshake_state_machine.js` | Protocol Bridge | Intercepts socket communication to spoof/translate FML3 S2C and C2S packets. |
| `dynamic_registry_injector.js` | Data Injector | Parses dynamic registries during handshake and injects unknown block/item definitions into the `bot.registry` object. |
| `event_debouncer.js` | Middleware | Monitors asynchronous block updates (e.g., VeinMiner) and delays LLM callbacks until terrain synchronization is complete. |
| `inventory_nbt_patch.js` | Middleware | Overrides the default 64-item stack limit by parsing NBT tags for storage mods. |
| `create_contraption_hazard.js` | Middleware | Parses NBT for Create Mod Contraptions to set infinite-cost zones in A* pathfinding. |
| `config_rag_parser.js` | Context Integration | Parses server `.toml` configs into an AST to inject physical constraints into the LLM system prompt. |
| `agent_manager.js` | Orchestrator | Manages isolated bot processes via `child_process` to protect the system from stack overflows. |

## 3. FML3 Protocol Bridge Implementation
The bridge acts as a transparent proxy. It appears as a Vanilla server to the bot instance while acting as a legitimate Forge client to the remote server.

### Handshake Functions
* **`handleServerHello(packet)`**: Extracts the FML protocol version (FML3) and updates the internal state to `HELLO_RECEIVED`.
* **`sendClientModList(packet)`**: Analyzes the server's mod list and generates a matching spoofed response including mandatory `minecraft` and `forge` entries.
* **`acknowledgeRegistrySync(packet)`**: Extracts mapping tables between numerical IDs and namespaces (e.g., `create:andesite_alloy`) into a `registrySyncBuffer`. It must return an indexed acknowledgment to avoid timeouts.

## 4. Dynamic Registry Injector
The injector intervenes just before world data loads to modify the `bot.registry` (prismarine-registry) in memory.
* **`parseRegistryPayload`**: Extracts ID mappings from the proxy buffer.
* **`injectBlockToRegistry`**: Generates object schemas for unknown mod blocks. Since physical properties (hardness, transparency) aren't sent during handshake, it applies heuristic defaults (Hardness: 1.0, Diggable: true, BoundingBox: "block").

## 5. Middleware and Mod Control
### VeinMiner Synchronization
`event_debouncer.js` implements a 500ms debounce timer. It transitions the bot to a `CASCADING_WAIT` state during mass destruction events, preventing the bot from attempting to move onto non-existent terrain.

### Storage Mod NBT Patching
`inventory_nbt_patch.js` applies two patches:
1.  **Global Override**: Sets `stackSize` for all items to the Java 32-bit integer maximum ($2147483647$) to bypass internal 64-limit checks.
2.  **NBT Interception**: Extracts the "true total" count from mod-specific NBT metadata to provide accurate context to the LLM.

### Create Mod Contraption Avoidance
`create_contraption_hazard.js` overrides the A* heuristic in `mineflayer-pathfinder`.
* **Exclusion Sphere**: Calculates a hazard radius based on the contraption's `BoundsFront` and `BoundsBack` NBT data.
* **Cost Intercept**: If a node falls within the Exclusion Sphere, the movement cost is set to `Infinity`.

## 6. LLM Context and Resource Management
* **RAG Pipeline**: `config_rag_parser.js` extracts limits (e.g., machine stress limits, cooldowns) from server configs and injects them into the LLM system prompt to prevent "hallucinated" commands.
* **Process Isolation**: Each bot runs in a separate `child_process`. This prevents a single bot's pathfinding loop from triggering a `RangeError: Maximum call stack size exceeded` in the Agent Manager.
* **Recovery**: If a process crashes or fails a task, the Agent Manager receives an IPC error code and triggers a recovery pipeline (e.g., re-evaluating the path).

## 7. Error Recovery Profiles
| Error Category | Component | Recovery Pipeline |
| :--- | :--- | :--- |
| Handshake Timeout | `forge_handshake...` | Identify missing channel index, update proxy rules, and restart process. |
| Undefined Reference | `dynamic_registry...` | Catch reference error, inject a dummy "Unknown Block" object into registry at runtime. |
| Stack Overflow | `mineflayer-pathfinder` | Terminate algorithm via hard limit, notify LLM via IPC, and add "Inaccessible Area" rule to prompt. |
| NBT/Payload Error | `inventory_nbt_patch` | Revert to safe default values (1 item) and command the LLM to "re-open inventory" to refresh packets. |
