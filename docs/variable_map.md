# variable_map

## System Environment Variables
| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `MC_HOST` | `localhost` | Minecraft server address. |
| `MC_PORT` | `25565` | Minecraft server port. |
| `BOT_NAME` | `AI_Bot_01` | Bot username. |
| `MC_CONFIG_DIR` | `./data/sample/configs` | Path to server TOML configuration files for RAG. |
| `BOT_ID` | `Bot` | (Internal) ID of the bot process used in `bot_actuator.js`. |
| `BOT_OPTIONS` | `{}` | (Internal) JSON string of options passed from `AgentManager` to `bot_actuator.js`. |

## Bot Actuator Configurations
| Feature | Parameter | Value/Behavior |
| :--- | :--- | :--- |
| Version | `version` | `1.20.1` |
| Handshake | `host` suffix | `\0FML3\0` (required for FML3 handshake trigger) |
| Max Packet | `maxPacketSize` | `10485760` (10MB) |
| Pathfinding | `canDig` | `true` |
| Pathfinding | `allowSprinting` | `true` |
| Pathfinding | `allowParkour` | `true` |
| Middleware | `EventDebouncer` | `500ms` |
| Middleware | `InventoryNBTPatch` | Global `stackSize` set to `2147483647`. |

## Agent Manager IPC Schema
| Message Type | Fields | Purpose |
| :--- | :--- | :--- |
| `ERROR` | `category`, `details` | Triggers the recovery pipeline in `AgentManager`. |
| `LOG` | `data` | Logs child process activity to the main console. |
| `command` | `command: 'inject_dummy_block'` | Injects a placeholder block into the registry to prevent crashes. |
