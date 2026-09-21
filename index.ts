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
import {
  DEFAULT_ANTIGRAVITY_MODELS,
  fetchAndCollapseAntigravityModels,
} from "./antigravity/models.js";
import {
  getAntigravityApiKey,
  loginAntigravity,
  refreshAntigravityToken,
} from "./antigravity/oauth.js";
import { streamAntigravity } from "./antigravity/stream.js";
import { registerCodexFilter } from "./codex-filter/index.js";
import { registerUsageCommand } from "./usage/index.js";

function syncOmpAuthAndGetToken(): string | undefined {
  let token = process.env.ANTIGRAVITY_API_KEY;
  try {
    const home = homedir();
    const piAuthPath = join(home, ".pi/agent/auth.json");
    let existingJson: Record<string, unknown> = {};

    if (existsSync(piAuthPath)) {
      try {
        const parsed = JSON.parse(readFileSync(piAuthPath, "utf-8"));
        if (parsed && typeof parsed === "object") {
          existingJson = parsed as Record<string, unknown>;
          const antigravityCred = existingJson["google-antigravity"];
          if (
            antigravityCred &&
            typeof antigravityCred === "object" &&
            "access" in antigravityCred &&
            typeof antigravityCred.access === "string"
          ) {
            token = token || antigravityCred.access;
          }
        }
      } catch {
        // Fall through
      }
    }

    if (!token) {
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
          token = parsed.access;
        }
      }
    }
  } catch {
    // Non-fatal if sync is unavailable
  }
  return token;
}

export default async function (pi: ExtensionAPI) {
  // Sync existing OAuth credentials from omp and retrieve token
  const token = syncOmpAuthAndGetToken();

  // Dynamically fetch and collapse live models from Google if token is available
  let models = DEFAULT_ANTIGRAVITY_MODELS;
  if (token) {
    try {
      const dynamicModels = await fetchAndCollapseAntigravityModels(token);
      if (dynamicModels && dynamicModels.length > 0) {
        models = dynamicModels;
      }
    } catch {
      // Keep defaults on network failure
    }
  }

  // Register Google Antigravity provider with full OAuth and Cloud Code Assist streaming support
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
    apiKey: "$ANTIGRAVITY_API_KEY",
    api: "google-antigravity-api" as unknown as Api,

    models,

    async refreshModels(context) {
      const activeToken = syncOmpAuthAndGetToken();
      if (activeToken) {
        const liveModels = await fetchAndCollapseAntigravityModels(activeToken, context?.signal);
        if (liveModels && liveModels.length > 0) {
          return liveModels;
        }
      }
      return models;
    },

    oauth: {
      name: PROVIDER_NAME,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey: getAntigravityApiKey,
    },

    streamSimple: streamAntigravity,
  });

  // Register /usage command
  registerUsageCommand(pi);

  // Register dynamic OpenAI Codex plan filter
  registerCodexFilter(pi);
}
