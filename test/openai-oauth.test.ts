import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNativeRoute } from "../src/websearch/native.js";
import { buildSearchRequest } from "../src/websearch/providers.js";
import { performProviderSearch } from "../src/websearch/search.js";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;
const request = { query: "current docs", maxResults: 5 };
const endpoint = "https://api.openai.com/v1/responses";

describe("OpenAI ChatGPT OAuth Responses transport", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		token,
		"opaque-oauth-token",
		`test.${Buffer.from(JSON.stringify({ sub: "user" })).toString("base64url")}.signature`,
	])(
		"#given credential %s without required account metadata #when searching #then retains endpoint and auth and decodes streamed sources",
		async (credential) => {
			const route = await resolveNativeRoute(
				{ provider: "openai", api: "openai-responses", id: "model-alias", baseUrl: "https://api.openai.com/v1" },
				{
					async getApiKeyAndHeaders() {
						return { ok: true, apiKey: credential };
					},
				},
			);
			expect(route.entry?.provider).toBe("openai");
			if (!route.entry) throw new Error("Missing native entry");
			const fetchMock = vi.fn(
				async (_url: string, _init?: RequestInit) =>
					new Response(
						`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "web_search_call", action: { sources: [{ url: "https://example.com/docs" }] } }] } })}\n\n`,
					),
			);
			vi.stubGlobal("fetch", fetchMock);
			const built = buildSearchRequest(route.entry, request);
			expect(built.url).toBe(endpoint);
			expect(built.init.headers["Authorization"]).toBe(`Bearer ${credential}`);
			expect(built.init.headers).not.toHaveProperty("chatgpt-account-id");
			expect(built.body).toMatchObject({
				store: false,
				stream: true,
				input: [{ role: "user", content: [{ type: "input_text", text: expect.stringContaining(request.query) }] }],
			});
			const result = await performProviderSearch(route.entry, request);
			expect(result.error).toBeUndefined();
			expect(result.results.map((item) => item.url)).toEqual(["https://example.com/docs"]);
			expect(fetchMock.mock.calls).toHaveLength(1);
			expect(fetchMock.mock.calls[0]?.[0]).toBe(endpoint);
			expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject(built.body ?? {});
			expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${credential}`);
		},
	);

	it("#given overridden credentials #when building #then uses only the effective bearer identity", () => {
		const ordinary = buildSearchRequest(
			{ provider: "openai", apiKey: token, headers: { authorization: "Bearer sk-api-key" } },
			request,
		);
		expect(ordinary.responseFormat).toBe("responses-sse");
		expect(Array.isArray(ordinary.body?.["input"])).toBe(true);
		expect(ordinary.init.headers["authorization"]).toBe("Bearer sk-api-key");
		const subscription = buildSearchRequest(
			{ provider: "openai", apiKey: "sk-api-key", headers: { authorization: "Bearer opaque-oauth-token" } },
			request,
		);
		expect(subscription.body).toMatchObject({ stream: true, store: false });
		expect(subscription.init.headers["authorization"]).toBe("Bearer opaque-oauth-token");
	});

	it("#given an opaque token with account header #when building #then streams without changing the configured endpoint", () => {
		const built = buildSearchRequest(
			{
				provider: "openai",
				apiKey: "opaque",
				baseUrl: "https://gateway.example/responses",
				headers: { "chatgpt-account-id": "account", accept: "application/json" },
			},
			request,
		);
		expect(built.url).toBe("https://gateway.example/responses");
		expect(built.init.headers["Accept"]).toBe("text/event-stream");
		expect(built.init.headers).not.toHaveProperty("accept");
		expect(built.body?.["stream"]).toBe(true);
	});

	it.each(["completed", "incomplete", "failed", "in_progress"])(
		"#given explicit JSON status %s #when searching #then accepts only completed sources",
		async (status) => {
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify({
							status,
							output: [{ type: "web_search_call", action: { sources: [{ url: "https://example.com/docs" }] } }],
						}),
						{ headers: { "Content-Type": "application/json; charset=utf-8" } },
					),
			);
			const result = await performProviderSearch({ provider: "openai", apiKey: "opaque-oauth-token" }, request);
			expect(result.results.length).toBe(status === "completed" ? 1 : 0);
		},
	);

	it("#given a truncated subscription stream #when searching #then returns no partial sources", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					'data: {"type":"response.output_item.done","item":{"type":"web_search_call","action":{"sources":[{"url":"https://example.com"}]}}}\n\n',
				),
		);
		const result = await performProviderSearch({ provider: "openai", apiKey: token }, request);
		expect(result.results).toEqual([]);
		expect(result.error).toBeDefined();
	});
});
