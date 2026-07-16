// Sentinel-gate decision logic for the `--continue-string` loop guard.
//
// Kept as a pure function (separate from the CLI entrypoint in index.ts, which
// runs main() on import) so the loop's continue/stop decision is unit-testable.

export type ContinueDecision =
  | { continue: true; reason: "detected" | "wakeup-override" }
  | { continue: false; reason: "not-detected" };

/**
 * Decide whether the loop should continue past the `--continue-string` sentinel
 * gate for a completed iteration.
 *
 * The sentinel (e.g. "[CONTINUE LOOP]") is normally required in the agent's
 * final text block to keep looping. But an agent that ends its turn by calling
 * `ScheduleWakeup` structurally emits no text after the tool call (the tool ends
 * the turn), so the sentinel can never land in the last text block. Without a
 * carve-out the gate `break`s the whole process before the ScheduleWakeup wait
 * code downstream can ever run — making that pacing logic dead code for its
 * primary use case, and leaving systemd's blind ~30s `Restart=always` to stand
 * in for whatever delay the agent actually requested.
 *
 * So: treat a requested wakeup as an explicit continue-and-wait signal that
 * supersedes a missing sentinel. This matches the README's own unconditional
 * framing of ScheduleWakeup pacing ("if the agent calls ScheduleWakeup during an
 * iteration, the loop waits before the next one") — no sentinel precondition is
 * documented there. The wait itself is honored downstream in index.ts.
 */
export function evaluateContinueSentinel(opts: {
  continueStringDetected: boolean;
  requestedWakeupSeconds?: number;
}): ContinueDecision {
  if (opts.continueStringDetected) return { continue: true, reason: "detected" };
  if (opts.requestedWakeupSeconds != null && opts.requestedWakeupSeconds > 0) {
    return { continue: true, reason: "wakeup-override" };
  }
  return { continue: false, reason: "not-detected" };
}
