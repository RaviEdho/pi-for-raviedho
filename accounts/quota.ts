import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fetchAntigravityUsage } from "../usage/antigravity.js";
import { fetchCodexUsage } from "../usage/codex.js";
import type { ProviderUsageReport } from "../usage/types.js";
import type { AccountCredential } from "./types.js";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache TTL

export interface AccountQuotaHealth {
  isExhausted: boolean;
  usedFraction: number; // 0.0 to 1.0
  remainingFraction: number;
  resetTimeMs?: number;
  reason?: string;
}

interface CachedQuotaEntry {
  report: ProviderUsageReport;
  fetchedAt: number;
}

export class QuotaManager {
  private static instance?: QuotaManager;
  private cache: Map<string, CachedQuotaEntry> = new Map();
  private cachePath: string;

  private constructor() {
    this.cachePath = join(homedir(), ".pi/agent/quota-cache.json");
    this.loadDiskCache();
  }

  public static getInstance(): QuotaManager {
    if (!QuotaManager.instance) {
      QuotaManager.instance = new QuotaManager();
    }
    return QuotaManager.instance;
  }

  private loadDiskCache(): void {
    if (!existsSync(this.cachePath)) return;
    try {
      const raw = readFileSync(this.cachePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [id, entry] of Object.entries(parsed)) {
          if (entry && typeof entry === "object" && "report" in entry) {
            this.cache.set(id, entry as CachedQuotaEntry);
          }
        }
      }
    } catch {
      // Ignore disk cache load error
    }
  }

  private saveDiskCache(): void {
    try {
      const dir = dirname(this.cachePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const data: Record<string, CachedQuotaEntry> = {};
      for (const [id, entry] of this.cache.entries()) {
        data[id] = entry;
      }
      writeFileSync(this.cachePath, JSON.stringify(data), {
        encoding: "utf-8",
        mode: 0o600,
      });
      try {
        chmodSync(this.cachePath, 0o600);
      } catch {
        // Ignore chmod error
      }
    } catch {
      // Ignore disk cache save error
    }
  }

  /**
   * Stores a freshly fetched usage report in memory and disk cache.
   */
  public setReport(accountId: string, report: ProviderUsageReport): void {
    this.cache.set(accountId, {
      report,
      fetchedAt: Date.now(),
    });
    this.saveDiskCache();
  }

  /**
   * Retrieves the cached report for an account if not expired.
   */
  public getReport(accountId: string): ProviderUsageReport | undefined {
    const entry = this.cache.get(accountId);
    if (!entry) return undefined;
    return entry.report;
  }

  /**
   * Opportunistically fetches and caches quota for an account if not already cached or expired.
   */
  public async ensureFreshQuota(
    account: AccountCredential,
    token: string,
    signal?: AbortSignal
  ): Promise<ProviderUsageReport | null> {
    const entry = this.cache.get(account.id);
    const now = Date.now();
    if (entry && now - entry.fetchedAt < CACHE_TTL_MS) {
      return entry.report;
    }

    try {
      let report: ProviderUsageReport | null = null;
      if (account.provider === "google-antigravity") {
        report = await fetchAntigravityUsage(
          token,
          account.projectId || "aicode-consumers",
          account.email || account.id,
          signal
        );
      } else if (account.provider === "openai-codex") {
        report = await fetchCodexUsage({
          accessToken: token,
          accountId: account.accountId,
          email: account.email || account.id,
          refreshToken: account.refresh,
          signal,
        });
      }

      if (report && !report.error) {
        this.setReport(account.id, report);
        return report;
      }
    } catch {
      // Ignore background fetch error
    }

    return entry ? entry.report : null;
  }

  /**
   * Evaluates quota health for an account relative to a specific model.
   */
  public evaluateAccountHealth(account: AccountCredential, modelId?: string): AccountQuotaHealth {
    const now = Date.now();

    // 1. Check explicit 429 cooldown
    if (account.blockedUntil && account.blockedUntil > now) {
      return {
        isExhausted: true,
        usedFraction: 1.0,
        remainingFraction: 0.0,
        resetTimeMs: account.blockedUntil,
        reason: account.blockedReason || "Rate limited (429)",
      };
    }

    const report = this.getReport(account.id);
    if (!report || report.groups.length === 0) {
      // No cached report yet: assume healthy with median usage
      return {
        isExhausted: false,
        usedFraction: 0.0,
        remainingFraction: 1.0,
      };
    }

    const cleanModel = (modelId || "").toLowerCase();

    // 2. Google Antigravity quota evaluation
    if (account.provider === "google-antigravity") {
      const isClaudeOrGpt = cleanModel.includes("claude") || cleanModel.includes("gpt");
      const targetPrefix = isClaudeOrGpt ? "3p" : "gemini";

      const allBuckets = report.groups.flatMap((g) => g.buckets);
      // Filter relevant buckets for this model family
      let relevantBuckets = allBuckets.filter((b) => b.bucketId.toLowerCase().includes(targetPrefix));
      if (relevantBuckets.length === 0) {
        relevantBuckets = allBuckets;
      }

      let isExhausted = false;
      let maxUsed = 0.0;
      let soonestResetMs: number | undefined;
      let exhaustionReason: string | undefined;

      for (const bucket of relevantBuckets) {
        let bucketResetMs: number | undefined;
        if (bucket.resetTime) {
          const parsed = Date.parse(bucket.resetTime);
          if (!isNaN(parsed)) bucketResetMs = parsed;
        }

        const isPastReset = bucketResetMs !== undefined && bucketResetMs <= now;
        const remaining = isPastReset ? 1.0 : bucket.remainingFraction;
        const used = isPastReset ? 0.0 : bucket.usedFraction;

        maxUsed = Math.max(maxUsed, used);

        if (!isPastReset && remaining <= 0.001) {
          isExhausted = true;
          exhaustionReason = `${bucket.displayName} quota exhausted`;
          if (bucketResetMs && (!soonestResetMs || bucketResetMs < soonestResetMs)) {
            soonestResetMs = bucketResetMs;
          }
        }
      }

      return {
        isExhausted,
        usedFraction: maxUsed,
        remainingFraction: Math.max(0, 1 - maxUsed),
        resetTimeMs: soonestResetMs,
        reason: exhaustionReason,
      };
    }

    // 3. OpenAI Codex quota evaluation
    if (account.provider === "openai-codex") {
      const allBuckets = report.groups.flatMap((g) => g.buckets);
      let isExhausted = false;
      let maxUsed = 0.0;
      let soonestResetMs: number | undefined;
      let exhaustionReason: string | undefined;

      for (const bucket of allBuckets) {
        let bucketResetMs: number | undefined;
        if (bucket.resetTime) {
          const parsed = Date.parse(bucket.resetTime);
          if (!isNaN(parsed)) bucketResetMs = parsed;
        }

        const isPastReset = bucketResetMs !== undefined && bucketResetMs <= now;
        const remaining = isPastReset ? 1.0 : bucket.remainingFraction;
        const used = isPastReset ? 0.0 : bucket.usedFraction;

        maxUsed = Math.max(maxUsed, used);

        if (!isPastReset && (remaining <= 0.001 || bucket.description?.includes("limit reached"))) {
          isExhausted = true;
          exhaustionReason = `${bucket.displayName} limit reached`;
          if (bucketResetMs && (!soonestResetMs || bucketResetMs < soonestResetMs)) {
            soonestResetMs = bucketResetMs;
          }
        }
      }

      return {
        isExhausted,
        usedFraction: maxUsed,
        remainingFraction: Math.max(0, 1 - maxUsed),
        resetTimeMs: soonestResetMs,
        reason: exhaustionReason,
      };
    }

    return {
      isExhausted: false,
      usedFraction: 0.0,
      remainingFraction: 1.0,
    };
  }
}
