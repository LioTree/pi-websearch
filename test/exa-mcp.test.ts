import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultWebsearchConfig, loadWebsearchConfig, validateProviderConfig } from "../src/websearch/config.js";
import { readExaMcpResponse } from "../src/websearch/providers/exa-mcp.js";
import { buildSearchRequest, isDirectSearchProvider, normalizeSearchResponse } from "../src/websearch/providers.js";
import { performSearch } from "../src/websearch/search.js";
import { createWebSearchTool } from "../src/websearch/tool.js";
import type { JsonObject, SearchDetails } from "../src/websearch/types.js";

const request = { query: "Node.js documentation", maxResults: 3 };
const text =
	"Title: Node.js\nURL: https://nodejs.org/docs/\nPublished: N/A\nAuthor: N/A\nHighlights:\nOfficial documentation";
const envelope = (result: JsonObject): JsonObject => ({ jsonrpc: "2.0", id: 1, result });
const success = () => envelope({ content: [{ type: "text", text }] });
const jsonResponse = (value: JsonObject) =>
	new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const sseResponse = (data: string) => new Response(data, { headers: { "Content-Type": "text/event-stream" } });
const sse = (value: JsonObject) => `event: message\ndata: ${JSON.stringify(value)}\n\n`;

function mockResponse(response: Response) {
	const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function run(response: Response) {
	const fetchMock = mockResponse(response);
	const result = await performSearch(defaultWebsearchConfig(), request);
	return { result, fetchMock };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Exa MCP direct search", () => {
	it("#given anonymous config #when building request #then uses official stateless tools/call without credentials", () => {
		const built = buildSearchRequest({ provider: "exa-mcp" }, { ...request, maxResults: 500 });
		expect(built.url).toBe("https://mcp.exa.ai/mcp");
		expect(built.responseFormat).toBe("exa-mcp");
		expect(built.init.headers).toEqual({
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
		});
		expect(built.body).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "web_search_exa",
				arguments: { query: request.query, numResults: 50 },
			},
		});
		expect(validateProviderConfig({ provider: "exa-mcp" }).ok).toBe(true);
		expect(validateProviderConfig({ provider: "exa" }).ok).toBe(false);
		expect(isDirectSearchProvider({ provider: "exa-mcp" })).toBe(true);
	});

	it.each(["json", "sse"])(
		"#given %s MCP response #when searching #then returns typed engine sources",
		async (format) => {
			const { result, fetchMock } = await run(
				format === "json" ? jsonResponse(success()) : sseResponse(sse(success())),
			);
			expect(result.error).toBeUndefined();
			expect(result.results).toEqual([
				{ title: "Node.js", url: "https://nodejs.org/docs/", snippet: "Official documentation" },
			]);
			expect(result.provider).toBe("exa-mcp");
			expect(result.answer).toBeUndefined();
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("#given multiple serialized results #when normalizing #then retains snippets, dates and result boundaries", () => {
		const second =
			"Title: Other\nURL: https://example.com/\nPublished: 2026-10-01\nAuthor: Writer\nText: Article text";
		const items = normalizeSearchResponse(
			"exa-mcp",
			envelope({ content: [{ type: "text", text: `${text}\n\n---\n\n${second}` }] }),
		);
		expect(items).toHaveLength(2);
		expect(items[1]).toEqual({
			title: "Other",
			url: "https://example.com/",
			publishedAt: "2026-10-01",
			snippet: "Article text",
		});
	});

	it("#given service notices before results #when normalizing #then parses source records", async () => {
		const { result } = await run(
			jsonResponse(
				envelope({
					content: [
						{
							type: "text",
							text: `Note: Search restrictions were relaxed.\nNote: Using available results.\n\n${text}`,
						},
					],
				}),
			),
		);
		expect(result.results[0]?.url).toBe("https://nodejs.org/docs/");
		expect(result.error).toBeUndefined();
	});

	it("#given more sources than the runtime cap #when searching #then returns at most 50", async () => {
		mockResponse(
			jsonResponse(
				envelope({
					structuredContent: {
						results: Array.from({ length: 60 }, (_, index) => ({
							title: `Result ${index}`,
							url: `https://example.com/${index}`,
						})),
					},
				}),
			),
		);
		const result = await performSearch(
			{ ...defaultWebsearchConfig(), maxResults: 1000 },
			{ ...request, maxResults: 1000 },
		);
		expect(result.results).toHaveLength(50);
		expect(result.truncated).toBe(true);
	});

	it("#given optional structured results #when normalizing #then uses source records rather than notices", () => {
		expect(
			normalizeSearchResponse(
				"exa-mcp",
				envelope({
					structuredContent: { results: [{ title: "Source", url: "https://example.com", text: "Source text" }] },
					content: [{ type: "text", text: "A service notice" }],
				}),
			),
		).toEqual([{ title: "Source", url: "https://example.com", snippet: "Source text" }]);
	});

	it("#given domain policies #when building and reading #then encodes query hints and enforces returned URL filters", async () => {
		const fetchMock = mockResponse(
			jsonResponse(
				envelope({
					content: [
						{
							type: "text",
							text: `${text}\n\n---\n\nTitle: Other\nURL: https://blocked.nodejs.org/\nPublished: N/A\nAuthor: N/A\nText: Excluded`,
						},
					],
				}),
			),
		);
		const result = await performSearch(
			{
				...defaultWebsearchConfig(),
				allowedDomains: ["nodejs.org"],
				providers: [{ provider: "exa-mcp", blockedDomains: ["blocked.nodejs.org"] }],
			},
			request,
		);
		expect(result.results).toHaveLength(1);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(JSON.parse(String(init?.body)).params.arguments.query).toBe(
			"Node.js documentation site:nodejs.org -site:blocked.nodejs.org",
		);
	});

	it("#given every source outside allowed domains #when searching #then reports no-results", async () => {
		mockResponse(jsonResponse(success()));
		const result = await performSearch(defaultWebsearchConfig(), { ...request, allowedDomains: ["example.com"] });
		expect(result.failureKind).toBe("no-results");
		expect(result.results).toEqual([]);
	});

	it.each([
		[
			envelope({
				_meta: { "ai.exa/rateLimited": true },
				content: [{ type: "text", text: "You've hit Exa's free MCP rate limit." }],
			}),
			"quota",
		],
		[
			envelope({
				isError: true,
				content: [{ type: "text", text: "web_search_exa error (429): rate limit exceeded" }],
			}),
			"quota",
		],
		[
			envelope({ isError: true, content: [{ type: "text", text: "web_search_exa error: temporary failure" }] }),
			"request",
		],
		[envelope({ isError: true, content: [{ type: "text", text: "web_search_exa error (401): denied" }] }), "auth"],
		[
			envelope({ isError: true, content: [{ type: "text", text: "web_search_exa error (503): retry later" }] }),
			"network",
		],
		[{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Quota exceeded" } }, "quota"],
		[
			envelope({ content: [{ type: "text", text: "No search results found. Please try a different query." }] }),
			"no-results",
		],
		[
			envelope({ content: [{ type: "text", text: "An answer with https://example.com is not a source record" }] }),
			"invalid-response",
		],
		[envelope({ content: [] }), "invalid-response"],
		[{ jsonrpc: "2.0", id: 2, result: {} }, "invalid-response"],
		[{ results: [] }, "invalid-response"],
		[
			envelope({
				content: [
					{
						type: "text",
						text: "Title: Unsafe\nURL: javascript:alert(1)\nPublished: N/A\nAuthor: N/A\nText: Bad",
					},
				],
			}),
			"invalid-response",
		],
	] satisfies Array<[JsonObject, string]>)(
		"#given MCP error or unusable payload %j #when searching #then reports %s without hidden DDG",
		async (payload, kind) => {
			const { result, fetchMock } = await run(jsonResponse(payload));
			expect(result.failureKind).toBe(kind);
			expect(result.error).toBeTruthy();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.attempts?.map((attempt) => attempt.provider)).toEqual(["exa-mcp"]);
		},
	);

	it.each([429, 503])("#given HTTP %i #when searching #then reports quota or network failure", async (status) => {
		const { result } = await run(new Response("service error", { status }));
		expect(result.failureKind).toBe(status === 429 ? "quota" : "network");
		expect(result.httpStatus).toBe(status);
	});

	it.each([
		["data: {broken}\n\n", "text/event-stream"],
		[`data: ${JSON.stringify(success())}\n`, "text/event-stream"],
		["{}", "text/html"],
		["{broken}", "application/json"],
	])("#given malformed body %s #when decoding #then fails as invalid-response", async (body, contentType) => {
		const { result } = await run(new Response(body, { headers: { "Content-Type": contentType } }));
		expect(result.failureKind).toBe("invalid-response");
	});

	it("#given unsupported response media type #when rejecting #then cancels the unread response body", async () => {
		const cancel = vi.fn();
		const { result } = await run(
			new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "text/html" } }),
		);
		expect(result.failureKind).toBe("invalid-response");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("#given chunked CRLF and notifications #when decoding #then waits for matching complete result", async () => {
		const data = `${sse({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}${sse(success())}`.replace(
			/\n/g,
			"\r\n",
		);
		const chunks = new TextEncoder().encode(data);
		let index = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (index < chunks.length) controller.enqueue(chunks.slice(index, ++index));
				else controller.close();
			},
		});
		const decoded = await readExaMcpResponse(
			new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
			new AbortController().signal,
		);
		expect(decoded).toEqual(success());
	});

	it("#given oversized JSON body #when reading #then enforces the total byte limit", async () => {
		const { result } = await run(
			new Response(" ".repeat(8 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } }),
		);
		expect(result.failureKind).toBe("invalid-response");
		expect(result.error).toContain("response size limit");
	});

	it("#given too many notification events #when reading #then enforces the event-count limit", async () => {
		const { result } = await run(
			sseResponse(sse({ jsonrpc: "2.0", method: "notifications/progress" }).repeat(10_001)),
		);
		expect(result.failureKind).toBe("invalid-response");
		expect(result.error).toContain("event limit");
	});

	it("#given already cancelled request #when searching #then never fetches", async () => {
		const fetchMock = mockResponse(jsonResponse(success()));
		const controller = new AbortController();
		controller.abort();
		await expect(performSearch(defaultWebsearchConfig(), request, controller.signal)).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("#given oversized SSE event #when reading #then rejects bounded response", async () => {
		const { result } = await run(sseResponse(`data: ${"x".repeat(1024 * 1024 + 1)}`));
		expect(result.failureKind).toBe("invalid-response");
		expect(result.error).toContain("size limit");
	});

	it("#given cancellation while reading #when aborted #then cancels reader and never starts another provider", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		mockResponse(new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "text/event-stream" } }));
		const promise = performSearch(defaultWebsearchConfig(), request, controller.signal);
		await Promise.resolve();
		controller.abort(new DOMException("Stopped", "AbortError"));
		await expect(promise).rejects.toThrow("Stopped");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("#given hanging MCP stream #when per-entry timeout expires #then reports timeout and cancels reader", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		mockResponse(new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "text/event-stream" } }));
		const promise = performSearch({ ...defaultWebsearchConfig(), timeoutMs: 25 }, request);
		await vi.advanceTimersByTimeAsync(26);
		const result = await promise;
		expect(result.failureKind).toBe("timeout");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("#given no configuration and native failure #when using tool #then falls through to anonymous MCP", async () => {
		const root = await mkdtemp(join(tmpdir(), "websearch-default-"));
		try {
			const loaded = await loadWebsearchConfig({ cwd: root, homeDir: root });
			const fetchMock = vi.fn(async (input: string | URL | Request) =>
				String(input).includes("api.openai.com")
					? new Response("unsupported", { status: 400 })
					: jsonResponse(success()),
			);
			vi.stubGlobal("fetch", fetchMock);
			const tool = createWebSearchTool(() => loaded);
			const result = await tool.execute("default", { query: request.query }, undefined, undefined, {
				model: { provider: "openai", id: "model", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
				modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake-key" }) },
			} as never);
			expect((result.details as SearchDetails).attempts?.map((attempt) => attempt.provider)).toEqual([
				"openai",
				"exa-mcp",
			]);
			expect((result.details as SearchDetails).results).toHaveLength(1);
			expect(tool.parameters.properties).not.toHaveProperty("mode");
			expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
				"https://api.openai.com/v1/responses",
				"https://mcp.exa.ai/mcp",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given explicit raw MCP config #when using raw tool #then skips native credentials and model-answer entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "websearch-raw-mcp-"));
		try {
			await mkdir(join(root, ".pi"));
			await writeFile(
				join(root, ".pi", "websearch.json"),
				JSON.stringify({
					rawMode: true,
					providers: [{ provider: "openai", apiKey: "fake-key" }, { provider: "exa-mcp" }],
				}),
			);
			const loaded = await loadWebsearchConfig({ cwd: root, homeDir: root });
			const fetchMock = mockResponse(jsonResponse(success()));
			const auth = vi.fn();
			const result = await createWebSearchTool(() => loaded).execute(
				"raw",
				{ query: request.query, mode: "raw" },
				undefined,
				undefined,
				{ modelRegistry: { getApiKeyAndHeaders: auth } } as never,
			);
			expect((result.details as SearchDetails).mode).toBe("raw");
			expect((result.details as SearchDetails).results).toHaveLength(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(auth).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
