import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSearchText, performProviderSearch, performSearch } from "../src/websearch/search.js";

const answer =
	"Node.js supports fetch without a flag since v18. See [documentation](https://nodejs.org/api/globals.html#fetch).";
const payload = {
	status: "completed",
	output: [
		{
			type: "web_search_call",
			action: {
				sources: [
					{ title: "Globals", url: "https://nodejs.org/api/globals.html#fetch" },
					{ title: "Node 18", url: "https://nodejs.org/en/blog/release/v18.0.0" },
				],
			},
		},
		{
			type: "message",
			content: [
				{
					type: "output_text",
					text: answer,
					annotations: [
						{ type: "url_citation", title: "Globals", url: "https://nodejs.org/api/globals.html#fetch" },
					],
				},
			],
		},
	],
};
const request = { query: "When did Node.js enable fetch without a flag?", maxResults: 5 };
function mockResponse(value: object = payload) {
	vi.stubGlobal(
		"fetch",
		async () => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }),
	);
}

describe("Responses answer and sources", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		"Claim [source](HTTPS://blocked.example/source)",
		"According to https://blocked.example, the answer is 18.",
		"See `https://blocked.example` for details.",
		"See https://blocked.example. Next sentence.",
		"依据：https://blocked.example，版本18。",
	])("#given blocked link in prose %s #when validating #then rejects the answer", async (text) => {
		mockResponse({
			status: "completed",
			output: [
				{ type: "web_search_call", action: { sources: [{ url: "https://allowed.example/source" }] } },
				{ type: "message", content: [{ type: "output_text", text }] },
			],
		});
		const details = await performProviderSearch(
			{ provider: "openai", apiKey: "test-secret", blockedDomains: ["blocked.example"] },
			request,
		);
		expect(details.error).toContain("mixed-source synthesis");
		expect(details.answer).toBeUndefined();
	});

	it.each(["See `https://allowed.example` for details.", "See HTTPS://allowed.example, then continue."])(
		"#given allowed prose link %s #when validating #then preserves the answer",
		async (text) => {
			mockResponse({
				status: "completed",
				output: [
					{ type: "web_search_call", action: { sources: [{ url: "https://allowed.example/source" }] } },
					{ type: "message", content: [{ type: "output_text", text }] },
				],
			});
			const details = await performProviderSearch(
				{ provider: "openai", apiKey: "test-secret", allowedDomains: ["allowed.example"] },
				request,
			);
			expect(details.error).toBeUndefined();
			expect(details.answer).toBe(text);
		},
	);

	it.each(["", "   "])("#given source title %j #when normalizing #then retains its valid URL", async (title) => {
		mockResponse({
			status: "completed",
			output: [{ type: "web_search_call", action: { sources: [{ title, url: "https://nodejs.org/docs" }] } }],
		});
		const details = await performProviderSearch({ provider: "openai", apiKey: "test-secret" }, request);
		expect(details.error).toBeUndefined();
		expect(details.results).toEqual([{ title: "https://nodejs.org/docs", url: "https://nodejs.org/docs" }]);
	});

	it("#given same streamed message ID with reordered keys #when completed #then keeps terminal answer once", async () => {
		const content = [{ type: "output_text", text: answer }];
		const done = { id: "msg1", type: "message", content };
		const terminal = { content, type: "message", id: "msg1" };
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					[
						{ type: "response.output_item.done", item: done },
						{
							type: "response.completed",
							response: { status: "completed", output: [payload.output[0], terminal] },
						},
					]
						.map((event) => `data: ${JSON.stringify(event)}\n\n`)
						.join(""),
					{ headers: { "Content-Type": "text/event-stream" } },
				),
		);
		const details = await performProviderSearch({ provider: "openai", apiKey: "test-secret" }, request);
		expect(details.answer).toBe(answer);
	});

	it.each([{ blockedDomains: ["nodejs.org"] }, { allowedDomains: ["allowed.example"] }])(
		"#given mixed sources and policy %j #when searching #then rejects contaminated answer",
		async (policy) => {
			mockResponse({
				...payload,
				output: [
					...payload.output,
					{ type: "web_search_call", action: { sources: [{ url: "https://allowed.example/source" }] } },
				],
			});
			const details = await performProviderSearch({ provider: "openai", apiKey: "test-secret", ...policy }, request);
			expect(details.error).toContain("mixed-source synthesis");
			expect(details.answer).toBeUndefined();
			expect(details.results).toEqual([]);
		},
	);

	it("#given unlisted blocked citation in answer #when searching #then does not leak it through text", async () => {
		mockResponse({
			status: "completed",
			output: [
				{ type: "web_search_call", action: { sources: [{ url: "https://allowed.example/source" }] } },
				{ type: "message", content: [{ type: "output_text", text: "Claim [source](https://blocked.example)" }] },
			],
		});
		const details = await performProviderSearch(
			{ provider: "openai", apiKey: "test-secret", blockedDomains: ["blocked.example"] },
			request,
		);
		expect(details.error).toContain("mixed-source synthesis");
		expect(formatSearchText(details)).not.toContain("https://blocked.example");
	});

	it.each(["openai", "codex", "xai"] as const)(
		"#given %s search evidence #when formatting #then preserves useful answer once and separate source titles",
		async (provider) => {
			mockResponse();
			const details = await performProviderSearch({ provider, apiKey: "test-secret" }, request);
			expect(details.error).toBeUndefined();
			expect(details.answer).toBe(answer);
			expect(details.results).toHaveLength(2);
			expect(details.results.map((item) => item.title)).toEqual(["Globals", "Node 18"]);
			expect(details.results.every((item) => item.snippet === undefined)).toBe(true);
			const text = formatSearchText(details);
			expect(text.split(answer)).toHaveLength(2);
			expect(text).toContain("Sources:");
		},
	);

	it("#given answer without structured sources #when searching #then does not treat prose as successful search", async () => {
		mockResponse({
			status: "completed",
			output: [{ type: "message", content: [{ type: "output_text", text: answer }] }],
		});
		const details = await performProviderSearch({ provider: "openai", apiKey: "test-secret" }, request);
		expect(details.error).toBeDefined();
		expect(details.answer).toBeUndefined();
	});

	it("#given credential in answer #when returning #then redacts it", async () => {
		mockResponse({
			...payload,
			output: [...payload.output, { type: "message", content: [{ type: "output_text", text: "test-secret" }] }],
		});
		const details = await performProviderSearch({ provider: "openai", apiKey: "test-secret" }, request);
		expect(details.answer).toContain("[redacted]");
		expect(JSON.stringify(details)).not.toContain("test-secret");
	});

	it("#given fill-first routing #when aggregating #then retains the answer rather than dropping it", async () => {
		mockResponse();
		const details = await performSearch(
			{
				auto: false,
				strategy: "fill-first",
				fallback: true,
				providers: [{ provider: "openai", apiKey: "test-secret" }],
			},
			request,
		);
		expect(details.error).toBeUndefined();
		expect(details.answer).toContain(answer);
		expect(formatSearchText(details).split(answer)).toHaveLength(2);
	});
});
