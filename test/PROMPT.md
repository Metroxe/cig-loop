Think deeply before answering. Show your full reasoning.

## Task 1: Analyze & Write

Read `src/claude.ts`. Identify the 3 most significant edge cases in the streaming event processing. Then write your findings to `test/analysis.md` (overwrite if it exists) with: trigger condition, severity, and a one-line fix for each.

## Task 2: Constraint Problem

Assign 5 tasks (A=3, B=5, C=2, D=4, E=1) to 3 workers with these constraints:
- A must finish before C starts
- B and D cannot share a worker
- E must be on W2
- Max 2 tasks per worker

Find the optimal schedule that minimizes makespan. Prove no better solution exists.
