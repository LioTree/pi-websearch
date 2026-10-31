import { describe, expect, it } from "vitest";

import { EmptyDomainPolicyError } from "../src/websearch/domains.js";
import { SEARCH_INSTRUCTIONS } from "../src/websearch/providers/shared.js";
import { buildSearchRequest, isDirectSearchProvider, normalizeSearchResponse } from "../src/websearch/providers.js";
import type { SearchProvider, SearchProviderConfig } from "../src/websearch/types.js";

function configFor(provider: SearchProvider): SearchProviderConfig {
	if (provider === "exa") return { provider };
	if (provider === "openai-codex")
		return { provider, headers: { Authorization: "Bearer test-token", "chatgpt-account-id": "test-account" } };
	if (provider === "google-cse") return { provider, apiKey: "google-test", searchEngineId: "cx-test" };
	return { provider, apiKey: `${provider}-test` };
}

describe("buildSearchRequest", () => {
	it("#given base url override for each provider #when building request #then uses configured endpoint", () => {
		// given
		const providers: SearchProvider[] = [
			"exa",
			"tavily",
			"serpdive",
			"brave",
			"serper",
			"google-cse",
			"z-ai",
			"openai",
			"codex",
			"openai-codex",
			"anthropic",
			"perplexity",
			"xai",
			"kimi",
			"kagi",
			"deepseek",
		];

		for (const provider of providers) {
			const config: SearchProviderConfig = {
				...configFor(provider),
				baseUrl: `https://gateway.example.com/${provider}`,
			};

			// when
			const request = buildSearchRequest(config, { query: "override endpoint", maxResults: 4 });

			// then
			expect(request.url.startsWith(`https://gateway.example.com/${provider}`)).toBe(true);
		}
	});

	it("#given exa config with api key #when building request #then sends exa key", () => {
		// given
		const config: SearchProviderConfig = { provider: "exa", apiKey: "exa-test" };

		// when
		const request = buildSearchRequest(config, { query: "pi extension", maxResults: 4 });

		// then
		expect(request.url).toBe("https://api.exa.ai/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("x-api-key", "exa-test");
		expect(request.body).toEqual({ query: "pi extension", numResults: 4 });
	});

	it("#given tavily config #when building request #then sends bearer token", () => {
		// given
		const config: SearchProviderConfig = { provider: "tavily", apiKey: "tvly-test" };

		// when
		const request = buildSearchRequest(config, { query: "current docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://api.tavily.com/search");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer tvly-test");
		expect(request.body).toEqual({ query: "current docs", max_results: 5 });
	});

	it("#given serpdive config #when building request #then sends bearer token and folds domain filters into the query", () => {
		// given
		const config: SearchProviderConfig = { provider: "serpdive", apiKey: "sd-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 20,
			allowedDomains: ["docs.example.com"],
			blockedDomains: ["reddit.com"],
		});

		// then
		expect(request.url).toBe("https://api.serpdive.com/v1/search");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer sd-test");
		expect(request.body).toEqual({
			query: "current docs site:docs.example.com -site:reddit.com",
			max_results: 10,
		});
	});

	it("#given allowed domain filter #when building brave request #then maps filter into provider query", () => {
		// given
		const config: SearchProviderConfig = { provider: "brave", apiKey: "brave-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "node fetch",
			maxResults: 2,
			allowedDomains: ["nodejs.org"],
		});

		// then
		expect(request.url).toContain("site%3Anodejs.org");
		expect(request.init.headers).toHaveProperty("X-Subscription-Token", "brave-test");
	});

	it("#given duckduckgo html config #when building request #then uses html endpoint without api key", () => {
		// given
		const config: SearchProviderConfig = { provider: "duckduckgo-html" };

		// when
		const request = buildSearchRequest(config, {
			query: "zero config search",
			maxResults: 4,
			blockedDomains: ["spam.example.com"],
		});

		// then
		expect(request.url).toContain("https://html.duckduckgo.com/html/");
		expect(request.url).toContain("q=zero+config+search+-site%3Aspam.example.com");
		expect(request.init.method).toBe("GET");
		expect(request.init.headers).toHaveProperty("Accept", "text/html");
		expect(request.body).toBeUndefined();
	});

	it("#given config allowlist and request allowlist #when building request #then request narrows config policy", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "exa",
			allowedDomains: ["docs.example.com", "api.example.com"],
		};

		// when
		const request = buildSearchRequest(config, {
			query: "sdk docs",
			maxResults: 3,
			allowedDomains: ["api.example.com", "other.example.com"],
		});

		// then
		expect(request.body).toEqual({ query: "sdk docs", numResults: 3, includeDomains: ["api.example.com"] });
	});

	it("#given config allowlist and request blocklist #when building request #then request narrows config policy", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "exa",
			allowedDomains: ["docs.example.com", "api.example.com"],
		};

		// when
		const request = buildSearchRequest(config, {
			query: "sdk docs",
			maxResults: 3,
			blockedDomains: ["docs.example.com"],
		});

		// then
		expect(request.body).toEqual({
			query: "sdk docs",
			numResults: 3,
			includeDomains: ["api.example.com"],
			excludeDomains: ["docs.example.com"],
		});
	});

	it("#given config blocklist and request allowlist #when building request #then blocked domains remain excluded", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "brave",
			apiKey: "brave-test",
			blockedDomains: ["blocked.example.com"],
		};

		// when
		const request = buildSearchRequest(config, {
			query: "node fetch",
			maxResults: 2,
			allowedDomains: ["blocked.example.com", "nodejs.org"],
		});

		// then
		expect(request.url).toContain("site%3Anodejs.org");
		expect(request.url).toContain("-site%3Ablocked.example.com");
		expect(request.url.match(/site%3Ablocked\.example\.com/g)).toHaveLength(1);
	});

	it("#given z-ai config #when building request #then uses web search endpoint and bearer token", () => {
		// given
		const config: SearchProviderConfig = { provider: "z-ai", apiKey: "zai-test" };

		// when
		const request = buildSearchRequest(config, { query: "financial news", maxResults: 15 });

		// then
		expect(request.url).toBe("https://api.z.ai/api/paas/v4/web_search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer zai-test");
		expect(request.body).toEqual({ search_engine: "search-prime", search_query: "financial news", count: 15 });
	});

	it("#given codex config #when building request #then uses hosted web_search tool shape", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "openai",
			apiKey: "openai-test",
			model: "gpt-5.5",
			codexMode: "cached",
			searchContextSize: "high",
		};

		// when
		const request = buildSearchRequest(config, { query: "latest OpenAI web search docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://api.openai.com/v1/responses");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer openai-test");
		expect(request.body).toEqual({
			model: "gpt-5.5",
			instructions:
				"Search the web and return a concise answer grounded only in the web results.\nInclude clickable source citations in the response text when possible.",
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: "latest OpenAI web search docs",
						},
					],
				},
			],
			store: false,
			stream: true,
			tools: [{ type: "web_search", external_web_access: false, search_context_size: "high" }],
			include: ["web_search_call.action.sources"],
			tool_choice: "required",
		});
	});

	it("#given codex blocklist #when building request #then maps blocked domains into input query", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "codex",
			apiKey: "openai-test",
			blockedDomains: ["spam.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "latest docs", maxResults: 5 });

		// then
		expect(request.body).toEqual({
			model: "gpt-5.5",
			instructions:
				"Search the web and return a concise answer grounded only in the web results.\nInclude clickable source citations in the response text when possible.",
			input: "latest docs -site:spam.example.com",
			tools: [{ type: "web_search", external_web_access: true }],
			include: ["web_search_call.action.sources"],
			tool_choice: "required",
		});
	});

	it("#given perplexity config #when building request #then uses direct search endpoint", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "perplexity",
			apiKey: "pplx-test",
			allowedDomains: ["docs.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "search api docs", maxResults: 25 });

		// then
		expect(request.url).toBe("https://api.perplexity.ai/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer pplx-test");
		expect(request.body).toEqual({
			query: "search api docs",
			max_results: 20,
			search_domain_filter: ["docs.example.com"],
		});
	});

	it("#given native perplexity config #when building request #then uses chat completion payload", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "perplexity",
			apiKey: "pplx-test",
			baseUrl: "https://api.perplexity.ai/chat/completions",
			model: "sonar-pro",
			allowedDomains: ["docs.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "search api docs", maxResults: 25 });

		// then
		expect(request.url).toBe("https://api.perplexity.ai/chat/completions");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer pplx-test");
		expect(request.body).toEqual({
			model: "sonar-pro",
			messages: [
				{ role: "system", content: SEARCH_INSTRUCTIONS },
				{ role: "user", content: "search api docs" },
			],
			search_domain_filter: ["docs.example.com"],
		});
	});

	it("#given xai config #when building request #then uses responses web_search tool shape", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "xai",
			apiKey: "xai-test",
			model: "grok-4.3",
			blockedDomains: ["spam.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "current xai docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://api.x.ai/v1/responses");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer xai-test");
		expect(request.body).toEqual({
			model: "grok-4.3",
			instructions: SEARCH_INSTRUCTIONS,
			input: "current xai docs",
			tools: [{ type: "web_search", filters: { excluded_domains: ["spam.example.com"] } }],
			tool_choice: "required",
		});
	});

	it("#given anthropic config #when building request #then uses messages web_search tool shape", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "anthropic",
			apiKey: "anthropic-test",
			baseUrl: "https://anthropic.gateway.example.com/v1/messages",
			model: "claude-sonnet-4-5-20250929",
			allowedDomains: ["docs.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "current anthropic search docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://anthropic.gateway.example.com/v1/messages");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("x-api-key", "anthropic-test");
		expect(request.init.headers).toHaveProperty("anthropic-version", "2023-06-01");
		expect(request.body).toEqual({
			model: "claude-sonnet-4-5-20250929",
			system: [{ type: "text", text: SEARCH_INSTRUCTIONS }],
			max_tokens: 1024,
			messages: [{ role: "user", content: "current anthropic search docs" }],
			tools: [
				{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["docs.example.com"] },
			],
		});
	});

	it("#given native z-ai config #when building request #then uses chat completion web search payload", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "z-ai",
			apiKey: "zai-test",
			baseUrl: "https://api.z.ai/chat/completions",
			model: "glm-4.6",
			allowedDomains: ["docs.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "financial news", maxResults: 15 });

		// then
		expect(request.url).toBe("https://api.z.ai/chat/completions");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer zai-test");
		expect(request.body).toEqual({
			model: "glm-4.6",
			messages: [
				{ role: "system", content: SEARCH_INSTRUCTIONS },
				{ role: "user", content: "financial news" },
			],
			tools: [
				{
					type: "web_search",
					web_search: {
						enable: true,
						search_engine: "search-prime",
						search_result: true,
						count: 15,
						search_domain_filter: "docs.example.com",
					},
				},
			],
		});
	});

	it("#given kimi config #when building request #then posts to kimi coding search with bearer token", () => {
		// given
		const config: SearchProviderConfig = { provider: "kimi", apiKey: "kimi-test" };

		// when
		const request = buildSearchRequest(config, { query: "current docs", maxResults: 5 });

		// then
		expect(request.url).toBe("https://api.kimi.com/coding/v1/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers["Authorization"]).toBe("Bearer kimi-test");
		expect(request.body).toEqual({
			text_query: "current docs",
			limit: 5,
			enable_page_crawling: false,
			timeout_seconds: 30,
		});
	});

	it("#given kagi config #when building request #then posts query with lens domain filters", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "kagi",
			apiKey: "kagi-test",
			allowedDomains: ["docs.example.com", "api.example.com"],
		};

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["api.example.com"],
		});

		// then
		expect(request.url).toBe("https://kagi.com/api/v1/search");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers["Authorization"]).toBe("Bearer kagi-test");
		expect(request.body).toEqual({
			query: "current docs",
			limit: 5,
			lens: { sites_included: ["api.example.com"] },
		});
	});

	it("#given kagi config blocklist #when building request #then maps blocklist into lens exclusions", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "kagi",
			apiKey: "kagi-test",
			blockedDomains: ["spam.example.com"],
		};

		// when
		const request = buildSearchRequest(config, { query: "current docs", maxResults: 5 });

		// then
		expect(request.body).toEqual({
			query: "current docs",
			limit: 5,
			lens: { sites_excluded: ["spam.example.com"] },
		});
	});

	it("#given kagi config without domain filters #when building request #then omits lens", () => {
		// given
		const config: SearchProviderConfig = { provider: "kagi", apiKey: "kagi-test" };

		// when
		const request = buildSearchRequest(config, { query: "current docs", maxResults: 30 });

		// then
		expect(request.url).toBe("https://kagi.com/api/v1/search");
		expect(request.body).toEqual({ query: "current docs", limit: 20 });
	});
});

describe("normalizeSearchResponse", () => {
	it("#given duckduckgo html response #when normalizing #then extracts result links", () => {
		// given
		const payload = {
			html: `
				<html><body>
					<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fpi&amp;rut=abc">Pi Docs</a>
					<a class="result__snippet">Useful docs snippet</a>
				</body></html>
			`,
		};

		// when
		const results = normalizeSearchResponse("duckduckgo-html", payload);

		// then
		expect(results).toEqual([
			{ title: "Pi Docs", url: "https://docs.example.com/pi", snippet: "Useful docs snippet" },
		]);
	});

	it("#given tavily response #when normalizing #then returns common results", () => {
		// given
		const payload = {
			results: [{ title: "Docs", url: "https://docs.example.com", content: "Useful docs", score: 0.9 }],
			response_time: 1.25,
		};

		// when
		const results = normalizeSearchResponse("tavily", payload);

		// then
		expect(results).toEqual([{ title: "Docs", url: "https://docs.example.com", snippet: "Useful docs", score: 0.9 }]);
	});

	it("#given serpdive response #when normalizing #then returns common results", () => {
		// given
		const payload = {
			results: [
				{ title: "Docs", url: "https://docs.example.com", content: "Extracted page content", date: "2026-06-19" },
			],
			response_time_ms: 1400,
		};

		// when
		const results = normalizeSearchResponse("serpdive", payload);

		// then
		expect(results).toEqual([{ title: "Docs", url: "https://docs.example.com", snippet: "Extracted page content" }]);
	});

	it("#given serper response #when normalizing #then uses organic links", () => {
		// given
		const payload = { organic: [{ title: "Result", link: "https://example.com", snippet: "Snippet", position: 1 }] };

		// when
		const results = normalizeSearchResponse("serper", payload);

		// then
		expect(results).toEqual([{ title: "Result", url: "https://example.com", snippet: "Snippet" }]);
	});

	it("#given z-ai response #when normalizing #then uses search_result links", () => {
		// given
		const payload = {
			search_result: [{ title: "Z Result", link: "https://z.example.com", content: "Z snippet", media: "Example" }],
		};

		// when
		const results = normalizeSearchResponse("z-ai", payload);

		// then
		expect(results).toEqual([
			{ title: "Z Result", url: "https://z.example.com", snippet: "Z snippet", source: "Example" },
		]);
	});

	it("#given codex response #when normalizing #then uses URL citation annotations", () => {
		// given
		const payload = {
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "Answer with source",
							annotations: [
								{
									type: "url_citation",
									url: "https://openai.com",
									title: "OpenAI",
									start_index: 0,
									end_index: 6,
								},
							],
						},
					],
				},
			],
		};

		// when
		const results = normalizeSearchResponse("codex", payload);

		// then
		expect(results).toEqual([{ title: "OpenAI", url: "https://openai.com" }]);
	});

	it("#given openai response with a URL only in prose #when normalizing #then ignores the unverified URL", () => {
		// given
		const payload = {
			output: [
				{ type: "web_search_call", status: "completed", action: { type: "search", queries: ["oh my openagent"] } },
				{
					type: "message",
					content: [{ type: "output_text", text: "https://ohmyopenagent.com/", annotations: [] }],
				},
			],
		};

		// when
		const results = normalizeSearchResponse("openai", payload);

		// then
		expect(results).toEqual([]);
	});

	it("#given a gateway that ignored the hosted tool and returned prose URLs #when normalizing #then returns no sources", () => {
		// given
		const payload = {
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "Here are links: https://fake.example.com and https://other.example.com",
							annotations: [],
						},
					],
				},
			],
		};

		// when
		const results = normalizeSearchResponse("openai", payload);

		// then
		expect(results).toEqual([]);
	});

	it("#given structured web search sources #when normalizing #then returns those sources", () => {
		// given
		const payload = {
			output: [
				{
					type: "web_search_call",
					action: { sources: [{ url: "https://source.example.com" }, { url: "https://second.example.com" }] },
				},
			],
		};

		// when
		const results = normalizeSearchResponse("openai", payload);

		// then
		expect(results).toEqual([
			{ title: "https://source.example.com", url: "https://source.example.com" },
			{ title: "https://second.example.com", url: "https://second.example.com" },
		]);
	});

	it("#given perplexity response #when normalizing #then uses result snippets", () => {
		// given
		const payload = {
			results: [
				{ title: "Perplexity", url: "https://docs.perplexity.ai", snippet: "Search docs", date: "2026-01-01" },
			],
		};

		// when
		const results = normalizeSearchResponse("perplexity", payload);

		// then
		expect(results).toEqual([
			{ title: "Perplexity", url: "https://docs.perplexity.ai", snippet: "Search docs", publishedAt: "2026-01-01" },
		]);
	});

	it("#given perplexity chat completion response #when normalizing #then uses search result snippets", () => {
		// given
		const payload = {
			choices: [{ message: { content: "Answer with sources" } }],
			search_results: [
				{ title: "Perplexity", url: "https://docs.perplexity.ai", snippet: "Search docs", date: "2026-01-01" },
			],
		};

		// when
		const results = normalizeSearchResponse("perplexity", payload);

		// then
		expect(results).toEqual([
			{ title: "Perplexity", url: "https://docs.perplexity.ai", snippet: "Search docs", publishedAt: "2026-01-01" },
		]);
	});

	it("#given xai response without annotations #when normalizing #then falls back to citations", () => {
		// given
		const payload = {
			output: [{ type: "message", content: [{ type: "output_text", text: "Answer from Grok", annotations: [] }] }],
			citations: ["https://x.ai"],
		};

		// when
		const results = normalizeSearchResponse("xai", payload);

		// then
		expect(results).toEqual([{ title: "https://x.ai", url: "https://x.ai" }]);
	});

	it("#given anthropic response #when normalizing #then extracts web search tool results", () => {
		// given
		const payload = {
			content: [
				{ type: "text", text: "Answer with Anthropic source" },
				{
					type: "web_search_tool_result",
					content: [
						{
							type: "web_search_result",
							title: "Anthropic",
							url: "https://docs.anthropic.com",
							page_age: "2026-01-01",
						},
					],
				},
			],
		};

		// when
		const results = normalizeSearchResponse("anthropic", payload);

		// then
		expect(results).toEqual([
			{
				title: "Anthropic",
				url: "https://docs.anthropic.com",
				publishedAt: "2026-01-01",
			},
		]);
	});

	it("#given z-ai chat completion response #when normalizing #then uses web search citations", () => {
		// given
		const payload = {
			choices: [{ message: { content: "Answer with Z.ai source" } }],
			web_search: [
				{
					title: "Z Result",
					link: "https://z.example.com",
					content: "Z snippet",
					media: "Example",
				},
			],
		};

		// when
		const results = normalizeSearchResponse("z-ai", payload);

		// then
		expect(results).toEqual([
			{ title: "Z Result", url: "https://z.example.com", snippet: "Z snippet", source: "Example" },
		]);
	});

	it("#given kimi response #when normalizing #then maps search_results", () => {
		// given
		const payload = {
			answer: "Synthesized answer",
			search_results: [
				{ title: "Kimi Result", url: "https://kimi.example.com", summary: "Kimi snippet", content: "Full content" },
			],
		};

		// when
		const results = normalizeSearchResponse("kimi", payload);

		// then
		expect(results).toEqual([{ title: "Kimi Result", url: "https://kimi.example.com", snippet: "Kimi snippet" }]);
	});

	it("#given kagi response #when normalizing #then maps data search results", () => {
		// given
		const payload = {
			meta: { ms: 42 },
			data: {
				search: [
					{
						title: "Kagi Result",
						url: "https://kagi.example.com",
						snippet: "Kagi snippet",
						time: "2026-01-01T00:00:00Z",
					},
				],
			},
		};

		// when
		const results = normalizeSearchResponse("kagi", payload);

		// then
		expect(results).toEqual([
			{
				title: "Kagi Result",
				url: "https://kagi.example.com",
				snippet: "Kagi snippet",
				publishedAt: "2026-01-01T00:00:00Z",
			},
		]);
	});
});

describe("isDirectSearchProvider", () => {
	it("#given hosted and direct entries #when classifying #then preserves Z.ai and Perplexity model-vs-direct semantics", () => {
		// given
		const cases: Array<{ entry: { provider: SearchProvider; model?: string }; direct: boolean }> = [
			{ entry: { provider: "openai" }, direct: false },
			{ entry: { provider: "openai", model: "gpt-5.5" }, direct: false },
			{ entry: { provider: "codex", model: "gpt-5.5" }, direct: false },
			{ entry: { provider: "anthropic", model: "claude-sonnet-5" }, direct: false },
			{ entry: { provider: "xai", model: "grok-4.3" }, direct: false },
			{ entry: { provider: "z-ai" }, direct: true },
			{ entry: { provider: "z-ai", model: "glm-4.6" }, direct: false },
			{ entry: { provider: "perplexity" }, direct: true },
			{ entry: { provider: "perplexity", model: "sonar-pro" }, direct: false },
			{ entry: { provider: "kimi", model: "k3" }, direct: true },
			{ entry: { provider: "exa" }, direct: true },
			{ entry: { provider: "duckduckgo-html" }, direct: true },
		];

		for (const testCase of cases) {
			// when
			const direct = isDirectSearchProvider(testCase.entry);

			// then
			expect(direct).toBe(testCase.direct);
		}
	});
});

describe("provider auth headers", () => {
	it("#given case-insensitive config headers #when building a request #then config overrides defaults and null deletes them", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "openai",
			apiKey: "openai-key",
			headers: { authorization: "Bearer gateway-token", "content-type": null },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("authorization", "Bearer gateway-token");
		expect(request.init.headers).not.toHaveProperty("Authorization");
		expect(request.init.headers).not.toHaveProperty("Content-Type");
		expect(request.init.headers).toHaveProperty("Accept", "text/event-stream");
	});

	it("#given a null Authorization tombstone and an API key #when building a request #then does not recreate the deleted header", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "openai",
			apiKey: "openai-key",
			headers: { Authorization: null },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).not.toHaveProperty("Authorization");
	});

	it("#given Cloudflare gateway auth #when building an OpenAI request #then keeps the provider Bearer alongside it", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "openai",
			apiKey: "openai-key",
			headers: { "cf-aig-authorization": "Bearer gateway-token" },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer openai-key");
		expect(request.init.headers).toHaveProperty("cf-aig-authorization", "Bearer gateway-token");
	});

	it("#given an explicit x-api-key header #when building an OpenAI request #then does not also add a bearer token", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "openai",
			apiKey: "openai-key",
			headers: { "x-api-key": "gateway-key" },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("x-api-key", "gateway-key");
		expect(request.init.headers).not.toHaveProperty("Authorization");
	});

	it("#given an Anthropic API key #when building a request #then uses x-api-key only", () => {
		// given
		const config: SearchProviderConfig = { provider: "anthropic", apiKey: "sk-ant-api03-test" };

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("x-api-key", "sk-ant-api03-test");
		expect(request.init.headers).not.toHaveProperty("Authorization");
		expect(request.init.headers).toHaveProperty("anthropic-version", "2023-06-01");
	});

	it("#given an Anthropic OAuth token #when building a request #then supplies client defaults and honors an explicit beta", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "anthropic",
			apiKey: "sk-ant-oat01-test",
			headers: { "anthropic-beta": "custom-beta" },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer sk-ant-oat01-test");
		expect(request.init.headers).not.toHaveProperty("x-api-key");
		expect(request.init.headers["anthropic-beta"]).toContain("custom-beta");
		expect(request.init.headers["anthropic-beta"]).toContain("claude-code-20250219");
		expect(request.init.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
		expect(request.init.headers["user-agent"]).toMatch(/^claude-cli\//);
		expect(request.init.headers).toHaveProperty("x-app", "cli");
	});

	it("#given Anthropic OAuth without an explicit beta #when building a request #then supplies the required betas", () => {
		// given
		const config: SearchProviderConfig = { provider: "anthropic", apiKey: "sk-ant-oat01-test" };

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers["anthropic-beta"]).toContain("claude-code-20250219");
		expect(request.init.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
	});

	it("#given Anthropic OAuth with a null beta tombstone #when building a request #then does not add the required betas", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "anthropic",
			apiKey: "sk-ant-oat01-test",
			headers: { "anthropic-beta": null },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).not.toHaveProperty("anthropic-beta");
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer sk-ant-oat01-test");
	});

	it("#given Anthropic OAuth with an explicit x-api-key #when building a request #then honors it and adds no Bearer", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "anthropic",
			apiKey: "sk-ant-oat01-test",
			headers: { "x-api-key": "proxy-key" },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("x-api-key", "proxy-key");
		expect(request.init.headers).not.toHaveProperty("Authorization");
		expect(request.init.headers["anthropic-beta"]).toContain("claude-code-20250219");
	});

	it("#given Anthropic OAuth with an explicit Authorization override #when building a request #then preserves it", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "anthropic",
			apiKey: "sk-ant-oat01-test",
			headers: { Authorization: "Bearer proxy-token" },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer proxy-token");
		expect(request.init.headers).not.toHaveProperty("x-api-key");
	});

	it("#given Anthropic OAuth with a null Authorization tombstone #when building a request #then does not recreate the header", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "anthropic",
			apiKey: "sk-ant-oat01-test",
			headers: { Authorization: null },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).not.toHaveProperty("Authorization");
		expect(request.init.headers).not.toHaveProperty("x-api-key");
	});

	it("#given header-only Anthropic auth #when building a request #then preserves the header and adds no x-api-key", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "anthropic",
			headers: { Authorization: "Bearer external-token" },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer external-token");
		expect(request.init.headers).not.toHaveProperty("x-api-key");
		expect(request.init.headers).toHaveProperty("anthropic-version", "2023-06-01");
	});

	it("#given header-only Kimi auth #when building a request #then preserves the header without adding an empty bearer", () => {
		// given
		const config: SearchProviderConfig = {
			provider: "kimi",
			headers: { Authorization: "Bearer kimi-oauth" },
		};

		// when
		const request = buildSearchRequest(config, { query: "headers", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer kimi-oauth");
		expect(request.init.headers).not.toHaveProperty("Authorization", "Bearer ");
	});
});

describe("perplexity citations", () => {
	it("#given a chat completion with citations #when normalizing #then returns the citation URLs", () => {
		// given
		const payload = {
			choices: [{ message: { content: "Answer with sources" } }],
			citations: ["https://one.example.com", "https://two.example.com"],
		};

		// when
		const results = normalizeSearchResponse("perplexity", payload);

		// then
		expect(results).toEqual([
			{ title: "https://one.example.com", url: "https://one.example.com" },
			{ title: "https://two.example.com", url: "https://two.example.com" },
		]);
	});
});

describe("domain policy request construction", () => {
	it("#given hierarchical allowed scopes with mixed case #when building request #then narrows to the canonical child without a sentinel", () => {
		// given
		const config: SearchProviderConfig = { provider: "exa", allowedDomains: ["Example.com."] };

		// when
		const request = buildSearchRequest(config, {
			query: "sdk docs",
			maxResults: 3,
			allowedDomains: ["Docs.Example.com."],
		});

		// then
		expect(request.body).toEqual({ query: "sdk docs", numResults: 3, includeDomains: ["docs.example.com"] });
		expect(JSON.stringify(request.body)).not.toContain("invalid.invalid");
	});

	it("#given a narrower provider entry scope #when building request #then it narrows the broader request scope", () => {
		// given
		const config: SearchProviderConfig = { provider: "exa", allowedDomains: ["Docs.Example.com"] };

		// when
		const request = buildSearchRequest(config, {
			query: "sdk docs",
			maxResults: 3,
			allowedDomains: ["EXAMPLE.com."],
		});

		// then
		expect(request.body).toEqual({ query: "sdk docs", numResults: 3, includeDomains: ["docs.example.com"] });
	});

	it("#given disjoint allowed scopes #when building request #then throws before any request is built", () => {
		// given
		const config: SearchProviderConfig = { provider: "exa", allowedDomains: ["example.com"] };

		// when / then
		expect(() =>
			buildSearchRequest(config, { query: "sdk docs", maxResults: 3, allowedDomains: ["other.example.net"] }),
		).toThrow(EmptyDomainPolicyError);
	});

	it("#given a blocked parent of an allowed child #when building request #then throws an empty policy error", () => {
		// given
		const config: SearchProviderConfig = { provider: "exa", blockedDomains: ["example.com"] };

		// when / then
		expect(() =>
			buildSearchRequest(config, { query: "sdk docs", maxResults: 3, allowedDomains: ["docs.example.com"] }),
		).toThrow(EmptyDomainPolicyError);
	});

	it("#given an allowed parent and a blocked child #when building request #then sends both native filters", () => {
		// given
		const config: SearchProviderConfig = { provider: "exa", allowedDomains: ["example.com"] };

		// when
		const request = buildSearchRequest(config, {
			query: "sdk docs",
			maxResults: 3,
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.body).toEqual({
			query: "sdk docs",
			numResults: 3,
			includeDomains: ["example.com"],
			excludeDomains: ["ads.example.com"],
		});
	});

	it("#given both filters for OpenAI #when building request #then keeps native allowed filters and blocked query exclusions", () => {
		// given
		const config: SearchProviderConfig = { provider: "openai", apiKey: "openai-test", model: "gpt-5.5" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["example.com"],
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.body).toMatchObject({
			tools: [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }],
		});
		expect(request.body).toHaveProperty("input", [
			{
				role: "user",
				content: [
					{
						type: "input_text",
						text: "current docs -site:ads.example.com",
					},
				],
			},
		]);
	});

	it("#given both filters for Anthropic #when building request #then sends allowed natively and blocked in the query", () => {
		// given
		const config: SearchProviderConfig = { provider: "anthropic", apiKey: "anthropic-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["example.com"],
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.body).toEqual({
			model: "claude-sonnet-4-5-20250929",
			system: [{ type: "text", text: SEARCH_INSTRUCTIONS }],
			max_tokens: 1024,
			messages: [{ role: "user", content: "current docs -site:ads.example.com" }],
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 8,
					allowed_domains: ["example.com"],
				},
			],
		});
	});

	it("#given blocked-only filters for Anthropic #when building request #then keeps the native blocked filter", () => {
		// given
		const config: SearchProviderConfig = { provider: "anthropic", apiKey: "anthropic-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.body).toEqual({
			model: "claude-sonnet-4-5-20250929",
			system: [{ type: "text", text: SEARCH_INSTRUCTIONS }],
			max_tokens: 1024,
			messages: [{ role: "user", content: "current docs" }],
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 8,
					blocked_domains: ["ads.example.com"],
				},
			],
		});
	});

	it("#given both filters for xAI #when building request #then sends allowed natively and blocked in the input", () => {
		// given
		const config: SearchProviderConfig = { provider: "xai", apiKey: "xai-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["example.com"],
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.body).toEqual({
			model: "grok-4.3",
			instructions: SEARCH_INSTRUCTIONS,
			input: "current docs -site:ads.example.com",
			tools: [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }],
			tool_choice: "required",
		});
	});

	it("#given both filters for Perplexity search #when building request #then sends allowed natively and blocked in the query", () => {
		// given
		const config: SearchProviderConfig = { provider: "perplexity", apiKey: "pplx-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["example.com"],
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.body).toEqual({
			query: "current docs -site:ads.example.com",
			max_results: 5,
			search_domain_filter: ["example.com"],
		});
	});

	it("#given both filters for Perplexity chat #when building request #then sends allowed natively and blocked in the message", () => {
		// given
		const config: SearchProviderConfig = { provider: "perplexity", apiKey: "pplx-test", model: "sonar-pro" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["example.com"],
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.body).toEqual({
			model: "sonar-pro",
			messages: [
				{ role: "system", content: SEARCH_INSTRUCTIONS },
				{ role: "user", content: "current docs -site:ads.example.com" },
			],
			search_domain_filter: ["example.com"],
		});
	});

	it("#given several allowed domains for Z.ai #when building request #then keeps all alternatives in the query", () => {
		// given
		const config: SearchProviderConfig = { provider: "z-ai", apiKey: "zai-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["docs.example.com", "api.example.com"],
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.body).toEqual({
			search_engine: "search-prime",
			search_query: "current docs (site:docs.example.com OR site:api.example.com) -site:ads.example.com",
			count: 5,
		});
	});

	it("#given several allowed domains for Kimi #when building request #then ORs the site alternatives and keeps exclusions", () => {
		// given
		const config: SearchProviderConfig = { provider: "kimi", apiKey: "kimi-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["docs.example.com", "api.example.com"],
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.body).toEqual({
			text_query: "current docs (site:docs.example.com OR site:api.example.com) -site:ads.example.com",
			limit: 5,
			enable_page_crawling: false,
			timeout_seconds: 30,
		});
	});

	it("#given an allowed parent and a blocked subdomain for Brave #when building request #then keeps the exclusion in the query", () => {
		// given
		const config: SearchProviderConfig = { provider: "brave", apiKey: "brave-test" };

		// when
		const request = buildSearchRequest(config, {
			query: "current docs",
			maxResults: 5,
			allowedDomains: ["example.com"],
			blockedDomains: ["ads.example.com"],
		});

		// then
		expect(request.url).toContain("site%3Aexample.com");
		expect(request.url).toContain("-site%3Aads.example.com");
		expect(request.url).not.toContain("invalid.invalid");
	});
});
