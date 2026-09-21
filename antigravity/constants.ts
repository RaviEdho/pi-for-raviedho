/**
 * Antigravity provider constants: endpoints, OAuth client info, wire profiles, and headers.
 * Ported from omp (@oh-my-pi/pi-ai and @oh-my-pi/pi-catalog).
 */

export const PROVIDER_ID = "google-antigravity";
export const PROVIDER_NAME = "Google Antigravity (Gemini 3, Claude, GPT-OSS)";

// OAuth 2.0 Client credentials for Antigravity
// Base64 decoded from omp's google-antigravity.kdl
export const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const OAUTH_CLIENT_SECRET = "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";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const CALLBACK_PORT = 51121;
export const CALLBACK_PATH = "/oauth-callback";
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

// Cloud Code Assist Endpoints
export const ANTIGRAVITY_PRIMARY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const LOAD_CODE_ASSIST_URL = `${ANTIGRAVITY_PRIMARY_ENDPOINT}/v1internal:loadCodeAssist`;
export const ONBOARD_USER_URL = `${ANTIGRAVITY_PRIMARY_ENDPOINT}/v1internal:onboardUser`;
export const OPERATIONS_URL = `${ANTIGRAVITY_PRIMARY_ENDPOINT}/v1internal`;
export const FETCH_AVAILABLE_MODELS_URL = `${ANTIGRAVITY_PRIMARY_ENDPOINT}/v1internal:fetchAvailableModels`;

export const FREE_TIER_ID = "free-tier";
export const ONBOARD_TIMEOUT_MS = 30_000;
export const ONBOARD_POLL_INTERVAL_MS = 1_000;

export const DEFAULT_ANTIGRAVITY_VERSION = "2.8.0";

/**
 * Build the exact Antigravity user agent string expected by daily-cloudcode-pa.
 */
export function getAntigravityUserAgent(): string {
  const version = process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION;
  const os = process.env.PI_AI_ANTIGRAVITY_OS || "darwin";
  const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || "arm64";
  const cl = process.env.PI_AI_ANTIGRAVITY_CL || "963137146";
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

/** Wire profiles matching omp captured client */
export interface AntigravityWireProfile {
  modelEnum?: string;
  maxOutputTokens: number;
}

export const ANTIGRAVITY_WIRE_PROFILES: Readonly<Record<string, AntigravityWireProfile>> = {
  "gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65536 },
  "gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
  "gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65536 },
  "gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535 },
  "gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
  "claude-sonnet-4-6": { maxOutputTokens: 64000 },
  "claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
  "claude-opus-4-6": { maxOutputTokens: 64000 },
  "claude-sonnet-4-5": { maxOutputTokens: 64000 },
  "claude-sonnet-4-5-thinking": { maxOutputTokens: 64000 },
  "claude-opus-4-5": { maxOutputTokens: 64000 },
  "claude-opus-4-5-thinking": { maxOutputTokens: 64000 },
};
