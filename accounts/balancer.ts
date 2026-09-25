import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { discoverProject, refreshAntigravityToken } from "../antigravity/oauth.js";
import { DEFAULT_FALLBACK_FREE_MODELS, loadCachedCatalog } from "../codex-filter/catalog.js";
import { getCodexPlanType } from "../codex-filter/plan.js";
import { refreshHyperToken } from "../hyper/oauth.js";
import { QuotaManager } from "./quota.js";
import { AccountStore } from "./store.js";
import type { AccountCredential, ResolvedAccountAuth } from "./types.js";

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes default cooldown on 429
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh if within 5 minutes of expiring

/**
 * Checks if an account is eligible to serve a requested model.
 */
export function isAccountEligibleForModel(account: AccountCredential, modelId?: string): boolean {
  if (account.provider !== "openai-codex" || !modelId) {
    return true;
  }

  const slug = modelId.startsWith("openai-codex/")
    ? modelId.slice("openai-codex/".length)
    : modelId;

  const plan = getCodexPlanType(account.access);
  if (!plan) {
    return true;
  }

  const catalog = loadCachedCatalog();
  if (catalog && catalog.length > 0) {
    const found = catalog.find((m) => m.slug === slug);
    if (found) {
      return found.availableInPlans.includes(plan);
    }
  }

  if (plan === "free") {
    return DEFAULT_FALLBACK_FREE_MODELS.includes(slug);
  }

  return true;
}

/**
 * Checks if an error message or object corresponds to rate limiting or quota exhaustion.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /429|402|rate.?limit|quota.?exceeded|resource.?exhausted|usage.?limit|usage.?not.?included|too.?many.?requests|freeusagelimiterror|gousagelimiterror|insufficient.?hypercredits|billing_error/i.test(
      msg
    ) ||
    (typeof error === "object" &&
      error !== null &&
      "status" in error &&
      ((error as { status: unknown }).status === 429 ||
        (error as { status: unknown }).status === 402))
  );
}

/**
 * Attempts to extract a recommended cooldown in milliseconds from an error.
 */
export function extractCooldownMs(error: unknown): number {
  if (!error) return DEFAULT_COOLDOWN_MS;
  const msg = error instanceof Error ? error.message : String(error);

  // Match "resets in ~X min" or "try again in ~X min" or "in X minutes"
  const minMatch = msg.match(/(?:resets|again|wait)\s+in\s+~?(\d+)\s*(?:m|min|minute)/i);
  if (minMatch && minMatch[1]) {
    const mins = parseInt(minMatch[1], 10);
    if (!isNaN(mins) && mins > 0) {
      return (mins + 1) * 60 * 1000;
    }
  }

  // Match seconds: "try again in X seconds" or "in ~X sec"
  const secMatch = msg.match(/(?:resets|again|wait)\s+in\s+~?(\d+)\s*(?:s|sec|second)/i);
  if (secMatch && secMatch[1]) {
    const secs = parseInt(secMatch[1], 10);
    if (!isNaN(secs) && secs > 0) {
      return (secs + 5) * 1000;
    }
  }

  return DEFAULT_COOLDOWN_MS;
}

export class AccountBalancer {
  private static instance?: AccountBalancer;
  private store: AccountStore;
  private sessionBindings: Map<string, Map<string, string>> = new Map();

  private constructor(store?: AccountStore) {
    this.store = store || AccountStore.getInstance();
  }

  public static getInstance(): AccountBalancer {
    if (!AccountBalancer.instance) {
      AccountBalancer.instance = new AccountBalancer();
    }
    return AccountBalancer.instance;
  }

  /**
   * Records that a session is using a specific account for a provider.
   */
  public recordSessionBinding(sessionId: string, provider: string, accountId: string): void {
    if (!sessionId) return;
    let providerMap = this.sessionBindings.get(sessionId);
    if (!providerMap) {
      providerMap = new Map();
      this.sessionBindings.set(sessionId, providerMap);
    }
    providerMap.set(provider, accountId);
  }

  /**
   * Retrieves the account currently in use (or selected via affinity & quota) for a session.
   */
  public getSessionAccount(
    provider: string,
    sessionId?: string,
    modelId?: string
  ): AccountCredential | undefined {
    const allAccounts = this.store.list(provider);
    const candidates = allAccounts.filter(
      (a) => !a.disabledCause && isAccountEligibleForModel(a, modelId)
    );
    if (candidates.length === 0) return undefined;

    const quotaManager = QuotaManager.getInstance();
    const evaluated = candidates.map((acc) => ({
      account: acc,
      health: quotaManager.evaluateAccountHealth(acc, modelId),
    }));

    const available = evaluated.filter((e) => !e.health.isExhausted);

    if (sessionId) {
      const boundId = this.sessionBindings.get(sessionId)?.get(provider);
      if (boundId) {
        const match = (available.length > 0 ? available : evaluated).find(
          (e) => e.account.id === boundId
        );
        if (match) return match.account;
      }
    }

    if (available.length > 0) {
      available.sort((a, b) => {
        // Prioritize unstarted accounts (0 usage, 0 timer elapsed) so their reset cycle begins
        if (a.health.isUnstarted && !b.health.isUnstarted) return -1;
        if (!a.health.isUnstarted && b.health.isUnstarted) return 1;
        return a.health.paceDelta - b.health.paceDelta;
      });
      return available[0].account;
    }

    evaluated.sort((a, b) => (a.health.resetTimeMs || 0) - (b.health.resetTimeMs || 0));
    return evaluated[0].account;
  }

  /**
   * Refreshes OAuth token for an account if expired or expiring soon.
   */
  public async ensureFreshToken(account: AccountCredential): Promise<string> {
    const now = Date.now();
    const isNearExpiry = account.expires && now + EXPIRY_BUFFER_MS >= account.expires;

    if (account.type === "api_key" && account.apiKey) {
      return account.apiKey;
    }

    if (!isNearExpiry && account.access) {
      return account.access;
    }

    if (!account.refresh) {
      if (account.access) return account.access;
      throw new Error(`Account ${account.id} has no valid access or refresh token.`);
    }

    // Refresh according to provider
    if (account.provider === "google-antigravity") {
      if (!account.projectId && account.access) {
        try {
          account.projectId = await discoverProject(account.access);
          account.updatedAt = Date.now();
          this.store.upsert(account);
        } catch {
          // Ignore
        }
      }

      if (!isNearExpiry && account.access) {
        return account.access;
      }

      try {
        const refreshed = await refreshAntigravityToken({
          refresh: account.refresh,
          access: account.access || "",
          expires: account.expires || 0,
          projectId: account.projectId,
          email: account.email,
        });
        account.access = refreshed.access;
        account.expires = refreshed.expires;
        if (refreshed.projectId) account.projectId = refreshed.projectId;
        account.updatedAt = Date.now();
        this.store.upsert(account);
        return refreshed.access;
      } catch (err) {
        console.error(`[AccountBalancer] Antigravity token refresh failed for ${account.id}:`, err);
        if (account.access) return account.access;
        throw err;
      }
    } else if (account.provider === "openai-codex") {
      try {
        const baseCodex = builtinProviders().find((p) => p.id === "openai-codex");
        if (baseCodex?.auth.oauth?.refresh) {
          const cred = await baseCodex.auth.oauth.refresh(
            {
              type: "oauth",
              access: account.access || "",
              refresh: account.refresh,
              expires: account.expires || 0,
            },
            new AbortController().signal
          );
          if (cred && cred.access) {
            account.access = cred.access;
            if (cred.refresh) account.refresh = cred.refresh;
            account.expires = cred.expires;
            account.updatedAt = Date.now();
            this.store.upsert(account);
            return cred.access;
          }
        }
      } catch (err) {
        console.error(`[AccountBalancer] OpenAI Codex token refresh failed for ${account.id}:`, err);
        if (account.access) return account.access;
        throw err;
      }
    }

    if (account.provider === "hyper") {
      if (account.type === "api_key" || account.apiKey) {
        return account.apiKey || account.access || "";
      }
      if (account.refresh && (!account.expires || account.expires - Date.now() < EXPIRY_BUFFER_MS)) {
        try {
          const cred = await refreshHyperToken(
            {
              access: account.access || "",
              refresh: account.refresh,
              expires: account.expires || Date.now() + 3600 * 1000,
            },
            new AbortController().signal
          );
          if (cred && cred.access) {
            account.access = cred.access;
            if (cred.refresh) account.refresh = cred.refresh;
            account.expires = cred.expires;
            account.updatedAt = Date.now();
            this.store.upsert(account);
            return cred.access;
          }
        } catch (err) {
          console.error(`[AccountBalancer] Charm Hyper token refresh failed for ${account.id}:`, err);
          if (account.access) return account.access;
          throw err;
        }
      }
      if (account.access) return account.access;
      if (account.apiKey) return account.apiKey;
    }

    if (account.access) return account.access;
    if (account.apiKey) return account.apiKey;
    throw new Error(`Cannot refresh token for provider ${account.provider}`);
  }

  /**
   * Selects an optimal account for a request based on session affinity, 429 status,
   * and pre-emptive quota ranking (preferring accounts with lowest % used).
   */
  public async selectAccount(
    provider: string,
    sessionId?: string,
    excludedAccountIds: string[] = [],
    modelId?: string
  ): Promise<ResolvedAccountAuth | null> {
    const allAccounts = this.store.list(provider);
    if (allAccounts.length === 0) {
      return null;
    }

    // Filter out disabled accounts, excluded accounts, and accounts not eligible for model
    const candidates = allAccounts.filter(
      (acc) =>
        !acc.disabledCause &&
        !excludedAccountIds.includes(acc.id) &&
        isAccountEligibleForModel(acc, modelId)
    );

    if (candidates.length === 0) {
      return null;
    }

    const quotaManager = QuotaManager.getInstance();

    // Preemptive quota check: fetch live quota for candidates lacking cached reports
    await Promise.allSettled(
      candidates.map(async (acc) => {
        if (!quotaManager.getReport(acc.id)) {
          const token = acc.access || acc.apiKey;
          if (token) {
            try {
              await quotaManager.ensureFreshQuota(acc, token, AbortSignal.timeout(3000));
            } catch {
              // Ignore background timeout/error
            }
          }
        }
      })
    );

    const evaluated = candidates.map((acc) => ({
      account: acc,
      health: quotaManager.evaluateAccountHealth(acc, modelId),
    }));

    // Filter out accounts that are exhausted (either on 429 cooldown or 100% quota consumed)
    const available = evaluated.filter((e) => !e.health.isExhausted);

    // If all eligible accounts are exhausted, return null so caller immediately reports cooldown/reset
    if (available.length === 0) {
      return null;
    }

    let chosen: AccountCredential;

    // Check if session already has a bound account that remains healthy and eligible
    let sessionBoundAccount: AccountCredential | undefined;
    if (sessionId) {
      const boundId = this.sessionBindings.get(sessionId)?.get(provider);
      if (boundId) {
        const match = available.find((e) => e.account.id === boundId);
        if (match) {
          sessionBoundAccount = match.account;
        }
      }
    }

    if (sessionBoundAccount) {
      // Retain prompt-cache session affinity as long as account is healthy
      chosen = sessionBoundAccount;
    } else {
      // Pick unstarted accounts first (0 usage, unstarted timer) so their reset window begins,
      // otherwise pick the account furthest under budget (lowest pace delta).
      available.sort((a, b) => {
        if (a.health.isUnstarted && !b.health.isUnstarted) return -1;
        if (!a.health.isUnstarted && b.health.isUnstarted) return 1;
        return a.health.paceDelta - b.health.paceDelta;
      });
      chosen = available[0].account;
      if (sessionId) {
        this.recordSessionBinding(sessionId, provider, chosen.id);
      }
    }

    const token = await this.ensureFreshToken(chosen);

    // Keep quota fresh in background for chosen account
    void quotaManager.ensureFreshQuota(chosen, token).catch(() => {});

    return {
      account: chosen,
      token,
    };
  }

  /**
   * Marks an account as blocked with a cooldown.
   */
  public markRateLimited(accountId: string, cooldownMs?: number, reason?: string): void {
    const cooldown = cooldownMs || DEFAULT_COOLDOWN_MS;
    this.store.setBlocked(accountId, cooldown, reason || "Rate limited (429)");
  }
}
