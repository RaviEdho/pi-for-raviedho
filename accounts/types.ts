export interface AccountCredential {
  id: string;
  provider: string;
  type: "oauth" | "api_key";
  label?: string;
  email?: string;
  accountId?: string;
  projectId?: string;
  orgId?: string;
  orgName?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  apiKey?: string;
  createdAt: number;
  updatedAt: number;
  blockedUntil?: number | null;
  blockedReason?: string | null;
  disabledCause?: string | null;
}

export interface AccountStoreData {
  version: number;
  activeAccounts: Record<string, string>; // provider -> accountId
  accounts: AccountCredential[];
}

export interface ResolvedAccountAuth {
  account: AccountCredential;
  token: string;
}
