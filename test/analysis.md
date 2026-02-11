# Edge Case Analysis: `src/claude.ts` Streaming Event Processing

## 1. Duplicate Output on `hasStreamedContent` Flag Race

**Trigger condition:** An `assistant` event arrives containing content blocks, but *some* blocks were streamed via `content_block_delta` while others were not (e.g., the CLI emits a partial streaming sequence interrupted by a reconnect). The flag `hasStreamedContent` is a single boolean for the entire turn — if *any* delta arrived, the *entire* assistant message is suppressed, silently dropping unstreamed blocks.

**Severity:** High — tool-use blocks or text blocks can be silently lost from the output, causing the user to miss actions Claude took.

**Fix:** Track streamed block indices in a `Set<number>` instead of a single boolean, and in `handleAssistantMessage` only skip blocks whose index was already streamed.

---

## 2. Block Index Collision Across Interleaved Turns

**Trigger condition:** The `blocks` record (`Record<number, StreamingBlock>`) is never cleared between assistant turns within a single iteration. If the CLI emits two consecutive assistant messages (e.g., after a tool-use round-trip) that both use index `0` for their first block, the second `content_block_start` at index 0 overwrites the first entry before `content_block_stop` can clean it up — or worse, a lingering entry from a prior turn causes `handleBlockStop` to process stale data.

**Severity:** Medium — produces garbled tool-use formatting or phantom "remaining markdown" flushes from a previous block's state leaking into the next turn.

**Fix:** Reset `blocks` to `{}` when a `message_start` event is received (line 287–289 currently ignores it).

---

## 3. `lastTextBlock` Not Updated in the `handleAssistantMessage` Fallback Path

**Trigger condition:** When `hasStreamedContent` is `false` and the assistant message is processed via the fallback path in `handleAssistantMessage` (lines 533–553), text content is written to output but `state.lastTextBlock` is never set. This means sentinel string detection (`stopString` / `continueString` at lines 212–218) checks against an empty or stale `lastTextBlock`, failing to detect stop/continue signals and causing the loop to either run extra iterations or terminate early.

**Severity:** High — the loop's stop/continue control flow is broken for any iteration where streaming deltas were not received (e.g., very short responses, network issues causing the CLI to batch output).

**Fix:** Add `state.lastTextBlock = cleaned;` after line 539 in the fallback text-block handling branch.
