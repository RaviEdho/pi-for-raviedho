import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  ANTIGRAVITY_PRIMARY_ENDPOINT,
  FETCH_AVAILABLE_MODELS_URL,
  getAntigravityUserAgent,
} from "./constants.js";
import type { AntigravityDiscoveryApiModel, AntigravityDiscoveryResponse } from "./types.js";

/** Default offline/pre-fetch fallback catalog */
export const DEFAULT_ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 },
    contextWindow: 1048576,
    maxTokens: 65535,
  },
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
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
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
];

const DISCOVERY_DENYLIST: Record<string, true> = {
  chat_20706: true,
  chat_23310: true,
  "gemini-2.5-pro": true,
  tab_flash_lite_preview: true,
  tab_jump_flash_lite_preview: true,
};

/**
 * Collapses raw Antigravity wire models into user-facing logical families.
 * Mirrors omp's _collapse.kdl rules.
 */
export function collapseAntigravityModels(
  rawModels: Record<string, AntigravityDiscoveryApiModel>
): ProviderModelConfig[] {
  const families = new Map<string, ProviderModelConfig>();

  for (const [id, info] of Object.entries(rawModels)) {
    if (DISCOVERY_DENYLIST[id] || info.isInternal) continue;

    let logicalId = id;
    let displayName = info.displayName || id;

    const flashMatch = id.match(/^(gemini-3\.[5-9]-flash)(?:-(?:extra-low|low|medium|high|tiered|agent))?$/);
    if (flashMatch) {
      logicalId = flashMatch[1]!;
      const rev = logicalId.replace("gemini-", "").replace("-flash", "");
      displayName = `Gemini ${rev} Flash`;
    } else if (id.startsWith("gemini-3.1-pro") || id === "gemini-pro-agent") {
      logicalId = "gemini-3.1-pro";
      displayName = "Gemini 3.1 Pro";
    } else if (id.startsWith("gemini-3-flash")) {
      logicalId = "gemini-3-flash";
      displayName = "Gemini 3 Flash";
    } else if (id.startsWith("claude-opus-4-6")) {
      logicalId = "claude-opus-4-6";
      displayName = "Claude Opus 4.6";
    } else if (id.startsWith("claude-sonnet-4-6")) {
      logicalId = "claude-sonnet-4-6";
      displayName = "Claude Sonnet 4.6";
    } else if (id.startsWith("gpt-oss-120b")) {
      logicalId = "gpt-oss-120b";
      displayName = "GPT-OSS 120B";
    } else if (id === "gemini-2.5-flash" || id === "gemini-2.5-flash-thinking") {
      logicalId = "gemini-2.5-flash";
      displayName = "Gemini 2.5 Flash";
    } else if (id === "gemini-2.5-flash-lite") {
      logicalId = "gemini-2.5-flash-lite";
      displayName = "Gemini 2.5 Flash Lite";
    } else if (id === "gemini-3.1-flash-lite") {
      logicalId = "gemini-3.1-flash-lite";
      displayName = "Gemini 3.1 Flash Lite";
    }

    if (!families.has(logicalId)) {
      const isClaude = logicalId.startsWith("claude-");
      const isFlash = logicalId.includes("flash");
      const isGptOss = logicalId.startsWith("gpt-oss");

      let cost = { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 };
      if (isGptOss) {
        cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      } else if (isFlash) {
        cost = { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 };
      } else if (logicalId.includes("opus")) {
        cost = { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 };
      } else if (isClaude) {
        cost = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
      }

      families.set(logicalId, {
        id: logicalId,
        name: displayName,
        reasoning: isGptOss ? true : (info.supportsThinking ?? true),
        input: isGptOss || !info.supportsImages ? ["text"] : ["text", "image"],
        cost,
        contextWindow: isClaude ? 200000 : isGptOss ? 131072 : 1048576,
        maxTokens: isClaude ? 64000 : isGptOss ? 8192 : 65535,
        baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
      });
    }
  }

  return Array.from(families.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetch discoverable models dynamically from Cloud Code Assist and collapse them.
 */
export async function fetchAndCollapseAntigravityModels(
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

    const collapsed = collapseAntigravityModels(data.models);
    return collapsed.length > 0 ? collapsed : null;
  } catch {
    return null;
  }
}
