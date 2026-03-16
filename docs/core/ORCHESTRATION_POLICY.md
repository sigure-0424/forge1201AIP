# ORCHESTRATION_POLICY

## Purpose

Define the generic orchestration model used by this bootstrap repository when Claude is used as planner/orchestrator and Gemini is used as the execution agent.

## Scope

This policy is intentionally generic. It provides the structure for task creation, runtime bookkeeping, validation, and retry control, but it does **not** define project-specific commands or success metrics.

## When to use the orchestrator

Use the `gemini-orchestrator` skill when all of the following are true:
- the task is multi-step or cross-file
- verification matters more than a one-shot answer
- a repair loop may be needed
- the operator wants Claude to plan and Gemini to execute

Do **not** force this workflow for tiny one-file utilities, quick experiments, or cases where the operator intentionally launched `gemini-only`.

## Role split

### Claude
- read `docs/core/` and existing task specs
- convert the operator request into a task spec with a task-id
- select execution mode (`local`, `cloud`, `hybrid`)
- prepare the Gemini prompt
- evaluate results, validation output, and residual risks
- requeue or close the task

### Gemini
- implement the requested changes
- run the requested commands
- capture logs and write job status markers
- return concrete artifacts and error notes

### Validator
- run project-specific validation commands
- reject completion if required checks are absent or failing

## Runtime paths

- Job directories: `tmp/orchestrator/jobs/<job-id>/`
- Archived runs: `tmp/orchestrator/archive/`
- Static templates: `.claude/skills/gemini-orchestrator/templates/`
- Generic scripts: `scripts/orchestrator/`

## Minimal job state model

Expected statuses:
- `queued`
- `running`
- `needs_clarification`
- `failed`
- `validated`
- `done`

## Completion gate

A task may be marked complete only when:
1. required files were produced or modified as requested
2. all declared validation commands passed
3. unresolved blockers and risks are recorded
4. `docs/core/ACTIVITY_SUMMARY.md` and `docs/core/TASK_INDEX.md` were updated when the change is meaningful

## Customization points required for real projects

Before using autonomous repair loops on a real project, customize at least:
- `validation_commands`
- protected paths / prohibited paths
- data access policy
- execution mode defaults
- any project-specific smoke command recorded in `STATE.yaml`
