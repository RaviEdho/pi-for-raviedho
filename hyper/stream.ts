import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { QuotaManager } from "../accounts/quota.js";
import type { ResolvedAccountAuth } from "../accounts/types.js";
import { HYPER_USER_AGENT } from "./constants.js";

/**
 * Streams completion requests to Charm Hyper via OpenAI Completions API.
 */
export function streamHyper(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  auth: ResolvedAccountAuth
): AssistantMessageEventStream {
  const customHeaders: Record<string, string> = {
    ...options?.headers,
    "User-Agent": HYPER_USER_AGENT,
  };

  const streamOptions: SimpleStreamOptions = {
    ...options,
    apiKey: auth.token,
    headers: customHeaders,
  };

  const innerStream = openAICompletionsApi().streamSimple(
    model as Model<"openai-completions">,
    context,
    streamOptions
  );

  return innerStream;
}
