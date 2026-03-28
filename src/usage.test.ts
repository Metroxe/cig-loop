import { test, expect, describe } from "bun:test";
import { getDynamicThreshold, checkThrottle } from "./usage.js";
import type { UsageData, ThrottleConfig } from "./types.js";

// ─── getDynamicThreshold ────────────────────────────────────────────────

describe("getDynamicThreshold", () => {
  const FIVE_HOURS = 5 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  test("halfway through a 7-day window → ~50%", () => {
    const resetsAt = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
    const threshold = getDynamicThreshold(resetsAt, SEVEN_DAYS);
    expect(threshold).toBe(50);
  });

  test("5.5 days into a 7-day window → ~79%", () => {
    // 1.5 days remaining
    const resetsAt = new Date(Date.now() + 1.5 * 24 * 60 * 60 * 1000).toISOString();
    const threshold = getDynamicThreshold(resetsAt, SEVEN_DAYS);
    expect(threshold).toBe(79);
  });

  test("1 day into a 7-day window → ~14%", () => {
    // 6 days remaining
    const resetsAt = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const threshold = getDynamicThreshold(resetsAt, SEVEN_DAYS);
    expect(threshold).toBe(14);
  });

  test("4 hours into a 5-hour window → 80%", () => {
    // 1 hour remaining
    const resetsAt = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString();
    const threshold = getDynamicThreshold(resetsAt, FIVE_HOURS);
    expect(threshold).toBe(80);
  });

  test("window about to reset (past reset time) → 100%", () => {
    const resetsAt = new Date(Date.now() - 1000).toISOString();
    const threshold = getDynamicThreshold(resetsAt, SEVEN_DAYS);
    expect(threshold).toBe(100);
  });

  test("window just started (full time remaining) → 0%", () => {
    const resetsAt = new Date(Date.now() + SEVEN_DAYS).toISOString();
    const threshold = getDynamicThreshold(resetsAt, SEVEN_DAYS);
    expect(threshold).toBe(0);
  });

  test("invalid date → 100% (don't throttle)", () => {
    const threshold = getDynamicThreshold("not-a-date", SEVEN_DAYS);
    expect(threshold).toBe(100);
  });

  test("empty string → 100%", () => {
    const threshold = getDynamicThreshold("", SEVEN_DAYS);
    expect(threshold).toBe(100);
  });
});

// ─── checkThrottle (dynamic mode) ──────────────────────────────────────

describe("checkThrottle dynamic mode", () => {
  const dynamicConfig: ThrottleConfig = {
    fiveHour: 0,
    sevenDay: 0,
    sonnet: 0,
    dynamic: true,
  };

  function makeUsage(overrides: Partial<UsageData> = {}): UsageData {
    return {
      fiveHour: null,
      sevenDay: null,
      sevenDaySonnet: null,
      sevenDayOpus: null,
      fetchedAt: Date.now(),
      ...overrides,
    };
  }

  test("all buckets under dynamic threshold → null (no hit)", () => {
    // 3.5 days remaining out of 7 → threshold ~50%
    // utilization at 30% → under threshold
    const resetIn3_5days = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
    const resetIn2_5hours = new Date(Date.now() + 2.5 * 60 * 60 * 1000).toISOString();

    const usage = makeUsage({
      fiveHour: { utilization: 30, resetsAt: resetIn2_5hours },
      sevenDay: { utilization: 30, resetsAt: resetIn3_5days },
      sevenDaySonnet: { utilization: 30, resetsAt: resetIn3_5days },
    });

    const hit = checkThrottle(usage, "sonnet", dynamicConfig);
    expect(hit).toBeNull();
  });

  test("5h bucket over dynamic threshold → throttled", () => {
    // 1 hour remaining out of 5 → threshold 80%
    // utilization at 90% → over
    const resetIn1hour = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString();
    const resetIn3_5days = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();

    const usage = makeUsage({
      fiveHour: { utilization: 90, resetsAt: resetIn1hour },
      sevenDay: { utilization: 10, resetsAt: resetIn3_5days },
    });

    const hit = checkThrottle(usage, "sonnet", dynamicConfig);
    expect(hit).not.toBeNull();
    expect(hit!.bucket).toBe("5h");
    expect(hit!.utilization).toBe(90);
    expect(hit!.threshold).toBe(80);
  });

  test("7d all-models bucket over → throttled even if 5h is fine", () => {
    const resetIn2_5hours = new Date(Date.now() + 2.5 * 60 * 60 * 1000).toISOString();
    // 1 day remaining → threshold ~86%
    const resetIn1day = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

    const usage = makeUsage({
      fiveHour: { utilization: 20, resetsAt: resetIn2_5hours },
      sevenDay: { utilization: 90, resetsAt: resetIn1day },
      sevenDaySonnet: { utilization: 50, resetsAt: resetIn1day },
    });

    const hit = checkThrottle(usage, "sonnet", dynamicConfig);
    expect(hit).not.toBeNull();
    expect(hit!.bucket).toBe("7d");
  });

  test("sonnet bucket over → throttled when model is sonnet", () => {
    const resetIn2_5hours = new Date(Date.now() + 2.5 * 60 * 60 * 1000).toISOString();
    const resetIn3_5days = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
    // 1 day remaining → threshold ~86%
    const resetIn1day = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

    const usage = makeUsage({
      fiveHour: { utilization: 20, resetsAt: resetIn2_5hours },
      sevenDay: { utilization: 20, resetsAt: resetIn3_5days },
      sevenDaySonnet: { utilization: 90, resetsAt: resetIn1day },
    });

    const hit = checkThrottle(usage, "sonnet", dynamicConfig);
    expect(hit).not.toBeNull();
    expect(hit!.bucket).toBe("sonnet");
  });

  test("sonnet bucket NOT checked when model is opus", () => {
    const resetIn2_5hours = new Date(Date.now() + 2.5 * 60 * 60 * 1000).toISOString();
    const resetIn3_5days = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
    const resetIn1day = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

    const usage = makeUsage({
      fiveHour: { utilization: 20, resetsAt: resetIn2_5hours },
      sevenDay: { utilization: 20, resetsAt: resetIn3_5days },
      sevenDaySonnet: { utilization: 99, resetsAt: resetIn1day }, // over, but should be ignored
      sevenDayOpus: { utilization: 20, resetsAt: resetIn3_5days }, // under
    });

    const hit = checkThrottle(usage, "claude-opus-4-20250514", dynamicConfig);
    expect(hit).toBeNull();
  });

  test("opus bucket checked when model is opus", () => {
    const resetIn2_5hours = new Date(Date.now() + 2.5 * 60 * 60 * 1000).toISOString();
    const resetIn3_5days = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
    const resetIn1day = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

    const usage = makeUsage({
      fiveHour: { utilization: 20, resetsAt: resetIn2_5hours },
      sevenDay: { utilization: 20, resetsAt: resetIn3_5days },
      sevenDayOpus: { utilization: 90, resetsAt: resetIn1day },
    });

    const hit = checkThrottle(usage, "claude-opus-4-20250514", dynamicConfig);
    expect(hit).not.toBeNull();
    expect(hit!.bucket).toBe("opus");
  });

  test("model-specific bucket NOT checked when model is unknown", () => {
    const resetIn2_5hours = new Date(Date.now() + 2.5 * 60 * 60 * 1000).toISOString();
    const resetIn3_5days = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
    const resetIn1day = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

    const usage = makeUsage({
      fiveHour: { utilization: 20, resetsAt: resetIn2_5hours },
      sevenDay: { utilization: 20, resetsAt: resetIn3_5days },
      sevenDaySonnet: { utilization: 99, resetsAt: resetIn1day },
      sevenDayOpus: { utilization: 99, resetsAt: resetIn1day },
    });

    // No model specified → skip model-specific bucket
    const hit = checkThrottle(usage, undefined, dynamicConfig);
    expect(hit).toBeNull();
  });

  test("no usage data → null (proceed)", () => {
    const usage = makeUsage();
    const hit = checkThrottle(usage, "sonnet", dynamicConfig);
    expect(hit).toBeNull();
  });
});

// ─── checkThrottle (static mode, regression) ───────────────────────────

describe("checkThrottle static mode", () => {
  const staticConfig: ThrottleConfig = {
    fiveHour: 90,
    sevenDay: 80,
    sonnet: 80,
    dynamic: false,
  };

  test("under all thresholds → null", () => {
    const usage: UsageData = {
      fiveHour: { utilization: 50, resetsAt: "" },
      sevenDay: { utilization: 50, resetsAt: "" },
      sevenDaySonnet: { utilization: 50, resetsAt: "" },
      sevenDayOpus: null,
      fetchedAt: Date.now(),
    };

    const hit = checkThrottle(usage, "sonnet", staticConfig);
    expect(hit).toBeNull();
  });

  test("5h over → throttled", () => {
    const usage: UsageData = {
      fiveHour: { utilization: 95, resetsAt: "2025-01-01T00:00:00Z" },
      sevenDay: { utilization: 50, resetsAt: "" },
      sevenDaySonnet: { utilization: 50, resetsAt: "" },
      sevenDayOpus: null,
      fetchedAt: Date.now(),
    };

    const hit = checkThrottle(usage, "sonnet", staticConfig);
    expect(hit).not.toBeNull();
    expect(hit!.bucket).toBe("5h");
    expect(hit!.threshold).toBe(90);
  });

  test("disabled buckets are skipped", () => {
    const config: ThrottleConfig = { fiveHour: 0, sevenDay: 0, sonnet: 0, dynamic: false };
    const usage: UsageData = {
      fiveHour: { utilization: 100, resetsAt: "" },
      sevenDay: { utilization: 100, resetsAt: "" },
      sevenDaySonnet: { utilization: 100, resetsAt: "" },
      sevenDayOpus: null,
      fetchedAt: Date.now(),
    };

    const hit = checkThrottle(usage, "sonnet", config);
    expect(hit).toBeNull();
  });
});
