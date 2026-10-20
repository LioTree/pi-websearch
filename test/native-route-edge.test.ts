import { describe, expect, it } from "vitest";
import { type NativeModelInfo, type NativeModelRegistry, resolveNativeRoute } from "../src/websearch/native.js";
import { isAllowedProviderBaseUrl, nativeSearchEndpoint } from "../src/websearch/provider-endpoints.js";

function model(overrides: Partial<NativeModelInfo> = {}): NativeModelInfo {
	const info: NativeModelInfo = {
		provider: "openai",
		id: "gpt-5.5",
		api: "openai-responses",
		baseUrl: "https://gateway.example.com/v1",
	};
	if (overrides.provider !== undefined) info.provider = overrides.provider;
	if (overrides.id !== undefined) info.id = overrides.id;
	if (overrides.api !== undefined) info.api = overrides.api;
	if (overrides.baseUrl !== undefined) info.baseUrl = overrides.baseUrl;
	if (overrides.headers !== undefined) info.headers = overrides.headers;
	return info;
}

function registry(apiKey = "native-test"): NativeModelRegistry {
	return {
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey };
		},
	};
}

describe("native endpoint semantics", () => {
	it("#given adapter-specific base URLs #when deriving endpoints #then mirrors the provider SDK paths without generic /v1 insertion", () => {
		// given
		const cases: Array<{ adapter: Parameters<typeof nativeSearchEndpoint>[0]; baseUrl: string; endpoint: string }> = [
			{
				adapter: "openai",
				baseUrl: "https://api.openai.com/v1",
				endpoint: "https://api.openai.com/v1/responses",
			},
			{
				adapter: "openai",
				baseUrl: "https://api.openai.com",
				endpoint: "https://api.openai.com/responses",
			},
			{
				adapter: "openai",
				baseUrl: "https://api.openai.com/v1/",
				endpoint: "https://api.openai.com/v1/responses",
			},
			{
				adapter: "openai",
				baseUrl: "https://api.openai.com/v1/responses",
				endpoint: "https://api.openai.com/v1/responses",
			},
			{
				adapter: "anthropic",
				baseUrl: "https://api.anthropic.com",
				endpoint: "https://api.anthropic.com/v1/messages",
			},
			{
				adapter: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				endpoint: "https://api.anthropic.com/v1/messages",
			},
			{
				adapter: "anthropic",
				baseUrl: "https://api.anthropic.com/v1/messages",
				endpoint: "https://api.anthropic.com/v1/messages",
			},
			{
				adapter: "anthropic",
				baseUrl: "https://gateway.example.com/proxy",
				endpoint: "https://gateway.example.com/proxy/v1/messages",
			},
			{
				adapter: "xai",
				baseUrl: "https://api.x.ai/v1",
				endpoint: "https://api.x.ai/v1/responses",
			},
			{
				adapter: "z-ai",
				baseUrl: "https://api.z.ai/api/coding/paas/v4",
				endpoint: "https://api.z.ai/api/coding/paas/v4/chat/completions",
			},
			{
				adapter: "perplexity",
				baseUrl: "https://api.perplexity.ai",
				endpoint: "https://api.perplexity.ai/chat/completions",
			},
			{
				adapter: "kimi",
				baseUrl: "https://api.kimi.com/coding",
				endpoint: "https://api.kimi.com/coding/v1/search",
			},
			{
				adapter: "kimi",
				baseUrl: "https://api.kimi.com/coding/v1",
				endpoint: "https://api.kimi.com/coding/v1/search",
			},
			{
				adapter: "kimi",
				baseUrl: "https://gateway.example.com/v1",
				endpoint: "https://gateway.example.com/v1/search",
			},
			{
				adapter: "codex",
				baseUrl: "https://chatgpt.com/backend-api",
				endpoint: "https://chatgpt.com/backend-api/codex/responses",
			},
			{
				adapter: "codex",
				baseUrl: "https://chatgpt.com/backend-api/codex",
				endpoint: "https://chatgpt.com/backend-api/codex/responses",
			},
		];

		for (const testCase of cases) {
			// when
			const endpoint = nativeSearchEndpoint(testCase.adapter, testCase.baseUrl);

			// then
			expect(endpoint).toBe(testCase.endpoint);
		}
	});

	it("#given query parameters and fragments #when deriving an endpoint #then preserves the query and drops the fragment", () => {
		// when
		const endpoint = nativeSearchEndpoint("openai", "https://gateway.example.com/v1?token=abc#fragment");

		// then
		expect(endpoint).toBe("https://gateway.example.com/v1/responses?token=abc");
	});

	it("#given public hostnames starting with fc or fd #when validating #then allows them", () => {
		// when / then
		expect(isAllowedProviderBaseUrl("https://fcbank.example.com/v1")).toBe(true);
		expect(isAllowedProviderBaseUrl("https://fdic.example.gov/v1")).toBe(true);
	});

	it("#given a public IPv6 host #when validating #then allows it while still rejecting private IPv6", () => {
		// when / then
		expect(isAllowedProviderBaseUrl("https://[2001:4860:4860::8888]/v1")).toBe(true);
		expect(isAllowedProviderBaseUrl("https://[fc00::1]/v1")).toBe(false);
		expect(isAllowedProviderBaseUrl("https://[fd12:3456::1]/v1")).toBe(false);
		expect(isAllowedProviderBaseUrl("https://[fe80::1]/v1")).toBe(false);
		expect(isAllowedProviderBaseUrl("https://[::ffff:127.0.0.1]/v1")).toBe(false);
	});

	it("#given private or non-HTTPS hosts #when validating #then rejects them", () => {
		// given
		const unsafe = [
			"http://gateway.example.com/v1",
			"https://localhost/v1",
			"https://127.0.0.1/v1",
			"https://10.1.2.3/v1",
			"https://[fd00::1]/v1",
			"https://[fe80::1]/v1",
			"https://user:pass@gateway.example.com/v1",
			"https://gateway.example.com../v1",
		];

		for (const baseUrl of unsafe) {
			// when
			const allowed = isAllowedProviderBaseUrl(baseUrl);

			// then
			expect(allowed).toBe(false);
		}
	});
});

describe("native route isolation", () => {
	it("#given an unsafe auth-resolved base URL #when resolving #then skips instead of sending credentials there", async () => {
		// given
		const insecureRegistry: NativeModelRegistry = {
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "native-test", baseUrl: "http://auth.example.com/v1" };
			},
		};

		// when
		const result = await resolveNativeRoute(model(), insecureRegistry);

		// then
		expect(result.entry).toBeUndefined();
		expect(result.status.status).toBe("skipped");
		expect(result.status.reason).toContain("public HTTPS");
	});

	it("#given a registry with other available models #when resolving the active model #then never reads the model catalog", async () => {
		// given
		let catalogReads = 0;
		let authCalls = 0;
		const discoveryRegistry: NativeModelRegistry & { getAvailable(): NativeModelInfo[] } = {
			async getApiKeyAndHeaders(candidate) {
				authCalls += 1;
				expect(candidate.provider).toBe("openai");
				return { ok: true, apiKey: "native-test" };
			},
			getAvailable() {
				catalogReads += 1;
				return [model({ provider: "anthropic", id: "claude-sonnet-5", api: "anthropic-messages" })];
			},
		};

		// when
		const result = await resolveNativeRoute(model(), discoveryRegistry);

		// then
		expect(result.entry?.provider).toBe("openai");
		expect(catalogReads).toBe(0);
		expect(authCalls).toBe(1);
	});

	it("#given a custom override endpoint #when resolving #then does not append an adapter suffix", async () => {
		// when
		const result = await resolveNativeRoute(
			model({ provider: "litellm", api: "openai-completions" }),
			registry("custom-key"),
			{ litellm: { adapter: "openai", endpoint: "https://search.example.com/custom" } },
		);

		// then
		expect(result.entry?.baseUrl).toBe("https://search.example.com/custom");
		expect(result.entry?.model).toBe("gpt-5.5");
		expect(result.entry?.apiKey).toBe("custom-key");
	});
});
