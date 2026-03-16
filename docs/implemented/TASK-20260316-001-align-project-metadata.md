# TASK-20260316-001-align-project-metadata

## Objective
Update the generic template metadata in `STATE.yaml` and `README.md` to reflect the actual project goals defined in `docs/core/GOAL.md` (Minecraft Forge 1.20.1 AI Player System Architecture).

## Scope
- Update `project_name` and `project_short_name` in `docs/core/STATE.yaml`.
- Update `current_goal` in `docs/core/STATE.yaml` to match `docs/core/GOAL.md`.
- Ensure `docs/core/TASK_INDEX.md` reflects this new task as active.

## Rationale
The current repository was bootstrapped from a template, and `STATE.yaml` still contains placeholder values ("RENAME_ME_PROJECT") and the generic template goal, which conflicts with the actual system architecture defined in `docs/core/GOAL.md`.

## Execution Mode
`local`
