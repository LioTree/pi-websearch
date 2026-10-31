import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, JsonValue, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import {
	appendDomainFilters,
	bearerHeaders,
	chatCompletionAnswer,
	citationLink,
	clamp,
	collect,
	getArray,
	getObject,
	getString,
	result,
	SEARCH_INSTRUCTIONS,
	uniqueSources,
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
		Number.POSITIVE_INFINITY,
	);
}

function normalizeCitations(data: JsonObject): SearchResultItem[] {
	return collect(
		getArray(data["citations"]).map((raw) => {
			const url = getString(raw);
			return result(url, url);
		}),
		Number.POSITIVE_INFINITY,
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
	normalizeAnswer(data) {
		const answer = chatCompletionAnswer(data);
		if (!answer) return undefined;
		// Do not rewrite numeric brackets: they can also be code or URL syntax.
		const references = getArray(data["citations"]).flatMap((raw, index) => {
			const url = getString(raw);
			return url ? [citationLink(String(index + 1), url)] : [];
		});
		return references.length ? `${answer}\n\nCitation mapping (provider indices): ${references.join(" ")}` : answer;
	},
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		if (config.model) {
			const body: JsonObject = {
				model: config.model,
				messages: [
					{ role: "system", content: SEARCH_INSTRUCTIONS },
					{ role: "user", content: domainQuery(request.query, allowedDomains, blockedDomains) },
				],
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
		const searchResults = normalizeResultList(getArray(data["results"]));
		// Citations remain evidence even when per-page snippets are available.
		// Validate every source before the shared result cap.
		return uniqueSources([...chatResults, ...searchResults, ...normalizeCitations(data)]);
	},
};
