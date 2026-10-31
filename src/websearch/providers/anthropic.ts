import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import {
	anthropicHeaders,
	appendDomainFilters,
	citationLink,
	collect,
	getArray,
	getObject,
	getString,
	isAnthropicOAuth,
	result,
	SEARCH_INSTRUCTIONS,
	uniqueSources,
} from "./shared.js";

function webCitations(block: JsonObject | undefined): JsonObject[] {
	return getArray(block?.["citations"])
		.map(getObject)
		.filter((citation): citation is JsonObject => citation?.["type"] === "web_search_result_location");
}

export const anthropicProvider: ProviderModule = {
	normalizeAnswer(data) {
		return (
			getArray(data["content"])
				.map(getObject)
				.filter((item) => item?.["type"] === "text")
				.map((item) => {
					const text = getString(item?.["text"]) ?? "";
					const links = webCitations(item).flatMap((citation) => {
						const url = getString(citation["url"]);
						return url ? [citationLink("source", url)] : [];
					});
					return [text, ...links].filter(Boolean).join(" ");
				})
				.filter(Boolean)
				.join("\n") || undefined
		);
	},
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const webSearchTool: JsonObject = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
		let query = request.query;
		if (allowedDomains) {
			webSearchTool["allowed_domains"] = allowedDomains;
			// The API rejects both filters together: keep allowed_domains native and fold
			// blocked exclusions into the query; the shared postfilter enforces both.
			if (blockedDomains) query = appendDomainFilters(query, undefined, blockedDomains);
		} else if (blockedDomains) {
			webSearchTool["blocked_domains"] = blockedDomains;
		}
		return {
			url: providerUrl(config),
			init: {
				method: "POST",
				headers: anthropicHeaders(config),
			},
			body: {
				model: config.model ?? "claude-sonnet-4-5-20250929",
				system: [
					...(isAnthropicOAuth(config)
						? [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }]
						: []),
					{ type: "text", text: SEARCH_INSTRUCTIONS },
				],
				max_tokens: 1024,
				messages: [{ role: "user", content: query }],
				tools: [webSearchTool],
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const content = getArray(data["content"]);
		return uniqueSources(
			collect(
				content.flatMap((raw) => {
					const item = getObject(raw);
					if (item?.["type"] === "text") {
						return webCitations(item).map((citation) =>
							result(
								getString(citation["title"])?.trim() || getString(citation["url"]),
								getString(citation["url"]),
							),
						);
					}
					if (item?.["type"] !== "web_search_tool_result") return [];
					return getArray(item["content"]).map((searchRaw) => {
						const searchItem = getObject(searchRaw);
						const source = result(
							getString(searchItem?.["title"])?.trim() || getString(searchItem?.["url"]),
							getString(searchItem?.["url"]),
						);
						const pageAge = getString(searchItem?.["page_age"]);
						if (source && pageAge) source.publishedAt = pageAge;
						return source;
					});
				}),
				Number.POSITIVE_INFINITY,
			),
		);
	},
};
