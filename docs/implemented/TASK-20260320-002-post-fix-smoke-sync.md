# TASK-20260320-002-post-fix-smoke-sync

## Goal
- Run `npm test`, and if it passes update docs/core/STATE.yaml smoke_status and add a one-line ACTIVITY_SUMMARY entry for the race-condition fix, then commit.

## Inputs
- Operator request: run npm test; if passing, update STATE.yaml smoke_status.last_run to 2026-03-20 and smoke_status.result to "passed (6 test files)"; append one line to docs/core/ACTIVITY_SUMMARY.md summarising "Fixed EXECUTE_ACTION race condition: await isExecuting before starting new action queue | src/bot_actuator.js --claude --BUGFIX-20260320-002"; commit with message "TASK:TASK-20260320-001 docs: post-fix smoke sync"
- Relevant files: docs/core/STATE.yaml, docs/core/ACTIVITY_SUMMARY.md, package.json

## Constraints
- Do not modify any src/ files
- Do not modify any test files
- Only update docs/core/STATE.yaml and docs/core/ACTIVITY_SUMMARY.md

## Prohibited paths
- `data/raw/`
- `src/`
- `tests/`

## Execution mode
- `local`

## Deliverables
- docs/core/STATE.yaml with smoke_status.last_run: "2026-03-20"
- docs/core/ACTIVITY_SUMMARY.md with new entry for BUGFIX-20260320-002
- git commit with message containing "post-fix smoke sync"

## Validation commands
- `npm test`
- `grep "2026-03-20" docs/core/STATE.yaml`
- `grep "BUGFIX-20260320-002" docs/core/ACTIVITY_SUMMARY.md`

## Success criteria
- npm test exits 0
- STATE.yaml smoke_status.last_run equals "2026-03-20"
- ACTIVITY_SUMMARY.md contains BUGFIX-20260320-002

## Retry policy
- max_attempts: 2
- retry_when:
  - npm test fails transiently
- do_not_retry_when:
  - src/ files need modification to pass tests

## Blockers
- none
