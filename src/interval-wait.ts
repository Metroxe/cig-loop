/**
 * The inter-iteration wait, made survivable.
 *
 * ── What went wrong ────────────────────────────────────────────────────────
 * v0.50.1 shipped the wait as one `await Bun.sleep(waitSeconds * 1000)`. Across
 * the Bowmark fleet between 2026-07-31 and 2026-08-01, **6 of 6** processes that
 * ran it for any meaningful stretch eventually parked inside that call and never
 * came out — 4 capability-engineer lanes, `prospector` twice, `avo` once. The
 * signature was identical every time and it is NOT what a sleeping process looks
 * like:
 *
 *   - `completedIterations` frozen, in one case ~1h39m past a 300s delay
 *   - **20-35% sustained CPU on the daemon** — a process genuinely awaiting a
 *     timer sits at ~0%
 *   - zero `claude` subprocess under the daemon pid
 *   - periodic ANSI-redraw blobs in the journal at a ~4-5min cadence, with no
 *     Start/Stop between them
 *
 * It always self-healed on a manual restart with no data loss, which is exactly
 * why it survived so long: nothing goes red, and the only symptom is an agent
 * that quietly stopped producing.
 *
 * ── What this does NOT claim ───────────────────────────────────────────────
 * The root cause is **not** established. The sustained CPU points at event-loop
 * starvation (a spinning renderer, a poller) rather than at `Bun.sleep` losing a
 * timer, and those want different fixes. Nothing here diagnoses it. Both
 * mechanisms below are deliberately chosen to work WITHOUT knowing which it is,
 * because an agent fleet that silently stops for 19 hours cannot wait on a
 * diagnosis.
 *
 * ── Mechanism 1: chunked, wall-clock deadline ──────────────────────────────
 * The wait is a loop of short sleeps against a `Date.now()` deadline rather than
 * one long timer. If the failure is a dropped or starved timer, one lost chunk
 * costs one chunk: the next iteration of the loop re-reads the clock and still
 * terminates at the right moment. A single long timer has no such recovery — it
 * is one point of failure holding the whole loop.
 *
 * ── Mechanism 2: an out-of-band watchdog ───────────────────────────────────
 * Chunking cannot help if the event loop itself is wedged, because then no timer
 * in this thread fires at all. So the deadline is ALSO held by a `Worker`, which
 * has its own event loop and its own thread and keeps ticking while the main one
 * is starved. If the wait overruns its deadline by more than the grace margin,
 * the watchdog force-exits the process.
 *
 * Exiting is the point. Every one of these agents runs under systemd with
 * `Restart=always` and `RestartSec=30`, and a manual restart is what recovered
 * all six incidents. So a hard exit converts a silent forever-hang into a ~30s
 * self-heal that leaves a loud line in the journal, which is strictly better
 * than the status quo on both axes. It is a backstop, not a fix, and it is
 * written to be obvious in the log rather than quiet.
 */

/** How long each sleep chunk is. Short enough that a lost one is cheap, long
 * enough that a 6-hour delay is not 21,600 wakeups. */
const CHUNK_MS = 5_000;

/** How far past its deadline a wait must run before the watchdog kills the
 * process. Generous on purpose: a machine under real load, a suspended laptop,
 * or an NTP step can all overshoot honestly, and a false kill mid-loop is worse
 * than a late one. The observed hangs overran by HOURS, so nothing this size
 * risks missing them. */
export function graceMsFor(totalMs: number): number {
  return Math.max(120_000, totalMs);
}

export interface WaitHooks {
  /** Chunk size override. Exists so a test can prove the CHUNKING property in
   * milliseconds instead of waiting out a real multi-chunk span; production
   * never passes it. */
  chunkMs?: number;
  /** Called when a single chunk returns far later than it was asked to. This is
   * the early warning for the starvation the watchdog exists to catch, and it
   * is worth a log line even when the wait goes on to finish correctly. */
  onLag?: (info: { askedMs: number; actualMs: number; totalMs: number }) => void;
  /** Called immediately before the watchdog force-exits, so the reason reaches
   * the log rather than the process just vanishing. */
  onWatchdogKill?: (info: { totalMs: number; overrunMs: number }) => void;
}

/** A chunk that takes this multiple of its asked duration is reported as lag. */
const LAG_FACTOR = 4;

/** How long the watchdog lets the main thread exit itself, with a readable log
 * line, before the kernel does it instead. Short — by this point the process is
 * already minutes past its deadline and the only question left is whether the
 * exit is tidy. */
const SOFT_EXIT_GRACE_MS = 10_000;

/**
 * Wait `totalMs`, measured against the wall clock rather than against one timer.
 *
 * Returns normally when the deadline is reached. Does not return if the watchdog
 * fires — that path exits the process by design.
 */
export async function waitForInterval(totalMs: number, hooks: WaitHooks = {}): Promise<void> {
  if (!(totalMs > 0)) return;

  const deadline = Date.now() + totalMs;
  const chunkMs = hooks.chunkMs && hooks.chunkMs > 0 ? hooks.chunkMs : CHUNK_MS;
  const grace = graceMsFor(totalMs);
  const watchdog = startWatchdog(deadline + grace, () => {
    hooks.onWatchdogKill?.({ totalMs, overrunMs: Date.now() - deadline });
  });

  try {
    // Wall-clock, never an accumulated counter: a counter drifts by exactly the
    // amount the thing we are guarding against would add.
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const asked = Math.min(chunkMs, remaining);
      const before = Date.now();
      await Bun.sleep(asked);
      const actual = Date.now() - before;
      if (actual > asked * LAG_FACTOR && actual - asked > 1_000) {
        hooks.onLag?.({ askedMs: asked, actualMs: actual, totalMs });
      }
    }
  } finally {
    watchdog.stop();
  }
}

export interface Watchdog {
  stop: () => void;
}

/**
 * A deadline held on another thread.
 *
 * The Worker does nothing but sleep and compare clocks, so it cannot itself be
 * starved by whatever is happening on the main thread — which is the entire
 * reason it is a Worker and not a `setInterval`. `unref()` keeps it from holding
 * the process open on the ordinary path, so a healthy run exits exactly as it
 * did before this existed.
 *
 * Falls back to a same-thread timer if a Worker cannot be constructed. That
 * fallback is strictly weaker (it is starvable, which is the failure mode) and
 * is here so that an environment without Worker support degrades to today's
 * behaviour rather than refusing to run.
 */
export function startWatchdog(killAtMs: number, onKill: () => void): Watchdog {
  const fire = () => {
    try {
      onKill();
    } catch {
      // Never let a logging failure swallow the exit — the exit IS the recovery.
    }
    // Non-zero: this is a crash, and systemd's Restart=always plus the journal
    // entry are what make it recoverable. A zero exit would read as a clean
    // finish and, on a `Restart=on-failure` unit, would not come back at all.
    process.exit(75);
  };

  try {
    // TWO STAGES, and the second one is the one that actually guarantees this
    // works. `worker.onmessage` is dispatched on the MAIN thread's event loop —
    // so if the main loop is starved, which is the leading explanation for the
    // hang, the "kill" message is never delivered and a message-only watchdog
    // is exactly as wedged as the thing it is watching. Stage 2 closes that: a
    // Bun Worker is a thread inside the SAME process (verified: it reports the
    // parent's `process.pid`), so `SIGKILL` to that pid is delivered by the
    // KERNEL and does not care what any event loop is doing.
    //
    // Stage 1 exists only to make the common case tidy — it gives the main
    // thread SOFT_EXIT_GRACE_MS to log the reason and exit itself, which
    // produces a readable journal line instead of a bare kill.
    const source = `
      self.onmessage = (e) => {
        const killAt = e.data.killAt;
        const graceMs = e.data.graceMs;
        const tick = () => {
          if (Date.now() >= killAt) {
            postMessage("kill");
            // Unconditional backstop. If the main thread was healthy enough to
            // act on the message it has already exited and this never runs.
            setTimeout(() => {
              try { process.kill(process.pid, "SIGKILL"); } catch {}
            }, graceMs);
            return;
          }
          setTimeout(tick, 5000);
        };
        tick();
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = (e: MessageEvent) => {
      if (e.data === "kill") fire();
    };
    worker.postMessage({ killAt: killAtMs, graceMs: SOFT_EXIT_GRACE_MS });
    // unref so a healthy run exits exactly as it did before this existed.
    worker.unref?.();
    return {
      stop: () => {
        try {
          worker.terminate();
        } catch {
          /* already gone */
        }
        URL.revokeObjectURL(url);
      },
    };
  } catch {
    const timer = setTimeout(fire, Math.max(0, killAtMs - Date.now()));
    timer.unref?.();
    return { stop: () => clearTimeout(timer) };
  }
}
