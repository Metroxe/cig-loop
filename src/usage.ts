/**
 * Anthropic OAuth usage fetching, caching, and throttle checking.
 *
 * Reads the OAuth token from ~/.claude/.credentials.json and fetches
 * utilization data from the undocumented Anthropic usage endpoint.
 */

import type { UsageBucket, UsageData, ThrottleConfig } from "./types.js";

// ─── Disk Cache ─────────────────────────────────────────────────────────

const DISK_CACHE_PATH = `${process.env.HOME || "~"}/.cache/cig-loop/usage.json`;

export async function loadDiskCache(): Promise<UsageData | null> {
  try {
    const file = Bun.file(DISK_CACHE_PATH);
    if (!(await file.exists())) return null;
    const data = await file.json();
    if (data && typeof data.fetchedAt === "number") return data as UsageData;
    return null;
  } catch {
    return null;
  }
}

export async function saveDiskCache(usage: UsageData): Promise<void> {
  try {
    await Bun.write(DISK_CACHE_PATH, JSON.stringify(usage));
  } catch {
    // best-effort — directory may not exist yet
    try {
      const dir = DISK_CACHE_PATH.slice(0, DISK_CACHE_PATH.lastIndexOf("/"));
      await Bun.$`mkdir -p ${dir}`.quiet();
      await Bun.write(DISK_CACHE_PATH, JSON.stringify(usage));
    } catch { /* ignore */ }
  }
}

// ─── Credential Reading ─────────────────────────────────────────────────

let cachedToken: string | null | undefined; // undefined = not yet read
let cachedUserAgent: string | undefined;

function getClaudeUserAgent(): string {
  if (cachedUserAgent) return cachedUserAgent;
  try {
    const result = Bun.spawnSync(["claude", "--version"]);
    const ver = result.stdout.toString().trim().split(" ")[0]; // "2.1.87"
    cachedUserAgent = `claude-code/${ver}`;
  } catch {
    cachedUserAgent = "claude-code/2.1.87";
  }
  return cachedUserAgent;
}

async function readOAuthToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;

  try {
    const home = process.env.HOME || "~";
    const file = Bun.file(`${home}/.claude/.credentials.json`);
    if (!(await file.exists())) {
      cachedToken = null;
      return null;
    }
    const content = await file.json();
    const token = content?.claudeAiOauth?.accessToken;
    cachedToken = typeof token === "string" ? token : null;
    return cachedToken;
  } catch {
    cachedToken = null;
    return null;
  }
}

// ─── API Fetch with Cache ───────────────────────────────────────────────

let cachedUsage: UsageData | null = null;
let fetchInProgress: Promise<UsageData | null> | null = null;
const CACHE_TTL_MS = 90_000;

/**
 * Fetch usage data from the Anthropic OAuth usage endpoint.
 * Returns cached data if fresh (within TTL), deduplicates concurrent calls.
 * Never throws — returns stale cached data or null on error.
 *
 * @param forceRefresh  Bypass TTL and fetch fresh data
 * @param retries       Number of retries on 429 (default 0 = single attempt).
 *                      Use retries > 0 only when Claude Code is NOT running
 *                      (e.g. between iterations), since the endpoint is
 *                      monopolized while Claude is active.
 */
export async function fetchUsage(forceRefresh = false, retries = 0): Promise<UsageData | null> {
  // Return cached data if still fresh
  if (!forceRefresh && cachedUsage && Date.now() - cachedUsage.fetchedAt < CACHE_TTL_MS) {
    return cachedUsage;
  }

  // Deduplicate concurrent fetches (only when retries match — don't let a
  // quick fire-and-forget block a retry-capable call)
  if (fetchInProgress && retries === 0) return fetchInProgress;

  const p = doFetch(retries);
  if (retries === 0) {
    fetchInProgress = p;
  }
  try {
    return await p;
  } finally {
    if (fetchInProgress === p) fetchInProgress = null;
  }
}

async function doFetch(maxRetries: number): Promise<UsageData | null> {
  const token = await readOAuthToken();
  if (!token) return null;

  // Retry with backoff on 429s — the usage endpoint is aggressively
  // rate-limited and shares quota with Claude Code itself (known issue:
  // anthropics/claude-code#31021, #31637, #30930).
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": getClaudeUserAgent(),
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 429) {
        if (attempt < maxRetries) {
          const retryAfter = parseInt(response.headers.get("retry-after") || "0", 10);
          const backoffMs = Math.max(retryAfter * 1000, 3_000) * Math.pow(2, attempt);
          await Bun.sleep(backoffMs);
          continue;
        }
        // Exhausted retries — fall through to disk/memory cache
        break;
      }

      if (!response.ok) {
        break; // fall through to cache
      }

      const data = await response.json();
      const usage = parseUsageResponse(data);
      cachedUsage = usage;
      saveDiskCache(usage); // fire-and-forget
      return usage;
    } catch {
      break; // fall through to cache
    }
  }

  // API unavailable — return in-memory cache, or fall back to disk cache
  if (cachedUsage) return cachedUsage;
  const diskCached = await loadDiskCache();
  if (diskCached) {
    cachedUsage = diskCached;
  }
  return cachedUsage;
}

function parseBucket(raw: unknown): UsageBucket | null {
  const b = raw as { utilization?: number; resets_at?: string } | null;
  if (!b || typeof b.utilization !== "number") return null;
  return {
    utilization: Math.round(b.utilization),
    resetsAt: b.resets_at || "",
  };
}

function parseUsageResponse(data: unknown): UsageData {
  const d = data as Record<string, unknown>;
  return {
    fiveHour: parseBucket(d.five_hour),
    sevenDay: parseBucket(d.seven_day),
    sevenDaySonnet: parseBucket(d.seven_day_sonnet),
    sevenDayOpus: parseBucket(d.seven_day_opus),
    fetchedAt: Date.now(),
  };
}

// ─── Throttle Check ─────────────────────────────────────────────────────

/** Known total durations for each bucket window (in ms). */
export const BUCKET_PERIOD_MS = {
  fiveHour: 5 * 60 * 60 * 1000,
  sevenDay: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Calculate the dynamic throttle threshold based on how far through the
 * bucket's time window we are.
 *
 * e.g. 5.5 days into a 7-day window → 5.5/7 ≈ 78.6%
 *
 * Returns a percentage (0–100). Returns 100 if the window is about to reset
 * (so we don't block right before a reset), or 0 if it just started.
 */
export function getDynamicThreshold(resetsAt: string, totalPeriodMs: number): number {
  const now = Date.now();
  const resetTime = new Date(resetsAt).getTime();
  if (isNaN(resetTime)) return 100; // can't calculate, don't throttle

  const timeRemaining = resetTime - now;
  if (timeRemaining <= 0) return 100; // about to reset, allow full usage

  const elapsed = totalPeriodMs - timeRemaining;
  if (elapsed <= 0) return 0; // just started, no usage expected yet

  return Math.round((elapsed / totalPeriodMs) * 100);
}

export interface ThrottleHit {
  bucket: string;
  utilization: number;
  threshold: number;
  resetsAt: string;
}

/**
 * Check a single bucket against a threshold. Returns a ThrottleHit if over, null if OK.
 */
function checkBucket(
  bucket: UsageBucket | null,
  name: string,
  threshold: number,
): ThrottleHit | null {
  if (threshold <= 0 || !bucket) return null;
  if (bucket.utilization >= threshold) {
    return {
      bucket: name,
      utilization: bucket.utilization,
      threshold,
      resetsAt: bucket.resetsAt,
    };
  }
  return null;
}

/**
 * Check whether any usage bucket exceeds its configured threshold.
 * Returns the first bucket that exceeds, or null if all OK.
 *
 * In dynamic mode, thresholds are calculated from time elapsed in each window
 * and ALL available buckets are checked.
 */
export function checkThrottle(
  usage: UsageData,
  model: string | undefined,
  thresholds: ThrottleConfig,
): ThrottleHit | null {
  if (thresholds.dynamic) {
    return checkThrottleDynamic(usage, model);
  }

  // Static mode: check each bucket against its fixed threshold
  const hit5h = checkBucket(usage.fiveHour, "5h", thresholds.fiveHour);
  if (hit5h) return hit5h;

  const hit7d = checkBucket(usage.sevenDay, "7d", thresholds.sevenDay);
  if (hit7d) return hit7d;

  // Check model-specific bucket
  if (thresholds.sonnet > 0) {
    const isOpus = model && model.toLowerCase().includes("opus");
    if (isOpus) {
      const hit = checkBucket(usage.sevenDayOpus, "opus", thresholds.sonnet);
      if (hit) return hit;
    } else {
      const hit = checkBucket(usage.sevenDaySonnet, "sonnet", thresholds.sonnet);
      if (hit) return hit;
    }
  }

  return null;
}

/**
 * Dynamic throttle: threshold for each bucket is calculated from how far
 * through its time window we are. All available buckets are checked.
 */
function checkThrottleDynamic(
  usage: UsageData,
  model: string | undefined,
): ThrottleHit | null {
  // 5h bucket
  if (usage.fiveHour) {
    const threshold = getDynamicThreshold(usage.fiveHour.resetsAt, BUCKET_PERIOD_MS.fiveHour);
    const hit = checkBucket(usage.fiveHour, "5h", threshold);
    if (hit) return hit;
  }

  // 7d all-models bucket
  if (usage.sevenDay) {
    const threshold = getDynamicThreshold(usage.sevenDay.resetsAt, BUCKET_PERIOD_MS.sevenDay);
    const hit = checkBucket(usage.sevenDay, "7d", threshold);
    if (hit) return hit;
  }

  // Model-specific 7d bucket (only check when model is known)
  if (model) {
    const isOpus = model.toLowerCase().includes("opus");
    const isSonnet = model.toLowerCase().includes("sonnet");
    const modelBucket = isOpus ? usage.sevenDayOpus : isSonnet ? usage.sevenDaySonnet : null;
    const modelName = isOpus ? "opus" : "sonnet";
    if (modelBucket) {
      const threshold = getDynamicThreshold(modelBucket.resetsAt, BUCKET_PERIOD_MS.sevenDay);
      const hit = checkBucket(modelBucket, modelName, threshold);
      if (hit) return hit;
    }
  }

  return null;
}

// ─── Centralized Poller ─────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1000;          // 5 minutes between fetches
const DISK_CHECK_INTERVAL_MS = 15_000;            // check disk cache every 15s for cross-process updates
const FRESHNESS_THRESHOLD_MS = POLL_INTERVAL_MS - 30_000; // skip fetch if disk data < 4.5 min old

/**
 * Centralized usage poller that coordinates across cig-loop processes via
 * the shared disk cache.  Each process runs one UsagePoller; before every
 * fetch it checks whether another process already wrote fresh data.
 */
export class UsagePoller {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private diskCheckTimer: ReturnType<typeof setInterval> | null = null;
  private _usage: UsageData | null = null;
  private _lastError: string | null = null;
  private _lastErrorAt = 0;
  private _fetching = false;
  private diskOnly: boolean;

  /** Called whenever usage data changes (from fetch or cross-process update). */
  onUsage: ((usage: UsageData) => void) | null = null;
  /** Called whenever a fetch attempt fails. */
  onError: ((error: string, at: number) => void) | null = null;

  /**
   * @param diskOnly  When true, never makes API calls — only reads the disk
   *                  cache written by another process. Use this for the attach
   *                  TUI so it doesn't compete for API quota.
   */
  constructor(diskOnly = false) {
    this.diskOnly = diskOnly;
  }

  get usage(): UsageData | null { return this._usage; }
  get lastError(): string | null { return this._lastError; }
  get lastErrorAt(): number { return this._lastErrorAt; }

  async start(): Promise<void> {
    // Seed from disk cache so footer has data immediately
    const diskData = await loadDiskCache();
    if (diskData) {
      this._usage = diskData;
      this.onUsage?.(diskData);
    }

    // Initial fetch (fire-and-forget so it doesn't block startup)
    this.poll();

    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.diskCheckTimer = setInterval(() => this.checkDiskCache(), DISK_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.diskCheckTimer) { clearInterval(this.diskCheckTimer); this.diskCheckTimer = null; }
  }

  /**
   * Force a fresh fetch — used after iterations end when the API is available.
   * @param retries  Number of 429 retries (default 3 for post-iteration window)
   */
  async refresh(retries = 3): Promise<UsageData | null> {
    return this.doFetchCycle(true, retries);
  }

  private async poll(): Promise<void> {
    await this.doFetchCycle(false);
  }

  /**
   * Core fetch cycle.  When `force` is false, skips the network call if the
   * disk cache was recently updated by another process.
   *
   * @param force   Bypass freshness check (used after iterations end)
   * @param retries Number of 429 retries (default 0 for background polls,
   *                use 3 for post-iteration when API is likely available)
   */
  private async doFetchCycle(force: boolean, retries = 0): Promise<UsageData | null> {
    if (this._fetching) return this._usage;
    this._fetching = true;

    try {
      // Always check disk cache first — another process may have fresh data
      const diskData = await loadDiskCache();
      if (diskData && diskData.fetchedAt > (this._usage?.fetchedAt ?? 0)) {
        this._usage = diskData;
        this._lastError = null;
        this.onUsage?.(diskData);
      }

      // Skip API call if disk data is fresh enough (or if we're disk-only)
      if (this.diskOnly) return this._usage;
      if (!force && diskData && Date.now() - diskData.fetchedAt < FRESHNESS_THRESHOLD_MS) {
        return this._usage;
      }

      let usage: UsageData | null = null;
      let errorMsg: string | null = null;

      // Fetch from API — single attempt for background polls, retries for
      // post-iteration refreshes when the API window is open.
      {
        const beforeFetchedAt = cachedUsage?.fetchedAt ?? 0;
        usage = await fetchUsage(true, retries);
        // fetchUsage returns stale cache on failure — detect by checking fetchedAt
        if (usage && usage.fetchedAt <= beforeFetchedAt) {
          usage = null;
        }
      }

      if (!usage) {
        errorMsg = "API fetch failed (rate-limited)";
      }

      if (usage) {
        this._usage = usage;
        this._lastError = null;
        cachedUsage = usage;         // keep in-memory cache in sync
        saveDiskCache(usage);        // share with other processes
        this.onUsage?.(usage);
      } else if (errorMsg) {
        this._lastError = errorMsg;
        this._lastErrorAt = Date.now();
        this.onError?.(errorMsg, this._lastErrorAt);
      }

      return this._usage;
    } finally {
      this._fetching = false;
    }
  }

  /** Check the disk cache for updates from other processes. */
  private async checkDiskCache(): Promise<void> {
    try {
      const diskData = await loadDiskCache();
      if (diskData && diskData.fetchedAt > (this._usage?.fetchedAt ?? 0)) {
        this._usage = diskData;
        this._lastError = null;
        this.onUsage?.(diskData);
      }
    } catch { /* best-effort */ }
  }
}

// ─── Display Helper ─────────────────────────────────────────────────────

/**
 * Format an ISO 8601 reset timestamp as a human-readable countdown.
 * e.g. "4h 12m", "5d 3h", "< 1m"
 */
export function formatResetTime(resetsAt: string): string {
  if (!resetsAt) return "?";

  const now = Date.now();
  const reset = new Date(resetsAt).getTime();
  let diffMs = reset - now;

  if (isNaN(diffMs) || diffMs <= 0) return "< 1m";

  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  diffMs %= 24 * 60 * 60 * 1000;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  diffMs %= 60 * 60 * 1000;
  const minutes = Math.floor(diffMs / (60 * 1000));

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "< 1m";
}
