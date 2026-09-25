export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval?: number;
}

export interface DevicePollSuccess {
  refresh_token: string;
  team_id: string;
  team_name: string;
  user_id: string;
}

export interface DevicePollError {
  error: string;
  error_description?: string;
}

export type DevicePollResponse = DevicePollSuccess | DevicePollError;

export interface TokenExchangeResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expiry?: string;
  expires_in?: number;
  expires_at?: number;
}

export interface CreditsResponse {
  balance?: number;
  balance_usd?: number;
}

export interface ProviderModelPayload {
  id: string;
  name: string;
  cost_per_1m_in: number;
  cost_per_1m_out: number;
  cost_per_1m_in_cached: number;
  cost_per_1m_out_cached?: number;
  context_window: number;
  default_max_tokens: number;
  can_reason: boolean;
  reasoning_levels?: string[];
  default_reasoning_effort?: string;
  supports_attachments: boolean;
}

export interface ProviderPayload {
  id?: string;
  name?: string;
  models: ProviderModelPayload[];
}

export interface HyperOAuthCredentials {
  access: string;
  refresh?: string;
  expires?: number;
  teamName?: string;
  teamId?: string;
  userId?: string;
  email?: string;
}
