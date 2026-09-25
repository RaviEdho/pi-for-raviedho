import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { AccountBalancer } from "../accounts/balancer.js";
import { QuotaManager } from "../accounts/quota.js";
import { AccountStore } from "../accounts/store.js";
import { fetchAntigravityUsage } from "./antigravity.js";
import { fetchCodexUsage } from "./codex.js";
import { formatUsageText } from "./format.js";
import { fetchHyperUsage } from "./hyper.js";
import type { ProviderUsageReport, SessionUsageInfo } from "./types.js";

interface StoredAuthEntry {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
  projectId?: string;
  email?: string;
  accountId?: string;
}

export interface CollectUsageOptions {
  signal?: AbortSignal;
  sessionId?: string;
  currentProvider?: string;
  currentModelId?: string;
}

export interface CollectUsageResult {
  reports: ProviderUsageReport[];
  sessionInfo?: SessionUsageInfo;
}

/**
 * Loads all configured credentials from ~/.pi/agent/auth.json as fallback.
 */
function loadConfiguredAuth(): Record<string, StoredAuthEntry> {
  const authPath = join(homedir(), ".pi/agent/auth.json");
  if (!existsSync(authPath)) return {};
  try {
    const raw = readFileSync(authPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, StoredAuthEntry>;
    }
  } catch {
    // Ignore read errors
  }
  return {};
}

/**
 * Fetches usage reports for all active and standby accounts across providers,
 * identifying the account in use for the current session.
 */
export async function collectUsageReports(
  options?: CollectUsageOptions
): Promise<CollectUsageResult> {
  const store = AccountStore.getInstance();
  store.sync();
  const balancer = AccountBalancer.getInstance();
  const reports: ProviderUsageReport[] = [];
  const signal = options?.signal;

  const antigravityAccounts = store.list("google-antigravity");
  const codexAccounts = store.list("openai-codex");
  const hyperAccounts = store.list("hyper");

  // 1. Google Antigravity multi-account fetch in parallel
  const antigravityPromises: Promise<ProviderUsageReport>[] = [];
  if (antigravityAccounts.length > 0) {
    const sessionAccount = balancer.getSessionAccount(
      "google-antigravity",
      options?.sessionId,
      options?.currentModelId
    );
    for (const acc of antigravityAccounts) {
      if (signal?.aborted) break;
      const isSession = sessionAccount?.id === acc.id;
      const isCooldown = acc.blockedUntil && acc.blockedUntil > Date.now();
      const mins = isCooldown ? Math.max(1, Math.ceil((acc.blockedUntil! - Date.now()) / 60000)) : 0;
      const cooldownTag = isCooldown ? ` [COOLDOWN ~${mins}m]` : "";
      const label = `${acc.email || acc.id}${cooldownTag}`;

      antigravityPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          try {
            const token = await balancer.ensureFreshToken(acc);
            const report = await fetchAntigravityUsage(
              token,
              acc.projectId || "aicode-consumers",
              label,
              signal,
              acc.planType
            );
            report.isSessionAccount = isSession;
            report.accountId = acc.id;
            if (report.planType && report.planType !== acc.planType) {
              acc.planType = report.planType;
              acc.updatedAt = Date.now();
              store.upsert(acc);
            }
            QuotaManager.getInstance().setReport(acc.id, report);
            return report;
          } catch (err) {
            return {
              providerId: "google-antigravity",
              providerName: "Google Antigravity",
              accountEmail: label,
              accountId: acc.id,
              isSessionAccount: isSession,
              planType: acc.planType,
              fetchedAt: Date.now(),
              groups: [],
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })()
      );
    }
  } else {
    // Fallback to auth.json
    const authMap = loadConfiguredAuth();
    const antigravity = authMap["google-antigravity"];
    if (antigravity?.access && antigravity.projectId) {
      antigravityPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          const report = await fetchAntigravityUsage(
            antigravity.access!,
            antigravity.projectId!,
            antigravity.email,
            signal
          );
          report.isSessionAccount = true;
          return report;
        })()
      );
    }
  }

  // 2. OpenAI Codex multi-account fetch in parallel
  const codexPromises: Promise<ProviderUsageReport>[] = [];
  if (codexAccounts.length > 0) {
    const sessionAccount = balancer.getSessionAccount(
      "openai-codex",
      options?.sessionId,
      options?.currentModelId
    );
    for (const acc of codexAccounts) {
      if (signal?.aborted) break;
      const isSession = sessionAccount?.id === acc.id;
      const isCooldown = acc.blockedUntil && acc.blockedUntil > Date.now();
      const mins = isCooldown ? Math.max(1, Math.ceil((acc.blockedUntil! - Date.now()) / 60000)) : 0;
      const cooldownTag = isCooldown ? ` [COOLDOWN ~${mins}m]` : "";
      const label = `${acc.email || acc.accountId || acc.id}${cooldownTag}`;

      codexPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          try {
            const token = await balancer.ensureFreshToken(acc);
            const report = await fetchCodexUsage({
              accessToken: token,
              accountId: acc.accountId,
              email: label,
              refreshToken: acc.refresh,
              signal,
            });
            report.isSessionAccount = isSession;
            report.accountId = acc.id;
            QuotaManager.getInstance().setReport(acc.id, report);
            return report;
          } catch (err) {
            return {
              providerId: "openai-codex",
              providerName: "OpenAI Codex",
              accountEmail: label,
              accountId: acc.id,
              isSessionAccount: isSession,
              planType: acc.planType,
              fetchedAt: Date.now(),
              groups: [],
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })()
      );
    }
  } else {
    // Fallback to auth.json
    const authMap = loadConfiguredAuth();
    const codex = authMap["openai-codex"];
    if (codex?.access) {
      codexPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          const report = await fetchCodexUsage({
            accessToken: codex.access!,
            accountId: codex.accountId,
            email: codex.email,
            refreshToken: codex.refresh,
            signal,
          });
          report.isSessionAccount = true;
          return report;
        })()
      );
    }
  }

  // 3. Charm Hyper multi-account fetch in parallel
  const hyperPromises: Promise<ProviderUsageReport>[] = [];
  if (hyperAccounts.length > 0) {
    const sessionAccount = balancer.getSessionAccount(
      "hyper",
      options?.sessionId,
      options?.currentModelId
    );
    for (const acc of hyperAccounts) {
      if (signal?.aborted) break;
      const isSession = sessionAccount?.id === acc.id;
      const isCooldown = acc.blockedUntil && acc.blockedUntil > Date.now();
      const mins = isCooldown ? Math.max(1, Math.ceil((acc.blockedUntil! - Date.now()) / 60000)) : 0;
      const cooldownTag = isCooldown ? ` [COOLDOWN ~${mins}m]` : "";
      const label = `${acc.email || acc.orgName || acc.id}${cooldownTag}`;

      hyperPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          try {
            const token = await balancer.ensureFreshToken(acc);
            const report = await fetchHyperUsage(
              token,
              label,
              signal,
              acc.planType
            );
            report.isSessionAccount = isSession;
            report.accountId = acc.id;
            QuotaManager.getInstance().setReport(acc.id, report);
            return report;
          } catch (err) {
            return {
              providerId: "hyper",
              providerName: "Charm Hyper",
              accountEmail: label,
              accountId: acc.id,
              isSessionAccount: isSession,
              planType: acc.planType,
              fetchedAt: Date.now(),
              groups: [],
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })()
      );
    }
  } else {
    // Fallback to auth.json or HYPER_API_KEY
    const authMap = loadConfiguredAuth();
    const hyperAuth = authMap["hyper"];
    const fallbackToken = hyperAuth?.access || hyperAuth?.key || process.env.HYPER_API_KEY;
    if (fallbackToken) {
      hyperPromises.push(
        (async (): Promise<ProviderUsageReport> => {
          const report = await fetchHyperUsage(
            fallbackToken,
            hyperAuth?.email || "default",
            signal
          );
          report.isSessionAccount = true;
          return report;
        })()
      );
    }
  }

  // Await all provider account queries concurrently
  const settled = await Promise.allSettled([
    ...antigravityPromises,
    ...codexPromises,
    ...hyperPromises,
  ]);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      reports.push(s.value);
    }
  }

  // Compute active session account info
  let sessionInfo: SessionUsageInfo | undefined;
  if (options?.currentProvider) {
    const account = balancer.getSessionAccount(
      options.currentProvider,
      options.sessionId,
      options.currentModelId
    );
    sessionInfo = {
      sessionId: options.sessionId,
      providerId: options.currentProvider,
      modelId: options.currentModelId,
      accountEmail: account?.email || account?.accountId || account?.id,
      accountId: account?.id,
    };
  }

  return { reports, sessionInfo };
}

/**
 * Renders the usage breakdown in a full TUI dialog, displaying in-modal loading state without polluting scrollback.
 */
async function showUsageTui(ctx: ExtensionCommandContext): Promise<void> {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const currentModel = ctx.model;
  const currentProvider = currentModel?.provider;
  const currentModelId = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;

  const abortController = new AbortController();

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let loading = true;
    let errorMsg: string | undefined;
    let reports: ProviderUsageReport[] = [];
    let sessionInfo: SessionUsageInfo | undefined;

    collectUsageReports({
      signal: abortController.signal,
      sessionId,
      currentProvider,
      currentModelId,
    })
      .then((res) => {
        loading = false;
        reports = res.reports;
        sessionInfo = res.sessionInfo;
        tui.requestRender();
      })
      .catch((err) => {
        if (!abortController.signal.aborted) {
          loading = false;
          errorMsg = err instanceof Error ? err.message : String(err);
          tui.requestRender();
        }
      });

    return {
      render: (width: number) => {
        const container = new Container();
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));

        container.addChild(border);
        container.addChild(new Text(theme.fg("accent", theme.bold("  Provider Usage & Quotas")), 1, 0));
        container.addChild(new Text("", 0, 0));

        if (loading) {
          container.addChild(new Text(theme.fg("dim", "  ⏳ Fetching provider quotas..."), 1, 0));
          container.addChild(new Text("", 0, 0));
          container.addChild(new Text(theme.fg("dim", "  Press Esc or q to cancel"), 1, 0));
        } else if (errorMsg) {
          container.addChild(new Text(theme.fg("error", `  Failed to fetch usage: ${errorMsg}`), 1, 0));
          container.addChild(new Text("", 0, 0));
          container.addChild(new Text(theme.fg("dim", "  Press Enter, Esc, or q to close"), 1, 0));
        } else if (reports.length === 0) {
          container.addChild(new Text(theme.fg("warning", "  No active provider accounts found to report usage for."), 1, 0));
          container.addChild(new Text("", 0, 0));
          container.addChild(new Text(theme.fg("dim", "  Press Enter, Esc, or q to close"), 1, 0));
        } else {
          const formatted = formatUsageText(reports, { sessionInfo });
          for (const line of formatted.split("\n")) {
            container.addChild(new Text(`  ${line}`, 0, 0));
          }
          container.addChild(new Text("", 0, 0));
          container.addChild(new Text(theme.fg("dim", "  Press Enter, Esc, or q to close"), 1, 0));
        }

        container.addChild(border);
        return container.render(width);
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape") || data === "q") {
          abortController.abort();
          done(undefined);
          return true;
        }
        return false;
      },
    };
  });
}

/**
 * Registers the /usage command with Pi.
 */
export { registerUsageFooter } from "./footer.js";
export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Display provider quota and rate limit status across all configured accounts",
    handler: async (_args, ctx) => {
      if (ctx.hasUI && ctx.mode === "tui") {
        await showUsageTui(ctx);
      } else {
        const sessionId = ctx.sessionManager?.getSessionId?.();
        const currentModel = ctx.model;
        const currentProvider = currentModel?.provider;
        const currentModelId = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;

        try {
          const result = await collectUsageReports({
            signal: ctx.signal,
            sessionId,
            currentProvider,
            currentModelId,
          });
          if (result.reports.length === 0) {
            console.log("No active provider accounts found to report usage for.");
            return;
          }
          const text = formatUsageText(result.reports, { sessionInfo: result.sessionInfo });
          console.log(text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed to fetch usage reports: ${msg}`);
        }
      }
    },
  });
}
