/**
 * Boilerplate command — fetch and copy boilerplate templates from the GitHub repo.
 */

import * as p from "@clack/prompts";
import chalk from "chalk";

const GITHUB_API = "https://api.github.com/repos/Metroxe/cig-loop/contents";

interface GitHubEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url: string | null;
}

/** Convert a folder name like "web-research" to "Web Research". */
function toDisplayName(dirName: string): string {
  return dirName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Fetch the list of boilerplate directories from GitHub. */
async function fetchBoilerplateList(): Promise<string[]> {
  const res = await fetch(`${GITHUB_API}/boilerplates`);
  if (!res.ok) {
    throw new Error(`Failed to fetch boilerplates: ${res.status} ${res.statusText}`);
  }
  const entries: GitHubEntry[] = await res.json();
  return entries.filter((e) => e.type === "dir").map((e) => e.name);
}

/** Recursively fetch all files in a boilerplate directory. Returns relative paths + download URLs. */
async function fetchBoilerplateFiles(
  dirName: string,
): Promise<Array<{ relativePath: string; downloadUrl: string }>> {
  const files: Array<{ relativePath: string; downloadUrl: string }> = [];

  async function walk(apiPath: string, prefix: string): Promise<void> {
    const res = await fetch(`${GITHUB_API}/${apiPath}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${apiPath}: ${res.status} ${res.statusText}`);
    }
    const entries: GitHubEntry[] = await res.json();

    for (const entry of entries) {
      if (entry.type === "file" && entry.download_url) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        files.push({ relativePath, downloadUrl: entry.download_url });
      } else if (entry.type === "dir") {
        const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        await walk(entry.path, nextPrefix);
      }
    }
  }

  await walk(`boilerplates/${dirName}`, "");
  return files;
}

/** Download a file's raw content. */
async function downloadFile(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status}`);
  }
  return res.text();
}

/** Check which files already exist in CWD. */
async function checkConflicts(filePaths: string[]): Promise<string[]> {
  const conflicts: string[] = [];
  for (const filePath of filePaths) {
    const file = Bun.file(filePath);
    if (await file.exists()) {
      conflicts.push(filePath);
    }
  }
  return conflicts;
}

/** Parse boilerplate subcommand args: `boilerplate [--name <name>] [--force]` */
function parseBoilerplateArgs(): { name?: string; force: boolean } {
  const args = process.argv.slice(3);
  let name: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--name" || args[i] === "-n") && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === "--force" || args[i] === "-f") {
      force = true;
    } else if (args[i] === "--list" || args[i] === "-l") {
      // handled separately
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        `Usage: cig-loop boilerplate [options]\n\n` +
        `Options:\n` +
        `  -n, --name <name>  boilerplate to use (skip interactive selection)\n` +
        `  -l, --list         list available boilerplates and exit\n` +
        `  -f, --force        overwrite existing files without prompting\n` +
        `  -h, --help         show this help\n`,
      );
      process.exit(0);
    }
  }

  return { name, force };
}

function shouldList(): boolean {
  return process.argv.slice(3).some((a) => a === "--list" || a === "-l");
}

export async function runBoilerplate(): Promise<void> {
  const { name: requestedName, force } = parseBoilerplateArgs();
  const listOnly = shouldList();
  const interactive = !requestedName && !listOnly;

  if (interactive) {
    p.intro(chalk.bgCyan.black(" cig-loop boilerplate "));
  }

  // Fetch available boilerplates
  const spinner = interactive ? p.spinner() : null;
  spinner?.start("Fetching boilerplates...");
  if (!interactive) console.log("Fetching boilerplates...");

  let boilerplates: string[];
  try {
    boilerplates = await fetchBoilerplateList();
  } catch (err) {
    spinner?.stop("Failed to fetch boilerplates");
    console.error(
      chalk.red(`Could not fetch boilerplates from GitHub.\n`) +
      `  ${chalk.dim(String(err))}\n\n` +
      `  Check your internet connection and try again.`,
    );
    process.exit(1);
  }

  if (boilerplates.length === 0) {
    spinner?.stop("No boilerplates found");
    console.log("No boilerplates are available in the repository yet.");
    process.exit(0);
  }

  spinner?.stop(`Found ${boilerplates.length} boilerplate${boilerplates.length > 1 ? "s" : ""}`);

  // --list: just print names and exit
  if (shouldList()) {
    for (const name of boilerplates) {
      console.log(`  ${name}  ${chalk.dim(toDisplayName(name))}`);
    }
    process.exit(0);
  }

  // Determine which boilerplate to use
  let dirName: string;

  if (requestedName) {
    if (!boilerplates.includes(requestedName)) {
      console.error(
        chalk.red(`Boilerplate "${requestedName}" not found.\n`) +
        `Available: ${boilerplates.join(", ")}`,
      );
      process.exit(1);
    }
    dirName = requestedName;
    console.log(`Using boilerplate: ${chalk.bold(toDisplayName(dirName))}`);
  } else {
    const selected = await p.select({
      message: "Select a boilerplate",
      options: boilerplates.map((name) => ({
        value: name,
        label: toDisplayName(name),
      })),
    });

    if (p.isCancel(selected)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    dirName = selected as string;
  }

  // Fetch file list
  spinner?.start("Fetching files...");
  if (!interactive) console.log("Fetching files...");

  let files: Array<{ relativePath: string; downloadUrl: string }>;
  try {
    files = await fetchBoilerplateFiles(dirName);
  } catch (err) {
    spinner?.stop("Failed to fetch files");
    console.error(chalk.red(`Could not fetch boilerplate files: ${err}`));
    process.exit(1);
  }

  if (files.length === 0) {
    spinner?.stop("No files found");
    console.log("This boilerplate has no files.");
    process.exit(0);
  }

  spinner?.stop(`${files.length} file${files.length > 1 ? "s" : ""} to copy`);
  if (!interactive) console.log(`${files.length} file${files.length > 1 ? "s" : ""} to copy`);

  // Check for conflicts
  const conflicts = await checkConflicts(files.map((f) => f.relativePath));

  if (conflicts.length > 0) {
    const warning =
      `The following files already exist and will be overwritten:\n` +
      conflicts.map((f) => `  ${chalk.yellow(f)}`).join("\n");

    if (interactive && !force) {
      p.log.warn(warning);

      const proceed = await p.confirm({
        message: "Overwrite existing files?",
        initialValue: false,
      });

      if (p.isCancel(proceed) || !proceed) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
    } else if (!force) {
      console.error(chalk.yellow(warning));
      console.error(chalk.red("Use --force to overwrite."));
      process.exit(1);
    } else {
      console.log(chalk.yellow(warning));
      console.log("Overwriting (--force).");
    }
  }

  // Download and write files
  spinner?.start("Copying files...");
  if (!interactive) console.log("Copying files...");

  try {
    for (const file of files) {
      const content = await downloadFile(file.downloadUrl);

      // Ensure parent directories exist
      const lastSlash = file.relativePath.lastIndexOf("/");
      if (lastSlash !== -1) {
        const dir = file.relativePath.substring(0, lastSlash);
        await Bun.spawn(["mkdir", "-p", dir]).exited;
      }

      await Bun.write(file.relativePath, content);
    }
  } catch (err) {
    spinner?.stop("Failed to copy files");
    console.error(chalk.red(`Error writing files: ${err}`));
    process.exit(1);
  }

  spinner?.stop("Files copied");

  // Show what was copied
  for (const file of files) {
    if (interactive) {
      p.log.success(file.relativePath);
    } else {
      console.log(chalk.green(`  ✓ ${file.relativePath}`));
    }
  }

  if (interactive) {
    p.outro(chalk.green(`Done! Run ${chalk.bold("cig-loop")} to start.`));
  } else {
    console.log(chalk.green(`\nDone! Run ${chalk.bold("cig-loop")} to start.`));
  }
}
