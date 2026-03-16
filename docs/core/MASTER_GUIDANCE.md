# MASTER_GUIDANCE (English, Agent-Readable, Final v6)

This document is the **single canonical operating protocol** for all agents (Claude / Gemini) across any threads/terminals.
Its goal is to minimize duplicate work, unexplainable changes, environment drift, Kaggle code mix-ups, log noise, and transient lock/sync failures.

---

## 0) Current “Finished Deliverable” (must be in context)

Treat the repository as already migrated to the following “current finished shape”.
At session start, you MUST reference these artifacts. If something is missing, report it as missing. Do not redesign the system unilaterally.
To prevent unexpected errors, please use UTF-8. Do not include a BOM.
### 0.1 Shared context (mandatory `docs/core`)

`docs/core/` is the **core context directory**. **Before any reasoning or implementation, you MUST read everything in `docs/core/`.**

**Core files that must exist** (minimum expected set):

* `docs/core/STATE.yaml` (single source of truth, machine-readable)
* `docs/core/GOAL.md` (top-level goal; STATE must not contradict it)
* `docs/core/MASTER_GUIDANCE.md` (this file, canonical for agents)
* `docs/core/MASTER_GUIDANCE.ja.md` (Japanese reference)
* `docs/core/TASK_INDEX.md` (active/completed task index)
* `docs/core/ACTIVITY_SUMMARY.md` (implementation log: what/where/by whom)
* `docs/core/KNOWLEDGE_BASE.md` (condensed knowledge, anti-regression)
* `docs/core/DECISIONS/` (ADRs: “why”)
* `docs/core/LOGS/` (full transcripts; not always-read outside the initial core scan)

**Core hygiene rule (to keep “read everything” feasible):**

* `docs/core/` MUST remain small and curated.
* Long histories, one-off notes, or bulky documents MUST live outside core (e.g., `docs/history/`) and be linked from core if needed.

### 0.2 Startup automation (Terminal Keeper + WSL)

`.vscode/sessions.json` MUST start wrappers (not raw CLIs).

**Default startup SHOULD be:**

* `scripts/tk_ensure_docker.sh`
* `scripts/tk_start_ai_session.sh`

The default session MUST ask before launching Claude/Gemini so the operator can choose `none`, `gemini`, or `claude` without paying the cost of always starting both agents.

**Direct-start sessions MAY additionally call:**

* `scripts/tk_start_claude.sh`
* `scripts/tk_start_gemini.sh`

### 0.3 Docker (always-on, repo mounted, CUDA GPU required)

`docker/compose.yaml` runs a dev container that mounts the repo and MUST always request the NVIDIA CUDA GPU (equivalent to `--gpus all` or the Compose GPU device reservation).

* CPU-only startup is not allowed by default.
* If CUDA/NVIDIA runtime is unavailable, startup MUST fail fast rather than silently falling back to CPU.
* Any temporary CPU-only exception MUST be explicitly documented in the task spec or ADR.

Startup is idempotent (already running => no-op).

> Everything in section 0 is the baseline shared assumption for all sessions.

---

## 1) Non-negotiables

1. At session start, you MUST read **everything in `docs/core/`**.
2. Shared context is a **3-layer model**:

   * **STATE**: always-read, short
   * **DECISIONS (ADR)**: rationale (“why”)
   * **LOGS**: full transcripts (“what was said”), referenced when needed
3. Notebooks (Kaggle/Colab) MUST be thin: setup + `!python -m ...` only. All logic lives in `src/`.
4. Verification MUST prioritize **Docker + `data/sample` smoke** (agent-runnable minimal path).
5. After each meaningful change: **git commit + sync (push)** to preserve easy rollback.
6. Reduce log noise: suppress unavoidable warnings and avoid overly verbose logs by default.
7. Transient failures from concurrency/sync (file locks, permission denied) MUST be handled via **wait / switch tasks / retry** (see section 7).

---

## 2) BOOT protocol (agent)

On startup, do the following (wrappers should automate the initial prompt, but you must comply regardless):

1. Read `docs/core/STATE.yaml` and `docs/core/GOAL.md` and **report `current_goal` and `active_tasks` by quoting STATE fields only** (no invention).
2. If `active_tasks` is empty:

   * list `docs/proposed/`
   * select the best next task and START it
   * if no suitable proposal exists, CREATE a new task spec (`TASK-YYYYMMDD-###-slug.md`) and START it

   NOTE:
   - In normal mode, you MAY present the selection rationale.
   - In No-Confirm Mode, you MUST NOT ask "what next?" and MUST proceed autonomously.
3. All work MUST be tied to a task-id.

---

## 2.2 Startup banner (SYSTEM-SIDE ONLY; not an agent task)

The startup banner is a **system feature** (Terminal Keeper / shell wrappers), not an agent responsibility.
Do NOT treat “print the banner” as a task.

### Banner content (project name)

* The banner displays the **project name**.
* If the project name is long, it must be abbreviated without ambiguity.

**Recommended source of truth:**

* `docs/core/STATE.yaml` contains `project_name` and `project_short_name`.
* If `project_short_name` exists, display it.
* Otherwise abbreviate `project_name`:

  * keep ~16–24 characters
  * prefer word boundaries (`-`, `_`, spaces)
  * append `…`

After the banner, the system prints:

* `PROTOCOL_VERSION` (from STATE.yaml)
* `GIT_COMMIT_SHA` (`git rev-parse --short HEAD`)
* `WORKSPACE` (WSL/Docker/Kaggle)

---

## 3) No-Confirm + Auto-Continue Mode (“No approval required”)

If the operator explicitly states like**「No approval required」** (No-Confirm Mode), then from that point in the session:

* Execute **all changes**, **all commands**, and **all policy shifts** without asking for approval.
* AUTONOMOUSLY choose and execute the next action(s) until the termination gate is met.
* Do not interrupt or stop until the termination conditions are met.

### 3.1 Hard ban: no “what next?” questions

From the moment No-Confirm Mode is enabled:

* DO NOT ask the operator what to do next.

  Examples of forbidden prompts:

  * "What should I do next?"
  * "Should I proceed?"
  * "Which option do you prefer?"
  * "Do you want me to continue?"

You MUST instead decide and proceed using the policies below.

### Minimal exceptions

* Only when a tool/OS physically requires confirmation (auth prompts, key entry).
* Never violate hard repo prohibitions (e.g., do not modify `data/raw`).

### 3.2 Ambiguity policy (how to decide without asking)

When information is missing or multiple paths are viable:

1. Prefer actions that are:

   * reversible (easy to revert via git)
   * minimal-scope
   * aligned with GOAL + STATE
   * and unblock verification (Docker + data/sample smoke)

2. If multiple viable options remain, choose the highest expected value option.
3. Record assumptions/choices in `ACTIVITY_SUMMARY.md` and, if material, an ADR.
4. If a decision would be irreversible/high-risk, choose a safe, reversible alternative (e.g., stub + TODO + task split) and continue.

### 3.3 Continuous execution loop (default behavior)

In No-Confirm Mode you should behave as if running this loop:

* Read `docs/core/` (required)
* Pick current task from `STATE.active_tasks`; else from `docs/proposed/`; else create a new task
* Implement + verify (Docker + data/sample smoke)
* Commit + sync; update `ACTIVITY_SUMMARY.md` / `STATE.yaml` / ADR as required
* Move to the next task automatically

### 3.4 Termination gate (the ONLY allowed stop conditions)

You may stop ONLY when one of the following is true:

1. DONE: You reached Definition of Done for the current task AND there are no remaining active tasks AND no further work is implied by GOAL/STATE.
2. OPTIMAL: You reached the best achievable solution under current constraints and further changes would be churn or regression risk.
3. BLOCKED: Further progress is impossible without external input/authorization/tooling that is not available (e.g., credentials prompt, missing private dataset, permissions).

If BLOCKED, DO NOT ask the operator what to do next. Output a BLOCKED report and stop.

BLOCKED report format:

* Blocker: (one sentence)
* Evidence: (errors/log lines/commands)
* Attempted mitigations: (what you tried)
* Best next action (recommended): (one actionable step)
* Fallback options: (2–3 alternatives, ranked)

### Recording duties still apply

Even in No-Confirm Mode:

* commit + sync per meaningful change
* update `ACTIVITY_SUMMARY.md`
* for material decisions: update `STATE.yaml` and/or add an ADR in `DECISIONS/`

---

## 4) Git policy: commit + sync per change

### Rules

* Commit per meaningful unit; avoid large “misc” commits.
* After each commit, sync/push. Do not leave critical work only locally.
* Prefer smaller commits if uncertain.

### Recommended commit message format

`TASK:<task-id> <type>: <short summary>`

* `<type>`: `feat|fix|refactor|docs|test|chore`

### Required doc updates on code/spec changes

If you modify `src/**`:

* update `docs/core/ACTIVITY_SUMMARY.md`
* update `docs/variable_map.md` **if variables/specs change**
* for important decisions: add `docs/core/DECISIONS/ADR-...` or update `STATE.yaml`

---

## 5) Kaggle/Notebook: prevent stale code usage

### Notebook must be thin

Notebook is a launcher:

* path setup
* `!python -m <package> ...`

No business logic inside notebooks.

### Mandatory version cell (print every run)

Each notebook must print:

* `NOTEBOOK_VERSION` (manual increment, e.g. `v0.7`)
* `PROTOCOL_VERSION` (from STATE.yaml)
* `GIT_COMMIT_SHA` (short SHA)
* `DATASET_VERSION` (Kaggle input name/date)

Rule:

* Increment `NOTEBOOK_VERSION` on every meaningful notebook change.
* Always print `GIT_COMMIT_SHA` so Kaggle runs can’t silently use older code.

---

## 6) Logging policy: reduce noise

### Rules

* Default level: INFO (no DEBUG by default)
* Suppress recurring environment warnings when safe, but do not blanket-disable all warnings.
* Prefer short, structured logs.

### Recommended controls

* Provide `--quiet` / `--verbose` flags:

  * `--quiet`: minimal INFO, suppress known warning noise
  * `--verbose`: enable DEBUG, show warnings
* Smoke runs should emit only: success/failure, cause, next action.

---

## 7) Transient lock/sync failures (concurrency, Google Drive, etc.)

When multiple agents run concurrently or cloud sync locks files, you may see:
`Permission denied`, `Access is denied`, `Text file busy`, `Device or resource busy`, etc.

Treat these as **transient**, not permanent.

### Mandatory procedure

1. **Bounded retry**: wait briefly (2–10s) and retry up to 3 times.
2. If still failing, **switch tasks**:

   * do read-only work first (design notes, ADR draft, task split, test planning, log cleanup)
   * pick a task that doesn’t touch the locked files
3. Retry later (30–120s).
4. If still failing:

   * check `tmp/locks/` for task locks
   * consider drive sync/editor locks; wait for sync completion
   * split tasks to avoid concurrent writes to the same files

### Lock alignment

* Any write-heavy work should respect `tmp/locks/<task-id>.lock`.
* If you cannot acquire the lock, follow the procedure above (switch tasks, retry later).

---

## 8) Docker + `data/sample` smoke (agent-runnable minimal verification)

* Smoke verifies dependencies, I/O, core paths, and CUDA GPU visibility inside Docker quickly.
* `data/sample/` MUST be committed and always available.
* The smoke path MUST include a GPU check inside the container (for example, `nvidia-smi` and/or a framework-level check such as `torch.cuda.is_available()`), and MUST fail if Docker cannot access the CUDA GPU.
* Record smoke results into `STATE.yaml` as `smoke_status` (date/command/result).

---

## 9) Definition of Done

A task is DONE only if:

1. Task spec exists (moved from proposed → implemented)
2. Docker + `data/sample` smoke passes (record command + result in STATE/ADR)
3. `ACTIVITY_SUMMARY.md` updated
4. Material decisions captured in an ADR
5. Notebook remains thin (no logic drift into notebooks)

---
---

## 10) Long-running jobs, timeouts, and high-cost resources (DEFAULT: forbidden)

### 10.1 Timeout-aware execution for long runs
Model training/inference can exceed interactive timeouts (agent session, terminal, CI, notebook runtime).
When a run is expected to take long:
- Use a background-capable terminal/session (e.g., tmux/screen/nohup, or a dedicated background Terminal Keeper terminal).
- Prefer checkpointing and resumable runs (avoid “single huge run”).
- Before starting: ensure the repo is clean, commit+sync, and record the exact command to be executed (STATE/ADR/LOGS).

### 10.2 Local Docker/WSL freeze or OOM recovery (auto-recover)
If local Docker/WSL freezes (often OOM or runaway processes):
- Treat it as a reliability event and recover quickly rather than “waiting forever”.
- Use OS-level kill/restart commands as needed (example patterns):
  - Windows: `taskkill /F ...` for the stuck process, then restart Docker/WSL
  - WSL: `wsl.exe --shutdown` (if required) and relaunch
  - Linux-side: `pkill -9 ...`, `docker kill ...`, `docker compose down/up -d`
- Prefer an automated recovery procedure/script in your environment (idempotent restart), so agents can restore the workspace without manual GUI steps.
- After recovery: rerun the minimal smoke path (Docker + data/sample) before continuing work.

### 10.3 High-cost resource usage is forbidden by default (permission required)
Using expensive/fragile resources is **FORBIDDEN by default** because it increases cost and failure modes.

This restriction does not prohibit the standard local Docker development/smoke path that uses the local CUDA GPU as required by sections 0.3 and 8.

This includes (non-exhaustive):
- Full-scale training on large datasets as part of routine iteration
- Long GPU runs without checkpoints/resume
- Cloud GPU/HPC usage, paid services, large-scale sweeps
- Google Colab “remote execution pipelines” (e.g., SSH/tunnels to push code, execute remotely, pull results)

**Exception:** If the operator explicitly permits it, then:
- Create an ADR describing the permission scope (what/why/cost/time limit) and link the command(s).
- Record the approval + run metadata in STATE/ACTIVITY.
- Enforce hard limits (time/steps), checkpointing, and resumability.

### 10.4 Google Colab SSH workflows (DEFAULT: forbidden)
Starting SSH (or tunnels) in a Colab notebook to push updated code, execute remotely, and return results is **forbidden by default**.
If explicitly permitted:
- Keep notebooks thin (launcher-only).
- Transfer only necessary artifacts.
- Do not expose secrets/tokens; redact logs and configs if needed.
- Record the exact workflow and commands in ADR/LOGS for reproducibility.

## Changelog

* v6:

  * Added Auto-Continue contract to No-Confirm Mode: forbids "what next?" questions, defines ambiguity policy, continuous execution loop, and termination gate + BLOCKED report.
  * BOOT: removed "propose" behavior in No-Confirm Mode; agent must select and start a task.

* v5:

  * Restored strict requirement: **read everything in `docs/core/` before any work**.
  * Restored/explicitly required `GOAL.md` in core context.
  * Restored requirement: update `docs/variable_map.md` when variables/specs change.
  * Kept v4 additions: No-Confirm Mode, commit+sync discipline, notebook version/SHA, log noise reduction, project-name system banner, transient lock handling.
