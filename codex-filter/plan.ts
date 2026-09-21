const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/**
 * Decodes the payload portion of a JWT string.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const raw = Buffer.from(parts[1], "base64").toString("utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore parse error
  }
  return null;
}

/**
 * Extracts chatgpt_plan_type (e.g. "free", "plus", "pro", "team") from an OAuth access token.
 */
export function getCodexPlanType(accessToken: string | undefined): string | null {
  if (!accessToken) return null;
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;

  const authClaim = payload[JWT_CLAIM_PATH];
  if (authClaim && typeof authClaim === "object" && !Array.isArray(authClaim)) {
    const plan = (authClaim as Record<string, unknown>).chatgpt_plan_type;
    if (typeof plan === "string" && plan.trim().length > 0) {
      return plan.trim().toLowerCase();
    }
  }
  return null;
}

/**
 * Extracts chatgpt_account_id from an OAuth access token.
 */
export function getCodexAccountId(accessToken: string | undefined): string | null {
  if (!accessToken) return null;
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;

  const authClaim = payload[JWT_CLAIM_PATH];
  if (authClaim && typeof authClaim === "object" && !Array.isArray(authClaim)) {
    const id = (authClaim as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === "string" && id.trim().length > 0) {
      return id.trim();
    }
  }
  return null;
}
