import { test, expect, describe } from "bun:test";
import { evaluateContinueSentinel } from "./sentinel.js";

// ─── evaluateContinueSentinel ───────────────────────────────────────────────

describe("evaluateContinueSentinel", () => {
  test("sentinel present → continue (detected)", () => {
    expect(evaluateContinueSentinel({ continueStringDetected: true })).toEqual({
      continue: true,
      reason: "detected",
    });
  });

  test("sentinel present AND wakeup requested → detected wins (no wait ambiguity)", () => {
    expect(
      evaluateContinueSentinel({ continueStringDetected: true, requestedWakeupSeconds: 1200 }),
    ).toEqual({ continue: true, reason: "detected" });
  });

  test("no sentinel, no wakeup → stop (original behavior preserved)", () => {
    expect(evaluateContinueSentinel({ continueStringDetected: false })).toEqual({
      continue: false,
      reason: "not-detected",
    });
  });

  // The core regression: an agent that ends its turn by calling ScheduleWakeup
  // structurally emits no text after the tool call, so the sentinel can never be
  // in the final text block. Before this fix that unconditionally hit `break`,
  // making the ScheduleWakeup wait code dead and letting systemd's blind ~30s
  // restart stand in for the requested delay.
  test("no sentinel but wakeup requested → continue (wakeup-override)", () => {
    expect(
      evaluateContinueSentinel({ continueStringDetected: false, requestedWakeupSeconds: 1200 }),
    ).toEqual({ continue: true, reason: "wakeup-override" });
  });

  test("zero / non-positive wakeup does not trigger the override", () => {
    expect(
      evaluateContinueSentinel({ continueStringDetected: false, requestedWakeupSeconds: 0 }),
    ).toEqual({ continue: false, reason: "not-detected" });
    expect(
      evaluateContinueSentinel({ continueStringDetected: false, requestedWakeupSeconds: -5 }),
    ).toEqual({ continue: false, reason: "not-detected" });
  });
});
