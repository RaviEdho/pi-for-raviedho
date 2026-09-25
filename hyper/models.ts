import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import {
  HYPER_API_BASE_URL,
  HYPER_USER_AGENT,
  MODEL_FETCH_TIMEOUT_MS,
  MODELS_URL,
  PROVIDER_ID,
  PROVIDER_INFO_URL,
} from "./constants.js";
import type { ProviderModelPayload, ProviderPayload } from "./types.js";

const PI_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

const ON_OFF_THINKING_LEVEL_MAP: ThinkingLevelMap = {
  off: "off",
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: "max",
};

export const DEFAULT_HYPER_MODELS: Model<"openai-completions">[] = [
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: HYPER_API_BASE_URL,
    headers: { "User-Agent": HYPER_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 32768,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: HYPER_API_BASE_URL,
    headers: { "User-Agent": HYPER_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    input: ["text"],
    cost: { input: 2.4, output: 4.8, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: HYPER_API_BASE_URL,
    headers: { "User-Agent": HYPER_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    input: ["text"],
    cost: { input: 0.2, output: 0.4, cacheRead: 0.04, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "qwen3.8-max",
    name: "Qwen3.8-Max",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: HYPER_API_BASE_URL,
    headers: { "User-Agent": HYPER_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65536,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "qwen3.8-flash",
    name: "Qwen3.8-Flash",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: HYPER_API_BASE_URL,
    headers: { "User-Agent": HYPER_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "glm-5.3",
    name: "GLM 5.3",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: HYPER_API_BASE_URL,
    headers: { "User-Agent": HYPER_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    input: ["text"],
    cost: { input: 1.52432, output: 4.79072, cacheRead: 0.283088, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: HYPER_API_BASE_URL,
    headers: { "User-Agent": HYPER_USER_AGENT },
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    input: ["text", "image"],
    cost: { input: 3.2664, output: 16.332, cacheRead: 0.32664, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 16000,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  },
];

function getCachePath(): string {
  return join(homedir(), ".pi/agent/hyper-models-cache.json");
}

function loadCachedModels(): Model<"openai-completions">[] | null {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as Model<"openai-completions">[];
    }
  } catch {
    // Ignore cache load errors
  }
  return null;
}

function saveCachedModels(models: Model<"openai-completions">[]): void {
  try {
    const cachePath = getCachePath();
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(cachePath, JSON.stringify(models, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Ignore cache save errors
  }
}

function buildThinkingLevelMap(levels: string[]): ThinkingLevelMap | undefined {
  if (levels.length === 0) return undefined;
  const availableLevels = new Set<string>(levels);
  const disabledReasoningLevel = levels.find((level) => level === "off" || level === "none") ?? null;
  const result: ThinkingLevelMap = {
    off: disabledReasoningLevel,
  };
  for (const level of PI_THINKING_LEVELS) {
    result[level] = availableLevels.has(level) ? (level as ThinkingLevel) : null;
  }
  return result;
}

export function toHyperModel(model: ProviderModelPayload): Model<"openai-completions"> {
  const input: ("text" | "image")[] = model.supports_attachments ? ["text", "image"] : ["text"];
  const reasoningLevels = model.reasoning_levels ?? [];
  const supportsReasoningEffort = reasoningLevels.length > 0;
  const thinkingLevelMap = supportsReasoningEffort
    ? buildThinkingLevelMap(reasoningLevels)
    : model.can_reason
      ? ON_OFF_THINKING_LEVEL_MAP
      : undefined;

  return {
    id: model.id,
    name: model.name || model.id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: HYPER_API_BASE_URL,
    headers: { "User-Agent": HYPER_USER_AGENT },
    reasoning: model.can_reason,
    thinkingLevelMap,
    input,
    cost: {
      input: model.cost_per_1m_in,
      output: model.cost_per_1m_out,
      cacheRead: model.cost_per_1m_out_cached ?? 0,
      cacheWrite: model.cost_per_1m_in_cached ?? 0,
    },
    contextWindow: model.context_window,
    maxTokens: model.default_max_tokens,
    compat: {
      supportsStore: false,
      supportsReasoningEffort,
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens",
    },
  };
}

/**
 * Dynamically fetches the live model catalog from Charm Hyper.
 * Falls back to disk cache and then default hardcoded models on failure.
 */
export async function fetchHyperModels(
  token?: string,
  signal?: AbortSignal
): Promise<Model<"openai-completions">[]> {
  const headers: Record<string, string> = {
    "User-Agent": HYPER_USER_AGENT,
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // 1. Try /v1/provider endpoint which contains full pricing & reasoning details
  try {
    const timeoutSignal = AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const res = await fetch(PROVIDER_INFO_URL, {
      method: "GET",
      headers,
      signal: combinedSignal,
    });

    if (res.ok) {
      const data = (await res.json()) as ProviderPayload;
      if (Array.isArray(data.models) && data.models.length > 0) {
        const models = data.models.map(toHyperModel);
        saveCachedModels(models);
        return models;
      }
    }
  } catch {
    // Non-fatal, try fallback endpoint
  }

  // 2. Try /v1/models endpoint as fallback
  try {
    const timeoutSignal = AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const res = await fetch(MODELS_URL, {
      method: "GET",
      headers,
      signal: combinedSignal,
    });

    if (res.ok) {
      const data = (await res.json()) as { data?: unknown[] };
      if (Array.isArray(data.data) && data.data.length > 0) {
        const models: Model<"openai-completions">[] = [];
        for (const item of data.data) {
          if (item && typeof item === "object" && "id" in item) {
            const raw = item as Record<string, unknown>;
            const id = String(raw.id);
            const name = typeof raw.display_name === "string" ? raw.display_name : id;
            const contextWindow = typeof raw.context_window === "number" ? raw.context_window : 1000000;
            const maxTokens = typeof raw.max_output_tokens === "number" ? raw.max_output_tokens : 32768;
            const capabilities = raw.capabilities as { vision?: boolean } | undefined;
            const supportsAttachments = capabilities?.vision ?? false;
            const reasoning = raw.reasoning as {
              effort_levels?: Array<{ value: string; display: string }>;
            } | undefined;
            const reasoningLevels = reasoning?.effort_levels?.map((e) => e.value) ?? [];
            const canReason = reasoningLevels.length > 0 || !!raw.reasoning;
            const pricing = raw.pricing as {
              input?: number;
              output?: number;
              cache_create?: number;
              cache_hit?: number;
            } | undefined;

            models.push(
              toHyperModel({
                id,
                name,
                cost_per_1m_in: pricing?.input ?? 0,
                cost_per_1m_out: pricing?.output ?? 0,
                cost_per_1m_in_cached: pricing?.cache_create ?? 0,
                cost_per_1m_out_cached: pricing?.cache_hit ?? 0,
                context_window: contextWindow,
                default_max_tokens: maxTokens,
                can_reason: canReason,
                reasoning_levels: reasoningLevels.length > 0 ? reasoningLevels : undefined,
                supports_attachments: supportsAttachments,
              })
            );
          }
        }
        if (models.length > 0) {
          saveCachedModels(models);
          return models;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // 3. Fallback to cached models from disk or built-in defaults
  const cached = loadCachedModels();
  return cached && cached.length > 0 ? cached : DEFAULT_HYPER_MODELS;
}
