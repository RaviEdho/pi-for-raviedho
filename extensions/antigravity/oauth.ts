import http from "node:http";
import { randomUUID } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  CALLBACK_PORT,
  CALLBACK_PATH,
  FREE_TIER_ID,
  getAntigravityUserAgent,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  LOAD_CODE_ASSIST_URL,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_SCOPES,
  ONBOARD_POLL_INTERVAL_MS,
  ONBOARD_TIMEOUT_MS,
  ONBOARD_USER_URL,
  OPERATIONS_URL,
  REDIRECT_URI,
} from "./constants.js";
import type {
  AntigravityApiKeyPayload,
  AntigravityOAuthCredentials,
  LoadCodeAssistResponse,
  OnboardOperation,
} from "./types.js";

async function postLoadCodeAssist(
  body: Record<string, unknown>,
  accessToken: string,
  signal?: AbortSignal
): Promise<LoadCodeAssistResponse> {
  const res = await fetch(LOAD_CODE_ASSIST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": getAntigravityUserAgent(),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`loadCodeAssist failed (${res.status}): ${errorText}`);
  }
  return (await res.json()) as LoadCodeAssistResponse;
}

/**
 * Onboard/discover the Cloud Code Assist project for Antigravity.
 * Mirrors omp's google-antigravity after-exchange hook.
 */
export async function discoverProject(
  accessToken: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": getAntigravityUserAgent(),
  };

  onProgress?.("Checking Cloud Code Assist account status...");

  let payload = await postLoadCodeAssist({ metadata: { ideType: "ANTIGRAVITY" } }, accessToken, signal);

  // If already has project and not paid tier, verify with companion project
  const initialProjectId = payload.cloudaicompanionProject;
  if (!payload.paidTier && initialProjectId) {
    try {
      payload = await postLoadCodeAssist(
        {
          cloudaicompanionProject: initialProjectId,
          metadata: { ideType: "ANTIGRAVITY" },
        },
        accessToken,
        signal
      );
    } catch {
      // Keep initial payload if secondary call fails
    }
  }

  // If no tier provisioned yet, onboard the free tier
  if (!payload.currentTier) {
    onProgress?.("Provisioning Antigravity free tier...");
    const onboardRes = await fetch(ONBOARD_USER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tierId: FREE_TIER_ID,
        metadata: { ideType: "ANTIGRAVITY" },
      }),
      signal,
    });

    if (!onboardRes.ok) {
      const errorText = await onboardRes.text();
      throw new Error(`onboardUser failed (${onboardRes.status}): ${errorText}`);
    }

    let operation = (await onboardRes.json()) as OnboardOperation;
    const deadline = Date.now() + ONBOARD_TIMEOUT_MS;

    while (!operation.done) {
      if (Date.now() >= deadline) {
        throw new Error("Antigravity user onboarding timed out after 30s");
      }
      if (signal?.aborted) {
        throw new Error("Onboarding cancelled");
      }

      const { promise: sleepPromise, resolve: sleepResolve } = Promise.withResolvers<void>();
      setTimeout(sleepResolve, ONBOARD_POLL_INTERVAL_MS);
      await sleepPromise;

      const opName = operation.name;
      if (!opName) {
        throw new Error("onboardUser returned an operation without a name");
      }

      const opRes = await fetch(`${OPERATIONS_URL}/${opName}`, {
        method: "GET",
        headers,
        signal,
      });

      if (!opRes.ok) {
        const errorText = await opRes.text();
        throw new Error(`Operation poll failed (${opRes.status}): ${errorText}`);
      }
      operation = (await opRes.json()) as OnboardOperation;
    }

    if (operation.error) {
      throw new Error(`Onboarding failed: ${operation.error.message ?? JSON.stringify(operation.error)}`);
    }

    onProgress?.("Refreshing Cloud Code Assist project...");
    payload = await postLoadCodeAssist({ metadata: { ideType: "ANTIGRAVITY" } }, accessToken, signal);
  }

  const projectId = payload.cloudaicompanionProject;
  if (!projectId) {
    throw new Error("Could not discover a Cloud Code Assist project for Antigravity");
  }

  return projectId;
}

/**
 * Interactive OAuth login flow for Antigravity.
 * Listens on local port 51121 for browser redirect, with prompt fallback for headless / remote setups.
 */
export async function loginAntigravity(
  callbacks: OAuthLoginCallbacks
): Promise<AntigravityOAuthCredentials> {
  const state = randomUUID();
  const authParams = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const authUrl = `${GOOGLE_AUTH_URL}?${authParams.toString()}`;

  let server: http.Server | undefined;
  const { promise: codePromise, resolve: codeResolve, reject: codeReject } = Promise.withResolvers<string>();

  try {
    server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
        if (reqUrl.pathname === CALLBACK_PATH) {
          const code = reqUrl.searchParams.get("code");
          const error = reqUrl.searchParams.get("error");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<html><body><h2>Authentication failed: ${error}</h2></body></html>`);
            codeReject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <!DOCTYPE html>
              <html>
                <head><title>Authentication Successful</title></head>
                <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #121212; color: #e0e0e0;">
                  <div style="text-align: center; border: 1px solid #333; padding: 2rem; border-radius: 8px; background: #1e1e1e;">
                    <h2 style="color: #4caf50; margin-top: 0;">✓ Antigravity OAuth Successful</h2>
                    <p>You can close this browser tab and return to Pi.</p>
                  </div>
                </body>
              </html>
            `);
            codeResolve(code);
            return;
          }
        }
        res.writeHead(404);
        res.end();
      } catch (err) {
        codeReject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.on("error", (err: unknown) => {
      const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
      if (code !== "EADDRINUSE") {
        const message = err instanceof Error ? err.message : String(err);
        callbacks.onProgress?.(`Callback server notice: ${message}`);
      }
    });

    server.listen(CALLBACK_PORT, "127.0.0.1");
  } catch {
    // If local server cannot bind (e.g. port taken), rely on onPrompt fallback
  }

  callbacks.onAuth({ url: authUrl });

  // Dual wait: browser redirect callback or user prompt paste
  const promptPromise = callbacks
    .onPrompt({
      message: "Complete sign-in in browser, or paste the callback URL / code here:",
    })
    .then((input) => {
      const trimmed = input.trim();
      if (trimmed.includes("code=")) {
        try {
          const parsedUrl = new URL(trimmed.startsWith("http") ? trimmed : `http://localhost?${trimmed}`);
          const parsedCode = parsedUrl.searchParams.get("code");
          if (parsedCode) return decodeURIComponent(parsedCode);
        } catch {
          const match = trimmed.match(/[?&]code=([^&]+)/);
          if (match?.[1]) return decodeURIComponent(match[1]);
        }
      }
      return trimmed;
    });

  let authCode: string;
  try {
    authCode = await Promise.race([codePromise, promptPromise]);
  } finally {
    if (server) {
      server.close();
    }
  }

  if (!authCode) {
    throw new Error("No authorization code received");
  }

  callbacks.onProgress?.("Exchanging authorization code for tokens...");

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: authCode,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    throw new Error(`OAuth token exchange failed (${tokenRes.status}): ${errorText}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!tokenData.refresh_token) {
    throw new Error("Google did not return a refresh token. Please re-run login with prompt=consent.");
  }

  // Fetch user email
  let email: string | undefined;
  try {
    const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (userinfoRes.ok) {
      const userInfo = (await userinfoRes.json()) as { email?: string };
      email = userInfo.email;
    }
  } catch {
    // Non-fatal if userinfo fails
  }

  // Discover and onboard project
  const projectId = await discoverProject(tokenData.access_token, callbacks.onProgress);

  return {
    access: tokenData.access_token,
    refresh: tokenData.refresh_token,
    expires: Date.now() + (tokenData.expires_in - 300) * 1000,
    projectId,
    email,
  };
}

/**
 * Refreshes an expired Google Antigravity OAuth access token.
 */
export async function refreshAntigravityToken(
  credentials: OAuthCredentials,
  signal?: AbortSignal
): Promise<AntigravityOAuthCredentials> {
  const currentCreds = credentials as AntigravityOAuthCredentials;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: currentCreds.refresh,
      grant_type: "refresh_token",
    }).toString(),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  let projectId = currentCreds.projectId;
  if (!projectId) {
    projectId = await discoverProject(data.access_token, undefined, signal);
  }

  return {
    access: data.access_token,
    refresh: data.refresh_token ?? currentCreds.refresh,
    expires: Date.now() + (data.expires_in - 300) * 1000,
    projectId,
    email: currentCreds.email,
  };
}

/**
 * Serializes credentials into the API key string passed to streamSimple.
 */
export function getAntigravityApiKey(credentials: OAuthCredentials): string {
  const creds = credentials as AntigravityOAuthCredentials;
  const payload: AntigravityApiKeyPayload = {
    accessToken: creds.access,
    projectId: creds.projectId,
    email: creds.email,
  };
  return JSON.stringify(payload);
}

/**
 * Parses options.apiKey passed to streamSimple.
 */
export async function parseAntigravityApiKey(rawKey: string): Promise<AntigravityApiKeyPayload> {
  const trimmed = rawKey.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        "accessToken" in parsed &&
        "projectId" in parsed &&
        typeof parsed.accessToken === "string" &&
        typeof parsed.projectId === "string"
      ) {
        return parsed as AntigravityApiKeyPayload;
      }
    } catch {
      // Fall through
    }
  }

  // Treat as raw access token and discover project
  const projectId = await discoverProject(trimmed);
  return {
    accessToken: trimmed,
    projectId,
  };
}
