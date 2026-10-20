import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadWebsearchConfig, validateProviderConfig, validateWebsearchConfig } from "../src/websearch/config.js";
import { type NativeModelInfo, resolveNativeAdapter, resolveNativeRoute } from "../src/websearch/native.js";
import { nativeSearchEndpoint } from "../src/websearch/provider-endpoints.js";
import { buildSearchRequest, isDirectSearchProvider, normalizeSearchResponse } from "../src/websearch/providers.js";
import { performSearch } from "../src/websearch/search.js";
import type { SearchProviderEntry, WebsearchConfig } from "../src/websearch/types.js";

const searchEntry: SearchProviderEntry = { provider: "deepseek", apiKey: "deepseek-test-credential" };
const request = { query: "DeepSeek search", maxResults: 8 };
const activeModel: NativeModelInfo = {
	provider: "deepseek",
	id: "arbitrary-model-alias",
	api: "openai-completions",
	baseUrl: "https://api.deepseek.com",
};
const source = {
	title: "DeepSeek API Docs",
	url: "https://api-docs.deepseek.com/guides/search/",
	snippet: "Short display snippet",
	summary: "Longer summary intended for models",
	content: "",
	site_name: "DeepSeek",
	date: "2026-10-19T00:00:00Z",
	rerank_score: 2.4,
	authority: 3,
};

function config(overrides: Partial<WebsearchConfig> = {}): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: false,
		auto: true,
		providers: [{ provider: "exa", apiKey: "fallback-test-credential" }],
		...overrides,
	};
}

function authRegistry() {
	return {
		getApiKeyAndHeaders: vi.fn(async () => ({
			ok: true as const,
			headers: { Authorization: "Bearer inherited-deepseek-token", "cf-aig-authorization": "Bearer gateway-token" },
			baseUrl: "https://gateway.example/deepseek/anthropic",
		})),
	};
}

function jsonResponse(payload: object, status = 200): Response {
	return new Response(JSON.stringify(payload), { status });
}

describe("DeepSeek Search API", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("#given DeepSeek search configuration #when validating #then requires documented bearer credentials and permits raw mode", () => {
		expect(validateProviderConfig(searchEntry).ok).toBe(true);
		expect(validateProviderConfig({ provider: "deepseek" }).ok).toBe(false);
		expect(validateProviderConfig({ provider: "deepseek", headers: { "x-api-key": "wrong-auth" } }).ok).toBe(false);
		expect(
			validateProviderConfig({ provider: "deepseek", headers: { Authorization: "Bearer header-token" } }).ok,
		).toBe(true);
		expect(validateWebsearchConfig(config({ rawMode: true, providers: [searchEntry] })).ok).toBe(true);
		expect(isDirectSearchProvider({ provider: "deepseek", model: "ignored-chat-model" })).toBe(true);
	});

	it("#given a JSON config with DeepSeek and a gateway override #when loading #then accepts both provider and adapter declarations", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-websearch-deepseek-"));
		try {
			await mkdir(join(cwd, ".pi"));
			await writeFile(
				join(cwd, ".pi", "websearch.json"),
				JSON.stringify({
					rawMode: true,
					providers: [searchEntry],
					nativeOverrides: { gateway: { adapter: "deepseek", endpoint: "https://gateway.example/search" } },
				}),
			);
			const loaded = await loadWebsearchConfig({ cwd, homeDir: cwd });
			expect(loaded).toMatchObject({
				ok: true,
				config: {
					providers: [searchEntry],
					nativeOverrides: { gateway: { adapter: "deepseek", endpoint: "https://gateway.example/search" } },
				},
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it.each([
		["https://api.deepseek.com", "https://api.deepseek.com/v1/tools/search"],
		["https://api.deepseek.com/v1/", "https://api.deepseek.com/v1/tools/search"],
		["https://api.deepseek.com/anthropic", "https://api.deepseek.com/v1/tools/search"],
		["https://api.deepseek.com/anthropic/v1", "https://api.deepseek.com/v1/tools/search"],
		["https://api.deepseek.com/beta", "https://api.deepseek.com/v1/tools/search"],
		[
			"https://gateway.example/deepseek/v1?route=search",
			"https://gateway.example/deepseek/v1/tools/search?route=search",
		],
		["https://gateway.example/deepseek/anthropic", "https://gateway.example/deepseek/v1/tools/search"],
		["https://gateway.example/deepseek/v1/tools/search", "https://gateway.example/deepseek/v1/tools/search"],
	])("#given base URL %s #when resolving the DeepSeek endpoint #then uses %s", (baseUrl, endpoint) => {
		expect(nativeSearchEndpoint("deepseek", baseUrl)).toBe(endpoint);
	});

	it.each(["openai-completions", "openai-responses", "anthropic-messages"])(
		"#given DeepSeek using %s #when inspecting native support #then resolves its independent Search API without a model prefix gate",
		(api) => {
			expect(resolveNativeAdapter({ ...activeModel, api })).toMatchObject({
				adapter: "deepseek",
				endpoint: "https://api.deepseek.com/v1/tools/search",
				status: { status: "ready", model: "arbitrary-model-alias" },
			});
		},
	);

	it("#given inherited header-only credentials and a resolved gateway URL #when resolving native search #then keeps auth paired with that URL", async () => {
		const registry = authRegistry();
		const resolved = await resolveNativeRoute(activeModel, registry);
		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledExactlyOnceWith(activeModel);
		expect(resolved.entry).toMatchObject({
			provider: "deepseek",
			baseUrl: "https://gateway.example/deepseek/v1/tools/search",
		});
		if (!resolved.entry) throw new Error("Native route was not resolved");
		const built = buildSearchRequest(resolved.entry, request);
		expect(built.init.headers).toMatchObject({
			Authorization: "Bearer inherited-deepseek-token",
			"cf-aig-authorization": "Bearer gateway-token",
		});
		expect(built.body).not.toHaveProperty("model");
	});

	it("#given an unknown gateway with a DeepSeek override #when resolving #then uses only its own credentials and complete endpoint", async () => {
		const registry = authRegistry();
		const resolved = await resolveNativeRoute({ ...activeModel, provider: "custom-deepseek" }, registry, {
			"custom-deepseek": { adapter: "deepseek", endpoint: "https://gateway.example/custom-search" },
		});
		expect(resolved.entry).toMatchObject({ provider: "deepseek", baseUrl: "https://gateway.example/custom-search" });
		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledOnce();
	});

	it("#given a disabled DeepSeek native route #when resolving #then does not resolve credentials", async () => {
		const registry = authRegistry();
		const resolved = await resolveNativeRoute(activeModel, registry, { deepseek: false });
		expect(resolved.status.status).toBe("skipped");
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("#given a DeepSeek query #when building the request #then uses the documented endpoint and fields without asking for page content", () => {
		const built = buildSearchRequest(searchEntry, request);
		expect(built.url).toBe("https://api.deepseek.com/v1/tools/search");
		expect(built.init).toMatchObject({
			method: "POST",
			headers: { Authorization: "Bearer deepseek-test-credential" },
		});
		expect(built.body).toEqual({ query: "DeepSeek search", count: 8, need_content: false });
	});

	it("#given a result limit above the API bound and a custom endpoint #when building #then caps count at fifty and preserves the explicit URL", () => {
		const built = buildSearchRequest(
			{ ...searchEntry, maxResults: 999, baseUrl: "https://gateway.example/custom-search" },
			request,
		);
		expect(built.url).toBe("https://gateway.example/custom-search");
		expect(built.body?.["count"]).toBe(50);
	});

	it("#given domain constraints #when building #then preserves OR alternatives and blocked exclusions in query syntax", () => {
		const built = buildSearchRequest(
			{ ...searchEntry, blockedDomains: ["ads.example.com"] },
			{
				...request,
				allowedDomains: ["example.com", "docs.test"],
			},
		);
		expect(built.body?.["query"]).toBe("DeepSeek search (site:example.com OR site:docs.test) -site:ads.example.com");
	});

	it("#given 128 astral Unicode characters #when building #then counts characters rather than UTF-16 code units", () => {
		expect(buildSearchRequest(searchEntry, { ...request, query: "𝄞".repeat(128) }).body?.["query"]).toBe(
			"𝄞".repeat(128),
		);
	});

	it.each(["", "   ", "a".repeat(129), "𝄞".repeat(129)])(
		"#given an invalid query %s #when building #then rejects rather than truncating it",
		(query) =>
			expect(() => buildSearchRequest(searchEntry, { ...request, query })).toThrow("1 to 128 Unicode characters"),
	);

	it("#given domain operators pushing the query above 128 characters #when building #then rejects the entire query before sending", () => {
		expect(() =>
			buildSearchRequest(searchEntry, { ...request, query: "a".repeat(120), allowedDomains: ["example.com"] }),
		).toThrow("including domain filters");
	});

	it("#given documented structured results #when normalizing #then preserves summaries, ranking, site and publication date", () => {
		expect(normalizeSearchResponse("deepseek", { results: [source] })).toEqual([
			{
				title: source.title,
				url: source.url,
				snippet: source.summary,
				score: 2.4,
				source: "DeepSeek",
				publishedAt: source.date,
			},
		]);
	});

	it("#given no long summary or optional metadata #when normalizing #then falls back to the short snippet without inventing fields", () => {
		expect(
			normalizeSearchResponse("deepseek", {
				results: [
					{
						title: "Docs",
						url: "https://docs.example/",
						summary: "",
						snippet: "Short",
						site_name: null,
						date: null,
					},
				],
			}),
		).toEqual([{ title: "Docs", url: "https://docs.example/", snippet: "Short" }]);
		expect(normalizeSearchResponse("deepseek", { results: [] })).toEqual([]);
		expect(normalizeSearchResponse("deepseek", { answer: "See https://unverified.example" })).toEqual([]);
	});

	it("#given an active DeepSeek model #when native search succeeds #then does not call the configured fallback", async () => {
		const native = await resolveNativeRoute(activeModel, authRegistry());
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			jsonResponse({ results: [source] }),
		);
		vi.stubGlobal("fetch", fetch);
		const details = await performSearch(config(), request, undefined, undefined, undefined, {
			...(native.entry ? { nativeEntry: native.entry } : {}),
			nativeStatus: native.status,
		});
		expect(details).toMatchObject({ provider: "deepseek", stage: "native", results: [{ url: source.url }] });
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]?.[0]).toBe("https://gateway.example/deepseek/v1/tools/search");
	});

	it.each([401, 402, 429, 503])(
		"#given native HTTP %s #when searching #then uses configured fallback even with fallback false",
		async (status) => {
			const native = await resolveNativeRoute(activeModel, authRegistry());
			const urls: string[] = [];
			vi.stubGlobal("fetch", async (input: string | URL | Request) => {
				const url = String(input);
				urls.push(url);
				return url.includes("gateway.example")
					? jsonResponse({ error: { message: "Search failed" } }, status)
					: jsonResponse({ results: [{ title: "Fallback", url: "https://fallback.example/" }] });
			});
			const details = await performSearch(config(), request, undefined, undefined, undefined, {
				...(native.entry ? { nativeEntry: native.entry } : {}),
				nativeStatus: native.status,
			});
			expect(urls).toEqual(["https://gateway.example/deepseek/v1/tools/search", "https://api.exa.ai/search"]);
			expect(details).toMatchObject({ provider: "exa", stage: "fallback" });
			expect(details.attempts?.[0]).toMatchObject({ provider: "deepseek", stage: "native", httpStatus: status });
		},
	);

	it.each([
		{ results: [] },
		{ answer: "See https://unverified.example/" },
		{ results: [{ title: "Invalid source", url: "javascript:alert(1)" }] },
	])(
		"#given an unusable DeepSeek response %j #when searching #then falls back rather than claiming search succeeded",
		async (payload) => {
			const native = await resolveNativeRoute(activeModel, authRegistry());
			const urls: string[] = [];
			vi.stubGlobal("fetch", async (input: string | URL | Request) => {
				const url = String(input);
				urls.push(url);
				return url.includes("gateway.example")
					? jsonResponse(payload)
					: jsonResponse({ results: [{ title: "Fallback", url: "https://fallback.example/" }] });
			});
			const details = await performSearch(config(), request, undefined, undefined, undefined, {
				...(native.entry ? { nativeEntry: native.entry } : {}),
				nativeStatus: native.status,
			});
			expect(urls).toEqual(["https://gateway.example/deepseek/v1/tools/search", "https://api.exa.ai/search"]);
			expect(details).toMatchObject({
				provider: "exa",
				stage: "fallback",
				results: [{ url: "https://fallback.example/" }],
			});
		},
	);

	it("#given an overlong native query #when searching #then does not send it to DeepSeek and preserves the full query for fallback", async () => {
		const native = await resolveNativeRoute(activeModel, authRegistry());
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			jsonResponse({ results: [{ title: "Fallback", url: "https://fallback.example/" }] }),
		);
		vi.stubGlobal("fetch", fetch);
		const details = await performSearch(
			config(),
			{ ...request, query: "a".repeat(129) },
			undefined,
			undefined,
			undefined,
			{
				...(native.entry ? { nativeEntry: native.entry } : {}),
				nativeStatus: native.status,
			},
		);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]?.[0]).toBe("https://api.exa.ai/search");
		expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain("a".repeat(129));
		expect(details.attempts?.[0]).toMatchObject({ provider: "deepseek", failureKind: "request" });
	});

	it("#given a direct DeepSeek entry with domain restrictions #when the service ignores operators #then the shared postfilter still excludes forbidden sources", async () => {
		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				results: [
					{ title: "Allowed", url: "https://docs.example.com/" },
					{ title: "Blocked", url: "https://ads.example.com/" },
					{ title: "Lookalike", url: "https://notexample.com/" },
				],
			}),
		);
		const details = await performSearch(
			config({
				providers: [{ ...searchEntry, blockedDomains: ["ads.example.com"] }],
				allowedDomains: ["example.com"],
			}),
			request,
		);
		expect(details.results.map((item) => item.url)).toEqual(["https://docs.example.com/"]);
	});
});
