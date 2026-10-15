import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { buildNativeEntries, type NativeModelInfo, type NativeModelRegistry } from "./native.js";
import { renderSearchCall, renderSearchResult } from "./renderers.js";
import {
	createSearchRoutingState,
	formatSearchText,
	performSearch,
	providerEntryLabel,
	type SearchRoutingState,
} from "./search.js";
import type {
	ConfigLoadResult,
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
					"Omit for normal configured routing. Use raw for direct search-engine results without an additional model-generated answer, including when a previous search returned a refusal or no usable sources.",
			}),
		),
	},
	{ additionalProperties: false },
);

const RAW_RETRY_GUIDELINE =
	'If search returns a refusal or no usable sources, or the user requests direct search-engine results, retry with the same query and mode: "raw". Do not repeat a raw retry for the same query.';
const RAW_RETRY_HINT =
	'If these results are a refusal or have no usable sources, retry with the same query and mode: "raw" to use direct search-engine results without an additional model-generated answer.';

function isAnswerProvider(entry: Pick<SearchProviderEntry, "provider" | "model">): boolean {
	if (entry.provider === "perplexity" || entry.provider === "z-ai") return Boolean(entry.model);
	return (
		entry.provider === "openai" ||
		entry.provider === "codex" ||
		entry.provider === "anthropic" ||
		entry.provider === "xai"
	);
}

export type ConfigProvider = () => ConfigLoadResult;
type ToolParams = typeof Params | typeof RawParams;
type WebSearchTool = ReturnType<typeof defineTool<ToolParams, SearchRenderDetails>>;

function nativeModelFromContext(model: ExtensionContext["model"]): NativeModelInfo | undefined {
	if (!model) return undefined;
	return { provider: model.provider, id: model.id, baseUrl: model.baseUrl };
}

function nativeRegistryFromContext(modelRegistry: ExtensionContext["modelRegistry"]): NativeModelRegistry {
	return {
		async getApiKeyAndHeaders(model) {
			return modelRegistry.getApiKeyAndHeaders(model as Parameters<typeof modelRegistry.getApiKeyAndHeaders>[0]);
		},
		getAvailable() {
			return modelRegistry.getAvailable().map((available) => ({
				provider: available.provider,
				id: available.id,
				baseUrl: available.baseUrl,
			}));
		},
	};
}

async function configWithNativeRoute(config: WebsearchConfig, ctx: ExtensionContext): Promise<WebsearchConfig> {
	if (!config.auto) return config;
	const nativeEntries = await buildNativeEntries(
		nativeModelFromContext(ctx.model),
		nativeRegistryFromContext(ctx.modelRegistry),
	);
	return nativeEntries.length > 0 ? { ...config, providers: [...nativeEntries, ...config.providers] } : config;
}

function formatSearchProgressText(details: SearchProgressDetails): string {
	if (details.currentProvider) {
		return `Searching "${details.query}" via ${details.currentProvider} (max ${details.maxResults})`;
	}
	const route = details.providerLabels.length > 0 ? details.providerLabels.join(" -> ") : "configured providers";
	return `Searching "${details.query}" via ${route} (max ${details.maxResults})`;
}

function searchErrorDetails(query: string, error: string, reason?: SearchErrorDetails["reason"]): SearchErrorDetails {
	return { phase: "error", query, error, ...(reason ? { reason } : {}) };
}

export function createWebSearchTool(getConfig: ConfigProvider): WebSearchTool {
	let routingState: SearchRoutingState | undefined;
	let routingKey = "";
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
			const config = raw
				? {
						...loaded.config,
						auto: false,
						providers: loaded.config.providers.filter((entry) => !isAnswerProvider(entry)),
					}
				: await configWithNativeRoute(loaded.config, ctx);
			if (config.providers.length === 0) {
				const message =
					"No direct search-engine providers configured for raw mode. Configure a provider such as duckduckgo-html or brave.";
				return { content: [{ type: "text", text: message }], details: searchErrorDetails(params.query, message) };
			}
			const maxResults = (raw ? config : loaded.config).providers[0]?.maxResults ?? 10;
			const progressDetails: SearchProgressDetails = {
				phase: "searching",
				query: params.query,
				providerLabels: config.providers.map(providerEntryLabel),
				maxResults,
				strategy: config.strategy,
				...(params.allowed_domains ? { allowedDomains: params.allowed_domains } : {}),
				...(params.blocked_domains ? { blockedDomains: params.blocked_domains } : {}),
			};
			onUpdate?.({
				content: [{ type: "text", text: formatSearchProgressText(progressDetails) }],
				details: progressDetails,
			});

			const nextRoutingKey = `${config.strategy}:${config.providers.map((provider) => provider.id ?? provider.provider).join("|")}`;
			if (
				!routingState ||
				routingKey !== nextRoutingKey ||
				routingState.successCounts.length !== config.providers.length
			) {
				routingState = createSearchRoutingState(config.providers.length);
				routingKey = nextRoutingKey;
			}
			const request = {
				query: params.query,
				maxResults,
				...(params.allowed_domains === undefined ? {} : { allowedDomains: params.allowed_domains }),
				...(params.blocked_domains === undefined ? {} : { blockedDomains: params.blocked_domains }),
			};
			const details = await performSearch(
				config,
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
			);
			const usedAnswerProvider = config.providers.some(
				(entry) => entry.provider === details.provider && entry.id === details.entryId && isAnswerProvider(entry),
			);
			const hint = rawMode && !raw && usedAnswerProvider ? `\n\n${RAW_RETRY_HINT}` : "";
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
