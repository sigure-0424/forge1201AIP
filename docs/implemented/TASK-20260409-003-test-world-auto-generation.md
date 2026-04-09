# TASK-20260409-003: Test World Auto Generation for Forge Bot Validation

## Summary

Implemented an automated test-world generation path for the Forge server and validated it end-to-end with Docker + bot integration.

## Changes

1. Added server-side zone generator:
   - `aux_mod/src/main/java/com/forgeaip/auxmod/TestWorldGenerator.java`
   - Reads `forgeaip_registry.json` and builds 9 test zones around spawn.
   - Uses mod block candidates by namespace for bridge/maze/break tests.
   - Applies slab-bottom placement for slab blocks when used as bridge tiles.
   - Adds safety filtering to exclude risky block classes (copycat/controller/block-entity) to avoid world-save exceptions.
   - Writes world-scoped marker: `world/forgeaip_testworld_generated.marker`.

2. Added clean world startup behavior in Docker:
   - `docker/forge-server/compose.yaml`
   - New startup wipe path controlled by `RESET_WORLD_ON_BOOT` (default enabled).
   - Clears `world`, `world_nether`, `world_the_end`, and `dimensions` before boot.

3. Added direct queued `-goto` command support:
   - `src/bot_actuator.js`
   - Parses `-goto x y z` directly from chat without LLM round-trip.
   - Supports relative tokens like `~`, `~5`, `~-3`.
   - Appends action to queue (append semantics) for command-block burst compatibility.

4. Container runtime hardening for bot integration:
   - `docker/bot.Dockerfile`: Node base image updated to `node:22-slim`.
   - Regenerated `package-lock.json` via `npm install` for `npm ci` consistency.
   - `docker/forge-server/compose.yaml`:
     - Health check fixed to support current server port behavior.
     - Bot-side `MC_PORT` aligned to `25566`.
     - Forge server host port publishing removed to avoid host port conflicts.

5. Bot stability fix against modded chat parser crash:
   - `src/bot_actuator.js`
   - Suppresses known non-fatal `minecraft-protocol/src/client/chat.js` undefined-read exception to prevent restart loops.

## Validation

1. `aux_mod` build:
   - `cd aux_mod && ./gradlew.bat build`
   - Result: success.

2. Node regression tests:
   - `npm test`
   - Result: 6/6 pass.

3. Docker stack validation:
   - `docker compose -f docker/forge-server/compose.yaml config`
   - Result: success.

4. Live server generation evidence:
   - Forge log includes:
     - `[TestWorldGenerator] Generated all zones around spawn ...`
     - `[BlockRegistryExporter] Registry written to /data/forgeaip_registry.json ...`
   - Marker exists:
     - `E:/forge1201server/world/forgeaip_testworld_generated.marker`
   - Registry timestamp refreshed:
     - `E:/forge1201server/forgeaip_registry.json`

5. Bot integration evidence:
   - `forgeaip-bot` container reaches handshake completion and applies authoritative registry.
   - Previous chat parser crash loop is suppressed and process remains running.

## Notes

- `forgeaip-bot` currently warns about missing `OLLAMA_URL`/`OLLAMA_API_KEY` in Docker environment. This does not block handshake or world-generation verification, but LLM task execution needs these variables set.
