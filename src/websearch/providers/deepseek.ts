import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import {
	appendDomainFilters,
	bearerHeaders,
	clamp,
	collect,
	getArray,
	getNumber,
	getObject,
	getString,
	result,
} from "./shared.js";

/** DeepSeek's dedicated Search API, not a model-generated chat answer. */
export const deepseekProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		const query = appendDomainFilters(request.query, allowedDomains, blockedDomains);
		if (query.trim().length === 0 || Array.from(query).length > 128) {
			throw new Error("DeepSeek search query, including domain filters, must contain 1 to 128 Unicode characters.");
		}
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: bearerHeaders(config) },
			body: { query, count: clamp(maxResults, 1, 50), need_content: false },
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return collect(
			getArray(data["results"]).map((raw) => {
				const item = getObject(raw);
				const source = result(
					getString(item?.["title"]),
					getString(item?.["url"]),
					getString(item?.["summary"]) || getString(item?.["snippet"]),
					getString(item?.["site_name"]),
					getNumber(item?.["rerank_score"]),
				);
				const date = getString(item?.["date"]);
				if (source && date) source.publishedAt = date;
				return source;
			}),
		);
	},
};
