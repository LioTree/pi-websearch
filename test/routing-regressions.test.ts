import { afterEach, describe, expect, it, vi } from "vitest";

import { type NativeModelInfo, resolveNativeRoute } from "../src/websearch/native.js";
import { SEARCH_INSTRUCTIONS } from "../src/websearch/providers/shared.js";
import { buildSearchRequest, normalizeSearchResponse } from "../src/websearch/providers.js";
import { performProviderSearch, performSearch } from "../src/websearch/search.js";
import type { SearchProviderEntry, WebsearchConfig } from "../src/websearch/types.js";

function jsonResponse(payload: object, status = 200): Response {
	return new Response(JSON.stringify(payload), { status });
}

function activeModel(provider = "openai"): NativeModelInfo {
	return { provider, id: "model-alias", api: "openai-responses", baseUrl: "https://gateway.example/v1" };
}

const nativeEntry: SearchProviderEntry = {
	provider: "openai",
	id: "native",
	model: "model-alias",
	apiKey: "test-provider-credential",
	baseUrl: "https://gateway.example/v1/responses",
};

const request = { query: "search documentation", maxResults: 5 };

describe("routing integration regressions", () => {
	it("#given Anthropic OAuth in an API key or auth header #when building search #then includes required CLI identity", () => {
		// given
		const configs: SearchProviderEntry[] = [
			{ provider: "anthropic", apiKey: "sk-ant-oat-test-credential" },
			{ provider: "anthropic", headers: { Authorization: "Bearer sk-ant-oat-test-credential" } },
		];
		for (const config of configs) {
			// when
			const built = buildSearchRequest(config, request);
			// then
			expect(built.init.headers).toHaveProperty("x-app", "cli");
			expect(built.body?.["system"]).toEqual([
				{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
				{ type: "text", text: SEARCH_INSTRUCTIONS },
			]);
		}
	});

	it("#given an Anthropic result with page age #when normalizing #then does not substitute the date for source content", () => {
		// given
		const payload = {
			content: [
				{ type: "text", text: "Search result summary" },
				{
					type: "web_search_tool_result",
					content: [
						{ type: "web_search_result", title: "Docs", url: "https://docs.example/", page_age: "2026-01-01" },
					],
				},
			],
		};
		// when
		const results = normalizeSearchResponse("anthropic", payload);
		// then
		expect(results[0]?.snippet).toBeUndefined();
		expect(results[0]?.publishedAt).toBe("2026-01-01");
	});

	it("#given citations in multiple output blocks and uncited search sources #when normalizing #then preserves every structured source", () => {
		// given
		const citation = (title: string, url: string) => ({ type: "url_citation", title, url });
		const payload = {
			output: [
				{
					type: "message",
					content: [
						{ type: "output_text", text: "Introduction" },
						{
							type: "output_text",
							text: "First answer",
							annotations: [citation("First", "https://first.example/")],
						},
					],
				},
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "Second answer",
							annotations: [citation("Second", "https://second.example/")],
						},
					],
				},
				{
					type: "web_search_call",
					action: { sources: [{ url: "https://first.example/" }, { url: "https://extra.example/" }] },
				},
			],
		};
		// when
		const results = normalizeSearchResponse("openai", payload);
		// then
		expect(results.map((result) => result.url)).toEqual([
			"https://first.example/",
			"https://second.example/",
			"https://extra.example/",
		]);
		expect(results[0]?.title).toBe("First");
	});

	it("#given more xAI domains than the API accepts #when searching #then falls back without silently omitting domains", async () => {
		// given
		const fetchMock = vi.fn(async (_input: string | URL | Request) =>
			jsonResponse({ results: [{ title: "Sixth domain", url: "https://six.example/" }] }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const config: WebsearchConfig = {
			auto: true,
			strategy: "priority",
			fallback: true,
			providers: [{ provider: "exa" }],
		};
		// when
		const result = await performSearch(
			config,
			{
				...request,
				allowedDomains: [
					"one.example",
					"two.example",
					"three.example",
					"four.example",
					"five.example",
					"six.example",
				],
			},
			undefined,
			undefined,
			undefined,
			{
				nativeEntry: { ...nativeEntry, provider: "xai" },
			},
		);
		// then
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.exa.ai/search");
		expect(result.results[0]?.url).toBe("https://six.example/");
		expect(result.attempts?.[0]?.failureKind).toBe("request");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it.each([
		"Invalid web_search filters: allowed_domains must contain at most 100 domains",
		"Invalid web_search argument: search_context_size must be low, medium or high",
	])(
		"#given a supported search tool with invalid arguments #when receiving %s #then does not cache capability failure",
		async (message) => {
			// given
			vi.stubGlobal("fetch", async () => jsonResponse({ error: { message } }, 400));
			// when
			const details = await performProviderSearch(nativeEntry, request);
			// then
			expect(details.failureKind).toBe("request");
		},
	);

	it.each([
		"web_search is not supported with this model",
		"Unsupported tool type: web_search",
		"Unknown tool: web_search",
	])(
		"#given an explicitly unsupported search tool #when receiving %s #then classifies a capability failure",
		async (message) => {
			// given
			vi.stubGlobal("fetch", async () => jsonResponse({ error: { message } }, 400));
			// when
			const details = await performProviderSearch(nativeEntry, request);
			// then
			expect(details.failureKind).toBe("unsupported");
		},
	);

	it("#given an exhausted paid account #when receiving HTTP 402 #then reports quota failure", async () => {
		// given
		vi.stubGlobal("fetch", async () => jsonResponse({ error: "Payment required" }, 402));
		// when
		const details = await performProviderSearch(nativeEntry, request);
		// then
		expect(details.failureKind).toBe("quota");
	});

	it("#given a credential in an endpoint key parameter #when upstream echoes it outside a URL #then redacts it", async () => {
		// given
		const secret = "endpoint-only-private-value";
		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				results: [{ title: `Echo ${secret}`, url: "https://docs.example/?key=configuration", text: secret }],
			}),
		);
		// when
		const details = await performProviderSearch(
			{
				provider: "exa",
				apiKey: "separate-exa-credential",
				baseUrl: `https://gateway.example/search?key=${secret}`,
			},
			request,
		);
		// then
		expect(JSON.stringify(details)).not.toContain(secret);
		expect(details.results[0]?.url).toBe("https://docs.example/?key=configuration");
	});

	it.each([
		{ provider: "perplexity", model: "sonar", endpoint: "https://api.perplexity.ai/chat/completions" },
		{ provider: "z-ai", model: "glm-alias", endpoint: "https://api.z.ai/api/paas/v4/chat/completions" },
	] as const)(
		"#given a model-backed $provider entry #when no endpoint is overridden #then uses the chat endpoint",
		({ provider, model, endpoint }) => {
			// when
			const built = buildSearchRequest({ provider, model, apiKey: "provider-test-key" }, request);
			// then
			expect(built.url).toBe(endpoint);
		},
	);

	it("#given a renamed Codex subscription provider #when opting into Codex #then uses the separate subscription adapter", async () => {
		// given
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "subscription-token" }));
		// when
		const result = await resolveNativeRoute(
			activeModel("my-codex"),
			{ getApiKeyAndHeaders },
			{
				"my-codex": { adapter: "codex" },
			},
		);
		// then
		expect(result.entry?.provider).toBe("openai-codex");
		expect(result.status.adapter).toBe("codex");
		expect(getApiKeyAndHeaders).toHaveBeenCalledOnce();
	});

	it("#given OpenAI credentials resolved to ChatGPT #when resolving native search #then does not call the ordinary Responses adapter", async () => {
		// when
		const result = await resolveNativeRoute(activeModel(), {
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "subscription-token", baseUrl: "https://chatgpt.com/backend-api" };
			},
		});
		// then
		expect(result.entry).toMatchObject({
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex/responses",
		});
		expect(result.status.adapter).toBe("codex");
	});

	it("#given a provider name inherited from Object.prototype #when no override exists #then skips without reading auth", async () => {
		// given
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "provider-test-key" }));
		// when
		const result = await resolveNativeRoute(activeModel("constructor"), { getApiKeyAndHeaders });
		// then
		expect(result.entry).toBeUndefined();
		expect(result.status.reason).toContain("unsupported provider");
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("#given different account credentials on the same native endpoint #when resolving cache keys #then isolates capability state", async () => {
		// given
		const resolveFor = (apiKey: string) =>
			resolveNativeRoute(activeModel(), {
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey };
				},
			});
		// when
		const first = await resolveFor("account-a-credential");
		const second = await resolveFor("account-b-credential");
		// then
		expect(first.key).not.toBe(second.key);
		expect(first.key).not.toContain("account-a");
		expect(second.key).not.toContain("account-b");
	});

	it("#given native auth spent time before transport #when returning search results #then includes that time in duration", async () => {
		// given
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		vi.stubGlobal("fetch", async () => jsonResponse({ results: [{ title: "Docs", url: "https://docs.example/" }] }));
		const config: WebsearchConfig = {
			auto: false,
			strategy: "priority",
			fallback: true,
			providers: [{ provider: "exa" }],
		};
		// when
		const result = await performSearch(config, request, undefined, undefined, undefined, { startedAt: 0 });
		// then
		expect(result.durationMs).toBe(1_000);
	});
});
