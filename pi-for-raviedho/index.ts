import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ANTIGRAVITY_PRIMARY_ENDPOINT,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./antigravity/constants.js";
import { DEFAULT_ANTIGRAVITY_MODELS, fetchAntigravityModels } from "./antigravity/models.js";
import {
  getAntigravityApiKey,
  loginAntigravity,
  refreshAntigravityToken,
} from "./antigravity/oauth.js";
import { streamAntigravity } from "./antigravity/stream.js";

function syncOmpAuthIfMissing(): void {
  try {
    const home = homedir();
    const piAuthPath = join(home, ".pi/agent/auth.json");
    let hasAntigravity = false;
    let existingJson: Record<string, unknown> = {};

    if (existsSync(piAuthPath)) {
      try {
        const parsed = JSON.parse(readFileSync(piAuthPath, "utf-8"));
        if (parsed && typeof parsed === "object") {
          existingJson = parsed as Record<string, unknown>;
          if (existingJson["google-antigravity"]) {
            hasAntigravity = true;
          }
        }
      } catch {
        // Fall through
      }
    }

    if (!hasAntigravity) {
      const ompDbPath = join(home, ".omp/agent/agent.db");
      if (existsSync(ompDbPath)) {
        const raw = execFileSync(
          "sqlite3",
          [
            ompDbPath,
            "SELECT data FROM auth_credentials WHERE provider='google-antigravity' ORDER BY updated_at DESC LIMIT 1;",
          ],
          { encoding: "utf-8" }
        ).trim();

        if (raw.startsWith("{")) {
          const parsed = JSON.parse(raw);
          existingJson["google-antigravity"] = {
            type: "oauth",
            access: parsed.access,
            refresh: parsed.refresh,
            expires: parsed.expires ?? Date.now() + 3600 * 1000,
            projectId: parsed.projectId,
            email: parsed.email,
          };
          writeFileSync(piAuthPath, JSON.stringify(existingJson, null, 2), "utf-8");
        }
      }
    }
  } catch {
    // Non-fatal if sync is unavailable
  }
}

export default function (pi: ExtensionAPI) {
  // Sync existing OAuth credentials from omp if ~/.pi/agent/auth.json lacks them
  syncOmpAuthIfMissing();

  // Register Google Antigravity provider with full OAuth and Cloud Code Assist streaming support
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
    apiKey: "$ANTIGRAVITY_API_KEY",
    // Custom streaming API identifier cast through Api domain type
    api: "google-antigravity-api" as unknown as Api,

    models: DEFAULT_ANTIGRAVITY_MODELS,

    async refreshModels(context) {
      // If an API key or OAuth token is available, discover live models
      const apiKey = context?.signal ? process.env.ANTIGRAVITY_API_KEY : undefined;
      if (apiKey) {
        const dynamicModels = await fetchAntigravityModels(apiKey, context.signal);
        if (dynamicModels && dynamicModels.length > 0) {
          return dynamicModels;
        }
      }
      return DEFAULT_ANTIGRAVITY_MODELS;
    },

    oauth: {
      name: PROVIDER_NAME,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey: getAntigravityApiKey,
    },

    streamSimple: streamAntigravity,
  });
}
