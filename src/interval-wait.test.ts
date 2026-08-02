import { describe, expect, test } from "bun:test";
import { graceMsFor, startWatchdog, waitForInterval } from "./interval-wait.js";

describe("waitForInterval", () => {
  test("returns after roughly the requested span", async () => {
    const before = Date.now();
    await waitForInterval(300);
    const elapsed = Date.now() - before;
    // Lower bound is the real assertion — it must not return early, because
    // returning early would re-invoke Claude faster than the operator's floor.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(3_000);
  });

  test("a zero or negative span is a no-op rather than an error", async () => {
    await waitForInterval(0);
    await waitForInterval(-5_000);
  });

  test("chunks rather than sleeping once, so a lost timer costs one chunk", async () => {
    // The property that matters: a wait longer than one chunk issues MORE THAN
    // ONE sleep, and no single sleep is the whole span. `chunkMs` keeps the
    // proof in milliseconds instead of waiting out a real multi-chunk span.
    const real = Bun.sleep;
    const asked: number[] = [];
    // @ts-expect-error — deliberately swapping the global for one assertion.
    Bun.sleep = (ms: number) => {
      asked.push(ms);
      return real(ms);
    };
    try {
      await waitForInterval(200, { chunkMs: 20 });
    } finally {
        Bun.sleep = real;
    }
    expect(asked.length).toBeGreaterThan(1);
    expect(Math.max(...asked)).toBeLessThanOrEqual(20);
  });
});

describe("graceMsFor", () => {
  test("never kills a short wait on a small overshoot", () => {
    // A 1s delay must still get minutes of grace — a loaded machine or an NTP
    // step overshoots honestly, and a false kill mid-loop is worse than a late
    // one. The real hangs overran by hours.
    expect(graceMsFor(1_000)).toBeGreaterThanOrEqual(120_000);
  });

  test("scales with the wait, so a long delay gets proportionate slack", () => {
    expect(graceMsFor(3_600_000)).toBeGreaterThanOrEqual(3_600_000);
  });
});

describe("startWatchdog", () => {
  test("stop() disarms it — a healthy wait must never exit the process", async () => {
    let fired = false;
    // A deadline already in the past: only stop() being honoured keeps this
    // test process alive to make the assertion at all.
    const wd = startWatchdog(Date.now() - 1_000, () => {
      fired = true;
    });
    wd.stop();
    await Bun.sleep(150);
    expect(fired).toBe(false);
  });

  test("a completed wait leaves no armed watchdog behind", async () => {
    let fired = false;
    const wd = startWatchdog(Date.now() + 50, () => {
      fired = true;
    });
    wd.stop();
    await Bun.sleep(200);
    // Past the deadline, and it must stay silent because the wait finished.
    expect(fired).toBe(false);
  });
});
