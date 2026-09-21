import type { ProviderUsageReport, SessionUsageInfo } from "./types.js";

/**
 * Formats an ISO 8601 timestamp into a compact relative string like "1d22h", "3h46m", or "12m".
 */
export function formatRelativeTime(isoString?: string, now = Date.now()): string {
  if (!isoString) return "unknown";
  const target = new Date(isoString).getTime();
  const diffMs = Math.max(0, target - now);
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/**
 * Creates a block progress bar like ████████████░░░░░░░░░░░░░░░░.
 */
export function makeProgressBar(usedFraction: number, width = 28): string {
  const clamped = Math.max(0, Math.min(1, usedFraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Formats usage reports into styled terminal text matching omp's layout,
 * including session-bound account indications.
 */
export function formatUsageText(
  reports: ProviderUsageReport[],
  options?: { now?: number; sessionInfo?: SessionUsageInfo; colorize?: boolean }
): string {
  const now = options?.now ?? Date.now();
  const lines: string[] = [];

  // Session context header if available
  if (options?.sessionInfo && (options.sessionInfo.accountEmail || options.sessionInfo.modelId)) {
    const sessionParts: string[] = [];
    if (options.sessionInfo.sessionId) {
      sessionParts.push(`session: ${options.sessionInfo.sessionId.slice(0, 8)}...`);
    }
    if (options.sessionInfo.modelId) {
      sessionParts.push(`model: ${options.sessionInfo.modelId}`);
    }
    if (options.sessionInfo.accountEmail) {
      sessionParts.push(`account: ${options.sessionInfo.accountEmail}`);
    }
    lines.push(`Active Session · ${sessionParts.join(" · ")}`);
    lines.push("");
  }

  const earliestFetch = reports.reduce((acc, r) => Math.min(acc, r.fetchedAt), now);
  const ageMs = Math.max(0, now - earliestFetch);
  const ageText = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;

  lines.push(`Usage · fetched ${ageText} ago`);
  lines.push("");

  const byProvider = new Map<string, ProviderUsageReport[]>();
  for (const report of reports) {
    const list = byProvider.get(report.providerName) || [];
    list.push(report);
    byProvider.set(report.providerName, list);
  }

  for (const [providerName, providerReports] of byProvider.entries()) {
    lines.push(`${providerName} — ${providerReports.length} account${providerReports.length === 1 ? "" : "s"}`);

    for (const report of providerReports) {
      const marker = report.isSessionAccount ? "●" : "○";
      const accountLabel = report.accountEmail ?? (report.planType ? "OAuth account" : undefined);

      if (accountLabel) {
        let header = `  ${marker} ${accountLabel}`;
        if (report.planType) {
          header += ` · plan: ${report.planType}`;
        }
        if (report.resetCredits && report.resetCredits > 0) {
          header += ` · ✦ ${report.resetCredits} saved reset${report.resetCredits === 1 ? "" : "s"}`;
        }
        lines.push(header);
      }

      if (report.error) {
        lines.push(`      Could not fetch usage: ${report.error}`);
        lines.push("");
        continue;
      }

      // Collect all buckets to determine column alignment
      const allBuckets = report.groups.flatMap((g) => g.buckets);
      if (allBuckets.length === 0) {
        lines.push("      No active quota limits reported.");
        lines.push("");
        continue;
      }

      const maxLabelLength = allBuckets.reduce(
        (max, b) => Math.max(max, `● ${b.displayName}`.length),
        0
      );
      const labelWidth = Math.max(30, maxLabelLength + 2);

      for (const bucket of allBuckets) {
        const label = `● ${bucket.displayName}`.padEnd(labelWidth, " ");
        const bar = makeProgressBar(bucket.usedFraction, 28);
        const percentStr = `${(bucket.usedFraction * 100).toFixed(1)}% used`.padStart(10, " ");
        const resetStr = bucket.resetTime ? ` · resets in ${formatRelativeTime(bucket.resetTime, now)}` : "";

        lines.push(`      ${label}  ${bar}  ${percentStr}${resetStr}`);
      }

      lines.push("");
    }
  }

  return lines.join("\n");
}
