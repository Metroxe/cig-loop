/**
 * Terminal UI using OpenTUI (cell-based TUI framework).
 *
 * Uses OpenTUI's React reconciler with absolute-position cell diffing,
 * which avoids the eraseLines / line-count mismatch issues that Ink
 * has in tmux.
 *
 * The StickyFooter class provides the same imperative API as before,
 * backed by a React component tree that OpenTUI manages.
 */

import { createCliRenderer, type CliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useTerminalDimensions, type Root } from "@opentui/react";
import { useState, useEffect, useSyncExternalStore } from "react";
import chalk from "chalk";
import { formatCost, formatDuration, formatNumber, stripAnsi } from "./format.js";
import { AnsiText } from "./ansi.js";
import { fetchUsage, formatResetTime, getDynamicThreshold, BUCKET_PERIOD_MS } from "./usage.js";
import type { CumulativeStats, LiveIterationStats, UsageData, ThrottleConfig } from "./types.js";

const orange = chalk.hex("#FF9500");

// ─── Store ────────────────────────────────────────────────────────────

interface LineItem {
  id: number;
  text: string;
  style?: "orange";
}

interface StoreState {
  lines: LineItem[];
  currentLine: string;
  currentLineStyle?: "orange";
  liveStats: LiveIterationStats | null;
  cumulative: CumulativeStats;
  usage: UsageData | null;
  throttleConfig: ThrottleConfig | null;
}

class TerminalStore {
  private state: StoreState;
  private lineCounter = 0;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = {
      lines: [],
      currentLine: "",
      liveStats: null,
      cumulative: {
        completedIterations: 0,
        totalDurationMs: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
      usage: null,
      throttleConfig: null,
    };
  }

  getSnapshot = (): StoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.state = { ...this.state };
    for (const l of this.listeners) l();
  }

  write(text: string, style?: "orange"): void {
    const parts = text.split("\n");

    if (parts.length === 1) {
      // No newlines — just append to current line
      this.state.currentLine += parts[0];
      if (style !== undefined) this.state.currentLineStyle = style;
      this.emit();
      return;
    }

    // Flush complete lines
    const newLines = [...this.state.lines];
    let currentLine = this.state.currentLine;
    // First committed line inherits existing style (or overrides with new style)
    let lineStyle: "orange" | undefined = style ?? this.state.currentLineStyle;

    for (let i = 0; i < parts.length; i++) {
      if (i < parts.length - 1) {
        newLines.push({ id: this.lineCounter++, text: currentLine + parts[i], style: lineStyle });
        currentLine = "";
        lineStyle = style; // subsequent lines use only this write's style
      } else {
        currentLine = parts[i]!;
      }
    }

    // Cap display lines at 5000 to keep scrollbox performant
    if (newLines.length > 5000) {
      newLines.splice(0, newLines.length - 5000);
    }

    this.state.lines = newLines;
    this.state.currentLine = currentLine;
    // Only carry style forward if there's content on the current line
    this.state.currentLineStyle = currentLine ? style : undefined;
    this.emit();
  }

  writeln(text: string): void {
    this.write(text + "\n");
  }

  setLiveStats(stats: LiveIterationStats): void {
    this.state.liveStats = stats;
    this.emit();
  }

  setCumulative(stats: CumulativeStats): void {
    this.state.cumulative = stats;
    this.emit();
  }

  setUsage(usage: UsageData | null): void {
    this.state.usage = usage;
    this.emit();
  }

  setThrottleConfig(config: ThrottleConfig | null): void {
    this.state.throttleConfig = config;
    this.emit();
  }

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

// ─── Smoking Cigarette ────────────────────────────────────────────────

const SMOKE_CYCLE = [
  ")( )(",
  "( )( ",
  " )()(",
  "() ( ",
  " )( )",
  "( )((",
  ")( ) ",
  " ()( ",
  ")(  (",
  "( )()",
  " )(()",
  "() ( ",
];
const EMBER_CYCLE = ["·:", ":·", "·.", ".:", ":.", "·:"];
const SMOKE_HEIGHT = 3;
const SMOKE_DRIFT = 1;
const BURN_DURATION_MS = 6 * 60 * 1000; // 6 minutes per cigarette
const BETWEEN_CIGS_MS = 10_000; // ~10s to pull one from the pack
const UNLIT_MS = 3_000; // unlit, just sitting there
const LIGHTING_MS = 3_000; // 🔥 at the tip
const SMOKE_BUILDUP_MS = 3_000; // smoke grows from 0 to full height
const CIG_CYCLE_MS = BURN_DURATION_MS + BETWEEN_CIGS_MS;
const CIG_EPOCH = Date.now();
const PAPER_FULL = 18;

function SmokingCigarette() {
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SMOKE_CYCLE.length);
      setNow(Date.now());
    }, 400);
    return () => clearInterval(timer);
  }, []);

  const totalElapsed = now - CIG_EPOCH;
  const cyclePos = totalElapsed % CIG_CYCLE_MS;
  const cigsSmoked = Math.floor(totalElapsed / CIG_CYCLE_MS);

  // Between-cigs gap: keep same height, count on last line
  if (cyclePos >= BURN_DURATION_MS) {
    const gapFilterEnd = (SMOKE_HEIGHT - 1) * SMOKE_DRIFT + 3 + 2 + PAPER_FULL + 7;
    const gapCountStr = `${cigsSmoked}`;
    const gapPad = Math.max(1, gapFilterEnd - gapCountStr.length);
    return (
      <box flexDirection="column" marginLeft={2}>
        {Array.from({ length: SMOKE_HEIGHT - 1 }, (_, i) => (
          <text key={i}>
            <span>{" "}</span>
          </text>
        ))}
        <text>
          <span attributes={TextAttributes.DIM}>{" ".repeat(gapPad) + gapCountStr}</span>
        </text>
        <text>
          <span>{" "}</span>
        </text>
      </box>
    );
  }

  // Phases
  const isUnlit = cyclePos < UNLIT_MS;
  const isLighting =
    cyclePos >= UNLIT_MS && cyclePos < UNLIT_MS + LIGHTING_MS;
  const smokingStart = UNLIT_MS + LIGHTING_MS;
  const smokingElapsed = Math.max(0, cyclePos - smokingStart);
  const smokingDuration = BURN_DURATION_MS - smokingStart;

  // Paper burns only during smoking phase
  const burnProgress =
    smokingDuration > 0 ? smokingElapsed / smokingDuration : 0;
  const paperLen = Math.max(0, Math.round(PAPER_FULL * (1 - burnProgress)));

  // Smoke builds up gradually after lighting
  const visibleSmoke =
    isUnlit || isLighting
      ? 0
      : Math.min(
          SMOKE_HEIGHT,
          Math.floor(
            (smokingElapsed / SMOKE_BUILDUP_MS) * (SMOKE_HEIGHT + 1)
          )
        );

  // Always render SMOKE_HEIGHT lines — empty placeholders until visible
  const bottomPad = (SMOKE_HEIGHT - 1) * SMOKE_DRIFT;
  const cigPad = bottomPad + 3;
  const smokeStartIdx = SMOKE_HEIGHT - visibleSmoke;
  const smokeLines: string[] = [];
  for (let i = 0; i < SMOKE_HEIGHT; i++) {
    if (i < smokeStartIdx) {
      smokeLines.push(" ");
    } else {
      smokeLines.push(
        " ".repeat(i * SMOKE_DRIFT) +
          SMOKE_CYCLE[(frame + i) % SMOKE_CYCLE.length]!
      );
    }
  }

  // Embed count on the bottom smoke line, right-aligned to filter end
  const countStr = `${cigsSmoked}`;
  const filterEnd = cigPad + 2 + paperLen + 7;
  const lastIdx = SMOKE_HEIGHT - 1;
  const lastLineWidth =
    lastIdx < smokeStartIdx ? 1 : lastIdx * SMOKE_DRIFT + 5;
  const countPad = Math.max(1, filterEnd - lastLineWidth - countStr.length);
  smokeLines[lastIdx] += " ".repeat(countPad) + countStr;

  return (
    <box flexDirection="column" marginLeft={2}>
      {smokeLines.map((line, i) => (
        <text key={i}>
          <span attributes={TextAttributes.DIM}>{line}</span>
        </text>
      ))}
      <text>
        {" ".repeat(cigPad)}
        {isLighting ? (
          <span>🔥</span>
        ) : isUnlit ? (
          <span fg="#F0E8D8">{"▓▓"}</span>
        ) : (
          <span fg="#FF6B35">
            {EMBER_CYCLE[frame % EMBER_CYCLE.length]}
          </span>
        )}
        {paperLen > 0 ? (
          <span fg="#F0E8D8">{"▓".repeat(paperLen)}</span>
        ) : ""}
        <span fg="#CD853F">{"▒".repeat(7)}</span>
      </text>
    </box>
  );
}

// ─── Footer Component ─────────────────────────────────────────────────

function usageColor(pct: number): string {
  if (pct >= 80) return "#FF5555";
  if (pct >= 50) return "#FFFF00";
  return "#50FA7B";
}

function Footer({
  liveStats,
  cumulative,
  usage,
  throttleConfig,
}: {
  liveStats: LiveIterationStats | null;
  cumulative: CumulativeStats;
  usage: UsageData | null;
  throttleConfig: ThrottleConfig | null;
}) {
  const [now, setNow] = useState(Date.now());
  const { width: cols } = useTerminalDimensions();

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  let line1: string;
  let line2: string;

  if (liveStats) {
    const elapsed = now - liveStats.startTime;
    const iterLabel =
      liveStats.totalIterations === 0
        ? `Iteration ${liveStats.iteration} (infinite)`
        : `Iteration ${liveStats.iteration}/${liveStats.totalIterations}`;
    const bar = progressBar(liveStats.iteration, liveStats.totalIterations);

    line1 = ` ${iterLabel} ${bar}`;
    line2 = ` ▸ Current:  ${formatDuration(elapsed)} │ ${formatNumber(liveStats.inputTokens)} in / ${formatNumber(liveStats.outputTokens)} out │ ${Math.round(liveStats.contextPercent)}% context`;
  } else {
    line1 = " Waiting...";
    line2 = "";
  }

  // Totals = completed iterations + current in-progress iteration
  const totalDurationMs = cumulative.totalDurationMs + (liveStats ? now - liveStats.startTime : 0);
  const totalInputTokens = cumulative.totalInputTokens + (liveStats ? liveStats.inputTokens : 0);
  const totalOutputTokens = cumulative.totalOutputTokens + (liveStats ? liveStats.outputTokens : 0);

  let line3: string;
  if (cumulative.completedIterations > 0 || liveStats) {
    line3 = ` ▸ Totals:   ${formatDuration(totalDurationMs)} │ ${formatNumber(totalInputTokens)} in / ${formatNumber(totalOutputTokens)} out │ ${formatCost(cumulative.totalCostUsd)}`;
  } else {
    line3 = " Totals:   --";
  }

  const isWide = cols >= 90;

  return (
    <box flexDirection="column" flexShrink={0}>
      <text>
        <span attributes={TextAttributes.DIM}>{"━".repeat(cols)}</span>
      </text>
      <box
        flexDirection={isWide ? "row" : "column"}
        alignItems={isWide ? "flex-start" : undefined}
      >
        <box flexDirection="column" flexGrow={1}>
          <text>
            <b>{line1}</b>
          </text>
          <text>
            <span fg="#5FAFAF">{line2}</span>
          </text>
          <text>
            <span fg="#FFFF00">{line3}</span>
          </text>
          {usage ? (() => {
            const isDynamic = throttleConfig?.dynamic ?? false;
            const cap5h = isDynamic && usage.fiveHour ? getDynamicThreshold(usage.fiveHour.resetsAt, BUCKET_PERIOD_MS.fiveHour) : null;
            const cap7d = isDynamic && usage.sevenDay ? getDynamicThreshold(usage.sevenDay.resetsAt, BUCKET_PERIOD_MS.sevenDay) : null;
            const capModel = isDynamic && usage.sevenDaySonnet ? getDynamicThreshold(usage.sevenDaySonnet.resetsAt, BUCKET_PERIOD_MS.sevenDay) : null;
            return (
            <text>
              <span attributes={TextAttributes.DIM}>{" Usage: "}</span>
              <span fg={usageColor(usage.fiveHour?.utilization ?? 0)}>
                {`5h: ${usage.fiveHour?.utilization ?? "?"}%`}
              </span>
              {cap5h !== null ? (
                <span attributes={TextAttributes.DIM}>{`/${cap5h}%`}</span>
              ) : null}
              <span attributes={TextAttributes.DIM}>
                {` (${usage.fiveHour ? formatResetTime(usage.fiveHour.resetsAt) : "?"}) `}
              </span>
              <span attributes={TextAttributes.DIM}>{"│ "}</span>
              <span fg={usageColor(usage.sevenDay?.utilization ?? 0)}>
                {`7d: ${usage.sevenDay?.utilization ?? "?"}%`}
              </span>
              {cap7d !== null ? (
                <span attributes={TextAttributes.DIM}>{`/${cap7d}%`}</span>
              ) : null}
              <span attributes={TextAttributes.DIM}>
                {` (${usage.sevenDay ? formatResetTime(usage.sevenDay.resetsAt) : "?"}) `}
              </span>
              <span attributes={TextAttributes.DIM}>{"│ "}</span>
              <span fg={usageColor(usage.sevenDaySonnet?.utilization ?? 0)}>
                {`sonnet: ${usage.sevenDaySonnet?.utilization ?? "?"}%`}
              </span>
              {capModel !== null ? (
                <span attributes={TextAttributes.DIM}>{`/${capModel}%`}</span>
              ) : null}
              <span attributes={TextAttributes.DIM}>
                {` (${usage.sevenDaySonnet ? formatResetTime(usage.sevenDaySonnet.resetsAt) : "?"})`}
              </span>
            </text>
            );
          })() : (
            <text>
              <span attributes={TextAttributes.DIM}>{" Usage: https://claude.ai/settings/usage"}</span>
            </text>
          )}
        </box>
        {!isWide && <text><span>{" "}</span></text>}
        <SmokingCigarette />
      </box>
    </box>
  );
}

// ─── App Component ────────────────────────────────────────────────────

function App({ store }: { store: TerminalStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { width, height } = useTerminalDimensions();

  return (
    <box flexDirection="column" width={width} height={height}>
      <scrollbox flexGrow={1} stickyScroll={true} stickyStart="bottom">
        {state.lines.map((line) => (
          <text key={line.id}>
            {line.style === "orange" ? (
              <span fg="#FF9500">{line.text || " "}</span>
            ) : (
              <AnsiText text={line.text || " "} />
            )}
          </text>
        ))}
        {state.currentLine ? (
          <text>
            {state.currentLineStyle === "orange" ? (
              <span fg="#FF9500">{state.currentLine}</span>
            ) : (
              <AnsiText text={state.currentLine} />
            )}
          </text>
        ) : null}
      </scrollbox>
      <Footer liveStats={state.liveStats} cumulative={state.cumulative} usage={state.usage} throttleConfig={state.throttleConfig} />
    </box>
  );
}

// ─── StickyFooter (imperative API) ────────────────────────────────────

export class StickyFooter {
  private store = new TerminalStore();
  private renderer: CliRenderer | null = null;
  private root: Root | null = null;
  private logWriter: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null =
    null;
  private logFilePath: string | undefined;
  private maxLogLines: number;
  private logLineCount = 0;
  private usagePollInterval: ReturnType<typeof setInterval> | null = null;
  private headless: boolean;

  constructor(logFilePath?: string, maxLogLines = 0, headless = false) {
    this.logFilePath = logFilePath;
    this.maxLogLines = maxLogLines;
    this.headless = headless;
    if (logFilePath) {
      this.logWriter = Bun.file(logFilePath).writer();
    }
  }

  async activate(): Promise<void> {
    if (this.headless) {
      // In headless mode, skip TUI entirely — only log to file
      return;
    }

    this.renderer = await createCliRenderer({
      exitOnCtrlC: false,
      useAlternateScreen: true,
      useMouse: false,
      autoFocus: false,
    });
    this.root = createRoot(this.renderer);
    this.root.render(<App store={this.store} />);

    // In raw mode, Ctrl+C doesn't generate SIGINT — it arrives as byte 0x03
    // on stdin. OpenTUI parses it as a keypress but with exitOnCtrlC:false it's
    // silently dropped. Re-raise SIGINT so process-level signal handlers work.
    this.renderer.keyInput.on("keypress", (event) => {
      if (event.name === "c" && event.ctrl) {
        process.kill(process.pid, "SIGINT");
      }
    });

    // Start background usage polling
    fetchUsage().then((usage) => {
      if (usage) this.store.setUsage(usage);
    });
    this.usagePollInterval = setInterval(() => {
      fetchUsage(true).then((usage) => {
        if (usage) this.store.setUsage(usage);
      });
    }, 60_000);
  }

  deactivate(): void {
    if (this.usagePollInterval) {
      clearInterval(this.usagePollInterval);
      this.usagePollInterval = null;
    }
    if (this.headless) return;

    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
    // Forcibly leave alternate screen and raw mode.
    // renderer.destroy() can be deferred if a render is in progress,
    // so the terminal may still be in alternate screen when this returns.
    process.stdout.write("\x1b[?1049l");
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
    // Dump scroll buffer to stdout so it persists in terminal scrollback
    const state = this.store.getSnapshot();
    for (const line of state.lines) {
      const text = line.style === "orange" ? orange(line.text) : line.text;
      process.stdout.write(text + "\n");
    }
    if (state.currentLine) {
      const text = state.currentLineStyle === "orange" ? orange(state.currentLine) : state.currentLine;
      process.stdout.write(text + "\n");
    }
  }

  write(text: string, style?: "orange"): void {
    if (this.logWriter) {
      const clean = stripAnsi(text);
      this.logWriter.write(clean);
      // Track newlines for rolling log
      for (let i = 0; i < clean.length; i++) {
        if (clean[i] === "\n") this.logLineCount++;
      }
    }

    if (this.renderer) {
      this.store.write(text, style);
    } else if (!this.headless) {
      // Fallback: apply color inline via ANSI codes
      if (style === "orange") {
        process.stdout.write(text.replace(/[^\n]+/g, (m) => orange(m)));
      } else {
        process.stdout.write(text);
      }
    }
  }

  writeln(text: string, style?: "orange"): void {
    this.write(text + "\n", style);
  }

  onLiveStats: ((stats: LiveIterationStats) => void) | null = null;

  setLiveStats(stats: LiveIterationStats): void {
    this.store.setLiveStats(stats);
    this.onLiveStats?.(stats);
  }

  setCumulative(stats: CumulativeStats): void {
    this.store.setCumulative(stats);
  }

  setUsage(usage: UsageData | null): void {
    this.store.setUsage(usage);
  }

  setThrottleConfig(config: ThrottleConfig | null): void {
    this.store.setThrottleConfig(config);
  }

  getCumulative(): CumulativeStats {
    return this.store.getSnapshot().cumulative;
  }

  /**
   * Flush the log writer and trim if over the line limit.
   * Safe to call mid-run — reopens the writer after trimming.
   */
  async flushAndTrimLog(): Promise<void> {
    if (!this.logWriter || !this.logFilePath || this.maxLogLines <= 0) return;
    if (this.logLineCount <= this.maxLogLines) return;

    await this.logWriter.flush();
    await this.logWriter.end();
    this.logWriter = null;

    await this.trimLog();

    // Reopen writer in append mode
    this.logWriter = Bun.file(this.logFilePath).writer();
  }

  /**
   * Trim the log file to the most recent maxLogLines lines.
   * Called after flushing the writer so the file is complete on disk.
   */
  private async trimLog(): Promise<void> {
    if (!this.logFilePath || this.maxLogLines <= 0) return;
    if (this.logLineCount <= this.maxLogLines) return;

    const content = await Bun.file(this.logFilePath).text();
    const lines = content.split("\n");
    // Keep the last maxLogLines lines (plus trailing empty if present)
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
