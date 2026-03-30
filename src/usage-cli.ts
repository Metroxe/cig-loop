/**
 * Manual usage override command.
 *
 * Allows setting usage percentages directly when the API is unavailable.
 * Writes to the shared disk cache so all cig-loop processes pick it up.
 *
 * Usage:
 *   cig-loop usage                          # interactive mode
 *   cig-loop usage --5h 42 --7d 44          # CLI mode
 *   cig-loop usage --5h 42 --sonnet 26      # partial update (keeps other values)
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import { loadDiskCache, saveDiskCache, formatResetTime } from "./usage.js";
import type { UsageData, UsageBucket } from "./types.js";

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (arg.startsWith("--") && next && !next.startsWith("--")) {
      result[arg.slice(2)] = next;
      i++;
    }
  }
  return result;
}

function makeBucket(pct: number, hoursUntilReset: number): UsageBucket {
  const resetsAt = new Date(Date.now() + hoursUntilReset * 3600_000).toISOString();
  return { utilization: pct, resetsAt };
}

function showCurrent(usage: UsageData | null): void {
  if (!usage) {
    console.log(chalk.dim("  No cached usage data."));
    return;
  }
  const age = Date.now() - usage.fetchedAt;
  const ageLabel = age < 60_000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60_000)}m ago`;
  console.log(chalk.dim(`  Current values (fetched ${ageLabel}):`));
  if (usage.fiveHour) console.log(`    5h:     ${usage.fiveHour.utilization}%  (resets in ${formatResetTime(usage.fiveHour.resetsAt)})`);
  if (usage.sevenDay) console.log(`    7d:     ${usage.sevenDay.utilization}%  (resets in ${formatResetTime(usage.sevenDay.resetsAt)})`);
  if (usage.sevenDaySonnet) console.log(`    sonnet: ${usage.sevenDaySonnet.utilization}%  (resets in ${formatResetTime(usage.sevenDaySonnet.resetsAt)})`);
  if (usage.sevenDayOpus) console.log(`    opus:   ${usage.sevenDayOpus.utilization}%  (resets in ${formatResetTime(usage.sevenDayOpus.resetsAt)})`);
  console.log("");
}

async function runInteractive(existing: UsageData | null): Promise<UsageData> {
  console.log("");
  console.log(chalk.bold("Set usage percentages manually"));
  console.log(chalk.dim("  Leave blank to keep current value. Enter 0-100 for percentage."));
  console.log("");

  showCurrent(existing);

  const fiveHourPct = await p.text({
    message: "5h utilization %",
    placeholder: existing?.fiveHour ? String(existing.fiveHour.utilization) : "0",
    validate: (v) => {
      if (v === "") return;
      const n = Number(v);
      if (isNaN(n) || n < 0 || n > 100) return "Must be 0-100";
    },
  });
  if (p.isCancel(fiveHourPct)) process.exit(0);

  const fiveHourReset = await p.text({
    message: "5h resets in how many hours?",
    placeholder: existing?.fiveHour ? String(Math.max(0, Math.round((new Date(existing.fiveHour.resetsAt).getTime() - Date.now()) / 3600_000 * 10) / 10)) : "5",
    validate: (v) => {
      if (v === "") return;
      const n = Number(v);
      if (isNaN(n) || n < 0) return "Must be >= 0";
    },
  });
  if (p.isCancel(fiveHourReset)) process.exit(0);

  const sevenDayPct = await p.text({
    message: "7d utilization %",
    placeholder: existing?.sevenDay ? String(existing.sevenDay.utilization) : "0",
    validate: (v) => {
      if (v === "") return;
      const n = Number(v);
      if (isNaN(n) || n < 0 || n > 100) return "Must be 0-100";
    },
  });
  if (p.isCancel(sevenDayPct)) process.exit(0);

  const sevenDayReset = await p.text({
    message: "7d resets in how many hours?",
    placeholder: existing?.sevenDay ? String(Math.max(0, Math.round((new Date(existing.sevenDay.resetsAt).getTime() - Date.now()) / 3600_000 * 10) / 10)) : "168",
    validate: (v) => {
      if (v === "") return;
      const n = Number(v);
      if (isNaN(n) || n < 0) return "Must be >= 0";
    },
  });
  if (p.isCancel(sevenDayReset)) process.exit(0);

  const sonnetPct = await p.text({
    message: "Sonnet 7d utilization %",
    placeholder: existing?.sevenDaySonnet ? String(existing.sevenDaySonnet.utilization) : "0",
    validate: (v) => {
      if (v === "") return;
      const n = Number(v);
      if (isNaN(n) || n < 0 || n > 100) return "Must be 0-100";
    },
  });
  if (p.isCancel(sonnetPct)) process.exit(0);

  const sonnetReset = await p.text({
    message: "Sonnet 7d resets in how many hours?",
    placeholder: existing?.sevenDaySonnet ? String(Math.max(0, Math.round((new Date(existing.sevenDaySonnet.resetsAt).getTime() - Date.now()) / 3600_000 * 10) / 10)) : "168",
    validate: (v) => {
      if (v === "") return;
      const n = Number(v);
      if (isNaN(n) || n < 0) return "Must be >= 0";
    },
  });
  if (p.isCancel(sonnetReset)) process.exit(0);

  return {
    fiveHour: makeBucket(
      fiveHourPct ? Number(fiveHourPct) : (existing?.fiveHour?.utilization ?? 0),
      fiveHourReset ? Number(fiveHourReset) : 5,
    ),
    sevenDay: makeBucket(
      sevenDayPct ? Number(sevenDayPct) : (existing?.sevenDay?.utilization ?? 0),
      sevenDayReset ? Number(sevenDayReset) : 168,
    ),
    sevenDaySonnet: makeBucket(
      sonnetPct ? Number(sonnetPct) : (existing?.sevenDaySonnet?.utilization ?? 0),
      sonnetReset ? Number(sonnetReset) : 168,
    ),
    sevenDayOpus: existing?.sevenDayOpus ?? null,
    fetchedAt: Date.now(),
  };
}

function runCli(args: Record<string, string>, existing: UsageData | null): UsageData {
  return {
    fiveHour: args["5h"] !== undefined
      ? makeBucket(Number(args["5h"]), Number(args["5h-reset"] || "5"))
      : existing?.fiveHour ?? makeBucket(0, 5),
    sevenDay: args["7d"] !== undefined
      ? makeBucket(Number(args["7d"]), Number(args["7d-reset"] || "168"))
      : existing?.sevenDay ?? makeBucket(0, 168),
    sevenDaySonnet: args["sonnet"] !== undefined
      ? makeBucket(Number(args["sonnet"]), Number(args["sonnet-reset"] || "168"))
      : existing?.sevenDaySonnet ?? null,
    sevenDayOpus: args["opus"] !== undefined
      ? makeBucket(Number(args["opus"]), Number(args["opus-reset"] || "168"))
      : existing?.sevenDayOpus ?? null,
    fetchedAt: Date.now(),
  };
}

export async function runUsageCommand(args: string[]): Promise<void> {
  const existing = await loadDiskCache();
  const parsed = parseArgs(args);
  const hasCliArgs = Object.keys(parsed).some((k) => ["5h", "7d", "sonnet", "opus"].includes(k));

  let usage: UsageData;
  if (hasCliArgs) {
    usage = runCli(parsed, existing);
  } else {
    usage = await runInteractive(existing);
  }

  await saveDiskCache(usage);

  console.log("");
  console.log(chalk.green("Usage updated:"));
  showCurrent(usage);
  console.log(chalk.dim("  All running cig-loop instances will pick this up within ~15s."));
}
