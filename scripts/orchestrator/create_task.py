#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

TASK_ID_RE = re.compile(r"TASK-\d{8}-\d{3}-[a-z0-9-]+")
SECTION_RE = re.compile(r"^##\s+(?P<name>.+?)\s*$")


def parse_sections(text: str) -> dict[str, list[str]]:
    current = None
    sections: dict[str, list[str]] = {}
    for raw_line in text.splitlines():
        match = SECTION_RE.match(raw_line.strip())
        if match:
            current = match.group('name').strip().lower().replace(' ', '_')
            sections.setdefault(current, [])
            continue
        if current is not None:
            sections[current].append(raw_line.rstrip())
    return sections


def bullet_values(lines: list[str]) -> list[str]:
    values = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('- '):
            value = stripped[2:].strip()
            if value.startswith('`') and value.endswith('`') and len(value) >= 2:
                value = value[1:-1].strip()
            values.append(value)
    return [v for v in values if v]


def infer_task_id(path: Path, text: str) -> str:
    for candidate in [path.name, text.splitlines()[0] if text.splitlines() else '']:
        match = TASK_ID_RE.search(candidate)
        if match:
            return match.group(0)
    raise SystemExit('task-id not found in file name or heading')


def main() -> int:
    parser = argparse.ArgumentParser(description='Create an orchestrator runtime job from a task spec')
    parser.add_argument('--task-spec', required=True, help='Path to the markdown task spec')
    parser.add_argument('--execution-mode', default='local', choices=['local', 'cloud', 'hybrid'])
    parser.add_argument('--operator-request', default='')
    parser.add_argument('--validation-command', action='append', default=[])
    parser.add_argument('--output-root', default='tmp/orchestrator/jobs')
    args = parser.parse_args()

    task_spec = Path(args.task_spec)
    text = task_spec.read_text(encoding='utf-8')
    task_id = infer_task_id(task_spec, text)
    sections = parse_sections(text)
    validation_commands = bullet_values(sections.get('validation_commands', [])) or args.validation_command
    success_criteria = bullet_values(sections.get('success_criteria', []))
    constraints = bullet_values(sections.get('constraints', []))
    prohibited_paths = bullet_values(sections.get('prohibited_paths', []))
    deliverables = bullet_values(sections.get('deliverables', []))

    created_at = datetime.now(timezone.utc)
    stamp = created_at.strftime('%Y%m%dT%H%M%SZ')
    job_id = f'{task_id}-{stamp}'
    job_dir = Path(args.output_root) / job_id
    job_dir.mkdir(parents=True, exist_ok=False)

    job = {
        'job_id': job_id,
        'task_id': task_id,
        'task_spec_path': str(task_spec),
        'created_at': created_at.isoformat(),
        'execution_mode': args.execution_mode,
        'status': 'queued',
        'attempt': 1,
        'operator_request': args.operator_request,
        'constraints': constraints,
        'prohibited_paths': prohibited_paths,
        'deliverables': deliverables,
        'validation_commands': validation_commands,
        'success_criteria': success_criteria,
    }

    (job_dir / 'job.json').write_text(json.dumps(job, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (job_dir / 'status.txt').write_text('queued\n', encoding='utf-8')
    (job_dir / 'task_spec.md').write_text(text, encoding='utf-8')
    print(job_dir)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
