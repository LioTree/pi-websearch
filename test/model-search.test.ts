import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSearchRequest } from "../src/websearch/providers.js";
import { formatSearchText, performProviderSearch } from "../src/websearch/search.js";
import type { SearchProviderEntry } from "../src/websearch/types.js";

const instructions =
	"Search the web and return a concise answer grounded only in the web results.\nInclude clickable source citations in the response text when possible.";
const query = "When was fetch stable in Node.js?";
const answer = "Node.js fetch became stable in v21.0.0. [Docs](https://nodejs.org/api/globals.html#fetch)";
const source = { title: "Globals", url: "https://nodejs.org/api/globals.html#fetch" };
const entries = [
	{ provider: "openai", apiKey: "test-key" },
	{ provider: "codex", apiKey: "test-key" },
	{ provider: "openai-codex", apiKey: "test-key", headers: { "chatgpt-account-id": "test-account" } },
	{ provider: "anthropic", apiKey: "test-key" },
	{ provider: "anthropic", apiKey: "sk-ant-oat-test-key" },
	{ provider: "xai", apiKey: "test-key" },
	{ provider: "perplexity", apiKey: "test-key", model: "sonar" },
	{ provider: "z-ai", apiKey: "test-key", model: "glm" },
] as const satisfies readonly SearchProviderEntry[];
const cases = [
	{
		entry: entries[3],
		payload: {
			content: [
				{ type: "text", text: answer },
				{ type: "web_search_tool_result", content: [{ type: "web_search_result", ...source }] },
			],
		},
	},
	{ entry: entries[6], payload: { choices: [{ message: { content: answer } }], citations: [source.url] } },
	{
		entry: entries[7],
		payload: {
			choices: [{ message: { content: answer } }],
			web_search: [{ title: source.title, link: source.url, content: "Actual page excerpt" }],
		},
	},
];

describe("Unified model search", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("#given numbered brackets in code and Markdown URLs #when preserving Perplexity citations #then never rewrites the body", async () => {
		const body =
			"Use `const second = values[1];` or:\n```js\nconst second = values[1];\n```\nDocs [parameters](https://nodejs.org/search?ids[1]=1). Evidence [1].";
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						search_results: [source],
						citations: [source.url],
						choices: [{ message: { content: body } }],
					}),
				),
		);
		const details = await performProviderSearch(entries[6], { query, maxResults: 5 });
		expect(details.error).toBeUndefined();
		expect(details.answer).toBe(`${body}\n\nCitation mapping (provider indices): [1](${source.url})`);
	});

	it("#given Anthropic native citations in reversed source order #when executing #then preserves each claim's link", async () => {
		const second = { title: "Second", url: "https://nodejs.org/second" };
		const payload = {
			content: [
				{ type: "web_search_tool_result", content: [source, second] },
				{ type: "text", text: "First claim.", citations: [{ type: "web_search_result_location", ...second }] },
				{ type: "text", text: "Second claim.", citations: [{ type: "web_search_result_location", ...source }] },
			],
		};
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload)));
		const details = await performProviderSearch(entries[3], { query, maxResults: 5 });
		expect(details.error).toBeUndefined();
		expect(details.answer).toBe(`First claim. [source](${second.url})\nSecond claim. [source](${source.url})`);
		expect(details.results).toHaveLength(2);
	});

	it("#given Perplexity numbered citations differing from source order #when executing #then maps claims to correct URLs and retains page snippets", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						search_results: [{ ...source, snippet: "Page excerpt" }],
						citations: ["https://nodejs.org/other", source.url],
						choices: [{ message: { content: "First [1]. Second [2]." } }],
					}),
				),
		);
		const details = await performProviderSearch(entries[6], { query, maxResults: 5 });
		expect(details.error).toBeUndefined();
		expect(details.answer).toBe(
			`First [1]. Second [2].\n\nCitation mapping (provider indices): [1](https://nodejs.org/other) [2](${source.url})`,
		);
		expect(details.results).toHaveLength(2);
		expect(details.results[0]?.snippet).toBe("Page excerpt");
	});

	it.each(["anthropic", "perplexity"] as const)(
		"#given %s blocked native citation absent from allowed page list #when executing #then rejects mixed answer",
		async (provider) => {
			const blocked = "https://blocked.example/cited";
			const payload =
				provider === "anthropic"
					? {
							content: [
								{ type: "web_search_tool_result", content: [source] },
								{
									type: "text",
									text: "Blocked claim.",
									citations: [{ type: "web_search_result_location", url: blocked, title: "Blocked" }],
								},
							],
						}
					: {
							search_results: [{ ...source, snippet: "Allowed excerpt" }],
							citations: [blocked],
							choices: [{ message: { content: "Blocked claim [1]." } }],
						};
			vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload)));
			const details = await performProviderSearch(
				{ provider, model: "test", apiKey: "test-key", blockedDomains: ["blocked.example"] },
				{ query, maxResults: 5 },
			);
			expect(details.error).toBeDefined();
			expect(details.answer).toBeUndefined();
		},
	);

	it("#given an excluded Perplexity citation after 50 allowed URLs #when executing #then checks evidence before result cap", async () => {
		const payload = {
			search_results: [source],
			citations: [
				...Array.from({ length: 50 }, (_, i) => `https://nodejs.org/${i}`),
				"https://blocked.example/cited",
			],
			choices: [{ message: { content: "Answer based on all sources." } }],
		};
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload)));
		const details = await performProviderSearch(
			{ ...entries[6], blockedDomains: ["blocked.example"] },
			{ query, maxResults: 5 },
		);
		expect(details.error).toBeDefined();
		expect(details.answer).toBeUndefined();
	});

	it.each(entries)(
		"#given $provider model search #when constructing #then sends shared instructions once and keeps user query",
		(entry) => {
			const body = buildSearchRequest(entry, { query, maxResults: 5 }).body;
			expect(JSON.stringify(body).split(JSON.stringify(instructions).slice(1, -1))).toHaveLength(2);
			expect(JSON.stringify(body)).toContain(query);
			expect(JSON.stringify(body)).not.toContain("Return only relevant source URLs");
		},
	);

	it.each(cases)(
		"#given $entry.provider answer with sources #when executing #then returns answer once separately",
		async ({ entry, payload }) => {
			vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload)));
			const details = await performProviderSearch(entry, { query, maxResults: 5 });
			expect(details.error).toBeUndefined();
			expect(details.answer).toBe(
				entry.provider === "perplexity"
					? `${answer}\n\nCitation mapping (provider indices): [1](${source.url})`
					: answer,
			);
			expect(details.results[0]?.url).toBe(source.url);
			expect(details.results.every((item) => item.snippet !== answer)).toBe(true);
			if (entry.provider === "z-ai") expect(details.results[0]?.snippet).toBe("Actual page excerpt");
			expect(formatSearchText(details).split(answer)).toHaveLength(2);
		},
	);

	it.each(cases)(
		"#given $entry.provider excluded answer source #when executing #then does not leak answer",
		async ({ entry, payload }) => {
			vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload)));
			const details = await performProviderSearch(
				{ ...entry, blockedDomains: ["nodejs.org"] },
				{ query, maxResults: 5 },
			);
			expect(details.error).toBeDefined();
			expect(details.answer).toBeUndefined();
		},
	);

	it.each(["anthropic", "perplexity", "z-ai"] as const)(
		"#given %s prose without sources #when executing #then does not claim successful search",
		async (provider) => {
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify({
							content: [{ type: "text", text: answer }],
							choices: [{ message: { content: answer } }],
						}),
					),
			);
			const details = await performProviderSearch(
				{ provider, apiKey: "test-key", model: "test" },
				{ query, maxResults: 5 },
			);
			expect(details.error).toBeDefined();
			expect(details.answer).toBeUndefined();
		},
	);

	it.each(["perplexity", "z-ai"] as const)(
		"#given %s direct search #when executing #then leaves model instructions and answer disabled",
		async (provider) => {
			const entry = { provider, apiKey: "test-key" };
			const body = buildSearchRequest(entry, { query, maxResults: 5 }).body;
			expect(body).not.toHaveProperty("messages");
			expect(body).not.toHaveProperty("instructions");
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify({
							results: [{ ...source, snippet: "Page excerpt" }],
							search_result: [{ title: source.title, link: source.url, content: "Page excerpt" }],
							choices: [{ message: { content: answer } }],
						}),
					),
			);
			const details = await performProviderSearch(entry, { query, maxResults: 5 });
			expect(details.error).toBeUndefined();
			expect(details.answer).toBeUndefined();
			expect(details.results[0]?.snippet).toBe("Page excerpt");
		},
	);
});
