# ProjectBase

This archive is a reusable bootstrap repository for agent-driven projects.

## Intended flow
1. Unzip.
2. Rename the root folder and update `project_name` / `project_short_name` in `docs/core/STATE.yaml`.
3. Replace the placeholder goal in `docs/core/GOAL.md`.
4. Add project-specific sample data under `data/sample/`.
5. Start Terminal Keeper. The default session starts Docker and then opens an AI launch menu so you can choose `none`, `gemini`, or `claude` instead of always auto-starting both agents.
6. For repositories that need multi-step implementation, validation, and repair loops, invoke the bundled `gemini-orchestrator` skill and customize the proposed validation task before relying on autonomous completion.

## What is intentionally *not* included
- application code
- project-specific smoke scripts
- Kaggle / Colab / training helpers
- Legacy CLI integration

Those items should be added only after the concrete project requirements are known.

## Included bootstrap additions
- optional selector-based Claude / Gemini startup
- a reusable `gemini-orchestrator` skill package under `.claude/skills/`
- generic runtime helpers under `scripts/orchestrator/`
- documentation for orchestration policy and execution modes

## Recommended first customizations
- complete `docs/proposed/TASK-20260303-002-customize-project-identity.md`
- complete `docs/proposed/TASK-20260303-003-define-project-verification.md`
- complete `docs/proposed/TASK-20260311-002-bind-project-validation-to-orchestrator.md`
