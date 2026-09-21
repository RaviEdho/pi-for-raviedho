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

  // 1. Google Antigravity multi-account fetch
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
      const statusTag = isCooldown
        ? `[COOLDOWN ~${mins}m]`
        : isSession
        ? "(Active)"
        : "(Standby)";
      const label = `${acc.email || acc.id} ${statusTag}`;

      try {
        const token = await balancer.ensureFreshToken(acc);
        const report = await fetchAntigravityUsage(
          token,
          acc.projectId || "aicode-consumers",
          label,
          signal
        );
        report.isSessionAccount = isSession;
        report.accountId = acc.id;
        QuotaManager.getInstance().setReport(acc.id, report);
        reports.push(report);
      } catch (err) {
        reports.push({
          providerId: "google-antigravity",
          providerName: "Google Antigravity",
          accountEmail: acc.email || acc.id,
          accountId: acc.id,
          isSessionAccount: isSession,
          fetchedAt: Date.now(),
          groups: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    // Fallback to auth.json
    const authMap = loadConfiguredAuth();
    const antigravity = authMap["google-antigravity"];
    if (antigravity?.access && antigravity.projectId) {
      const report = await fetchAntigravityUsage(
        antigravity.access,
        antigravity.projectId,
        antigravity.email,
        signal
      );
      report.isSessionAccount = true;
      reports.push(report);
    }
  }

  // 2. OpenAI Codex multi-account fetch
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
      const statusTag = isCooldown
        ? `[COOLDOWN ~${mins}m]`
        : isSession
        ? "(Active)"
        : "(Standby)";
      const label = `${acc.email || acc.accountId || acc.id} ${statusTag}`;

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
        reports.push(report);
      } catch (err) {
        reports.push({
          providerId: "openai-codex",
          providerName: "OpenAI Codex",
          accountEmail: acc.email || acc.accountId || acc.id,
          accountId: acc.id,
          isSessionAccount: isSession,
          fetchedAt: Date.now(),
          groups: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    // Fallback to auth.json
    const authMap = loadConfiguredAuth();
    const codex = authMap["openai-codex"];
    if (codex?.access) {
      const report = await fetchCodexUsage({
        accessToken: codex.access,
        accountId: codex.accountId,
        email: codex.email,
        refreshToken: codex.refresh,
        signal,
      });
      report.isSessionAccount = true;
      reports.push(report);
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
 * Renders the usage breakdown in a full TUI dialog.
 */
async function showUsageTui(
  reports: ProviderUsageReport[],
  sessionInfo: SessionUsageInfo | undefined,
  ctx: ExtensionCommandContext
): Promise<void> {
  const formatted = formatUsageText(reports, { sessionInfo });

  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));

    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold("  Provider Usage & Quotas")), 1, 0));
    container.addChild(new Text("", 0, 0));

    for (const line of formatted.split("\n")) {
      container.addChild(new Text(`  ${line}`, 0, 0));
    }

    container.addChild(new Text("", 0, 0));
    container.addChild(new Text(theme.fg("dim", "  Press Enter, Esc, or q to close"), 1, 0));
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape") || data === "q") {
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
export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Display provider quota and rate limit status across all configured accounts",
    handler: async (_args, ctx) => {
      let result: CollectUsageResult;

      if (ctx.hasUI) {
        ctx.ui.notify("Fetching provider quota usage...", "info");
      }

      const sessionId = ctx.sessionManager?.getSessionId?.();
      const currentModel = ctx.model;
      const currentProvider = currentModel?.provider;
      const currentModelId = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;

      try {
        result = await collectUsageReports({
          signal: ctx.signal,
          sessionId,
          currentProvider,
          currentModelId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to fetch usage reports: ${msg}`, "error");
        return;
      }

      if (result.reports.length === 0) {
        ctx.ui.notify("No active provider accounts found to report usage for.", "warning");
        return;
      }

      if (ctx.hasUI && ctx.mode === "tui") {
        await showUsageTui(result.reports, result.sessionInfo, ctx);
      } else {
        const text = formatUsageText(result.reports, { sessionInfo: result.sessionInfo });
        console.log(text);
      }
    },
  });
}
