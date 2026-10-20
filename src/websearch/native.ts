import { createHash } from "node:crypto";

import { isAllowedProviderBaseUrl, nativeSearchEndpoint } from "./provider-endpoints.js";
import { hasAuthHeader, hasHeaderTombstone, mergeHeadersWithTombstones } from "./providers/shared.js";
import type {
	NativeRouteStatus,
	NativeSearchAdapter,
	SearchProvider,
	SearchProviderEntry,
	WebsearchConfig,
} from "./types.js";

export interface NativeModelInfo {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
	headers?: Record<string, string | null>;
}

export type NativeAuthResult =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string | null>;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };

export interface NativeModelRegistry {
	getApiKeyAndHeaders(model: NativeModelInfo): Promise<NativeAuthResult>;
}

export interface NativeAdapterResolution {
	status: NativeRouteStatus;
	adapter?: NativeSearchAdapter;
	model?: string;
	endpoint?: string;
}

interface KnownProviderAdapter {
	adapter: NativeSearchAdapter;
	/** Required chat protocol for hosted-tool adapters. Undefined for dedicated search endpoints. */
	api?: string;
}

interface NativeCapability {
	adapter: NativeSearchAdapter;
	model: string;
	explicitEndpoint?: string;
}

type CapabilityResult = { ok: true; capability: NativeCapability } | { ok: false; status: NativeRouteStatus };

const KNOWN_PROVIDERS: Record<string, KnownProviderAdapter> = {
	openai: { adapter: "openai", api: "openai-responses" },
	anthropic: { adapter: "anthropic", api: "anthropic-messages" },
	xai: { adapter: "xai", api: "openai-responses" },
	zai: { adapter: "z-ai", api: "openai-completions" },
	"zai-coding-cn": { adapter: "z-ai", api: "openai-completions" },
	"z-ai": { adapter: "z-ai", api: "openai-completions" },
	perplexity: { adapter: "perplexity", api: "openai-completions" },
	"kimi-coding": { adapter: "kimi" },
	deepseek: { adapter: "deepseek" },
	"openai-codex": { adapter: "codex", api: "openai-codex-responses" },
};

const NATIVE_ADAPTERS: ReadonlySet<NativeSearchAdapter> = new Set<NativeSearchAdapter>([
	"openai",
	"codex",
	"anthropic",
	"xai",
	"perplexity",
	"z-ai",
	"kimi",
	"deepseek",
]);

const SEARCH_PROVIDER_BY_ADAPTER: Record<NativeSearchAdapter, SearchProvider> = {
	openai: "openai",
	codex: "openai-codex",
	anthropic: "anthropic",
	xai: "xai",
	perplexity: "perplexity",
	"z-ai": "z-ai",
	kimi: "kimi",
	deepseek: "deepseek",
};

function normalizeProviderId(provider: string): string {
	return provider === "z-ai" ? "zai" : provider;
}

function skipped(
	model: NativeModelInfo | undefined,
	adapter: NativeSearchAdapter | undefined,
	reason: string,
	modelId?: string,
): NativeAdapterResolution {
	const status: NativeRouteStatus = { status: "skipped", reason };
	if (model) status.provider = model.provider;
	const resolvedModel = modelId ?? model?.id;
	if (resolvedModel) status.model = resolvedModel;
	if (adapter) status.adapter = adapter;
	return { status };
}

function ready(
	model: NativeModelInfo,
	adapter: NativeSearchAdapter,
	resolvedModel: string,
	endpoint?: string,
): NativeAdapterResolution {
	const resolution: NativeAdapterResolution = {
		status: { status: "ready", provider: model.provider, model: resolvedModel, adapter },
		adapter,
		model: resolvedModel,
	};
	if (endpoint !== undefined) resolution.endpoint = endpoint;
	return resolution;
}

function deriveEndpoint(adapter: NativeSearchAdapter, baseUrl: string): string | undefined {
	try {
		const endpoint = nativeSearchEndpoint(adapter, baseUrl);
		return isAllowedProviderBaseUrl(endpoint) ? endpoint : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve capability independently of the active model's base URL. URL selection and
 * validation happen after auth resolution, because the resolved auth base URL is the
 * authoritative endpoint for the paired credentials.
 */
function resolveCapability(
	model: NativeModelInfo | undefined,
	overrides?: WebsearchConfig["nativeOverrides"],
): CapabilityResult {
	if (!model) return { ok: false, status: skipped(undefined, undefined, "no active model").status };

	const override = overrides && Object.hasOwn(overrides, model.provider) ? overrides[model.provider] : undefined;
	if (override === false) {
		return {
			ok: false,
			status: skipped(model, undefined, `native disabled for provider "${model.provider}" by nativeOverrides`)
				.status,
		};
	}

	if (override) {
		if (!NATIVE_ADAPTERS.has(override.adapter)) {
			return {
				ok: false,
				status: skipped(model, undefined, `invalid native adapter "${String(override.adapter)}"`).status,
			};
		}
		const resolvedOverrideModel = override.model?.trim();
		if (override.model !== undefined && !resolvedOverrideModel) {
			return {
				ok: false,
				status: skipped(model, override.adapter, "native override model must be non-empty").status,
			};
		}
		const modelId = resolvedOverrideModel ?? model.id;
		const overrideEndpoint = override.endpoint?.trim();
		if (overrideEndpoint) {
			if (!isAllowedProviderBaseUrl(overrideEndpoint)) {
				return {
					ok: false,
					status: skipped(model, override.adapter, "native override endpoint must be a public HTTPS URL", modelId)
						.status,
				};
			}
			return {
				ok: true,
				capability: { adapter: override.adapter, model: modelId, explicitEndpoint: overrideEndpoint },
			};
		}
		return { ok: true, capability: { adapter: override.adapter, model: modelId } };
	}

	const providerId = normalizeProviderId(model.provider);
	const known = Object.hasOwn(KNOWN_PROVIDERS, providerId) ? KNOWN_PROVIDERS[providerId] : undefined;
	if (!known) {
		return {
			ok: false,
			status: skipped(
				model,
				undefined,
				`unsupported provider "${model.provider}"; add nativeOverrides["${model.provider}"] to opt in`,
			).status,
		};
	}

	if (known.api && model.api !== known.api) {
		return {
			ok: false,
			status: skipped(
				model,
				known.adapter,
				`provider "${model.provider}" uses api "${model.api}"; native adapter "${known.adapter}" requires "${known.api}"`,
			).status,
		};
	}

	return { ok: true, capability: { adapter: known.adapter, model: model.id } };
}

/**
 * Resolve the native adapter candidate for the active model without reading credentials.
 * A ready candidate may have no endpoint when the model base URL is unusable; the
 * authenticated route can still succeed with an auth-resolved base URL.
 */
export function resolveNativeAdapter(
	model: NativeModelInfo | undefined,
	overrides?: WebsearchConfig["nativeOverrides"],
): NativeAdapterResolution {
	const resolved = resolveCapability(model, overrides);
	if (!resolved.ok) return { status: resolved.status };
	if (!model) return { status: skipped(undefined, undefined, "no active model").status };

	const { capability } = resolved;
	if (capability.explicitEndpoint)
		return ready(model, capability.adapter, capability.model, capability.explicitEndpoint);
	const endpoint = deriveEndpoint(capability.adapter, model.baseUrl);
	const resolution = ready(model, capability.adapter, capability.model, endpoint);
	if (!endpoint) {
		resolution.status.reason = "endpoint will be resolved from the authenticated provider base URL";
	}
	return resolution;
}

function isChatGptEndpoint(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return (
			(url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") &&
			(url.pathname === "/backend-api" || url.pathname.startsWith("/backend-api/"))
		);
	} catch {
		return false;
	}
}

function generatedPrimaryHeader(adapter: NativeSearchAdapter, apiKey: string): "authorization" | "x-api-key" {
	return adapter === "anthropic" && !apiKey.includes("sk-ant-oat") ? "x-api-key" : "authorization";
}

function authFailure(model: NativeModelInfo, adapter: NativeSearchAdapter, modelId: string): NativeAdapterResolution {
	return skipped(
		model,
		adapter,
		`native auth failed for provider "${model.provider}"; credential resolution was rejected`,
		modelId,
	);
}

function hasUsableAuth(
	auth: Extract<NativeAuthResult, { ok: true }>,
	headers: Record<string, string | null>,
	adapter: NativeSearchAdapter,
): boolean {
	if (hasAuthHeader(headers)) return true;
	const apiKey = auth.apiKey?.trim();
	if (!apiKey) return false;
	return !hasHeaderTombstone(headers, generatedPrimaryHeader(adapter, apiKey));
}

function routeKey(
	model: NativeModelInfo,
	adapter: NativeSearchAdapter,
	modelId: string,
	endpoint: string,
	credentials: Pick<SearchProviderEntry, "apiKey" | "headers">,
): string {
	const headers = Object.entries(credentials.headers ?? {})
		.map(([name, value]) => [name.toLowerCase(), value])
		.sort(([left], [right]) => (left ?? "").localeCompare(right ?? ""));
	const fingerprint = createHash("sha256")
		.update(JSON.stringify([model.provider, model.api, adapter, endpoint, modelId, credentials.apiKey, headers]))
		.digest("hex");
	return `native:${fingerprint}`;
}

export async function resolveNativeRoute(
	model: NativeModelInfo | undefined,
	registry: NativeModelRegistry | undefined,
	overrides?: WebsearchConfig["nativeOverrides"],
): Promise<{ entry?: SearchProviderEntry; status: NativeRouteStatus; key?: string }> {
	const resolved = resolveCapability(model, overrides);
	if (!resolved.ok) return { status: resolved.status };
	if (!model) return { status: skipped(undefined, undefined, "no active model").status };
	const { capability } = resolved;

	if (!registry) {
		return { status: skipped(model, capability.adapter, "no model registry available", capability.model).status };
	}

	let auth: NativeAuthResult;
	try {
		auth = await registry.getApiKeyAndHeaders(model);
	} catch {
		return { status: authFailure(model, capability.adapter, capability.model).status };
	}
	if (!auth.ok) {
		return { status: authFailure(model, capability.adapter, capability.model).status };
	}

	const headers = mergeHeadersWithTombstones(model.headers, auth.headers);
	if (!hasUsableAuth(auth, headers, capability.adapter)) {
		return {
			status: skipped(model, capability.adapter, `no usable credentials for provider "${model.provider}"`).status,
		};
	}

	const authBaseUrl = auth.baseUrl && auth.baseUrl.trim().length > 0 ? auth.baseUrl : model.baseUrl;
	const baseUrl = capability.explicitEndpoint ?? authBaseUrl;
	// Pi can resolve OpenAI's Sign in with ChatGPT auth to the Codex backend.
	// Keep the paired credentials and URL, but use the subscription wire format.
	const adapter = capability.adapter === "openai" && isChatGptEndpoint(baseUrl) ? "codex" : capability.adapter;
	const endpoint = capability.explicitEndpoint ?? deriveEndpoint(adapter, baseUrl);
	if (!endpoint) {
		return {
			status: skipped(model, capability.adapter, "resolved base URL must be a public HTTPS URL", capability.model)
				.status,
		};
	}

	const entry: SearchProviderEntry = {
		id: "native",
		provider: SEARCH_PROVIDER_BY_ADAPTER[adapter],
		baseUrl: endpoint,
		model: capability.model,
		priority: -1,
	};
	if (auth.apiKey) entry.apiKey = auth.apiKey;
	if (Object.keys(headers).length > 0) entry.headers = headers;

	return {
		entry,
		status: { status: "ready", provider: model.provider, model: capability.model, adapter },
		key: routeKey(model, adapter, capability.model, endpoint, entry),
	};
}

export async function buildNativeEntry(
	model: NativeModelInfo | undefined,
	registry: NativeModelRegistry | undefined,
	overrides?: WebsearchConfig["nativeOverrides"],
): Promise<SearchProviderEntry | null> {
	return (await resolveNativeRoute(model, registry, overrides)).entry ?? null;
}
