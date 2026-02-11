/**
 * Rich output formatting for Claude CLI streaming events.
 *
 * Styled to match Claude Code's TUI:
 * - Tool use: dimmed with arrow prefix
 * - Tool results: indented, with smart formatting per tool type
 * - Diffs: colored +/- lines
 * - System reminders: stripped from output
 */

import chalk from "chalk";

// ─── System Reminder Stripping ─────────────────────────────────────────

/**
 * Remove <system-reminder>...</system-reminder> blocks that Claude injects
 * into tool results (e.g. malware warnings on file reads).
 */
export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

// ─── Tool Use Formatting ───────────────────────────────────────────────

/**
 * Format a tool_use block into a human-readable one-liner.
 */
export function formatToolUse(toolName: string, toolInput: string): string {
  try {
    const input = typeof toolInput === "string" ? JSON.parse(toolInput) : toolInput;

    switch (toolName) {
      case "Read":
        return `Read ${chalk.underline(input.file_path || input.path || "file")}`;
      case "Write":
        return `Write ${chalk.underline(input.file_path || input.path || "file")}`;
      case "Edit":
      case "StrReplace":
        return `Edit ${chalk.underline(input.file_path || input.path || "file")}`;
      case "MultiEdit":
        return `MultiEdit ${chalk.underline(input.file_path || input.path || "file")}`;
      case "Grep":
      case "Search":
      case "RipGrep": {
        const pattern = String(input.pattern || input.query || "");
        const searchPath = String(input.path || input.directory || ".");
        return `Grep ${chalk.yellow(`"${truncate(pattern, 40)}")`)} in ${searchPath}`;
      }
      case "Glob":
        return `Glob ${input.pattern || input.glob_pattern || "*"}`;
      case "LS":
      case "ListDir":
        return `LS ${input.path || input.directory || input.target_directory || "."}`;
      case "Bash":
      case "Shell": {
        const cmd = String(input.command || "");
        return `Bash ${chalk.dim(truncate(cmd, 60))}`;
      }
      case "WebSearch":
        return `WebSearch ${chalk.yellow(input.query || input.search_term || "")}`;
      case "SemanticSearch": {
        const q = String(input.query || "");
        return `SemanticSearch ${chalk.yellow(truncate(q, 50))}`;
      }
      case "TodoRead":
        return "TodoRead";
      case "TodoWrite":
        return "TodoWrite";
      case "Task": {
        const desc = String(input.description || "");
        return `Task ${truncate(desc, 50)}`;
      }
      case "ReadLints":
        return `ReadLints ${input.paths?.join(", ") || "workspace"}`;
      default: {
        const firstKey = Object.keys(input)[0];
        if (firstKey && typeof input[firstKey] === "string") {
          return `${toolName} ${truncate(String(input[firstKey]), 50)}`;
        }
        return toolName;
      }
    }
  } catch {
    return toolName;
  }
}

// ─── Tool Result Formatting ────────────────────────────────────────────

/**
 * Format a tool result for display. Returns indented, cleaned output.
 */
export function formatToolResult(
  content: string | unknown,
  maxLines = 12,
): string {
  if (!content) return "";

  let text = parseAndFormat(content);
  text = stripSystemReminders(text);
  if (!text.trim()) return "";

  return indentBlock(text, maxLines);
}

function parseAndFormat(content: string | unknown): string {
  let data: unknown = content;

  if (typeof content === "string") {
    try {
      data = JSON.parse(content);
    } catch {
      return stripSystemReminders(content);
    }
  }

  if (isObj(data) && "success" in data && isObj(data.success)) {
    data = data.success;
  }

  if (!isObj(data)) {
    return typeof content === "string" ? stripSystemReminders(content) : String(content);
  }

  // Detect and route
  if ("diff" in data || ("linesAdded" in data && "linesRemoved" in data)) {
    return formatDiff(data);
  }
  if ("stdout" in data || "stderr" in data) {
    return formatShellResult(data);
  }
  if ("content" in data && typeof data.content === "string") {
    return formatReadResult(data);
  }
  if ("directoryTreeRoot" in data) {
    return formatLsResult(data);
  }
  if ("files" in data && Array.isArray(data.files)) {
    return formatGlobResult(data);
  }
  if ("bytesWritten" in data || "linesWritten" in data) {
    return formatWriteResult(data);
  }
  if ("pattern" in data && ("matches" in data || "outputMode" in data)) {
    return formatGrepResult(data);
  }

  return typeof content === "string" ? stripSystemReminders(content) : JSON.stringify(content, null, 2);
}

// ─── Specific Formatters ───────────────────────────────────────────────

function formatDiff(data: Record<string, unknown>): string {
  const lines: string[] = [];

  const diff = data.diff;
  if (typeof diff === "string") {
    for (const line of diff.split("\n")) {
      if (line.startsWith("-") && !line.startsWith("---")) {
        lines.push(chalk.red(line));
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        lines.push(chalk.green(line));
      } else if (line.startsWith("@@")) {
        lines.push(chalk.cyan(line));
      } else {
        lines.push(chalk.dim(line));
      }
    }
  } else {
    const added = data.linesAdded;
    const removed = data.linesRemoved;
    const parts: string[] = [];
    if (typeof added === "number") parts.push(chalk.green(`+${added}`));
    if (typeof removed === "number") parts.push(chalk.red(`-${removed}`));
    if (parts.length > 0) lines.push(parts.join(" "));
  }

  return lines.join("\n") || chalk.dim("(edit applied)");
}

function formatShellResult(data: Record<string, unknown>): string {
  const lines: string[] = [];

  const stdout = data.stdout;
  if (typeof stdout === "string" && stdout.trim()) {
    lines.push(stdout.trim());
  }

  const stderr = data.stderr;
  if (typeof stderr === "string" && stderr.trim()) {
    if (lines.length > 0) lines.push("");
    lines.push(chalk.yellow(stderr.trim()));
  }

  const exitCode = data.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) {
    lines.push(chalk.red(`exit code ${exitCode}`));
  }

  return lines.join("\n") || chalk.dim("(no output)");
}

function formatReadResult(data: Record<string, unknown>): string {
  const content = data.content;
  if (typeof content !== "string") return JSON.stringify(data, null, 2);

  // Strip system reminders from file content
  const cleaned = stripSystemReminders(content);
  if (!cleaned) return chalk.dim("(empty file)");

  // Show the actual content with line numbers
  const contentLines = cleaned.split("\n");
  const numWidth = String(contentLines.length).length;
  return contentLines
    .map((line, i) => chalk.dim(`${String(i + 1).padStart(numWidth)} `) + line)
    .join("\n");
}

function formatLsResult(data: Record<string, unknown>): string {
  const tree = data.directoryTreeRoot;
  if (!isObj(tree)) return JSON.stringify(data, null, 2);

  const lines: string[] = [];
  walkTree(tree, lines, 0);
  return lines.join("\n") || chalk.dim("(empty directory)");
}

function walkTree(node: Record<string, unknown>, lines: string[], depth: number): void {
  const indent = "  ".repeat(depth);
  const childDirs = node.childrenDirs;
  if (Array.isArray(childDirs)) {
    for (const dir of childDirs) {
      if (isObj(dir) && typeof dir.absPath === "string") {
        const name = dir.absPath.split("/").pop() || dir.absPath;
        lines.push(chalk.blue(`${indent}${name}/`));
        walkTree(dir, lines, depth + 1);
      }
    }
  }
  const childFiles = node.childrenFiles;
  if (Array.isArray(childFiles)) {
    for (const file of childFiles) {
      if (typeof file === "string") lines.push(`${indent}${file}`);
    }
  }
}

function formatGlobResult(data: Record<string, unknown>): string {
  const files = data.files;
  if (!Array.isArray(files)) return JSON.stringify(data, null, 2);
  return files.join("\n") || chalk.dim("No files matched");
}

function formatWriteResult(data: Record<string, unknown>): string {
  const filePath = data.path || data.file_path;
  const lineCount = data.linesWritten;
  const byteCount = data.bytesWritten;

  const parts: string[] = [];
  if (typeof filePath === "string") parts.push(chalk.underline(String(filePath)));
  if (typeof lineCount === "number") parts.push(chalk.dim(`(${lineCount} lines)`));
  else if (typeof byteCount === "number") parts.push(chalk.dim(`(${byteCount} bytes)`));

  return parts.join(" ") || chalk.dim("(write completed)");
}

function formatGrepResult(data: Record<string, unknown>): string {
  const matches = data.matches;
  if (!Array.isArray(matches)) {
    if ("content" in data && typeof data.content === "string") {
      return stripSystemReminders(data.content);
    }
    return JSON.stringify(data, null, 2);
  }

  const lines: string[] = [];
  for (const match of matches) {
    if (isObj(match)) {
      const file = match.file || match.path || "";
      const line = match.line || match.lineNumber || "";
      const text = match.content || match.text || "";
      lines.push(`${chalk.cyan(String(file))}${chalk.dim(`:${line}:`)} ${text}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : chalk.dim("No matches found");
}

// ─── Cost / Token Formatting ───────────────────────────────────────────

export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export function formatNumber(num: number): string {
  return num.toLocaleString("en-US");
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes}m ${seconds}s`;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max) + "..." : str;
}

/**
 * Indent a block of text with consistent left padding.
 * Truncates to maxLines if needed.
 */
function indentBlock(content: string, maxLines: number): string {
  if (!content) return "";

  const lines = content.split("\n");
  const pad = "    ";

  if (lines.length <= maxLines) {
    return lines.map((l) => chalk.dim(pad) + l).join("\n");
  }

  const shown = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  return (
    shown.map((l) => chalk.dim(pad) + l).join("\n") +
    "\n" + chalk.dim(`${pad}... (${remaining} more lines)`)
  );
}
