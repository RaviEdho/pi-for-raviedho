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

export default function (pi: ExtensionAPI) {
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

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("antigravity", "Antigravity provider ready");
  });
}
