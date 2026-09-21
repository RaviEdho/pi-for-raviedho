import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountBalancer } from "./accounts/balancer.js";
import { AccountStore } from "./accounts/store.js";
import { executeWithMultiAccountFailover } from "./accounts/wrapper.js";
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

export default async function (pi: ExtensionAPI) {
  // Initialize multi-account store and auto-discover accounts from omp and Pi stores
  const store = AccountStore.getInstance();
  const balancer = AccountBalancer.getInstance();

  // Retrieve active token for initial model discovery
  let token: string | undefined = process.env.ANTIGRAVITY_API_KEY;
  const activeAccount = store.getActive(PROVIDER_ID);
  if (activeAccount) {
    try {
      token = await balancer.ensureFreshToken(activeAccount);
    } catch {
      // Non-fatal if offline
    }
  }

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

  // Register Google Antigravity provider with multi-account failover and streaming support
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
    apiKey: "$ANTIGRAVITY_API_KEY",
    api: "google-antigravity-api" as unknown as Api,

    models,

    async refreshModels(context) {
      const currentActive = store.getActive(PROVIDER_ID);
      let activeToken: string | undefined;
      if (currentActive) {
        try {
          activeToken = await balancer.ensureFreshToken(currentActive);
        } catch {
          // Ignore
        }
      }
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

    streamSimple(model, transcript, options) {
      return executeWithMultiAccountFailover(
        PROVIDER_ID,
        model,
        transcript,
        options,
        (m, ctx, opts, resolvedAuth) => {
          const apiKey = resolvedAuth.account.projectId
            ? JSON.stringify({
                accessToken: resolvedAuth.token,
                projectId: resolvedAuth.account.projectId,
                email: resolvedAuth.account.email,
              })
            : resolvedAuth.token;
          return streamAntigravity(m, ctx, {
            ...opts,
            apiKey,
          });
        }
      );
    },
  });

  // Register /usage quota monitor command
  registerUsageCommand(pi);

  // Register dynamic OpenAI Codex plan filter and multi-account provider
  registerCodexFilter(pi);
}
