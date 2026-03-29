/**
 * Terminal UI — prints directly to stdout with a sticky footer.
 *
 * Log lines go straight to stdout (scrollable in your terminal).
 * The footer is repainted in-place at the bottom using ANSI cursor
 * movement, similar to Claude Code's status line.
 *
 * No alternate screen, no React, no OpenTUI.
 */

import chalk from "chalk";
import { formatCost, formatDuration, formatNumber, stripAnsi } from "./format.js";
import { fetchUsage, loadDiskCache, formatResetTime, getDynamicThreshold, BUCKET_PERIOD_MS } from "./usage.js";
import type { CumulativeStats, LiveIterationStats, UsageData, ThrottleConfig } from "./types.js";

const orange = chalk.hex("#FF9500");

// ─── State ───────────────────────────────────────────────────────────

interface FooterState {
  liveStats: LiveIterationStats | null;
  cumulative: CumulativeStats;
  usage: UsageData | null;
  usageError: boolean;
  usageLastAttempt: number;
  throttleConfig: ThrottleConfig | null;
}

// ─── Progress Bar ─────────────────────────────────────────────────────

function progressBar(current: number, total: number, width = 20): string {
  if (total === 0) {
    const pos = current % (width * 2);
    const idx = pos < width ? pos : width * 2 - pos;
    return " ".repeat(idx) + "◆" + " ".repeat(Math.max(0, width - idx - 1));
  }
  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);
  return "█".repeat(filled) + "░".repeat(empty) + ` ${pct}%`;
}

// ─── Footer Renderer ─────────────────────────────────────────────────

function usageColor(pct: number): string {
  if (pct >= 80) return "#FF5555";
  if (pct >= 50) return "#FFFF00";
  return "#50FA7B";
}

function renderFooter(state: FooterState): string[] {
  const cols = process.stdout.columns || 80;
  const now = Date.now();
  const lines: string[] = [];

  // Separator
  lines.push(chalk.dim("━".repeat(cols)));

  // Line 1: iteration info
  if (state.liveStats) {
    const elapsed = now - state.liveStats.startTime;
    const iterLabel =
      state.liveStats.totalIterations === 0
        ? `Iteration ${state.liveStats.iteration} (infinite)`
        : `Iteration ${state.liveStats.iteration}/${state.liveStats.totalIterations}`;
    const bar = progressBar(state.liveStats.iteration, state.liveStats.totalIterations);
    lines.push(chalk.bold(` ${iterLabel} ${bar}`));
  } else {
    lines.push(chalk.bold(" Waiting..."));
  }

  // Line 2: current iteration stats
  if (state.liveStats) {
    const elapsed = now - state.liveStats.startTime;
    lines.push(
      chalk.hex("#5FAFAF")(
        ` ▸ Current:  ${formatDuration(elapsed)} │ ${formatNumber(state.liveStats.inputTokens)} in / ${formatNumber(state.liveStats.outputTokens)} out │ ${Math.round(state.liveStats.contextPercent)}% context`
      )
    );
  } else {
    lines.push("");
  }

  // Line 3: totals
  const totalDurationMs = state.cumulative.totalDurationMs + (state.liveStats ? now - state.liveStats.startTime : 0);
  const totalInputTokens = state.cumulative.totalInputTokens + (state.liveStats ? state.liveStats.inputTokens : 0);
  const totalOutputTokens = state.cumulative.totalOutputTokens + (state.liveStats ? state.liveStats.outputTokens : 0);

  if (state.cumulative.completedIterations > 0 || state.liveStats) {
    lines.push(
      chalk.yellow(
        ` ▸ Totals:   ${formatDuration(totalDurationMs)} │ ${formatNumber(totalInputTokens)} in / ${formatNumber(totalOutputTokens)} out │ ${formatCost(state.cumulative.totalCostUsd)}`
      )
    );
  } else {
    lines.push(chalk.yellow(" Totals:   --"));
  }

  // Line 4: usage
  const { usage, throttleConfig } = state;
  if (usage) {
    const isDynamic = throttleConfig?.dynamic ?? false;
    const cap5h = isDynamic && usage.fiveHour ? getDynamicThreshold(usage.fiveHour.resetsAt, BUCKET_PERIOD_MS.fiveHour) : null;
    const cap7d = isDynamic && usage.sevenDay ? getDynamicThreshold(usage.sevenDay.resetsAt, BUCKET_PERIOD_MS.sevenDay) : null;
    const capModel = isDynamic && usage.sevenDaySonnet ? getDynamicThreshold(usage.sevenDaySonnet.resetsAt, BUCKET_PERIOD_MS.sevenDay) : null;
    const ageMs = now - usage.fetchedAt;
    const ageSec = Math.round(ageMs / 1000);
    const ageLabel = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;

    let usageLine = chalk.dim(" Usage: ");
    // 5h
    usageLine += chalk.hex(usageColor(usage.fiveHour?.utilization ?? 0))(`5h: ${usage.fiveHour?.utilization ?? "?"}%`);
    if (cap5h !== null) usageLine += chalk.dim(`/${cap5h}%`);
    usageLine += chalk.dim(` (${usage.fiveHour ? formatResetTime(usage.fiveHour.resetsAt) : "?"}) `);
    usageLine += chalk.dim("| ");
    // 7d
    usageLine += chalk.hex(usageColor(usage.sevenDay?.utilization ?? 0))(`7d: ${usage.sevenDay?.utilization ?? "?"}%`);
    if (cap7d !== null) usageLine += chalk.dim(`/${cap7d}%`);
    usageLine += chalk.dim(` (${usage.sevenDay ? formatResetTime(usage.sevenDay.resetsAt) : "?"}) `);
    usageLine += chalk.dim("| ");
    // sonnet
    usageLine += chalk.hex(usageColor(usage.sevenDaySonnet?.utilization ?? 0))(`sonnet: ${usage.sevenDaySonnet?.utilization ?? "?"}%`);
    if (capModel !== null) usageLine += chalk.dim(`/${capModel}%`);
    usageLine += chalk.dim(` (${usage.sevenDaySonnet ? formatResetTime(usage.sevenDaySonnet.resetsAt) : "?"})`);
    usageLine += chalk.dim(" | ");
    usageLine += chalk.hex(ageMs > 5 * 60 * 1000 ? "#FF9500" : "#888888")(ageLabel);

    lines.push(usageLine);
  } else if (state.usageError) {
    const POLL_INTERVAL = 120;
    const secSinceAttempt = state.usageLastAttempt > 0 ? Math.round((now - state.usageLastAttempt) / 1000) : 0;
    const nextCheckIn = Math.max(0, POLL_INTERVAL - secSinceAttempt);
    lines.push(chalk.dim(" Usage: ") + orange(`rate-limited | next check ${nextCheckIn}s`));
  } else {
    lines.push(chalk.dim(" Usage: loading..."));
  }

  return lines;
}

// ─── StickyFooter (imperative API) ────────────────────────────────────

export class StickyFooter {
  private state: FooterState;
  private footerLineCount = 0;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private usagePollInterval: ReturnType<typeof setInterval> | null = null;
  private logWriter: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  private logFilePath: string | undefined;
  private maxLogLines: number;
  private logLineCount = 0;
  private headless: boolean;
  private active = false;

  constructor(logFilePath?: string, maxLogLines = 0, headless = false) {
    this.logFilePath = logFilePath;
    this.maxLogLines = maxLogLines;
    this.headless = headless;
    if (logFilePath) {
      this.logWriter = Bun.file(logFilePath).writer();
    }
    this.state = {
      liveStats: null,
      cumulative: {
        completedIterations: 0,
        totalDurationMs: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
      usage: null,
      usageError: false,
      usageLastAttempt: 0,
      throttleConfig: null,
    };
  }

  async activate(): Promise<void> {
    if (this.headless) return;
    this.active = true;

    // Draw initial footer
    this.drawFooter();

    // Redraw footer every second for live timer updates
    this.refreshInterval = setInterval(() => this.drawFooter(), 1000);

    // Load disk-cached usage immediately, then try a live fetch
    loadDiskCache().then((usage) => {
      if (usage) this.setUsage(usage);
    });
    fetchUsage().then((usage) => {
      if (usage) this.setUsage(usage);
      else if (!this.state.usage) {
        this.state.usageError = true;
        this.state.usageLastAttempt = Date.now();
        this.drawFooter();
      }
    });
    this.usagePollInterval = setInterval(() => {
      fetchUsage(true).then((usage) => {
        if (usage) this.setUsage(usage);
        else if (!this.state.usage) {
          this.state.usageError = true;
          this.state.usageLastAttempt = Date.now();
          this.drawFooter();
        }
      });
    }, 120_000);
  }

  deactivate(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.usagePollInterval) {
      clearInterval(this.usagePollInterval);
      this.usagePollInterval = null;
    }
    if (!this.active) return;
    this.active = false;

    // Clear the footer from the terminal
    this.clearFooter();
  }

  // ─── Footer Drawing ──────────────────────────────────────────────

  private clearFooter(): void {
    if (this.footerLineCount === 0) return;
    // Move cursor up and clear each footer line
    let esc = "";
    for (let i = 0; i < this.footerLineCount; i++) {
      esc += "\x1b[A"; // cursor up
      esc += "\r\x1b[K"; // beginning of line + clear to end
    }
    process.stdout.write(esc);
    this.footerLineCount = 0;
  }

  private drawFooter(): void {
    if (!this.active) return;
    // Erase old footer
    this.clearFooter();
    // Render new footer
    const lines = renderFooter(this.state);
    const output = lines.join("\n") + "\n";
    process.stdout.write(output);
    this.footerLineCount = lines.length;
  }

  // ─── Writing ─────────────────────────────────────────────────────

  write(text: string, style?: "orange"): void {
    // Write to log file
    if (this.logWriter) {
      const clean = stripAnsi(text);
      this.logWriter.write(clean);
      for (let i = 0; i < clean.length; i++) {
        if (clean[i] === "\n") this.logLineCount++;
      }
    }

    if (this.headless) return;

    // Clear footer, write content, redraw footer
    this.clearFooter();
    if (style === "orange") {
      process.stdout.write(text.replace(/[^\n]+/g, (m) => orange(m)));
    } else {
      process.stdout.write(text);
    }
    if (this.active) this.drawFooter();
  }

  writeln(text: string, style?: "orange"): void {
    this.write(text + "\n", style);
  }

  // ─── State Updates ───────────────────────────────────────────────

  onLiveStats: ((stats: LiveIterationStats) => void) | null = null;

  setLiveStats(stats: LiveIterationStats): void {
    this.state.liveStats = stats;
    this.onLiveStats?.(stats);
    // Footer redraws on the 1s timer — no need to force here
  }

  setCumulative(stats: CumulativeStats): void {
    this.state.cumulative = stats;
  }

  setUsage(usage: UsageData | null): void {
    this.state.usage = usage;
    if (usage) this.state.usageError = false;
  }

  setThrottleConfig(config: ThrottleConfig | null): void {
    this.state.throttleConfig = config;
  }

  getCumulative(): CumulativeStats {
    return this.state.cumulative;
  }

  // ─── Log Management ──────────────────────────────────────────────

  async flushAndTrimLog(): Promise<void> {
    if (!this.logWriter || !this.logFilePath || this.maxLogLines <= 0) return;
    if (this.logLineCount <= this.maxLogLines) return;

    await this.logWriter.flush();
    await this.logWriter.end();
    this.logWriter = null;

    await this.trimLog();
    this.logWriter = Bun.file(this.logFilePath).writer();
  }

  private async trimLog(): Promise<void> {
    if (!this.logFilePath || this.maxLogLines <= 0) return;
    if (this.logLineCount <= this.maxLogLines) return;

    const content = await Bun.file(this.logFilePath).text();
    const lines = content.split("\n");
    const trimmed = lines.slice(-this.maxLogLines);
    await Bun.write(this.logFilePath, trimmed.join("\n"));
    this.logLineCount = trimmed.length;
  }

  async closeLog(): Promise<void> {
    if (this.logWriter) {
      await this.logWriter.flush();
      await this.logWriter.end();
      this.logWriter = null;
      await this.trimLog();
    }
  }
}
