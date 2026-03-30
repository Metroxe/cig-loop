/**
 * Manual usage override command.
 *
 * Allows setting usage percentages directly when the API is unavailable.
 * Writes to the shared disk cache so all cig-loop processes pick it up.
 *
 * Usage:
 *   cig-loop usage                                    # interactive mode
 *   cig-loop usage --5h 42 --7d 44                    # CLI mode (default reset times)
 *   cig-loop usage --5h 42 --5h-reset 1774819200000   # CLI with ms timestamp reset
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import { loadDiskCache, saveDiskCache, formatResetTime } from "./usage.js";
import type { UsageData, UsageBucket } from "./types.js";

// ─── Common timezones ────────────────────────────────────────────────────

const TIMEZONES = [
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Vancouver", label: "Vancouver (PT)" },
  { value: "America/Toronto", label: "Toronto (ET)" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Paris", label: "Paris (CET/CEST)" },
  { value: "Europe/Berlin", label: "Berlin (CET/CEST)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Asia/Shanghai", label: "Shanghai (CST)" },
  { value: "Australia/Sydney", label: "Sydney (AEST)" },
  { value: "UTC", label: "UTC" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────

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

function makeBucketFromMs(pct: number, resetMs: number): UsageBucket {
  return { utilization: pct, resetsAt: new Date(resetMs).toISOString() };
}

function defaultResetMs(hours: number): number {
  return Date.now() + hours * 3600_000;
}

function formatAbsoluteTime(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function showCurrent(usage: UsageData | null, tz = "America/Vancouver"): void {
  if (!usage) {
    console.log(chalk.dim("  No cached usage data."));
    return;
  }
  const age = Date.now() - usage.fetchedAt;
  const ageLabel = age < 60_000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60_000)}m ago`;
  console.log(chalk.dim(`  Current values (fetched ${ageLabel}):`));
  if (usage.fiveHour) console.log(`    5h:     ${usage.fiveHour.utilization}%  resets ${formatAbsoluteTime(usage.fiveHour.resetsAt, tz)} (${formatResetTime(usage.fiveHour.resetsAt)})`);
  if (usage.sevenDay) console.log(`    7d:     ${usage.sevenDay.utilization}%  resets ${formatAbsoluteTime(usage.sevenDay.resetsAt, tz)} (${formatResetTime(usage.sevenDay.resetsAt)})`);
  if (usage.sevenDaySonnet) console.log(`    sonnet: ${usage.sevenDaySonnet.utilization}%  resets ${formatAbsoluteTime(usage.sevenDaySonnet.resetsAt, tz)} (${formatResetTime(usage.sevenDaySonnet.resetsAt)})`);
  if (usage.sevenDayOpus) console.log(`    opus:   ${usage.sevenDayOpus.utilization}%  resets ${formatAbsoluteTime(usage.sevenDayOpus.resetsAt, tz)} (${formatResetTime(usage.sevenDayOpus.resetsAt)})`);
  console.log("");
}


/**
 * Convert a "local time in timezone" Date to UTC.
 * The input Date's components are treated as being in `tz`.
 */
function zonedToUtc(localDate: Date, tz: string): Date {
  // Format the local date in the target timezone to get the offset
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const nowInTz = formatter.format(new Date());
  const nowTzDate = new Date(nowInTz);
  const offsetMs = nowTzDate.getTime() - new Date().getTime();

  // Apply inverse offset: local → UTC
  return new Date(localDate.getTime() - offsetMs);
}

// ─── Date/time picker ────────────────────────────────────────────────────

/**
 * Build day options for the next 8 days in the given timezone.
 */
function buildDayOptions(tz: string): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 24 * 3600_000);
    const dateStr = d.toLocaleDateString("en-CA", { timeZone: tz }); // "2026-03-30"
    const label = i === 0
      ? `Today (${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })})`
      : i === 1
        ? `Tomorrow (${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })})`
        : d.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" });
    options.push({ value: dateStr, label });
  }
  return options;
}

/**
 * Prompt for a date + time in the given timezone. Returns a UTC Date.
 */
async function promptDateTime(label: string, existing: UsageBucket | null, tz: string): Promise<Date | null> {
  const currentResetLabel = existing?.resetsAt
    ? `${formatAbsoluteTime(existing.resetsAt, tz)} (${formatResetTime(existing.resetsAt)})`
    : "not set";

  const wantChange = await p.confirm({
    message: `${label} reset — current: ${currentResetLabel}. Change?`,
    initialValue: !existing?.resetsAt,
  });
  if (p.isCancel(wantChange)) process.exit(0);
  if (!wantChange) return null; // keep existing

  const day = await p.select({
    message: `${label} resets on`,
    options: buildDayOptions(tz),
  });
  if (p.isCancel(day)) process.exit(0);

  const time = await p.text({
    message: `${label} resets at (e.g. "3:00 PM", "15:00")`,
    placeholder: "3:00 PM",
    validate: (v) => {
      if (!v || v === "") return "Enter a time";
      const m = v.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (!m) return 'Enter time like "3:00 PM" or "15:00"';
    },
  });
  if (p.isCancel(time)) process.exit(0);

  // Parse time
  const timeStr = time as string;
  const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i)!;
  let hour = parseInt(m[1]!, 10);
  const minute = parseInt(m[2]!, 10);
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  // Build local date in timezone, then convert to UTC
  const dateStr = day as string; // "2026-03-30"
  const localDate = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`);
  return zonedToUtc(localDate, tz);
}

// ─── Interactive prompts for a single bucket ─────────────────────────────

async function promptBucket(
  label: string,
  existing: UsageBucket | null,
  defaultResetHours: number,
  tz: string,
): Promise<UsageBucket | null> {
  const pct = await p.text({
    message: `${label} utilization %`,
    placeholder: existing ? String(existing.utilization) : "0",
    validate: (v) => {
      if (v === "") return;
      const n = Number(v);
      if (isNaN(n) || n < 0 || n > 100) return "Must be 0-100";
    },
  });
  if (p.isCancel(pct)) process.exit(0);

  const utilization = pct ? Number(pct) : (existing?.utilization ?? 0);

  const newResetDate = await promptDateTime(label, existing, tz);

  let resetsAt: string;
  if (newResetDate) {
    resetsAt = newResetDate.toISOString();
  } else if (existing?.resetsAt) {
    resetsAt = existing.resetsAt;
  } else {
    resetsAt = new Date(defaultResetMs(defaultResetHours)).toISOString();
  }

  return { utilization, resetsAt };
}

// ─── Interactive mode ────────────────────────────────────────────────────

async function runInteractive(existing: UsageData | null): Promise<UsageData> {
  console.log("");
  console.log(chalk.bold("Set usage percentages manually"));
  console.log(chalk.dim("  Leave blank to keep current value."));
  console.log("");

  // Timezone picker
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzChoice = await p.select({
    message: "Timezone for reset times",
    options: TIMEZONES.map((tz) => ({
      value: tz.value,
      label: tz.value === detectedTz ? `${tz.label} (detected)` : tz.label,
    })),
    initialValue: detectedTz,
  });
  if (p.isCancel(tzChoice)) process.exit(0);
  const tz = tzChoice as string;

  console.log("");
  showCurrent(existing, tz);

  const fiveHour = await promptBucket("5h", existing?.fiveHour ?? null, 5, tz);
  const sevenDay = await promptBucket("7d", existing?.sevenDay ?? null, 168, tz);
  const sevenDaySonnet = await promptBucket("Sonnet 7d", existing?.sevenDaySonnet ?? null, 168, tz);

  return {
    fiveHour,
    sevenDay,
    sevenDaySonnet,
    sevenDayOpus: existing?.sevenDayOpus ?? null,
    fetchedAt: Date.now(),
  };
}

// ─── CLI mode ────────────────────────────────────────────────────────────

function cliBucket(
  pctStr: string | undefined,
  resetStr: string | undefined,
  existing: UsageBucket | null,
  defaultResetHours: number,
): UsageBucket | null {
  if (pctStr === undefined) return existing;
  const pct = Number(pctStr);
  const resetMs = resetStr ? Number(resetStr) : defaultResetMs(defaultResetHours);
  return makeBucketFromMs(pct, resetMs);
}

function runCli(args: Record<string, string>, existing: UsageData | null): UsageData {
  return {
    fiveHour: cliBucket(args["5h"], args["5h-reset"], existing?.fiveHour ?? null, 5),
    sevenDay: cliBucket(args["7d"], args["7d-reset"], existing?.sevenDay ?? null, 168),
    sevenDaySonnet: cliBucket(args["sonnet"], args["sonnet-reset"], existing?.sevenDaySonnet ?? null, 168),
    sevenDayOpus: cliBucket(args["opus"], args["opus-reset"], existing?.sevenDayOpus ?? null, 168),
    fetchedAt: Date.now(),
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────

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

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log("");
  console.log(chalk.green("Usage updated:"));
  showCurrent(usage, tz);
  console.log(chalk.dim("  All running cig-loop instances will pick this up within ~15s."));
}
