/**
 * Daemon mode for cig-loop.
 *
 * Runs the loop headless with a Unix socket control server.
 * State is persisted to ~/.cig-loop/runs/<id>/ for discovery by client commands.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { CumulativeStats, LiveIterationStats, LoopConfig, ThrottleConfig } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────

const RUNS_DIR = `${process.env.HOME}/.cig-loop/runs`;
const HISTORY_FILE = `${process.env.HOME}/.cig-loop/history.jsonl`;

// ─── Types ──────────────────────────────────────────────────────────────

export interface DaemonState {
  id: string;
  pid: number;
  startedAt: string;
  cwd: string;
  promptPath: string;
  phase: "starting" | "running" | "throttled" | "paused" | "suspended" | "stopping" | "stopped";
  iteration: number;
  totalIterations: number;
  cumulative: CumulativeStats;
  live: LiveIterationStats | null;
  stopReason?: string;
  stoppedAt?: string;
  logFile?: string;
  throttleConfig?: ThrottleConfig | null;
  /** Original CLI args for respawning (continue/rerun) */
  spawnArgs?: string[];
  /** Show the smoking cigarette animation */
  showCig?: boolean;
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
  private statusServer: ReturnType<typeof Bun.serve> | null = null;
  private readonly statusPort?: number;
  private readonly statusToken?: string;
  private _pauseRequested = false;
  private _stopRequested = false;
  private _skipRequested = false;
  private _forceStopRequested = false;
  private _forceQuitRequested = false;
  private _iterationAbort: AbortController = new AbortController();

  private state: DaemonState;

  constructor(config: LoopConfig) {
    this.id = generateId();
    this.runDir = `${RUNS_DIR}/${this.id}`;
    // Socket lives in /tmp — Bun.serve auto-deletes the unix socket's
    // parent directory on process exit, which would destroy run state.
    this.socketPath = `/tmp/cig-loop-${this.id}.sock`;

    this.state = {
      id: this.id,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      promptPath: resolve(config.promptPath),
      phase: "starting",
      iteration: 0,
      totalIterations: config.iterations,
      cumulative: {
        completedIterations: 0,
        totalDurationMs: 0,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
      },
      live: null,
      showCig: config.showCig,
    };

    this.statusPort = config.statusPort;
    this.statusToken = config.statusToken;
  }

  getState(): DaemonState { return this.state; }

  /** Append this session to the history JSONL file (survives Bun's cleanup). */
  appendHistory(): void {
    try {
      const { appendFileSync } = require("node:fs") as typeof import("node:fs");
      mkdirSync(`${process.env.HOME}/.cig-loop`, { recursive: true });
      appendFileSync(HISTORY_FILE, JSON.stringify(this.state) + "\n");
    } catch { /* best effort */ }
  }

  get isPauseRequested(): boolean {
    return this._pauseRequested;
  }

  get isStopRequested(): boolean {
    return this._stopRequested;
  }

  get isSkipRequested(): boolean {
    return this._skipRequested;
  }

  get isForceStopRequested(): boolean {
    return this._forceStopRequested;
  }

  get isForceQuitRequested(): boolean {
    return this._forceQuitRequested;
  }

  /** Get the AbortSignal for the current iteration. */
  get iterationSignal(): AbortSignal {
    return this._iterationAbort.signal;
  }

  /** Reset the abort controller for a new iteration. Clears skip flag. */
  resetIterationAbort(): void {
    this._iterationAbort = new AbortController();
    this._skipRequested = false;
    this._forceStopRequested = false;
  }

  /** Abort the current iteration's Claude subprocess. */
  abortCurrentIteration(): void {
    this._iterationAbort.abort();
  }

  async start(): Promise<void> {
    // Create run directory and files via shell subprocess — Bun auto-deletes
    // files/directories it creates (via Bun.write, mkdir, writeFileSync) on
    // process exit, which destroys the session history we need.
    await Bun.$`mkdir -p ${this.runDir}`.quiet();
    await Bun.$`echo ${String(process.pid)} > ${this.runDir}/pid`.quiet();

    // Write CWD symlink for easy identification (via shell to avoid Bun auto-cleanup)
    try {
      await Bun.$`ln -sf ${process.cwd()} ${this.runDir}/cwd`.quiet();
    } catch {
      // Non-critical
    }

    // Start Unix socket server (local control: all verbs)
    this.server = Bun.serve({
      unix: this.socketPath,
      fetch: (req) => this.handleRequest(req),
    });

    // Optionally start a READ-ONLY TCP status server for a LAN dashboard.
    // Bound to 0.0.0.0 so it's reachable from the network; control verbs are
    // never served here (see handleStatusRequest), and an optional bearer
    // token gates access when the port isn't otherwise firewalled.
    if (this.statusPort && this.statusPort > 0) {
      try {
        this.statusServer = Bun.serve({
          port: this.statusPort,
          hostname: "0.0.0.0",
          fetch: (req) => this.handleStatusRequest(req),
        });
      } catch (err) {
        // Non-fatal: the loop must run even if the status port is taken.
        console.error(`cig-loop: failed to start status server on port ${this.statusPort}: ${err}`);
      }
    }

    // Write state file
    await this.persistState();
  }

  /**
   * Network-facing handler for the TCP status server. READ-ONLY by design:
   * only GET /status, GET /log, GET /health. Control verbs (stop/pause/skip/
   * force-*) are intentionally absent so nothing on the LAN can drive the loop
   * — those stay on the local unix socket (handleRequest).
   */
  private async handleStatusRequest(req: Request): Promise<Response> {
    if (this.statusToken) {
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${this.statusToken}`) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/status") {
      return Response.json(this.state);
    }

    if (req.method === "GET" && path === "/log") {
      const lines = parseInt(url.searchParams.get("lines") || "50", 10);
      return this.getLogTail(lines);
    }

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return Response.json({ ok: true, id: this.id, phase: this.state.phase });
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleRequest(req: Request): Promise<Response> {
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

    if (req.method === "POST" && path === "/skip") {
      this._skipRequested = true;
      this.abortCurrentIteration();
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/force-stop") {
      this._forceStopRequested = true;
      this.abortCurrentIteration();
      this.state.phase = "suspended";
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/force-quit") {
      this._forceQuitRequested = true;
      this._stopRequested = true;
      this.abortCurrentIteration();
      this.state.phase = "stopping";
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/continue") {
      this._forceStopRequested = false;
      this._pauseRequested = false;
      if (this.state.phase === "suspended" || this.state.phase === "paused") {
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
    this.state.logFile = path;
  }

  setThrottleConfig(config: ThrottleConfig | null): void {
    this.state.throttleConfig = config;
  }

  setSpawnArgs(args: string[]): void {
    this.state.spawnArgs = args;
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
    if (phase === "stopped") {
      this.state.stoppedAt = new Date().toISOString();
    }
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

  async persistState(): Promise<void> {
    // Write via shell — Bun auto-deletes files it creates on process exit
    const json = JSON.stringify(this.state, null, 2);
    await Bun.$`echo ${json} > ${this.runDir}/state.json`.quiet();
  }

  async shutdown(): Promise<void> {
    this.state.phase = "stopped";
    if (!this.state.stoppedAt) {
      this.state.stoppedAt = new Date().toISOString();
    }
    await this.persistState();
    this.appendHistory();

    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }

    if (this.statusServer) {
      this.statusServer.stop(true);
      this.statusServer = null;
    }

    // Don't delete the run directory — keep it for history (24h TTL).
    // listRuns() handles cleanup of expired entries.
    // Socket file is left behind (harmless).
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
  stoppedAt?: string;
  stopReason?: string;
  socketPath: string;
  spawnArgs?: string[];
}

const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // keep stopped sessions for 24h

/**
 * List all daemon run directories, including recently stopped sessions.
 * Dead sessions are kept for 24h so the autopilot monitor can detect
 * sessions that stopped since its last check.
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

        // Clean up sessions that have been dead for > 24h
        if (!alive) {
          const stoppedAt = state.stoppedAt ? new Date(state.stoppedAt).getTime() : 0;
          if (stoppedAt > 0 && Date.now() - stoppedAt > HISTORY_TTL_MS) {
            try { await rm(runDir, { recursive: true }); } catch {}
            continue;
          }
          // No stoppedAt means old-format state — clean up immediately
          if (!stoppedAt) {
            try { await rm(runDir, { recursive: true }); } catch {}
            continue;
          }
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
          stoppedAt: state.stoppedAt,
          stopReason: state.stopReason,
          socketPath: `/tmp/cig-loop-${entry}.sock`,
          spawnArgs: state.spawnArgs,
        });
      } catch {
        // Skip malformed entries
      }
    }
  } catch {
    // Runs dir doesn't exist yet
  }

  // Also load stopped sessions from history JSONL
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const content = readFileSync(HISTORY_FILE, "utf-8");
    const seenIds = new Set(runs.map((r) => r.id));
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const state = JSON.parse(line);
        if (seenIds.has(state.id)) continue; // already in runs (still alive)
        if (!state.stoppedAt) continue;
        const stoppedAt = new Date(state.stoppedAt).getTime();
        if (Date.now() - stoppedAt > HISTORY_TTL_MS) continue; // expired
        runs.push({
          id: state.id,
          pid: state.pid,
          alive: false,
          cwd: state.cwd || "?",
          promptPath: state.promptPath || "?",
          phase: state.phase || "stopped",
          iteration: state.iteration || 0,
          totalIterations: state.totalIterations || 0,
          startedAt: state.startedAt || "?",
          stoppedAt: state.stoppedAt,
          stopReason: state.stopReason,
          socketPath: "",
          spawnArgs: state.spawnArgs,
        });
        seenIds.add(state.id);
      } catch { /* skip malformed lines */ }
    }
  } catch { /* history file doesn't exist yet */ }

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
    if (runs.length === 1) return runs[0]!;
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

  return matches[0]!;
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
