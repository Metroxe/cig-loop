/**
 * Client commands for interacting with cig-loop daemons.
 *
 * Subcommands: list, status, stop, pause, resume, logs
 */

import chalk from "chalk";
import { listRuns, findRun, daemonRequest, type RunInfo } from "./daemon.js";
import { formatCost, formatDuration, formatNumber } from "./format.js";

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
