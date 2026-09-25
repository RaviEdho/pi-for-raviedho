import { hostname } from "node:os";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { AccountStore } from "../accounts/store.js";
import {
  DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_AUTH_URL,
  HYPER_BASE_URL,
  HYPER_USER_AGENT,
  OAUTH_FETCH_TIMEOUT_MS,
  PROVIDER_ID,
  TOKEN_EXCHANGE_URL,
} from "./constants.js";
import type {
  DeviceAuthResponse,
  DevicePollResponse,
  DevicePollSuccess,
  HyperOAuthCredentials,
  TokenExchangeResponse,
} from "./types.js";

function getDeviceName(): string {
  const host = hostname();
  return host ? `Pi (${host})` : "Pi";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Initiates the Charm Hyper OAuth device authorization flow.
 */
async function initiateDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthResponse> {
  const timeoutSignal = AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch(DEVICE_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": HYPER_USER_AGENT,
    },
    body: JSON.stringify({ device_name: getDeviceName() }),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Hyper device auth failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as DeviceAuthResponse;
}

/**
 * Polls the device authorization endpoint until approval, denial, or expiration.
 */
async function pollDeviceAuth(
  deviceAuth: DeviceAuthResponse,
  signal?: AbortSignal
): Promise<DevicePollSuccess> {
  let intervalMs = Math.max(1000, (deviceAuth.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS) * 1000);
  const deadline = Date.now() + deviceAuth.expires_in * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("Login cancelled");
    }

    await sleep(intervalMs, signal);

    try {
      const timeoutSignal = AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const url = `${HYPER_BASE_URL}/device/auth/${encodeURIComponent(deviceAuth.device_code)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": HYPER_USER_AGENT,
        },
        signal: combinedSignal,
      });

      const payload = (await res.json()) as DevicePollResponse;

      if ("refresh_token" in payload && payload.refresh_token) {
        return payload;
      }

      if ("error" in payload) {
        if (payload.error === "authorization_pending") {
          continue;
        }
        if (payload.error === "slow_down") {
          intervalMs += 5000;
          continue;
        }
        throw new Error(`Hyper device authorization failed: ${payload.error_description || payload.error}`);
      }
    } catch (pollErr) {
      if (signal?.aborted) throw pollErr;
      if (pollErr instanceof Error && pollErr.message.includes("Hyper device authorization failed")) {
        throw pollErr;
      }
      // Non-fatal transient network glitch during polling
    }
  }

  throw new Error("Hyper device authorization timed out");
}

/**
 * Exchanges a device authorization refresh token for an access token.
 */
async function exchangeRefreshToken(
  refreshToken: string,
  signal?: AbortSignal
): Promise<TokenExchangeResponse> {
  const timeoutSignal = AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch(TOKEN_EXCHANGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": HYPER_USER_AGENT,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Hyper token exchange failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as TokenExchangeResponse;
}

function calculateExpiresAt(token: TokenExchangeResponse): number {
  const now = Date.now();
  if (typeof token.expires_in === "number" && token.expires_in > 0) {
    return now + Math.max(60, token.expires_in - 30) * 1000;
  }
  if (typeof token.expires_at === "number" && token.expires_at > 0) {
    const targetMs = token.expires_at > 1_000_000_000_000 ? token.expires_at : token.expires_at * 1000;
    return targetMs - 30_000;
  }
  return now + 3600 * 1000;
}

/**
 * Handles the complete Charm Hyper OAuth device flow login.
 */
export async function loginHyper(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Initiating Charm Hyper device authentication...");
  const deviceAuth = await initiateDeviceAuth(callbacks.signal);

  callbacks.onDeviceCode?.({
    userCode: deviceAuth.user_code,
    verificationUri: deviceAuth.verification_url,
    intervalSeconds: deviceAuth.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
    expiresInSeconds: deviceAuth.expires_in,
  });

  callbacks.onAuth?.({
    url: deviceAuth.verification_url,
    instructions: `Confirm code: ${deviceAuth.user_code}`,
  });

  callbacks.onProgress?.(`Waiting for confirmation on ${deviceAuth.verification_url} (Code: ${deviceAuth.user_code})...`);

  const pollResult = await pollDeviceAuth(deviceAuth, callbacks.signal);

  callbacks.onProgress?.("Device confirmed, exchanging tokens...");
  const token = await exchangeRefreshToken(pollResult.refresh_token, callbacks.signal);
  const expires = calculateExpiresAt(token);

  const teamName = pollResult.team_name || undefined;
  const userId = pollResult.user_id || undefined;
  const email = teamName || userId || "default";
  const id = AccountStore.generateAccountId(PROVIDER_ID, email);

  const creds: HyperOAuthCredentials = {
    access: token.access_token,
    refresh: token.refresh_token || pollResult.refresh_token,
    expires,
    teamName,
    teamId: pollResult.team_id,
    userId,
    email,
  };

  try {
    const store = AccountStore.getInstance();
    store.upsert({
      id,
      provider: PROVIDER_ID,
      type: "oauth",
      email,
      orgId: pollResult.team_id,
      orgName: teamName,
      planType: "free",
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.setActive(PROVIDER_ID, id);
  } catch {
    // Non-fatal if store persistence fails
  }

  return creds as unknown as OAuthCredentials;
}

/**
 * Refreshes an expired Charm Hyper OAuth token.
 */
export async function refreshHyperToken(
  credentials: OAuthCredentials,
  signal?: AbortSignal
): Promise<OAuthCredentials> {
  if (!credentials.refresh) {
    throw new Error("No refresh token available for Charm Hyper");
  }

  const token = await exchangeRefreshToken(credentials.refresh, signal);
  const expires = calculateExpiresAt(token);

  const updated: OAuthCredentials = {
    ...credentials,
    access: token.access_token,
    refresh: token.refresh_token || credentials.refresh,
    expires,
  };

  try {
    const store = AccountStore.getInstance();
    const id = AccountStore.generateAccountId(PROVIDER_ID, (credentials as HyperOAuthCredentials).email || "default");
    const account = store.get(id);
    if (account) {
      account.access = updated.access;
      account.refresh = updated.refresh;
      account.expires = updated.expires;
      account.updatedAt = Date.now();
      store.upsert(account);
    }
  } catch {
    // Non-fatal
  }

  return updated;
}

/**
 * Returns the access token string for API calls.
 */
export function getHyperApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}
