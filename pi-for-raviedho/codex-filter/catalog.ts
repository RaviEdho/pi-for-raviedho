import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CodexCatalogCache,
  CodexModelSummary,
  RawCodexCatalogResponse,
} from "./types.js";

const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_FALLBACK_FREE_MODELS = [
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-reserve",
];

let memoryCache: CodexCatalogCache | null = null;

function getCacheFilePath(): string {
  return join(homedir(), ".pi/agent/codex-catalog-cache.json");
}

/**
 * Loads the cached Codex catalog from memory or disk.
 */
export function loadCachedCatalog(): CodexModelSummary[] | null {
  if (memoryCache && Date.now() - memoryCache.updatedAt < CACHE_TTL_MS) {
    return memoryCache.models;
  }

  const cachePath = getCacheFilePath();
  if (existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, "utf-8");
      const parsed = JSON.parse(raw) as CodexCatalogCache;
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.models) &&
        typeof parsed.updatedAt === "number"
      ) {
        memoryCache = parsed;
        return parsed.models;
      }
    } catch {
      // Fall through on corrupt cache
    }
  }

  return memoryCache ? memoryCache.models : null;
}

/**
 * Persists the discovered catalog to disk and memory.
 */
export function saveCachedCatalog(models: CodexModelSummary[]): void {
  memoryCache = {
    updatedAt: Date.now(),
    models,
  };

  try {
    const cachePath = getCacheFilePath();
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(memoryCache, null, 2), "utf-8");
  } catch {
    // Non-fatal if disk write fails
  }
}

/**
 * Fetches the live model catalog from OpenAI's Codex endpoint.
 */
export async function fetchLiveCodexCatalog(
  accessToken: string,
  accountId: string,
  signal?: AbortSignal
): Promise<CodexModelSummary[]> {
  const res = await fetch(CODEX_MODELS_ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
      accept: "application/json",
      originator: "pi",
      "User-Agent": "pi",
    },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Codex models: HTTP ${res.status}`);
  }

  const data = (await res.json()) as RawCodexCatalogResponse;
  if (!data?.models || !Array.isArray(data.models)) {
    return [];
  }

  const summaries: CodexModelSummary[] = data.models
    .filter((m) => m && typeof m.slug === "string")
    .map((m) => ({
      slug: m.slug,
      displayName: m.display_name || m.slug,
      availableInPlans: Array.isArray(m.available_in_plans) ? m.available_in_plans : [],
      contextWindow: m.context_window,
    }));

  if (summaries.length > 0) {
    saveCachedCatalog(summaries);
  }

  return summaries;
}
