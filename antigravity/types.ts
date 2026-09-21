import type { OAuthCredentials } from "@earendil-works/pi-ai";

/** Stored OAuth credentials including discovered Google Cloud Project ID */
export interface AntigravityOAuthCredentials extends OAuthCredentials {
  projectId: string;
  email?: string;
}

/** Structured API key passed to streamSimple via options.apiKey */
export interface AntigravityApiKeyPayload {
  accessToken: string;
  projectId: string;
  email?: string;
}

export interface LoadCodeAssistResponse {
  currentTier?: { id?: string } | null;
  paidTier?: { id?: string } | null;
  allowedTiers?: Array<{ id?: string }>;
  ineligibleTiers?: Array<{
    tierId?: string;
    reasonMessage?: string;
    validationUrl?: string;
  }>;
  cloudaicompanionProject?: string;
}

export interface OnboardOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string } | null;
  response?: { "@type"?: string; cloudaicompanionProject?: string } | null;
}

export interface AntigravityDiscoveryApiModel {
  displayName?: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  recommended?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
  model?: string;
  apiProvider?: string;
  modelProvider?: string;
  isInternal?: boolean;
  supportsVideo?: boolean;
}

export interface AntigravityDiscoveryResponse {
  models?: Record<string, AntigravityDiscoveryApiModel>;
}

export interface CloudCodeAssistPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
    id?: string;
  };
}

export interface CloudCodeAssistCandidate {
  content?: {
    role?: string;
    parts?: CloudCodeAssistPart[];
  };
  finishReason?: string;
}

export interface CloudCodeAssistUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface CloudCodeAssistResponseChunk {
  responseId?: string;
  candidates?: CloudCodeAssistCandidate[];
  usageMetadata?: CloudCodeAssistUsageMetadata;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}
