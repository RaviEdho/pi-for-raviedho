export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window: string;
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
  fetchedAt: number;
  groups: QuotaGroup[];
  capacitySummary?: string;
  error?: string;
}
