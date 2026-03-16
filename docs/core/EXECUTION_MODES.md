# EXECUTION_MODES

## local

Use `local` when the task depends on:
- local-only data
- mounted secrets or private files
- local GPU / Docker state
- direct inspection of the current working tree

## cloud

Use `cloud` when the task is primarily code editing against repository content that already exists in a remote environment and does not require private local assets.

## hybrid

Use `hybrid` when implementation can happen remotely but validation or data access must happen locally.

## Selection rules

1. Prefer `local` when validation depends on `data/sample/`, local Docker, or a local GPU.
2. Prefer `cloud` only when the task can be reproduced from repository state alone.
3. Prefer `hybrid` when the cheapest split is remote implementation plus local verification.
4. If the operator started a `gemini-only` session for a tiny task, do not escalate to the full orchestrator unless the task becomes multi-step or high-risk.

## Safety rules

- Never assume project-specific validation exists; check first.
- Never mark `cloud` safe for tasks involving local private data without an explicit project policy.
- If the execution mode is uncertain, default to the smallest reversible path and record the choice.
