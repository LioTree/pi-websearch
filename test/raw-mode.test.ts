import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWebsearchConfig } from "../src/websearch/config.js";
import { createWebSearchTool } from "../src/websearch/tool.js";
import type { SearchDetails, WebsearchConfig } from "../src/websearch/types.js";

function config(rawMode?: boolean): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: true,
		...(rawMode === undefined ? {} : { rawMode }),
		providers: [
			{ provider: "xai", apiKey: "test", priority: -2 },
			{ provider: "brave", apiKey: "test", maxResults: 3 },
		],
	};
}

function toolFor(rawMode?: boolean, overrides: Partial<WebsearchConfig> = {}) {
	return createWebSearchTool(() => ({ ok: true, source: "test", config: { ...config(rawMode), ...overrides } }));
}

function context() {
	const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "test" }));
	return {
		model: { provider: "xai", id: "grok-4", baseUrl: "https://api.x.ai/v1" },
		modelRegistry: { getApiKeyAndHeaders, getAvailable: () => [] },
	};
}

function mockSearch() {
	return vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const payload = String(input).includes("brave")
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
		expect(tool.promptGuidelines?.join(" ")).toContain('mode: "raw"');
	});

	it("#given raw override #when searching #then skips native discovery and explicit answer providers", async () => {
		mockSearch();
		const ctx = context();
		const result = await toolFor(true).execute(
			"raw",
			{ query: "test query", mode: "raw", allowed_domains: ["example.com"] },
			undefined,
			undefined,
			ctx as never,
		);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(1);
		const request = vi.mocked(fetch).mock.calls[0];
		expect(String(request?.[0])).toContain("brave");
		expect(String(request?.[0])).toContain("example.com");
		expect((result.details as SearchDetails).results[0]?.snippet).toBe("Engine snippet");
		expect(JSON.stringify(result.content)).not.toContain("retry with");
	});

	it("#given no mode #when searching #then retains native routing and adds retry hint only when enabled", async () => {
		mockSearch();
		for (const enabled of [false, true]) {
			const ctx = context();
			const result = await toolFor(enabled).execute(
				"default",
				{ query: "test query" },
				undefined,
				undefined,
				ctx as never,
			);
			expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalled();
			expect((result.details as SearchDetails).provider).toBe("xai");
			expect(JSON.stringify(result.content).includes("retry with")).toBe(enabled);
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
	});

	it("#given only answer providers #when raw requested #then returns actionable error without fetching", async () => {
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
					{ provider, model: "answer-model", apiKey: "test" },
					{ provider, apiKey: "test" },
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
