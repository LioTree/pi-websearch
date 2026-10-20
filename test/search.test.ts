import { afterEach, describe, expect, it, vi } from "vitest";

import {
	canonicalDomain,
	domainWithin,
	EmptyDomainPolicyError,
	isHostAllowedByPolicy,
	mergeDomainFilters,
} from "../src/websearch/domains.js";
import {
	createSearchRoutingState,
	effectiveDomainFilters,
	effectiveMaxResults,
	formatSearchText,
	performProviderSearch,
	performSearch,
} from "../src/websearch/search.js";
import type { NativeRouteStatus, SearchProviderEntry, WebsearchConfig } from "../src/websearch/types.js";

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

function config(providers: SearchProviderEntry[], overrides: Partial<WebsearchConfig> = {}): WebsearchConfig {
	return {
		strategy: "priority",
		fallback: true,
		auto: true,
		providers,
		...overrides,
	};
}

function nativeEntry(overrides: Partial<SearchProviderEntry> = {}): SearchProviderEntry {
	return {
		id: "native",
		provider: "openai",
		apiKey: "native-secret",
		baseUrl: "https://native.example.com/v1/responses",
		model: "gpt-5.5",
		...overrides,
	};
}

const nativeReady: NativeRouteStatus = {
	status: "ready",
	provider: "openai",
	model: "gpt-5.5",
	adapter: "openai",
};

describe("performSearch routing", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("#given native and configured providers #when native succeeds #then returns native without touching fallback", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			urls.push(String(input));
			return jsonResponse({
				output: [{ type: "web_search_call", action: { sources: [{ url: "https://native.example" }] } }],
			});
		});
		const cfg = config([{ id: "backup", provider: "exa", baseUrl: "https://exa.example.com" }]);

		// when
		const details = await performSearch(cfg, { query: "native", maxResults: 5 }, undefined, undefined, undefined, {
			nativeEntry: nativeEntry(),
			nativeStatus: nativeReady,
			mode: "normal",
		});

		// then
		expect(urls).toEqual(["https://native.example.com/v1/responses"]);
		expect(details.stage).toBe("native");
		expect(details.strategy).toBe("priority");
		expect(details.native?.status).toBe("ready");
		expect(details.attempts).toEqual([
			expect.objectContaining({ provider: "openai", entryId: "native", stage: "native", resultsCount: 1 }),
		]);
	});

	it.each(["priority", "round-robin", "fill-first"] as const)(
		"#given %s strategy #when native succeeds #then returns native without consuming strategy state",
		async (strategy) => {
			// given
			const urls: string[] = [];
			vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
				urls.push(String(input));
				return jsonResponse({
					output: [{ type: "web_search_call", action: { sources: [{ url: "https://native.example" }] } }],
				});
			});
			const cfg = config(
				[
					{ id: "one", provider: "exa", baseUrl: "https://one.example.com" },
					{ id: "two", provider: "exa", baseUrl: "https://two.example.com" },
				],
				{ strategy },
			);

			// when
			const details = await performSearch(cfg, { query: "native", maxResults: 2 }, undefined, undefined, undefined, {
				nativeEntry: nativeEntry(),
				nativeStatus: nativeReady,
			});

			// then
			expect(urls).toEqual(["https://native.example.com/v1/responses"]);
			expect(details.stage).toBe("native");
			expect(details.attempts?.map((attempt) => attempt.stage)).toEqual(["native"]);

			if (strategy === "round-robin") {
				// A native success must not consume the configured chain's rotation.
				vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
					const url = String(input);
					urls.push(url);
					if (url.includes("native")) return jsonResponse({ error: "down" }, 503);
					return jsonResponse(exaResults("https://one.example.com/result"));
				});
				await performSearch(
					cfg,
					{ query: "native", maxResults: 2 },
					undefined,
					createSearchRoutingState(2),
					undefined,
					{
						nativeEntry: nativeEntry(),
						nativeStatus: nativeReady,
					},
				);
				expect(urls.at(-1)).toBe("https://one.example.com");
			}
		},
	);

	it.each(["priority", "round-robin", "fill-first"] as const)(
		"#given %s strategy #when native fails with fallback disabled #then still tries the configured chain",
		async (strategy) => {
			// given
			const urls: string[] = [];
			vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				urls.push(url);
				if (url.includes("native")) return jsonResponse({ error: "down" }, 503);
				return jsonResponse(exaResults("https://fallback.example.com"));
			});
			const cfg = config(
				[
					{ id: "one", provider: "exa", baseUrl: "https://one.example.com" },
					{ id: "two", provider: "exa", baseUrl: "https://two.example.com" },
				],
				{ strategy, fallback: false },
			);

			// when
			const details = await performSearch(
				cfg,
				{ query: "fallback", maxResults: 2 },
				undefined,
				undefined,
				undefined,
				{
					nativeEntry: nativeEntry(),
					nativeStatus: nativeReady,
					mode: "normal",
				},
			);

			// then
			expect(urls[0]).toContain("native.example.com");
			expect(urls[1]).toBe("https://one.example.com");
			expect(details.stage).toBe("fallback");
			expect(details.native?.status).toBe("skipped");
			expect(details.attempts?.[0]).toMatchObject({ stage: "native", failureKind: "network" });
			expect(details.attempts?.[1]).toMatchObject({ stage: "fallback", resultsCount: 1 });
		},
	);

	it("#given round robin #when native fails on consecutive calls #then native is attempted first every time", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.includes("native")) return jsonResponse({ error: "down" }, 503);
			return jsonResponse(exaResults(`https://${url.includes("one") ? "one" : "two"}.example.com/result`));
		});
		const cfg = config(
			[
				{ id: "one", provider: "exa", baseUrl: "https://one.example.com" },
				{ id: "two", provider: "exa", baseUrl: "https://two.example.com" },
			],
			{ strategy: "round-robin", fallback: false },
		);
		const state = createSearchRoutingState(cfg.providers.length);

		// when
		const first = await performSearch(cfg, { query: "rr", maxResults: 1 }, undefined, state, undefined, {
			nativeEntry: nativeEntry(),
			nativeStatus: nativeReady,
		});
		const second = await performSearch(cfg, { query: "rr", maxResults: 1 }, undefined, state, undefined, {
			nativeEntry: nativeEntry(),
			nativeStatus: nativeReady,
		});

		// then
		expect(urls).toEqual([
			"https://native.example.com/v1/responses",
			"https://one.example.com",
			"https://native.example.com/v1/responses",
			"https://two.example.com",
		]);
		expect(first.entryId).toBe("one");
		expect(second.entryId).toBe("two");
	});

	it("#given fill-first and a trailing failure #when merging #then attributes results to the first successful provider", async () => {
		// given
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.includes("one")) return jsonResponse(exaResults("https://shared.example.com"));
			return jsonResponse({ error: "down" }, 503);
		});
		const cfg = config(
			[
				{ id: "one", provider: "exa", baseUrl: "https://one.example.com" },
				{ id: "two", provider: "exa", baseUrl: "https://two.example.com" },
			],
			{ strategy: "fill-first" },
		);

		// when
		const details = await performSearch(cfg, { query: "fill", maxResults: 2 });

		// then
		expect(details.provider).toBe("exa");
		expect(details.entryId).toBe("one");
		expect(details.error).toBeUndefined();
		expect(details.attempts?.map((attempt) => `${attempt.entryId}:${attempt.error ? "fail" : "ok"}`)).toEqual([
			"one:ok",
			"two:fail",
		]);
	});

	it("#given global max results #when native and entry limits differ #then output never exceeds the global limit or entry limit", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => {
			return jsonResponse(exaResults("https://a.example.com", "https://b.example.com", "https://c.example.com"));
		});

		// when
		const native = await performSearch(
			config([{ id: "backup", provider: "exa", baseUrl: "https://exa.example.com" }], { maxResults: 2 }),
			{ query: "limit", maxResults: 10 },
			undefined,
			undefined,
			undefined,
			{ nativeEntry: nativeEntry(), nativeStatus: nativeReady },
		);
		const entryLimited = await performSearch(
			config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com", maxResults: 1 }], { maxResults: 3 }),
			{ query: "limit", maxResults: 10 },
		);

		// then
		expect(native.results).toHaveLength(2);
		expect(native.truncated).toBe(true);
		expect(entryLimited.results).toHaveLength(1);
	});

	it("#given global allowed domains #when request and entry narrow them #then provider policy cannot bypass the global intersection", async () => {
		// given
		const bodies: string[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			bodies.push(String(init?.body ?? ""));
			return jsonResponse(exaResults("https://a.example.com/result"));
		});
		const cfg = config(
			[
				{ id: "one", provider: "exa", baseUrl: "https://one.example.com", allowedDomains: ["b.example.com"] },
				{ id: "two", provider: "exa", baseUrl: "https://two.example.com" },
			],
			{ allowedDomains: ["a.example.com"] },
		);

		// when
		const details = await performSearch(cfg, {
			query: "domains",
			maxResults: 1,
			allowedDomains: ["a.example.com", "b.example.com"],
		});

		// then
		expect(details.entryId).toBe("two");
		expect(bodies).toHaveLength(1);
		expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ includeDomains: ["a.example.com"] });
		expect(details.attempts?.map((attempt) => [attempt.entryId, attempt.failureKind])).toEqual([
			["one", "no-results"],
			["two", undefined],
		]);
	});

	it("#given global blocked domains and entry allowed domains #when searching #then global blocks still apply", async () => {
		// given
		const bodies: string[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			bodies.push(String(init?.body ?? ""));
			return jsonResponse(exaResults("https://a.example.com/result"));
		});
		const cfg = config(
			[
				{
					id: "one",
					provider: "exa",
					baseUrl: "https://one.example.com",
					allowedDomains: ["a.example.com", "b.example.com"],
				},
			],
			{ blockedDomains: ["b.example.com"] },
		);

		// when
		await performSearch(cfg, { query: "blocked", maxResults: 1 });

		// then
		expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ includeDomains: ["a.example.com"] });
	});

	it("#given invalid JSON on 2xx #when searching #then reports invalid-response rather than no-results", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => new Response("not json", { status: 200 }));
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], { fallback: false });

		// when
		const details = await performSearch(cfg, { query: "parse", maxResults: 1 });

		// then
		expect(details.failureKind).toBe("invalid-response");
		expect(details.results).toHaveLength(0);
	});

	it("#given valid empty JSON #when searching #then reports no-results", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => jsonResponse({}));
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], { fallback: false });

		// when
		const details = await performSearch(cfg, { query: "empty", maxResults: 1 });

		// then
		expect(details.failureKind).toBe("no-results");
	});

	it("#given a prose URL in a Responses answer #when normalizing #then does not fabricate a source", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				jsonResponse({
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "I could not search, but see https://fake.example.com" }],
						},
					],
				}),
		);
		const cfg = config(
			[{ id: "openai", provider: "openai", apiKey: "test", baseUrl: "https://openai.example.com/v1" }],
			{
				fallback: false,
			},
		);

		// when
		const details = await performSearch(cfg, { query: "prose", maxResults: 1 });

		// then
		expect(details.results).toEqual([]);
		expect(details.results.some((item) => item.url.includes("fake.example.com"))).toBe(false);
	});

	it("#given HTTP 400 without an explicit tool marker #when searching #then does not classify it as unsupported", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => jsonResponse({ error: "bad request" }, 400));
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], { fallback: false });

		// when
		const details = await performSearch(cfg, { query: "400", maxResults: 1 });

		// then
		expect(details.failureKind).toBe("request");
		expect(details.httpStatus).toBe(400);
	});

	it("#given HTTP 400 with an explicit search tool marker #when searching #then classifies it as unsupported", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> => jsonResponse({ error: "web_search tool is not supported for this model" }, 400),
		);
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], { fallback: false });

		// when
		const details = await performSearch(cfg, { query: "unsupported", maxResults: 1 });

		// then
		expect(details.failureKind).toBe("unsupported");
	});

	it("#given HTTP 404 without an explicit marker #when searching #then stays a request failure", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => jsonResponse({ error: "not found" }, 404));
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], { fallback: false });

		// when
		const details = await performSearch(cfg, { query: "404", maxResults: 1 });

		// then
		expect(details.failureKind).toBe("request");
	});

	it("#given an error body echoing secrets #when searching #then sanitizes the error and all attempts", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				new Response(
					JSON.stringify({
						error: {
							message: "bad key supersecret at https://api.example.com/?token=abc123",
						},
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				),
		);
		const cfg = config([{ id: "one", provider: "exa", apiKey: "supersecret", baseUrl: "https://one.example.com" }], {
			fallback: false,
		});

		// when
		const details = await performSearch(cfg, { query: "secret", maxResults: 1 });

		// then
		expect(details.error).not.toContain("supersecret");
		expect(details.error).not.toContain("abc123");
		expect(details.attempts?.[0]?.error).not.toContain("supersecret");
		expect(details.attempts?.[0]?.error).not.toContain("abc123");
		expect(details.failureKind).toBe("auth");
	});

	it("#given a result URL with a token query #when searching #then returns a redacted URL", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> => jsonResponse(exaResults("https://example.com/page?token=secretvalue&q=keep")),
		);
		const cfg = config([{ id: "one", provider: "exa", apiKey: "secretvalue", baseUrl: "https://one.example.com" }]);

		// when
		const details = await performSearch(cfg, { query: "url", maxResults: 1 });

		// then
		expect(details.results[0]?.url).not.toContain("secretvalue");
		expect(details.results[0]?.url).toContain("redacted");
	});

	it("#given a global allowed parent and a case-varied entry subdomain #when searching #then the entry narrows to the subdomain", async () => {
		// given
		const bodies: string[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			bodies.push(String(init?.body ?? ""));
			return jsonResponse(exaResults("https://docs.example.com/result"));
		});
		const cfg = config(
			[
				{
					id: "one",
					provider: "exa",
					baseUrl: "https://one.example.com",
					allowedDomains: [" Docs.Example.COM. "],
				},
			],
			{ allowedDomains: ["Example.COM."], fallback: false },
		);

		// when
		const details = await performSearch(cfg, { query: "nested allowed", maxResults: 1 });

		// then
		expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ includeDomains: ["docs.example.com"] });
		expect(details.results.map((item) => item.url)).toEqual(["https://docs.example.com/result"]);
	});

	it("#given a blocked parent and an allowed child entry #when searching #then skips the entry without fetching", async () => {
		// given
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const cfg = config(
			[
				{
					id: "one",
					provider: "exa",
					baseUrl: "https://one.example.com",
					allowedDomains: ["docs.example.com"],
				},
			],
			{ blockedDomains: ["Example.COM."], fallback: false },
		);

		// when
		const details = await performSearch(cfg, { query: "blocked parent", maxResults: 1 });

		// then
		expect(fetchMock).not.toHaveBeenCalled();
		expect(details.failureKind).toBe("no-results");
		expect(details.error).toContain("excludes every source");
	});

	it("#given conflicting global and entry allowed domains #when searching #then no fetch and no-results", async () => {
		// given
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const cfg = config(
			[
				{
					id: "one",
					provider: "exa",
					baseUrl: "https://one.example.com",
					allowedDomains: ["b.example.com"],
				},
			],
			{ allowedDomains: ["a.example.com"], fallback: false },
		);

		// when
		const details = await performSearch(cfg, { query: "disjoint", maxResults: 1 });

		// then
		expect(fetchMock).not.toHaveBeenCalled();
		expect(details.failureKind).toBe("no-results");
		expect(details.error).toContain("allowed: (none)");
	});

	it("#given allowed parent with blocked child #when results span both #then the parent remains allowed and the child is postfiltered", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				jsonResponse(
					exaResults("https://sub.example.com/x", "https://other.example.com/y", "https://attackerexample.com/z"),
				),
		);
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], {
			allowedDomains: ["example.com"],
			blockedDomains: ["sub.example.com"],
			fallback: false,
		});

		// when
		const details = await performSearch(cfg, { query: "allow block", maxResults: 5 });

		// then
		expect(details.results.map((item) => item.url)).toEqual(["https://other.example.com/y"]);
	});

	it("#given benign docs metadata and credential-like headers #when successful #then only actual credentials are redacted", async () => {
		// given
		const benignUrl = "https://docs.example.com/page?key=configuration";
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				jsonResponse({
					results: [
						{
							title: "User-Agent docs-agent/1.0",
							url: benignUrl,
							text: "Bearer wording is benign; docs-agent/1.0",
						},
						{
							title: "actual-secret",
							url: "https://docs.example.com/page?key=actual-secret",
							text: "actual-secret",
						},
					],
				}),
		);
		const cfg = config([
			{
				id: "one",
				provider: "exa",
				apiKey: "actual-secret",
				baseUrl: "https://one.example.com",
				headers: { Authorization: "Bearer actual-secret", "User-Agent": "docs-agent/1.0" },
			},
		]);

		// when
		const details = await performSearch(cfg, { query: "benign metadata", maxResults: 5 });

		// then
		expect(details.results[0]).toEqual({
			title: "User-Agent docs-agent/1.0",
			url: benignUrl,
			snippet: "Bearer wording is benign; docs-agent/1.0",
		});
		expect(details.results[1]?.title).not.toContain("actual-secret");
		expect(details.results[1]?.snippet).not.toContain("actual-secret");
		expect(details.results[1]?.url).not.toContain("actual-secret");
	});

	it("#given a provider that hangs beyond the global timeout #when searching #then times out and falls through", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.includes("hang")) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				});
			}
			return Promise.resolve(jsonResponse(exaResults("https://quick.example.com")));
		});
		const cfg = config(
			[
				{ id: "hang", provider: "exa", baseUrl: "https://hang.example.com", timeoutMs: 10_000 },
				{ id: "quick", provider: "exa", baseUrl: "https://quick.example.com" },
			],
			{ timeoutMs: 50 },
		);

		// when
		const details = await performSearch(cfg, { query: "timeout", maxResults: 1 });

		// then
		expect(urls).toEqual(["https://hang.example.com", "https://quick.example.com"]);
		expect(details.entryId).toBe("quick");
		expect(details.attempts?.[0]).toMatchObject({ failureKind: "timeout" });
	});

	it("#given user abort during the native stage #when aborted #then rejects without touching fallback", async () => {
		// given
		const controller = new AbortController();
		const urls: string[] = [];
		vi.stubGlobal("fetch", (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			urls.push(String(_input));
			queueMicrotask(() => controller.abort());
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		});
		const cfg = config([{ id: "fallback", provider: "exa", baseUrl: "https://fallback.example.com" }]);

		// when / then
		await expect(
			performSearch(cfg, { query: "abort", maxResults: 1 }, controller.signal, undefined, undefined, {
				nativeEntry: nativeEntry(),
				nativeStatus: nativeReady,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(urls).toEqual(["https://native.example.com/v1/responses"]);
	});

	it("#given user abort during the configured chain #when aborted #then rejects without trying the next provider", async () => {
		// given
		const controller = new AbortController();
		let fetchCalls = 0;
		vi.stubGlobal("fetch", (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			fetchCalls += 1;
			queueMicrotask(() => controller.abort());
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		});
		const cfg = config([
			{ id: "one", provider: "exa", baseUrl: "https://one.example.com" },
			{ id: "two", provider: "exa", baseUrl: "https://two.example.com" },
		]);

		// when / then
		await expect(performSearch(cfg, { query: "abort", maxResults: 1 }, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetchCalls).toBe(1);
	});

	it("#given an already-aborted signal #when searching #then rejects before any fetch", async () => {
		// given
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }]);

		// when / then
		await expect(performSearch(cfg, { query: "aborted", maxResults: 1 }, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("#given an authenticated search request #when building the fetch options #then redirects are disabled", async () => {
		// given
		let init: RequestInit | undefined;
		vi.stubGlobal("fetch", async (_input: string | URL | Request, requestInit?: RequestInit): Promise<Response> => {
			init = requestInit;
			return jsonResponse(exaResults("https://example.com/result"));
		});
		const cfg = config([{ id: "one", provider: "exa", apiKey: "key", baseUrl: "https://one.example.com" }]);

		// when
		await performSearch(cfg, { query: "redirect", maxResults: 1 });

		// then
		expect(init?.redirect).toBe("error");
	});

	it("#given metadata that merely mentions refusal #when results are empty #then reports no-results", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> => jsonResponse({ results: [], metadata: { description: "refusal policy page" } }),
		);
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], { fallback: false });

		// when
		const details = await performSearch(cfg, { query: "refusal", maxResults: 1 });

		// then
		expect(details.failureKind).toBe("no-results");
	});

	it("#given a structured refusal field #when results are empty #then reports refusal", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => jsonResponse({ results: [], stop_reason: "refusal" }));
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], { fallback: false });

		// when
		const details = await performSearch(cfg, { query: "structured refusal", maxResults: 1 });

		// then
		expect(details.failureKind).toBe("refusal");
	});

	it.each([
		["null", "null"],
		["array", "[]"],
		["string", '"text"'],
		["number", "42"],
	])(
		"#given a JSON %s body #when a provider schema requires an object #then reports invalid-response",
		async (_label, body) => {
			// given
			vi.stubGlobal("fetch", async (): Promise<Response> => new Response(body, { status: 200 }));
			const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], { fallback: false });

			// when
			const details = await performSearch(cfg, { query: "schema", maxResults: 1 });

			// then
			expect(details.failureKind).toBe("invalid-response");
		},
	);

	it("#given secrets in result metadata and endpoint query #when returning results #then redacts metadata without truncating snippets", async () => {
		// given
		const longSnippet = `${"a".repeat(600)} api-secret header-secret endpoint-secret`;
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				jsonResponse({
					results: [
						{
							title: "Title api-secret",
							url: "https://result.example.com/page?token=endpoint-secret&q=keep",
							text: longSnippet,
						},
					],
				}),
		);
		const cfg = config([
			{
				id: "one",
				provider: "exa",
				apiKey: "api-secret",
				baseUrl: "https://one.example.com/search?token=endpoint-secret",
				headers: { Authorization: "Bearer header-secret" },
			},
		]);

		// when
		const details = await performSearch(cfg, { query: "metadata", maxResults: 1 });

		// then
		const result = details.results[0];
		expect(result?.title).not.toContain("api-secret");
		expect(result?.snippet).not.toContain("api-secret");
		expect(result?.snippet).not.toContain("header-secret");
		expect(result?.snippet).not.toContain("endpoint-secret");
		expect(result?.url).not.toContain("endpoint-secret");
		expect(result?.snippet?.length ?? 0).toBeGreaterThan(500);
	});

	it("#given bare header and endpoint secrets echoed in an error #when failing #then redacts all copies", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				new Response(JSON.stringify({ error: "bad api-secret header-secret endpoint-secret" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const cfg = config([
			{
				id: "one",
				provider: "exa",
				apiKey: "api-secret",
				baseUrl: "https://one.example.com/search?token=endpoint-secret",
				headers: { Authorization: "Bearer header-secret" },
			},
		]);

		// when
		const details = await performSearch(cfg, { query: "error secrets", maxResults: 1 });

		// then
		for (const forbidden of ["api-secret", "header-secret", "endpoint-secret"]) {
			expect(details.error).not.toContain(forbidden);
			expect(details.attempts?.[0]?.error).not.toContain(forbidden);
			expect(formatSearchText(details)).not.toContain(forbidden);
		}
	});

	it("#given an allowed host #when results include a lookalike host #then only the host and its subdomains pass", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				jsonResponse(
					exaResults("https://attackerexample.com/x", "https://sub.example.com/y", "https://example.com/z"),
				),
		);
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], {
			allowedDomains: ["example.com"],
			fallback: false,
		});

		// when
		const details = await performSearch(cfg, { query: "allowed boundary", maxResults: 5 });

		// then
		expect(details.results.map((item) => item.url)).toEqual(["https://sub.example.com/y", "https://example.com/z"]);
	});

	it("#given a blocked host #when results include its subdomain and a lookalike #then only the lookalike passes", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				jsonResponse(
					exaResults("https://sub.example.com/x", "https://attackerexample.com/y", "https://example.com/z"),
				),
		);
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], {
			blockedDomains: ["example.com"],
			fallback: false,
		});

		// when
		const details = await performSearch(cfg, { query: "blocked boundary", maxResults: 5 });

		// then
		expect(details.results.map((item) => item.url)).toEqual(["https://attackerexample.com/y"]);
	});

	it("#given global and entry allowed domains #when postfiltering #then the entry can only narrow the global set", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				jsonResponse(
					exaResults("https://example.com/x", "https://sub.example.com/y", "https://deep.sub.example.com/z"),
				),
		);
		const cfg = config(
			[{ id: "one", provider: "exa", baseUrl: "https://one.example.com", allowedDomains: ["sub.example.com"] }],
			{ allowedDomains: ["example.com"] },
		);

		// when
		const details = await performSearch(cfg, { query: "entry narrowing", maxResults: 5 });

		// then
		expect(details.results.map((item) => item.url)).toEqual([
			"https://sub.example.com/y",
			"https://deep.sub.example.com/z",
		]);
	});

	it("#given a prompt-only blocked-domain adapter #when it returns a blocked source #then postfilter removes it", async () => {
		// given
		vi.stubGlobal(
			"fetch",
			async (): Promise<Response> =>
				jsonResponse(nativePayload("https://blocked.example.com/x", "https://allowed.example.com/y")),
		);
		const cfg = config(
			[
				{
					id: "openai",
					provider: "openai",
					apiKey: "test",
					baseUrl: "https://openai.example.com/v1/responses",
				},
			],
			{ blockedDomains: ["blocked.example.com"], fallback: false },
		);

		// when
		const details = await performSearch(cfg, { query: "blocked adapter", maxResults: 5 });

		// then
		expect(details.results.map((item) => item.url)).toEqual(["https://allowed.example.com/y"]);
	});

	it("#given every result outside allowed domains #when searching #then reports a domain-filtered no-results failure", async () => {
		// given
		vi.stubGlobal("fetch", async (): Promise<Response> => jsonResponse(exaResults("https://attackerexample.com/x")));
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }], {
			allowedDomains: ["example.com"],
			fallback: false,
		});

		// when
		const details = await performSearch(cfg, { query: "all filtered", maxResults: 2 });

		// then
		expect(details.failureKind).toBe("no-results");
		expect(details.error).toContain("domain filters");
	});

	it("#given very large round-robin weights #when searching #then does not expand them into arrays", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.includes("one")) return jsonResponse({ error: "down" }, 503);
			return jsonResponse(exaResults("https://two.example.com/result"));
		});
		const cfg = config(
			[
				{ id: "one", provider: "exa", baseUrl: "https://one.example.com", weight: 1_000_000_000 },
				{ id: "two", provider: "exa", baseUrl: "https://two.example.com", weight: 1_000_000_000 },
			],
			{ strategy: "round-robin" },
		);

		// when
		const details = await performSearch(cfg, { query: "huge weight", maxResults: 1 });

		// then
		expect(urls).toEqual(["https://one.example.com", "https://two.example.com"]);
		expect(details.entryId).toBe("two");
	});

	it("#given a chain success after a native failure #when returning #then includes total duration and strategy metadata", async () => {
		// given
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			return url.includes("native")
				? jsonResponse({ error: "down" }, 503)
				: jsonResponse(exaResults("https://fallback.example.com/result"));
		});
		const cfg = config([{ id: "one", provider: "exa", baseUrl: "https://one.example.com" }]);

		// when
		const details = await performSearch(cfg, { query: "duration", maxResults: 1 }, undefined, undefined, undefined, {
			nativeEntry: nativeEntry(),
			nativeStatus: nativeReady,
		});

		// then
		expect(details.strategy).toBe("priority");
		expect(details.durationMs).toBeGreaterThanOrEqual(details.attempts?.at(-1)?.durationMs ?? 0);
	});

	it("#given all providers fail #when terminal #then preserves every attempt and the failure trace", async () => {
		// given
		vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
			return String(input).includes("one")
				? jsonResponse({ error: "auth" }, 401)
				: jsonResponse({ error: "quota" }, 429);
		});
		const cfg = config([
			{ id: "one", provider: "exa", baseUrl: "https://one.example.com" },
			{ id: "two", provider: "exa", baseUrl: "https://two.example.com" },
		]);

		// when
		const details = await performSearch(cfg, { query: "all fail", maxResults: 1 });

		// then
		expect(details.error).toContain("exa/one");
		expect(details.error).toContain("exa/two");
		expect(details.attempts?.map((attempt) => attempt.failureKind)).toEqual(["auth", "quota"]);
		expect(formatSearchText(details)).toContain("Routing attempts");
	});
});

describe("provider timeout and policy helpers", () => {
	it("#given a provider timeout larger than the global timeout #when called directly #then uses the global cap", async () => {
		// given
		vi.stubGlobal("fetch", (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		});
		const entry: SearchProviderEntry = {
			id: "one",
			provider: "exa",
			baseUrl: "https://one.example.com",
			timeoutMs: 10_000,
		};

		// when
		const details = await performProviderSearch(entry, { query: "timeout", maxResults: 1 }, undefined, {
			timeoutMs: 20,
		});

		// then
		expect(details.failureKind).toBe("timeout");
	});

	it("#given global and request domain filters #when intersecting #then global allowed domains win", () => {
		// given / when
		const filters = effectiveDomainFilters({ allowedDomains: ["a.com"] }, { allowedDomains: ["a.com", "b.com"] });

		// then
		expect(filters).toEqual({ allowedDomains: ["a.com"] });
	});

	it("#given config maxResults zero #when normalizing #then clamps to a safe positive limit", () => {
		// given / when / then
		expect(effectiveMaxResults(config([], { maxResults: 0 }))).toBe(1);
		expect(effectiveMaxResults(config([], { maxResults: 100 }))).toBe(50);
	});
});

describe("domain policy utilities", () => {
	it("#given wildcard case and trailing dot #when canonicalizing #then returns one canonical scope", () => {
		// given / when / then
		expect(canonicalDomain(" *.Example.COM. ")).toBe("example.com");
		expect(domainWithin("Docs.Example.COM.", "example.com")).toBe(true);
		expect(domainWithin("attackerexample.com", "example.com")).toBe(false);
	});

	it("#given parent and child allowed scopes #when merging #then the narrower scope wins", () => {
		// given / when
		const merged = mergeDomainFilters({ allowedDomains: ["Example.COM."] }, { allowedDomains: ["Docs.Example.com"] });

		// then
		expect(merged).toEqual({ allowedDomains: ["docs.example.com"] });
	});

	it("#given allowed and blocked scopes #when merging #then blocks union and fully covered allowed scopes are removed", () => {
		// given / when
		const preserved = mergeDomainFilters(
			{ allowedDomains: ["example.com"], blockedDomains: ["sub.example.com"] },
			{ blockedDomains: ["other.example.com", "Sub.Example.com."] },
		);

		// then
		expect(preserved).toEqual({
			allowedDomains: ["example.com"],
			blockedDomains: ["sub.example.com", "other.example.com"],
		});
	});

	it("#given an allowed child fully covered by a blocked parent #when merging #then throws with an empty policy", () => {
		// given / when / then
		expect(() =>
			mergeDomainFilters({ allowedDomains: ["docs.example.com"] }, { blockedDomains: ["example.com"] }),
		).toThrow(EmptyDomainPolicyError);
		try {
			mergeDomainFilters({ allowedDomains: ["a.com"] }, { allowedDomains: ["b.com"] });
		} catch (error) {
			expect(error).toBeInstanceOf(EmptyDomainPolicyError);
			expect((error as EmptyDomainPolicyError).policy.allowedDomains).toEqual([]);
		}
	});

	it("#given a host and policy #when checking #then matching is case and boundary safe", () => {
		// given / when / then
		expect(isHostAllowedByPolicy("Docs.Example.COM", { allowedDomains: ["example.com"] })).toBe(true);
		expect(isHostAllowedByPolicy("attackerexample.com", { allowedDomains: ["example.com"] })).toBe(false);
		expect(isHostAllowedByPolicy("sub.example.com", { blockedDomains: ["example.com"] })).toBe(false);
		expect(isHostAllowedByPolicy("example.com", { allowedDomains: [] })).toBe(false);
	});
});
