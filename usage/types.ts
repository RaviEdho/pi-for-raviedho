export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window: string;
  windowSeconds?: number;
  remainingFraction: number;
  usedFraction: number;
  resetTime?: string;
  description?: string;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface ProviderUsageReport {
  providerId: string;
  providerName: string;
  accountEmail?: string;
  accountId?: string;
  isSessionAccount?: boolean;
  isActiveAccount?: boolean;
  planType?: string;
  resetCredits?: number;
  fetchedAt: number;
  groups: QuotaGroup[];
  capacitySummary?: string;
  error?: string;
}

export interface SessionUsageInfo {
  sessionId?: string;
  modelId?: string;
  providerId?: string;
  accountEmail?: string;
  accountId?: string;
}
