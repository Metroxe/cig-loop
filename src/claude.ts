/**
 * Claude CLI runner.
 *
 * Spawns the `claude` CLI with --output-format stream-json and parses the
 * streaming events in real time, piping formatted output through the
 * StickyFooter's scroll region.
 */

import chalk from "chalk";
import { formatToolUse, formatToolResult, formatCost, formatNumber, stripSystemReminders, getToolIcon } from "./format.js";
import { MarkdownStreamer } from "./markdown.js";
import { StickyFooter } from "./terminal.js";
import type {
  InjectableMcp,
  IterationResult,
  LiveIterationStats,
  LoopConfig,
  StreamingBlock,
  TokenUsage,
} from "./types.js";

/**
 * Run a single Claude iteration. Reads the prompt file, spawns the Claude
 * CLI, streams + formats output, and returns structured results.
 */
export async function runClaudeIteration(
  config: LoopConfig,
  iteration: number,
  footer: StickyFooter,
): Promise<IterationResult> {
  const startTime = Date.now();

  // Read prompt file content
  const promptFile = Bun.file(config.promptPath);
  const promptContent = await promptFile.text();

  // Use a temp debug file to capture MCP connection errors
  const debugFile = `/tmp/ez-ralph-loop-debug-${iteration}-${Date.now()}.log`;

  // Build command args
  const args: string[] = [
    "--dangerously-skip-permissions",
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--no-session-persistence",       // skip writing session to disk
    "--debug-file", debugFile,        // capture debug logs for MCP error reporting
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  // IMPORTANT: prompt must come BEFORE --mcp-config because --mcp-config
  // is variadic (accepts multiple values) and would consume the prompt text
  args.push(promptContent);

  // MCP server handling (appended after the prompt)
  const hasConfiguredMcps = config.mcpServers.length > 0;
  const hasInjectedMcps = config.injectedMcps.length > 0;

  if (!hasConfiguredMcps && !hasInjectedMcps) {
    // No MCPs at all: skip everything for fastest startup
    args.push("--strict-mcp-config");
  } else if (hasInjectedMcps && !hasConfiguredMcps) {
    // Only injected MCPs: use strict mode + inject via --mcp-config
    args.push("--strict-mcp-config");
    args.push("--mcp-config", buildMcpConfigJson(config.injectedMcps));
  } else if (hasInjectedMcps && hasConfiguredMcps) {
    // Both: let configured load normally + inject additional ones
    args.push("--mcp-config", buildMcpConfigJson(config.injectedMcps));
  }
  // hasConfiguredMcps && !hasInjectedMcps: no flags needed, all configured MCPs load

  // Initialize live stats
  const totalIterations = config.iterations;
  const liveStats: LiveIterationStats = {
    iteration,
    totalIterations,
    startTime,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  footer.setLiveStats(liveStats);

  footer.writeln(chalk.dim("  ◆ Starting Claude..."));

  // Spawn claude process (stdin must not inherit, otherwise claude may block waiting for input)
  const proc = Bun.spawn(["claude", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let output = "";
  let tokenUsage: TokenUsage | undefined;
  let costUsd: number | undefined;

  // Block tracking for streaming
  const blocks: Record<number, StreamingBlock> = {};

  // Processing state shared across event handlers
  const state: ProcessingState = {
    thinkingStarted: false,
    setThinkingStarted: (v: boolean) => { state.thinkingStarted = v; },
    appendOutput: (text: string) => { output += text; },
    hasStreamedContent: false,
    markdownStreamer: new MarkdownStreamer(),
    lastTextBlock: "",
  };

  // Read stdout line by line
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.substring(0, newlineIdx);
        buffer = buffer.substring(newlineIdx + 1);

        if (!line.trim()) continue;

        // Verbose mode: show raw JSON
        if (config.verbose) {
          footer.writeln(chalk.gray(`[VERBOSE] ${line}`));
        }

        try {
          let event = JSON.parse(line);

          // Unwrap stream_event envelope: {type:"stream_event", event:{...}}
          if (event.type === "stream_event" && event.event) {
            event = event.event;
          }

          await processEvent(event, blocks, footer, liveStats, config, state, debugFile);

          // Update live stats from assistant message usage (mid-conversation)
          if (event.type === "assistant" && event.message?.usage) {
            const u = event.message.usage as Record<string, number>;
            liveStats.inputTokens += u.input_tokens || 0;
            liveStats.outputTokens += u.output_tokens || 0;
            footer.setLiveStats(liveStats);
          }

          // Extract final token usage from result events
          if (event.type === "result") {
            if (event.usage) {
              const u = event.usage as Record<string, number>;
              tokenUsage = {
                inputTokens: u.input_tokens || 0,
                outputTokens: u.output_tokens || 0,
                cacheReadTokens: u.cache_read_input_tokens || 0,
                cacheCreationTokens: u.cache_creation_input_tokens || 0,
              };
            }
            costUsd = (event.total_cost_usd as number) || 0;

            liveStats.costUsd = costUsd;
            liveStats.inputTokens = tokenUsage?.inputTokens || 0;
            liveStats.outputTokens = tokenUsage?.outputTokens || 0;
            footer.setLiveStats(liveStats);
          }
        } catch {
          // Not valid JSON, output as-is
          footer.writeln(line);
          output += line + "\n";
        }
      }
    }
  } catch (err) {
    footer.writeln(chalk.red(`Error reading Claude output: ${err}`));
  }

  // Process remaining buffer
  if (buffer.trim()) {
    footer.writeln(buffer);
    output += buffer + "\n";
  }

  // Read stderr
  try {
    const stderrText = await new Response(proc.stderr).text();
    if (stderrText.trim()) {
      footer.writeln(chalk.yellow(stderrText));
      output += stderrText;
    }
  } catch {
    // Ignore stderr read errors
  }

  // Wait for process to exit
  const exitCode = await proc.exited;
  const durationMs = Date.now() - startTime;

  // Clean up temp debug file
  try { await Bun.file(debugFile).exists() && Bun.$`rm -f ${debugFile}`.quiet(); } catch { /* ignore */ }

  // Check sentinel strings against the final text block only
  const finalText = state.lastTextBlock;
  const stopStringDetected = config.stopString
    ? finalText.includes(config.stopString)
    : false;
  const continueStringDetected = config.continueString
    ? finalText.includes(config.continueString)
    : false;

  return {
    iteration,
    success: exitCode === 0,
    exitCode,
    durationMs,
    tokenUsage,
    costUsd,
    output,
    stopStringDetected,
    continueStringDetected,
    finalResponse: finalText,
  };
}

// ─── Event Processing ──────────────────────────────────────────────────

interface ProcessingState {
  thinkingStarted: boolean;
  setThinkingStarted: (v: boolean) => void;
  appendOutput: (text: string) => void;
  /** Track whether we've seen streaming deltas (to avoid double-printing from assistant events) */
  hasStreamedContent: boolean;
  markdownStreamer: MarkdownStreamer;
  /** Content of the most recent text block (reset on each new text block start) */
  lastTextBlock: string;
}

async function processEvent(
  event: Record<string, unknown>,
  blocks: Record<number, StreamingBlock>,
  footer: StickyFooter,
  liveStats: LiveIterationStats,
  config: LoopConfig,
  state: ProcessingState,
  debugFile: string,
): Promise<void> {
  const eventType = event.type as string;

  switch (eventType) {
    case "system":
      await handleSystemEvent(event, footer, config, debugFile);
      break;

    case "content_block_start":
      handleBlockStart(event, blocks, state, footer);
      break;

    case "content_block_delta":
      handleBlockDelta(event, blocks, footer, liveStats, state);
      break;

    case "content_block_stop":
      handleBlockStop(event, blocks, footer, state);
      break;

    case "assistant":
      handleAssistantMessage(event, footer, state);
      break;

    case "user":
      handleUserMessage(event, footer);
      break;

    case "result":
      handleResult(event, footer);
      break;

    case "message_start":
    case "message_delta":
    case "message_stop":
    case "ping":
      // Known streaming protocol events, no action needed
      break;

    default:
      // Unknown event type, ignore
      break;
  }
}

async function handleSystemEvent(
  event: Record<string, unknown>,
  footer: StickyFooter,
  config: LoopConfig,
  debugFile: string,
): Promise<void> {
  const subtype = event.subtype as string;
  if (subtype === "init") {
    const model = event.model as string | undefined;
    const sessionId = event.session_id as string | undefined;
    if (model) {
      footer.writeln(chalk.dim(`  ◆ Model: ${model}`));
    }
    if (config.verbose && sessionId) {
      footer.writeln(chalk.dim(`  Session: ${sessionId}`));
    }

    // Show MCP server status
    const mcpServers = event.mcp_servers as Array<Record<string, string>> | undefined;
    const hasFailed = mcpServers?.some((s) => s.status === "failed");

    // If any MCP failed, read the debug file for error details
    let mcpErrors: Record<string, string> = {};
    if (hasFailed) {
      mcpErrors = await parseMcpErrors(debugFile);
    }

    if (mcpServers && mcpServers.length > 0) {
      for (const server of mcpServers) {
        const name = server.name || "unknown";
        const status = server.status || "unknown";
        if (status === "failed") {
          const errorDetail = mcpErrors[name];
          if (errorDetail) {
            footer.writeln(chalk.red(`  MCP: ${name} - FAILED: ${errorDetail}`));
          } else {
            footer.writeln(chalk.red(`  MCP: ${name} - FAILED`));
          }
        } else if (status === "connected" || status === "running") {
          footer.writeln(chalk.green(`  MCP: ${name} - connected`));
        } else {
          footer.writeln(chalk.dim(`  MCP: ${name} - ${status}`));
        }
      }
    }
  }
}

/**
 * Parse the Claude debug log file for MCP connection error messages.
 * Returns a map of server name -> error message.
 */
async function parseMcpErrors(debugFile: string): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  try {
    const file = Bun.file(debugFile);
    if (await file.exists()) {
      const content = await file.text();
      // Match lines like: [ERROR] MCP server "name" Connection failed: reason
      // or: MCP server "name": Connection failed after Xms: reason
      for (const line of content.split("\n")) {
        const errorMatch = line.match(/MCP server "([^"]+)"[:\s]+Connection failed(?:\s+after \d+ms)?:\s*(.+)/);
        if (errorMatch) {
          const name = errorMatch[1]!;
          const reason = errorMatch[2]!.trim();
          errors[name] = reason;
        }
      }
    }
  } catch {
    // Can't read debug file, no error details available
  }
  return errors;
}

function handleBlockStart(
  event: Record<string, unknown>,
  blocks: Record<number, StreamingBlock>,
  state: ProcessingState,
  footer: StickyFooter,
): void {
  const idx = event.index as number;
  const block = event.content_block as Record<string, unknown> | undefined;
  if (!block) return;

  const blockType = block.type as string;

  // Mark that we've received streaming blocks for this assistant turn,
  // so handleAssistantMessage knows to skip re-printing.
  if (blockType === "tool_use" || blockType === "text" || blockType === "thinking") {
    state.hasStreamedContent = true;
  }

  switch (blockType) {
    case "tool_use":
      blocks[idx] = { type: "tool_use", name: (block.name as string) || "tool", input: "" };
      break;
    case "text":
      // Reset markdown streamer so state doesn't leak across tool use gaps
      state.markdownStreamer.reset();
      state.lastTextBlock = "";
      footer.writeln("");
      blocks[idx] = { type: "text", content: "" };
      break;
    case "tool_result":
      blocks[idx] = { type: "tool_result", content: "" };
      break;
    case "thinking":
      blocks[idx] = { type: "thinking", content: "" };
      break;
  }
}

function handleBlockDelta(
  event: Record<string, unknown>,
  blocks: Record<number, StreamingBlock>,
  footer: StickyFooter,
  liveStats: LiveIterationStats,
  state: ProcessingState,
): void {
  const idx = event.index as number;
  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta) return;

  const deltaType = delta.type as string;

  switch (deltaType) {
    case "text_delta": {
      const text = delta.text as string;
      if (text) {
        state.hasStreamedContent = true;
        const sanitized = state.markdownStreamer.feed(text);
        if (sanitized) footer.write(orangeLines(sanitized));
        state.appendOutput(text);
        state.lastTextBlock += text; // track most recent text block for sentinel detection
        if (blocks[idx]) {
          blocks[idx].content = (blocks[idx].content || "") + text;
        }
      }
      break;
    }

    case "thinking_delta": {
      const thinking = delta.thinking as string;
      if (thinking) {
        if (!state.thinkingStarted) {
          footer.write("\n");
          state.setThinkingStarted(true);
        }
        // Stream thinking content — explicit gray color per-line to prevent ANSI bleed
        footer.write(dimLines(thinking));
        state.appendOutput(thinking);
        if (blocks[idx]) {
          blocks[idx].content = (blocks[idx].content || "") + thinking;
        }
      }
      break;
    }

    case "input_json_delta": {
      const partialJson = delta.partial_json as string;
      if (partialJson && blocks[idx]) {
        blocks[idx].input = (blocks[idx].input || "") + partialJson;
      }
      break;
    }
  }
}

function handleBlockStop(
  event: Record<string, unknown>,
  blocks: Record<number, StreamingBlock>,
  footer: StickyFooter,
  state: ProcessingState,
): void {
  const idx = event.index as number;
  const block = blocks[idx];
  if (!block) return;

  switch (block.type) {
    case "tool_use": {
      const description = formatToolUse(block.name || "tool", block.input || "{}");
      const icon = getToolIcon(block.name || "tool");
      footer.writeln(`${icon} ${chalk.cyan(description)}`);
      break;
    }

    case "tool_result": {
      const preview = formatToolResult(block.content);
      if (preview) {
        footer.writeln(preview);
      }
      footer.writeln(""); // blank line after tool result
      break;
    }

    case "thinking": {
      if (state.thinkingStarted) {
        footer.writeln("\n"); // newline after thinking
        state.setThinkingStarted(false);
      }
      break;
    }

    case "text": {
      // Flush any remaining buffered markdown
      const remaining = state.markdownStreamer.flush();
      if (remaining) footer.write(orangeLines(remaining));
      footer.writeln(""); // end current line
      footer.writeln(""); // blank line after text block
      break;
    }
  }

  delete blocks[idx];
}

function handleAssistantMessage(
  event: Record<string, unknown>,
  footer: StickyFooter,
  state: ProcessingState,
): void {
  const message = event.message as Record<string, unknown> | undefined;
  if (!message?.content) return;

  // If we already streamed this via content_block_delta events,
  // skip re-printing entirely to avoid duplicates.
  if (state.hasStreamedContent) {
    state.hasStreamedContent = false;
    return;
  }

  // Fallback: print content that wasn't streamed via deltas
  const content = message.content as Array<Record<string, unknown>>;
  for (const block of content) {
    const blockType = block.type as string;
    if (blockType === "text" && block.text) {
      const cleaned = stripSystemReminders(block.text as string);
      if (cleaned) {
        footer.writeln(cleaned);
        state.appendOutput(cleaned + "\n");
      }
    } else if (blockType === "tool_use") {
      const description = formatToolUse(
        block.name as string,
        typeof block.input === "string" ? block.input : JSON.stringify(block.input),
      );
      const icon = getToolIcon(block.name as string);
      footer.writeln(`${icon} ${chalk.cyan(description)}`);
    } else if (blockType === "tool_result" && block.content) {
      const preview = formatToolResult(block.content);
      if (preview) footer.writeln(preview);
    }
  }
}

function handleUserMessage(
  event: Record<string, unknown>,
  footer: StickyFooter,
): void {
  // User messages contain tool results. Display a preview of each.
  const message = event.message as Record<string, unknown> | undefined;
  if (!message?.content) return;

  const content = message.content as Array<Record<string, unknown>>;
  for (const block of content) {
    if (block.type === "tool_result") {
      // Extract the text content from the tool result
      let text: string | undefined;
      if (typeof block.content === "string") {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        // Content can be an array of {type: "text", text: "..."} parts
        text = (block.content as Array<Record<string, unknown>>)
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n");
      }

      if (text) {
        if (block.is_error) {
          // For errors, show with red styling instead of normal formatting
          const cleaned = text.replace(/<tool_use_error>[\s\S]*?<\/tool_use_error>/g, (m) =>
            m.replace(/<\/?tool_use_error>/g, "")).trim();
          if (cleaned) {
            footer.writeln(chalk.dim("    │ ") + chalk.red(cleaned));
            footer.writeln("");
          }
        } else {
          const preview = formatToolResult(text);
          if (preview) {
            footer.writeln(preview);
            footer.writeln("");
          }
        }
      }
    }
  }
}

function handleResult(
  event: Record<string, unknown>,
  footer: StickyFooter,
): void {
  const totalCost = event.total_cost_usd as number | undefined;
  const usage = event.usage as Record<string, number> | undefined;

  if (totalCost || usage) {
    footer.writeln("");
    footer.writeln(
      chalk.dim(
        `  Step cost: ${formatCost(totalCost || 0)} │ ` +
        `${formatNumber(usage?.input_tokens || 0)} in / ` +
        `${formatNumber(usage?.output_tokens || 0)} out`
      ),
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function dimLines(text: string): string {
  return text.replace(/[^\n]+/g, (m) => chalk.gray.italic(m));
}

const orange = chalk.hex("#FF9500");

function orangeLines(text: string): string {
  return text.replace(/[^\n]+/g, (m) => orange(m));
}

// ─── MCP Config Builder ────────────────────────────────────────────────

/**
 * Build a JSON string for --mcp-config from injectable MCP definitions.
 */
function buildMcpConfigJson(mcps: InjectableMcp[]): string {
  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};

  for (const mcp of mcps) {
    mcpServers[mcp.name] = {
      command: mcp.command,
      args: mcp.args,
      ...(mcp.env && Object.keys(mcp.env).length > 0 ? { env: mcp.env } : {}),
    };
  }

  return JSON.stringify({ mcpServers });
}
