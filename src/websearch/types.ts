export type SearchProvider =
	| "exa"
	| "tavily"
	| "serpdive"
	| "brave"
	| "duckduckgo-html"
	| "serper"
	| "google-cse"
	| "deepseek"
	| "z-ai"
	| "openai"
	| "openai-codex"
	| "codex"
	| "anthropic"
	| "perplexity"
	| "xai"
	| "kimi"
	| "kagi";

export type SearchContextSize = "low" | "medium" | "high";
export type CodexSearchMode = "cached" | "live";
export type RoutingStrategy = "priority" | "round-robin" | "fill-first";

export type NativeSearchAdapter =
	| "openai"
	| "codex"
	| "anthropic"
	| "xai"
	| "perplexity"
	| "z-ai"
	| "kimi"
	| "deepseek";

export interface SearchPolicy {
	maxResults?: number;
	timeoutMs?: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export interface NativeSearchOverride {
	adapter: NativeSearchAdapter;
	/** Complete search endpoint; otherwise derive it from the active provider's resolved URL. */
	endpoint?: string;
	/** Explicit opt-in to a different search model. Defaults to the active model ID. */
	model?: string;
}

export interface NativeRouteStatus {
	status: "ready" | "skipped";
	provider?: string;
	model?: string;
	adapter?: NativeSearchAdapter;
	reason?: string;
}

export type SearchFailureKind =
	| "unsupported"
	| "auth"
	| "quota"
	| "network"
	| "timeout"
	| "invalid-response"
	| "no-results"
	| "refusal"
	| "request";

export interface SearchProviderConfig {
	id?: string;
	provider: SearchProvider;
	apiKey?: string;
	headers?: Record<string, string | null>;
	baseUrl?: string;
	searchEngineId?: string;
	maxResults?: number;
	model?: string;
	codexMode?: CodexSearchMode;
	searchContextSize?: SearchContextSize;
	allowedDomains?: string[];
	blockedDomains?: string[];
	userLocation?: SearchUserLocation;
	timeoutMs?: number;
}

export interface SearchProviderEntry extends SearchProviderConfig {
	priority?: number;
	weight?: number;
}

export interface WebsearchConfig extends SearchPolicy {
	strategy: RoutingStrategy;
	fallback: boolean;
	auto: boolean;
	/** Opt in to the model-facing mode: "raw" escape hatch. */
	rawMode?: boolean;
	nativeOverrides?: Record<string, NativeSearchOverride | false>;
	providers: SearchProviderEntry[];
}

export interface SearchUserLocation {
	country?: string;
	region?: string;
	city?: string;
	timezone?: string;
}

export interface SearchRequest {
	query: string;
	maxResults: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export interface BuiltSearchRequest {
	url: string;
	/** Codex subscription endpoints require an incrementally decoded SSE response. */
	responseFormat?: "codex-sse";
	init: {
		method: "GET" | "POST";
		headers: Record<string, string>;
	};
	body?: JsonObject;
}

export interface SearchResultItem {
	title: string;
	url: string;
	snippet?: string;
	score?: number;
	source?: string;
	publishedAt?: string;
}

export interface SearchDetails {
	provider: SearchProvider;
	entryId?: string;
	query: string;
	results: SearchResultItem[];
	durationMs: number;
	truncated: boolean;
	strategy?: RoutingStrategy;
	attempts?: SearchAttempt[];
	answer?: string;
	error?: string;
	failureKind?: SearchFailureKind;
	httpStatus?: number;
	stage?: "native" | "fallback";
	mode?: "normal" | "raw";
	native?: NativeRouteStatus;
}

export interface SearchProgressDetails {
	phase: "searching";
	query: string;
	providerLabels: string[];
	maxResults: number;
	currentProvider?: string;
	attempts?: SearchAttempt[];
	routeLabels?: string[];
	strategy?: RoutingStrategy;
	allowedDomains?: string[];
	blockedDomains?: string[];
	native?: NativeRouteStatus;
	mode?: "normal" | "raw";
}

export type ConfigLoadFailureReason = "missing_config" | "invalid_config" | "missing_api_key";

export interface SearchErrorDetails {
	phase: "error";
	query: string;
	error: string;
	reason?: ConfigLoadFailureReason;
}

export type SearchRenderDetails = SearchDetails | SearchProgressDetails | SearchErrorDetails;

export interface SearchAttempt {
	provider: SearchProvider;
	entryId?: string;
	durationMs: number;
	resultsCount: number;
	error?: string;
	failureKind?: SearchFailureKind;
	httpStatus?: number;
	stage?: "native" | "fallback";
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue;
}

export type ConfigLoadResult =
	| { ok: true; config: WebsearchConfig; source: string }
	| {
			ok: false;
			reason: ConfigLoadFailureReason;
			message: string;
			source?: string;
	  };

export type ProviderValidationResult =
	| { ok: true; config: SearchProviderEntry }
	| { ok: false; reason: "invalid_config" | "missing_api_key"; message: string };
