import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { fetchAntigravityUsage } from "./antigravity.js";
import { fetchCodexUsage } from "./codex.js";
import { formatUsageText } from "./format.js";
import type { ProviderUsageReport } from "./types.js";

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

/**
 * Loads all configured credentials from ~/.pi/agent/auth.json.
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
 * Fetches usage reports for all active logged-in providers.
 */
export async function collectUsageReports(signal?: AbortSignal): Promise<ProviderUsageReport[]> {
  const authMap = loadConfiguredAuth();
  const reports: ProviderUsageReport[] = [];

  // 1. Google Antigravity
  const antigravity = authMap["google-antigravity"];
  if (antigravity?.access && antigravity.projectId) {
    const report = await fetchAntigravityUsage(
      antigravity.access,
      antigravity.projectId,
      antigravity.email,
      signal
    );
    reports.push(report);
  }

  // 2. OpenAI Codex
  const codex = authMap["openai-codex"];
  if (codex?.access && !reports.some((r) => r.providerId === "openai-codex")) {
    const report = await fetchCodexUsage({
      accessToken: codex.access,
      accountId: codex.accountId,
      email: codex.email,
      refreshToken: codex.refresh,
      signal,
    });
    reports.push(report);
  } else if (codex && !reports.some((r) => r.providerId === "openai-codex")) {
    reports.push({
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      accountEmail: codex.email,
      fetchedAt: Date.now(),
      groups: [],
      error: "Missing access token",
    });
  }

  return reports;
}

/**
 * Renders the usage breakdown in a full TUI dialog.
 */
async function showUsageTui(reports: ProviderUsageReport[], ctx: ExtensionCommandContext): Promise<void> {
  const formatted = formatUsageText(reports);

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
        }
      },
    };
  });
}

/**
 * Registers the /usage command in Pi.
 */
export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Show quota and usage for currently logged-in providers",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.hasUI) {
        ctx.ui.notify("Fetching provider usage...", "info");
      }

      const reports = await collectUsageReports();

      if (reports.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify("No logged-in providers found with usage support.", "warning");
        } else {
          console.log("No logged-in providers found with usage support.");
        }
        return;
      }

      if (ctx.hasUI && ctx.mode === "tui") {
        await showUsageTui(reports, ctx);
      } else {
        console.log(formatUsageText(reports));
      }
    },
  });
}
