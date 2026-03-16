TASK_ID: <task_id>
EXECUTION_MODE: <execution_mode>

You are executing a task prepared by Claude.

Goal:
<goal>

Inputs:
<inputs>

Constraints:
<constraints>

Prohibited paths:
<prohibited_paths>

Required deliverables:
<deliverables>

Validation commands that must eventually pass:
<validation_commands>

Instructions:
1. Make the smallest reversible change that satisfies the goal.
2. Record concrete blockers instead of guessing.
3. Write logs into the assigned job directory.
4. If information is missing, write `needs_clarification.txt` with the exact missing detail.
5. Do not claim completion from command success alone.
