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
  /** The content of the final text block (last text block before iteration ended) */
  finalResponse: string;
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
  /** Stop the loop when this string is found in output */
  stopString?: string;
  /** Continue only if this string is found in output */
  continueString?: string;
  /** Path to log file (undefined = no logging) */
  logFile?: string;
  /** Show raw JSON events */
  verbose: boolean;
  /** All MCP servers to enable — passed via --mcp-config with --strict-mcp-config */
  injectedMcps: InjectableMcp[];
  /** Enable IDE integration (--ide flag to Claude) */
  enableIde?: boolean;
  /** Enable Chrome integration (--chrome flag to Claude) */
  enableChrome?: boolean;
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
