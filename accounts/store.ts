import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AccountCredential, AccountStoreData } from "./types.js";

const STORE_VERSION = 1;
export const SUPPORTED_PROVIDERS = new Set(["google-antigravity", "openai-codex"]);

export class AccountStore {
  private static instance?: AccountStore;
  private filePath: string;
  private piAuthPath: string;
  private data: AccountStoreData;
  private lastMtimes = {
    accounts: 0,
    auth: 0,
  };
  private lastCheckTime = 0;

  private constructor(filePath?: string) {
    this.filePath = filePath || join(homedir(), ".pi/agent/accounts.json");
    this.piAuthPath = join(homedir(), ".pi/agent/auth.json");
    this.data = {
      version: STORE_VERSION,
      activeAccounts: {},
      accounts: [],
    };
    this.load();
    this.autoImportFromSources();
    this.updateLastMtimes();
    this.lastCheckTime = Date.now();
  }

  public static getInstance(): AccountStore {
    if (!AccountStore.instance) {
      AccountStore.instance = new AccountStore();
    }
    return AccountStore.instance;
  }

  /**
   * Generates a normalized unique account id.
   */
  public static generateAccountId(provider: string, identity: string): string {
    const cleanProvider = provider.trim().toLowerCase();
    const cleanIdentity = identity.trim().toLowerCase();
    return `${cleanProvider}:${cleanIdentity}`;
  }

  /**
   * Safe file modification time retrieval (returns 0 if file does not exist).
   */
  private getFileMtime(path: string): number {
    try {
      if (existsSync(path)) {
        return statSync(path).mtimeMs;
      }
    } catch {
      // Ignore stat errors
    }
    return 0;
  }

  /**
   * Updates internal cache of source file modification timestamps.
   */
  private updateLastMtimes(): void {
    this.lastMtimes = {
      accounts: this.getFileMtime(this.filePath),
      auth: this.getFileMtime(this.piAuthPath),
    };
  }

  /**
   * Loads existing accounts from disk.
   */
  public load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.accounts)) {
        // Preserve active in-memory cooldown blocks if not expired
        const activeBlocks = new Map<string, { blockedUntil: number | null; blockedReason?: string | null }>();
        for (const a of this.data.accounts) {
          if (a.blockedUntil && a.blockedUntil > Date.now()) {
            activeBlocks.set(a.id, { blockedUntil: a.blockedUntil, blockedReason: a.blockedReason });
          }
        }

        const loadedAccounts = (parsed.accounts as AccountCredential[]).filter(
          (a) => a && typeof a === "object" && SUPPORTED_PROVIDERS.has(a.provider)
        );

        this.data = {
          version: parsed.version || STORE_VERSION,
          activeAccounts: parsed.activeAccounts || {},
          accounts: loadedAccounts,
        };

        for (const acc of this.data.accounts) {
          const block = activeBlocks.get(acc.id);
          if (block && (!acc.blockedUntil || block.blockedUntil! > acc.blockedUntil)) {
            acc.blockedUntil = block.blockedUntil;
            acc.blockedReason = block.blockedReason;
          }
        }
      }
    } catch {
      // Keep empty default on parse failure
    }
  }

  /**
   * Forces a full synchronization from accounts.json and auth.json.
   */
  public sync(): void {
    this.load();
    this.autoImportFromSources();
    this.updateLastMtimes();
    this.lastCheckTime = Date.now();
  }

  /**
   * Checks file modification timestamps on disk and automatically reloads/imports
   * if accounts.json or auth.json has been modified externally.
   */
  public reloadIfModified(force = false): boolean {
    const now = Date.now();
    if (!force && now - this.lastCheckTime < 1000) {
      return false;
    }
    this.lastCheckTime = now;

    const accountsMtime = this.getFileMtime(this.filePath);
    const authMtime = this.getFileMtime(this.piAuthPath);

    let needsLoad = false;
    let needsImport = false;

    if (accountsMtime > this.lastMtimes.accounts) {
      needsLoad = true;
      this.lastMtimes.accounts = accountsMtime;
    }

    if (authMtime > this.lastMtimes.auth) {
      needsImport = true;
      this.lastMtimes.auth = authMtime;
    }

    if (needsLoad) {
      this.load();
    }
    if (needsImport || needsLoad) {
      this.autoImportFromSources();
    }

    return needsLoad || needsImport;
  }

  /**
   * Persists accounts to disk.
   */
  public save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // Ignore chmod error if unsupported
      }
      this.lastMtimes.accounts = this.getFileMtime(this.filePath);
    } catch (err) {
      console.error("[AccountStore] Failed to save accounts.json:", err);
    }
  }

  /**
   * Synchronizes active account for the provider to ~/.pi/agent/auth.json
   * so standard Pi operations and tools find the active credential.
   */
  public syncActiveToPiAuth(provider: string): void {
    const active = this.getActive(provider);
    if (!active) return;

    const piAuthPath = this.piAuthPath;
    let currentAuth: Record<string, unknown> = {};

    if (existsSync(piAuthPath)) {
      try {
        currentAuth = JSON.parse(readFileSync(piAuthPath, "utf-8")) || {};
      } catch {
        currentAuth = {};
      }
    }
    const existingAuth = currentAuth[provider] as Record<string, unknown> | undefined;
    if (existingAuth) {
      if (
        active.type === "oauth" &&
        existingAuth.type === "oauth" &&
        existingAuth.access === active.access &&
        existingAuth.refresh === active.refresh &&
        existingAuth.expires === active.expires &&
        existingAuth.projectId === active.projectId
      ) {
        return;
      }
      if (
        active.type === "api_key" &&
        existingAuth.type === "api_key" &&
        existingAuth.key === active.apiKey
      ) {
        return;
      }
    }

    if (active.type === "oauth") {
      currentAuth[provider] = {
        type: "oauth",
        access: active.access,
        refresh: active.refresh,
        expires: active.expires,
        projectId: active.projectId,
        email: active.email,
        accountId: active.accountId,
        orgId: active.orgId,
      };
    } else if (active.type === "api_key") {
      currentAuth[provider] = {
        type: "api_key",
        key: active.apiKey,
      };
    }

    try {
      const dir = dirname(piAuthPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      writeFileSync(piAuthPath, JSON.stringify(currentAuth, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      try {
        chmodSync(piAuthPath, 0o600);
      } catch {
        // Ignore chmod error if unsupported
      }
      this.lastMtimes.auth = this.getFileMtime(this.piAuthPath);
    } catch (err) {
      console.error(`[AccountStore] Failed to sync active account to auth.json for ${provider}:`, err);
    }
  }

  /**
   * Automatically discovers and imports credentials from ~/.pi/agent/auth.json
   * into the accounts store without overwriting newer state.
   */
  public autoImportFromSources(): void {
    let modified = false;

    const findExisting = (
      provider: string,
      email?: string,
      accountId?: string,
      id?: string,
      refresh?: string
    ) => {
      return this.data.accounts.find((a) => {
        if (a.provider !== provider) return false;
        if (id && a.id === id) return true;
        if (email && a.email && a.email.toLowerCase() === email.toLowerCase()) return true;
        if (accountId && a.accountId && a.accountId === accountId) return true;
        if (refresh && a.refresh && a.refresh === refresh) return true;
        return false;
      });
    };

    const extractEmailFromJwt = (token?: string): string | undefined => {
      if (!token) return undefined;
      try {
        const parts = token.split(".");
        if (parts.length === 3) {
          const raw = Buffer.from(parts[1], "base64").toString("utf-8");
          const payload = JSON.parse(raw);
          return (
            payload?.["https://api.openai.com/profile"]?.email ||
            payload?.email ||
            undefined
          );
        }
      } catch {
        // Ignore
      }
      return undefined;
    };

    const extractAccountIdFromJwt = (token?: string): string | undefined => {
      if (!token) return undefined;
      try {
        const parts = token.split(".");
        if (parts.length === 3) {
          const raw = Buffer.from(parts[1], "base64").toString("utf-8");
          const payload = JSON.parse(raw);
          return (
            payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
            undefined
          );
        }
      } catch {
        // Ignore
      }
      return undefined;
    };

    // Check ~/.pi/agent/auth.json
    const piAuthPath = this.piAuthPath;
    if (existsSync(piAuthPath)) {
      try {
        const raw = readFileSync(piAuthPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          for (const [provider, entry] of Object.entries(parsed)) {
            if (!SUPPORTED_PROVIDERS.has(provider)) continue;
            if (!entry || typeof entry !== "object") continue;
            const cred = entry as Record<string, unknown>;
            const access = typeof cred.access === "string" ? cred.access : undefined;
            const refresh = typeof cred.refresh === "string" ? cred.refresh : undefined;
            const email =
              (typeof cred.email === "string" ? cred.email : undefined) ||
              extractEmailFromJwt(access);
            const accountId =
              (typeof cred.accountId === "string" ? cred.accountId : undefined) ||
              extractAccountIdFromJwt(access);
            const projectId = typeof cred.projectId === "string" ? cred.projectId : undefined;
            const tokenSuffix = refresh ? `token-${refresh.slice(-8)}` : access ? `tok-${access.slice(-8)}` : undefined;
            const identity = email || accountId || (projectId && projectId !== "aicode-consumers" ? projectId : undefined) || tokenSuffix || "default";
            const id = AccountStore.generateAccountId(provider, identity);

            const isOAuth = cred.type === "oauth" || !!cred.access;
            const existing = findExisting(provider, email, accountId, id, refresh);

            if (!existing) {
              const account: AccountCredential = {
                id,
                provider,
                type: isOAuth ? "oauth" : "api_key",
                email,
                accountId,
                projectId,
                access,
                refresh,
                expires: typeof cred.expires === "number" ? cred.expires : undefined,
                apiKey: typeof cred.key === "string" ? cred.key : undefined,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              this.data.accounts.push(account);
              this.data.activeAccounts[provider] = account.id;
              modified = true;
            } else {
              if (email && !existing.email) existing.email = email;
              if (accountId && !existing.accountId) existing.accountId = accountId;
              if (projectId && !existing.projectId) existing.projectId = projectId;
              const credExpires = typeof cred.expires === "number" ? cred.expires : undefined;
              const isPiAuthNewer =
                !existing.access ||
                (credExpires && existing.expires ? credExpires >= existing.expires : true);
              if (isOAuth && access && access !== existing.access && isPiAuthNewer) {
                existing.access = access;
                if (refresh) existing.refresh = refresh;
                if (credExpires) existing.expires = credExpires;
                existing.updatedAt = Date.now();
                modified = true;
              }
              if (this.data.activeAccounts[provider] !== existing.id) {
                this.data.activeAccounts[provider] = existing.id;
                modified = true;
              }
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }

    if (modified) {
      this.save();
    }

    for (const provider of SUPPORTED_PROVIDERS) {
      if (this.data.activeAccounts[provider]) {
        this.syncActiveToPiAuth(provider);
      }
    }
  }

  /**
   * Returns all accounts, optionally filtered by provider.
   */
  public list(provider?: string): AccountCredential[] {
    this.reloadIfModified();
    if (!provider) {
      return [...this.data.accounts];
    }
    return this.data.accounts.filter((a) => a.provider === provider);
  }

  /**
   * Retrieves an account by its unique ID.
   */
  public get(id: string): AccountCredential | undefined {
    this.reloadIfModified();
    return this.data.accounts.find((a) => a.id === id);
  }

  /**
   * Retrieves the currently active account for a provider.
   */
  public getActive(provider: string): AccountCredential | undefined {
    this.reloadIfModified();
    const activeId = this.data.activeAccounts[provider];
    if (activeId) {
      const acc = this.get(activeId);
      if (acc) return acc;
    }
    const accounts = this.list(provider);
    return accounts.find((a) => !a.disabledCause) || accounts[0];
  }

  /**
   * Sets the active account for a provider and syncs it to Pi's auth.json.
   */
  public setActive(provider: string, accountId: string): boolean {
    const account = this.get(accountId);
    if (!account || account.provider !== provider) {
      return false;
    }
    this.data.activeAccounts[provider] = accountId;
    this.save();
    this.syncActiveToPiAuth(provider);
    return true;
  }

  /**
   * Saves or updates an account in the store.
   */
  public upsert(account: AccountCredential): void {
    const index = this.data.accounts.findIndex((a) => a.id === account.id);
    account.updatedAt = Date.now();
    if (index >= 0) {
      this.data.accounts[index] = account;
    } else {
      this.data.accounts.push(account);
    }
    if (!this.data.activeAccounts[account.provider]) {
      this.data.activeAccounts[account.provider] = account.id;
    }
    this.save();
    this.syncActiveToPiAuth(account.provider);
  }

  /**
   * Removes an account from the store.
   */
  public remove(id: string): boolean {
    const index = this.data.accounts.findIndex((a) => a.id === id);
    if (index < 0) return false;
    const [removed] = this.data.accounts.splice(index, 1);
    if (this.data.activeAccounts[removed.provider] === id) {
      const remaining = this.list(removed.provider);
      if (remaining.length > 0) {
        this.data.activeAccounts[removed.provider] = remaining[0].id;
        this.syncActiveToPiAuth(removed.provider);
      } else {
        delete this.data.activeAccounts[removed.provider];
      }
    }
    this.save();
    return true;
  }

  /**
   * Marks an account as rate-limited / blocked until a specified timestamp.
   */
  public setBlocked(id: string, cooldownMs: number, reason = "Rate limited (429)"): void {
    const account = this.get(id);
    if (account) {
      account.blockedUntil = Date.now() + cooldownMs;
      account.blockedReason = reason;
      this.save();
    }
  }

  /**
   * Clears any active block on an account.
   */
  public clearBlock(id: string): void {
    const account = this.get(id);
    if (account && (account.blockedUntil || account.blockedReason)) {
      account.blockedUntil = null;
      account.blockedReason = null;
      this.save();
    }
  }

  /**
   * Checks if an account is currently blocked.
   */
  public isBlocked(account: AccountCredential): boolean {
    if (account.disabledCause) return true;
    if (!account.blockedUntil) return false;
    if (Date.now() >= account.blockedUntil) {
      // Cooldown expired
      account.blockedUntil = null;
      account.blockedReason = null;
      return false;
    }
    return true;
  }
}
