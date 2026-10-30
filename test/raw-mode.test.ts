import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveNativeRouteMock = vi.hoisted(() => vi.fn());

vi.mock("../src/websearch/native.js", () => ({
	resolveNativeRoute: resolveNativeRouteMock,
}));

import { loadWebsearchConfig } from "../src/websearch/config.js";
import { formatSearchText } from "../src/websearch/search.js";
import { createWebSearchTool } from "../src/websearch/tool.js";
import type { SearchDetails, WebsearchConfig } from "../src/websearch/types.js";

function config(rawMode?: boolean): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: true,
		...(rawMode === undefined ? {} : { rawMode }),
		providers: [
			{
				id: "hosted",
				provider: "xai",
				apiKey: "test",
				priority: -2,
				baseUrl: "https://hosted.example/v1/responses",
			},
			{ id: "direct", provider: "brave", apiKey: "test", maxResults: 3, baseUrl: "https://brave.example" },
		],
	};
}

function toolFor(rawMode?: boolean, overrides: Partial<WebsearchConfig> = {}) {
	return createWebSearchTool(() => ({ ok: true, source: "test", config: { ...config(rawMode), ...overrides } }));
}

function context() {
	const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "test" }));
	return {
		model: { provider: "xai", id: "grok-4", api: "openai-responses", baseUrl: "https://api.x.ai/v1" },
		modelRegistry: { getApiKeyAndHeaders, getAvailable: () => [] },
	};
}

function nativeResolution() {
	return {
		entry: {
			id: "native",
			provider: "xai",
			apiKey: "test",
			baseUrl: "https://hosted.example/v1/responses",
			model: "grok-4",
		},
		status: { status: "ready", provider: "xai", model: "grok-4", adapter: "xai" },
		key: "xai|https://hosted.example/v1/responses",
	};
}

function mockSearch() {
	return vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			const payload = url.includes("brave")
				? {
						web: {
							results: [{ title: "Direct result", url: "https://example.com", description: "Engine snippet" }],
						},
					}
				: { output: [{ type: "web_search_call", action: { sources: [{ url: "https://example.com" }] } }] };
			return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
		}),
	);
}

describe("opt-in raw search mode", () => {
	beforeEach(() => {
		resolveNativeRouteMock.mockReset();
		resolveNativeRouteMock.mockResolvedValue(nativeResolution());
	});

	afterEach(() => vi.unstubAllGlobals());

	it.each([undefined, false])(
		"#given rawMode=%s #when defining tool #then preserves original schema and guidelines",
		(enabled) => {
			const tool = toolFor(enabled);
			expect(tool.parameters.properties).not.toHaveProperty("mode");
			expect(tool.promptGuidelines).toEqual([
				"After using web_search, cite relevant returned URLs in the final answer.",
			]);
		},
	);

	it("#given raw mode enabled #when defining tool #then exposes only optional raw override", () => {
		const tool = toolFor(true);
		expect(tool.parameters.properties).toHaveProperty("mode");
		expect(tool.parameters.required).toEqual(["query"]);
		expect(tool.parameters.additionalProperties).toBe(false);
		const guideline = tool.promptGuidelines?.[1];
		if (!("mode" in tool.parameters.properties)) throw new Error("Expected raw mode parameter");
		expect(tool.parameters.properties.mode.description).toBe(guideline);
		expect(guideline).toBeTruthy();
	});

	it("#given raw override #when searching #then skips native resolution and explicit hosted providers", async () => {
		mockSearch();
		const ctx = context();
		const result = await toolFor(true).execute(
			"raw",
			{ query: "test query", mode: "raw", allowed_domains: ["example.com"] },
			undefined,
			undefined,
			ctx as never,
		);
		expect(resolveNativeRouteMock).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(1);
		const request = vi.mocked(fetch).mock.calls[0];
		expect(String(request?.[0])).toContain("brave");
		expect(String(request?.[0])).toContain("example.com");
		const details = result.details as SearchDetails;
		expect(details.mode).toBe("raw");
		expect(details.stage).toBe("fallback");
		expect(details.results[0]?.snippet).toBe("Engine snippet");
		expect(result.content).toEqual([{ type: "text", text: formatSearchText(details) }]);
	});

	it("#given no mode #when searching #then retains native-first routing and adds the retry hint only when enabled", async () => {
		mockSearch();
		for (const enabled of [false, true]) {
			resolveNativeRouteMock.mockClear();
			const ctx = context();
			const result = await toolFor(enabled).execute(
				"default",
				{ query: "test query" },
				undefined,
				undefined,
				ctx as never,
			);
			expect(resolveNativeRouteMock).toHaveBeenCalled();
			expect((result.details as SearchDetails).provider).toBe("xai");
			expect((result.details as SearchDetails).stage).toBe("native");
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			const resultsText = formatSearchText(result.details as SearchDetails);
			expect(text.startsWith(resultsText)).toBe(true);
			expect(text.length > resultsText.length).toBe(enabled);
		}
	});

	it("#given raw disabled #when raw requested programmatically #then refuses without fetching", async () => {
		mockSearch();
		const result = await toolFor(false).execute(
			"disabled",
			{ query: "test query", mode: "raw" },
			undefined,
			undefined,
			context() as never,
		);
		expect(JSON.stringify(result.content)).toContain("disabled");
		expect(fetch).not.toHaveBeenCalled();
		expect(resolveNativeRouteMock).not.toHaveBeenCalled();
	});

	it("#given only hosted providers #when raw requested #then returns actionable error without fetching", async () => {
		mockSearch();
		const result = await toolFor(true, { providers: [{ provider: "xai", apiKey: "test" }] }).execute(
			"none",
			{ query: "test query", mode: "raw" },
			undefined,
			undefined,
			context() as never,
		);
		expect(JSON.stringify(result.content)).toContain("No direct search-engine providers");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("#given direct provider fails #when raw requested #then never falls back to an answer provider", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unavailable", { status: 503 })),
		);
		const result = await toolFor(true).execute(
			"failed",
			{ query: "test query", mode: "raw" },
			undefined,
			undefined,
			context() as never,
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect((result.details as SearchDetails).error).toBeDefined();
		expect((result.details as SearchDetails).native?.reason).toContain("raw mode");
	});

	it.each(["perplexity", "z-ai"] as const)(
		"#given %s direct and model entries #when raw requested #then keeps only the direct API",
		async (provider) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(
							JSON.stringify(
								provider === "perplexity"
									? { results: [{ title: "Direct", url: "https://example.com", snippet: "snippet" }] }
									: { search_result: [{ title: "Direct", link: "https://example.com", content: "snippet" }] },
							),
						),
				),
			);
			const tool = toolFor(true, {
				providers: [
					{ provider, model: "answer-model", apiKey: "test", id: "answer" },
					{ provider, apiKey: "test", id: "direct" },
				],
			});
			const result = await tool.execute(
				"dual",
				{ query: "test query", mode: "raw" },
				undefined,
				undefined,
				context() as never,
			);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(vi.mocked(fetch).mock.calls[0]?.[1]?.body).not.toContain('"model"');
			expect((result.details as SearchDetails).entryId).toBe("direct");
			expect((result.details as SearchDetails).results).toHaveLength(1);
		},
	);

	it("#given raw call with conflicting domains #when searching #then preserves validation", async () => {
		mockSearch();
		const result = await toolFor(true).execute(
			"domains",
			{ query: "test query", mode: "raw", allowed_domains: ["a.com"], blocked_domains: ["b.com"] },
			undefined,
			undefined,
			context() as never,
		);
		expect(JSON.stringify(result.content)).toContain("Cannot specify both");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("rawMode configuration", () => {
	it.each([true, false, undefined, "true"])(
		"#given rawMode=%s #when loading config #then validates opt-in",
		async (rawMode) => {
			const root = await mkdtemp(join(tmpdir(), "websearch-raw-"));
			try {
				await mkdir(join(root, ".pi"));
				await writeFile(
					join(root, ".pi", "websearch.json"),
					JSON.stringify({ provider: "duckduckgo-html", ...(rawMode === undefined ? {} : { rawMode }) }),
				);
				const loaded = await loadWebsearchConfig({ cwd: root, homeDir: root });
				expect(loaded.ok).toBe(typeof rawMode !== "string");
				if (loaded.ok) expect(loaded.config.rawMode).toBe(rawMode);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
