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
 * Computes the fraction of time elapsed in the current rate limit window (0.0 to 1.0).
 * For unused buckets (usedFraction === 0), the timer has not started ticking, so 0.0 is returned.
 */
export function computeTimeElapsedFraction(
  resetTimeIso?: string,
  windowSeconds?: number,
  now = Date.now(),
  usedFraction?: number
): number | undefined {
  if (!resetTimeIso || !windowSeconds || windowSeconds <= 0) return undefined;
  if (usedFraction !== undefined && usedFraction <= 0) return 0.0;

  const resetMs = new Date(resetTimeIso).getTime();
  if (Number.isNaN(resetMs)) return undefined;
  const remainingMs = resetMs - now;
  const windowMs = windowSeconds * 1000;
  // Clamp remaining time to [0, windowMs] to protect against slight clock skews
  const clampedRemainingMs = Math.max(0, Math.min(windowMs, remainingMs));
  const elapsedMs = windowMs - clampedRemainingMs;
  return Math.max(0, Math.min(1, elapsedMs / windowMs));
}

/**
 * Creates a block progress bar like ████████░░░░┃░░░░░░░░░░░░░
 * with a bold vertical bar ┃ indicating current time/reset cycle progress.
 */
export function makeProgressBar(
  usedFraction: number,
  width = 28,
  timeElapsedFraction?: number
): string {
  const clampedUsed = Math.max(0, Math.min(1, usedFraction));
  const usedSlots = Math.round(clampedUsed * width);

  let markerIndex: number | undefined;
  if (timeElapsedFraction !== undefined && !Number.isNaN(timeElapsedFraction)) {
    const clampedTime = Math.max(0, Math.min(1, timeElapsedFraction));
    markerIndex = Math.min(width - 1, Math.max(0, Math.floor(clampedTime * width)));
  }

  let bar = "";
  for (let i = 0; i < width; i++) {
    if (markerIndex !== undefined && i === markerIndex) {
      bar += "┃";
    } else if (i < usedSlots) {
      bar += "█";
    } else {
      bar += "░";
    }
  }

  return bar;
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
        let content = `${marker} ${accountLabel}`;
        if (report.planType) {
          content += ` · plan: ${report.planType}`;
        }
        if (report.resetCredits && report.resetCredits > 0) {
          content += ` · ✦ ${report.resetCredits} saved reset${report.resetCredits === 1 ? "" : "s"}`;
        }
        if (report.isSessionAccount) {
          content = `\x1b[1m${content}\x1b[22m`;
        }
        lines.push(`  ${content}`);
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
        const timeElapsed = computeTimeElapsedFraction(
          bucket.resetTime,
          bucket.windowSeconds,
          now,
          bucket.usedFraction
        );
        const bar = makeProgressBar(bucket.usedFraction, 28, timeElapsed);
        const percentStr = `${(bucket.usedFraction * 100).toFixed(1)}% used`.padStart(10, " ");
        
        let resetStr = "";
        if (bucket.usedFraction <= 0 && (timeElapsed === 0 || timeElapsed === undefined)) {
          resetStr = " · ready";
        } else if (bucket.resetTime) {
          resetStr = ` · ${formatRelativeTime(bucket.resetTime, now)}`;
        }

        lines.push(`      ${label}  ${bar}  ${percentStr}${resetStr}`);
      }

      lines.push("");
    }
  }

  return lines.join("\n");
}
