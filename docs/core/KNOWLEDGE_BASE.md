# KNOWLEDGE_BASE

## Rules of thumb
- Keep `docs/core/` small; agents are expected to read all of it before starting work.
- Put bulky or historical reference material in `docs/references/` and link it here.
- Keep bootstrap scripts generic; only add project-specific helpers after requirements are fixed.
- The default Terminal Keeper session should start Docker and then ask whether to launch Claude, Gemini, or neither.
- Runtime artifacts for delegated work belong under `tmp/orchestrator/`, not in `docs/core/`.
- The generic validator is only a framework; project-specific validation commands must be bound before autonomous completion is trusted.

## References
- Bootstrap procedure reference: `docs/references/PROJECTSTART_MANUAL.md`
- Orchestration runtime policy: `docs/core/ORCHESTRATION_POLICY.md`
- Execution mode selection: `docs/core/EXECUTION_MODES.md`
