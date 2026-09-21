import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  ANTIGRAVITY_PRIMARY_ENDPOINT,
  ANTIGRAVITY_WIRE_PROFILES,
  getAntigravityUserAgent,
} from "./constants.js";
import { parseAntigravityApiKey } from "./oauth.js";
import type { CloudCodeAssistResponseChunk } from "./types.js";

const INT63_MASK = (1n << 63n) - 1n;
const ANTIGRAVITY_RANDOM_BOUND = 9_000_000_000_000_000_000n;

function randomSignedDecimalSessionId(): string {
  let value = 0n;
  while (true) {
    const bytes = randomBytes(8);
    let candidate = 0n;
    for (const byte of bytes) {
      candidate = (candidate << 8n) | BigInt(byte);
    }
    candidate &= INT63_MASK;
    if (candidate < ANTIGRAVITY_RANDOM_BOUND) {
      value = candidate;
      break;
    }
  }
  return `-${value.toString()}`;
}

function deriveSignedDecimalSessionId(text: string): string {
  const digest = createHash("sha256").update(text).digest();
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(digest[index] ?? 0);
  }
  return `-${(value & INT63_MASK).toString()}`;
}
function isThinkingPart(part: { thought?: boolean }): boolean {
  return part.thought === true;
}

function retainThoughtSignature(existing?: string, incoming?: string): string | undefined {
  return typeof incoming === "string" && incoming.length > 0 ? incoming : existing;
}

function mapStopReasonString(reason: string): "stop" | "length" | "error" {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    default:
      return "error";
  }
}

function convertMessagesToGemini(transcript: TranscriptContext): Record<string, unknown>[] {
  const contents: Record<string, unknown>[] = [];

  for (const msg of transcript.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: msg.content }],
        });
      } else {
        const parts = msg.content.map((item) => {
          if (item.type === "text") {
            return { text: item.text };
          }
          return {
            inlineData: {
              mimeType: item.mimeType,
              data: item.data,
            },
          };
        });
        if (parts.length > 0) {
          contents.push({ role: "user", parts });
        }
      }
    } else if (msg.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text && block.text.trim()) {
            parts.push({
              text: block.text,
              ...(block.textSignature ? { thoughtSignature: block.textSignature } : {}),
            });
          }
        } else if (block.type === "thinking") {
          if (block.thinking && block.thinking.trim()) {
            parts.push({
              thought: true,
              text: block.thinking,
              ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
            });
          }
        } else if (block.type === "toolCall") {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.arguments ?? {},
              id: block.id,
            },
            ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
          });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
    } else if (msg.role === "toolResult") {
      const textContent = msg.content.filter((c) => c.type === "text");
      const textResult = textContent.map((c) => c.text).join("\n");
      const functionResponsePart = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: textResult } : { output: textResult },
          ...(msg.toolCallId ? { id: msg.toolCallId } : {}),
        },
      };

      const lastContent = contents[contents.length - 1];
      if (
        lastContent &&
        lastContent.role === "user" &&
        Array.isArray(lastContent.parts) &&
        lastContent.parts.some((p: Record<string, unknown>) => p.functionResponse)
      ) {
        lastContent.parts.push(functionResponsePart);
      } else {
        contents.push({
          role: "user",
          parts: [functionResponsePart],
        });
      }
    }
  }

  return contents;
}

function normalizeAntigravityTools(
  tools: Tool[],
  isClaude: boolean
): Array<{ functionDeclarations: Record<string, unknown>[] }> | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const cleaned = cleanSchema(tool.parameters);
        return {
          name: tool.name,
          description: tool.description,
          ...(isClaude ? { parameters: cleaned } : { parametersJsonSchema: cleaned }),
        };
      }),
    },
  ];
}

function resolveWireModelId(modelId: string, thinkingEnabled: boolean): string {
  if (modelId === "gemini-3.1-pro") {
    return thinkingEnabled ? "gemini-pro-agent" : "gemini-3.1-pro-low";
  }
  if (modelId === "gemini-3.5-flash") {
    return thinkingEnabled ? "gemini-3-flash-agent" : "gemini-3.5-flash-extra-low";
  }
  if (modelId === "claude-opus-4-6") {
    return "claude-opus-4-6-thinking";
  }
  if (modelId === "claude-sonnet-4-5") {
    return thinkingEnabled ? "claude-sonnet-4-5-thinking" : "claude-sonnet-4-5";
  }
  if (modelId === "claude-opus-4-5") {
    return thinkingEnabled ? "claude-opus-4-5-thinking" : "claude-opus-4-5";
  }
  return modelId;
}

function cleanSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);

  const copy: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  delete copy["$schema"];

  for (const combiner of ["anyOf", "oneOf"]) {
    const variants = copy[combiner];
    if (Array.isArray(variants)) {
      const nonNull = variants.filter(
        (v) => v && typeof v === "object" && (v as { type?: unknown }).type !== "null"
      );
      const hasNull = variants.some(
        (v) => v && typeof v === "object" && (v as { type?: unknown }).type === "null"
      );

      if (hasNull && nonNull.length === 1) {
        const unwrapped = cleanSchema(nonNull[0]);
        delete copy[combiner];
        if (unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) {
          Object.assign(copy, unwrapped);
        }
      } else {
        copy[combiner] = variants.map(cleanSchema);
      }
    }
  }

  if (copy.properties && typeof copy.properties === "object" && !Array.isArray(copy.properties)) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(copy.properties)) {
      props[k] = cleanSchema(v);
    }
    copy.properties = props;
  }

  if (copy.items) {
    copy.items = cleanSchema(copy.items);
  }

  return copy;
}


/**
 * Parses an SSE text stream into structured JSON events.
 */
async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<CloudCodeAssistResponseChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Stream aborted by caller");
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") return;
          try {
            const parsed: unknown = JSON.parse(dataStr);
            if (parsed && typeof parsed === "object") {
              yield parsed as CloudCodeAssistResponseChunk;
            }
          } catch {
            // Ignore malformed intermediate chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Custom streamSimple implementation for Google Antigravity.
 */
export function streamAntigravity(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const eventStream = createAssistantMessageEventStream();
  const transcript = collapseSystemMessages(context);
  const systemPrompt = getCurrentSystemPrompt(transcript.messages);
  const tools = getCurrentTools(transcript.messages);

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      const rawApiKey = options?.apiKey;
      if (!rawApiKey) {
        throw new Error(
          "Antigravity requires authentication. Run /login google-antigravity or provide an access token."
        );
      }

      const credentials = await parseAntigravityApiKey(rawApiKey);
      const isClaude = model.id.startsWith("claude-");
      const thinkingEnabled = Boolean(options?.reasoning);
      const wireModelId = resolveWireModelId(model.id, thinkingEnabled);
      const wireProfile = ANTIGRAVITY_WIRE_PROFILES[wireModelId];

      const agentId = randomUUID();
      const trajectoryId = randomUUID();
      const step = 2;
      const requestId = `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`;

      const firstUserMessage = transcript.messages.find((m) => m.role === "user");
      const sessionSeed = firstUserMessage ? JSON.stringify(firstUserMessage) : randomUUID();
      const sessionId = deriveSignedDecimalSessionId(sessionSeed) || randomSignedDecimalSessionId();

      const labels: Record<string, string> = {
        trajectory_id: trajectoryId,
        last_step_index: String(step - 1),
        used_claude: String(isClaude),
        used_claude_conservative: String(isClaude),
      };
      if (wireProfile?.modelEnum) {
        labels.model_enum = wireProfile.modelEnum;
      }

      // Convert messages and tools to Cloud Code Assist format
      const contents = convertMessagesToGemini(transcript);
      const convertedTools = normalizeAntigravityTools(tools, isClaude);
      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: wireProfile?.maxOutputTokens ?? (isClaude ? 64000 : 65535),
      };
      if (options?.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
      }
      if (thinkingEnabled) {
        generationConfig.thinkingConfig = {
          includeThoughts: true,
          thinkingBudget: 4000,
        };
      }

      const requestPayload: Record<string, unknown> = {
        contents,
        generationConfig,
        sessionId,
        labels,
      };

      if (systemPrompt) {
        requestPayload.systemInstruction = {
          role: "user",
          parts: [{ text: systemPrompt }],
        };
      }

      if (convertedTools && convertedTools.length > 0) {
        requestPayload.tools = convertedTools;
        requestPayload.toolConfig = {
          functionCallingConfig: { mode: "VALIDATED" },
        };
      } else if (isClaude) {
        // Claude routes always expect VALIDATED mode
        requestPayload.toolConfig = {
          functionCallingConfig: { mode: "VALIDATED" },
        };
      }

      const envelope: Record<string, unknown> = {
        requestId,
        request: requestPayload,
        model: wireModelId,
        userAgent: "antigravity",
        requestType: "agent",
      };

      const finalPayload = (await options?.onPayload?.(envelope, model)) ?? envelope;

      const requestUrl = `${ANTIGRAVITY_PRIMARY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": getAntigravityUserAgent(),
        },
        body: JSON.stringify(finalPayload),
        signal: options?.signal,
      });
      if (options?.onResponse) {
        const headersRecord: Record<string, string> = {};
        response.headers.forEach((val, key) => {
          headersRecord[key] = val;
        });
        await options.onResponse({ status: response.status, headers: headersRecord }, model);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud Code Assist API error (${response.status}): ${errorText}`);
      }

      if (!response.body) {
        throw new Error("No response body received from Cloud Code Assist");
      }

      eventStream.push({ type: "start", partial: output });

      let currentBlock: TextContent | ThinkingContent | null = null;
      let toolCallCount = 0;

      const finishCurrentBlock = () => {
        if (!currentBlock) return;
        const blockIndex = output.content.length - 1;
        if (currentBlock.type === "text") {
          eventStream.push({
            type: "text_end",
            contentIndex: blockIndex,
            content: currentBlock.text,
            partial: output,
          });
        } else if (currentBlock.type === "thinking") {
          eventStream.push({
            type: "thinking_end",
            contentIndex: blockIndex,
            content: currentBlock.thinking,
            partial: output,
          });
        }
        currentBlock = null;
      };

      for await (const chunk of parseSseStream(response.body, options?.signal)) {
        if (chunk.error) {
          throw new Error(`Stream error: ${chunk.error.message || chunk.error.status || JSON.stringify(chunk.error)}`);
        }

        const responseData = (chunk as unknown as { response?: CloudCodeAssistResponseChunk }).response ?? chunk;
        const candidate = responseData.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== undefined && part.text !== "") {
              const isThinking = isThinkingPart(part);
              if (isThinking) {
                if (currentBlock?.type !== "thinking") {
                  finishCurrentBlock();
                  const newBlock: ThinkingContent = {
                    type: "thinking",
                    thinking: "",
                    thinkingSignature: part.thoughtSignature,
                  };
                  output.content.push(newBlock);
                  currentBlock = newBlock;
                  eventStream.push({
                    type: "thinking_start",
                    contentIndex: output.content.length - 1,
                    partial: output,
                  });
                }
                currentBlock.thinking += part.text;
                currentBlock.thinkingSignature = retainThoughtSignature(
                  currentBlock.thinkingSignature,
                  part.thoughtSignature
                );
                eventStream.push({
                  type: "thinking_delta",
                  contentIndex: output.content.length - 1,
                  delta: part.text,
                  partial: output,
                });
              } else {
                if (currentBlock?.type !== "text") {
                  finishCurrentBlock();
                  const newBlock: TextContent = {
                    type: "text",
                    text: "",
                    textSignature: part.thoughtSignature,
                  };
                  output.content.push(newBlock);
                  currentBlock = newBlock;
                  eventStream.push({
                    type: "text_start",
                    contentIndex: output.content.length - 1,
                    partial: output,
                  });
                }
                currentBlock.text += part.text;
                currentBlock.textSignature = retainThoughtSignature(
                  currentBlock.textSignature,
                  part.thoughtSignature
                );
                eventStream.push({
                  type: "text_delta",
                  contentIndex: output.content.length - 1,
                  delta: part.text,
                  partial: output,
                });
              }
            }

            if (part.functionCall) {
              finishCurrentBlock();
              toolCallCount += 1;
              const callId = part.functionCall.id || `call_${randomUUID().slice(0, 8)}_${toolCallCount}`;
              const toolArgs: JsonObject = (part.functionCall.args || {}) as JsonObject;
              const toolCall: ToolCall = {
                type: "toolCall",
                id: callId,
                name: part.functionCall.name || "",
                arguments: toolArgs,
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              };

              output.content.push(toolCall);
              const toolIndex = output.content.length - 1;

              eventStream.push({
                type: "toolcall_start",
                contentIndex: toolIndex,
                partial: output,
              });
              eventStream.push({
                type: "toolcall_delta",
                contentIndex: toolIndex,
                delta: JSON.stringify(toolCall.arguments),
                partial: output,
              });
              eventStream.push({
                type: "toolcall_end",
                contentIndex: toolIndex,
                toolCall,
                partial: output,
              });
            }
          }
        }

        if (candidate?.finishReason) {
          const mapped = mapStopReasonString(candidate.finishReason);
          if ((mapped === "stop" || mapped === "length") && output.content.some((b) => b.type === "toolCall")) {
            output.stopReason = "toolUse";
          } else {
            output.stopReason = mapped;
            if (mapped === "error") {
              output.errorMessage = `Generation stopped with reason: ${candidate.finishReason}`;
            }
          }
        }

        if (responseData.usageMetadata) {
          const promptTokens = responseData.usageMetadata.promptTokenCount || 0;
          const cacheRead = responseData.usageMetadata.cachedContentTokenCount || 0;
          const outputTokens = responseData.usageMetadata.candidatesTokenCount || 0;
          const thinkingTokens = responseData.usageMetadata.thoughtsTokenCount || 0;

          output.usage = {
            input: Math.max(0, promptTokens - cacheRead),
            output: outputTokens + thinkingTokens,
            cacheRead,
            cacheWrite: 0,
            totalTokens: responseData.usageMetadata.totalTokenCount || promptTokens + outputTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          calculateCost(model, output.usage);
        }
      }

      finishCurrentBlock();

      if (output.stopReason === "pending") {
        output.stopReason = output.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
      }

      if (output.stopReason === "error" || output.stopReason === "aborted") {
        eventStream.push({
          type: "error",
          reason: output.stopReason,
          error: output,
        });
      } else {
        eventStream.push({
          type: "done",
          reason: output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">,
          message: output,
        });
      }
      eventStream.end();
    } catch (err) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      eventStream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      eventStream.end();
    }
  })();

  return eventStream;
}
