# PROJECTSTART_MANUAL (v2)

Bootstrapping guide for a **brand-new repository** so multiple agents (Claude / Gemini) can operate with shared context and reproducible verification.

**Assumption:** The empty repo initially contains only:

* `GOAL.md` (final goal)
* `MASTER_GUIDANCE.md` (agent protocol)

Optionally, the repo may include private reference materials (e.g., non-public API docs).

**Bootstrap scope (this manual):**

* Create `Terminal Keeper` startup (`.vscode/sessions.json`) **that starts wrappers only**.
* Default startup should use an agent selector wrapper so Claude/Gemini are not always started automatically.
* Create the required folder structure.
* Move `GOAL.md` and `MASTER_GUIDANCE.md` into the correct place.
* Create all “docs we can write now” (STATE/TASK_INDEX/etc.).
* **Create wrappers with maximum-permission flags for ALL agent CLIs**.
* **Do NOT** implement application code yet (no `src/` logic).

---

## 0) Pre-flight checklist

### Required tools

* Git
* WSL (Windows) and a POSIX shell (bash)
* Terminal Keeper VS Code extension (if you use Terminal Keeper)
* Docker Desktop / Docker Engine (recommended for reproducible smoke)
* Agent CLIs (as needed): `claude`,`gemini`

### Bootstrap principles

* Keep `docs/core/` **small and curated** (agents must read everything in it).
* Put bulky/private references into `docs/references/` and link from `docs/core/KNOWLEDGE_BASE.md`.
* After each meaningful step: **commit + sync (push)**.

---

## 1) Create the fixed directory layout

Create these directories (minimum):

```text
.vscode/
scripts/
docker/
docs/
docs/core/
docs/core/DECISIONS/
docs/core/LOGS/
docs/proposed/
docs/implemented/
docs/references/
notebooks/
data/
data/raw/
data/processed/
data/sample/
results/
analysis/
tmp/
tmp/locks/
```

**Notes**

* `data/raw/`, `data/processed/`, `results/`, `tmp/` are usually gitignored.
* `data/sample/` should be **committed** (tiny dataset for smoke/CI).

Commit+sync.

---

## 2) Move initial docs into `docs/core/` and keep root stubs

### 2.1 Move files

Move your initial files:

* `GOAL.md` → `docs/core/GOAL.md`
* `MASTER_GUIDANCE.md` → `docs/core/MASTER_GUIDANCE.md`

### 2.2 Create root stubs (thin pointers)

Re-create these at repo root as **link-only stubs** (do not duplicate content):

**Root `GOAL.md` stub:**

```md
# GOAL (stub)
Canonical file: docs/core/GOAL.md
```

**Root `MASTER_GUIDANCE.md` stub:**

```md
# MASTER_GUIDANCE (stub)
Canonical file: docs/core/MASTER_GUIDANCE.md
```

Commit+sync.

---

## 3) Create the `docs/core/` minimum set (write what’s possible now)

### 3.1 `docs/core/STATE.yaml` (initial)

Create with at least:

```yaml
protocol_version: v1
project_name: "<Your Project Name>"
project_short_name: "<Short Name (optional)>"
current_goal: "<1–2 line summary from GOAL.md>"
active_tasks: []
recent_changes: []
decisions_index: []
smoke_status:
  last_run: null
  command: null
  result: null
hazards: []
```

### 3.2 `docs/core/TASK_INDEX.md` (empty index)

```md
# TASK_INDEX

## Active
- (none)

## Completed
- (none)
```

### 3.3 `docs/core/ACTIVITY_SUMMARY.md` (empty log)

```md
# ACTIVITY_SUMMARY

Format:
- [summary] | [paths] --[agent-id] --[task-id]

Entries:
- (none)
```

### 3.4 `docs/core/KNOWLEDGE_BASE.md` (seed)

```md
# KNOWLEDGE_BASE

## Rules of thumb
- Keep docs/core small; place bulky/private refs under docs/references and link here.

## References
- (none)
```

### 3.5 `docs/core/DECISIONS/` and `docs/core/LOGS/`

* Create directories only (no content needed yet).

### 3.6 `docs/core/MASTER_GUIDANCE.ja.md`

* If you maintain Japanese guidance, add it now.
* Otherwise add a stub that points to the English canonical.

### 3.7 `docs/variable_map.md`

Create as an initially empty table (to be updated once code/specs exist):

```md
# variable_map

- (empty; to be filled when variables/specs appear)
```

Commit+sync.

---

## 4) Place private / bulky references correctly

If you have private docs (e.g., non-public APIs), store them under:

* `docs/references/`

Then link them from:

* `docs/core/KNOWLEDGE_BASE.md`

**Rule:** Do not put bulky references into `docs/core/`.

Commit+sync.

---

## 5) Add Docker “always-on” dev container (repo mounted)

Create `docker/compose.yaml`:

```yaml
services:
  dev:
    image: python:3.11-slim
    working_dir: /workspace
    volumes:
      - .:/workspace
    command: bash -lc "python -V && sleep infinity"
```

Commit+sync.

---

## 6) System-side banner + wrapper entrypoints (scripts)

The banner is **SYSTEM-side** (Terminal Keeper / shell wrappers), not an agent task.
Wrappers MUST print the banner **before** launching any agent.

Default startup should call a selector wrapper first so the operator can choose whether to launch Claude, Gemini, or neither.

### 6.1 Max-permission flag matrix (ALL agents)

Wrappers MUST use the highest-privilege no-approval flags available for each CLI:

| CLI             | Max no-approval flag                         | Sandbox control | Wrapper behavior                                  |
| --------------- | -------------------------------------------- | --------------- | ------------------------------------------------- |
| Gemini CLI       | `-y` / `--yolo`                              | N/A             | Always set                                        |
| Claude Code CLI | `--dangerously-skip-permissions`             | CLI-level skip  | Always set                                        |
**Important:** If a flag is not supported by the installed version, wrappers MUST feature-detect and use the best available fallback.

### 6.2 `scripts/tk_common.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

tk_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}
```

### 6.3 `scripts/print_banner.sh` (SYSTEM)

Requirements:

* Print **project name** (use `project_short_name` if present; otherwise abbreviate `project_name` to ~16–24 chars and append `…`).
* Print identifiers: `PROTOCOL_VERSION`, `GIT_COMMIT_SHA`, `WORKSPACE`.

Data source:

* Read `project_short_name`, `project_name`, `protocol_version` from `docs/core/STATE.yaml`.

### 6.4 `scripts/tk_ensure_docker.sh`

* Idempotently run: `docker compose -f docker/compose.yaml up -d`.
* If Docker is unavailable, print a message and exit 0 (do not block startup).

### 6.5 BOOT prompt policy (ALL agents)

Wrappers MUST inject a BOOT prompt that instructs the agent to:

1. Read **EVERYTHING in `docs/core/`** before any reasoning.
2. Report only STATE fields (quote-only; no invention).
3. If `active_tasks` is empty, enumerate `docs/proposed/` and propose next actions.
4. Respect No-Confirm Mode: if operator says 「確認を必要としない」, execute without asking.
5. Handle transient locks (Drive sync / concurrent agents): wait/retry, switch tasks, retry later.

### 6.6 Wrapper templates (maximum permissions)

#### 6.6.1 `scripts/tk_start_claude.sh`

* MUST call `scripts/print_banner.sh` first.
* MUST set: `--dangerously-skip-permissions`
* MUST start with a BOOT prompt.

#### 6.6.3 `scripts/tk_start_gemini.sh`

* MUST call `scripts/print_banner.sh` first.
* MUST use `-y` (YOLO mode) to automatically accept actions.
* MUST use `-i` (Interactive prompt) to inject the BOOT prompt.

Template:

```bash
exec gemini -y -i "$BOOT_PROMPT"
```

### 6.7 Permissions

Make scripts executable:

```bash
chmod +x scripts/*.sh
```

Commit+sync.

---

## 7) Terminal Keeper: `.vscode/sessions.json` (reference template)

`.vscode/sessions.json` MUST start wrappers only:

```json
{
  "$schema": "https://cdn.statically.io/gh/nguyenngoclongdev/cdn/main/schema/v11/terminal-keeper.json",
  "theme": "tribe",
  "active": "default",
  "activateOnStartup": true,
  "keepExistingTerminals": false,
  "sessions": {
    "default": [
      {
        "name": "docker dev (WSL)",
        "autoExecuteCommands": true,
        "icon": "rocket",
        "color": "terminal.ansiGreen",
        "shellPath": "wsl.exe",
        "commands": [
          "bash -lc './scripts/tk_ensure_docker.sh'"
        ]
      },
      {
        "name": "claude (WSL)",
        "autoExecuteCommands": true,
        "icon": "beaker",
        "color": "terminal.ansiCyan",
        "shellPath": "wsl.exe",
        "commands": [
          "bash -lc './scripts/tk_start_claude.sh'"
        ]
      },
      {
        "name": "gemini (WSL)",
        "autoExecuteCommands": true,
        "icon": "code",
        "color": "terminal.ansiYellow",
        "shellPath": "wsl.exe",
        "commands": [
          "bash -lc './scripts/tk_start_gemini.sh'"
        ]
      },
      {
        "name": "terminal (default)",
        "autoExecuteCommands": false,
        "icon": "terminal",
        "color": "terminal.ansiWhite",
        "commands": []
      }
    ],
    "saved-session": []
  }
}
```

Commit+sync.

---

## 8) Stop condition (end bootstrap here)

Bootstrap ends after:

* Folder structure exists.
* `GOAL.md` and `MASTER_GUIDANCE.md` are moved into `docs/core/` and root stubs exist.
* Core docs are created (`STATE`, `TASK_INDEX`, `ACTIVITY`, `KNOWLEDGE`, `DECISIONS/`, `LOGS/`, `variable_map`).
* Docker compose exists (repo mounted).
* Terminal Keeper sessions exist (wrappers only).
* Wrappers exist for **ALL agents** and include **maximum-permission flags** + BOOT injection.

**Do not** add application code yet.

---

## 9) Completeness checklist (must all be true)

* [ ] `.vscode/sessions.json` starts wrappers only (no raw CLI starts)
* [ ] `docs/core/GOAL.md` exists and root GOAL stub points to it
* [ ] `docs/core/MASTER_GUIDANCE.md` exists and root stub points to it
* [ ] `docs/core/STATE.yaml` exists with `project_name`, `protocol_version`, `current_goal`, `active_tasks`
* [ ] `docs/core/TASK_INDEX.md`, `ACTIVITY_SUMMARY.md`, `KNOWLEDGE_BASE.md` exist
* [ ] `docs/core/DECISIONS/` and `docs/core/LOGS/` exist
* [ ] `docs/variable_map.md` exists
* [ ] `docs/references/` exists for bulky/private docs; `docs/core` remains small
* [ ] `docker/compose.yaml` exists and mounts repo
* [ ] `scripts/print_banner.sh` prints project name + identifiers
* [ ] `scripts/tk_ensure_docker.sh` is idempotent
* [ ] `scripts/tk_start_claude.sh` uses `--dangerously-skip-permissions`
* [ ] `scripts/tk_start_gemini.sh` uses `--dangerously-bypass-approvals-and-sandbox` if supported, else fallback
* [ ] `chmod +x scripts/*.sh` done
* [ ] commit+sync after each bootstrap stage

---

## Appendix: Transient lock/sync failures

If you see `Permission denied`, `Text file busy`, etc.:

* wait 2–10 seconds, retry up to 3 times
* switch to a different task (read-only work) and retry later
* check `tmp/locks/` and any sync/editor locks

---

## Appendix: No-Confirm Mode

If the operator says **「No approval required」**, execute changes/commands/policy shifts without asking.
Still record changes via commit+sync and update ACTIVITY/STATE/ADR.
