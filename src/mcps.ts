/**
 * Built-in MCP server registry.
 *
 * These are well-known MCP servers that can be injected at runtime
 * without any configuration files. They are passed to Claude via
 * --mcp-config and run via npx (auto-downloaded if not cached).
 */

import type { InjectableMcp } from "./types.js";

export const BUILTIN_MCPS: InjectableMcp[] = [
  {
    name: "playwright",
    command: "npx",
    args: ["@playwright/mcp@latest"],
    description: "Browser automation and testing",
    prereqs: "Run: npx playwright install",
  },
  {
    name: "browsermcp",
    command: "npx",
    args: ["@browsermcp/mcp@latest"],
    description: "Browser control and web automation. Install the extension and start it before running. https://docs.browsermcp.io/setup-extension",
  },
];

/**
 * Check if a built-in MCP requires environment variables that aren't set.
 * Returns the list of missing env var names, or empty if ready to use.
 */
export function getMissingEnvVars(mcp: InjectableMcp): string[] {
  if (!mcp.env) return [];
  const missing: string[] = [];
  for (const [key, defaultVal] of Object.entries(mcp.env)) {
    if (!defaultVal && !process.env[key]) {
      missing.push(key);
    }
  }
  return missing;
}
