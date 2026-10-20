import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { EmptyDomainPolicyError } from "./domains.js";
import { type NativeModelInfo, type NativeModelRegistry, resolveNativeRoute } from "./native.js";
import { isDirectSearchProvider } from "./providers.js";
import { renderSearchCall, renderSearchResult } from "./renderers.js";
import {
	createSearchRoutingState,
	domainPolicyFailure,
	effectiveMaxResults,
	formatSearchText,
	performSearch,
	providerEntryLabel,
	SEARCH_TOTAL_BUDGET_MS,
	type SearchRoutingState,
	validateDomainPolicies,
} from "./search.js";
import type {
	ConfigLoadResult,
	NativeRouteStatus,
	SearchDetails,
	SearchErrorDetails,
	SearchProgressDetails,
	SearchProviderEntry,
	SearchRenderDetails,
	WebsearchConfig,
} from "./types.js";

const Params = Type.Object(
	{
		query: Type.String({ minLength: 2, description: "The search query to use" }),
		allowed_domains: Type.Optional(
			Type.Array(Type.String(), { description: "Only include search results from these domains" }),
		),
		blocked_domains: Type.Optional(
			Type.Array(Type.String(), { description: "Never include search results from these domains" }),
		),
	},
	{ additionalProperties: false },
);

const RawParams = Type.Object(
	{
		...Params.properties,
		mode: Type.Optional(
			Type.Literal("raw", {
				description:
					"Omit for normal native-first routing. Use raw for direct search-engine results without an additional model-generated answer, including when a previous search returned a refusal or no usable sources.",
			}),
		),
	},
	{ additionalProperties: false },
);

const RAW_RETRY_GUIDELINE =
	'If search returns a refusal or no usable sources, or the user requests direct search-engine results, retry with the same query and mode: "raw". Do not repeat a raw retry for the same query.';
const RAW_RETRY_HINT =
	'If these results are a refusal or have no usable sources, retry with the same query and mode: "raw" to use direct search-engine results without an additional model-generated answer.';
const NATIVE_UNSUPPORTED_TTL_MS = 5 * 60_000;

export type ConfigProvider = () => ConfigLoadResult;
type ToolParams = typeof Params | typeof RawParams;
type WebSearchTool = ReturnType<typeof defineTool<ToolParams, SearchRenderDetails>>;

interface NativeResolution {
	entry?: SearchProviderEntry;
	status: NativeRouteStatus;
	key?: string;
	deadlineExceeded?: boolean;
}

function nativeModelFromContext(model: ExtensionContext["model"]): NativeModelInfo | undefined {
	if (!model) return undefined;
	return {
		provider: model.provider,
		id: model.id,
		api: model.api,
		baseUrl: model.baseUrl,
		...(model.headers ? { headers: model.headers } : {}),
	};
}

function nativeRegistryFor(
	model: ExtensionContext["model"],
	registry: ExtensionContext["modelRegistry"],
): NativeModelRegistry {
	return {
		async getApiKeyAndHeaders() {
			// Capture the model before the async operation starts. The active model may
			// change while auth is pending; capability, credentials, and the routing
			// fingerprint must all refer to the same model snapshot.
			if (!model) return { ok: false, error: "No active model is available for native search." };
			if (!registry) return { ok: false, error: "No model registry is available for native search." };
			return registry.getApiKeyAndHeaders(model);
		},
	};
}

function skippedNative(reason: string): NativeResolution {
	return { status: { status: "skipped", reason } };
}

function deadlineError(): DOMException {
	return new DOMException("Native authentication exceeded the search deadline.", "TimeoutError");
}

function isDeadlineError(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}

function raceNativeOperation<T>(operation: Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<T> {
	if (signal?.aborted)
		return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
	const remaining = deadline - Date.now();
	if (remaining <= 0) return Promise.reject(deadlineError());

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const settle = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = (): void =>
			settle(() => reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")));
		const timer = setTimeout(() => settle(() => reject(deadlineError())), remaining);
		signal?.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => settle(() => resolve(value)),
			(error: unknown) => settle(() => reject(error)),
		);
	});
}

async function resolveNative(
	config: WebsearchConfig,
	model: ExtensionContext["model"],
	registry: ExtensionContext["modelRegistry"],
	raw: boolean,
	signal: AbortSignal | undefined,
	deadline: number,
): Promise<NativeResolution> {
	if (raw) return skippedNative("raw mode requested");
	if (!config.auto) return skippedNative("auto is disabled");
	const nativeModel = nativeModelFromContext(model);
	if (!nativeModel) return skippedNative("no active model");
	try {
		return await raceNativeOperation(
			resolveNativeRoute(nativeModel, nativeRegistryFor(model, registry), config.nativeOverrides),
			signal,
			deadline,
		);
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
		if (isDeadlineError(error)) {
			return {
				status: {
					status: "skipped",
					provider: nativeModel.provider,
					model: nativeModel.id,
					reason: "native authentication exceeded the search deadline",
				},
				deadlineExceeded: true,
			};
		}
		throw error;
	}
}

function formatSearchProgressText(details: SearchProgressDetails): string {
	const nativeSuffix =
		details.native?.status === "skipped" && details.native.reason
			? ` (native skipped: ${details.native.reason})`
			: details.native?.status === "ready"
				? " (native first)"
				: "";
	if (details.currentProvider) {
		return `Searching "${details.query}" via ${details.currentProvider} (max ${details.maxResults})${nativeSuffix}`;
	}
	const route = details.providerLabels.length > 0 ? details.providerLabels.join(" -> ") : "configured providers";
	return `Searching "${details.query}" via ${route} (max ${details.maxResults})${nativeSuffix}`;
}

function searchErrorDetails(query: string, error: string, reason?: SearchErrorDetails["reason"]): SearchErrorDetails {
	return { phase: "error", query, error, ...(reason ? { reason } : {}) };
}

function providerFingerprint(provider: SearchProviderEntry): Record<string, unknown> {
	return {
		id: provider.id,
		provider: provider.provider,
		baseUrl: provider.baseUrl,
		model: provider.model,
		codexMode: provider.codexMode,
		searchContextSize: provider.searchContextSize,
		searchEngineId: provider.searchEngineId,
		userLocation: provider.userLocation,
		priority: provider.priority,
		weight: provider.weight,
		maxResults: provider.maxResults,
		timeoutMs: provider.timeoutMs,
		allowedDomains: provider.allowedDomains,
		blockedDomains: provider.blockedDomains,
		hasApiKey: provider.apiKey !== undefined,
		headerNames: Object.keys(provider.headers ?? {}).sort(),
	};
}

function routingFingerprint(
	config: WebsearchConfig,
	mode: "normal" | "raw",
	model: ExtensionContext["model"],
	nativeKey: string | undefined,
): string {
	return JSON.stringify({
		mode,
		strategy: config.strategy,
		fallback: config.fallback,
		auto: config.auto,
		rawMode: config.rawMode,
		maxResults: config.maxResults,
		timeoutMs: config.timeoutMs,
		allowedDomains: config.allowedDomains,
		blockedDomains: config.blockedDomains,
		nativeOverrides: config.nativeOverrides,
		nativeKey,
		model: model
			? {
					provider: model.provider,
					id: model.id,
					api: model.api,
					baseUrl: model.baseUrl,
					headerNames: Object.keys(model.headers ?? {}).sort(),
				}
			: null,
		providers: config.providers.map(providerFingerprint),
	});
}

function nativeCacheKey(resolution: NativeResolution): string | undefined {
	if (!resolution.entry) return undefined;
	if (resolution.key) return resolution.key;
	return `${resolution.status.provider ?? resolution.entry.provider}:${resolution.status.adapter ?? resolution.entry.provider}:${resolution.status.model ?? resolution.entry.model ?? resolution.entry.id ?? "native"}:${resolution.entry.baseUrl ?? ""}`;
}

function isUnsupportedCached(cache: Map<string, number>, key: string | undefined, now: number): boolean {
	if (!key) return false;
	const expiresAt = cache.get(key);
	if (expiresAt === undefined) return false;
	if (expiresAt <= now) {
		cache.delete(key);
		return false;
	}
	return true;
}

function successfulHostedAttempt(details: SearchDetails, config: WebsearchConfig): boolean {
	if (details.stage === "native") {
		return !isDirectSearchProvider({
			provider: details.provider,
			...(details.native?.model === undefined ? {} : { model: details.native.model }),
		});
	}
	const entries = new Map<string, SearchProviderEntry>();
	for (const entry of config.providers) {
		entries.set(`${entry.provider}:${entry.id ?? ""}`, entry);
	}
	return (details.attempts ?? []).some((attempt) => {
		if (attempt.error) return false;
		const entry = entries.get(`${attempt.provider}:${attempt.entryId ?? ""}`);
		return entry !== undefined && !isDirectSearchProvider(entry);
	});
}

export function createWebSearchTool(getConfig: ConfigProvider): WebSearchTool {
	let routingState: SearchRoutingState | undefined;
	let routingKey = "";
	let unsupportedCacheFingerprint = "";
	const unsupportedUntil = new Map<string, number>();
	const initialConfig = getConfig();
	const rawMode = initialConfig.ok && initialConfig.config.rawMode === true;

	return defineTool<ToolParams, SearchRenderDetails>({
		name: "web_search",
		label: "Web Search",
		description: "Search the web for current information and return source URLs for citation.",
		promptSnippet: "Search the web for current information, documentation, news, or external facts.",
		promptGuidelines: [
			"After using web_search, cite relevant returned URLs in the final answer.",
			...(rawMode ? [RAW_RETRY_GUIDELINE] : []),
		],
		parameters: rawMode ? RawParams : Params,
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			if (params.allowed_domains?.length && params.blocked_domains?.length) {
				const message = "Error: Cannot specify both allowed_domains and blocked_domains in the same request";
				const details = searchErrorDetails(params.query, message);
				return { content: [{ type: "text", text: message }], details };
			}

			const loaded = getConfig();
			if (!loaded.ok) {
				const details = searchErrorDetails(params.query, loaded.message, loaded.reason);
				return { content: [{ type: "text", text: loaded.message }], details };
			}

			const raw = "mode" in params && params.mode === "raw";
			if (raw && (!rawMode || !loaded.config.rawMode)) {
				const message = 'Raw search mode is disabled. Enable "rawMode": true in websearch.json.';
				return { content: [{ type: "text", text: message }], details: searchErrorDetails(params.query, message) };
			}
			const mode = raw ? "raw" : "normal";
			const searchConfig: WebsearchConfig = raw
				? {
						...loaded.config,
						auto: false,
						providers: loaded.config.providers.filter((entry) => isDirectSearchProvider(entry)),
					}
				: loaded.config;
			if (raw && searchConfig.providers.length === 0) {
				const message =
					"No direct search-engine providers configured for raw mode. Configure a provider such as duckduckgo-html or brave.";
				return { content: [{ type: "text", text: message }], details: searchErrorDetails(params.query, message) };
			}

			signal?.throwIfAborted();

			// Validate the global/request domain policy before native auth or any
			// fetch. An empty allowed intersection is a no-results outcome, not a
			// provider request. Entry conflicts are handled per attempt.
			const maxResults = effectiveMaxResults(searchConfig);
			const request = {
				query: params.query,
				maxResults,
				...(params.allowed_domains === undefined ? {} : { allowedDomains: params.allowed_domains }),
				...(params.blocked_domains === undefined ? {} : { blockedDomains: params.blocked_domains }),
			};
			try {
				validateDomainPolicies(searchConfig, request);
			} catch (error) {
				if (error instanceof EmptyDomainPolicyError) {
					const details = domainPolicyFailure(searchConfig, request, error, {
						mode,
						nativeStatus: { status: "skipped", reason: "domain policy excludes all sources" },
					});
					return { content: [{ type: "text", text: formatSearchText(details) }], details };
				}
				throw error;
			}

			// Abort before native resolution: no credential refresh and no fetch
			// may start after the caller cancelled.
			signal?.throwIfAborted();

			const activeModel = ctx.model;
			const activeRegistry = ctx.modelRegistry;
			const searchStartedAt = Date.now();
			const deadline = searchStartedAt + SEARCH_TOTAL_BUDGET_MS;
			const resolution = await resolveNative(searchConfig, activeModel, activeRegistry, raw, signal, deadline);
			signal?.throwIfAborted();
			if (resolution.deadlineExceeded) {
				const details: SearchDetails = {
					provider: searchConfig.providers[0]?.provider ?? "exa",
					query: params.query,
					results: [],
					durationMs: Date.now() - searchStartedAt,
					truncated: false,
					error: "Search deadline exceeded while resolving native authentication.",
					failureKind: "timeout",
					strategy: searchConfig.strategy,
					stage: "fallback",
					mode,
					native: resolution.status,
				};
				return { content: [{ type: "text", text: formatSearchText(details) }], details };
			}
			const nativeKey = nativeCacheKey(resolution);
			const fingerprint = routingFingerprint(searchConfig, mode, activeModel, nativeKey);
			if (unsupportedCacheFingerprint !== fingerprint) {
				unsupportedUntil.clear();
				unsupportedCacheFingerprint = fingerprint;
			}

			const now = Date.now();
			const cachedUnsupported = isUnsupportedCached(unsupportedUntil, nativeKey, now);
			let nativeEntry = resolution.status.status === "ready" ? resolution.entry : undefined;
			let nativeStatus: NativeRouteStatus = resolution.status;
			if (cachedUnsupported) {
				nativeEntry = undefined;
				nativeStatus = {
					...resolution.status,
					status: "skipped",
					reason: "native search recently reported an explicit unsupported tool response",
				};
			}
			if (!nativeEntry && nativeStatus.status === "ready") {
				nativeStatus = { ...nativeStatus, status: "skipped", reason: "native route was not resolved" };
			}
			if (!nativeEntry && searchConfig.providers.length === 0) {
				const message = "No search provider is available for this model. Configure providers in websearch.json.";
				return { content: [{ type: "text", text: message }], details: searchErrorDetails(params.query, message) };
			}

			const providerLabels = [
				...(nativeEntry ? [providerEntryLabel(nativeEntry)] : []),
				...searchConfig.providers.map(providerEntryLabel),
			];
			const progressDetails: SearchProgressDetails = {
				phase: "searching",
				query: params.query,
				providerLabels,
				maxResults,
				strategy: searchConfig.strategy,
				mode,
				native: nativeStatus,
				...(params.allowed_domains ? { allowedDomains: params.allowed_domains } : {}),
				...(params.blocked_domains ? { blockedDomains: params.blocked_domains } : {}),
			};
			onUpdate?.({
				content: [{ type: "text", text: formatSearchProgressText(progressDetails) }],
				details: progressDetails,
			});

			const nextRoutingKey = fingerprint;
			if (
				!routingState ||
				routingKey !== nextRoutingKey ||
				routingState.successCounts.length !== searchConfig.providers.length
			) {
				routingState = createSearchRoutingState(searchConfig.providers.length);
				routingKey = nextRoutingKey;
			}
			const details = await performSearch(
				searchConfig,
				request,
				signal,
				routingState,
				(providerLabel, attempts, routeLabels) => {
					const attemptProgress: SearchProgressDetails = {
						...progressDetails,
						currentProvider: providerLabel,
						attempts: [...attempts],
						routeLabels: [...routeLabels],
					};
					onUpdate?.({
						content: [{ type: "text", text: formatSearchProgressText(attemptProgress) }],
						details: attemptProgress,
					});
				},
				{
					...(nativeEntry ? { nativeEntry } : {}),
					nativeStatus,
					mode,
					startedAt: searchStartedAt,
					deadline,
				},
			);

			const nativeAttempt = details.attempts?.find((attempt) => attempt.stage === "native");
			if (nativeKey && nativeAttempt?.failureKind === "unsupported") {
				unsupportedUntil.set(nativeKey, Date.now() + NATIVE_UNSUPPORTED_TTL_MS);
			}

			const hint = rawMode && !raw && successfulHostedAttempt(details, searchConfig) ? `\n\n${RAW_RETRY_HINT}` : "";
			return { content: [{ type: "text", text: formatSearchText(details) + hint }], details };
		},
		renderCall: (args, theme) => renderSearchCall(args, theme),
		renderResult: (result, options, theme) => renderSearchResult(result, options, theme),
	});
}

export const web_search = createWebSearchTool(() => ({
	ok: false,
	reason: "missing_config",
	message: "Missing websearch config. Create .pi/websearch.json or ~/.pi/websearch.json before starting pi.",
}));
