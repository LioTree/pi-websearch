import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import {
	appendDomainFilters,
	bearerHeaders,
	chatCompletionAnswer,
	clamp,
	collect,
	getArray,
	getObject,
	getString,
	result,
	SEARCH_INSTRUCTIONS,
} from "./shared.js";

function domainQuery(query: string, allowedDomains?: string[], blockedDomains?: string[]): string {
	// Z.ai's native filter accepts a single domain. With one allowed domain keep it
	// native; with several, express the alternatives (and any blocked exclusions) in
	// the query so no allowed scope is silently dropped.
	return allowedDomains && allowedDomains.length > 1
		? appendDomainFilters(query, allowedDomains, blockedDomains)
		: appendDomainFilters(query, undefined, blockedDomains);
}

function nativeDomainFilter(allowedDomains?: string[]): string | undefined {
	return allowedDomains?.length === 1 ? allowedDomains[0] : undefined;
}

export const zAiProvider: ProviderModule = {
	normalizeAnswer: chatCompletionAnswer,
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		if (config.model) {
			const webSearch: JsonObject = {
				enable: true,
				search_engine: "search-prime",
				search_result: true,
				count: clamp(maxResults, 1, 50),
			};
			const domainFilter = nativeDomainFilter(allowedDomains);
			if (domainFilter) webSearch["search_domain_filter"] = domainFilter;
			if (config.searchContextSize) webSearch["content_size"] = config.searchContextSize;
			return {
				url: providerUrl(config),
				init: { method: "POST", headers: bearerHeaders(config) },
				body: {
					model: config.model,
					messages: [
						{ role: "system", content: SEARCH_INSTRUCTIONS },
						{ role: "user", content: domainQuery(request.query, allowedDomains, blockedDomains) },
					],
					tools: [{ type: "web_search", web_search: webSearch }],
				},
			};
		}

		const body: JsonObject = {
			search_engine: "search-prime",
			search_query: domainQuery(request.query, allowedDomains, blockedDomains),
			count: clamp(maxResults, 1, 50),
		};
		const domainFilter = nativeDomainFilter(allowedDomains);
		if (domainFilter) body["search_domain_filter"] = domainFilter;
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: bearerHeaders(config) },
			body,
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const chatResults = collect(
			getArray(data["web_search"]).map((raw) => {
				const item = getObject(raw);
				return result(
					getString(item?.["title"]),
					getString(item?.["link"]),
					getString(item?.["content"]),
					getString(item?.["media"]),
				);
			}),
		);
		if (chatResults.length > 0) return chatResults;

		return collect(
			getArray(data["search_result"]).map((raw) => {
				const item = getObject(raw);
				return result(
					getString(item?.["title"]),
					getString(item?.["link"]),
					getString(item?.["content"]),
					getString(item?.["media"]),
				);
			}),
		);
	},
};
