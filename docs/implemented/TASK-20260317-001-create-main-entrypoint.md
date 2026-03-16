# TASK-20260317-001-create-main-entrypoint

## Goal
Create `index.js` as the main entry point to instantiate the `AgentManager` and start the bot so it can connect to the Forge 1.20.1 server.

## Context
The user wants to know how to start the bot. `package.json` specifies `index.js` as the main script, but it is missing. We need a script that actually starts the `AgentManager` and provides connection details (host, port).

## Tasks
1. Create `index.js` that initializes `AgentManager` and calls `startBot()`.
2. Add support for parsing `.env` or command-line arguments for host/port.
3. Update `docs/core/STATE.yaml` and `docs/core/ACTIVITY_SUMMARY.md`.