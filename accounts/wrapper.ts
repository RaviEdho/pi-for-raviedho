import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AccountBalancer, extractCooldownMs, isRateLimitError } from "./balancer.js";
import { QuotaManager } from "./quota.js";
import { AccountStore } from "./store.js";
import type { ResolvedAccountAuth } from "./types.js";

export type StreamSimpleExecutor = (
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  auth: ResolvedAccountAuth
) => AssistantMessageEventStream;

/**
 * Creates an event stream that transparently handles multi-account load balancing
 * and automatic failover on rate limits (429 / quota exhaustion).
 */
export function executeWithMultiAccountFailover(
  providerId: string,
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  executor: StreamSimpleExecutor
): AssistantMessageEventStream {
  const outerStream = createAssistantMessageEventStream();
  const balancer = AccountBalancer.getInstance();
  const store = AccountStore.getInstance();

  (async () => {
    const totalAccounts = store.list(providerId);
    const hasConfiguredAccounts = totalAccounts.length > 0;
    const suppliedApiKey = options?.apiKey?.trim();

    if (!hasConfiguredAccounts && !suppliedApiKey) {
      const errorMsg: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: providerId,
        model: model.id,
        stopReason: "error",
        errorMessage: `No accounts configured for provider: ${providerId}`,
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      outerStream.push({ type: "error", reason: "error", error: errorMsg });
      return;
    }

    const excludedIds: string[] = [];
    const maxAttempts = Math.max(1, totalAccounts.length);
    let attempts = 0;
    let lastError: AssistantMessage | null = null;
    let streamStarted = false;

    while (attempts < maxAttempts) {
      if (options?.signal?.aborted) {
        break;
      }

      attempts++;
      let resolvedAuth: ResolvedAccountAuth | null = null;
      if (hasConfiguredAccounts) {
        try {
          resolvedAuth = await balancer.selectAccount(providerId, options?.sessionId, excludedIds, model.id);
        } catch (authErr) {
          console.error(`[MultiAccount] Error selecting account for ${providerId}:`, authErr);
        }
      } else if (suppliedApiKey) {
        resolvedAuth = {
          account: {
            id: `${providerId}:api-key`,
            provider: providerId,
            type: "api_key",
            apiKey: suppliedApiKey,
            access: suppliedApiKey,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          token: suppliedApiKey,
        };
      }

      if (!resolvedAuth) {
        break;
      }

      const account = resolvedAuth.account;
      excludedIds.push(account.id);

      let innerStream: AssistantMessageEventStream;
      try {
        innerStream = executor(model, context, options, resolvedAuth);
      } catch (initErr) {
        if (hasConfiguredAccounts && isRateLimitError(initErr)) {
          const cooldown = extractCooldownMs(initErr);
          balancer.markRateLimited(account.id, cooldown, String(initErr));
          continue; // Try next account
        }
        // Non-retryable setup error
        const errorMsg: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: providerId,
          model: model.id,
          stopReason: "error",
          errorMessage: initErr instanceof Error ? initErr.message : String(initErr),
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        outerStream.push({ type: "error", reason: "error", error: errorMsg });
        return;
      }

      let emittedTokens = false;
      let shouldFailover = false;
      const bufferedEvents: AssistantMessageEvent[] = [];

      const flushBuffered = () => {
        while (bufferedEvents.length > 0) {
          const ev = bufferedEvents.shift()!;
          streamStarted = true;
          outerStream.push(ev);
        }
      };

      try {
        for await (const event of innerStream) {
          if (options?.signal?.aborted) {
            break;
          }

          if (event.type === "text_delta" || event.type === "thinking_delta") {
            emittedTokens = true;
          }

          if (event.type === "error") {
            const errorText = event.error.errorMessage || "";
            if (!emittedTokens && isRateLimitError(errorText) && hasConfiguredAccounts) {
              // Rate limit error before any tokens: discard buffered start event and fail over
              bufferedEvents.length = 0;
              const cooldown = extractCooldownMs(errorText);
              balancer.markRateLimited(account.id, cooldown, errorText);
              lastError = event.error;
              shouldFailover = true;
              break;
            }
          }

          // Buffer start event until first token/content or terminal event
          if (event.type === "start" && !emittedTokens) {
            bufferedEvents.push(event);
            continue;
          }

          // Flush any buffered start event before emitting content or errors
          flushBuffered();
          streamStarted = true;
          outerStream.push(event);
        }
      } catch (streamErr) {
        if (!emittedTokens && isRateLimitError(streamErr) && hasConfiguredAccounts) {
          bufferedEvents.length = 0;
          const cooldown = extractCooldownMs(streamErr);
          balancer.markRateLimited(account.id, cooldown, String(streamErr));
          shouldFailover = true;
        } else {
          flushBuffered();
          const errorMsg: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: providerId,
            model: model.id,
            stopReason: "error",
            errorMessage: streamErr instanceof Error ? streamErr.message : String(streamErr),
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          outerStream.push({ type: "error", reason: "error", error: errorMsg });
          return;
        }
      }

      if (!shouldFailover) {
        // Successful or gracefully completed turn
        return;
      }
    }

    // If all candidate accounts failed or were exhausted
    if (!streamStarted) {
      let exhaustionMessage: string;
      if (hasConfiguredAccounts) {
        const remainingAccounts = store.list(providerId);
        const quotaManager = QuotaManager.getInstance();
        const cooldownList = remainingAccounts
          .map((a) => {
            const name = a.email || a.accountId || a.id;
            const health = quotaManager.evaluateAccountHealth(a, model.id);
            const resetMs = a.blockedUntil || health.resetTimeMs;
            const mins = resetMs && resetMs > Date.now()
              ? Math.max(1, Math.ceil((resetMs - Date.now()) / 60000))
              : 0;
            const reason =
              a.blockedReason ||
              health.reason ||
              (health.isExhausted ? "Quota exhausted" : "Rate limited");
            return `  - ${name}: cooldown ~${mins}m (${reason})`;
          })
          .join("\n");

        exhaustionMessage =
          `All ${remainingAccounts.length} account(s) for provider "${providerId}" are currently rate-limited or exhausted:\n` +
          cooldownList +
          (lastError?.errorMessage ? `\n\nLast error: ${lastError.errorMessage}` : "");
      } else {
        exhaustionMessage =
          lastError?.errorMessage ||
          `Request failed for provider "${providerId}" with supplied API key.`;
      }

      const errorMsg: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: providerId,
        model: model.id,
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: exhaustionMessage,
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };

      outerStream.push({
        type: "error",
        reason: options?.signal?.aborted ? "aborted" : "error",
        error: errorMsg,
      });
    }
  })().catch((fatalErr) => {
    const errorMsg: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: providerId,
      model: model.id,
      stopReason: "error",
      errorMessage: fatalErr instanceof Error ? fatalErr.message : String(fatalErr),
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    outerStream.push({ type: "error", reason: "error", error: errorMsg });
  });

  return outerStream;
}
