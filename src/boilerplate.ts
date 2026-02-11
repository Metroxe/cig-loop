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

export async function runBoilerplate(): Promise<void> {
  p.intro(chalk.bgCyan.black(" cig-loop boilerplate "));

  // Fetch available boilerplates
  const spinner = p.spinner();
  spinner.start("Fetching boilerplates...");

  let boilerplates: string[];
  try {
    boilerplates = await fetchBoilerplateList();
  } catch (err) {
    spinner.stop("Failed to fetch boilerplates");
    p.log.error(
      `Could not fetch boilerplates from GitHub.\n` +
      `  ${chalk.dim(String(err))}\n\n` +
      `  Check your internet connection and try again.`,
    );
    p.outro("");
    process.exit(1);
  }

  if (boilerplates.length === 0) {
    spinner.stop("No boilerplates found");
    p.log.warn("No boilerplates are available in the repository yet.");
    p.outro("");
    return;
  }

  spinner.stop(`Found ${boilerplates.length} boilerplate${boilerplates.length > 1 ? "s" : ""}`);

  // Select a boilerplate
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

  const dirName = selected as string;

  // Fetch file list
  spinner.start("Fetching files...");

  let files: Array<{ relativePath: string; downloadUrl: string }>;
  try {
    files = await fetchBoilerplateFiles(dirName);
  } catch (err) {
    spinner.stop("Failed to fetch files");
    p.log.error(`Could not fetch boilerplate files: ${err}`);
    p.outro("");
    process.exit(1);
  }

  if (files.length === 0) {
    spinner.stop("No files found");
    p.log.warn("This boilerplate has no files.");
    p.outro("");
    return;
  }

  spinner.stop(`${files.length} file${files.length > 1 ? "s" : ""} to copy`);

  // Check for conflicts
  const conflicts = await checkConflicts(files.map((f) => f.relativePath));

  if (conflicts.length > 0) {
    p.log.warn(
      `The following files already exist and will be overwritten:\n` +
      conflicts.map((f) => `  ${chalk.yellow(f)}`).join("\n"),
    );

    const proceed = await p.confirm({
      message: "Overwrite existing files?",
      initialValue: false,
    });

    if (p.isCancel(proceed) || !proceed) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
  }

  // Download and write files
  spinner.start("Copying files...");

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
    spinner.stop("Failed to copy files");
    p.log.error(`Error writing files: ${err}`);
    p.outro("");
    process.exit(1);
  }

  spinner.stop("Files copied");

  // Show what was copied
  for (const file of files) {
    p.log.success(file.relativePath);
  }

  p.outro(chalk.green(`Done! Run ${chalk.bold("cig-loop")} to start.`));
}
