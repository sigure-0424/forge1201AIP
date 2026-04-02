from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    job_path = Path(sys.argv[1])
    prompt_path = Path(sys.argv[2])
    job = json.loads(job_path.read_text(encoding="utf-8"))

    prompt = f"TASK_ID: {job['task_id']}\nEXECUTION_MODE: {job['execution_mode']}\n\n"
    prompt += "Operator request:\n"
    prompt += (job.get("operator_request", "").strip() or "(not provided)") + "\n\n"
    prompt += "Constraints:\n"
    for item in job.get("constraints", []):
        prompt += f"- {item}\n"
    prompt += "\nProhibited paths:\n"
    for item in job.get("prohibited_paths", []):
        prompt += f"- {item}\n"
    prompt += "\nDeliverables:\n"
    for item in job.get("deliverables", []):
        prompt += f"- {item}\n"
    prompt += "\nValidation commands:\n"
    for item in job.get("validation_commands", []):
        prompt += f"- {item}\n"
    prompt += (
        "\nWrite logs into the assigned job directory and create needs_clarification.txt "
        "if you cannot proceed safely.\n"
    )
    prompt_path.write_text(prompt, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
