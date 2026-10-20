import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import {
	anthropicHeaders,
	appendDomainFilters,
	collect,
	getArray,
	getObject,
	getString,
	isAnthropicOAuth,
	result,
} from "./shared.js";

export const anthropicProvider: ProviderModule = {
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
				...(isAnthropicOAuth(config)
					? {
							system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
						}
					: {}),
				max_tokens: 1024,
				messages: [{ role: "user", content: query }],
				tools: [webSearchTool],
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		const content = getArray(data["content"]);
		const text = content
			.map(getObject)
			.map((item) => getString(item?.["text"]))
			.filter((value): value is string => value !== undefined)
			.join("\n");
		return collect(
			content.flatMap((raw) => {
				const item = getObject(raw);
				if (item?.["type"] !== "web_search_tool_result") return [];
				return getArray(item["content"]).map((searchRaw) => {
					const searchItem = getObject(searchRaw);
					const source = result(getString(searchItem?.["title"]), getString(searchItem?.["url"]), text);
					const pageAge = getString(searchItem?.["page_age"]);
					if (source && pageAge) source.publishedAt = pageAge;
					return source;
				});
			}),
		);
	},
};
