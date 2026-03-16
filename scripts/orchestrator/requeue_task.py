#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description='Requeue an orchestrator job for another attempt')
    parser.add_argument('job_dir')
    parser.add_argument('--reason', required=True)
    parser.add_argument('--note', default='')
    args = parser.parse_args()

    job_dir = Path(args.job_dir)
    job_file = job_dir / 'job.json'
    job = json.loads(job_file.read_text(encoding='utf-8'))
    job['attempt'] = int(job.get('attempt', 1)) + 1
    job['status'] = 'queued'
    job['last_requeue_at'] = datetime.now(timezone.utc).isoformat()
    job_file.write_text(json.dumps(job, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    history = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'reason': args.reason,
        'note': args.note,
        'attempt': job['attempt'],
    }
    with (job_dir / 'requeue_history.jsonl').open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(history, ensure_ascii=False) + '\n')

    (job_dir / 'status.txt').write_text('queued\n', encoding='utf-8')
    print(job_dir)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
