/**
 * Interactive session browser for cig-loop.
 *
 * Shows a list of running daemons with live stats and log preview.
 * Arrow keys to navigate, Enter to attach.
 */

import { createCliRenderer, type CliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useTerminalDimensions, type Root } from "@opentui/react";
import { useState, useEffect, useSyncExternalStore } from "react";
import chalk from "chalk";
import { listRuns, daemonRequest, type RunInfo } from "./daemon.js";
import { formatCost, formatDuration, formatNumber } from "./format.js";
import { AnsiText } from "./ansi.js";

// ─── Store ───────────────────────────────────────────────────────────

interface SessionsState {
  runs: RunInfo[];
  selectedIdx: number;
  preview: { lines: string[]; status: any } | null;
  loading: boolean;
}

class SessionsStore {
  private state: SessionsState = {
    runs: [],
    selectedIdx: 0,
    preview: null,
    loading: true,
  };
  private listeners = new Set<() => void>();

  getSnapshot = (): SessionsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.state = { ...this.state };
    for (const l of this.listeners) l();
  }

  setRuns(runs: RunInfo[]): void {
    this.state.runs = runs;
    this.state.loading = false;
    // Clamp selection
    if (this.state.selectedIdx >= runs.length) {
      this.state.selectedIdx = Math.max(0, runs.length - 1);
    }
    this.emit();
  }

  setSelectedIdx(idx: number): void {
    this.state.selectedIdx = idx;
    this.emit();
  }

  setPreview(preview: SessionsState["preview"]): void {
    this.state.preview = preview;
    this.emit();
  }
}

// ─── Components ──────────────────────────────────────────────────────

function SessionList({ runs, selectedIdx }: { runs: RunInfo[]; selectedIdx: number }) {
  if (runs.length === 0) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <text><span attributes={TextAttributes.DIM}>{"  No running sessions."}</span></text>
        <text><span>{" "}</span></text>
        <text><span attributes={TextAttributes.DIM}>{"  Start one with: cig-loop -p <prompt>"}</span></text>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {runs.map((run, i) => {
        const selected = i === selectedIdx;
        const phaseColor =
          run.phase === "running" ? "#50FA7B"
          : run.phase === "paused" || run.phase === "throttled" ? "#FFFF00"
          : run.phase === "suspended" ? "#FF9500"
          : run.phase === "stopping" ? "#FF5555"
          : "#888888";

        const iterLabel = run.totalIterations === 0
          ? `${run.iteration}/∞`
          : `${run.iteration}/${run.totalIterations}`;

        // Truncate prompt path for display
        const maxPromptLen = 40;
        let prompt = run.promptPath;
        if (prompt.length > maxPromptLen) {
          prompt = "…" + prompt.slice(-maxPromptLen + 1);
        }

        return (
          <box key={run.id} flexDirection="column">
            <text>
              <span
                fg={selected ? "#000000" : undefined}
                bg={selected ? "#5FAFAF" : undefined}
                attributes={selected ? TextAttributes.BOLD : 0}
              >
                {` ${run.id} `}
              </span>
              <span fg={phaseColor}>{` ${run.phase.padEnd(10)}`}</span>
              <span attributes={TextAttributes.DIM}>{` ${iterLabel.padEnd(8)}`}</span>
              <span attributes={TextAttributes.DIM}>{` ${prompt}`}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

function SessionPreview({ preview }: { preview: SessionsState["preview"] }) {
  if (!preview) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <text><span attributes={TextAttributes.DIM}>{"  Loading..."}</span></text>
      </box>
    );
  }

  const { status } = preview;
  const cum = status?.cumulative;
  const elapsed = status ? Date.now() - new Date(status.startedAt).getTime() : 0;

  return (
    <box flexDirection="column" flexGrow={1}>
      <text><span attributes={TextAttributes.BOLD}>{" Stats"}</span></text>
      {cum ? (
        <>
          <text><span attributes={TextAttributes.DIM}>{`  Uptime:     ${formatDuration(elapsed)}`}</span></text>
          <text><span attributes={TextAttributes.DIM}>{`  Cost:       ${formatCost(cum.totalCostUsd)}`}</span></text>
          <text><span attributes={TextAttributes.DIM}>{`  Tokens:     ${formatNumber(cum.totalInputTokens)} in / ${formatNumber(cum.totalOutputTokens)} out / ${formatNumber(cum.totalCacheReadTokens)} cache-read`}</span></text>
        </>
      ) : (
        <text><span attributes={TextAttributes.DIM}>{"  --"}</span></text>
      )}
      <text><span>{" "}</span></text>
      <text><span attributes={TextAttributes.BOLD}>{" Recent Output"}</span></text>
      <text><span attributes={TextAttributes.DIM}>{" " + "─".repeat(40)}</span></text>
      {preview.lines.length > 0 ? (
        preview.lines.map((line, i) => (
          <text key={i}><AnsiText text={" " + line} /></text>
        ))
      ) : (
        <text><span attributes={TextAttributes.DIM}>{"  (no output yet)"}</span></text>
      )}
    </box>
  );
}

function SessionBrowser({ store }: { store: SessionsStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { width, height } = useTerminalDimensions();

  const midpoint = Math.floor(width * 0.4);

  return (
    <box flexDirection="column" width={width} height={height}>
      <text><span attributes={TextAttributes.BOLD}>{" cig-loop sessions"}</span></text>
      <text><span attributes={TextAttributes.DIM}>{" ↑/↓ navigate  Enter attach  x stop  q quit"}</span></text>
      <text><span attributes={TextAttributes.DIM}>{"─".repeat(width)}</span></text>
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" width={midpoint}>
          <SessionList runs={state.runs} selectedIdx={state.selectedIdx} />
        </box>
        <box flexDirection="column" width={1}>
          <text><span attributes={TextAttributes.DIM}>{"│"}</span></text>
        </box>
        <box flexDirection="column" flexGrow={1}>
          <SessionPreview preview={state.preview} />
        </box>
      </box>
    </box>
  );
}

// ─── Entry Point ─────────────────────────────────────────────────────

export async function runSessionBrowser(): Promise<void> {
  const store = new SessionsStore();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
    useMouse: false,
    autoFocus: false,
  });
  const root = createRoot(renderer);
  root.render(<SessionBrowser store={store} />);

  // Track which session ID to attach to (set on Enter)
  let attachId: string | null = null;

  // Keyboard handling
  renderer.keyInput.on("keypress", (event) => {
    const key = event.name?.toLowerCase();
    const state = store.getSnapshot();

    if (key === "q" || (key === "c" && event.ctrl)) {
      root.unmount();
      renderer.destroy();
      process.stdout.write("\x1b[?1049l");
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.exit(0);
    }

    if (key === "up" || key === "k") {
      store.setSelectedIdx(Math.max(0, state.selectedIdx - 1));
      fetchPreview();
    }

    if (key === "down" || key === "j") {
      store.setSelectedIdx(Math.min(state.runs.length - 1, state.selectedIdx + 1));
      fetchPreview();
    }

    if (key === "return") {
      const selected = state.runs[state.selectedIdx];
      if (selected) {
        attachId = selected.id;
        // Clean up TUI
        root.unmount();
        renderer.destroy();
        process.stdout.write("\x1b[?1049l");
        if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      }
    }

    if (key === "x") {
      const selected = state.runs[state.selectedIdx];
      if (selected) {
        daemonRequest(selected.socketPath, "/force-quit", "POST").catch(() => {});
        // Refresh after a brief delay to let the daemon shut down
        setTimeout(refresh, 500);
      }
    }
  });

  // Fetch runs and preview data
  async function refresh() {
    const runs = await listRuns();
    store.setRuns(runs);
    await fetchPreview();
  }

  async function fetchPreview() {
    const state = store.getSnapshot();
    const selected = state.runs[state.selectedIdx];
    if (!selected) {
      store.setPreview(null);
      return;
    }

    try {
      const [status, logResult] = await Promise.all([
        daemonRequest(selected.socketPath, "/status"),
        daemonRequest(selected.socketPath, "/log?lines=20"),
      ]);
      store.setPreview({
        lines: logResult.lines || [],
        status,
      });
    } catch {
      store.setPreview({ lines: ["(connection error)"], status: null });
    }
  }

  // Initial fetch
  await refresh();

  // Periodic refresh
  const refreshTimer = setInterval(refresh, 2000);

  // Wait for attach selection
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (attachId !== null) {
        clearInterval(check);
        clearInterval(refreshTimer);
        resolve();
      }
    }, 100);
  });

  // Attach to the selected session
  if (attachId) {
    const { cmdAttach } = await import("./daemon-cli.js");
    await cmdAttach(attachId);
  }
}
