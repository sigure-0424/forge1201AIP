#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def tail_text(path: Path, lines: int = 40) -> list[str]:
    if not path.exists():
        return []
    text = path.read_text(encoding='utf-8', errors='replace').splitlines()
    return text[-lines:]


def main() -> int:
    parser = argparse.ArgumentParser(description='Collect orchestrator job output into result.json')
    parser.add_argument('job_dir')
    args = parser.parse_args()

    job_dir = Path(args.job_dir)
    job = json.loads((job_dir / 'job.json').read_text(encoding='utf-8'))

    clarification = job_dir / 'needs_clarification.txt'
    exit_code_file = job_dir / 'exit_code.txt'
    stdout_log = job_dir / 'gemini.stdout.log'
    stderr_log = job_dir / 'gemini.stderr.log'

    if clarification.exists():
        status = 'needs_clarification'
        summary = clarification.read_text(encoding='utf-8', errors='replace').strip()
    elif not exit_code_file.exists():
        status = 'running'
        summary = 'exit_code.txt not found'
    else:
        code = int(exit_code_file.read_text(encoding='utf-8').strip() or '1')
        status = 'succeeded' if code == 0 else 'failed'
        summary = f'process exited with code {code}'

    result = {
        'job_id': job['job_id'],
        'task_id': job['task_id'],
        'status': status,
        'summary': summary,
        'stdout_tail': tail_text(stdout_log),
        'stderr_tail': tail_text(stderr_log),
    }
    (job_dir / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(job_dir / 'result.json')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
