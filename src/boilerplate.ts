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

/** Compute SHA-256 hex digest of a string. */
function sha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/** Parse boilerplate subcommand args: `boilerplate [--name <name>]` */
function parseBoilerplateArgs(): { name?: string } {
  const args = process.argv.slice(3);
  let name: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--name" || args[i] === "-n") && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === "--list" || args[i] === "-l") {
      // handled separately
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        `Usage: cig-loop boilerplate [options]\n\n` +
        `Options:\n` +
        `  -n, --name <name>  boilerplate to use (skip interactive selection)\n` +
        `  -l, --list         list available boilerplates and exit\n` +
        `  -h, --help         show this help\n`,
      );
      process.exit(0);
    }
  }

  return { name };
}

function shouldList(): boolean {
  return process.argv.slice(3).some((a) => a === "--list" || a === "-l");
}

export async function runBoilerplate(): Promise<void> {
  const { name: requestedName } = parseBoilerplateArgs();
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

  const outputDir = dirName;
  await Bun.spawn(["mkdir", "-p", outputDir]).exited;

  // Download all files and categorize by conflict status
  spinner?.start("Downloading files...");
  if (!interactive) console.log("Downloading files...");

  type FileEntry = { relativePath: string; content: string };
  const newFiles: FileEntry[] = [];
  const identicalFiles: FileEntry[] = [];
  const changedFiles: FileEntry[] = [];

  try {
    for (const file of files) {
      const content = await downloadFile(file.downloadUrl);
      const destPath = `${outputDir}/${file.relativePath}`;
      const destFile = Bun.file(destPath);

      if (await destFile.exists()) {
        const existingContent = await destFile.text();
        if (sha256(content) === sha256(existingContent)) {
          identicalFiles.push({ relativePath: file.relativePath, content });
        } else {
          changedFiles.push({ relativePath: file.relativePath, content });
        }
      } else {
        newFiles.push({ relativePath: file.relativePath, content });
      }
    }
  } catch (err) {
    spinner?.stop("Failed to download files");
    console.error(chalk.red(`Error downloading files: ${err}`));
    process.exit(1);
  }

  spinner?.stop("Files downloaded");

  // If there are changed files, ask which ones to overwrite
  let filesToOverwrite: FileEntry[] = [];

  if (changedFiles.length > 0) {
    if (interactive) {
      const selected = await p.multiselect({
        message: "These files have changed. Select which to overwrite:",
        options: changedFiles.map((f) => ({
          value: f.relativePath,
          label: f.relativePath,
        })),
        initialValues: changedFiles
          .filter((f) => f.relativePath.endsWith("PROMPT.md"))
          .map((f) => f.relativePath),
        required: false,
      });

      if (p.isCancel(selected)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }

      const selectedPaths = new Set(selected as string[]);
      filesToOverwrite = changedFiles.filter((f) => selectedPaths.has(f.relativePath));
    } else {
      // Non-interactive: skip changed files (safe default)
      console.log(chalk.yellow("Skipping changed files (non-interactive mode):"));
      for (const f of changedFiles) {
        console.log(chalk.yellow(`  ⊘ ${outputDir}/${f.relativePath}`));
      }
    }
  }

  // Write new files and selected overwrite files
  spinner?.start("Writing files...");
  if (!interactive) console.log("Writing files...");

  const filesToWrite = [...newFiles, ...filesToOverwrite];

  try {
    for (const file of filesToWrite) {
      const destPath = `${outputDir}/${file.relativePath}`;

      const lastSlash = destPath.lastIndexOf("/");
      if (lastSlash !== -1) {
        const dir = destPath.substring(0, lastSlash);
        await Bun.spawn(["mkdir", "-p", dir]).exited;
      }

      await Bun.write(destPath, file.content);
    }
  } catch (err) {
    spinner?.stop("Failed to write files");
    console.error(chalk.red(`Error writing files: ${err}`));
    process.exit(1);
  }

  spinner?.stop("Done");

  // Show summary
  const skippedPaths = new Set(
    changedFiles
      .filter((f) => !filesToOverwrite.includes(f))
      .map((f) => f.relativePath),
  );

  for (const file of files) {
    const destPath = `${outputDir}/${file.relativePath}`;
    const isIdentical = identicalFiles.some((f) => f.relativePath === file.relativePath);
    const isSkipped = skippedPaths.has(file.relativePath);

    if (isIdentical) {
      if (interactive) {
        p.log.info(chalk.dim(`= ${destPath}`));
      } else {
        console.log(chalk.dim(`  = ${destPath}`));
      }
    } else if (isSkipped) {
      if (interactive) {
        p.log.warn(`⊘ ${destPath}`);
      } else {
        console.log(chalk.yellow(`  ⊘ ${destPath}`));
      }
    } else {
      if (interactive) {
        p.log.success(destPath);
      } else {
        console.log(chalk.green(`  ✓ ${destPath}`));
      }
    }
  }

  if (interactive) {
    p.outro(chalk.green(`Done! Files are in ${chalk.bold(outputDir)}/\nRun ${chalk.bold(`cd ${outputDir} && cig-loop`)} to start.`));
  } else {
    console.log(chalk.green(`\nDone! Files are in ${chalk.bold(outputDir)}/\nRun ${chalk.bold(`cd ${outputDir} && cig-loop`)} to start.`));
  }
}
