import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCodexAccountId, getCodexEmail, getCodexPlanType } from "../codex-filter/plan.js";
import type { ProviderUsageReport, QuotaBucket, QuotaGroup } from "./types.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

interface RawCodexWindowPayload {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

interface RawCodexRateLimitPayload {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: RawCodexWindowPayload | null;
  secondary_window?: RawCodexWindowPayload | null;
}

interface RawCodexAdditionalRateLimit {
  limit_name?: string;
  metered_feature?: string;
  rate_limit?: RawCodexRateLimitPayload | null;
}

interface RawCodexUsageResponse {
  user_id?: string;
  account_id?: string;
  email?: string;
  plan_type?: string;
  rate_limit?: RawCodexRateLimitPayload | null;
  additional_rate_limits?: RawCodexAdditionalRateLimit[] | null;
  rate_limit_reset_credits?: {
    available_count?: number;
    applicable_available_count?: number;
  } | null;
  error?: {
    message?: string;
  };
}

export interface FetchCodexUsageOptions {
  accessToken: string;
  accountId?: string;
  email?: string;
  refreshToken?: string;
  signal?: AbortSignal;
}

interface CapacityStat {
  window: string;
  durationSeconds?: number;
  meter?: string;
  usedFraction: number;
}

function formatWindowLabel(seconds: number): string {
  const daySeconds = 86_400;
  if (seconds >= daySeconds) {
    const days = Math.round(seconds / daySeconds);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  const hours = Math.max(1, Math.round(seconds / 3600));
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function formatWindowShort(seconds: number): string {
  const daySeconds = 86_400;
  if (seconds >= daySeconds) {
    const days = Math.round(seconds / daySeconds);
    return `${days}d`;
  }
  const hours = Math.max(1, Math.round(seconds / 3600));
  return `${hours}h`;
}

function resolveResetTimeIso(window: RawCodexWindowPayload, nowMs: number): string | undefined {
  if (window.reset_at !== undefined && window.reset_at > 0) {
    const ms = window.reset_at > 1_000_000_000_000 ? window.reset_at : window.reset_at * 1000;
    if (Number.isFinite(ms)) {
      return new Date(ms).toISOString();
    }
  }
  if (window.reset_after_seconds !== undefined && window.reset_after_seconds >= 0) {
    return new Date(nowMs + window.reset_after_seconds * 1000).toISOString();
  }
  return undefined;
}

async function refreshCodexToken(
  refreshToken: string,
  signal?: AbortSignal
): Promise<{ access: string; refresh?: string; expires?: number } | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    return {
      access: data.access_token,
      refresh: data.refresh_token ?? refreshToken,
      expires: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
    };
  } catch {
    return null;
  }
}

function persistRefreshedAuth(newAccess: string, newRefresh?: string, expires?: number): void {
  try {
    const authPath = join(homedir(), ".pi/agent/auth.json");
    if (!existsSync(authPath)) return;
    const raw = readFileSync(authPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed["openai-codex"]) {
      parsed["openai-codex"].access = newAccess;
      if (newRefresh) parsed["openai-codex"].refresh = newRefresh;
      if (expires) parsed["openai-codex"].expires = expires;
      writeFileSync(authPath, JSON.stringify(parsed, null, 2), "utf-8");
    }
  } catch {
    // Ignore write errors
  }
}

/**
 * Fetches the user quota summary from OpenAI Codex (/wham/usage).
 */
export async function fetchCodexUsage(options: FetchCodexUsageOptions): Promise<ProviderUsageReport> {
  const fetchedAt = Date.now();
  let token = options.accessToken;
  const accountId = options.accountId || getCodexAccountId(token) || undefined;
  const fallbackEmail = options.email || getCodexEmail(token) || undefined;
  const fallbackPlan = getCodexPlanType(token) || undefined;

  const buildHeaders = (t: string): Record<string, string> => {
    const h: Record<string, string> = {
      Authorization: `Bearer ${t}`,
      "User-Agent": "pi",
      Accept: "application/json",
    };
    if (accountId) {
      h["ChatGPT-Account-Id"] = accountId;
    }
    return h;
  };

  try {
    let res = await fetch(CODEX_USAGE_URL, {
      method: "GET",
      headers: buildHeaders(token),
      signal: options.signal,
    });

    if (res.status === 401 && options.refreshToken) {
      const refreshed = await refreshCodexToken(options.refreshToken, options.signal);
      if (refreshed) {
        token = refreshed.access;
        persistRefreshedAuth(refreshed.access, refreshed.refresh, refreshed.expires);
        res = await fetch(CODEX_USAGE_URL, {
          method: "GET",
          headers: buildHeaders(token),
          signal: options.signal,
        });
      }
    }

    if (!res.ok) {
      const errorText = await res.text();
      return {
        providerId: "openai-codex",
        providerName: "OpenAI Codex",
        accountEmail: fallbackEmail,
        planType: fallbackPlan,
        fetchedAt,
        groups: [],
        error: `HTTP ${res.status}: ${errorText || res.statusText}`,
      };
    }

    const data = (await res.json()) as RawCodexUsageResponse;
    const email = data.email || fallbackEmail;
    const planType = data.plan_type || fallbackPlan;
    const resetCredits = data.rate_limit_reset_credits?.available_count;

    const buckets: QuotaBucket[] = [];
    const capacityStats: CapacityStat[] = [];
    const nowMs = Date.now();

    // 1. Primary and secondary chat rate limits
    const rateLimit = data.rate_limit;
    if (rateLimit) {
      if (rateLimit.primary_window) {
        const win = rateLimit.primary_window;
        const usedPercent = typeof win.used_percent === "number" ? win.used_percent : 0;
        const usedFraction = Math.max(0, Math.min(1, usedPercent / 100));
        const remainingFraction = Math.max(0, 1 - usedFraction);
        const displayName = win.limit_window_seconds
          ? formatWindowLabel(win.limit_window_seconds)
          : "Primary window";
        const windowShort = win.limit_window_seconds
          ? formatWindowShort(win.limit_window_seconds)
          : "primary";
        const resetTime = resolveResetTimeIso(win, nowMs);

        buckets.push({
          bucketId: "codex-primary",
          displayName,
          window: windowShort,
          windowSeconds: win.limit_window_seconds,
          remainingFraction,
          usedFraction,
          resetTime,
          description: rateLimit.limit_reached ? "limit reached" : undefined,
        });
        capacityStats.push({
          window: windowShort,
          durationSeconds: win.limit_window_seconds,
          usedFraction,
        });
      }

      if (rateLimit.secondary_window) {
        const win = rateLimit.secondary_window;
        const usedPercent = typeof win.used_percent === "number" ? win.used_percent : 0;
        const usedFraction = Math.max(0, Math.min(1, usedPercent / 100));
        const remainingFraction = Math.max(0, 1 - usedFraction);
        const displayName = win.limit_window_seconds
          ? formatWindowLabel(win.limit_window_seconds)
          : "Secondary window";
        const windowShort = win.limit_window_seconds
          ? formatWindowShort(win.limit_window_seconds)
          : "secondary";
        const resetTime = resolveResetTimeIso(win, nowMs);

        buckets.push({
          bucketId: "codex-secondary",
          displayName,
          window: windowShort,
          windowSeconds: win.limit_window_seconds,
          remainingFraction,
          usedFraction,
          resetTime,
          description: rateLimit.limit_reached ? "limit reached" : undefined,
        });
        capacityStats.push({
          window: windowShort,
          durationSeconds: win.limit_window_seconds,
          usedFraction,
        });
      }
    }

    // 2. Additional rate limits (Spark, Code Review, etc.)
    for (const item of data.additional_rate_limits ?? []) {
      if (!item?.rate_limit) continue;
      const slug = (item.metered_feature ?? item.limit_name ?? "extra")
        .toLowerCase()
        .replace(/^codex[-_]/, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const featureName = slug === "spark" ? "Spark" : (item.limit_name ?? slug);

      if (item.rate_limit.primary_window) {
        const win = item.rate_limit.primary_window;
        const usedPercent = typeof win.used_percent === "number" ? win.used_percent : 0;
        const usedFraction = Math.max(0, Math.min(1, usedPercent / 100));
        const remainingFraction = Math.max(0, 1 - usedFraction);
        const windowName = win.limit_window_seconds
          ? formatWindowLabel(win.limit_window_seconds)
          : "Primary window";
        const displayName = `${windowName} (${featureName})`;
        const windowShort = win.limit_window_seconds
          ? formatWindowShort(win.limit_window_seconds)
          : "primary";
        const resetTime = resolveResetTimeIso(win, nowMs);

        buckets.push({
          bucketId: `codex-${slug}-primary`,
          displayName,
          window: windowShort,
          windowSeconds: win.limit_window_seconds,
          remainingFraction,
          usedFraction,
          resetTime,
          description: item.rate_limit.limit_reached ? "limit reached" : undefined,
        });
        capacityStats.push({
          window: windowShort,
          durationSeconds: win.limit_window_seconds,
          meter: featureName,
          usedFraction,
        });
      }

      if (item.rate_limit.secondary_window) {
        const win = item.rate_limit.secondary_window;
        const usedPercent = typeof win.used_percent === "number" ? win.used_percent : 0;
        const usedFraction = Math.max(0, Math.min(1, usedPercent / 100));
        const remainingFraction = Math.max(0, 1 - usedFraction);
        const windowName = win.limit_window_seconds
          ? formatWindowLabel(win.limit_window_seconds)
          : "Secondary window";
        const displayName = `${windowName} (${featureName})`;
        const windowShort = win.limit_window_seconds
          ? formatWindowShort(win.limit_window_seconds)
          : "secondary";
        const resetTime = resolveResetTimeIso(win, nowMs);

        buckets.push({
          bucketId: `codex-${slug}-secondary`,
          displayName,
          window: windowShort,
          windowSeconds: win.limit_window_seconds,
          remainingFraction,
          usedFraction,
          resetTime,
          description: item.rate_limit.limit_reached ? "limit reached" : undefined,
        });
        capacityStats.push({
          window: windowShort,
          durationSeconds: win.limit_window_seconds,
          meter: featureName,
          usedFraction,
        });
      }
    }

    // Sort capacity stats by durationSeconds ascending, then meter name
    capacityStats.sort((a, b) => {
      const durA = a.durationSeconds ?? Number.POSITIVE_INFINITY;
      const durB = b.durationSeconds ?? Number.POSITIVE_INFINITY;
      if (durA !== durB) return durA - durB;
      return (a.meter ?? "").localeCompare(b.meter ?? "");
    });

    const capacityParts = capacityStats.map((stat) => {
      const meterLabel = stat.meter ? ` (${stat.meter})` : "";
      const used = stat.usedFraction.toFixed(2);
      const left = (1 - stat.usedFraction).toFixed(2);
      return `${stat.window}${meterLabel} → ${used}/1 account used (${left}× quota left)`;
    });

    const capacitySummary =
      capacityParts.length > 0 ? `capacity: ${capacityParts.join(" · ")}` : undefined;

    const groups: QuotaGroup[] =
      buckets.length > 0
        ? [
            {
              displayName: "ChatGPT Limits",
              buckets,
            },
          ]
        : [];

    return {
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      accountEmail: email,
      planType,
      resetCredits,
      fetchedAt,
      groups,
      capacitySummary,
    };
  } catch (err) {
    return {
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      accountEmail: fallbackEmail,
      planType: fallbackPlan,
      fetchedAt,
      groups: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
