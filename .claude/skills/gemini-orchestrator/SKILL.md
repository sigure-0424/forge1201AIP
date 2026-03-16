# gemini-orchestrator

## Purpose

Use this skill when a task needs planning, delegation, validation, and possible repair loops.
The expected operating model is:
- Claude reads shared context and prepares the task
- Gemini executes the implementation work
- the validator decides whether the task may be considered complete

This skill is **not** for trivial one-file edits or tiny utility scripts when the operator intentionally chose a `gemini-only` workflow.

## Required context before use

Before doing anything else:
1. Read everything in `docs/core/`.
2. Read the relevant task spec under `docs/proposed/` or `docs/implemented/`.
3. Confirm that the task has a task-id. If not, create one.
4. Confirm that the execution mode is one of `local`, `cloud`, or `hybrid`.
5. Confirm whether real `validation_commands` exist. If they do not, treat autonomous completion as unavailable.

## Core operating rules

### 1) Plan in Claude, execute in Gemini
Claude owns:
- request decomposition
- task spec creation or refinement
- runtime job creation
- mode selection
- prompt preparation
- post-run evaluation

Gemini owns:
- file edits
- command execution
- logs and status markers
- concrete implementation output

### 2) Keep runtime state out of `docs/core/`
Use:
- `tmp/orchestrator/jobs/<job-id>/`
- `tmp/orchestrator/archive/`

Do not store noisy runtime logs in `docs/core/`.

### 3) Never claim completion from exit code alone
A task is complete only if:
- the requested deliverable exists
- validation passed
- remaining blockers or risks are recorded
- task tracking docs were updated

### 4) Do not force orchestration when it is not justified
Prefer plain Gemini or a normal shell when the job is:
- tiny
- low-risk
- single-step
- not worth a repair loop

## Standard workflow

1. Read the operator request.
2. Map it to an existing task or create a new task spec.
3. Fill the task spec completely using `templates/task_spec.md`.
4. Create a runtime job with `scripts/orchestrator/create_task.py`.
5. Prepare the Gemini prompt using `templates/gemini_prompt.md`.
6. Launch Gemini with `scripts/orchestrator/launch_gemini.sh`.
7. Collect the result with `scripts/orchestrator/collect_result.py`.
8. Run validation with `scripts/orchestrator/validate_task.sh`.
9. If validation fails, decide whether to:
   - requeue the job
   - split the task
   - mark it blocked
   - escalate for missing external input
10. Only after passing validation, update task tracking and prepare the final report using `templates/final_report.md`.

## Task spec minimum fields

Every orchestrated task spec must define at least:
- `task_id`
- `goal`
- `inputs`
- `constraints`
- `prohibited_paths`
- `execution_mode`
- `deliverables`
- `validation_commands`
- `success_criteria`
- `retry_policy`
- `blockers`

## Efficiency rules

- Default to the smallest reversible change.
- Prefer reusing existing docs and scripts over introducing new top-level systems.
- Keep the number of active jobs small unless the task is explicitly parallel-safe.
- If the operator selected `gemini-only`, do not spawn a full orchestrator flow unless verification complexity makes it necessary.

## Completion rule

Do not mark a task `done` when any of the following is true:
- validation commands are undefined
- validation failed
- the output is incomplete
- the runtime status is `needs_clarification`
- blockers remain that prevent the requested deliverable
