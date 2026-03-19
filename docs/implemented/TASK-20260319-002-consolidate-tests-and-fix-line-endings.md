# TASK-20260319-002: Consolidate Test Suite and Fix Line Endings

## Goal
1. Expand `npm test` to run all existing unit and integration tests (currently only E2E runs).
2. Add `.gitattributes` to enforce LF line endings and prevent CRLF drift in WSL/Windows environments.
3. Normalize all source files to LF.

## Definition of Done
- `npm test` runs all test files and all pass.
- `.gitattributes` exists and enforces `* text=auto eol=lf`.
- No CRLF files remain in the working tree after normalization.
- STATE.yaml, ACTIVITY_SUMMARY.md, TASK_INDEX.md updated.

## Implementation
- Added `.gitattributes` with `* text=auto eol=lf`.
- Updated `package.json` scripts.test to run all tests sequentially via node.
- Ran `git add --renormalize .` to normalize line endings.
- Committed changes.

## Result
All tests pass. Line endings normalized.
