export interface RawCodexCatalogModel {
  slug: string;
  display_name?: string;
  priority?: number;
  available_in_plans?: string[];
  supported_in_api?: boolean;
  context_window?: number;
  max_context_window?: number;
}

export interface RawCodexCatalogResponse {
  models?: RawCodexCatalogModel[];
}

export interface CodexModelSummary {
  slug: string;
  displayName: string;
  availableInPlans: string[];
  contextWindow?: number;
}

export interface CodexCatalogCache {
  updatedAt: number;
  models: CodexModelSummary[];
}
