# TASK-20260409-004: Experimental World Exhaustive Validation

## Summary

Execute full end-to-end validation of all generated experimental zones using direct action API control, collect evidence, and identify any remaining runtime defects under real Forge + bot integration.

## Scope

1. Validate runtime prerequisites:
   - Forge container healthy
   - Bot container healthy
   - Bot online via WebUI API

2. Run zone-by-zone action coverage against generated world:
   - Zone 1 bridge traversal
   - Zone 2 maze traversal
   - Zone 3 break-yard block breaking
   - Zone 4 item-range interaction
   - Zone 5 mineall behavior
   - Zone 6 craft/smelt hub operations
   - Zone 7 durability lane repeated tool use
   - Zone 8 jetpack hill vertical movement
   - Zone 9 combat arena hostile combat

3. Gather evidence:
   - API responses for action dispatch
   - bot status snapshots
   - bot log entries indicating success/failure/timeouts

4. If defects are found:
   - Implement minimal code fixes
   - Re-run only affected validation segments

## Constraints

- No world carry-over assumptions: validate against fresh generated world behavior.
- Prefer direct `/api/bots/:id/actions` for deterministic execution.
- Keep changes minimal and reversible.
- Do NOT pre-provision all intermediate crafting materials for test success.
- Allow only minimal initial-material assumptions; all follow-up materials must be obtained by instruction-driven behavior during the test.
- If runtime is too long, support zone sharding across multiple server stacks for parallel execution.

## Validation Plan

- Runtime checks:
  - `docker ps` / equivalent container status
  - `GET /api/bots`
- Action execution:
  - `POST /api/bots/:id/actions` with `queue_op` control
- Evidence collection:
  - `GET /api/bots/:id/log`
  - `GET /api/bots` status snapshots

## Exit Criteria

- All zones have at least one representative action run with evidence.
- Any blocking failure is either fixed and retested, or reported with reproducible traces.
