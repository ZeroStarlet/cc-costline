import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync, utimesSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { readCache, writeCache } from "./cache.js";
import { collectCosts } from "./collector.js";
import { shouldRefreshLocalCostCache } from "./statusline.js";

// Anthropic usage API: strict per-token rate limits (~5 req/token). NEVER shrink.
const ANTHROPIC_TTL_MS = 300_000;
// ccclub rank: self-hosted, no strict limits — refresh more aggressively for visible data.
const CCCLUB_TTL_MS = 90_000;

const REFRESH_LOCK = join(tmpdir(), "sl-refresh.lock");
const REFRESH_LAST = join(tmpdir(), "sl-refresh.last");
const LOCK_STALE_MS = 60_000;

function acquireLock(): boolean {
  try {
    if (existsSync(REFRESH_LOCK)) {
      try {
        const stat = statSync(REFRESH_LOCK);
        if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
        unlinkSync(REFRESH_LOCK);
      } catch {
        return false;
      }
    }
    const fd = openSync(REFRESH_LOCK, "wx");
    try {
      writeFileSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try { unlinkSync(REFRESH_LOCK); } catch {}
  try {
    const now = new Date();
    if (!existsSync(REFRESH_LAST)) {
      writeFileSync(REFRESH_LAST, "");
    }
    utimesSync(REFRESH_LAST, now, now);
  } catch {}
}

function refreshLocalCost(transcriptPath: string): void {
  const cache = readCache();
  if (!shouldRefreshLocalCostCache(cache, transcriptPath)) return;
  try {
    const result = collectCosts(undefined, cache?.files);
    // Don't overwrite valid cache with zeros (directory read failure)
    if (result.cost7d > 0 || result.cost30d > 0 || !cache) {
      writeCache({
        cost7d: result.cost7d,
        cost30d: result.cost30d,
        updatedAt: new Date().toISOString(),
        files: result.files,
      });
    }
  } catch {}
}

function refreshClaudeUsage(): void {
  const cacheFile = join(tmpdir(), "sl-claude-usage");
  const hitFile = join(tmpdir(), "sl-claude-usage-hit");
  const now = Date.now();

  let staleData: { fiveHour: number; sevenDay: number; fiveHourResetsAt?: number } | null = null;
  let lastAttempt = 0;
  let cachedTokenPrefix = "";
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
      staleData = cached.data ?? null;
      lastAttempt = cached.lastAttempt || 0;
      cachedTokenPrefix = cached.tokenPrefix || "";
    } catch {}
  }

  // Get current token — cross-platform:
  //   macOS: Keychain first (Claude Code 2.x), then file fallback
  //   Windows/Linux: ~/.claude/.credentials.json (Claude Code stores tokens there)
  let accessToken = "";
  try {
    let credentialsJSON = "";
    if (process.platform === "darwin") {
      try {
        const username = process.env.USER || process.env.USERNAME;
        const keychainCmd = `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w 2>/dev/null`;
        credentialsJSON = execSync(keychainCmd, { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).trim();
      } catch {
        // Keychain miss — fall through to file fallback
      }
    }
    if (!credentialsJSON) {
      const credPath = join(homedir(), ".claude", ".credentials.json");
      if (existsSync(credPath)) {
        credentialsJSON = readFileSync(credPath, "utf-8");
      }
    }
    if (!credentialsJSON) return;
    const credentials = JSON.parse(credentialsJSON);
    accessToken = credentials.claudeAiOauth?.accessToken || "";
    if (!accessToken) return;
    const expiresAt = credentials.claudeAiOauth?.expiresAt;
    if (expiresAt && now > expiresAt) return;
  } catch {
    return;
  }

  const currentTokenPrefix = accessToken.slice(-20);
  const tokenChanged = cachedTokenPrefix && currentTokenPrefix !== cachedTokenPrefix;

  // Skip if cache is fresh and token hasn't rotated
  if (!tokenChanged && lastAttempt && now - lastAttempt < ANTHROPIC_TTL_MS) return;

  // Mark attempt before HTTP — protects against repeated failures hammering the API
  try { writeFileSync(cacheFile, JSON.stringify({ data: staleData, lastAttempt: now, tokenPrefix: currentTokenPrefix }), "utf-8"); } catch {}

  try {
    const apiUrl = "https://api.anthropic.com/api/oauth/usage";
    const curlCmd = `curl -sf "${apiUrl}" -H "Authorization: Bearer ${accessToken}" -H "anthropic-beta: oauth-2025-04-20"`;
    const response = execSync(curlCmd, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
    if (!response) return;
    const data = JSON.parse(response);
    try { writeFileSync(join(tmpdir(), "sl-claude-usage-raw"), JSON.stringify(data, null, 2), "utf-8"); } catch {}

    const parseUtil = (val: any): number => {
      if (typeof val === "number") return Math.round(val);
      if (typeof val === "string") return Math.round(parseFloat(val.replace("%", "")));
      return 0;
    };
    const fiveHour = parseUtil(data.five_hour?.utilization);
    const sevenDay = parseUtil(data.seven_day?.utilization);

    let fiveHourResetsAt: number | undefined;
    const resetsAtRaw = data.five_hour?.resets_at ?? data.five_hour?.reset_at ?? data.five_hour?.next_reset;
    if (resetsAtRaw) {
      const ts = typeof resetsAtRaw === "string" ? new Date(resetsAtRaw).getTime() : resetsAtRaw * 1000;
      if (!isNaN(ts) && ts > now) fiveHourResetsAt = ts;
    }
    if (fiveHour >= 100) {
      if (!fiveHourResetsAt) {
        if (existsSync(hitFile)) {
          const hitTime = parseFloat(readFileSync(hitFile, "utf-8").trim());
          if (!isNaN(hitTime)) fiveHourResetsAt = hitTime + 5 * 3600 * 1000;
        } else {
          writeFileSync(hitFile, String(now), "utf-8");
          fiveHourResetsAt = now + 5 * 3600 * 1000;
        }
      }
    } else {
      try { if (existsSync(hitFile)) unlinkSync(hitFile); } catch {}
    }

    const result: { fiveHour: number; sevenDay: number; fiveHourResetsAt?: number } = { fiveHour, sevenDay };
    if (fiveHourResetsAt) result.fiveHourResetsAt = fiveHourResetsAt;
    writeFileSync(cacheFile, JSON.stringify({ data: result, lastAttempt: now, tokenPrefix: currentTokenPrefix }), "utf-8");
  } catch {}
}

function refreshCcclubRank(): void {
  const configPath = join(homedir(), ".ccclub", "config.json");
  if (!existsSync(configPath)) return;
  const cacheFile = join(tmpdir(), "sl-ccclub-rank");
  const now = Date.now();

  let staleData: { rank: number; total: number; cost: number } | null = null;
  let lastAttempt = 0;
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
      staleData = cached.data ?? null;
      lastAttempt = cached.lastAttempt || cached.timestamp || 0;
      if (now - lastAttempt < CCCLUB_TTL_MS) return;
    } catch {}
  }

  // Mark attempt before HTTP
  try { writeFileSync(cacheFile, JSON.stringify({ data: staleData, timestamp: staleData ? (lastAttempt || now) : 0, lastAttempt: now }), "utf-8"); } catch {}

  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const code = config.groups?.[0];
    const userId = config.userId;
    if (!code || !userId) return;
    const tz = -(new Date()).getTimezoneOffset();
    const url = `${config.apiUrl}/api/rank/${code}?period=today&tz=${tz}`;
    const response = execSync(`curl -sf "${url}"`, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
    if (!response) return;
    const data = JSON.parse(response);
    const rankings = data.rankings || [];
    const me = rankings.find((r: any) => r.userId === userId);
    if (!me) return;
    const result = { rank: me.rank, total: rankings.length, cost: me.costUSD };
    writeFileSync(cacheFile, JSON.stringify({ data: result, timestamp: now, lastAttempt: now }), "utf-8");
  } catch {}
}

export function refreshAll(transcriptPath = ""): void {
  if (!acquireLock()) return;
  try {
    refreshLocalCost(transcriptPath);
    refreshClaudeUsage();
    refreshCcclubRank();
  } finally {
    releaseLock();
  }
}
