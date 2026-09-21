import {
  ANTIGRAVITY_PRIMARY_ENDPOINT,
  LOAD_CODE_ASSIST_URL,
  getAntigravityUserAgent,
} from "../antigravity/constants.js";
import type { LoadCodeAssistResponse } from "../antigravity/types.js";
import type { ProviderUsageReport, QuotaBucket, QuotaGroup } from "./types.js";

interface RawQuotaBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  description?: string;
}

interface RawQuotaGroup {
  displayName?: string;
  description?: string;
  buckets?: RawQuotaBucket[];
}

interface RawQuotaSummaryResponse {
  groups?: RawQuotaGroup[];
  description?: string;
  error?: {
    code?: number;
    message?: string;
  };
}

/**
 * Fetches the user quota summary and plan tier from Antigravity Cloud Code Assist.
 */
export async function fetchAntigravityUsage(
  accessToken: string,
  projectId: string,
  email?: string,
  signal?: AbortSignal,
  fallbackPlanType?: string
): Promise<ProviderUsageReport> {
  const fetchedAt = Date.now();
  const url = `${ANTIGRAVITY_PRIMARY_ENDPOINT}/v1internal:retrieveUserQuotaSummary`;
  let planType = fallbackPlanType;

  try {
    const [quotaRes, loadRes] = await Promise.allSettled([
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": getAntigravityUserAgent(),
        },
        body: JSON.stringify({ project: projectId }),
        signal,
      }),
      fetch(LOAD_CODE_ASSIST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": getAntigravityUserAgent(),
        },
        body: JSON.stringify({
          cloudaicompanionProject: projectId,
          metadata: { ideType: "ANTIGRAVITY" },
        }),
        signal,
      }),
    ]);

    if (loadRes.status === "fulfilled" && loadRes.value.ok) {
      try {
        const loadData = (await loadRes.value.json()) as LoadCodeAssistResponse;
        planType = loadData.paidTier?.id || loadData.currentTier?.id || planType || "free-tier";
      } catch {
        // Ignore JSON error
      }
    } else if (!planType) {
      planType = "free-tier";
    }

    if (quotaRes.status === "rejected" || !quotaRes.value.ok) {
      const errorText =
        quotaRes.status === "fulfilled"
          ? await quotaRes.value.text()
          : String(quotaRes.reason);
      const statusCode = quotaRes.status === "fulfilled" ? quotaRes.value.status : "Error";
      return {
        providerId: "google-antigravity",
        providerName: "Google Antigravity",
        accountEmail: email,
        planType,
        fetchedAt,
        groups: [],
        error: `HTTP ${statusCode}: ${errorText}`,
      };
    }

    const data = (await quotaRes.value.json()) as RawQuotaSummaryResponse;
    const rawGroups = data.groups ?? [];

    let min5hRemaining = 1.0;
    let minWeeklyRemaining = 1.0;
    let has5h = false;
    let hasWeekly = false;

    const groups: QuotaGroup[] = rawGroups.map((rg) => {
      const buckets: QuotaBucket[] = (rg.buckets ?? []).map((b) => {
        const remainingFraction = b.remainingFraction ?? 1.0;
        const usedFraction = Math.max(0, Math.min(1, 1 - remainingFraction));
        const window = (b.window ?? "").toLowerCase();

        if (window.includes("5h") || b.bucketId?.includes("5h")) {
          has5h = true;
          min5hRemaining = Math.min(min5hRemaining, remainingFraction);
        } else if (window.includes("week") || b.bucketId?.includes("weekly")) {
          hasWeekly = true;
          minWeeklyRemaining = Math.min(minWeeklyRemaining, remainingFraction);
        }

        let displayName = b.displayName ?? b.bucketId ?? "Quota";
        if (b.bucketId === "gemini-weekly") displayName = "Gemini (Weekly)";
        else if (b.bucketId === "gemini-5h") displayName = "Gemini (5 Hour)";
        else if (b.bucketId === "3p-weekly") displayName = "Claude & GPT (shared) (Weekly)";
        else if (b.bucketId === "3p-5h") displayName = "Claude & GPT (shared) (5 Hour)";

        return {
          bucketId: b.bucketId ?? "default",
          displayName,
          window: b.window ?? "default",
          remainingFraction,
          usedFraction,
          resetTime: b.resetTime,
          description: b.description,
        };
      });

      return {
        displayName: rg.displayName ?? "Models",
        description: rg.description,
        buckets,
      };
    });

    // Build capacity summary line matching omp format
    const capacityParts: string[] = [];
    if (has5h) {
      const used5h = (1 - min5hRemaining).toFixed(2);
      const left5h = min5hRemaining.toFixed(2);
      capacityParts.push(`5h → ${used5h}/1 account used (${left5h}× quota left)`);
    }
    if (hasWeekly) {
      const usedWeekly = (1 - minWeeklyRemaining).toFixed(2);
      const leftWeekly = minWeeklyRemaining.toFixed(2);
      capacityParts.push(`7d → ${usedWeekly}/1 account used (${leftWeekly}× quota left)`);
    }

    const capacitySummary =
      capacityParts.length > 0 ? `capacity: ${capacityParts.join(" · ")}` : undefined;

    return {
      providerId: "google-antigravity",
      providerName: "Google Antigravity",
      accountEmail: email,
      planType,
      fetchedAt,
      groups,
      capacitySummary,
    };
  } catch (err) {
    return {
      providerId: "google-antigravity",
      providerName: "Google Antigravity",
      accountEmail: email,
      planType,
      fetchedAt,
      groups: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
