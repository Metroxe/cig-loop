/**
 * Terminal UI using Ink (React for CLIs).
 *
 * Replaces raw ANSI escape sequences with Ink's layout engine.
 * The StickyFooter class provides the same imperative API as before,
 * backed by a React component tree that Ink manages.
 */

import React, { useState, useEffect, useSyncExternalStore } from "react";
import { render, Box, Text, Static } from "ink";
import chalk from "chalk";
import { formatCost, formatDuration, formatNumber } from "./format.js";
import type { CumulativeStats, LiveIterationStats } from "./types.js";

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
        currentLine = parts[i];
      }
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
      <Box flexDirection="column" marginLeft={2}>
        {Array.from({ length: SMOKE_HEIGHT - 1 }, (_, i) => (
          <Text key={i}>{" "}</Text>
        ))}
        <Text dimColor>{" ".repeat(gapPad) + gapCountStr}</Text>
        <Text>{" "}</Text>
      </Box>
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
    <Box flexDirection="column" marginLeft={2}>
      {smokeLines.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
      <Text>
        {" ".repeat(cigPad)}
        {isLighting ? (
          <Text>🔥</Text>
        ) : isUnlit ? (
          <Text color="#F0E8D8">{"▓▓"}</Text>
        ) : (
          <Text color="#FF6B35">
            {EMBER_CYCLE[frame % EMBER_CYCLE.length]}
          </Text>
        )}
        {paperLen > 0 ? (
          <Text color="#F0E8D8">{"▓".repeat(paperLen)}</Text>
        ) : null}
        <Text color="#CD853F">{"▒".repeat(7)}</Text>
      </Text>
    </Box>
  );
}

// ─── Footer Component ─────────────────────────────────────────────────

function Footer({
  liveStats,
  cumulative,
}: {
  liveStats: LiveIterationStats | null;
  cumulative: CumulativeStats;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const cols = process.stdout.columns || 80;

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
    line2 = ` ▸ Current:  ${formatDuration(elapsed)} │ ${formatNumber(liveStats.inputTokens)} in / ${formatNumber(liveStats.outputTokens)} out`;
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
    <Box flexDirection="column">
      <Text dimColor>{"━".repeat(cols)}</Text>
      <Box
        flexDirection={isWide ? "row" : "column"}
        alignItems={isWide ? "center" : undefined}
      >
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>{line1}</Text>
          <Text color="cyan">{line2}</Text>
          <Text color="yellow">{line3}</Text>
          <Text dimColor>{" Usage: https://claude.ai/settings/usage"}</Text>
        </Box>
        <SmokingCigarette />
      </Box>
    </Box>
  );
}

// ─── App Component ────────────────────────────────────────────────────

function App({ store }: { store: TerminalStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <Box flexDirection="column">
      <Static items={state.lines}>
        {(line) => (
          <Text key={line.id} color={line.style === "orange" ? "#FF9500" : undefined}>
            {line.text || " "}
          </Text>
        )}
      </Static>
      {state.currentLine ? (
        <Text color={state.currentLineStyle === "orange" ? "#FF9500" : undefined}>
          {state.currentLine}
        </Text>
      ) : null}
      <Footer liveStats={state.liveStats} cumulative={state.cumulative} />
    </Box>
  );
}

// ─── StickyFooter (imperative API) ────────────────────────────────────

type InkInstance = ReturnType<typeof render>;

export class StickyFooter {
  private store = new TerminalStore();
  private inkInstance: InkInstance | null = null;
  private logWriter: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null =
    null;

  constructor(logFilePath?: string) {
    if (logFilePath) {
      this.logWriter = Bun.file(logFilePath).writer();
    }
  }

  activate(): void {
    this.inkInstance = render(<App store={this.store} />, {
      exitOnCtrlC: false,
      patchConsole: false,
    });
  }

  deactivate(): void {
    if (this.inkInstance) {
      this.inkInstance.unmount();
      this.inkInstance = null;
    }
  }

  write(text: string, style?: "orange"): void {
    if (this.logWriter) {
      this.logWriter.write(text);
    }

    if (this.inkInstance) {
      this.store.write(text, style);
    } else {
      // Non-Ink fallback: apply color inline via ANSI codes
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

  setLiveStats(stats: LiveIterationStats): void {
    this.store.setLiveStats(stats);
  }

  setCumulative(stats: CumulativeStats): void {
    this.store.setCumulative(stats);
  }

  getCumulative(): CumulativeStats {
    return this.store.getSnapshot().cumulative;
  }

  async closeLog(): Promise<void> {
    if (this.logWriter) {
      await this.logWriter.flush();
      await this.logWriter.end();
    }
  }
}
