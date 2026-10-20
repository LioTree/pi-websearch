import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import { normalizeResponsesPayload } from "./openai-responses.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import { appendDomainFilters, bearerHeaders } from "./shared.js";

export const xaiProvider: ProviderModule = {
	buildRequest({ config, request, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		if ((allowedDomains?.length ?? 0) > 5 || (blockedDomains?.length ?? 0) > 5) {
			throw new Error("xAI hosted search supports at most 5 allowed or excluded domains; use a fallback provider.");
		}
		const webSearchTool: JsonObject = { type: "web_search" };
		let input = request.query;
		if (allowedDomains) {
			webSearchTool["filters"] = { allowed_domains: allowedDomains };
			// xAI accepts either allowed or excluded filters, not both: when allowed is
			// present, keep blocked exclusions in the query and let the postfilter enforce them.
			if (blockedDomains) input = appendDomainFilters(input, undefined, blockedDomains);
		} else if (blockedDomains) {
			webSearchTool["filters"] = { excluded_domains: blockedDomains };
		}
		return {
			url: providerUrl(config),
			init: { method: "POST", headers: bearerHeaders(config) },
			body: {
				model: config.model ?? "grok-4.3",
				input,
				tools: [webSearchTool],
				tool_choice: "required",
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeResponsesPayload(data, { citationsFallback: true });
	},
};
