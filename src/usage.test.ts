import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  getDynamicThreshold,
  checkThrottle,
  readOAuthToken,
  __resetTokenCacheForTests,
  detectRateLimitHit,
  rateLimitBackoffMs,
  RATE_LIMIT_BACKOFF_SCHEDULE_MS,
} from "./usage.js";
import type { UsageData, ThrottleConfig } from "./types.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ─── readOAuthToken ─────────────────────────────────────────────────────

describe("readOAuthToken", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalEnvToken: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "cig-loop-usage-test-"));
    originalHome = process.env.HOME;
    originalEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.HOME = fakeHome;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    __resetTokenCacheForTests();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalEnvToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalEnvToken;
    rmSync(fakeHome, { recursive: true, force: true });
    __resetTokenCacheForTests();
  });

  test("falls back to CLAUDE_CODE_OAUTH_TOKEN when ~/.claude/.credentials.json is absent", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token-123";
    const token = await readOAuthToken();
    expect(token).toBe("env-token-123");
  });

  test("returns null when neither the credentials file nor the env var is present", async () => {
    const token = await readOAuthToken();
    expect(token).toBeNull();
  });

  test("prefers ~/.claude/.credentials.json over the env var when both are present", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token-should-be-ignored";
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "file-token-456" } }),
    );
    const token = await readOAuthToken();
    expect(token).toBe("file-token-456");
  });

  test("falls back to the env var when the credentials file exists but has no token", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token-789";
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(join(fakeHome, ".claude", ".credentials.json"), JSON.stringify({}));
    const token = await readOAuthToken();
    expect(token).toBe("env-token-789");
  });
});

// ─── detectRateLimitHit ─────────────────────────────────────────────────

describe("detectRateLimitHit", () => {
  test("matches the real weekly-limit message", () => {
    expect(
      detectRateLimitHit("You've hit your weekly limit · resets Jul 27, 11am (America/Vancouver)"),
    ).toBe(true);
  });

  test("matches a 5-hour variant", () => {
    expect(
      detectRateLimitHit("You've hit your 5-hour limit · resets 3:00pm (America/Vancouver)"),
    ).toBe(true);
  });

  test("matches when embedded in a larger output blob", () => {
    expect(
      detectRateLimitHit("some preceding log noise\nYou've hit your weekly limit · resets Jul 27, 11am\ntrailing"),
    ).toBe(true);
  });

  test("does not match ordinary assistant output", () => {
    expect(detectRateLimitHit("[CONTINUE LOOP]")).toBe(false);
    expect(detectRateLimitHit("")).toBe(false);
    expect(detectRateLimitHit("I hit a limit on how many files I could read, so I stopped.")).toBe(false);
  });

  test("does not match cig-loop's own proactive throttle message (different wording)", () => {
    expect(detectRateLimitHit("⏸ Throttled: 5h at 92% (limit: 90%). Resuming at Thu 11:00 AM.")).toBe(false);
  });
});

// ─── rateLimitBackoffMs ─────────────────────────────────────────────────

describe("rateLimitBackoffMs", () => {
  test("follows the schedule for consecutive hits 1..N", () => {
    RATE_LIMIT_BACKOFF_SCHEDULE_MS.forEach((expected, i) => {
      expect(rateLimitBackoffMs(i + 1)).toBe(expected);
    });
  });

  test("holds at the last (longest) schedule entry beyond its length", () => {
    const last = RATE_LIMIT_BACKOFF_SCHEDULE_MS[RATE_LIMIT_BACKOFF_SCHEDULE_MS.length - 1];
    expect(rateLimitBackoffMs(RATE_LIMIT_BACKOFF_SCHEDULE_MS.length + 5)).toBe(last);
    expect(rateLimitBackoffMs(1000)).toBe(last);
  });

  test("clamps a 0 or negative count to the first entry", () => {
    expect(rateLimitBackoffMs(0)).toBe(RATE_LIMIT_BACKOFF_SCHEDULE_MS[0]);
    expect(rateLimitBackoffMs(-3)).toBe(RATE_LIMIT_BACKOFF_SCHEDULE_MS[0]);
  });
});
