import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Credential, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_FALLBACK_FREE_MODELS,
  fetchLiveCodexCatalog,
  loadCachedCatalog,
} from "./catalog.js";
import { getCodexAccountId, getCodexPlanType } from "./plan.js";

/**
 * Reads stored openai-codex credentials directly from ~/.pi/agent/auth.json if present.
 */
function getStoredCodexCredential(): { access?: string; accountId?: string } | null {
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
 * Registers the OpenAI Codex dynamic plan filter provider and helper command.
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

  // Wrap baseCodex provider with dynamic filterModels and refreshModels
  const filteredCodexProvider: Provider = {
    ...baseCodex,

    filterModels(
      models: readonly Model<Api>[],
      credential?: Credential
    ): readonly Model<Api>[] {
      if (!credential || credential.type !== "oauth" || !credential.access) {
        return models;
      }

      const plan = getCodexPlanType(credential.access);
      if (!plan) {
        return models;
      }

      const catalog = loadCachedCatalog();
      if (catalog && catalog.length > 0) {
        const allowedSlugs = new Set(
          catalog
            .filter((m) => m.availableInPlans.includes(plan))
            .map((m) => m.slug)
        );
        return models.filter((m) => allowedSlugs.has(m.id));
      }

      // Fallback if catalog has not been cached yet
      if (plan === "free") {
        return models.filter((m) => DEFAULT_FALLBACK_FREE_MODELS.includes(m.id));
      }

      return models;
    },

    async refreshModels(context) {
      if (baseCodex.refreshModels) {
        await baseCodex.refreshModels(context);
      }
      if (context.credential?.type === "oauth" && context.credential.access) {
        const accountId =
          getCodexAccountId(context.credential.access) ||
          (context.credential as { accountId?: string }).accountId;
        if (accountId) {
          try {
            await fetchLiveCodexCatalog(context.credential.access, accountId, context.signal);
          } catch {
            // Ignore refresh errors
          }
        }
      }
    },
  };

  pi.registerProvider(filteredCodexProvider);

  // Register command to inspect the current detected Codex tier and model availability
  pi.registerCommand("codex-plan", {
    description: "Check your OpenAI Codex account plan tier and model availability",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const cred = getStoredCodexCredential();
      if (!cred?.access) {
        ctx.ui.notify("No OpenAI Codex account logged in. Use /login openai-codex first.", "warning");
        return;
      }

      const plan = getCodexPlanType(cred.access) || "unknown";
      const accountId = cred.accountId || getCodexAccountId(cred.access) || "unknown";

      let catalog = loadCachedCatalog();
      if ((!catalog || catalog.length === 0) && cred.accountId) {
        try {
          catalog = await fetchLiveCodexCatalog(cred.access, cred.accountId);
        } catch {
          // Keep empty if failed
        }
      }

      const lines: string[] = [];
      lines.push(`Plan Tier:   ${plan.toUpperCase()}`);
      lines.push(`Account ID:  ${accountId}`);
      lines.push("");

      if (catalog && catalog.length > 0) {
        const available = catalog.filter((m) => m.availableInPlans.includes(plan));
        const restricted = catalog.filter((m) => !m.availableInPlans.includes(plan));

        lines.push(`Available in ${plan.toUpperCase()} tier (${available.length}):`);
        for (const m of available) {
          lines.push(`  ✓ ${m.slug.padEnd(20)} (${m.displayName})`);
        }

        if (restricted.length > 0) {
          lines.push("");
          lines.push(`Restricted models (requires upgrade to Plus/Pro):`);
          for (const m of restricted) {
            lines.push(`  ✗ ${m.slug.padEnd(20)} (${m.displayName})`);
          }
        }
      } else {
        lines.push("Live catalog could not be fetched. Using default free-tier whitelist.");
      }

      if (ctx.hasUI && ctx.mode === "tui") {
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        console.log(lines.join("\n"));
      }
    },
  });
}
