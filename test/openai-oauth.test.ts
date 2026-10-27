import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNativeRoute } from "../src/websearch/native.js";
import { buildSearchRequest } from "../src/websearch/providers.js";
import { performProviderSearch } from "../src/websearch/search.js";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;
const request = { query: "current docs", maxResults: 5 };
const endpoint = "https://api.openai.com/v1/responses";

describe("OpenAI ChatGPT OAuth Responses transport", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("#given subscription auth at OpenAI #when searching #then retains endpoint and auth and decodes streamed sources", async () => {
		const route = await resolveNativeRoute(
			{ provider: "openai", api: "openai-responses", id: "model-alias", baseUrl: "https://api.openai.com/v1" },
			{
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: token };
				},
			},
		);
		expect(route.entry?.provider).toBe("openai");
		if (!route.entry) throw new Error("Missing native entry");
		const fetchMock = vi.fn(
			async () =>
				new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "web_search_call", action: { sources: [{ url: "https://example.com/docs" }] } }] } })}\n\n`,
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const built = buildSearchRequest(route.entry, request);
		expect(built.url).toBe(endpoint);
		expect(built.init.headers["Authorization"]).toBe(`Bearer ${token}`);
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
	});

	it("#given overridden credentials #when building #then uses only the effective bearer identity", () => {
		const ordinary = buildSearchRequest(
			{ provider: "openai", apiKey: token, headers: { authorization: "Bearer sk-api-key" } },
			request,
		);
		expect(ordinary.responseFormat).toBeUndefined();
		expect(typeof ordinary.body?.["input"]).toBe("string");
		const subscription = buildSearchRequest(
			{ provider: "openai", apiKey: "sk-api-key", headers: { authorization: `Bearer ${token}` } },
			request,
		);
		expect(subscription.body).toMatchObject({ stream: true, store: false });
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
