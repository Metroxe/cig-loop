# Streaming Event Processing - Edge Case Analysis

## Edge Case 1: Block Index Collision/Orphaning
**Trigger Condition**: `content_block_delta` or `content_block_stop` event arrives for an index before corresponding `content_block_start`, or events arrive out-of-order due to streaming protocol issues

**Severity**: HIGH

**Issue**: Lines 430-431, 447-448, 456-457 access `blocks[idx]` properties without null checks. If block doesn't exist in the record, property access on undefined will fail silently or crash.

**Fix**: Add null guard before all accesses: `if (blocks[idx]) { blocks[idx].content += text; }`

---

## Edge Case 2: Double-Printing from hasStreamedContent Flag
**Trigger Condition**: Streaming partially completes mid-turn then falls back to `assistant` event, but `hasStreamedContent` flag incorrectly suppresses the fallback printing of non-streamed blocks

**Severity**: MEDIUM

**Issue**: Lines 387-389 set `hasStreamedContent = true` immediately on block start, but lines 519-522 use this global flag to skip ALL content in assistant message. If some blocks stream but others don't, non-streamed content is lost.

**Fix**: Track streamed block indices in Set instead: `if (!streamedIndices.has(idx)) { /* print */ }`

---

## Edge Case 3: Sentinel Detection on Split Text Blocks
**Trigger Condition**: Stop/continue strings span multiple text blocks or are separated by thinking/tool blocks, causing `lastTextBlock` to contain only partial fragment of the sentinel string

**Severity**: HIGH

**Issue**: Line 396 resets `lastTextBlock = ""` on each new text block start. Lines 212-217 only check this partial value. Multi-block sentinels are never detected, breaking loop termination logic.

**Fix**: Check accumulated output instead: `const finalText = output;` (line 211) or maintain concatenated text across blocks

---

# Task Scheduling Optimization

## Problem
Assign 5 tasks to 3 workers:
- Tasks: A=3, B=5, C=2, D=4, E=1
- Constraints:
  1. A must finish before C starts (precedence: A → C)
  2. B and D cannot share a worker
  3. E must be assigned to W2
  4. Maximum 2 tasks per worker

## Optimal Solution

**Makespan: 5 time units**

```
Worker 1: A(3) → C(2)    [Sequential: 0-3, 3-5]    Duration: 5
Worker 2: E(1) → D(4)    [Sequential: 0-1, 1-5]    Duration: 5
Worker 3: B(5)           [0-5]                      Duration: 5
```

### Constraint Verification
✓ **A → C precedence**: A finishes at t=3, C starts at t=3 on W1
✓ **B/D separation**: B on W3, D on W2 (different workers)
✓ **E on W2**: E assigned to W2
✓ **Max 2 tasks/worker**: W1 has 2 tasks, W2 has 2 tasks, W3 has 1 task (all ≤ 2)

## Proof of Optimality

### Lower Bounds

Three independent lower bounds establish that makespan cannot be less than 5:

1. **Task B dominance**: B has duration 5 and must execute somewhere → makespan ≥ 5

2. **Precedence chain**: A + C = 3 + 2 = 5 must execute sequentially → makespan ≥ 5

3. **Work partition**: Total work = 3+5+2+4+1 = 15 units across 3 workers → ⌈15/3⌉ = 5 minimum average

### Why No Solution Achieves Makespan < 5

Since the solution achieves makespan = 5 and matches all three lower bounds, we must prove no configuration can beat it:

**Case analysis on B and D placement** (since they cannot share):

- **Case 1**: B on W1, D elsewhere
  - W1 has B(5) + at most one other task
  - If W1 = B only: makespan ≥ 5 from B
  - If W1 = B + X: duration ≥ 5 already from B alone
  - Cannot place A→C chain on W1 (would need 2 tasks plus B = 3 tasks, violates constraint)

- **Case 2**: D on W2 (required by E constraint)
  - W2 must have E(1) + something else
  - If W2 = E + D: duration = 1+4 = 5 (achieved in our solution)
  - If W2 = E only: need to place D elsewhere, creating imbalance

- **Case 3**: Try makespan = 4
  - B(5) cannot fit in makespan 4 → impossible
  - A→C chain (5 total) cannot fit in makespan 4 → impossible

**Distribution verification**:

Given E must be on W2 and B/D must separate:
- Optimal assignment spreads work evenly: {5}, {5}, {5}
- Any other valid assignment creates imbalance:
  - Moving C from W1 to W3: W1=3, W2=5, W3=7 → makespan 7
  - Moving D from W2 to W3: W2=1, W3=9 → makespan 9

### Conclusion

The solution achieves makespan = 5, which equals the theoretical minimum from three independent lower bounds. No assignment can do better. **This solution is provably optimal.**
