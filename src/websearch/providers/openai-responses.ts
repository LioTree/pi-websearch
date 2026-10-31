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
	SEARCH_INSTRUCTIONS,
} from "./shared.js";

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
	const input = blockedDomains ? appendDomainFilters(request.query, undefined, blockedDomains) : request.query;

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
			instructions: SEARCH_INSTRUCTIONS,
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
				return result(getString(source?.["title"])?.trim() || url, url);
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
	const annotationResults = collect(
		contents.flatMap((content) =>
			getArray(content["annotations"]).map((raw) => {
				const item = getObject(raw);
				if (item?.["type"] !== "url_citation") return null;
				const url = getString(item["url"]);
				return result(getString(item["title"])?.trim() || url, url);
			}),
		),
	);
	// Citations carry better titles, but must not hide other structured sources.
	const structured = new Map<string, SearchResultItem>();
	for (const source of [...annotationResults, ...sources]) {
		if (!structured.has(source.url)) structured.set(source.url, source);
	}
	if (structured.size > 0) {
		return collect([...structured.values()]);
	}
	if (!options.citationsFallback) return [];
	return collect(
		getArray(data["citations"]).map((raw) => {
			const url = getString(raw);
			return result(url, url);
		}),
	);
}

export function responsesAnswer(data: JsonObject): string | undefined {
	if (data["error"] || (data["status"] !== undefined && data["status"] !== "completed")) return undefined;
	return (
		getArray(data["output"])
			.map(getObject)
			.filter((item) => item?.["type"] === "message")
			.flatMap((item) => getArray(item?.["content"]))
			.map(getObject)
			.filter((item) => item?.["type"] === "output_text")
			.map((item) => getString(item?.["text"]) ?? "")
			.filter(Boolean)
			.join("\n") || undefined
	);
}

export const openAiResponsesProvider: ProviderModule = {
	normalizeAnswer: responsesAnswer,
	buildRequest(ctx: BuildContext): BuiltSearchRequest {
		return buildResponsesRequest(ctx);
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeResponsesPayload(data, { citationsFallback: false });
	},
};
