import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Credential, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "../accounts/store.js";
import { executeWithMultiAccountFailover } from "../accounts/wrapper.js";
import {
  DEFAULT_FALLBACK_FREE_MODELS,
  fetchLiveCodexCatalog,
  loadCachedCatalog,
} from "./catalog.js";
import { getCodexAccountId, getCodexPlanType } from "./plan.js";

/**
 * Reads stored openai-codex credentials directly from ~/.pi/agent/auth.json or AccountStore.
 */
function getStoredCodexCredential(): { access?: string; accountId?: string } | null {
  const store = AccountStore.getInstance();
  const active = store.getActive("openai-codex");
  if (active?.access) {
    return {
      access: active.access,
      accountId: active.accountId || (getCodexAccountId(active.access) ?? undefined),
    };
  }

  const authPath = join(homedir(), ".pi/agent/auth.json");
  if (!existsSync(authPath)) return null;
  try {
    const raw = readFileSync(authPath, "utf-8");
    const parsed = JSON.parse(raw);
    const cred = parsed?.["openai-codex"];
    if (cred && typeof cred === "object" && typeof cred.access === "string") {
      return {
        access: cred.access,
        accountId: typeof cred.accountId === "string" ? cred.accountId : getCodexAccountId(cred.access) ?? undefined,
      };
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Registers the OpenAI Codex dynamic plan filter provider with multi-account failover.
 */
export function registerCodexFilter(pi: ExtensionAPI): void {
  const baseCodex = builtinProviders().find((p) => p.id === "openai-codex");
  if (!baseCodex) {
    return;
  }

  // Kick off a non-blocking background catalog refresh if credentials already exist
  const stored = getStoredCodexCredential();
  if (stored?.access && stored.accountId) {
    void fetchLiveCodexCatalog(stored.access, stored.accountId).catch(() => {
      // Ignore background network failure on startup
    });
  }

  // Wrap baseCodex provider with dynamic filterModels, refreshModels, and multi-account streamSimple
  const filteredCodexProvider: Provider = {
    ...baseCodex,

    filterModels(
      models: readonly Model<Api>[],
      credential?: Credential
    ): readonly Model<Api>[] {
      const store = AccountStore.getInstance();
      const accounts = store.list("openai-codex").filter((a) => !a.disabledCause);

      const tokens: string[] = [];
      if (credential && credential.type === "oauth" && credential.access) {
        tokens.push(credential.access);
      }
      for (const a of accounts) {
        if (a.access && !tokens.includes(a.access)) {
          tokens.push(a.access);
        }
      }

      if (tokens.length === 0) {
        return models;
      }

      const plans = new Set<string>();
      for (const t of tokens) {
        const p = getCodexPlanType(t);
        if (p) plans.add(p);
      }

      if (plans.size === 0) {
        return models;
      }

      const catalog = loadCachedCatalog();
      if (catalog && catalog.length > 0) {
        const allowedSlugs = new Set(
          catalog
            .filter((m) => m.availableInPlans.some((plan) => plans.has(plan)))
            .map((m) => m.slug)
        );
        return models.filter((m) => allowedSlugs.has(m.id));
      }

      // Fallback if catalog has not been cached yet
      if (plans.size === 1 && plans.has("free")) {
        return models.filter((m) => DEFAULT_FALLBACK_FREE_MODELS.includes(m.id));
      }

      return models;
    },

    async refreshModels(context) {
      if (baseCodex.refreshModels) {
        await baseCodex.refreshModels(context);
      }
      let access = context.credential?.type === "oauth" ? context.credential.access : undefined;
      if (!access) {
        const active = AccountStore.getInstance().getActive("openai-codex");
        access = active?.access;
      }
      if (access) {
        const accountId =
          getCodexAccountId(access) ||
          (context.credential as { accountId?: string })?.accountId;
        if (accountId) {
          try {
            await fetchLiveCodexCatalog(access, accountId, context.signal);
          } catch {
            // Ignore refresh errors
          }
        }
      }
    },

    streamSimple(model: Model<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions) {
      return executeWithMultiAccountFailover(
        "openai-codex",
        model,
        transcript,
        options,
        (m, ctx, opts, resolvedAuth) => {
          return baseCodex.streamSimple(m, ctx, {
            ...opts,
            apiKey: resolvedAuth.token,
          });
        }
      );
    },
  };

  pi.registerProvider(filteredCodexProvider);
}
