/**
 * Terminal management for the sticky footer.
 *
 * Uses ANSI escape sequences to create a scroll region in the upper portion
 * of the terminal, reserving the bottom lines for a persistent status footer.
 * Claude's streaming output scrolls naturally in the upper region while the
 * footer stays pinned.
 */

import chalk from "chalk";
import { formatCost, formatDuration, formatNumber } from "./format.js";
import type { CumulativeStats, LiveIterationStats } from "./types.js";

const FOOTER_LINES = 4; // separator + 3 content lines
const ESC = "\x1B";

/** Move cursor to specific row, col (1-based) */
function moveTo(row: number, col: number): string {
  return `${ESC}[${row};${col}H`;
}

/** Set scrolling region (1-based, inclusive) */
function setScrollRegion(top: number, bottom: number): string {
  return `${ESC}[${top};${bottom}r`;
}

/** Reset scrolling region to full terminal */
function resetScrollRegion(): string {
  return `${ESC}[r`;
}

/** Save cursor position */
function saveCursor(): string {
  return `${ESC}7`;
}

/** Restore cursor position */
function restoreCursor(): string {
  return `${ESC}8`;
}

/** Clear from cursor to end of line */
function clearLine(): string {
  return `${ESC}[2K`;
}

/**
 * Build a progress bar string.
 * e.g. [=======>          ] 30%
 */
function progressBar(current: number, total: number, width = 20): string {
  if (total === 0) {
    // Infinite mode: show a spinner-style bar
    const pos = current % (width * 2);
    const idx = pos < width ? pos : width * 2 - pos;
    const bar = " ".repeat(idx) + "<=>" + " ".repeat(Math.max(0, width - idx - 3));
    return `[${bar}]`;
  }

  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);
  const bar = "=".repeat(Math.max(0, filled - 1)) + (filled > 0 ? ">" : "") + " ".repeat(empty);
  return `[${bar}] ${pct}%`;
}

export class StickyFooter {
  private rows: number = 0;
  private cols: number = 0;
  private active = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private liveStats: LiveIterationStats | null = null;
  private cumulative: CumulativeStats = {
    completedIterations: 0,
    totalDurationMs: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
  private logWriter: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;

  constructor(logFilePath?: string) {
    if (logFilePath) {
      this.logWriter = Bun.file(logFilePath).writer();
    }
  }

  /** Activate the sticky footer: set scroll region and start redraw timer. */
  activate(): void {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;

    const scrollBottom = this.rows - FOOTER_LINES;
    if (scrollBottom < 2) {
      // Terminal too small for footer, skip
      return;
    }

    this.active = true;

    // Push existing content up to make room for the footer at the bottom,
    // then position the cursor at the bottom of the scroll region.
    // This avoids jumping to row 1 and overwriting the config summary.
    const padding = "\n".repeat(FOOTER_LINES + 1);
    process.stdout.write(padding);

    // Set scroll region to exclude the footer area
    process.stdout.write(setScrollRegion(1, scrollBottom));

    // Position cursor at the bottom of the scroll region (not row 1!)
    // so new output continues naturally from here
    process.stdout.write(moveTo(scrollBottom, 1));

    // Draw initial footer
    this.drawFooter();

    // Redraw footer every second (for live duration timer)
    this.timer = setInterval(() => {
      this.drawFooter();
    }, 1000);

    // Handle terminal resize
    process.stdout.on("resize", this.handleResize);
  }

  /** Deactivate: reset scroll region, stop timer, restore normal terminal. */
  deactivate(): void {
    if (!this.active) return;

    this.active = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    process.stdout.removeListener("resize", this.handleResize);

    // Reset scroll region
    process.stdout.write(resetScrollRegion());
    // Move to bottom of terminal
    process.stdout.write(moveTo(this.rows, 1));
    // Clear footer lines
    for (let i = 0; i < FOOTER_LINES; i++) {
      process.stdout.write(clearLine() + "\n");
    }
    // Move cursor back up
    process.stdout.write(`${ESC}[${FOOTER_LINES}A`);
  }

  /** Write text to the scrolling output area (above the footer). */
  write(text: string): void {
    if (this.logWriter) {
      this.logWriter.write(text);
    }

    if (!this.active) {
      process.stdout.write(text);
      return;
    }

    // The scroll region is already set, so just write directly.
    // The terminal will scroll within the region automatically.
    process.stdout.write(text);
  }

  /** Write a line to the scrolling output area. */
  writeln(text: string): void {
    this.write(text + "\n");
  }

  /** Update the live stats for the current iteration. */
  setLiveStats(stats: LiveIterationStats): void {
    this.liveStats = stats;
  }

  /** Update cumulative totals (call after each iteration completes). */
  setCumulative(stats: CumulativeStats): void {
    this.cumulative = stats;
  }

  /** Get the cumulative stats. */
  getCumulative(): CumulativeStats {
    return this.cumulative;
  }

  /** Flush and close the log writer. */
  async closeLog(): Promise<void> {
    if (this.logWriter) {
      await this.logWriter.flush();
      await this.logWriter.end();
    }
  }

  private handleResize = (): void => {
    const newRows = process.stdout.rows || 24;
    const newCols = process.stdout.columns || 80;

    // Skip if nothing changed
    if (newRows === this.rows && newCols === this.cols) return;

    this.rows = newRows;
    this.cols = newCols;

    const scrollBottom = this.rows - FOOTER_LINES;
    if (scrollBottom < 2) return;

    // Reset scroll region, clear the footer area at the new position,
    // re-set the scroll region, and position cursor at the bottom of the scroll area
    process.stdout.write(
      resetScrollRegion() +
      saveCursor() +
      moveTo(scrollBottom + 1, 1) +
      clearLine() + "\n" + clearLine() + "\n" + clearLine() + "\n" + clearLine() +
      restoreCursor() +
      setScrollRegion(1, scrollBottom)
    );

    this.drawFooter();
  };

  private drawFooter(): void {
    if (!this.active) return;

    const w = this.cols;
    const footerStartRow = this.rows - FOOTER_LINES + 1;

    // Build footer lines
    const separator = chalk.dim("-".repeat(w));

    let line1: string;
    let line2: string;
    let line3: string;

    if (this.liveStats) {
      const s = this.liveStats;
      const elapsed = Date.now() - s.startTime;
      const iterLabel = s.totalIterations === 0
        ? `Iteration ${s.iteration} (infinite)`
        : `Iteration ${s.iteration}/${s.totalIterations}`;
      const bar = progressBar(s.iteration, s.totalIterations);

      line1 = ` ${iterLabel} ${bar}`;
      line2 = ` Current:  ${formatDuration(elapsed)} | ${formatCost(s.costUsd)} | ${formatNumber(s.inputTokens)} in / ${formatNumber(s.outputTokens)} out`;
    } else {
      line1 = " Waiting...";
      line2 = "";
    }

    const c = this.cumulative;
    if (c.completedIterations > 0) {
      line3 = ` Totals:   ${formatDuration(c.totalDurationMs)} | ${formatCost(c.totalCostUsd)} | ${formatNumber(c.totalInputTokens)} in / ${formatNumber(c.totalOutputTokens)} out`;
    } else {
      line3 = " Totals:   --";
    }

    // Pad/truncate lines to terminal width
    line1 = padRight(line1, w);
    line2 = padRight(line2, w);
    line3 = padRight(line3, w);

    // Write footer without disturbing the scroll region cursor
    process.stdout.write(
      saveCursor() +
      moveTo(footerStartRow, 1) + separator +
      moveTo(footerStartRow + 1, 1) + clearLine() + chalk.bold(line1) +
      moveTo(footerStartRow + 2, 1) + clearLine() + chalk.cyan(line2) +
      moveTo(footerStartRow + 3, 1) + clearLine() + chalk.yellow(line3) +
      restoreCursor()
    );
  }
}

function padRight(str: string, width: number): string {
  // Strip ANSI to measure visible length
  const visible = str.replace(/\x1B\[[0-9;]*m/g, "");
  if (visible.length >= width) return str;
  return str + " ".repeat(width - visible.length);
}
