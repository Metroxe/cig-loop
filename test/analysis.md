# Streaming Event Processing: Edge Case Analysis

Source: `src/claude.ts`

---

## Edge Case 1: Remaining buffer after stream ends is not parsed as JSON

**Trigger condition:** The Claude process writes its final JSON line (often the `result` event) without a trailing `\n`. The read loop (lines 121–182) only processes complete lines delimited by newlines. The leftover data stays in `buffer` and falls to the post-loop handler (lines 188–191), which writes it as raw text — never passing it through `JSON.parse` or `processEvent`.

**Severity:** HIGH — Silently drops the `result` event, causing `tokenUsage` and `costUsd` to remain `undefined`. Also prevents `lastTextBlock` from being updated if the final text block was in progress, breaking `stopStringDetected` / `continueStringDetected` sentinel logic.

**Fix:** After the read loop, attempt `processEvent(JSON.parse(buffer.trim()), ...)` before falling back to raw text output.

---

## Edge Case 2: `hasStreamedContent` boolean suppresses non-streamed blocks in mixed assistant messages

**Trigger condition:** An assistant message contains multiple content blocks, but only some were delivered via `content_block_start`/`content_block_delta` (e.g., connection instability drops some blocks, or the CLI batches them). The flag `hasStreamedContent` is set `true` on the *first* streaming block (line 391/429). When `handleAssistantMessage` fires (line 522), it sees the flag, resets it to `false`, and skips the *entire* message — including blocks that were never streamed.

**Severity:** HIGH — Silently drops content (text, tool use summaries) that was present in the assistant event but never delivered via deltas, with no indication to the user.

**Fix:** Replace the boolean with a `Set<number>` of streamed block indices; in `handleAssistantMessage`, only skip blocks whose index is in the set.

---

## Edge Case 3: `content_block_delta` for an unknown block index produces orphaned output

**Trigger condition:** A `content_block_delta` arrives for an index that never received a `content_block_start` (dropped/reordered stream event, or a protocol version mismatch). The delta handler checks `if (blocks[idx])` (lines 433, 451, 459) and skips updating the block record, but for `text_delta` and `thinking_delta` it *still* writes to the footer and appends to `output`/`lastTextBlock` unconditionally (lines 430–432, 448–449). The subsequent `content_block_stop` finds no block and returns early (line 475), skipping all formatting cleanup (tool-use summaries, blank-line separators, thinking newlines).

**Severity:** MEDIUM — Produces malformed terminal output: missing tool-use icons/descriptions, missing section separators, and leaked ANSI state from thinking blocks that never get their closing newline.

**Fix:** In `handleBlockDelta`, if `blocks[idx]` is `undefined`, create a synthetic block entry (e.g., `{ type: "text", content: "" }`) so `handleBlockStop` can clean up correctly.

---

# Task 2: Constraint Scheduling Problem

## Problem

Assign 5 tasks to 3 workers:
- **Durations:** A=3, B=5, C=2, D=4, E=1
- **Constraints:**
  1. A must finish before C starts (precedence: A → C)
  2. B and D cannot share a worker (conflict)
  3. E must be on W2 (fixed assignment)
  4. Max 2 tasks per worker (capacity)

**Objective:** Minimize makespan (completion time of the last worker).

## Optimal Schedule — Makespan = 5

```
Time:  0   1   2   3   4   5
W1:    [===A===][==C==]
W2:    [E][=====D=====]
W3:    [========B========]
```

| Worker | Tasks | Timeline | Completion |
|--------|-------|----------|------------|
| W1 | A, C | A: [0,3], C: [3,5] | 5 |
| W2 | E, D | E: [0,1], D: [1,5] | 5 |
| W3 | B | B: [0,5] | 5 |

### Constraint Verification

1. **A → C:** A finishes at t=3, C starts at t=3. Satisfied.
2. **B ≠ D worker:** B on W3, D on W2. Satisfied.
3. **E on W2:** E assigned to W2. Satisfied.
4. **Max 2 tasks/worker:** W1=2, W2=2, W3=1. All ≤ 2. Satisfied.

## Proof That No Better Solution Exists

### Three independent lower bounds all equal 5

**LB1 — Longest single task:** B has duration 5. Any schedule must complete B, so makespan ≥ 5.

**LB2 — Precedence chain:** A→C forces sequential execution: 3 + 2 = 5. So makespan ≥ 5.

**LB3 — Total work / workers:** Total work = 3+5+2+4+1 = 15. With 3 workers: ⌈15/3⌉ = 5. So makespan ≥ 5.

### Our schedule achieves makespan = 5

Since makespan ≥ 5 (from all three lower bounds) and our solution achieves exactly 5, **no schedule with makespan < 5 can exist**.

### Exhaustive verification that constraints force this assignment

Even the assignment itself is essentially unique (up to symmetry of W1/W3 labels):

- **E is fixed on W2.** W2 has capacity for one more task.
- **B = 5.** If B goes on W2: E+B = 1+5 = 6 > 5 (exceeds lower bound). So B must go on W1 or W3.
- **D = 4.** If D shares a worker with B: violates constraint 2. So D is on a different worker from B.
- **A+C = 5.** They must execute sequentially on the same worker (splitting them across workers wastes idle time waiting for A and pushes makespan above 5).

The only way to achieve makespan = 5:
- W2 = {E(1), D(4)} = 5 (the only pairing that fills W2 to exactly 5)
- One of {W1, W3} gets B(5) alone
- The other gets A(3) then C(2) = 5

Any deviation (B on W2, splitting A/C, co-locating B and D) yields makespan ≥ 6.

**QED. The optimal makespan is 5 and no better solution exists.**
