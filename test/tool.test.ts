import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveNativeRouteMock = vi.hoisted(() => vi.fn());

vi.mock("../src/websearch/native.js", () => ({
	resolveNativeRoute: resolveNativeRouteMock,
}));

import { SEARCH_TOTAL_BUDGET_MS } from "../src/websearch/search.js";
import { createWebSearchTool, web_search } from "../src/websearch/tool.js";
import type {
	SearchDetails,
	SearchErrorDetails,
	SearchProgressDetails,
	SearchProviderEntry,
	WebsearchConfig,
} from "../src/websearch/types.js";

function jsonResponse(payload: object, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function exaResults(...urls: string[]) {
	return { results: urls.map((url, index) => ({ title: `Result ${index}`, url, text: `snippet ${index}` })) };
}

function nativePayload(...urls: string[]) {
	return {
		output: [
			{
				type: "web_search_call",
				action: { sources: urls.map((url) => ({ url })) },
			},
		],
	};
}

function baseConfig(overrides: Partial<WebsearchConfig> = {}): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: true,
		providers: [{ id: "manual", provider: "exa", apiKey: "exa-test", baseUrl: "https://exa.example.com" }],
		...overrides,
	};
}

function nativeResolution(overrides: Record<string, unknown> = {}) {
	return {
		entry: {
			id: "native",
			provider: "openai",
			apiKey: "native-test",
			baseUrl: "https://native.example.com/v1/responses",
			model: "gpt-5.5",
		},
		status: { status: "ready", provider: "openai", model: "gpt-5.5", adapter: "openai" },
		key: "openai|https://native.example.com/v1/responses",
		...overrides,
	};
}

function context(
	model: { provider: string; id: string; api: string; baseUrl: string; headers?: Record<string, string> } = {
		provider: "openai",
		id: "gpt-5.5",
		api: "openai-responses",
		baseUrl: "https://native.example.com/v1",
		headers: { "X-Model": "yes" },
	},
) {
	const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "resolved-test" }));
	return {
		model,
		modelRegistry: {
			getApiKeyAndHeaders,
			getAvailable: () => [],
		},
	};
}

type ToolUpdate = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
};
type ExecuteParams = { query: string; mode?: "raw"; allowed_domains?: string[]; blocked_domains?: string[] };

function execute(
	tool: ReturnType<typeof createWebSearchTool>,
	params: ExecuteParams,
	ctx: ReturnType<typeof context>,
	signal?: AbortSignal,
	updates?: ToolUpdate[],
) {
	return (
		tool as unknown as {
			execute(
				toolCallId: string,
				params: ExecuteParams,
				signal: AbortSignal | undefined,
				onUpdate: ((update: ToolUpdate) => void) | undefined,
				ctx: unknown,
			): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
		}
	).execute("tool-call", params, signal, updates ? (update) => updates.push(update) : undefined, ctx);
}

describe("web_search tool definition", () => {
	beforeEach(() => {
		resolveNativeRouteMock.mockReset();
		resolveNativeRouteMock.mockResolvedValue(nativeResolution());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("#given web search tool #when inspecting metadata #then exposes expected name and label", () => {
		// given / when / then
		expect(web_search.name).toBe("web_search");
		expect(web_search.label).toBe("Web Search");
		expect(web_search.description).toContain("Search the web");
	});

	it("#given web search parameters #when inspecting schema #then matches the fixed free-code shape", () => {
		// given
		const parameters = web_search.parameters;

		// when / then
		expect(parameters.required).toEqual(["query"]);
		expect(parameters.properties).toHaveProperty("query");
		expect(parameters.properties).toHaveProperty("allowed_domains");
		expect(parameters.properties).toHaveProperty("blocked_domains");
		expect(parameters.properties).not.toHaveProperty("mode");
		expect(parameters.additionalProperties).toBe(false);
	});

	it("#given auto enabled and a ready native route #when executing #then tries native before the configured chain", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			urls.push(String(input));
			return jsonResponse(nativePayload("https://native.example/result"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		const result = await execute(tool, { query: "native route" }, context());

		// then
		const details = result.details as SearchDetails;
		expect(urls).toEqual(["https://native.example.com/v1/responses"]);
		expect(details.stage).toBe("native");
		expect(details.native?.status).toBe("ready");
		expect(details.entryId).toBe("native");
	});

	it("#given a ready native route #when it fails and fallback is false #then the configured chain still runs", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.includes("native")) return jsonResponse({ error: "down" }, 503);
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		const tool = createWebSearchTool(() => ({
			ok: true,
			config: baseConfig({ fallback: false }),
			source: "test",
		}));

		// when
		const result = await execute(tool, { query: "native failure" }, context());

		// then
		const details = result.details as SearchDetails;
		expect(urls).toEqual(["https://native.example.com/v1/responses", "https://exa.example.com"]);
		expect(details.stage).toBe("fallback");
		expect(details.native?.status).toBe("skipped");
		expect(details.attempts?.map((attempt) => attempt.stage)).toEqual(["native", "fallback"]);
	});

	it("#given conflicting global and request domains #when executing #then returns no-results before native resolution or fetch", async () => {
		// given
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({
			ok: true,
			config: baseConfig({ allowedDomains: ["a.example.com"] }),
			source: "test",
		}));

		// when
		const result = await execute(tool, { query: "domain conflict", allowed_domains: ["b.example.com"] }, context());

		// then
		const details = result.details as SearchDetails;
		expect(details.failureKind).toBe("no-results");
		expect(details.error).toContain("excludes every source");
		expect(details.native?.status).toBe("skipped");
		expect(resolveNativeRouteMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("#given auto false #when executing #then does not resolve or fetch native", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			urls.push(String(input));
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig({ auto: false }), source: "test" }));

		// when
		const result = await execute(tool, { query: "no native" }, context());

		// then
		expect(resolveNativeRouteMock).not.toHaveBeenCalled();
		expect(urls).toEqual(["https://exa.example.com"]);
		expect((result.details as SearchDetails).native?.status).toBe("skipped");
	});

	it("#given a model with no active selection #when executing #then skips native and uses the configured chain", async () => {
		// given
		resolveNativeRouteMock.mockResolvedValue({
			status: { status: "skipped", reason: "native adapter is not known" },
		});
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			urls.push(String(input));
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		const result = await execute(tool, { query: "skip native" }, context());

		// then
		expect(urls).toEqual(["https://exa.example.com"]);
		expect((result.details as SearchDetails).native?.reason).toBe("native adapter is not known");
	});

	it("#given a ready native route #when the request is already aborted #then rejects before resolution or fetch", async () => {
		// given
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when / then
		await expect(execute(tool, { query: "aborted" }, context(), controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(resolveNativeRouteMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("#given cancellation during native resolution #when resolution returns #then rejects before fetch", async () => {
		// given
		const controller = new AbortController();
		resolveNativeRouteMock.mockImplementation(async () => {
			controller.abort();
			return nativeResolution();
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when / then
		await expect(execute(tool, { query: "abort after auth" }, context(), controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("#given the active model changes while native auth is pending #when auth resolves #then uses the captured model snapshot", async () => {
		// given
		const ctx = context();
		const capturedModel = ctx.model;
		const nextModel = {
			provider: "openai",
			id: "gpt-5.4",
			api: "openai-responses",
			baseUrl: "https://next-native.example.com/v1",
		};
		resolveNativeRouteMock.mockImplementation(async (_model, registry) => {
			ctx.model = nextModel;
			await registry.getApiKeyAndHeaders();
			return nativeResolution();
		});
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> => jsonResponse(nativePayload("https://native.example/result")),
		);
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		await execute(tool, { query: "model snapshot" }, ctx);

		// then
		expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(capturedModel);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalledWith(nextModel);
	});

	it("#given native auth hangs #when the caller aborts #then rejects immediately and never fetches", async () => {
		// given
		const controller = new AbortController();
		let rejectAuth: ((error: Error) => void) | undefined;
		resolveNativeRouteMock.mockReturnValue(
			new Promise((_resolve, reject) => {
				rejectAuth = reject;
			}),
		);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		const pending = execute(tool, { query: "hung auth abort" }, context(), controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });

		// then
		expect(fetchMock).not.toHaveBeenCalled();
		rejectAuth?.(new Error("late auth failure"));
		await Promise.resolve();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("#given native auth hangs #when the total search deadline expires #then returns a timeout without fetching", async () => {
		// given
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		resolveNativeRouteMock.mockReturnValue(new Promise(() => {}));
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		const pending = execute(tool, { query: "auth deadline" }, context());
		await vi.advanceTimersByTimeAsync(SEARCH_TOTAL_BUDGET_MS + 1);
		const result = await pending;

		// then
		expect(fetchMock).not.toHaveBeenCalled();
		const details = result.details as SearchDetails;
		expect(details.failureKind).toBe("timeout");
		expect(details.error).toContain("deadline");
		expect(details.native?.reason).toContain("deadline");
	});

	it("#given the registry wrapper #when resolving native auth #then passes the full active model object", async () => {
		// given
		const ctx = context();
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> => jsonResponse(nativePayload("https://native.example/result")),
		);

		// when
		await execute(tool, { query: "full model" }, ctx);

		// then
		const registry = resolveNativeRouteMock.mock.calls[0]?.[1] as {
			getApiKeyAndHeaders(): Promise<{ ok: boolean; apiKey?: string }>;
		};
		expect(registry).toBeDefined();
		await registry.getApiKeyAndHeaders();
		expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(ctx.model);
	});

	it("#given an explicit hosted provider entry in normal mode #when auto is false #then keeps the configured entry", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			urls.push(String(input));
			return jsonResponse(nativePayload("https://hosted.example/result"));
		});
		const hosted: SearchProviderEntry = {
			id: "hosted",
			provider: "openai",
			apiKey: "openai-test",
			baseUrl: "https://hosted.example/v1/responses",
			model: "gpt-5.5",
		};
		const tool = createWebSearchTool(() => ({
			ok: true,
			config: baseConfig({ auto: false, providers: [hosted] }),
			source: "test",
		}));

		// when
		const result = await execute(tool, { query: "explicit hosted" }, context());

		// then
		const details = result.details as SearchDetails;
		expect(urls).toEqual(["https://hosted.example/v1/responses"]);
		expect(details.entryId).toBe("hosted");
	});

	it("#given a configured chain #when executing #then never injects a hidden DuckDuckGo provider", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			urls.push(String(input));
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		resolveNativeRouteMock.mockResolvedValue({ status: { status: "skipped", reason: "no native" } });
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		await execute(tool, { query: "no hidden backend" }, context());

		// then
		expect(urls).toEqual(["https://exa.example.com"]);
		expect(urls.some((url) => url.includes("duckduckgo"))).toBe(false);
	});

	it("#given global maxResults #when native returns more #then caps results and reports the global limit in progress", async () => {
		// given
		const updates: ToolUpdate[] = [];
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			return jsonResponse(nativePayload("https://one.example", "https://two.example", "https://three.example"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig({ maxResults: 2 }), source: "test" }));

		// when
		const result = await execute(tool, { query: "max results" }, context(), undefined, updates);

		// then
		const progress = updates[0]?.details as SearchProgressDetails;
		expect(progress.maxResults).toBe(2);
		expect((result.details as SearchDetails).results).toHaveLength(2);
	});

	it("#given global policy #when native is attempted #then forwards allowed-domain policy to the native request", async () => {
		// given
		let body = "";
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			body = String(init?.body ?? "");
			return jsonResponse(nativePayload("https://docs.example.com/result"));
		});
		const tool = createWebSearchTool(() => ({
			ok: true,
			config: baseConfig({ allowedDomains: ["docs.example.com"] }),
			source: "test",
		}));

		// when
		await execute(tool, { query: "policy" }, context());

		// then
		expect(JSON.parse(body)).toMatchObject({
			tools: [{ filters: { allowed_domains: ["docs.example.com"] } }],
		});
	});

	it("#given a native 400 without an explicit unsupported marker #when searching twice #then retries native both times", async () => {
		// given
		let nativeCalls = 0;
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			if (String(input).includes("native")) {
				nativeCalls += 1;
				return jsonResponse({ error: "bad request" }, 400);
			}
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		await execute(tool, { query: "400 cache" }, context());
		await execute(tool, { query: "400 cache" }, context());

		// then
		expect(nativeCalls).toBe(2);
	});

	it("#given an explicit unsupported native tool response #when searching twice #then short-caches native but keeps fallback working", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.includes("native")) {
				return jsonResponse({ error: "web_search tool is not supported for this model" }, 400);
			}
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		const first = await execute(tool, { query: "unsupported cache" }, context());
		const second = await execute(tool, { query: "unsupported cache" }, context());

		// then
		expect(urls).toEqual([
			"https://native.example.com/v1/responses",
			"https://exa.example.com",
			"https://exa.example.com",
		]);
		expect((first.details as SearchDetails).attempts?.[0]?.failureKind).toBe("unsupported");
		expect((second.details as SearchDetails).native?.status).toBe("skipped");
		expect((second.details as SearchDetails).native?.reason).toContain("recently reported");
	});

	it("#given a native auth failure #when searching twice #then never caches it as unsupported", async () => {
		// given
		let nativeCalls = 0;
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			if (String(input).includes("native")) {
				nativeCalls += 1;
				return jsonResponse({ error: "bad key" }, 401);
			}
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		await execute(tool, { query: "auth cache" }, context());
		await execute(tool, { query: "auth cache" }, context());

		// then
		expect(nativeCalls).toBe(2);
	});

	it("#given an unsupported cache #when the active model changes #then retries native", async () => {
		// given
		let nativeCalls = 0;
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			if (String(input).includes("native")) {
				nativeCalls += 1;
				return jsonResponse({ error: "web_search tool is not supported" }, 400);
			}
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));
		const firstContext = context();
		const secondContext = context({
			provider: "openai",
			id: "gpt-5.4",
			api: "openai-responses",
			baseUrl: "https://native.example.com/v1",
		});

		// when
		await execute(tool, { query: "model reset" }, firstContext);
		await execute(tool, { query: "model reset" }, secondContext);

		// then
		expect(nativeCalls).toBe(2);
	});

	it("#given an unsupported cache #when the resolved endpoint changes #then retries native", async () => {
		// given
		let nativeCalls = 0;
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			if (String(input).includes("native")) {
				nativeCalls += 1;
				return jsonResponse({ error: "web_search tool is not supported" }, 400);
			}
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		await execute(tool, { query: "endpoint reset" }, context());
		resolveNativeRouteMock.mockResolvedValue(
			nativeResolution({
				entry: {
					id: "native",
					provider: "openai",
					apiKey: "native-test",
					baseUrl: "https://other-native.example/v1/responses",
					model: "gpt-5.5",
				},
				key: "openai|https://other-native.example/v1/responses",
			}),
		);
		await execute(tool, { query: "endpoint reset" }, context());

		// then
		expect(nativeCalls).toBe(2);
	});

	it("#given an unsupported cache #when its TTL expires #then retries native", async () => {
		// given
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		let nativeCalls = 0;
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			if (String(input).includes("native")) {
				nativeCalls += 1;
				return jsonResponse({ error: "web_search tool is not supported" }, 400);
			}
			return jsonResponse(exaResults("https://exa.example/result"));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		await execute(tool, { query: "ttl" }, context());
		vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
		await execute(tool, { query: "ttl" }, context());

		// then
		expect(nativeCalls).toBe(2);
	});

	it("#given round-robin state #when the config fingerprint changes #then resets the chain cursor", async () => {
		// given
		let currentConfig = baseConfig({
			strategy: "round-robin",
			fallback: false,
			providers: [
				{ id: "one", provider: "exa", baseUrl: "https://one.example.com" },
				{ id: "two", provider: "exa", baseUrl: "https://two.example.com" },
			],
		});
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.includes("native")) return jsonResponse({ error: "down" }, 503);
			return jsonResponse(exaResults(`https://${url.includes("one") ? "one" : "two"}.example.com/result`));
		});
		const tool = createWebSearchTool(() => ({ ok: true, config: currentConfig, source: "test" }));

		// when
		await execute(tool, { query: "state" }, context());
		await execute(tool, { query: "state" }, context());
		currentConfig = {
			...currentConfig,
			providers: [
				{ id: "two", provider: "exa", baseUrl: "https://two.example.com" },
				{ id: "one", provider: "exa", baseUrl: "https://one.example.com" },
			],
		};
		await execute(tool, { query: "state" }, context());

		// then
		expect(urls).toEqual([
			"https://native.example.com/v1/responses",
			"https://one.example.com",
			"https://native.example.com/v1/responses",
			"https://two.example.com",
			"https://native.example.com/v1/responses",
			"https://two.example.com",
		]);
	});

	it("#given invalid domain filters #when executing #then returns error details without a provider", async () => {
		// given
		const tool = createWebSearchTool(() => ({ ok: true, config: baseConfig(), source: "test" }));

		// when
		const result = await execute(
			tool,
			{ query: "bad filters", allowed_domains: ["example.com"], blocked_domains: ["example.org"] },
			context(),
		);

		// then
		const details = result.details as SearchErrorDetails;
		expect(details).toEqual({
			phase: "error",
			query: "bad filters",
			error: "Error: Cannot specify both allowed_domains and blocked_domains in the same request",
		});
		expect("provider" in details).toBe(false);
	});

	it("#given config load failure #when executing #then returns load error details", async () => {
		// given
		const tool = createWebSearchTool(() => ({
			ok: false,
			reason: "invalid_config",
			message: "Invalid provider config in .pi/websearch.json",
		}));

		// when
		const result = await execute(tool, { query: "config failure" }, context());

		// then
		const details = result.details as SearchErrorDetails;
		expect(details).toEqual({
			phase: "error",
			query: "config failure",
			error: "Invalid provider config in .pi/websearch.json",
			reason: "invalid_config",
		});
	});
});
