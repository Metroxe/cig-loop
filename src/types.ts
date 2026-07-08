/**
 * Token usage statistics from a single Claude invocation.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Result from a single iteration of the cig loop.
 */
export interface IterationResult {
  /** 1-based iteration number */
  iteration: number;
  /** Whether Claude exited successfully (exit code 0) */
  success: boolean;
  /** Exit code from the Claude process */
  exitCode: number;
  /** Duration of this iteration in milliseconds */
  durationMs: number;
  /** Token usage if available */
  tokenUsage?: TokenUsage;
  /** Cost in USD if available */
  costUsd?: number;
  /** The raw output captured from Claude */
  output: string;
  /** Whether the stop string was detected */
  stopStringDetected: boolean;
  /** Whether the continue string was detected */
  continueStringDetected: boolean;
  /** Whether the iteration was killed due to timeout */
  timedOut: boolean;
  /** The content of the final text block (last text block before iteration ended) */
  finalResponse: string;
  /**
   * If the agent called ScheduleWakeup during this iteration, the requested
   * delay in seconds. cig-loop is the re-invoker for headless `claude -p`, so
   * this only takes effect if the loop waits this long before the next
   * iteration (see the loop body in index.ts).
   */
  requestedWakeupSeconds?: number;
}

/**
 * Cumulative statistics across all iterations.
 */
export interface CumulativeStats {
  completedIterations: number;
  totalDurationMs: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/**
 * Resolved configuration for a cig loop run.
 * All fields are populated after CLI arg parsing + interactive prompts.
 */
export interface LoopConfig {
  /** Path to the prompt file */
  promptPath: string;
  /** Number of iterations (0 = infinite) */
  iterations: number;
  /** Claude model to use (undefined = Claude default) */
  model?: string;
  /** Reasoning effort level (low|medium|high|xhigh|max). Undefined = the model's own default. */
  effort?: string;
  /** Stop the loop when this string is found in output */
  stopString?: string;
  /** Continue only if this string is found in output */
  continueString?: string;
  /** Path to log file (undefined = no logging) */
  logFile?: string;
  /** Maximum number of lines to keep in the log file (0 = unlimited) */
  maxLogLines: number;
  /** Show raw JSON events */
  verbose: boolean;
  /** All MCP servers to enable — passed via --mcp-config with --strict-mcp-config */
  injectedMcps: InjectableMcp[];
  /** Enable IDE integration (--ide flag to Claude) */
  enableIde?: boolean;
  /** Enable Chrome integration (--chrome flag to Claude) */
  enableChrome?: boolean;
  /** Delay in seconds between iterations (0 = no delay) */
  delaySeconds: number;
  /** Max wall-clock time per iteration in seconds (0 = no limit) */
  timeoutSeconds: number;
  /** Per-bucket throttle thresholds (0 = disabled) */
  throttle: ThrottleConfig;
  /** Show the smoking cigarette animation in the footer */
  showCig: boolean;
  /**
   * If set, also expose a READ-ONLY status server over TCP on this port
   * (in addition to the always-on local unix control socket). Serves
   * `GET /status`, `GET /log`, `GET /health`. Control verbs (stop/pause/skip)
   * are never exposed over TCP. Undefined/0 = disabled. Intended for a LAN
   * dashboard to poll a headless daemon's live state.
   */
  statusPort?: number;
  /**
   * If set, the TCP status server requires `Authorization: Bearer <token>`.
   * Undefined = no auth (rely on network/firewall isolation, e.g. LAN-only).
   */
  statusToken?: string;
}

/**
 * An MCP server definition that can be injected at runtime via --mcp-config.
 * Defined in an mcps.json file alongside the prompt, or via --mcp-inject.
 */
export interface InjectableMcp {
  /** Display name for the MCP server */
  name: string;
  /** Command to run (e.g. "npx") */
  command: string;
  /** Arguments to the command (e.g. ["@playwright/mcp@latest"]) */
  args: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Short description shown in the selection list */
  description?: string;
  /** Setup instructions or prerequisites */
  prereqs?: string;
}

/**
 * The shape of an mcps.json file.
 */
export interface McpInjectFile {
  mcpServers: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

/**
 * Streaming block tracker used during Claude output parsing.
 */
export interface StreamingBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  name?: string;
  input?: string;
  content?: string;
}

/**
 * A discovered MCP server from `claude mcp list`.
 */
export interface McpServerInfo {
  /** Server name (e.g. "plugin:playwright:playwright") */
  name: string;
  /** Command + args as a single string from `claude mcp list` (e.g. "npx @playwright/mcp@latest") */
  command: string;
  /** Whether the server is healthy */
  healthy: boolean;
  /** Status text (e.g. "Connected" or "Failed to connect") */
  status: string;
  /** Config source file path (e.g. "~/.claude/settings.json") */
  source?: string;
  /** Parsed command executable (e.g. "npx"), extracted from config file or fallback */
  parsedCommand?: string;
  /** Parsed command arguments (e.g. ["@playwright/mcp@latest"]), extracted from config file or fallback */
  parsedArgs?: string[];
  /** Environment variables from config file */
  env?: Record<string, string>;
}

/**
 * Live stats updated during a single iteration, used by the footer.
 */
export interface LiveIterationStats {
  iteration: number;
  totalIterations: number;
  startTime: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated context window usage as a percentage (0-100) */
  contextPercent: number;
}

/**
 * A single usage bucket from the Anthropic OAuth usage endpoint.
 */
export interface UsageBucket {
  /** Utilization percentage (0-100) */
  utilization: number;
  /** ISO 8601 timestamp when this bucket resets */
  resetsAt: string;
}

/**
 * Parsed usage data from the Anthropic OAuth usage endpoint.
 */
export interface UsageData {
  fiveHour: UsageBucket | null;
  sevenDay: UsageBucket | null;
  sevenDaySonnet: UsageBucket | null;
  sevenDayOpus: UsageBucket | null;
  fetchedAt: number;
}

/**
 * Per-bucket throttle thresholds (0 = disabled).
 */
export interface ThrottleConfig {
  fiveHour: number;
  sevenDay: number;
  sonnet: number;
  /** When true, thresholds are calculated dynamically based on time elapsed in each bucket's window */
  dynamic: boolean;
}
