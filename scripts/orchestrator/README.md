# scripts/orchestrator

Generic orchestration helpers for the bootstrap template.

## Files
- `create_task.py`: create a runtime job directory from a task spec
- `launch_gemini.sh`: generate a prompt and launch Gemini for a job
- `collect_result.py`: normalize job output into `result.json`
- `validate_task.sh`: run declared validation commands and write `validator.json`
- `requeue_task.py`: reset a job for another attempt with a recorded reason
- `recover_runtime.sh`: repair placeholder runtime directories and clean stale locks

## Notes
- These scripts are intentionally generic.
- They are safe starting points, not a substitute for project-specific validation policy.
- All scripts assume UTF-8 text files.
