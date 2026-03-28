/**
 * Daemon mode for cig-loop.
 *
 * Runs the loop headless with a Unix socket control server.
 * State is persisted to ~/.cig-loop/runs/<id>/ for discovery by client commands.
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import type { CumulativeStats, LiveIterationStats, LoopConfig } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────

const RUNS_DIR = `${process.env.HOME}/.cig-loop/runs`;

// ─── Types ──────────────────────────────────────────────────────────────

export interface DaemonState {
  id: string;
  pid: number;
  startedAt: string;
  cwd: string;
  promptPath: string;
  phase: "starting" | "running" | "throttled" | "paused" | "stopping" | "stopped";
  iteration: number;
  totalIterations: number;
  cumulative: CumulativeStats;
  live: LiveIterationStats | null;
  stopReason?: string;
}

// ─── ID Generation ──────────────────────────────────────────────────────

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ─── Daemon Controller ──────────────────────────────────────────────────

export class DaemonController {
  readonly id: string;
  readonly runDir: string;
  readonly socketPath: string;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private _pauseRequested = false;
  private _stopRequested = false;

  private state: DaemonState;

  constructor(config: LoopConfig) {
    this.id = generateId();
    this.runDir = `${RUNS_DIR}/${this.id}`;
    this.socketPath = `${this.runDir}/control.sock`;

    this.state = {
      id: this.id,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      promptPath: config.promptPath,
      phase: "starting",
      iteration: 0,
      totalIterations: config.iterations,
      cumulative: {
        completedIterations: 0,
        totalDurationMs: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
      live: null,
    };
  }

  get isPauseRequested(): boolean {
    return this._pauseRequested;
  }

  get isStopRequested(): boolean {
    return this._stopRequested;
  }

  async start(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });

    // Write PID file
    await Bun.write(`${this.runDir}/pid`, String(process.pid));

    // Write CWD symlink for easy identification
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(process.cwd(), `${this.runDir}/cwd`);
    } catch {
      // Symlink may fail on some systems, non-critical
    }

    // Start Unix socket server
    this.server = Bun.serve({
      unix: this.socketPath,
      fetch: (req) => this.handleRequest(req),
    });

    // Write state file
    await this.persistState();
  }

  private handleRequest(req: Request): Response {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/status") {
      return Response.json(this.state);
    }

    if (req.method === "POST" && path === "/stop") {
      this._stopRequested = true;
      this.state.phase = "stopping";
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/pause") {
      this._pauseRequested = true;
      this.state.phase = "paused";
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/resume") {
      this._pauseRequested = false;
      if (this.state.phase === "paused") {
        this.state.phase = "running";
      }
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && path === "/log") {
      const lines = parseInt(url.searchParams.get("lines") || "50", 10);
      return this.getLogTail(lines);
    }

    return new Response("Not found", { status: 404 });
  }

  private logFilePath_: string | undefined;

  setLogFile(path: string): void {
    this.logFilePath_ = path;
  }

  private async getLogTail(lines: number): Promise<Response> {
    const logFile = this.logFilePath_;
    if (!logFile) return Response.json({ lines: [], logFile: null });

    try {
      const content = await Bun.file(logFile).text();
      const allLines = content.split("\n");
      const tail = allLines.slice(-lines);
      return Response.json({ lines: tail, logFile });
    } catch {
      return Response.json({ lines: [], logFile: null });
    }
  }

  setPhase(phase: DaemonState["phase"]): void {
    this.state.phase = phase;
  }

  setIteration(iteration: number): void {
    this.state.iteration = iteration;
  }

  setLive(stats: LiveIterationStats | null): void {
    this.state.live = stats;
  }

  setCumulative(stats: CumulativeStats): void {
    this.state.cumulative = stats;
  }

  setStopReason(reason: string): void {
    this.state.stopReason = reason;
  }

  async persistState(logFile?: string): Promise<void> {
    const data = { ...this.state, logFile };
    await Bun.write(`${this.runDir}/state.json`, JSON.stringify(data, null, 2));
  }

  async shutdown(): Promise<void> {
    this.state.phase = "stopped";
    await this.persistState();

    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }

    // Clean up run directory
    try {
      await rm(this.runDir, { recursive: true });
    } catch {
      // Best effort
    }
  }
}

// ─── Client Utilities ───────────────────────────────────────────────────

export interface RunInfo {
  id: string;
  pid: number;
  alive: boolean;
  cwd: string;
  promptPath: string;
  phase: string;
  iteration: number;
  totalIterations: number;
  startedAt: string;
  socketPath: string;
}

/**
 * List all daemon run directories, checking which are still alive.
 */
export async function listRuns(): Promise<RunInfo[]> {
  const runs: RunInfo[] = [];

  try {
    const entries = await readdir(RUNS_DIR);
    for (const entry of entries) {
      const runDir = `${RUNS_DIR}/${entry}`;
      try {
        const stateFile = Bun.file(`${runDir}/state.json`);
        if (!(await stateFile.exists())) continue;

        const state = await stateFile.json();
        const pid = state.pid as number;

        // Check if process is still alive
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }

        // Clean up stale run directories
        if (!alive) {
          try { await rm(runDir, { recursive: true }); } catch {}
          continue;
        }

        runs.push({
          id: entry,
          pid,
          alive,
          cwd: state.cwd || "?",
          promptPath: state.promptPath || "?",
          phase: state.phase || "?",
          iteration: state.iteration || 0,
          totalIterations: state.totalIterations || 0,
          startedAt: state.startedAt || "?",
          socketPath: `${runDir}/control.sock`,
        });
      } catch {
        // Skip malformed entries
      }
    }
  } catch {
    // Runs dir doesn't exist yet
  }

  return runs;
}

/**
 * Find a single run by ID prefix. Throws if ambiguous or not found.
 */
export async function findRun(idPrefix?: string): Promise<RunInfo> {
  const runs = await listRuns();

  if (runs.length === 0) {
    throw new Error("No running cig-loop daemons found");
  }

  if (!idPrefix) {
    if (runs.length === 1) return runs[0];
    throw new Error(
      `Multiple daemons running. Specify an ID:\n${runs.map((r) => `  ${r.id}  ${r.promptPath}  (${r.phase})`).join("\n")}`
    );
  }

  const matches = runs.filter((r) => r.id.startsWith(idPrefix));
  if (matches.length === 0) {
    throw new Error(`No daemon found matching "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID "${idPrefix}". Matches:\n${matches.map((r) => `  ${r.id}  ${r.promptPath}`).join("\n")}`
    );
  }

  return matches[0];
}

/**
 * Send a request to a daemon's control socket.
 */
export async function daemonRequest(socketPath: string, path: string, method = "GET"): Promise<any> {
  const resp = await fetch(`http://localhost${path}`, {
    method,
    unix: socketPath,
  } as any);

  if (!resp.ok) {
    throw new Error(`Daemon returned ${resp.status}: ${await resp.text()}`);
  }

  return resp.json();
}
