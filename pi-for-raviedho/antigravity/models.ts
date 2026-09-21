import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  ANTIGRAVITY_PRIMARY_ENDPOINT,
  FETCH_AVAILABLE_MODELS_URL,
  getAntigravityUserAgent,
} from "./constants.js";
import type { AntigravityDiscoveryResponse } from "./types.js";

/** Default model list matching omp catalog definitions */
export const DEFAULT_ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
];

const DISCOVERY_DENYLIST: Record<string, true> = {
  chat_20706: true,
  chat_23310: true,
  "gemini-2.5-pro": true,
};

/**
 * Fetch discoverable models dynamically from Cloud Code Assist.
 */
export async function fetchAntigravityModels(
  accessToken: string,
  signal?: AbortSignal
): Promise<ProviderModelConfig[] | null> {
  try {
    const res = await fetch(FETCH_AVAILABLE_MODELS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": getAntigravityUserAgent(),
      },
      body: JSON.stringify({}),
      signal,
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as AntigravityDiscoveryResponse;
    if (!data.models) return null;

    const models: ProviderModelConfig[] = [];
    for (const [modelId, modelInfo] of Object.entries(data.models)) {
      if (DISCOVERY_DENYLIST[modelId] || modelInfo.isInternal) {
        continue;
      }

      const isClaude = modelId.startsWith("claude-");
      const isFlash = modelId.includes("flash");
      const maxTokens = modelInfo.maxOutputTokens ?? (isClaude ? 64000 : 65536);
      const contextWindow = modelInfo.maxTokens ?? (isClaude ? 200000 : 1048576);

      let cost = { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 };
      if (isFlash) {
        cost = { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 };
      } else if (modelId.includes("opus")) {
        cost = { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 };
      } else if (isClaude) {
        cost = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
      }

      models.push({
        id: modelId,
        name: modelInfo.displayName || modelId,
        reasoning: modelInfo.supportsThinking ?? true,
        input: modelInfo.supportsImages ? ["text", "image"] : ["text"],
        cost,
        contextWindow,
        maxTokens,
        baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
      });
    }

    if (models.length === 0) return null;
    models.sort((a, b) => a.name.localeCompare(b.name));
    return models;
  } catch {
    return null;
  }
}
