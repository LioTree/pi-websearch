import { describe, expect, it } from "vitest";

import {
	buildNativeEntry,
	type NativeAuthResult,
	type NativeModelInfo,
	type NativeModelRegistry,
	resolveNativeAdapter,
	resolveNativeRoute,
} from "../src/websearch/native.js";
import { buildSearchRequest } from "../src/websearch/providers.js";

interface ModelOptions {
	provider?: string;
	id?: string;
	api?: string;
	baseUrl?: string;
	headers?: Record<string, string | null>;
}

function model(options: ModelOptions = {}): NativeModelInfo {
	const info: NativeModelInfo = {
		provider: options.provider ?? "openai",
		id: options.id ?? "gpt-5.5",
		api: options.api ?? "openai-responses",
		baseUrl: options.baseUrl ?? "https://gateway.example.com/v1",
	};
	if (options.headers) info.headers = options.headers;
	return info;
}

function registry(result: NativeAuthResult = { ok: true, apiKey: "native-test" }): NativeModelRegistry {
	return {
		async getApiKeyAndHeaders() {
			return result;
		},
	};
}

describe("resolveNativeAdapter", () => {
	it("#given known provider identities and arbitrary model ids #when resolving adapters #then uses identity and protocol only", () => {
		// given
		const cases: Array<{
			model: NativeModelInfo;
			adapter: "openai" | "anthropic" | "xai" | "z-ai" | "kimi" | "perplexity";
			provider: string;
			endpoint: string;
		}> = [
			{
				model: model({ id: "gpt-99-not-in-any-catalog" }),
				adapter: "openai",
				provider: "openai",
				endpoint: "https://gateway.example.com/v1/responses",
			},
			{
				model: model({ provider: "anthropic", id: "claude-future-99", api: "anthropic-messages" }),
				adapter: "anthropic",
				provider: "anthropic",
				endpoint: "https://gateway.example.com/v1/messages",
			},
			{
				model: model({ provider: "xai", id: "grok-99", api: "openai-responses" }),
				adapter: "xai",
				provider: "xai",
				endpoint: "https://gateway.example.com/v1/responses",
			},
			{
				model: model({ provider: "zai", id: "glm-99", api: "openai-completions" }),
				adapter: "z-ai",
				provider: "zai",
				endpoint: "https://gateway.example.com/v1/chat/completions",
			},
			{
				model: model({ provider: "z-ai", id: "glm-99", api: "openai-completions" }),
				adapter: "z-ai",
				provider: "z-ai",
				endpoint: "https://gateway.example.com/v1/chat/completions",
			},
			{
				model: model({
					provider: "zai-coding-cn",
					id: "glm-99",
					api: "openai-completions",
					baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
				}),
				adapter: "z-ai",
				provider: "zai-coding-cn",
				endpoint: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
			},
			{
				model: model({ provider: "kimi-coding", id: "k3", api: "anthropic-messages" }),
				adapter: "kimi",
				provider: "kimi-coding",
				endpoint: "https://gateway.example.com/v1/search",
			},
			{
				model: model({ provider: "kimi-coding", id: "k3", api: "openai-completions" }),
				adapter: "kimi",
				provider: "kimi-coding",
				endpoint: "https://gateway.example.com/v1/search",
			},
			{
				model: model({ provider: "perplexity", id: "sonar-99", api: "openai-completions" }),
				adapter: "perplexity",
				provider: "perplexity",
				endpoint: "https://gateway.example.com/v1/chat/completions",
			},
		];

		for (const testCase of cases) {
			// when
			const resolution = resolveNativeAdapter(testCase.model);

			// then
			expect(resolution.status).toEqual({
				status: "ready",
				provider: testCase.provider,
				model: testCase.model.id,
				adapter: testCase.adapter,
			});
			expect(resolution.adapter).toBe(testCase.adapter);
			expect(resolution.endpoint).toBe(testCase.endpoint);
		}
	});

	it("#given unsupported provider without override #when resolving #then skips with an opt-in reason", () => {
		// when
		const resolution = resolveNativeAdapter(
			model({ provider: "litellm", id: "proxy-model", api: "openai-completions" }),
		);

		// then
		expect(resolution.status.status).toBe("skipped");
		expect(resolution.status.reason).toContain('nativeOverrides["litellm"]');
		expect(resolution.endpoint).toBeUndefined();
	});

	it("#given an OpenRouter model id #when resolving #then does not unwrap it or reuse OpenRouter credentials", async () => {
		// given
		let authCalls = 0;
		const authRegistry: NativeModelRegistry = {
			async getApiKeyAndHeaders() {
				authCalls += 1;
				return { ok: true, apiKey: "openrouter-key" };
			},
		};

		// when
		const result = await resolveNativeRoute(
			model({ provider: "openrouter", id: "openai/gpt-5.5", api: "openai-completions" }),
			authRegistry,
		);

		// then
		expect(result.entry).toBeUndefined();
		expect(result.status.status).toBe("skipped");
		expect(result.status.reason).toContain('unsupported provider "openrouter"');
		expect(authCalls).toBe(0);
	});

	it("#given a known provider with a mismatched protocol #when resolving #then skips instead of guessing", () => {
		// when
		const resolution = resolveNativeAdapter(model({ api: "openai-completions" }));

		// then
		expect(resolution.status.status).toBe("skipped");
		expect(resolution.status.adapter).toBe("openai");
		expect(resolution.status.reason).toContain('requires "openai-responses"');
	});

	it("#given the Codex subscription provider #when resolving #then selects the separate subscription adapter", () => {
		// when
		const resolution = resolveNativeAdapter(
			model({
				provider: "openai-codex",
				id: "gpt-5.5",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
			}),
		);

		// then
		expect(resolution.status.status).toBe("ready");
		expect(resolution.status.adapter).toBe("codex");
		expect(resolution.endpoint).toBe("https://chatgpt.com/backend-api/codex/responses");
	});

	it("#given an OpenAI override resolved to ChatGPT #when resolving #then still uses the subscription wire format", async () => {
		// when
		const resolution = await resolveNativeRoute(
			model({
				provider: "openai-codex",
				id: "gpt-5.5",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
			}),
			registry(),
			{ "openai-codex": { adapter: "openai" } },
		);

		// then
		expect(resolution.status.status).toBe("ready");
		expect(resolution.entry?.provider).toBe("openai-codex");
		expect(resolution.status.adapter).toBe("codex");
	});

	it("#given a custom provider override #when resolving #then trusts the explicit adapter and model", () => {
		// given
		const activeModel = model({ provider: "litellm", id: "proxy-model", api: "openai-completions" });
		const overrides = { litellm: { adapter: "openai" as const, model: "gpt-5.6-sol" } };

		// when
		const resolution = resolveNativeAdapter(activeModel, overrides);

		// then
		expect(resolution.status).toEqual({
			status: "ready",
			provider: "litellm",
			model: "gpt-5.6-sol",
			adapter: "openai",
		});
		expect(resolution.endpoint).toBe("https://gateway.example.com/v1/responses");
	});

	it("#given an override with a complete endpoint #when resolving #then does not append an adapter suffix", () => {
		// given
		const activeModel = model({ provider: "litellm", api: "openai-completions" });
		const overrides = {
			litellm: { adapter: "anthropic" as const, endpoint: "https://search.example.com/custom/path?x=1" },
		};

		// when
		const resolution = resolveNativeAdapter(activeModel, overrides);

		// then
		expect(resolution.status.status).toBe("ready");
		expect(resolution.endpoint).toBe("https://search.example.com/custom/path?x=1");
	});

	it("#given override false or an unsafe override endpoint #when resolving #then skips with a truthful reason", () => {
		// given
		const activeModel = model();
		const disabled = resolveNativeAdapter(activeModel, { openai: false });
		const httpOverride = resolveNativeAdapter(activeModel, {
			openai: { adapter: "openai", endpoint: "http://search.example.com/responses" },
		});
		const localOverride = resolveNativeAdapter(activeModel, {
			openai: { adapter: "openai", endpoint: "https://localhost/responses" },
		});

		// then
		expect(disabled.status.status).toBe("skipped");
		expect(disabled.status.reason).toContain("disabled");
		expect(httpOverride.status.status).toBe("skipped");
		expect(httpOverride.status.reason).toContain("public HTTPS");
		expect(localOverride.status.status).toBe("skipped");
		expect(localOverride.status.reason).toContain("public HTTPS");
	});

	it("#given an unusable model URL #when inspecting the adapter #then reports a ready candidate without blocking auth-resolved URL selection", () => {
		// when
		const resolution = resolveNativeAdapter(model({ baseUrl: "http://localhost:11434/v1" }));

		// then
		expect(resolution.status.status).toBe("ready");
		expect(resolution.status.reason).toContain("authenticated provider base URL");
		expect(resolution.endpoint).toBeUndefined();
	});

	it("#given no active model #when resolving #then skips without credentials", () => {
		// when
		const resolution = resolveNativeAdapter(undefined);

		// then
		expect(resolution.status).toEqual({ status: "skipped", reason: "no active model" });
	});
});

describe("resolveNativeRoute", () => {
	it("#given an API-key model #when resolving #then builds a native entry from the active model only", async () => {
		// given
		const activeModel = model({ id: "gpt-5.5" });
		const calls: NativeModelInfo[] = [];
		const authRegistry: NativeModelRegistry = {
			async getApiKeyAndHeaders(candidate) {
				calls.push(candidate);
				return { ok: true, apiKey: "native-test" };
			},
		};

		// when
		const result = await resolveNativeRoute(activeModel, authRegistry);

		// then
		expect(calls).toEqual([activeModel]);
		expect(result.entry).toEqual({
			id: "native",
			provider: "openai",
			baseUrl: "https://gateway.example.com/v1/responses",
			model: "gpt-5.5",
			priority: -1,
			apiKey: "native-test",
		});
		expect(result.status).toEqual({
			status: "ready",
			provider: "openai",
			model: "gpt-5.5",
			adapter: "openai",
		});
		expect(result.key).toMatch(/^native:[0-9a-f]{64}$/);
	});

	it("#given auth-resolved base URL and headers #when resolving #then preserves them and applies null deletions", async () => {
		// given
		const activeModel = model({
			headers: { "X-Model": "model", "X-Deleted": "model" },
		});
		const authRegistry = registry({
			ok: true,
			apiKey: "native-test",
			baseUrl: "https://auth.example.com/root/v1",
			headers: { "x-model": "auth", "X-Auth": "header", "x-deleted": null },
		});

		// when
		const result = await resolveNativeRoute(activeModel, authRegistry);

		// then
		expect(result.entry?.baseUrl).toBe("https://auth.example.com/root/v1/responses");
		expect(result.entry?.headers).toEqual({ "x-model": "auth", "X-Auth": "header", "x-deleted": null });
	});

	it("#given a valid auth-resolved URL and an unusable active model URL #when resolving #then uses the auth URL", async () => {
		// given
		const authRegistry = registry({
			ok: true,
			apiKey: "native-test",
			baseUrl: "https://auth.example.com/v1",
		});

		// when
		const result = await resolveNativeRoute(model({ baseUrl: "http://localhost:11434/v1" }), authRegistry);

		// then
		expect(result.status.status).toBe("ready");
		expect(result.entry?.baseUrl).toBe("https://auth.example.com/v1/responses");
	});

	it("#given Cloudflare gateway auth and an OpenAI key #when building the native request #then both auth headers coexist", async () => {
		// given
		const result = await resolveNativeRoute(
			model(),
			registry({ ok: true, apiKey: "openai-key", headers: { "cf-aig-authorization": "Bearer gateway" } }),
		);
		if (!result.entry) throw new Error("expected a native entry");

		// when
		const request = buildSearchRequest(result.entry, { query: "gateway auth", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer openai-key");
		expect(request.init.headers).toHaveProperty("cf-aig-authorization", "Bearer gateway");
	});

	it("#given a resolved auth tombstone and gateway auth #when building the native request #then the tombstone deletes the generated default", async () => {
		// given
		const result = await resolveNativeRoute(
			model({ headers: { Authorization: "Bearer model-token" } }),
			registry({
				ok: true,
				apiKey: "openai-key",
				headers: { Authorization: null, "cf-aig-authorization": "Bearer gateway" },
			}),
		);
		if (!result.entry) throw new Error("expected a native entry");

		// when
		const request = buildSearchRequest(result.entry, { query: "tombstone", maxResults: 1 });

		// then
		expect(result.entry.headers).toEqual({ Authorization: null, "cf-aig-authorization": "Bearer gateway" });
		expect(request.init.headers).not.toHaveProperty("Authorization");
		expect(request.init.headers).toHaveProperty("cf-aig-authorization", "Bearer gateway");
	});

	it("#given an Anthropic OAuth token with explicit resolved auth #when building the native request #then honors the override and the null tombstone", async () => {
		// given
		const result = await resolveNativeRoute(
			model({ provider: "anthropic", id: "claude-sonnet-5", api: "anthropic-messages" }),
			registry({
				ok: true,
				apiKey: "sk-ant-oat01-test",
				headers: { Authorization: "Bearer explicit-proxy", "x-api-key": null },
			}),
		);
		if (!result.entry) throw new Error("expected a native entry");

		// when
		const request = buildSearchRequest(result.entry, { query: "anthropic oauth", maxResults: 1 });

		// then
		expect(request.init.headers).toHaveProperty("Authorization", "Bearer explicit-proxy");
		expect(request.init.headers).not.toHaveProperty("x-api-key");
		expect(request.init.headers["anthropic-beta"]).toContain("claude-code-20250219");
	});

	it("#given merged model-header auth and no apiKey #when resolving #then accepts header-only auth", async () => {
		// when
		const result = await resolveNativeRoute(
			model({ headers: { Authorization: "Bearer model-token" } }),
			registry({ ok: true }),
		);

		// then
		expect(result.status.status).toBe("ready");
		expect(result.entry?.headers).toEqual({ Authorization: "Bearer model-token" });
	});

	it("#given model-header auth deliberately nulled by resolved auth #when resolving #then skips as unusable", async () => {
		// when
		const result = await resolveNativeRoute(
			model({ headers: { Authorization: "Bearer model-token" } }),
			registry({ ok: true, headers: { Authorization: null } }),
		);

		// then
		expect(result.entry).toBeUndefined();
		expect(result.status.reason).toContain("no usable credentials");
	});

	it("#given header-only auth #when resolving #then accepts it without an apiKey", async () => {
		// given
		const activeModel = model({ provider: "kimi-coding", id: "k3", api: "anthropic-messages" });
		const authRegistry = registry({ ok: true, headers: { Authorization: "Bearer kimi-oauth" } });

		// when
		const result = await resolveNativeRoute(activeModel, authRegistry);

		// then
		expect(result.status.status).toBe("ready");
		expect(result.entry?.provider).toBe("kimi");
		expect(result.entry?.apiKey).toBeUndefined();
		expect(result.entry?.headers).toEqual({ Authorization: "Bearer kimi-oauth" });
	});

	it("#given no usable credentials #when resolving #then skips without making an anonymous request", async () => {
		// when
		const result = await resolveNativeRoute(model(), registry({ ok: true }));

		// then
		expect(result.entry).toBeUndefined();
		expect(result.status.status).toBe("skipped");
		expect(result.status.reason).toContain("no usable credentials");
	});

	it("#given auth errors containing secrets #when resolving #then sanitizes the status reason", async () => {
		// given
		const authRegistry = registry({
			ok: false,
			error: "denied sk-live-abcdef123456 for https://auth.example.com/v1?token=super-secret Bearer topsecret",
		});

		// when
		const result = await resolveNativeRoute(model(), authRegistry);

		// then
		expect(result.status.status).toBe("skipped");
		expect(result.status.reason).toContain("native auth failed");
		expect(result.status.reason).not.toContain("sk-live-abcdef123456");
		expect(result.status.reason).not.toContain("super-secret");
		expect(result.status.reason).not.toContain("topsecret");
	});

	it("#given a thrown auth error #when resolving #then returns a sanitized skip instead of rejecting", async () => {
		// given
		const authRegistry: NativeModelRegistry = {
			async getApiKeyAndHeaders() {
				throw new Error("command failed: api-key=sk-live-abcdef123456");
			},
		};

		// when
		const result = await resolveNativeRoute(model(), authRegistry);

		// then
		expect(result.status.status).toBe("skipped");
		expect(result.status.reason).toContain("native auth failed");
		expect(result.status.reason).not.toContain("sk-live-abcdef123456");
	});

	it("#given an auth error containing an arbitrary header token #when resolving #then does not echo it", async () => {
		// given
		const authRegistry = registry({
			ok: false,
			error: "gateway rejected X-Custom-Auth=opaque-token-9f8e7d6c5b4a",
		});

		// when
		const result = await resolveNativeRoute(model(), authRegistry);

		// then
		expect(result.status.status).toBe("skipped");
		expect(result.status.reason).toContain("native auth failed");
		expect(result.status.reason).not.toContain("opaque-token");
		expect(result.status.reason).not.toContain("X-Custom-Auth");
	});

	it("#given no registry #when resolving #then skips instead of falling back to an unauthenticated call", async () => {
		// when
		const result = await resolveNativeRoute(model(), undefined);

		// then
		expect(result.entry).toBeUndefined();
		expect(result.status.reason).toBe("no model registry available");
	});

	it("#given two active models #when resolving sequentially #then each result follows its own model and auth", async () => {
		// given
		const authRegistry: NativeModelRegistry = {
			async getApiKeyAndHeaders(candidate) {
				return { ok: true, apiKey: `${candidate.provider}-key` };
			},
		};

		// when
		const openaiResult = await resolveNativeRoute(model({ id: "gpt-5.5" }), authRegistry);
		const anthropicResult = await resolveNativeRoute(
			model({ provider: "anthropic", id: "claude-sonnet-5", api: "anthropic-messages" }),
			authRegistry,
		);

		// then
		expect(openaiResult.entry?.baseUrl).toBe("https://gateway.example.com/v1/responses");
		expect(openaiResult.entry?.apiKey).toBe("openai-key");
		expect(anthropicResult.entry?.baseUrl).toBe("https://gateway.example.com/v1/messages");
		expect(anthropicResult.entry?.apiKey).toBe("anthropic-key");
		expect(openaiResult.key).not.toBe(anthropicResult.key);
	});

	it("#given query tokens in the base URL #when resolving #then the diagnostic key does not contain them", async () => {
		// given
		const activeModel = model({ baseUrl: "https://gateway.example.com/v1?token=super-secret" });

		// when
		const result = await resolveNativeRoute(activeModel, registry());

		// then
		expect(result.entry?.baseUrl).toBe("https://gateway.example.com/v1/responses?token=super-secret");
		expect(result.key).not.toContain("super-secret");
	});

	it("#given non-secret query routing differences #when resolving #then the opaque capability keys differ", async () => {
		// when
		const first = await resolveNativeRoute(model({ baseUrl: "https://gateway.example.com/v1?route=a" }), registry());
		const second = await resolveNativeRoute(model({ baseUrl: "https://gateway.example.com/v1?route=b" }), registry());

		// then
		expect(first.entry?.baseUrl).toContain("route=a");
		expect(first.key).not.toContain("route=a");
		expect(first.key).not.toBe(second.key);
	});

	it("#given the same effective endpoint #when resolving twice #then the capability key is stable", async () => {
		// when
		const first = await resolveNativeRoute(model(), registry());
		const second = await resolveNativeRoute(model(), registry());

		// then
		expect(first.key).toBe(second.key);
	});

	it("#given an override endpoint and auth base URL #when resolving #then uses the override endpoint with the active model auth", async () => {
		// given
		const activeModel = model({ provider: "litellm", api: "openai-completions" });
		const authRegistry = registry({
			ok: true,
			apiKey: "override-key",
			baseUrl: "https://auth.example.com/should-not-be-used",
			headers: { "X-Auth": "yes" },
		});

		// when
		const result = await resolveNativeRoute(activeModel, authRegistry, {
			litellm: { adapter: "openai", endpoint: "https://search.example.com/custom" },
		});

		// then
		expect(result.entry?.baseUrl).toBe("https://search.example.com/custom");
		expect(result.entry?.apiKey).toBe("override-key");
		expect(result.entry?.headers).toEqual({ "X-Auth": "yes" });
	});

	it("#given a buildNativeEntry call #when the adapter is supported #then returns the same active entry", async () => {
		// when
		const entry = await buildNativeEntry(model(), registry());

		// then
		expect(entry?.id).toBe("native");
		expect(entry?.provider).toBe("openai");
	});
});
