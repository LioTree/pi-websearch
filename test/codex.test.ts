import { afterEach, describe, expect, it, vi } from "vitest";

import { validateProviderConfig, validateWebsearchConfig } from "../src/websearch/config.js";
import { type NativeModelInfo, resolveNativeAdapter, resolveNativeRoute } from "../src/websearch/native.js";
import { buildSearchRequest, isDirectSearchProvider, normalizeSearchResponse } from "../src/websearch/providers.js";
import { performProviderSearch, performSearch } from "../src/websearch/search.js";
import type { JsonObject, SearchProviderEntry, WebsearchConfig } from "../src/websearch/types.js";

function token(account = "test-codex-account"): string {
	return `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}

const entry: SearchProviderEntry = { provider: "openai-codex", apiKey: token(), model: "arbitrary-codex-alias" };
const request = { query: "Codex web search", maxResults: 5 };
const model: NativeModelInfo = {
	provider: "openai-codex",
	id: "arbitrary-codex-alias",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};
const searchItem: JsonObject = {
	id: "search-1",
	type: "web_search_call",
	status: "completed",
	action: { type: "search", sources: [{ url: "https://docs.example/search" }] },
};
const messageItem: JsonObject = {
	id: "message-1",
	type: "message",
	content: [
		{
			type: "output_text",
			text: "A cited summary.",
			annotations: [{ type: "url_citation", url: "https://docs.example/search", title: "Search docs" }],
		},
	],
};

function event(data: JsonObject): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}
function completion(output: JsonObject[] = [searchItem, messageItem], type = "response.completed"): JsonObject {
	return { type, response: { status: "completed", output } };
}
function streamResponse(events: JsonObject[], separator = "\n"): Response {
	return new Response(events.map(event).join("").replaceAll("\n", separator), {
		headers: { "Content-Type": "text/event-stream" },
	});
}
function config(): WebsearchConfig {
	return {
		auto: true,
		fallback: false,
		strategy: "priority",
		providers: [{ provider: "exa", apiKey: "fallback-credential" }],
	};
}
function registry() {
	return { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: token() })) };
}

describe("Codex subscription search", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("#given Codex subscription configuration #when validating #then requires bearer credentials and excludes it from raw", () => {
		expect(validateProviderConfig(entry).ok).toBe(true);
		expect(validateProviderConfig({ provider: "openai-codex" }).ok).toBe(false);
		expect(validateProviderConfig({ provider: "openai-codex", headers: { "x-api-key": "not-bearer" } }).ok).toBe(
			false,
		);
		expect(isDirectSearchProvider(entry)).toBe(false);
		expect(validateWebsearchConfig({ ...config(), rawMode: true, providers: [entry] }).ok).toBe(false);
	});

	it("#given an active Codex model with an arbitrary alias #when inspecting #then resolves the subscription adapter and endpoint without auth", () => {
		expect(resolveNativeAdapter(model)).toMatchObject({
			adapter: "codex",
			endpoint: "https://chatgpt.com/backend-api/codex/responses",
			status: { status: "ready", model: model.id },
		});
		expect(resolveNativeAdapter({ ...model, api: "openai-responses" }).status.status).toBe("skipped");
	});

	it("#given active Codex credentials #when resolving native search #then selects the separate subscription provider", async () => {
		const auth = registry();
		const resolved = await resolveNativeRoute(model, auth);
		expect(auth.getApiKeyAndHeaders).toHaveBeenCalledExactlyOnceWith(model);
		expect(resolved.entry).toMatchObject({
			provider: "openai-codex",
			model: model.id,
			apiKey: token(),
			baseUrl: "https://chatgpt.com/backend-api/codex/responses",
		});
	});

	it("#given a renamed provider opting into Codex #when resolving #then preserves its resolved gateway, headers and model", async () => {
		const resolved = await resolveNativeRoute(
			{ ...model, provider: "my-codex" },
			{
				async getApiKeyAndHeaders() {
					return {
						ok: true,
						apiKey: token(),
						baseUrl: "https://gateway.example/backend-api",
						headers: { "cf-aig-authorization": "Bearer gateway-credential" },
					};
				},
			},
			{ "my-codex": { adapter: "codex" } },
		);
		expect(resolved.entry).toMatchObject({
			provider: "openai-codex",
			baseUrl: "https://gateway.example/backend-api/codex/responses",
			headers: { "cf-aig-authorization": "Bearer gateway-credential" },
		});
	});

	it("#given OpenAI auth resolving to ChatGPT #when resolving #then changes the request adapter to Codex without borrowing another account", async () => {
		const auth = {
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true as const,
				apiKey: token(),
				baseUrl: "https://chatgpt.com/backend-api",
			})),
		};
		const resolved = await resolveNativeRoute(
			{ ...model, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
			auth,
		);
		expect(resolved.entry).toMatchObject({
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex/responses",
		});
		expect(resolved.status.adapter).toBe("codex");
		expect(auth.getApiKeyAndHeaders).toHaveBeenCalledOnce();
	});

	it("#given a disabled Codex override #when resolving #then never resolves credentials", async () => {
		const auth = registry();
		expect((await resolveNativeRoute(model, auth, { "openai-codex": false })).entry).toBeUndefined();
		expect(auth.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("#given a subscription token #when building #then uses Codex identity, account headers, structured input and streaming-only fields", () => {
		const built = buildSearchRequest(entry, request);
		expect(built.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(built.responseFormat).toBe("codex-sse");
		expect(built.init.headers).toMatchObject({
			Authorization: `Bearer ${token()}`,
			"chatgpt-account-id": "test-codex-account",
			originator: "pi",
			Accept: "text/event-stream",
			"OpenAI-Beta": "responses=experimental",
		});
		expect(built.body).toMatchObject({
			model: model.id,
			store: false,
			stream: true,
			instructions: expect.any(String),
			input: [{ role: "user", content: [{ type: "input_text", text: expect.stringContaining(request.query) }] }],
			tools: [{ type: "web_search" }],
			include: ["web_search_call.action.sources"],
			tool_choice: "required",
		});
		expect(built.body).not.toHaveProperty("max_output_tokens");
	});

	it("#given an explicit bearer header overriding apiKey #when building #then derives the account from the effective outgoing credential", () => {
		const built = buildSearchRequest(
			{
				...entry,
				headers: { authorization: `Bearer ${token("header-account")}`, "cf-aig-authorization": "Bearer gateway" },
			},
			request,
		);
		expect(built.init.headers["chatgpt-account-id"]).toBe("header-account");
		expect(built.init.headers["authorization"]).toBe(`Bearer ${token("header-account")}`);
		expect(built.init.headers["cf-aig-authorization"]).toBe("Bearer gateway");
	});

	it("#given header-only opaque gateway auth with an account header #when building #then accepts it without requiring a JWT", () => {
		const built = buildSearchRequest(
			{
				provider: "openai-codex",
				headers: { Authorization: "Bearer opaque-token", "ChatGPT-Account-ID": "gateway-account" },
			},
			request,
		);
		expect(built.init.headers["ChatGPT-Account-ID"]).toBe("gateway-account");
	});

	it.each([
		{ ...entry, apiKey: "not-a-subscription-token" },
		{ ...entry, headers: { Authorization: null } },
		{ ...entry, headers: { "chatgpt-account-id": null } },
	])(
		"#given missing subscription identity %j #when building #then fails before any fetch without leaking the token",
		(badEntry) => {
			expect(() => buildSearchRequest(badEntry, request)).toThrow(/Codex subscription search requires/);
		},
	);

	it("#given domain filters and cached search #when building #then preserves restrictions and disables external access without dropping them", () => {
		const built = buildSearchRequest(
			{ ...entry, codexMode: "cached", allowedDomains: ["docs.example"], blockedDomains: ["ads.docs.example"] },
			request,
		);
		expect(built.body?.["tools"]).toEqual([
			{ type: "web_search", external_web_access: false, filters: { allowed_domains: ["docs.example"] } },
		]);
		expect(JSON.stringify(built.body?.["input"])).toContain("-site:ads.docs.example");
	});

	it("#given a legacy codex API-key entry #when building #then keeps its old non-streaming API request unchanged", () => {
		const built = buildSearchRequest({ provider: "codex", apiKey: "sk-legacy-key" }, request);
		expect(built.url).toBe("https://api.openai.com/v1/responses");
		expect(built.responseFormat).toBeUndefined();
		expect(built.body).not.toHaveProperty("stream");
	});

	it.each(["response.completed", "response.done"])(
		"#given a %s terminal event #when reading #then returns only structured search sources",
		async (type) => {
			vi.stubGlobal("fetch", async () => streamResponse([completion(undefined, type)]));
			const details = await performProviderSearch(entry, request);
			expect(details.error).toBeUndefined();
			expect(details.results).toEqual([
				{ title: "Search docs", url: "https://docs.example/search", snippet: "A cited summary." },
			]);
		},
	);

	it("#given split UTF-8, CRLF, comments and multiline SSE data #when reading #then reassembles events correctly", async () => {
		const terminal = completion([{ ...searchItem, action: { sources: [{ url: "https://docs.example/中文" }] } }]);
		const bytes = new TextEncoder().encode(
			`: keepalive\r\nevent: response.completed\r\ndata: ${JSON.stringify(terminal).slice(0, 1)}\r\ndata: ${JSON.stringify(terminal).slice(1)}\r\n\r\n`,
		);
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
							controller.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		expect((await performProviderSearch(entry, request)).results[0]?.url).toBe("https://docs.example/中文");
	});

	it("#given completed output items omitted from the final snapshot #when reading #then keeps their structured sources", async () => {
		vi.stubGlobal("fetch", async () =>
			streamResponse([{ type: "response.output_item.done", item: searchItem }, completion([])]),
		);
		expect((await performProviderSearch(entry, request)).results[0]?.url).toBe("https://docs.example/search");
	});

	it.each([
		{ events: [{ type: "response.output_item.done", item: searchItem }] },
		{ events: [{ type: "response.failed", response: { error: null, output: [searchItem] } }] },
		{ events: [{ type: "response.incomplete", response: { output: [searchItem] } }] },
		{ events: [{ type: "response.completed", response: { status: "failed", output: [searchItem] } }] },
	])(
		"#given an unfinished or failed stream %j #when reading #then never reports partial sources as success",
		async ({ events }) => {
			vi.stubGlobal("fetch", async () => streamResponse(events));
			const details = await performProviderSearch(entry, request);
			expect(details.results).toEqual([]);
			expect(details.failureKind).toBe("invalid-response");
		},
	);

	it.each([
		["insufficient_quota", "quota"],
		["rate_limit_exceeded", "quota"],
		["invalid_api_key", "auth"],
		["server_error", "network"],
	])(
		"#given a stream error %s inside HTTP 200 #when reading #then preserves its %s failure classification",
		async (code, failureKind) => {
			vi.stubGlobal("fetch", async () =>
				streamResponse([
					{ type: "error", error: { code, message: `Upstream echoed ${token()} and test-codex-account` } },
					completion(),
				]),
			);
			const details = await performProviderSearch(entry, request);
			expect(details.failureKind).toBe(failureKind);
			expect(details.results).toEqual([]);
			expect(details.error).not.toContain(token());
			expect(details.error).not.toContain("test-codex-account");
		},
	);

	it("#given an explicit unsupported search error inside a stream #when reading #then exposes it as unsupported", async () => {
		vi.stubGlobal("fetch", async () =>
			streamResponse([{ type: "error", message: "web_search is not supported", code: "invalid_request_error" }]),
		);
		expect((await performProviderSearch(entry, request)).failureKind).toBe("unsupported");
	});

	it("#given only prose URLs #when reading completed output #then refuses to invent search sources", async () => {
		vi.stubGlobal("fetch", async () =>
			streamResponse([
				completion([{ type: "message", content: [{ type: "output_text", text: "See https://fake.example/" }] }]),
			]),
		);
		expect((await performProviderSearch(entry, request)).results).toEqual([]);
		expect(normalizeSearchResponse("openai-codex", { output: [] })).toEqual([]);
	});

	it("#given malformed SSE data #when reading #then returns invalid-response rather than ignoring corrupted events", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(`data: {broken}\n\n${event(completion())}`, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		expect((await performProviderSearch(entry, request)).failureKind).toBe("invalid-response");
	});

	it("#given a completed response whose connection stays open #when reading #then returns promptly and cancels the reader", async () => {
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(event(completion())));
						},
						cancel,
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const details = await performProviderSearch(entry, request);
		expect(details.results).toHaveLength(1);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("#given a CR-only completed event and an open connection #when reading #then returns without waiting for EOF or another byte", async () => {
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(event(completion()).replaceAll("\n", "\r")));
						},
						cancel,
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		expect((await performProviderSearch(entry, request)).results).toHaveLength(1);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each([
		{ body: "data: [DONE]\n\n", label: "premature DONE marker" },
		{ body: `data: ${"x".repeat(1024 * 1024 + 1)}`, label: "oversized unfinished frame" },
		{ body: ": x\n\n".repeat(1_700_000), label: "oversized stream" },
		{ body: event({ type: "response.created" }).repeat(10_001), label: "excessive events" },
	])("#given $label #when reading #then bounds resource use and returns invalid-response", async ({ body }) => {
		vi.stubGlobal("fetch", async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
		expect((await performProviderSearch(entry, request)).failureKind).toBe("invalid-response");
	});

	it("#given a caller cancelling while waiting for SSE #when aborting #then rejects and cancels the reader without starting fallback", async () => {
		const cancel = vi.fn();
		const controller = new AbortController();
		const fetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							stream.enqueue(new TextEncoder().encode(": keepalive\n\n"));
						},
						cancel,
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		vi.stubGlobal("fetch", fetch);
		const native = await resolveNativeRoute(model, registry());
		const running = performSearch(config(), request, controller.signal, undefined, undefined, {
			...(native.entry ? { nativeEntry: native.entry } : {}),
			nativeStatus: native.status,
		});
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		controller.abort();
		await expect(running).rejects.toThrow();
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("#given a stalled SSE response #when its timeout expires #then cancels the reader and reports timeout", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							stream.enqueue(new TextEncoder().encode(": keepalive\n\n"));
						},
						cancel,
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const running = performProviderSearch({ ...entry, timeoutMs: 10 }, request);
		await vi.advanceTimersByTimeAsync(10);
		expect((await running).failureKind).toBe("timeout");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("#given a subscription native stream failing with quota #when searching #then falls back even when chain fallback is false", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = String(input);
			urls.push(url);
			return url.includes("chatgpt.com")
				? streamResponse([
						{
							type: "response.failed",
							response: { error: { code: "insufficient_quota", message: "Quota exhausted" } },
						},
					])
				: new Response(JSON.stringify({ results: [{ title: "Fallback", url: "https://fallback.example/" }] }));
		});
		const native = await resolveNativeRoute(model, registry());
		const details = await performSearch(config(), request, undefined, undefined, undefined, {
			...(native.entry ? { nativeEntry: native.entry } : {}),
			nativeStatus: native.status,
		});
		expect(urls).toEqual(["https://chatgpt.com/backend-api/codex/responses", "https://api.exa.ai/search"]);
		expect(details).toMatchObject({ stage: "fallback", provider: "exa" });
		expect(details.attempts?.[0]).toMatchObject({ stage: "native", provider: "openai-codex", failureKind: "quota" });
	});
});
