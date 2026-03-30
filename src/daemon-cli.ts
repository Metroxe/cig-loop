/**
 * Client commands for interacting with cig-loop daemons.
 *
 * Subcommands: list, status, stop, pause, resume, logs, attach
 */

import chalk from "chalk";
import { listRuns, findRun, daemonRequest, type RunInfo } from "./daemon.js";
import { formatCost, formatDuration, formatNumber } from "./format.js";
import { StickyFooter, type ControlAction } from "./terminal.js";
import { UsagePoller } from "./usage.js";

export async function runClientCommand(command: string, arg?: string): Promise<void> {
  switch (command) {
    case "list":
      return cmdList();
    case "status":
      return cmdStatus(arg);
    case "stop":
      return cmdStop(arg);
    case "pause":
      return cmdPause(arg);
    case "resume":
      return cmdResume(arg);
    case "logs":
      return cmdLogs(arg);
    case "attach":
      return cmdAttach(arg);
    default:
      console.error(chalk.red(`Unknown command: ${command}`));
      process.exit(1);
  }
}

async function cmdList(): Promise<void> {
  const runs = await listRuns();

  if (runs.length === 0) {
    console.log(chalk.dim("No running cig-loop daemons."));
    return;
  }

  console.log(chalk.bold("Running cig-loop daemons:\n"));

  for (const run of runs) {
    const phaseColor = run.phase === "running" ? chalk.green
      : run.phase === "paused" ? chalk.yellow
      : run.phase === "throttled" ? chalk.yellow
      : run.phase === "stopping" ? chalk.red
      : chalk.dim;

    const iterLabel = run.totalIterations === 0
      ? `${run.iteration}/∞`
      : `${run.iteration}/${run.totalIterations}`;

    console.log(`  ${chalk.cyan(run.id)}  ${phaseColor(run.phase.padEnd(10))}  ${iterLabel.padEnd(8)}  ${chalk.dim(run.promptPath)}`);
    console.log(`  ${" ".repeat(6)}  pid ${run.pid}  ${chalk.dim(run.cwd)}`);
    console.log("");
  }
}

async function cmdStatus(idPrefix?: string): Promise<void> {
  try {
    const run = await findRun(idPrefix);
    const status = await daemonRequest(run.socketPath, "/status");

    const phaseColor = status.phase === "running" ? chalk.green
      : status.phase === "paused" ? chalk.yellow
      : status.phase === "throttled" ? chalk.yellow
      : chalk.dim;

    const iterLabel = status.totalIterations === 0
      ? `${status.iteration} (infinite)`
      : `${status.iteration}/${status.totalIterations}`;

    const cum = status.cumulative;
    const elapsed = Date.now() - new Date(status.startedAt).getTime();

    console.log("");
    console.log(chalk.bold(`Daemon ${chalk.cyan(status.id)}`));
    console.log("");
    console.log(`  Phase:      ${phaseColor(status.phase)}`);
    console.log(`  Iteration:  ${iterLabel}`);
    console.log(`  Uptime:     ${formatDuration(elapsed)}`);
    console.log(`  Prompt:     ${status.promptPath}`);
    console.log(`  CWD:        ${status.cwd}`);
    console.log(`  PID:        ${status.pid}`);
    console.log("");
    console.log(chalk.bold("  Cumulative:"));
    console.log(`    Completed: ${cum.completedIterations}`);
    console.log(`    Duration:  ${formatDuration(cum.totalDurationMs)}`);
    console.log(`    Cost:      ${formatCost(cum.totalCostUsd)}`);
    console.log(`    Tokens:    ${formatNumber(cum.totalInputTokens)} in / ${formatNumber(cum.totalOutputTokens)} out`);

    if (status.live) {
      const liveElapsed = Date.now() - status.live.startTime;
      console.log("");
      console.log(chalk.bold("  Current iteration:"));
      console.log(`    Elapsed:   ${formatDuration(liveElapsed)}`);
      console.log(`    Tokens:    ${formatNumber(status.live.inputTokens)} in / ${formatNumber(status.live.outputTokens)} out`);
      console.log(`    Context:   ${Math.round(status.live.contextPercent)}%`);
    }

    if (status.stopReason) {
      console.log("");
      console.log(`  Stop reason: ${chalk.yellow(status.stopReason)}`);
    }
    console.log("");
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

async function cmdStop(idPrefix?: string): Promise<void> {
  try {
    const run = await findRun(idPrefix);
    await daemonRequest(run.socketPath, "/stop", "POST");
    console.log(chalk.green(`Sent stop signal to daemon ${chalk.cyan(run.id)}`));
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

async function cmdPause(idPrefix?: string): Promise<void> {
  try {
    const run = await findRun(idPrefix);
    await daemonRequest(run.socketPath, "/pause", "POST");
    console.log(chalk.yellow(`Paused daemon ${chalk.cyan(run.id)}`));
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

async function cmdResume(idPrefix?: string): Promise<void> {
  try {
    const run = await findRun(idPrefix);
    await daemonRequest(run.socketPath, "/resume", "POST");
    console.log(chalk.green(`Resumed daemon ${chalk.cyan(run.id)}`));
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

async function cmdLogs(idPrefix?: string): Promise<void> {
  try {
    const run = await findRun(idPrefix);
    const result = await daemonRequest(run.socketPath, "/log?lines=100");

    if (!result.logFile) {
      console.log(chalk.dim("No log file configured for this daemon."));
      return;
    }

    console.log(chalk.dim(`Log file: ${result.logFile}`));
    console.log(chalk.dim("─".repeat(60)));

    for (const line of result.lines) {
      console.log(line);
    }
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

// ─── Attach ──────────────────────────────────────────────────────────

/**
 * Attach a TUI to a running daemon.
 *
 * @param idPrefix - Daemon ID prefix to find, or undefined for auto-detect
 */
export async function cmdAttach(idPrefix?: string): Promise<void> {
  let run: RunInfo;
  try {
    run = await findRun(idPrefix);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // Fetch initial status
  let status: any;
  try {
    status = await daemonRequest(run.socketPath, "/status");
  } catch (err) {
    console.error(chalk.red(`Failed to connect to daemon ${run.id}: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // Check if already stopped
  if (status.phase === "stopped") {
    printAttachSummary(status);
    return;
  }

  // Create the TUI (no log file — daemon handles logging)
  const footer = new StickyFooter(undefined, 0, false);
  await footer.activate();

  // Usage poller in disk-only mode — the daemon process handles API calls
  // and writes to the shared disk cache; we just read it.
  const usagePoller = new UsagePoller(true);
  usagePoller.onUsage = (usage) => footer.setUsage(usage);
  usagePoller.onError = (error) => footer.setUsageFetchError(error);
  await usagePoller.start();

  // Load existing log content as scrollback
  const logFile = status.logFile;
  let tailOffset = 0;
  if (logFile) {
    try {
      const file = Bun.file(logFile);
      if (await file.exists()) {
        const content = await file.text();
        if (content.length > 0) {
          footer.write(content);
        }
        tailOffset = file.size;
      }
    } catch {
      // Non-critical — start with empty scrollback
    }
  }

  // Seed footer with current daemon state
  if (status.cumulative) footer.setCumulative(status.cumulative);
  if (status.live) footer.setLiveStats(status.live);
  if (status.throttleConfig) footer.setThrottleConfig(status.throttleConfig);
  footer.setPhase(status.phase);

  // Track whether we're cleaning up to avoid double-exit
  let exiting = false;
  let resolveAttach: () => void;
  const attachDone = new Promise<void>((resolve) => { resolveAttach = resolve; });

  const exit = async (reason: string) => {
    if (exiting) return;
    exiting = true;
    clearInterval(pollTimer);
    usagePoller.stop();

    // Fetch final status
    let finalStatus = status;
    try {
      finalStatus = await daemonRequest(run.socketPath, "/status");
    } catch {}

    footer.deactivate();
    printAttachSummary(finalStatus, reason);
    resolveAttach();
  };

  // Wire up control bar actions
  footer.onAction = async (action: ControlAction) => {
    try {
      switch (action) {
        case "pause":
          // Toggle pause
          if (status.phase === "paused") {
            await daemonRequest(run.socketPath, "/resume", "POST");
          } else {
            await daemonRequest(run.socketPath, "/pause", "POST");
          }
          break;
        case "force-stop":
          await daemonRequest(run.socketPath, "/force-stop", "POST");
          break;
        case "skip":
          await daemonRequest(run.socketPath, "/skip", "POST");
          break;
        case "force-quit":
          await daemonRequest(run.socketPath, "/force-quit", "POST");
          // Wait briefly then exit
          await Bun.sleep(500);
          await exit("force quit");
          break;
        case "background":
          if (exiting) return;
          exiting = true;
          clearInterval(pollTimer);
          footer.deactivate();
          console.log("");
          console.log(chalk.cyan(`  Backgrounded session ${chalk.bold(run.id)}`));
          console.log(chalk.dim(`  Use 'cig-loop sessions' to reattach`));
          console.log("");
          resolveAttach();
          break;
        case "continue":
          await daemonRequest(run.socketPath, "/continue", "POST");
          break;
      }
    } catch (err) {
      // Daemon may be gone
    }
  };

  // Handle Ctrl+C — force quit the daemon
  const sigHandler = () => {
    daemonRequest(run.socketPath, "/force-quit", "POST").catch(() => {});
    setTimeout(() => exit("force quit (Ctrl+C)"), 500);
  };
  process.on("SIGINT", sigHandler);
  process.on("SIGTERM", sigHandler);

  // Poll loop: update stats + tail log
  const pollTimer = setInterval(async () => {
    if (exiting) return;

    try {
      status = await daemonRequest(run.socketPath, "/status");

      // Update footer stats
      if (status.cumulative) footer.setCumulative(status.cumulative);
      if (status.live) footer.setLiveStats(status.live);
      footer.setPhase(status.phase);

      // Tail the log file for new output
      if (logFile) {
        try {
          const file = Bun.file(logFile);
          const size = file.size;
          if (size < tailOffset) {
            // Log was trimmed — reset
            tailOffset = 0;
          }
          if (size > tailOffset) {
            const slice = file.slice(tailOffset, size);
            const newContent = await slice.text();
            footer.write(newContent);
            tailOffset = size;
          }
        } catch {
          // Log file read error — non-critical
        }
      }

      // Detect daemon stopped
      if (status.phase === "stopped") {
        await exit(status.stopReason || "loop finished");
      }
    } catch {
      // Socket error — daemon likely crashed
      await exit("daemon connection lost");
    }
  }, 500);

  // Block until the session ends (exit/background/force-quit resolves this)
  await attachDone;
}

// ─── Attach Summary ──────────────────────────────────────────────────

function printAttachSummary(status: any, reason?: string): void {
  const cum = status.cumulative;
  if (!cum) return;

  const cols = process.stdout.columns || 80;
  const stopReason = reason || status.stopReason || "loop finished";
  const isFatal = stopReason.startsWith("fatal error");
  const color = isFatal ? chalk.red : chalk.green;
  const icon = isFatal ? "✗" : "✓";

  console.log("");
  console.log(color("━".repeat(cols)));
  console.log(chalk.bold(color(`  ${icon} Session ${status.id || "?"} ${isFatal ? "crashed" : "finished"}`)));
  console.log("");
  console.log(`  Iterations:  ${cum.completedIterations}`);
  console.log(`  Duration:    ${formatDuration(cum.totalDurationMs)}`);
  console.log(`  Cost:        ${formatCost(cum.totalCostUsd)}`);
  console.log(`  Tokens:      ${formatNumber(cum.totalInputTokens)} in / ${formatNumber(cum.totalOutputTokens)} out`);
  console.log(`  Reason:      ${color(stopReason)}`);
  console.log("");
}
