import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, JsonValue, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import {
	appendDomainFilters,
	bearerHeaders,
	clamp,
	collect,
	getArray,
	getObject,
	getString,
	result,
} from "./shared.js";

function normalizeResultList(items: JsonValue[]): SearchResultItem[] {
	return collect(
		items.map((raw) => {
			const item = getObject(raw);
			const searchResult = result(
				getString(item?.["title"]),
				getString(item?.["url"]),
				getString(item?.["snippet"]),
			);
			if (searchResult) {
				const publishedAt = getString(item?.["date"]) ?? getString(item?.["last_updated"]);
				if (publishedAt) searchResult.publishedAt = publishedAt;
			}
			return searchResult;
		}),
	);
}

function responseText(data: JsonObject): string | undefined {
	const firstChoice = getObject(getArray(data["choices"])[0]);
	const message = getObject(firstChoice?.["message"]);
	return getString(message?.["content"]);
}

function normalizeCitations(data: JsonObject, snippet: string | undefined): SearchResultItem[] {
	return collect(
		getArray(data["citations"]).map((raw) => {
			const url = getString(raw);
			return result(url, url, snippet);
		}),
	);
}

function domainQuery(query: string, allowedDomains?: string[], blockedDomains?: string[]): string {
	// Perplexity accepts one filter direction. Keep allowed domains native and fold
	// blocked exclusions into the query; the shared postfilter enforces both.
	return allowedDomains && blockedDomains ? appendDomainFilters(query, undefined, blockedDomains) : query;
}

function applyDomainFilter(body: JsonObject, allowedDomains?: string[], blockedDomains?: string[]): void {
	if (allowedDomains) body["search_domain_filter"] = allowedDomains;
	else if (blockedDomains) body["search_domain_filter"] = blockedDomains.map((domain) => `-${domain}`);
}

export const perplexityProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		if (config.model) {
			const body: JsonObject = {
				model: config.model,
				messages: [{ role: "user", content: domainQuery(request.query, allowedDomains, blockedDomains) }],
			};
			applyDomainFilter(body, allowedDomains, blockedDomains);
			if (config.searchContextSize) body["web_search_options"] = { search_context_size: config.searchContextSize };
			return {
				url: providerUrl(config),
				init: { method: "POST", headers: bearerHeaders(config) },
				body,
			};
		}

		const body: JsonObject = {
			query: domainQuery(request.query, allowedDomains, blockedDomains),
			max_results: clamp(maxResults, 1, 20),
		};
		applyDomainFilter(body, allowedDomains, blockedDomains);
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: bearerHeaders(config) },
			body,
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const chatResults = normalizeResultList(getArray(data["search_results"]));
		if (chatResults.length > 0) return chatResults;
		const searchResults = normalizeResultList(getArray(data["results"]));
		if (searchResults.length > 0) return searchResults;
		return normalizeCitations(data, responseText(data));
	},
};
