#!/usr/bin/env bun

/**
 * ez-ralph-loop
 *
 * A CLI for running a "ralph loop" - repeatedly invoking Claude Code
 * with a prompt file, with rich streaming output, progress tracking,
 * cumulative cost tracking, and optional sentinel string detection.
 */

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { runClaudeIteration } from "./claude.js";
import { formatCost, formatDuration, formatNumber } from "./format.js";
import { StickyFooter } from "./terminal.js";
import { BUILTIN_MCPS, getMissingEnvVars } from "./mcps.js";
import type { CumulativeStats, InjectableMcp, IterationResult, LoopConfig, McpInjectFile, McpServerInfo } from "./types.js";

// ─── CLI Arg Parsing ───────────────────────────────────────────────────

const program = new Command()
  .name("ez-ralph-loop")
  .description("Run a ralph loop - repeatedly invoke Claude Code with a prompt file")
  .version("1.0.0")
  .option("-p, --prompt <path>", "path to prompt file", "./PROMPT.md")
  .option("-i, --iterations <number>", "number of iterations (0 = infinite)", "10")
  .option("-m, --model <model>", "Claude model to use")
  .option("--stop-string <string>", "stop loop when this string is detected in output")
  .option("--continue-string <string>", "continue only if this string is detected in output")
  .option("--log-file <path>", "log all output to this file")
  .option("-v, --verbose", "show raw JSON events", false)
  .option("--enable-mcps [servers]", "enable MCP servers: 'all' or comma-separated names (default: none)")
  .option("--mcp-inject <path>", "path to mcps.json file with injectable MCP servers")
  .option("--computer-use", "enable desktop control via desktop-commander MCP", false)
  .option("--no-interactive", "skip interactive prompts, use defaults for missing args")
  .parse(process.argv);

const opts = program.opts();

// ─── MCP Discovery ─────────────────────────────────────────────────────

/**
 * Discover available MCP servers by running `claude mcp list`,
 * then cross-reference with config files to determine the source.
 */
async function discoverMcpServers(): Promise<McpServerInfo[]> {
  try {
    const proc = Bun.spawn(["claude", "mcp", "list"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const servers: McpServerInfo[] = [];

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Checking")) continue;

      // Format: "name: command args... - STATUS_ICON Status text"
      const colonIdx = trimmed.indexOf(": ");
      if (colonIdx === -1) continue;

      const name = trimmed.substring(0, colonIdx).trim();
      const rest = trimmed.substring(colonIdx + 2);

      const dashIdx = rest.lastIndexOf(" - ");
      let command: string;
      let status: string;
      let healthy: boolean;

      if (dashIdx !== -1) {
        command = rest.substring(0, dashIdx).trim();
        const statusPart = rest.substring(dashIdx + 3).trim();
        status = statusPart.replace(/^[✓✗]\s*/, "").trim();
        healthy = statusPart.startsWith("✓");
      } else {
        command = rest.trim();
        status = "unknown";
        healthy = false;
      }

      servers.push({ name, command, healthy, status, source: undefined });
    }

    // Cross-reference with config files to find the source
    await resolveServerSources(servers);

    return servers;
  } catch {
    return [];
  }
}

/**
 * Determine which config file each MCP server comes from.
 *
 * Config sources:
 *   - User scope:    ~/.claude.json  (top-level "mcpServers")
 *   - Project scope: <cwd>/.mcp.json ("mcpServers")
 *   - Local scope:   ~/.claude.json  (projects.<cwd>.mcpServers)
 *   - Plugins:       ~/.claude/settings.json ("enabledPlugins")
 */
async function resolveServerSources(servers: McpServerInfo[]): Promise<void> {
  const home = process.env.HOME || "~";
  const cwd = process.cwd();

  // 1. Project scope: <cwd>/.mcp.json
  const projectMcpPath = `${cwd}/.mcp.json`;
  try {
    const file = Bun.file(projectMcpPath);
    if (await file.exists()) {
      const content = await file.json();
      for (const name of Object.keys(content.mcpServers || {})) {
        const match = servers.find((s) => s.name === name);
        if (match && !match.source) match.source = `.mcp.json (project)`;
      }
    }
  } catch { /* skip */ }

  // 2. User + Local scope: ~/.claude.json
  const claudeJsonPath = `${home}/.claude.json`;
  try {
    const file = Bun.file(claudeJsonPath);
    if (await file.exists()) {
      const content = await file.json();

      // User-scope MCPs (top-level "mcpServers")
      for (const name of Object.keys(content.mcpServers || {})) {
        const match = servers.find((s) => s.name === name);
        if (match && !match.source) match.source = `~/.claude.json (user)`;
      }

      // Local-scope MCPs (projects.<cwd>.mcpServers)
      const projectConfig = content.projects?.[cwd];
      if (projectConfig) {
        for (const name of Object.keys(projectConfig.mcpServers || {})) {
          const match = servers.find((s) => s.name === name);
          if (match && !match.source) match.source = `~/.claude.json (local)`;
        }
      }
    }
  } catch { /* skip */ }

  // 3. Plugins: ~/.claude/settings.json
  try {
    const file = Bun.file(`${home}/.claude/settings.json`);
    if (await file.exists()) {
      const settings = await file.json();
      for (const server of servers) {
        if (server.name.startsWith("plugin:") && !server.source) {
          server.source = `~/.claude/settings.json (plugin)`;
        }
      }
    }
  } catch { /* skip */ }

  // Fallback
  for (const server of servers) {
    if (!server.source) server.source = "unknown source";
  }
}

/**
 * Load injectable MCP servers from an mcps.json file.
 * Searches for the file at:
 *   1. Explicit path from --mcp-inject flag
 *   2. mcps.json next to the prompt file
 *   3. mcps.json in CWD
 */
async function loadInjectableMcps(explicitPath?: string, promptPath?: string): Promise<InjectableMcp[]> {
  const candidates: string[] = [];

  if (explicitPath) {
    candidates.push(explicitPath);
  }

  // Check next to the prompt file
  if (promptPath) {
    const dir = promptPath.substring(0, promptPath.lastIndexOf("/") + 1) || "./";
    candidates.push(`${dir}mcps.json`);
  }

  // Check CWD
  candidates.push("./mcps.json");

  for (const path of candidates) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        const content: McpInjectFile = await file.json();
        const mcps: InjectableMcp[] = [];

        for (const [name, config] of Object.entries(content.mcpServers || {})) {
          mcps.push({
            name,
            command: config.command,
            args: config.args || [],
            env: config.env,
          });
        }

        return mcps;
      }
    } catch {
      // Skip invalid files
    }
  }

  return [];
}

/**
 * Parse --enable-mcps flag value into a list of server names.
 * - undefined/false: no MCPs
 * - true or "all": all MCPs
 * - "name1,name2": specific servers
 */
function parseMcpFlag(value: unknown): string[] | "all" | "none" {
  if (value === undefined || value === false) return "none";
  if (value === true || value === "all") return "all";
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return "none";
}

// ─── Interactive Prompts ───────────────────────────────────────────────

async function gatherConfig(): Promise<LoopConfig> {
  // Check which args were explicitly provided on the CLI
  const explicitArgs = new Set<string>();
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("-")) {
      const clean = arg.replace(/^-+/, "").split("=")[0] || "";
      explicitArgs.add(clean);
    }
  }

  const hasExplicit = (flags: string[]): boolean =>
    flags.some((f) => explicitArgs.has(f));

  // Determine if we need interactive mode
  const needsInteractive = opts.interactive !== false && !hasExplicit(["no-interactive"]);
  const allProvided =
    hasExplicit(["p", "prompt"]) &&
    hasExplicit(["i", "iterations"]);

  // If all key args provided or --no-interactive, skip prompts
  if (!needsInteractive || allProvided) {
    return await buildConfigFromOpts();
  }

  // Interactive mode via Clack
  p.intro(chalk.bgCyan.black(" ez-ralph-loop "));

  // Phase 1: core settings (group prompt)
  const core = await p.group(
    {
      promptPath: () =>
        p.text({
          message: "Path to prompt file",
          initialValue: opts.prompt || "./PROMPT.md",
          validate: (val) => {
            if (!val?.trim()) return "Path is required";
            return undefined;
          },
        }),
      iterations: () =>
        p.text({
          message: "Number of iterations (0 = infinite)",
          initialValue: String(opts.iterations ?? "10"),
          validate: (val) => {
            const n = parseInt(val || "", 10);
            if (isNaN(n) || n < 0) return "Must be a non-negative integer";
            return undefined;
          },
        }),
      model: () =>
        p.select({
          message: "Claude model",
          options: [
            { value: "", label: "Default (let Claude decide)" },
            { value: "sonnet", label: "Claude Sonnet" },
            { value: "opus", label: "Claude Opus" },
            { value: "haiku", label: "Claude Haiku" },
          ],
          initialValue: opts.model || "",
        }),
      stopString: () =>
        p.text({
          message: "Stop string (leave empty to skip)",
          initialValue: opts.stopString || "",
        }),
      continueString: () =>
        p.text({
          message: "Continue string (leave empty to skip)",
          initialValue: opts.continueString || "",
        }),
      logFile: () =>
        p.text({
          message: "Log file path (leave empty to skip)",
          initialValue: opts.logFile || "",
        }),
    },
    {
      onCancel: () => {
        p.cancel("Cancelled.");
        process.exit(0);
      },
    },
  );

  // Phase 2: MCP server selection
  let selectedMcps: string[] = [];
  let selectedInjected: InjectableMcp[] = [];

  // Load injectable MCPs from mcps.json (custom user-defined ones)
  const promptPath = (core.promptPath as string).trim();
  const customInjectables = await loadInjectableMcps(opts.mcpInject, promptPath);

  p.note(
    "Add servers:   claude mcp add <name> -- <command>\n" +
    "Add plugins:   claude plugin add <name>\n" +
    "\n" +
    "Config files:\n" +
    "  User:    ~/.claude.json\n" +
    "  Project: .mcp.json (in project root)\n" +
    "  Local:   ~/.claude.json (per-project section)\n" +
    "  Plugins: ~/.claude/settings.json\n" +
    "\n" +
    "Custom MCPs: define in mcps.json next to your prompt\n" +
    "Built-in MCPs: select from the list below (injected via npx)\n" +
    "\n" +
    "Disabling MCPs speeds up startup significantly.",
    "MCP Servers",
  );

  const wantMcps = await p.confirm({
    message: "Enable MCP servers?",
    initialValue: false,
  });

  if (p.isCancel(wantMcps)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  if (wantMcps) {
    // Discover configured MCPs
    const spinner = p.spinner();
    spinner.start("Discovering MCP servers...");
    const servers = await discoverMcpServers();
    spinner.stop(
      servers.length > 0
        ? `Found ${servers.length} configured MCP server${servers.length > 1 ? "s" : ""}`
        : "No configured MCP servers found",
    );

    // Build combined options: configured + custom injectable + built-in
    const options: Array<{ value: string; label: string; hint: string }> = [];
    const defaults: string[] = [];

    // Section 1: Configured MCPs (from Claude's config)
    for (const s of servers) {
      const statusIcon = s.healthy ? chalk.green("OK") : chalk.red(s.status);
      options.push({
        value: `configured:${s.name}`,
        label: `${s.name}  ${chalk.dim(`[${s.source}]`)}`,
        hint: `${s.command} (${statusIcon})`,
      });
      if (s.healthy) defaults.push(`configured:${s.name}`);
    }

    // Section 2: Custom injectable MCPs (from mcps.json)
    for (const m of customInjectables) {
      const cmdStr = [m.command, ...m.args].join(" ");
      options.push({
        value: `inject:${m.name}`,
        label: `${m.name}  ${chalk.dim("[mcps.json]")}`,
        hint: cmdStr,
      });
      defaults.push(`inject:${m.name}`);
    }

    // Section 3: Built-in MCPs (bundled in the binary)
    for (const m of BUILTIN_MCPS) {
      // Skip built-ins that overlap with configured or custom MCPs
      const alreadyListed = servers.some((s) => s.name.includes(m.name))
        || customInjectables.some((c) => c.name === m.name);
      if (alreadyListed) continue;

      const missing = getMissingEnvVars(m);
      const hints: string[] = [];
      if (m.description) hints.push(m.description);
      if (missing.length > 0) hints.push(chalk.yellow(`needs: ${missing.join(", ")}`));
      if (m.prereqs) hints.push(chalk.dim(m.prereqs));

      options.push({
        value: `builtin:${m.name}`,
        label: `${m.name}  ${chalk.dim("[built-in]")}`,
        hint: hints.join(" | "),
      });
      // Don't pre-select built-ins
    }

    if (options.length > 0) {
      const mcpChoices = await p.multiselect({
        message: "Select MCP servers to enable",
        options,
        initialValues: defaults,
        required: false,
      });

      if (p.isCancel(mcpChoices)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }

      const chosen = mcpChoices as string[];

      // Split into configured vs injected
      const allInjectables = [...customInjectables, ...BUILTIN_MCPS];
      for (const choice of chosen) {
        if (choice.startsWith("configured:")) {
          selectedMcps.push(choice.substring("configured:".length));
        } else if (choice.startsWith("inject:") || choice.startsWith("builtin:")) {
          const name = choice.replace(/^(inject|builtin):/, "");
          const mcp = allInjectables.find((m) => m.name === name);
          if (mcp) selectedInjected.push(mcp);
        }
      }
    } else {
      p.log.info("No MCP servers available.");
    }
  }

  p.outro(chalk.dim("Configuration complete."));

  return {
    promptPath,
    iterations: parseInt(core.iterations as string, 10),
    model: (core.model as string) || undefined,
    stopString: (core.stopString as string).trim() || undefined,
    continueString: (core.continueString as string).trim() || undefined,
    logFile: (core.logFile as string).trim() || undefined,
    verbose: opts.verbose ?? false,
    mcpServers: selectedMcps,
    injectedMcps: selectedInjected,
  };
}

async function buildConfigFromOpts(): Promise<LoopConfig> {
  const mcpFlag = parseMcpFlag(opts.enableMcps);
  let mcpServers: string[] = [];
  let injectedMcps: InjectableMcp[] = [];

  if (mcpFlag === "all") {
    const servers = await discoverMcpServers();
    mcpServers = servers.map((s) => s.name);
  } else if (Array.isArray(mcpFlag)) {
    // Check if any of the names match built-in MCPs
    const configuredNames: string[] = [];
    for (const name of mcpFlag) {
      const builtin = BUILTIN_MCPS.find((m) => m.name === name);
      if (builtin) {
        injectedMcps.push(builtin);
      } else {
        configuredNames.push(name);
      }
    }
    mcpServers = configuredNames;
  }

  // --computer-use shortcut: inject desktop-commander
  if (opts.computerUse) {
    const dc = BUILTIN_MCPS.find((m) => m.name === "desktop-commander");
    if (dc && !injectedMcps.some((m) => m.name === dc.name)) {
      injectedMcps.push(dc);
    }
  }

  // Also load injectable MCPs from mcps.json if --mcp-inject is set
  const promptPath = opts.prompt || "./PROMPT.md";
  const customInjectables = await loadInjectableMcps(opts.mcpInject, promptPath);
  if (opts.mcpInject || mcpFlag !== "none") {
    injectedMcps = [...injectedMcps, ...customInjectables];
  }

  return {
    promptPath,
    iterations: parseInt(opts.iterations, 10) || 10,
    model: opts.model || undefined,
    stopString: opts.stopString || undefined,
    continueString: opts.continueString || undefined,
    logFile: opts.logFile || undefined,
    verbose: opts.verbose ?? false,
    mcpServers,
    injectedMcps,
  };
}

// ─── Re-run Command Builder ────────────────────────────────────────────

function buildRerunCommand(config: LoopConfig): string {
  const parts = ["ez-ralph-loop"];

  parts.push("-p", JSON.stringify(config.promptPath));
  parts.push("-i", String(config.iterations));
  if (config.model) parts.push("-m", config.model);
  if (config.stopString) parts.push("--stop-string", JSON.stringify(config.stopString));
  if (config.continueString) parts.push("--continue-string", JSON.stringify(config.continueString));
  if (config.logFile) parts.push("--log-file", JSON.stringify(config.logFile));
  if (config.verbose) parts.push("-v");
  if (config.mcpServers.length > 0) {
    parts.push("--enable-mcps", config.mcpServers.join(","));
  }
  if (config.injectedMcps.length > 0) {
    // For re-run, reference built-in MCPs by name via --enable-mcps
    // and custom mcps.json ones via --mcp-inject
    const builtinNames = BUILTIN_MCPS.map((m) => m.name);
    const injectedBuiltins = config.injectedMcps.filter((m) => builtinNames.includes(m.name));
    const injectedCustom = config.injectedMcps.filter((m) => !builtinNames.includes(m.name));

    // Use --computer-use shortcut if desktop-commander is the only injected built-in
    const hasDesktopCommander = injectedBuiltins.some((m) => m.name === "desktop-commander");
    const otherBuiltins = injectedBuiltins.filter((m) => m.name !== "desktop-commander");

    if (hasDesktopCommander) {
      parts.push("--computer-use");
    }

    if (otherBuiltins.length > 0) {
      const allMcpNames = [
        ...config.mcpServers,
        ...otherBuiltins.map((m) => m.name),
      ];
      const enableIdx = parts.indexOf("--enable-mcps");
      if (enableIdx !== -1) {
        parts.splice(enableIdx, 2);
      }
      parts.push("--enable-mcps", allMcpNames.join(","));
    }

    if (injectedCustom.length > 0) {
      const dir = config.promptPath.substring(0, config.promptPath.lastIndexOf("/") + 1) || "./";
      parts.push("--mcp-inject", JSON.stringify(`${dir}mcps.json`));
    }
  }
  parts.push("--no-interactive");

  return parts.join(" ");
}

// ─── Validation ────────────────────────────────────────────────────────

async function validateConfig(config: LoopConfig): Promise<void> {
  // Check prompt file exists
  const file = Bun.file(config.promptPath);
  const exists = await file.exists();
  if (!exists) {
    console.error(chalk.red(`Error: Prompt file not found: ${config.promptPath}`));
    process.exit(1);
  }

  // Check claude CLI is available
  try {
    const proc = Bun.spawn(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error(chalk.red("Error: 'claude' CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-cli"));
      process.exit(1);
    }
  } catch {
    console.error(chalk.red("Error: Could not check for 'claude' CLI."));
    process.exit(1);
  }

  // Quick auth check: run `claude --version` just to confirm the binary works
  // (actual auth errors will surface on the first iteration with a clear message)
  try {
    const proc = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error(chalk.red("Error: 'claude' CLI is not working properly. Try running 'claude' to check."));
      process.exit(1);
    }
  } catch {
    // Non-fatal
  }
}

// ─── Ralph Loop ────────────────────────────────────────────────────────

async function runLoop(config: LoopConfig): Promise<void> {
  const footer = new StickyFooter(config.logFile);
  const cumulative: CumulativeStats = {
    completedIterations: 0,
    totalDurationMs: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  // Handle Ctrl+C gracefully
  const cleanup = () => {
    footer.deactivate();
    printFinalSummary(cumulative, config, "interrupted");
    footer.closeLog();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  footer.activate();

  const maxIterations = config.iterations === 0 ? Infinity : config.iterations;
  let stopReason: string | undefined;

  for (let i = 1; i <= maxIterations; i++) {
    // Print iteration header in scroll area
    const iterLabel = config.iterations === 0
      ? `Iteration ${i} (infinite mode)`
      : `Iteration ${i}/${config.iterations}`;

    const cols = process.stdout.columns || 80;
    footer.writeln("");
    footer.writeln(chalk.blue("─".repeat(cols)));
    footer.writeln(chalk.bold.blue(`  ${iterLabel}`));
    footer.writeln("");

    // Run Claude
    let result: IterationResult;
    try {
      result = await runClaudeIteration(config, i, footer);
    } catch (err) {
      footer.writeln(chalk.red(`\nFatal error in iteration ${i}: ${err}`));
      stopReason = `fatal error on iteration ${i}`;
      break;
    }

    // Update cumulative stats
    cumulative.completedIterations = i;
    cumulative.totalDurationMs += result.durationMs;
    cumulative.totalCostUsd += result.costUsd || 0;
    cumulative.totalInputTokens += result.tokenUsage?.inputTokens || 0;
    cumulative.totalOutputTokens += result.tokenUsage?.outputTokens || 0;
    footer.setCumulative(cumulative);

    // Print iteration summary in scroll area
    footer.writeln("");
    const statusIcon = result.success ? chalk.green("  ✓") : chalk.red("  ✗");
    const statusText = result.success ? chalk.green("Success") : chalk.red(`Failed (exit ${result.exitCode})`);
    footer.writeln(
      `${statusIcon} ${chalk.bold(`Iteration ${i}`)} ${chalk.dim("·")} ${statusText} ${chalk.dim("·")} ${formatDuration(result.durationMs)} ${chalk.dim("·")} ${formatCost(result.costUsd || 0)}`
    );

    // Sentinel detection
    if (config.stopString) {
      if (result.stopStringDetected) {
        footer.writeln(chalk.yellow(`  Sentinel: "${config.stopString}" detected - stopping loop`));
        stopReason = `--stop-string "${config.stopString}" detected on iteration ${i}`;
        break;
      } else {
        footer.writeln(chalk.dim(`  Sentinel: "${config.stopString}" not detected`));
      }
    }

    if (config.continueString) {
      if (!result.continueStringDetected) {
        footer.writeln(chalk.yellow(`  Sentinel: "${config.continueString}" NOT detected - stopping loop`));
        stopReason = `--continue-string "${config.continueString}" not detected on iteration ${i}`;
        break;
      } else {
        footer.writeln(chalk.dim(`  Sentinel: "${config.continueString}" detected - continuing`));
      }
    }

    // Check non-zero exit code
    if (!result.success) {
      footer.writeln(chalk.yellow(`  Claude exited with code ${result.exitCode}`));
      // Continue anyway - let the user's iteration count decide
    }
  }

  if (!stopReason && maxIterations !== Infinity) {
    stopReason = "all iterations completed";
  }

  footer.deactivate();

  process.removeListener("SIGINT", cleanup);
  process.removeListener("SIGTERM", cleanup);

  printFinalSummary(cumulative, config, stopReason || "loop finished");

  await footer.closeLog();
}

// ─── Final Summary ─────────────────────────────────────────────────────

function printFinalSummary(
  cumulative: CumulativeStats,
  config: LoopConfig,
  stopReason: string,
): void {
  const cols = process.stdout.columns || 80;
  console.log("");
  console.log(chalk.green("━".repeat(cols)));
  console.log(chalk.bold.green("  ✓ Ralph Loop Complete"));
  console.log("");
  const totalLabel = config.iterations === 0
    ? `${cumulative.completedIterations} (infinite mode)`
    : `${cumulative.completedIterations}/${config.iterations}`;
  console.log(`  Iterations:  ${totalLabel}`);
  console.log(`  Duration:    ${formatDuration(cumulative.totalDurationMs)}`);
  console.log(`  Cost:        ${formatCost(cumulative.totalCostUsd)}`);
  console.log(`  Tokens:      ${formatNumber(cumulative.totalInputTokens)} in / ${formatNumber(cumulative.totalOutputTokens)} out`);
  console.log(`  Stopped:     ${chalk.dim(stopReason)}`);
  console.log("");
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = await gatherConfig();

  // Validate
  await validateConfig(config);

  // Show re-run command
  const rerunCmd = buildRerunCommand(config);
  console.log("");
  console.log(chalk.dim("To re-run with these settings:"));
  console.log(chalk.cyan(`  ${rerunCmd}`));
  console.log("");

  // Show config summary
  console.log(chalk.bold("Configuration:"));
  console.log(`  Prompt:     ${config.promptPath}`);
  console.log(`  Iterations: ${config.iterations === 0 ? "infinite" : config.iterations}`);
  if (config.model) console.log(`  Model:      ${config.model}`);
  if (config.stopString) console.log(`  Stop:       "${config.stopString}"`);
  if (config.continueString) console.log(`  Continue:   "${config.continueString}"`);
  if (config.logFile) console.log(`  Log file:   ${config.logFile}`);
  const hasMcps = config.mcpServers.length > 0 || config.injectedMcps.length > 0;
  if (hasMcps) {
    if (config.mcpServers.length > 0) {
      console.log(`  MCPs:       ${config.mcpServers.join(", ")}`);
    }
    if (config.injectedMcps.length > 0) {
      const injectedNames = config.injectedMcps.map((m) => m.name).join(", ");
      console.log(`  Injected:   ${injectedNames}`);
    }
  } else {
    console.log(`  MCPs:       disabled (use --enable-mcps or --mcp-inject to enable)`);
  }
  console.log("");

  // Run the loop
  await runLoop(config);
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err}`));
  process.exit(1);
});
