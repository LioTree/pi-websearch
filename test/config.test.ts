import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadWebsearchConfig, validateProviderConfig, validateWebsearchConfig } from "../src/websearch/config.js";

async function makeTempHome(): Promise<string> {
	const root = join(tmpdir(), `pi-websearch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await mkdir(root, { recursive: true });
	return root;
}

async function writeProjectConfig(root: string, value: unknown): Promise<string> {
	const projectPi = join(root, ".pi");
	await mkdir(projectPi, { recursive: true });
	const path = join(projectPi, "websearch.json");
	await writeFile(path, JSON.stringify(value), "utf8");
	return path;
}

describe("loadWebsearchConfig", () => {
	it("#given no config files #when loading config #then enables native-first with only anonymous Exa MCP", async () => {
		// given
		const root = await makeTempHome();

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result).toEqual({
				ok: true,
				source: "default",
				config: { strategy: "priority", fallback: true, auto: true, providers: [{ provider: "exa-mcp" }] },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given unreadable project config path #when loading #then reports invalid_config instead of defaulting", async () => {
		const root = await makeTempHome();
		try {
			const path = join(root, ".pi", "websearch.json");
			await mkdir(path, { recursive: true });
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid_config");
				expect(result.source).toBe(path);
				expect(result.message).toContain("Cannot read");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given project and global config #when loading config #then project config wins", async () => {
		// given
		const root = await makeTempHome();
		const globalHome = join(root, "global-home");
		await mkdir(globalHome, { recursive: true });
		const projectPath = await writeProjectConfig(root, {
			provider: "exa",
			apiKey: "exa-project",
			maxResults: 3,
		});
		await writeFile(
			join(globalHome, "websearch.json"),
			JSON.stringify({ provider: "tavily", apiKey: "global" }),
			"utf8",
		);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: globalHome });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.strategy).toBe("priority");
				expect(result.config.fallback).toBe(true);
				expect(result.config.auto).toBe(true);
				expect(result.config.maxResults).toBe(3);
				expect(result.config.providers).toEqual([{ provider: "exa", apiKey: "exa-project", maxResults: 3 }]);
				expect(result.source).toBe(projectPath);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given backend alias config #when loading config #then preserves explicit override", async () => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, { backend: "brave", apiKey: "brave-test" });

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.source).toBe(path);
				expect(result.config.providers).toEqual([{ provider: "brave", apiKey: "brave-test" }]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given multiple providers #when loading config #then preserves routing policy and global policy", async () => {
		// given
		const root = await makeTempHome();
		await writeProjectConfig(root, {
			strategy: "round-robin",
			fallback: true,
			maxResults: 5,
			timeoutMs: 15000,
			allowedDomains: ["docs.example.com"],
			providers: [
				{
					id: "anthropic-gateway",
					provider: "anthropic",
					apiKey: "anthropic-test",
					baseUrl: "https://anthropic.gateway.example.com/v1/messages",
					weight: 2,
				},
				{ id: "exa-search", provider: "exa", apiKey: "exa-test", priority: 10 },
			],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.strategy).toBe("round-robin");
				expect(result.config.maxResults).toBe(5);
				expect(result.config.timeoutMs).toBe(15000);
				expect(result.config.allowedDomains).toEqual(["docs.example.com"]);
				expect(result.config.providers).toHaveLength(2);
				expect(result.config.providers[0]).toMatchObject({
					id: "anthropic-gateway",
					provider: "anthropic",
					weight: 2,
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given legacy config with auto false #when loading config #then disables native auto route", async () => {
		// given
		const root = await makeTempHome();
		await writeProjectConfig(root, { provider: "exa", apiKey: "exa-test", auto: false });

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.auto).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given a single-provider config with global and provider keys #when loading config #then accepts both sets", async () => {
		// given
		const root = await makeTempHome();
		await writeProjectConfig(root, {
			provider: "brave",
			apiKey: "brave-test",
			strategy: "fill-first",
			fallback: false,
			auto: false,
			rawMode: true,
			maxResults: 7,
			timeoutMs: 1000,
			blockedDomains: ["spam.example.com"],
			nativeOverrides: { brave: false },
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config).toMatchObject({
					strategy: "fill-first",
					fallback: false,
					auto: false,
					rawMode: true,
					maxResults: 7,
					timeoutMs: 1000,
					blockedDomains: ["spam.example.com"],
					nativeOverrides: { brave: false },
				});
				expect(result.config.providers).toEqual([
					{
						provider: "brave",
						apiKey: "brave-test",
						maxResults: 7,
						timeoutMs: 1000,
						blockedDomains: ["spam.example.com"],
					},
				]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given providers and top-level provider fields #when loading config #then rejects the ambiguous mix", async () => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, {
			apiKey: "stray-key",
			providers: [{ provider: "exa", apiKey: "exa-test" }],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid_config");
				expect(result.message).toContain(path);
				expect(result.message).toContain("providers");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given empty provider list #when loading config #then config is invalid with its path", async () => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, { providers: [] });

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid_config");
				expect(result.message).toContain(path);
				expect(result.message).toContain("non-empty");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given one invalid provider entry among valid entries #when loading config #then rejects instead of filtering", async () => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, {
			providers: [
				{ provider: "exa", apiKey: "exa-test" },
				{ provider: "not-a-provider", apiKey: "whatever" },
			],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid_config");
				expect(result.message).toContain(path);
				expect(result.message).toContain("providers[1].provider");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["top-level typo", { provider: "exa", apiKey: "exa-test", fallbak: true }, "config.fallbak"],
		["typo without a provider", { fallbak: true }, "config.fallbak"],
		[
			"global typo",
			{ providers: [{ provider: "exa", apiKey: "exa-test" }], allowed_domain: ["docs.example.com"] },
			"config.allowed_domain",
		],
		[
			"entry typo",
			{ providers: [{ provider: "exa", apiKey: "exa-test", allowed_domain: ["docs.example.com"] }] },
			"config.providers[0].allowed_domain",
		],
		[
			"unknown entry key",
			{ providers: [{ provider: "exa", apiKey: "exa-test", codexCommand: "codex" }] },
			"config.providers[0].codexCommand",
		],
	] as const)("#given an unknown %s #when loading config #then rejects it", async (_label, value, keyPath) => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, value);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid_config");
				expect(result.message).toContain(path);
				expect(result.message).toContain(keyPath);
				expect(result.message).toContain("not a supported configuration key");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["strategy", { strategy: "random", providers: [{ provider: "exa", apiKey: "key" }] }],
		["fallback", { fallback: "yes", providers: [{ provider: "exa", apiKey: "key" }] }],
		["auto", { auto: "yes", providers: [{ provider: "exa", apiKey: "key" }] }],
		["rawMode", { rawMode: "yes", providers: [{ provider: "exa", apiKey: "key" }] }],
		["maxResults", { maxResults: 0, providers: [{ provider: "exa", apiKey: "key" }] }],
		["maxResults", { maxResults: 1.5, providers: [{ provider: "exa", apiKey: "key" }] }],
		["maxResults", { maxResults: Number.MAX_SAFE_INTEGER + 1, providers: [{ provider: "exa", apiKey: "key" }] }],
		["timeoutMs", { timeoutMs: 0, providers: [{ provider: "exa", apiKey: "key" }] }],
		["timeoutMs", { timeoutMs: 2_147_483_648, providers: [{ provider: "exa", apiKey: "key" }] }],
	] as const)(
		"#given an explicitly invalid %s #when loading config #then rejects instead of defaulting",
		async (field, value) => {
			// given
			const root = await makeTempHome();
			const path = await writeProjectConfig(root, value);

			try {
				// when
				const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

				// then
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.reason).toBe("invalid_config");
					expect(result.message).toContain(path);
					expect(result.message).toContain(field);
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("#given global allowed and blocked domains #when loading config #then config is invalid", async () => {
		// given
		const root = await makeTempHome();
		await writeProjectConfig(root, {
			allowedDomains: ["docs.example.com"],
			blockedDomains: ["spam.example.com"],
			providers: [{ provider: "exa", apiKey: "exa-test" }],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.message).toContain("allowedDomains");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given rawMode with only model-answer providers #when loading config #then rejects the config", async () => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, {
			rawMode: true,
			providers: [
				{ provider: "openai", apiKey: "openai-test" },
				{ provider: "perplexity", apiKey: "pplx-test", model: "sonar-pro" },
			],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid_config");
				expect(result.message).toContain(path);
				expect(result.message).toContain("direct-search provider");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given rawMode with a direct-search provider #when loading config #then accepts the config", async () => {
		// given
		const root = await makeTempHome();
		await writeProjectConfig(root, {
			rawMode: true,
			providers: [{ provider: "brave", apiKey: "brave-test" }],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.config.rawMode).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given valid native overrides #when loading config #then preserves adapter, endpoint and model without credentials", async () => {
		// given
		const root = await makeTempHome();
		await writeProjectConfig(root, {
			auto: true,
			nativeOverrides: {
				"my-gateway": {
					adapter: "openai",
					endpoint: "https://gateway.example.com/v1/responses",
					model: "gpt-5.5",
				},
				openai: false,
			},
			providers: [{ provider: "brave", apiKey: "brave-test" }],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.nativeOverrides).toEqual({
					"my-gateway": {
						adapter: "openai",
						endpoint: "https://gateway.example.com/v1/responses",
						model: "gpt-5.5",
					},
					openai: false,
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["unknown adapter", { adapter: "google" }],
		["whitespace model", { adapter: "openai", model: "   " }],
		["whitespace endpoint", { adapter: "openai", endpoint: "   " }],
		["http endpoint", { adapter: "openai", endpoint: "http://gateway.example.com/v1/responses" }],
		["host-only endpoint", { adapter: "openai", endpoint: "https://gateway.example.com" }],
		["private endpoint", { adapter: "openai", endpoint: "https://localhost/v1/responses" }],
		["credential endpoint", { adapter: "openai", endpoint: "https://user:pass@gateway.example.com/v1/responses" }],
		["credentials", { adapter: "openai", apiKey: "must-not-be-here" }],
		["headers", { adapter: "openai", headers: { authorization: "Bearer must-not-be-here" } }],
	] as const)("#given native override with %s #when loading config #then rejects it", async (_label, override) => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, {
			nativeOverrides: { openai: override },
			providers: [{ provider: "brave", apiKey: "brave-test" }],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid_config");
				expect(result.message).toContain(path);
				expect(result.message).toContain("nativeOverrides.openai");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given non-credential headers without apiKey #when loading config #then rejects missing auth", async () => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, {
			providers: [{ provider: "kimi", headers: { "User-Agent": "pi-test", "X-Trace-Id": "trace-123" } }],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("missing_api_key");
				expect(result.message).toContain(path);
				expect(result.message).not.toContain("pi-test");
				expect(result.message).not.toContain("trace-123");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given a documented credential header without apiKey #when loading config #then accepts header-only auth", async () => {
		// given
		const root = await makeTempHome();
		await writeProjectConfig(root, {
			providers: [{ provider: "kimi", headers: { Authorization: "Bearer test-token", "X-Trace": null } }],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.providers[0]?.headers).toEqual({
					Authorization: "Bearer test-token",
					"X-Trace": null,
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["apiKey whitespace", { provider: "exa", apiKey: "   " }, "apiKey"],
		["id whitespace", { provider: "exa", apiKey: "exa-test", id: "   " }, "id"],
		["domain whitespace", { provider: "exa", apiKey: "exa-test", allowedDomains: ["   "] }, "allowedDomains"],
		["searchEngineId whitespace", { provider: "google-cse", apiKey: "key", searchEngineId: "   " }, "searchEngineId"],
		["model whitespace", { provider: "exa", apiKey: "exa-test", model: "   " }, "model"],
	] as const)("#given %s #when loading config #then rejects the blank string", async (_label, value, field) => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, value);

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid_config");
				expect(result.message).toContain(path);
				expect(result.message).toContain(field);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		["invalid header name", { "Bad Header": "value" }],
		["reserved header name", { ["__proto__"]: "value" }],
		["non-string header value", { Authorization: 42 }],
		["control characters", { Authorization: "Bearer bad\nvalue" }],
	])("#given %s #when loading config #then rejects the provider headers", async (_label, headers) => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, {
			providers: [{ provider: "kimi", headers }],
		});

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("invalid_config");
				expect(result.message).toContain(path);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("validateWebsearchConfig", () => {
	it("#given config with non-boolean auto #when validating #then config is invalid", () => {
		// given
		const invalidConfig = JSON.parse(
			JSON.stringify({
				strategy: "priority",
				fallback: true,
				auto: "yes",
				providers: [{ provider: "exa", apiKey: "exa-test" }],
			}),
		);

		// when
		const result = validateWebsearchConfig(invalidConfig);

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("auto");
	});

	it("#given config with non-boolean fallback #when validating #then config is invalid", () => {
		// given
		const invalidConfig = JSON.parse(
			JSON.stringify({
				strategy: "priority",
				fallback: "yes",
				auto: true,
				providers: [{ provider: "exa", apiKey: "exa-test" }],
			}),
		);

		// when
		const result = validateWebsearchConfig(invalidConfig);

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("fallback");
	});
});

it("#given provider entry with timeoutMs #when loading config #then preserves timeout", async () => {
	// given
	const root = await makeTempHome();
	await writeProjectConfig(root, {
		providers: [{ id: "slow", provider: "exa", apiKey: "exa-test", timeoutMs: 15000 }],
	});

	try {
		// when
		const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

		// then
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.providers[0]).toMatchObject({ id: "slow", timeoutMs: 15000 });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

describe("validateProviderConfig", () => {
	it.each(["allowedDomains", "blockedDomains"] as const)(
		"#given whitespace in %s #when validating directly #then rejects the policy before credentials",
		(key) => {
			expect(validateProviderConfig({ provider: "exa", [key]: ["   "] })).toEqual({
				ok: false,
				reason: "invalid_config",
				message: `Provider config ${key} must be an array of non-empty domains.`,
			});
		},
	);

	it.each([
		["openai", " for hosted Responses API search"],
		["codex", " for hosted Responses API search"],
		["openai-codex", ""],
		["exa", ""],
	] as const)(
		"#given %s without credentials #when validating #then preserves the provider-specific diagnostic",
		(provider, suffix) => {
			expect(validateProviderConfig({ provider, headers: { "X-Trace": "not-a-credential" } })).toEqual({
				ok: false,
				reason: "missing_api_key",
				message: `Provider ${provider} requires apiKey or authentication headers${suffix}.`,
			});
		},
	);

	it("#given non-positive timeoutMs #when validating provider #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "exa", apiKey: "exa-test", timeoutMs: 0 });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("timeoutMs");
	});

	it("#given timeout above the setTimeout limit #when validating provider #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "exa", apiKey: "exa-test", timeoutMs: 2_147_483_648 });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("timeoutMs");
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"#given maxResults=%s #when validating provider #then config is invalid",
		(maxResults) => {
			// given / when
			const result = validateProviderConfig({ provider: "exa", apiKey: "exa-test", maxResults });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.message).toContain("maxResults");
		},
	);

	it("#given exa without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "exa" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_api_key");
	});

	it("#given exa with api key #when validating #then provider is valid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "exa", apiKey: "exa-test" });

		// then
		expect(result.ok).toBe(true);
	});

	it("#given exa with its documented authentication header #when validating #then provider is valid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "exa",
			headers: { "X-API-Key": "exa-test" },
		});

		// then
		expect(result.ok).toBe(true);
	});

	it("#given exa with only a bearer header #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "exa",
			headers: { Authorization: "Bearer exa-test" },
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_api_key");
	});

	it.each([
		["brave", "X-Subscription-Token"],
		["serper", "X-API-KEY"],
		["anthropic", "X-API-Key"],
		["tavily", "Authorization"],
	] as const)("#given documented %s auth header only #when validating #then provider is valid", (provider, name) => {
		// given / when
		const result = validateProviderConfig({ provider, headers: { [name]: "test-token" } });

		// then
		expect(result.ok).toBe(true);
	});

	it("#given only tracing headers #when validating a provider #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "kimi",
			headers: { "User-Agent": "pi-test", "X-Trace-Id": "trace-123" },
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_api_key");
	});

	it("#given only Cloudflare gateway auth #when validating a provider #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "kimi",
			headers: { "cf-aig-authorization": "Bearer gateway-token" },
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_api_key");
	});

	it("#given tavily without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "tavily" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_api_key");
	});

	it("#given google without search engine id #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "google-cse", apiKey: "key" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("searchEngineId");
	});

	it("#given google with header auth but no apiKey #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "google-cse",
			searchEngineId: "engine-id",
			headers: { Authorization: "Bearer google-test" },
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("apiKey");
	});

	it("#given google with apiKey and search engine id #when validating #then provider is valid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "google-cse",
			apiKey: "key",
			searchEngineId: "engine-id",
		});

		// then
		expect(result.ok).toBe(true);
	});

	it("#given z-ai without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "z-ai" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_api_key");
	});

	it("#given perplexity with api key #when validating #then provider is valid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "perplexity", apiKey: "pplx-test" });

		// then
		expect(result.ok).toBe(true);
	});

	it("#given xai without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "xai" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_api_key");
	});

	it("#given kimi without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "kimi" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_api_key");
	});

	it("#given kimi with api key #when validating #then provider is valid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "kimi", apiKey: "kimi-test" });

		// then
		expect(result.ok).toBe(true);
	});

	it("#given kagi without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "kagi" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("missing_api_key");
	});

	it("#given kagi with api key #when validating #then provider is valid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "kagi", apiKey: "kagi-test" });

		// then
		expect(result.ok).toBe(true);
	});

	it("#given codex without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "codex" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("apiKey");
	});

	it("#given openai without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "openai" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("apiKey");
	});

	it("#given anthropic without api key #when validating #then provider is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "anthropic" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("apiKey");
	});

	it("#given undocumented codexCommand #when loading #then rejects the unknown key instead of ignoring it", async () => {
		// given
		const root = await makeTempHome();
		const path = await writeProjectConfig(root, { provider: "codex", apiKey: "codex-test", codexCommand: "codex" });

		try {
			// when
			const result = await loadWebsearchConfig({ cwd: root, homeDir: root });

			// then
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain(path);
				expect(result.message).toContain("config.codexCommand");
				expect(result.message).toContain("not a supported configuration key");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#given both config domain filter modes #when validating #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "brave",
			apiKey: "brave-test",
			allowedDomains: ["docs.example.com"],
			blockedDomains: ["spam.example.com"],
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("invalid_config");
	});

	it("#given unsafe base url #when validating #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "tavily",
			apiKey: "tvly-test",
			baseUrl: "http://127.0.0.1:8080",
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("invalid_config");
			expect(result.message).toContain("public HTTPS URL");
		}
	});

	it("#given public https base url override #when validating #then config is valid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "tavily",
			apiKey: "tvly-test",
			baseUrl: "https://search-gateway.example.com/tavily",
		});

		// then
		expect(result.ok).toBe(true);
	});

	it("#given exa with private base url override #when validating #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({ provider: "exa", baseUrl: "https://localhost/search" });

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("invalid_config");
	});

	it("#given base url with credentials #when validating #then config is invalid", () => {
		// given / when
		const result = validateProviderConfig({
			provider: "tavily",
			apiKey: "tvly-test",
			baseUrl: "https://user:pass@search-gateway.example.com/tavily",
		});

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("invalid_config");
	});

	it("#given private ipv6 base url override #when validating #then config is invalid", () => {
		// given / when
		const loopback = validateProviderConfig({ provider: "exa", baseUrl: "https://[::1]/search" });
		const uniqueLocal = validateProviderConfig({ provider: "exa", baseUrl: "https://[fd00::1]/search" });
		const linkLocal = validateProviderConfig({ provider: "exa", baseUrl: "https://[fe80::1]/search" });
		const linkLocalUpperRange = validateProviderConfig({ provider: "exa", baseUrl: "https://[febf::1]/search" });
		const mappedLoopback = validateProviderConfig({ provider: "exa", baseUrl: "https://[::ffff:127.0.0.1]/search" });

		// then
		expect(loopback.ok).toBe(false);
		expect(uniqueLocal.ok).toBe(false);
		expect(linkLocal.ok).toBe(false);
		expect(linkLocalUpperRange.ok).toBe(false);
		expect(mappedLoopback.ok).toBe(false);
	});
});
