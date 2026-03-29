/**
 * Scrape usage data from claude.ai/settings/usage by connecting to a running
 * Chrome instance via the Chrome DevTools Protocol (CDP).
 *
 * This avoids the aggressively rate-limited /api/oauth/usage endpoint by
 * loading the dashboard page in an authenticated browser session.
 *
 * Requires: Chrome running with --remote-debugging-port=<port>, already
 * authenticated to claude.ai (past Cloudflare).
 *
 * Works with any CDP-exposing browser: OpenClaw, Playwright, raw Chrome, etc.
 */

import type { UsageData } from "./types.js";

/**
 * Connect to a Chrome CDP endpoint, open the usage page in a new tab,
 * extract data, close the tab. Returns null on any failure.
 */
export async function scrapeUsage(cdpPort: number): Promise<UsageData | null> {
  let targetId: string | null = null;

  try {
    // Create a new tab via CDP HTTP API (Chrome requires PUT)
    const newTabResp = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?about:blank`,
      { method: "PUT", signal: AbortSignal.timeout(5_000) },
    );
    if (!newTabResp.ok) return null;
    const newTab = await newTabResp.json() as { id: string; webSocketDebuggerUrl: string };
    targetId = newTab.id;

    // Connect CDP WebSocket to the new tab
    const ws = new WebSocket(newTab.webSocketDebuggerUrl);
    const cdp = new CdpClient(ws);
    await cdp.ready();

    // Navigate to usage page
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: "https://claude.ai/settings/usage" });
    await cdp.waitForEvent("Page.loadEventFired", 15_000);

    // Wait for Cloudflare challenge + React render
    await Bun.sleep(8_000);

    // Extract body text
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.body?.innerText || ''",
      returnByValue: true,
    });

    ws.close();

    // Close the tab
    await fetch(
      `http://127.0.0.1:${cdpPort}/json/close/${targetId}`,
      { method: "PUT", signal: AbortSignal.timeout(5_000) },
    ).catch(() => {});
    targetId = null;

    const bodyText: string = result?.result?.value || "";
    if (!bodyText || bodyText.includes("security verification")) {
      return null; // Cloudflare didn't pass
    }

    return parseUsagePage(bodyText);
  } catch {
    // Clean up tab on error
    if (targetId) {
      await fetch(
        `http://127.0.0.1:${cdpPort}/json/close/${targetId}`,
        { method: "PUT", signal: AbortSignal.timeout(3_000) },
      ).catch(() => {});
    }
    return null;
  }
}

// ─── Page Parser ────────────────────────────────────────────────────────

/**
 * Parse usage data from the claude.ai/settings/usage page body text.
 *
 * Expected sections:
 *   "Current session" → 5h bucket
 *   "All models"      → 7d bucket
 *   "Sonnet only"     → sonnet bucket
 *   "Opus only"       → opus bucket
 */
function parseUsagePage(text: string): UsageData | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  function findSection(patterns: string[]): { utilization: number; resetsAt: string } | null {
    for (const pattern of patterns) {
      const idx = lines.findIndex((l) => l.toLowerCase().includes(pattern.toLowerCase()));
      if (idx === -1) continue;

      let utilization: number | null = null;
      let resetsAt = "";

      for (let i = idx; i < Math.min(idx + 8, lines.length); i++) {
        const line = lines[i]!;
        const pctMatch = line.match(/(\d+)%\s*used/);
        if (pctMatch) utilization = parseInt(pctMatch[1]!, 10);

        if (!resetsAt) {
          const resetMatch = line.match(/Resets?\s+(?:in\s+)?(.+)/i);
          if (resetMatch) resetsAt = resetToIso(resetMatch[1]!.trim());
        }
      }

      if (utilization !== null) return { utilization, resetsAt };
    }
    return null;
  }

  const fiveHour = findSection(["Current session"]);
  const sevenDay = findSection(["All models"]);
  const sevenDaySonnet = findSection(["Sonnet only"]);
  const sevenDayOpus = findSection(["Opus only"]);

  if (!fiveHour && !sevenDay && !sevenDaySonnet && !sevenDayOpus) return null;

  return { fiveHour, sevenDay, sevenDaySonnet, sevenDayOpus, fetchedAt: Date.now() };
}

/**
 * Convert a human-readable reset string to an approximate ISO 8601 timestamp.
 * Handles: "8 min", "2 hr 30 min", "Thu 8:00 PM", etc.
 */
function resetToIso(resetStr: string): string {
  const now = new Date();

  // Relative: "X hr Y min", "X min"
  const relMatch = resetStr.match(/(?:(\d+)\s*h(?:r|ours?)?)?[\s,]*(?:(\d+)\s*min)?/i);
  if (relMatch && (relMatch[1] || relMatch[2])) {
    const hours = parseInt(relMatch[1] || "0", 10);
    const mins = parseInt(relMatch[2] || "0", 10);
    if (hours > 0 || mins > 0) {
      return new Date(now.getTime() + hours * 3600_000 + mins * 60_000).toISOString();
    }
  }

  // Absolute: "Thu 8:00 PM"
  const absMatch = resetStr.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (absMatch) {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const targetDay = dayNames.findIndex((d) => absMatch[1]!.startsWith(d));
    let hour = parseInt(absMatch[2]!, 10);
    const minute = parseInt(absMatch[3]!, 10);
    if (absMatch[4]!.toUpperCase() === "PM" && hour < 12) hour += 12;
    if (absMatch[4]!.toUpperCase() === "AM" && hour === 12) hour = 0;

    const reset = new Date(now);
    reset.setHours(hour, minute, 0, 0);
    let daysAhead = targetDay - now.getDay();
    if (daysAhead <= 0) daysAhead += 7;
    if (daysAhead === 0 && reset <= now) daysAhead = 7;
    reset.setDate(reset.getDate() + daysAhead);
    return reset.toISOString();
  }

  return "";
}

// ─── CDP Client ─────────────────────────────────────────────────────────

class CdpClient {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private events: Array<(method: string, params: any) => void> = [];
  private readyPromise: Promise<void>;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.readyPromise = new Promise((resolve) => {
      ws.addEventListener("open", () => resolve());
    });
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
        if (msg.method) {
          for (const cb of this.events) cb(msg.method, msg.params);
        }
      } catch { /* ignore */ }
    });
  }

  ready(): Promise<void> { return this.readyPromise; }

  send(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  waitForEvent(eventName: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const cb = (method: string) => {
        if (method === eventName) {
          this.events = this.events.filter((e) => e !== cb);
          resolve();
        }
      };
      this.events.push(cb);
      setTimeout(() => {
        this.events = this.events.filter((e) => e !== cb);
        resolve();
      }, timeoutMs);
    });
  }
}
