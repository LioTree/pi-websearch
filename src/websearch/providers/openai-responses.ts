import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import {
	appendDomainFilters,
	bearerHeaders,
	collect,
	getArray,
	getObject,
	getString,
	mergeHeaders,
	result,
} from "./shared.js";

function searchOnlyPrompt(query: string): string {
	return `Find web pages matching any of these search terms or quoted phrases. If the query contains OR, search each alternative independently. Return only relevant source URLs, one per line. Query: ${query}`;
}

export function buildResponsesRequest({
	config,
	request,
	allowedDomains,
	blockedDomains,
}: BuildContext): BuiltSearchRequest {
	const webSearchTool: JsonObject = {
		type: "web_search",
		external_web_access: (config.codexMode ?? "live") === "live",
	};
	if (config.searchContextSize) webSearchTool["search_context_size"] = config.searchContextSize;
	if (allowedDomains) webSearchTool["filters"] = { allowed_domains: allowedDomains };
	if (config.userLocation) webSearchTool["user_location"] = { type: "approximate", ...config.userLocation };
	const input = searchOnlyPrompt(
		blockedDomains ? appendDomainFilters(request.query, undefined, blockedDomains) : request.query,
	);

	const headers = bearerHeaders(config);
	// This wire format works with both API keys and OAuth. Credentials can be
	// opaque or overridden, so never infer transport from optional JWT claims.
	const streaming = config.provider === "openai";
	return {
		url: providerUrl(config),
		...(streaming ? { responseFormat: "responses-sse" as const } : {}),
		init: {
			method: "POST",
			headers: streaming ? mergeHeaders(headers, { Accept: "text/event-stream" }) : headers,
		},
		body: {
			model: config.model ?? "gpt-5.5",
			input: streaming ? [{ role: "user", content: [{ type: "input_text", text: input }] }] : input,
			...(streaming ? { store: false, stream: true } : {}),
			tools: [webSearchTool],
			include: ["web_search_call.action.sources"],
			tool_choice: "required",
		},
	};
}

/**
 * Normalize only structured search and citation sources. Text-only responses are not
 * evidence that the endpoint honored the hosted search tool, so prose URLs are ignored.
 */
export function normalizeResponsesPayload(
	data: JsonObject,
	options: { citationsFallback: boolean },
): SearchResultItem[] {
	if (data["error"] || (data["status"] !== undefined && data["status"] !== "completed")) return [];
	const output = getArray(data["output"]);
	const sources = collect(
		output.flatMap((raw) => {
			const item = getObject(raw);
			if (item?.["type"] !== "web_search_call") return [];
			const action = getObject(item["action"]);
			return getArray(action?.["sources"]).map((sourceRaw) => {
				const source = getObject(sourceRaw);
				const url = getString(source?.["url"]);
				return result(url, url);
			});
		}),
	);
	const contents = output.flatMap((raw) => {
		const message = getObject(raw);
		if (message?.["type"] !== "message") return [];
		return getArray(message["content"])
			.map(getObject)
			.filter((item): item is JsonObject => item !== undefined && item["type"] === "output_text");
	});
	const text =
		contents
			.map((content) => getString(content["text"]) ?? "")
			.filter(Boolean)
			.join("\n") || undefined;
	const annotationResults = collect(
		contents.flatMap((content) =>
			getArray(content["annotations"]).map((raw) => {
				const item = getObject(raw);
				if (item?.["type"] !== "url_citation") return null;
				const url = getString(item["url"]);
				return result(getString(item["title"]) ?? url, url, getString(content["text"]));
			}),
		),
	);
	// Citations carry better titles, but must not hide other structured sources.
	const structured = new Map<string, SearchResultItem>();
	for (const source of [...annotationResults, ...sources]) {
		if (!structured.has(source.url)) structured.set(source.url, source);
	}
	if (structured.size > 0) {
		return collect([...structured.values()]).map((source) => {
			if (source.snippet || text === undefined) return source;
			return { ...source, snippet: text };
		});
	}
	if (!options.citationsFallback) return [];
	return collect(
		getArray(data["citations"]).map((raw) => {
			const url = getString(raw);
			return result(url, url, text);
		}),
	);
}

export const openAiResponsesProvider: ProviderModule = {
	buildRequest(ctx: BuildContext): BuiltSearchRequest {
		return buildResponsesRequest(ctx);
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeResponsesPayload(data, { citationsFallback: false });
	},
};
