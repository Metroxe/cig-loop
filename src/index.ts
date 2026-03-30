#!/usr/bin/env bun

/**
 * cig-loop
 *
 * A CLI for running a "cig loop" - repeatedly invoking Claude Code
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
import { VERSION, checkForUpdate } from "./version.js";
import { DaemonController } from "./daemon.js";
import type { CumulativeStats, InjectableMcp, IterationResult, LoopConfig, McpInjectFile, McpServerInfo, ThrottleConfig } from "./types.js";
import { checkThrottle, formatResetTime, UsagePoller } from "./usage.js";

// ─── Subcommand Routing ────────────────────────────────────────────────

if (process.argv[2] === "boilerplate") {
  const { runBoilerplate } = await import("./boilerplate.js");
  await runBoilerplate();
  process.exit(0);
}

if (process.argv[2] === "update") {
  const { runUpdate } = await import("./update.js");
  await runUpdate();
  process.exit(0);
}

if (["list", "status", "stop", "logs", "pause", "resume", "attach"].includes(process.argv[2] || "")) {
  const { runClientCommand } = await import("./daemon-cli.js");
  await runClientCommand(process.argv[2] as string, process.argv[3]);
  process.exit(0);
}

if (process.argv[2] === "sessions") {
  const { runSessionBrowser } = await import("./sessions.js");
  await runSessionBrowser();
  process.exit(0);
}

// "default" subcommand — autopilot preset with optional overrides
if (process.argv[2] === "default") {
  const defaults = [
    "-p", "./autopilot/PROMPT.md",
    "-m", "sonnet",
    "-i", "30",
    "--throttle-dynamic",
    "--enable-mcps", "playwright",
    "--stop-string", "[STOP LOOP]",
    "--continue-string", "[CONTINUE LOOP]",
    "--log-file", "./autopilot/log.txt",
  ];
  // Remove "default" from argv; append defaults BEFORE extra args so
  // user-provided flags (argv[3+]) override them.
  const extraArgs = process.argv.slice(3);
  process.argv = [process.argv[0]!, process.argv[1]!, ...defaults, ...extraArgs];
}

// ─── CLI Arg Parsing ───────────────────────────────────────────────────

const program = new Command()
  .name("cig-loop")
  .description("Run a cig loop - repeatedly invoke Claude Code with a prompt file")
  .version(VERSION)
  .option("-p, --prompt <path>", "path to prompt file", "./PROMPT.md")
  .option("-i, --iterations <number>", "number of iterations (0 = infinite)", "10")
  .option("-m, --model <model>", "Claude model to use")
  .option("--stop-string <string>", "stop loop when this string is detected in output")
  .option("--continue-string <string>", "continue only if this string is detected in output")
  .option("--log-file <path>", "log all output to this file")
  .option("--max-log-lines <number>", "max lines to keep in log file (0 = unlimited)", "0")
  .option("-v, --verbose", "show raw JSON events", false)
  .option("--enable-mcps [servers]", "enable MCP servers: 'all' or comma-separated names (default: none)")
  .option("--mcp-inject <path>", "path to mcps.json file with injectable MCP servers")
  .option("--ide", "enable IDE integration", false)
  .option("--chrome", "enable Chrome browser integration", false)
  .option("-d, --delay <seconds>", "delay in seconds between iterations", "0")
  .option("-t, --timeout <seconds>", "max wall-clock time per iteration in seconds (0 = no limit)", "0")
  .option("--throttle-5h <percent>", "pause when 5h usage exceeds % (0=off)", "0")
  .option("--throttle-7d <percent>", "pause when 7d usage exceeds % (0=off)", "0")
  .option("--throttle-sonnet <percent>", "pause when sonnet/opus usage exceeds % (0=off)", "0")
  .option("--throttle-dynamic", "dynamic throttle: pace usage proportionally across each window", false)
  .option("--daemon", "run headless as a daemon with a control socket", false)
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
      const mcpServers = content.mcpServers || {};
      for (const [name, def] of Object.entries(mcpServers)) {
        const match = servers.find((s) => s.name === name);
        if (match && !match.source) {
          match.source = `.mcp.json (project)`;
          const typedDef = def as { command: string; args?: string[]; env?: Record<string, string> };
          match.parsedCommand = typedDef.command;
          match.parsedArgs = typedDef.args || [];
          match.env = typedDef.env;
        }
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
      const userMcpServers = content.mcpServers || {};
      for (const [name, def] of Object.entries(userMcpServers)) {
        const match = servers.find((s) => s.name === name);
        if (match && !match.source) {
          match.source = `~/.claude.json (user)`;
          const typedDef = def as { command: string; args?: string[]; env?: Record<string, string> };
          match.parsedCommand = typedDef.command;
          match.parsedArgs = typedDef.args || [];
          match.env = typedDef.env;
        }
      }

      // Local-scope MCPs (projects.<cwd>.mcpServers)
      const projectConfig = content.projects?.[cwd];
      if (projectConfig) {
        const localMcpServers = projectConfig.mcpServers || {};
        for (const [name, def] of Object.entries(localMcpServers)) {
          const match = servers.find((s) => s.name === name);
          if (match && !match.source) {
            match.source = `~/.claude.json (local)`;
            const typedDef = def as { command: string; args?: string[]; env?: Record<string, string> };
            match.parsedCommand = typedDef.command;
            match.parsedArgs = typedDef.args || [];
            match.env = typedDef.env;
          }
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

  // Fallback: parse command string for servers not found in any config file
  for (const server of servers) {
    if (!server.source) server.source = "unknown source";
    if (!server.parsedCommand) {
      const parts = server.command.split(/\s+/);
      server.parsedCommand = parts[0] || server.command;
      server.parsedArgs = parts.slice(1);
    }
  }
}

/**
 * Convert a discovered MCP server into an injectable MCP definition.
 */
function mcpServerToInjectable(server: McpServerInfo): InjectableMcp {
  return {
    name: server.name,
    command: server.parsedCommand || server.command.split(/\s+/)[0] || server.command,
    args: server.parsedArgs || server.command.split(/\s+/).slice(1),
    env: server.env,
  };
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

/**
 * Search for PROMPT.md in the current directory and immediate subdirectories.
 * Returns the path if found, otherwise undefined.
 */
async function findPromptMd(): Promise<string | undefined> {
  // Check current directory
  const cwdPrompt = Bun.file("./PROMPT.md");
  if (await cwdPrompt.exists()) {
    return "./PROMPT.md";
  }

  // Check immediate subdirectories in parallel
  try {
    const proc = Bun.spawn(["ls", "-d", "*/"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const subdirs = stdout
      .split("\n")
      .map((line) => line.trim().replace(/\/$/, ""))
      .filter(Boolean);

    // Check all subdirectories in parallel
    const checks = subdirs.map(async (subdir) => {
      const subdirPrompt = Bun.file(`./${subdir}/PROMPT.md`);
      if (await subdirPrompt.exists()) {
        return `./${subdir}/PROMPT.md`;
      }
      throw new Error("not found");
    });

    // Return the first one that resolves successfully
    return await Promise.any(checks);
  } catch {
    // Either ls failed or no PROMPT.md found in any subdir
  }

  return undefined;
}

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
  p.intro(chalk.bgCyan.black(" cig-loop "));

  // Find PROMPT.md if it exists
  const foundPromptPath = await findPromptMd();

  // Phase 1: core settings (group prompt)
  const core = await p.group(
    {
      promptPath: () =>
        p.text({
          message: "Path to prompt file",
          initialValue: opts.prompt || foundPromptPath,
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
      delaySeconds: () =>
        p.text({
          message: "Delay between iterations in seconds (0 = no delay)",
          initialValue: String(opts.delay ?? "0"),
          validate: (val) => {
            const n = parseFloat(val || "");
            if (isNaN(n) || n < 0) return "Must be a non-negative number";
            return undefined;
          },
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
  let selectedMcps: InjectableMcp[] = [];

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

      // Convert all choices to InjectableMcp definitions
      const allInjectables = [...customInjectables, ...BUILTIN_MCPS];
      for (const choice of chosen) {
        if (choice.startsWith("configured:")) {
          const name = choice.substring("configured:".length);
          const server = servers.find((s) => s.name === name);
          if (server) selectedMcps.push(mcpServerToInjectable(server));
        } else if (choice.startsWith("inject:") || choice.startsWith("builtin:")) {
          const name = choice.replace(/^(inject|builtin):/, "");
          const mcp = allInjectables.find((m) => m.name === name);
          if (mcp) selectedMcps.push(mcp);
        }
      }
    } else {
      p.log.info("No MCP servers available.");
    }
  }

  // Phase 3: IDE and Chrome integration toggles
  const enableIde = await p.confirm({
    message: "Enable IDE integration? (--ide)",
    initialValue: false,
  });
  if (p.isCancel(enableIde)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const enableChrome = await p.confirm({
    message: "Enable Chrome integration? (--chrome)",
    initialValue: false,
  });
  if (p.isCancel(enableChrome)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // Phase 4: Throttle settings
  const wantThrottle = await p.confirm({
    message: "Enable usage throttling? (pause loop when nearing rate limits)",
    initialValue: false,
  });
  if (p.isCancel(wantThrottle)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  let throttle: ThrottleConfig = { fiveHour: 0, sevenDay: 0, sonnet: 0, dynamic: false };
  if (wantThrottle) {
    const throttleMode = await p.select({
      message: "Throttle mode",
      options: [
        { value: "dynamic", label: "Dynamic — pace usage proportionally across each window" },
        { value: "static", label: "Static — fixed percentage thresholds" },
      ],
      initialValue: "dynamic",
    });
    if (p.isCancel(throttleMode)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    if (throttleMode === "dynamic") {
      throttle = { fiveHour: 0, sevenDay: 0, sonnet: 0, dynamic: true };
    } else {
      const throttleInputs = await p.group(
        {
          fiveHour: () =>
            p.text({
              message: "5h usage threshold % (0 = off)",
              initialValue: "90",
              validate: (val) => {
                const n = parseInt(val || "", 10);
                if (isNaN(n) || n < 0 || n > 100) return "Must be 0-100";
                return undefined;
              },
            }),
          sevenDay: () =>
            p.text({
              message: "7d usage threshold % (0 = off)",
              initialValue: "80",
              validate: (val) => {
                const n = parseInt(val || "", 10);
                if (isNaN(n) || n < 0 || n > 100) return "Must be 0-100";
                return undefined;
              },
            }),
          sonnet: () =>
            p.text({
              message: "Sonnet/Opus usage threshold % (0 = off)",
              initialValue: "80",
              validate: (val) => {
                const n = parseInt(val || "", 10);
                if (isNaN(n) || n < 0 || n > 100) return "Must be 0-100";
                return undefined;
              },
            }),
        },
        {
          onCancel: () => {
            p.cancel("Cancelled.");
            process.exit(0);
          },
        },
      );
      throttle = {
        fiveHour: parseInt(throttleInputs.fiveHour as string, 10) || 0,
        sevenDay: parseInt(throttleInputs.sevenDay as string, 10) || 0,
        sonnet: parseInt(throttleInputs.sonnet as string, 10) || 0,
        dynamic: false,
      };
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
    maxLogLines: parseInt(opts.maxLogLines, 10) || 0,
    verbose: opts.verbose ?? false,
    injectedMcps: selectedMcps,
    enableIde: enableIde as boolean,
    enableChrome: enableChrome as boolean,
    delaySeconds: parseFloat(core.delaySeconds as string) || 0,
    timeoutSeconds: parseInt(opts.timeout, 10) || 0,
    throttle,
  };
}

async function buildConfigFromOpts(): Promise<LoopConfig> {
  const mcpFlag = parseMcpFlag(opts.enableMcps);
  let injectedMcps: InjectableMcp[] = [];

  if (mcpFlag === "all") {
    // Discover all configured MCPs and convert to injectable format
    const servers = await discoverMcpServers();
    injectedMcps = servers.map(mcpServerToInjectable);
  } else if (Array.isArray(mcpFlag)) {
    // Check built-ins first, then discover configured MCPs for the rest
    const remainingNames: string[] = [];
    for (const name of mcpFlag) {
      const builtin = BUILTIN_MCPS.find((m) => m.name === name);
      if (builtin) {
        injectedMcps.push(builtin);
      } else {
        remainingNames.push(name);
      }
    }

    if (remainingNames.length > 0) {
      const servers = await discoverMcpServers();
      for (const name of remainingNames) {
        const server = servers.find((s) => s.name === name);
        if (server) {
          injectedMcps.push(mcpServerToInjectable(server));
        } else {
          console.warn(chalk.yellow(`Warning: MCP server "${name}" not found in Claude config, skipping`));
        }
      }
    }
  }

  // Also load injectable MCPs from mcps.json if --mcp-inject is set
  const promptPath = opts.prompt || "./PROMPT.md";
  const customInjectables = await loadInjectableMcps(opts.mcpInject, promptPath);
  if (opts.mcpInject || mcpFlag !== "none") {
    for (const custom of customInjectables) {
      if (!injectedMcps.some((m) => m.name === custom.name)) {
        injectedMcps.push(custom);
      }
    }
  }

  return {
    promptPath,
    iterations: parseInt(opts.iterations, 10) || 10,
    model: opts.model || undefined,
    stopString: opts.stopString || undefined,
    continueString: opts.continueString || undefined,
    logFile: opts.logFile || undefined,
    maxLogLines: parseInt(opts.maxLogLines, 10) || 0,
    verbose: opts.verbose ?? false,
    injectedMcps,
    enableIde: opts.ide ?? false,
    enableChrome: opts.chrome ?? false,
    delaySeconds: parseFloat(opts.delay) || 0,
    timeoutSeconds: parseInt(opts.timeout, 10) || 0,
    throttle: {
      fiveHour: parseInt(opts.throttle5h, 10) || 0,
      sevenDay: parseInt(opts.throttle7d, 10) || 0,
      sonnet: parseInt(opts.throttleSonnet, 10) || 0,
      dynamic: opts.throttleDynamic ?? false,
    },
  };
}

// ─── Re-run Command Builder ────────────────────────────────────────────

function buildRerunCommand(config: LoopConfig): string {
  const parts = ["./cig-loop"];

  parts.push("-p", JSON.stringify(config.promptPath));
  if (config.model) parts.push("-m", config.model);
  if (config.stopString) parts.push("--stop-string", JSON.stringify(config.stopString));
  if (config.continueString) parts.push("--continue-string", JSON.stringify(config.continueString));
  if (config.logFile) parts.push("--log-file", JSON.stringify(config.logFile));
  if (config.maxLogLines > 0) parts.push("--max-log-lines", String(config.maxLogLines));
  if (config.verbose) parts.push("-v");

  if (config.injectedMcps.length > 0) {
    // Reference all MCPs by name — buildConfigFromOpts will rediscover and convert them
    const allNames = config.injectedMcps.map((m) => m.name);
    parts.push("--enable-mcps", allNames.join(","));
  }

  if (config.delaySeconds > 0) parts.push("-d", String(config.delaySeconds));
  if (config.timeoutSeconds > 0) parts.push("-t", String(config.timeoutSeconds));
  if (config.throttle.dynamic) {
    parts.push("--throttle-dynamic");
  } else {
    if (config.throttle.fiveHour > 0) parts.push("--throttle-5h", String(config.throttle.fiveHour));
    if (config.throttle.sevenDay > 0) parts.push("--throttle-7d", String(config.throttle.sevenDay));
    if (config.throttle.sonnet > 0) parts.push("--throttle-sonnet", String(config.throttle.sonnet));
  }
  if (config.enableIde) parts.push("--ide");
  if (config.enableChrome) parts.push("--chrome");

  parts.push("--no-interactive");
  parts.push("-i", String(config.iterations));

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

// ─── Gitignore Helper ──────────────────────────────────────────────────

async function ensureLogFileInGitignore(logFile: string): Promise<void> {
  const gitignorePath = `${process.cwd()}/.gitignore`;
  const entry = logFile.startsWith("./") ? logFile.slice(2) : logFile;
  const gi = Bun.file(gitignorePath);

  if (await gi.exists()) {
    const content = await gi.text();
    const lines = content.split("\n");
    if (lines.some((l) => l.trim() === entry)) return;
    const needsNewline = content.length > 0 && !content.endsWith("\n");
    await Bun.write(gi, content + (needsNewline ? "\n" : "") + entry + "\n");
  } else {
    await Bun.write(gi, entry + "\n");
  }
}

// ─── Cig Loop ──────────────────────────────────────────────────────────

async function runLoop(config: LoopConfig, daemon: DaemonController): Promise<void> {
  // TUI always runs in the attach layer; the loop itself is headless (log-only)
  const footer = new StickyFooter(config.logFile, config.maxLogLines, true);
  const cumulative: CumulativeStats = {
    completedIterations: 0,
    totalDurationMs: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  // Poller reference — set after activate(), used by cleanup handlers.
  let usagePoller: UsagePoller | null = null;

  // Ensure terminal is restored on any exit path (crash, uncaught exception, etc.)
  // This is a safety net — deactivate() is idempotent so double-calls are fine.
  const emergencyCleanup = () => {
    usagePoller?.stop();
    footer.deactivate();
  };
  process.on("exit", emergencyCleanup);

  // Handle Ctrl+C — triggers force-quit via daemon signals.
  // In auto-attach mode, the attach TUI handles Ctrl+C via the socket API,
  // so this only fires for bare daemon processes killed externally.
  const cleanup = () => {
    usagePoller?.stop();
    daemon.abortCurrentIteration();
    daemon.setStopReason("user interrupted (SIGINT)");
    daemon.setPhase("stopped");
    daemon.persistState();
    footer.deactivate();
    footer.closeLog();
    daemon.shutdown();
    // Don't process.exit — let the attach layer detect "stopped" and exit cleanly.
    // For bare --daemon mode (no attach), the loop will break on isForceQuitRequested.
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Handle uncaught errors
  const crashCleanup = (err: unknown) => {
    usagePoller?.stop();
    daemon.abortCurrentIteration();
    footer.deactivate();
    const errMsg = err instanceof Error ? err.message : String(err);
    daemon.setStopReason(`fatal error: ${errMsg}`);
    daemon.setPhase("stopped");
    footer.closeLog();
    daemon.shutdown();
    process.exit(1);
  };
  process.on("uncaughtException", crashCleanup);
  process.on("unhandledRejection", crashCleanup);

  await footer.activate();
  footer.setThrottleConfig(config.throttle);
  daemon.setThrottleConfig(config.throttle);

  // Centralized usage poller — shared across this process and coordinates
  // with other cig-loop processes via the disk cache.
  usagePoller = new UsagePoller();
  usagePoller.onUsage = (usage) => footer.setUsage(usage);
  usagePoller.onError = (error) => footer.setUsageFetchError(error);
  await usagePoller.start();

  // Hook live stats into daemon state
  footer.onLiveStats = (stats) => daemon.setLive(stats);

  const maxIterations = config.iterations === 0 ? Infinity : config.iterations;
  let stopReason: string | undefined;

  for (let i = 1; i <= maxIterations; i++) {
    // Check for stop/pause/force-quit signals
    if (daemon.isForceQuitRequested || daemon.isStopRequested) {
      stopReason = "stopped via control";
      break;
    }
    while (daemon.isPauseRequested) {
      daemon.setPhase("paused");
      await Bun.sleep(1000);
      if (daemon.isStopRequested || daemon.isForceQuitRequested) break;
    }
    if (daemon.isStopRequested || daemon.isForceQuitRequested) {
      stopReason = "stopped via control";
      break;
    }

    // Handle suspended state (force-stop was pressed — wait for continue or quit)
    while (daemon.isForceStopRequested) {
      daemon.setPhase("suspended");
      await daemon.persistState();
      await Bun.sleep(1000);
      if (daemon.isForceQuitRequested || daemon.isStopRequested) break;
    }
    if (daemon.isForceQuitRequested || daemon.isStopRequested) {
      stopReason = "stopped via control";
      break;
    }

    daemon.setPhase("running");
    daemon.setIteration(i);
    daemon.resetIterationAbort();

    // Throttle check: pause if any usage bucket exceeds its threshold.
    // Uses the poller's cached data — the poller handles the 5-min global
    // refresh cycle, so we never fire extra API calls here.
    const hasThrottle = config.throttle.dynamic || config.throttle.fiveHour > 0 || config.throttle.sevenDay > 0 || config.throttle.sonnet > 0;
    if (hasThrottle) {
      let throttleLogged = false;
      while (true) {
        const usage = usagePoller.usage;
        if (!usage) break; // no data yet, proceed
        const hit = checkThrottle(usage, config.model, config.throttle);
        if (!hit) {
          daemon.setPhase("running");
          break; // under threshold
        }
        daemon.setPhase("throttled");
        if (!throttleLogged) {
          footer.writeln(
            chalk.yellow(`\u23f8 Throttled: ${hit.bucket} at ${hit.utilization}% (limit: ${hit.threshold}%). Resets in ${formatResetTime(hit.resetsAt)}. Waiting for poller refresh...`)
          );
          throttleLogged = true;
        }
        // Wait 30s then re-check — the poller updates usage in the background
        await Bun.sleep(30_000);
      }
    }

    // Print iteration header in scroll area
    const iterLabel = config.iterations === 0
      ? `Iteration ${i} (infinite mode)`
      : `Iteration ${i}/${config.iterations}`;

    const cols = process.stdout.columns || 80;
    footer.writeln("");
    footer.writeln(chalk.hex("#5FAFAF")("─".repeat(cols)));
    footer.writeln(chalk.bold.hex("#5FAFAF")(`  ${iterLabel}`));
    footer.writeln("");

    // Run Claude using daemon's iteration-scoped abort signal
    let result: IterationResult;
    try {
      result = await runClaudeIteration(config, i, footer, daemon.iterationSignal);
    } catch (err) {
      // Check if this was a skip/force-stop/force-quit abort
      if (daemon.isSkipRequested) {
        footer.writeln(chalk.yellow(`  ⏭ Iteration ${i} skipped`));
        daemon.setLive(null);
        continue;
      }
      if (daemon.isForceStopRequested) {
        footer.writeln(chalk.yellow(`  ⏸ Force stopped during iteration ${i}`));
        daemon.setLive(null);
        i--; // Re-run this iteration after continue
        continue;
      }
      if (daemon.isForceQuitRequested || daemon.isStopRequested) {
        stopReason = "stopped via control";
        break;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      footer.writeln(chalk.red(`\nFatal error in iteration ${i}: ${errMsg}`));
      stopReason = `fatal error on iteration ${i}: ${errMsg}`;
      break;
    }

    // Check if the iteration was aborted by a daemon control signal
    // (not a real crash — the subprocess was killed intentionally)
    if (daemon.isSkipRequested) {
      footer.writeln(chalk.yellow(`  ⏭ Iteration ${i} skipped`));
      daemon.setLive(null);
      continue;
    }
    if (daemon.isForceStopRequested) {
      footer.writeln(chalk.yellow(`  ⏸ Force stopped during iteration ${i}`));
      daemon.setLive(null);
      // Don't increment i — re-run this iteration after continue
      i--;
      continue;
    }
    if (daemon.isForceQuitRequested || daemon.isStopRequested) {
      stopReason = "stopped via control";
      break;
    }

    // Update cumulative stats
    cumulative.completedIterations = i;
    cumulative.totalDurationMs += result.durationMs;
    cumulative.totalCostUsd += result.costUsd || 0;
    cumulative.totalInputTokens += result.tokenUsage?.inputTokens || 0;
    cumulative.totalOutputTokens += result.tokenUsage?.outputTokens || 0;
    footer.setCumulative(cumulative);
    daemon.setCumulative(cumulative);
    daemon.setLive(null);

    // Print iteration summary in scroll area
    footer.writeln("");
    const statusIcon = result.success ? chalk.green("✓") : chalk.red("✗");
    const statusText = result.success ? chalk.green("Success") : chalk.red(`Failed (exit ${result.exitCode})`);
    footer.writeln(
      `${statusIcon} ${chalk.bold(`Iteration ${i}`)} ${chalk.dim("·")} ${statusText} ${chalk.dim("·")} ${formatDuration(result.durationMs)} ${chalk.dim("·")} ${formatCost(result.costUsd || 0)}`
    );

    // Display final response highlighted
    if (result.finalResponse.trim()) {
      footer.writeln("");
      const responseLines = result.finalResponse.trim().split("\n");
      for (const line of responseLines) {
        footer.writeln(chalk.green(`  ${line}`));
      }
      footer.writeln("");
    }

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
      if (result.timedOut) {
        footer.writeln(chalk.yellow(`  Iteration timed out after ${config.timeoutSeconds}s - continuing to next iteration`));
        // Don't break — timeout is recoverable
      } else if (result.exitCode >= 128) {
        // Fatal signals (SIGKILL=137, SIGTERM=143, etc.) should stop the loop
        const signal = result.exitCode - 128;
        const signalName = { 9: "SIGKILL", 15: "SIGTERM", 11: "SIGSEGV", 6: "SIGABRT" }[signal] || `signal ${signal}`;
        stopReason = `Claude killed by ${signalName} (exit code ${result.exitCode}) on iteration ${i}`;
        footer.writeln(chalk.red(`  ${stopReason} - stopping loop`));
        break;
      } else {
        // Non-zero exit (e.g. rate limit hit mid-run) — retry this iteration
        // after the throttle check at the top of the loop catches it.
        footer.writeln(chalk.yellow(`  Will retry iteration ${i} after throttle check`));
        usagePoller.refresh();
        i--;
        continue;
      }
    }

    // Refresh usage now that Claude Code has exited — best window to get
    // fresh data since the API is less contended. Fire-and-forget.
    usagePoller.refresh();

    // Trim log if over the line limit
    await footer.flushAndTrimLog();

    // Delay between iterations (skip after last iteration)
    if (config.delaySeconds > 0 && i < maxIterations) {
      footer.writeln(chalk.dim(`  Waiting ${config.delaySeconds}s before next iteration...`));
      await Bun.sleep(config.delaySeconds * 1000);
    }
  }

  if (!stopReason && maxIterations !== Infinity) {
    stopReason = "all iterations completed";
  }

  usagePoller?.stop();
  footer.deactivate();

  process.removeListener("SIGINT", cleanup);
  process.removeListener("SIGTERM", cleanup);
  process.removeListener("exit", emergencyCleanup);
  process.removeListener("uncaughtException", crashCleanup);
  process.removeListener("unhandledRejection", crashCleanup);

  const finalReason = stopReason || "loop finished";
  daemon.setStopReason(finalReason);
  daemon.setPhase("stopped");
  await daemon.persistState();

  // Don't print summary here — the attached TUI will detect "stopped" phase
  // and handle display. Just clean up.
  await footer.closeLog();
  await daemon.shutdown();
}

// ─── Final Summary ─────────────────────────────────────────────────────

function printFinalSummary(
  cumulative: CumulativeStats,
  config: LoopConfig,
  stopReason: string,
): void {
  const cols = process.stdout.columns || 80;
  const isFatal = stopReason.startsWith("fatal error");
  const isInterrupted = stopReason.startsWith("user interrupted");
  const isSentinel = stopReason.startsWith("--stop-string") || stopReason.startsWith("--continue-string");
  const color = isFatal ? chalk.red : (isInterrupted || isSentinel) ? chalk.yellow : chalk.green;
  const icon = isFatal ? "✗" : (isInterrupted || isSentinel) ? "⚠" : "✓";

  console.log("");
  console.log(color("━".repeat(cols)));
  const heading = isFatal ? "Cig Loop Crashed" : (isInterrupted || isSentinel) ? "Cig Loop Stopped" : "Cig Loop Complete";
  console.log(chalk.bold(color(`  ${icon} ${heading}`)));
  console.log("");
  const totalLabel = config.iterations === 0
    ? `${cumulative.completedIterations} (infinite mode)`
    : `${cumulative.completedIterations}/${config.iterations}`;
  console.log(`  Iterations:  ${totalLabel}`);
  console.log(`  Duration:    ${formatDuration(cumulative.totalDurationMs)}`);
  console.log(`  Cost:        ${formatCost(cumulative.totalCostUsd)}`);
  console.log(`  Tokens:      ${formatNumber(cumulative.totalInputTokens)} in / ${formatNumber(cumulative.totalOutputTokens)} out`);
  console.log(`  Reason:      ${color(stopReason)}`);
  console.log("");
  console.log(`  ${chalk.dim("Rerun:")}     ${chalk.magenta(buildRerunCommand(config))}`);
  console.log("");
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Fire off update check in background (non-blocking)
  const updateCheckPromise = checkForUpdate();

  const config = await gatherConfig();

  // Validate
  await validateConfig(config);

  const isDaemon = opts.daemon === true;

  // Always ensure a log file exists (needed for daemon-first architecture)
  if (!config.logFile) {
    config.logFile = `cig-loop-${Date.now()}.log`;
  }

  // Ensure log file is gitignored
  await ensureLogFileInGitignore(config.logFile);

  // Show version
  console.log(chalk.bold(`cig-loop v${VERSION}`));
  console.log("");

  // Show update notice if a newer version is available
  const newerVersion = await updateCheckPromise;
  if (newerVersion) {
    console.log(
      chalk.yellow(`  Update available: v${VERSION} → v${newerVersion}`),
    );
    console.log(
      chalk.yellow(`  Run ${chalk.bold("cig-loop update")} to upgrade`),
    );
    console.log("");
  }

  // Show config summary
  console.log(chalk.bold("Configuration:"));
  console.log(`  Prompt:     ${config.promptPath}`);
  console.log(`  Iterations: ${config.iterations === 0 ? "infinite" : config.iterations}`);
  if (config.model) console.log(`  Model:      ${config.model}`);
  if (config.stopString) console.log(`  Stop:       "${config.stopString}"`);
  if (config.continueString) console.log(`  Continue:   "${config.continueString}"`);
  if (config.delaySeconds > 0) console.log(`  Delay:      ${config.delaySeconds}s between iterations`);
  if (config.timeoutSeconds > 0) console.log(`  Timeout:    ${config.timeoutSeconds}s per iteration`);
  if (config.logFile) {
    const logDetails = config.maxLogLines > 0
      ? `${config.logFile} (rolling, max ${config.maxLogLines} lines)`
      : config.logFile;
    console.log(`  Log file:   ${logDetails}`);
  }
  if (config.injectedMcps.length > 0) {
    const mcpNames = config.injectedMcps.map((m) => m.name).join(", ");
    console.log(`  MCPs:       ${mcpNames}`);
  } else {
    console.log(`  MCPs:       disabled (use --enable-mcps or --mcp-inject to enable)`);
  }
  if (config.throttle.dynamic) {
    console.log(`  Throttle:   dynamic (pace usage across each window)`);
  } else {
    const throttleParts: string[] = [];
    if (config.throttle.fiveHour > 0) throttleParts.push(`5h: ${config.throttle.fiveHour}%`);
    if (config.throttle.sevenDay > 0) throttleParts.push(`7d: ${config.throttle.sevenDay}%`);
    if (config.throttle.sonnet > 0) throttleParts.push(`sonnet: ${config.throttle.sonnet}%`);
    if (throttleParts.length > 0) {
      console.log(`  Throttle:   ${throttleParts.join(", ")}`);
    } else {
      console.log(`  Throttle:   disabled`);
    }
  }
  if (config.enableIde) console.log(`  IDE:        enabled`);
  if (config.enableChrome) console.log(`  Chrome:     enabled`);
  if (isDaemon) console.log(`  Mode:       ${chalk.cyan("daemon (background)")}`);
  console.log("");

  if (isDaemon) {
    // Daemon mode: run the loop headless in this process
    // Truncate log file before registering so the attach TUI doesn't
    // load stale content from a previous run.
    await Bun.write(config.logFile!, "");

    const daemon = new DaemonController(config);
    daemon.setLogFile(config.logFile!);
    await daemon.start();
    await daemon.persistState();

    console.log(chalk.cyan(`  Session:    ${daemon.id}`));
    console.log(chalk.cyan(`  Log:        ${config.logFile}`));
    console.log("");
    console.log(chalk.dim("  Use 'cig-loop sessions' to attach"));
    console.log(chalk.dim("  Use 'cig-loop stop' to stop"));
    console.log("");
    await runLoop(config, daemon);
  } else {
    // Foreground mode: spawn a detached daemon child, then attach the TUI.
    // The child process runs the loop headless; the parent process is just
    // the TUI. When the user presses [B]ackground, the parent exits and the
    // child continues running.
    const child = spawnDaemonChild(config);

    // Wait for the daemon to register (state.json + socket)
    let daemonId: string | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      await Bun.sleep(250);
      const { listRuns } = await import("./daemon.js");
      const runs = await listRuns();
      // Find the run owned by our child PID
      const match = runs.find((r) => r.pid === child.pid);
      if (match) {
        daemonId = match.id;
        break;
      }
    }

    if (!daemonId) {
      console.error(chalk.red("Failed to start daemon — child process did not register within 10s."));
      process.exit(1);
    }

    console.log(chalk.cyan(`  Session:    ${daemonId}`));
    console.log(chalk.cyan(`  Log:        ${config.logFile}`));
    console.log("");

    // Detach parent from child — child survives parent exit
    child.unref();

    // Auto-attach the TUI
    const { cmdAttach } = await import("./daemon-cli.js");
    await cmdAttach(daemonId);
  }
}

/**
 * Spawn a detached child process running the loop in daemon mode.
 * Returns the child process handle.
 */
function spawnDaemonChild(config: LoopConfig) {
  const args: string[] = [];

  args.push("-p", config.promptPath);
  args.push("-i", String(config.iterations));
  args.push("--daemon");
  args.push("--no-interactive");

  if (config.model) args.push("-m", config.model);
  if (config.stopString) args.push("--stop-string", config.stopString);
  if (config.continueString) args.push("--continue-string", config.continueString);
  if (config.logFile) args.push("--log-file", config.logFile);
  if (config.maxLogLines > 0) args.push("--max-log-lines", String(config.maxLogLines));
  if (config.verbose) args.push("-v");
  if (config.delaySeconds > 0) args.push("-d", String(config.delaySeconds));
  if (config.timeoutSeconds > 0) args.push("-t", String(config.timeoutSeconds));

  if (config.injectedMcps.length > 0) {
    const allNames = config.injectedMcps.map((m) => m.name);
    args.push("--enable-mcps", allNames.join(","));
  }

  if (config.throttle.dynamic) {
    args.push("--throttle-dynamic");
  } else {
    if (config.throttle.fiveHour > 0) args.push("--throttle-5h", String(config.throttle.fiveHour));
    if (config.throttle.sevenDay > 0) args.push("--throttle-7d", String(config.throttle.sevenDay));
    if (config.throttle.sonnet > 0) args.push("--throttle-sonnet", String(config.throttle.sonnet));
  }

  if (config.enableIde) args.push("--ide");
  if (config.enableChrome) args.push("--chrome");

  // Use process.execPath so this works both in dev (bun src/index.ts)
  // and as a compiled binary (cig-loop). For compiled binaries, argv[0]
  // is the binary itself; for dev, we need bun + the entrypoint.
  const isBundled = !process.argv[1]?.endsWith(".ts");
  const cmd = isBundled
    ? [process.execPath, ...args]
    : [process.execPath, process.argv[1]!, ...args];

  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });

  return proc;
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err}`));
  process.exit(1);
});
