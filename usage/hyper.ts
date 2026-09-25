import { CREDITS_FETCH_TIMEOUT_MS, CREDITS_URL, HYPER_USER_AGENT, PROVIDER_ID, PROVIDER_NAME } from "../hyper/constants.js";
import type { CreditsResponse } from "../hyper/types.js";
import type { ProviderUsageReport, QuotaBucket } from "./types.js";

/**
 * Fetches the remaining Hypercredit balance and quota health from Charm Hyper.
 */
export async function fetchHyperUsage(
  token: string,
  label?: string,
  signal?: AbortSignal,
  planType = "free"
): Promise<ProviderUsageReport> {
  const fetchedAt = Date.now();

  try {
    const timeoutSignal = AbortSignal.timeout(CREDITS_FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const res = await fetch(CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": HYPER_USER_AGENT,
      },
      signal: combinedSignal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      return {
        providerId: PROVIDER_ID,
        providerName: PROVIDER_NAME,
        accountEmail: label,
        planType,
        fetchedAt,
        groups: [],
        error: `Credits check failed (${res.status}): ${errorText}`,
      };
    }

    const data = (await res.json()) as CreditsResponse;
    let balance = data.balance;
    if (balance === undefined && typeof data.balance_usd === "number") {
      balance = data.balance_usd / 0.05;
    }

    if (balance === undefined || typeof balance !== "number") {
      return {
        providerId: PROVIDER_ID,
        providerName: PROVIDER_NAME,
        accountEmail: label,
        planType,
        fetchedAt,
        groups: [],
        error: "Invalid credits payload received from Hyper",
      };
    }

    // 1 Hypercredit = $0.05. Free plan starts with 100 HC refreshing monthly.
    const totalAllocation = balance > 100 ? Math.ceil(balance / 100) * 100 : 100;
    const usedCredits = Math.max(0, totalAllocation - balance);
    const usedFraction = Math.max(0, Math.min(1, usedCredits / totalAllocation));
    const remainingFraction = Math.max(0, Math.min(1, balance / totalAllocation));
    const usdVal = (balance * 0.05).toFixed(2);
    const formattedBalance = Number.isInteger(balance) ? balance.toString() : balance.toFixed(2);

    const bucket: QuotaBucket = {
      bucketId: "hypercredits",
      displayName: `Credits (${formattedBalance} HC / $${usdVal})`,
      window: "monthly",
      windowSeconds: 30 * 86400,
      usedFraction,
      remainingFraction,
      description: `${formattedBalance} Hypercredits available ($${usdVal})`,
    };

    return {
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      accountEmail: label,
      planType,
      fetchedAt,
      groups: [
        {
          displayName: "Credits",
          buckets: [bucket],
        },
      ],
      capacitySummary: `${formattedBalance} HC ($${usdVal})`,
    };
  } catch (err) {
    return {
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      accountEmail: label,
      planType,
      fetchedAt,
      groups: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
