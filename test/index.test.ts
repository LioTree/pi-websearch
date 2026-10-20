import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import websearchExtension from "../src/index.js";
import type { createWebSearchTool } from "../src/websearch/tool.js";
import type { ConfigLoadResult } from "../src/websearch/types.js";

type SessionHandler = (event: object, ctx: object) => Promise<void> | void;
type LoadWebsearchConfig = (options: { readonly cwd: string }) => Promise<ConfigLoadResult>;
type Tool = ReturnType<typeof createWebSearchTool>;
type CommandHandler = (rawArgs: string, ctx: StatusContext) => Promise<void>;

interface StatusContext {
	model?: ReturnType<typeof modelFor>;
	modelRegistry?: ReturnType<typeof registryFor>;
	ui: { notify: ReturnType<typeof vi.fn> };
}

const loadWebsearchConfig = vi.hoisted(() => vi.fn<LoadWebsearchConfig>());

vi.mock("../src/websearch/config.js", () => ({ loadWebsearchConfig }));

const missingConfig: ConfigLoadResult = {
	ok: false,
	reason: "missing_config",
	message: "Missing websearch config. Create .pi/websearch.json or ~/.pi/websearch.json before starting pi.",
};

const activeConfig: ConfigLoadResult = {
	ok: true,
	source: "test",
	config: {
		strategy: "priority",
		fallback: true,
		auto: true,
		providers: [{ id: "fallback", provider: "exa", apiKey: "exa-key" }],
	},
};

function createTheme() {
	return { fg: (_key: string, value: string) => value };
}

function modelFor(provider: string, id: string, api: string, baseUrl: string) {
	return { provider, id, api, baseUrl, headers: { "x-model-header": "model-value" } };
}

function registryFor(apiKey: string) {
	return { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey })) };
}

interface Harness {
	sessionStart?: SessionHandler;
	modelSelect?: SessionHandler;
	tools: Tool[];
	statusCommand?: CommandHandler;
	notify: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
	const harness: Harness = {
		tools: [],
		notify: vi.fn(),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
	};
	websearchExtension({
		registerTool(definition: Tool) {
			harness.tools.push(definition);
		},
		registerCommand(_name: string, definition: { handler: CommandHandler }) {
			harness.statusCommand = definition.handler;
		},
		on(eventName: string, handler: unknown) {
			if (eventName === "session_start") harness.sessionStart = handler as SessionHandler;
			if (eventName === "model_select") harness.modelSelect = handler as SessionHandler;
		},
	} as never);
	return harness;
}

function sessionContext(
	cwd: string,
	model: ReturnType<typeof modelFor> | undefined,
	registry: ReturnType<typeof registryFor> | undefined,
	harness: Harness,
) {
	return {
		cwd,
		hasUI: true,
		model,
		modelRegistry: registry,
		ui: {
			notify: harness.notify,
			setStatus: harness.setStatus,
			setWidget: harness.setWidget,
			theme: createTheme(),
		},
	} as never;
}

function toolContext(model: ReturnType<typeof modelFor> | undefined, registry: ReturnType<typeof registryFor>) {
	return { model, modelRegistry: registry } as never;
}

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
}

const openAiPayload = {
	output: [
		{
			type: "web_search_call",
			action: { sources: [{ url: "https://openai.example.com/native-result" }] },
		},
	],
};

const anthropicPayload = {
	content: [
		{
			type: "web_search_tool_result",
			content: [{ title: "Anthropic native result", url: "https://anthropic.example.com/native-result" }],
		},
	],
};

const exaPayload = {
	results: [{ title: "Fallback result", url: "https://fallback.example.com/result" }],
};

function mockFetch() {
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("api.openai.com")) return jsonResponse(openAiPayload);
		if (url.includes("api.anthropic.com")) return jsonResponse(anthropicPayload);
		if (url.includes("api.exa.ai")) return jsonResponse(exaPayload);
		if (url.includes("api.search.brave.com")) {
			return jsonResponse({
				web: {
					results: [{ title: "Brave result", url: "https://brave.example.com/result", description: "direct" }],
				},
			});
		}
		throw new Error(`Unexpected search URL: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function lastTool(harness: Harness): Tool {
	const tool = harness.tools.at(-1);
	if (!tool) throw new Error("The extension did not register web_search.");
	return tool;
}

describe("websearch extension lifecycle", () => {
	beforeEach(() => {
		loadWebsearchConfig.mockReset();
		loadWebsearchConfig.mockResolvedValue(activeConfig);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("#given explicit config #when session starts #then clears UI and re-registers the tool from loaded config", async () => {
		// given
		const harness = createHarness();

		// when
		await harness.sessionStart?.({}, sessionContext("/tmp/explicit", undefined, undefined, harness));

		// then
		expect(loadWebsearchConfig).toHaveBeenCalledWith({ cwd: "/tmp/explicit" });
		expect(harness.tools).toHaveLength(2);
		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.setStatus).toHaveBeenCalledWith("pi-websearch", undefined);
		expect(harness.setWidget).toHaveBeenCalledWith("pi-websearch", undefined);
	});

	it("#given config error and an OpenAI model #when session starts #then reports the error and does not mask it", async () => {
		// given
		const harness = createHarness();
		const invalidConfig: ConfigLoadResult = {
			ok: false,
			reason: "invalid_config",
			message: "/tmp/bad/.pi/websearch.json: config.providers must be a non-empty array of provider entries.",
			source: "/tmp/bad/.pi/websearch.json",
		};
		loadWebsearchConfig.mockResolvedValue(invalidConfig);
		const fetchMock = mockFetch();

		// when
		await harness.sessionStart?.(
			{},
			sessionContext(
				"/tmp/bad",
				modelFor("openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1"),
				undefined,
				harness,
			),
		);
		const result = await lastTool(harness).execute(
			"invalid",
			{ query: "test query" },
			undefined,
			undefined,
			toolContext(
				modelFor("openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1"),
				registryFor("openai-key"),
			),
		);

		// then
		expect(harness.notify).toHaveBeenCalledWith(invalidConfig.message, "error");
		expect(JSON.stringify(result.content)).toContain("non-empty array");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(lastTool(harness).parameters.properties).not.toHaveProperty("mode");
	});

	it("#given hasUI false #when config is invalid #then startup does not touch UI", async () => {
		// given
		const harness = createHarness();
		loadWebsearchConfig.mockResolvedValue(missingConfig);

		// when
		await harness.sessionStart?.({}, {
			cwd: "/tmp/no-ui",
			hasUI: false,
			model: undefined,
			modelRegistry: registryFor("unused"),
			ui: { notify: harness.notify, setStatus: harness.setStatus, setWidget: harness.setWidget },
		} as never);

		// then
		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.setStatus).not.toHaveBeenCalled();
		expect(harness.setWidget).not.toHaveBeenCalled();
	});
});

describe("native-first end-to-end execution", () => {
	beforeEach(() => {
		loadWebsearchConfig.mockReset();
		loadWebsearchConfig.mockResolvedValue(activeConfig);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		{
			label: "OpenAI",
			model: modelFor("openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1"),
			key: "openai-key",
			url: "https://api.openai.com/v1/responses",
			marker: "https://openai.example.com/native-result",
		},
		{
			label: "Anthropic",
			model: modelFor("anthropic", "claude-sonnet-4-5", "anthropic-messages", "https://api.anthropic.com"),
			key: "anthropic-key",
			url: "https://api.anthropic.com/v1/messages",
			marker: "https://anthropic.example.com/native-result",
		},
	])(
		"#given an active $label model #when session_start registers the tool and it executes #then hosted search succeeds without the configured fallback",
		async ({ model, key, url, marker }) => {
			// given
			const harness = createHarness();
			const registry = registryFor(key);
			const fetchMock = mockFetch();
			await harness.sessionStart?.({}, sessionContext("/tmp/native", model, registry, harness));

			// when
			const result = await lastTool(harness).execute(
				"native",
				{ query: "test query" },
				undefined,
				undefined,
				toolContext(model, registry),
			);

			// then
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(String(fetchMock.mock.calls[0]?.[0])).toBe(url);
			expect(JSON.stringify(result.content)).toContain(marker);
			expect(JSON.stringify(result.content)).not.toContain("https://fallback.example.com/result");
			const details = result.details as { provider?: string; stage?: string; attempts?: Array<{ stage?: string }> };
			expect(details.stage).toBe("native");
			expect(details.attempts?.[0]?.stage).toBe("native");
			expect(JSON.stringify(result)).not.toContain(key);
			expect(JSON.stringify(result)).not.toContain("exa-key");
		},
	);

	it("#given an OpenAI session then an Anthropic model #when the same registered tool executes #then each call follows the new context model", async () => {
		// given
		const harness = createHarness();
		const openAiModel = modelFor("openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1");
		const anthropicModel = modelFor(
			"anthropic",
			"claude-sonnet-4-5",
			"anthropic-messages",
			"https://api.anthropic.com",
		);
		const openAiRegistry = registryFor("openai-key");
		const anthropicRegistry = registryFor("anthropic-key");
		const fetchMock = mockFetch();
		await harness.sessionStart?.({}, sessionContext("/tmp/switch", openAiModel, openAiRegistry, harness));
		const tool = lastTool(harness);

		// when
		const first = await tool.execute(
			"first",
			{ query: "test query" },
			undefined,
			undefined,
			toolContext(openAiModel, openAiRegistry),
		);
		const second = await tool.execute(
			"second",
			{ query: "test query" },
			undefined,
			undefined,
			toolContext(anthropicModel, anthropicRegistry),
		);

		// then
		expect(JSON.stringify(first.content)).toContain("https://openai.example.com/native-result");
		expect(JSON.stringify(second.content)).toContain("https://anthropic.example.com/native-result");
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.openai.com");
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("api.anthropic.com");
		expect(openAiRegistry.getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
		expect(anthropicRegistry.getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
	});

	it("#given rawMode with a direct provider #when session starts #then exposes raw and keeps native-first normal routing", async () => {
		// given
		const harness = createHarness();
		const model = modelFor("openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1");
		const registry = registryFor("openai-key");
		loadWebsearchConfig.mockResolvedValue({
			ok: true,
			source: "test",
			config: {
				strategy: "priority",
				fallback: true,
				auto: true,
				rawMode: true,
				providers: [{ id: "direct", provider: "brave", apiKey: "brave-key" }],
			},
		});
		const fetchMock = mockFetch();
		await harness.sessionStart?.({}, sessionContext("/tmp/raw", model, registry, harness));
		const tool = lastTool(harness);
		expect(tool.parameters.properties).toHaveProperty("mode");

		// when
		const normal = await tool.execute(
			"normal",
			{ query: "test query" },
			undefined,
			undefined,
			toolContext(model, registry),
		);
		const raw = await tool.execute(
			"raw",
			{ query: "test query", mode: "raw" },
			undefined,
			undefined,
			toolContext(model, registry),
		);

		// then
		expect(JSON.stringify(normal.content)).toContain("https://openai.example.com/native-result");
		expect(JSON.stringify(raw.content)).toContain("https://brave.example.com/result");
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.openai.com");
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("api.search.brave.com");
		expect((raw.details as { mode?: string }).mode).toBe("raw");
	});

	it("#given rawMode false #when a later session starts #then re-registers without the raw parameter", async () => {
		// given
		const harness = createHarness();
		loadWebsearchConfig.mockResolvedValue({
			ok: true,
			source: "test",
			config: { ...activeConfig.config, rawMode: true, providers: [{ provider: "brave", apiKey: "brave-key" }] },
		});
		await harness.sessionStart?.({}, sessionContext("/tmp/raw", undefined, undefined, harness));
		expect(lastTool(harness).parameters.properties).toHaveProperty("mode");

		// when
		loadWebsearchConfig.mockResolvedValue(activeConfig);
		await harness.sessionStart?.({}, sessionContext("/tmp/raw", undefined, undefined, harness));

		// then
		expect(lastTool(harness).parameters.properties).not.toHaveProperty("mode");
	});
});

describe("/websearch status", () => {
	beforeEach(() => {
		loadWebsearchConfig.mockReset();
		loadWebsearchConfig.mockResolvedValue(activeConfig);
	});

	it("#given a supported active model #when status runs #then reports model, modes, adapter candidate and providers without resolving auth", async () => {
		// given
		const harness = createHarness();
		const model = modelFor("openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1");
		const registry = registryFor("openai-key");
		await harness.sessionStart?.({}, sessionContext("/tmp/status", model, registry, harness));
		const notify = vi.fn();

		// when
		await harness.statusCommand?.("status", {
			model,
			modelRegistry: registry,
			ui: { notify },
		});

		// then
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
		const call = notify.mock.calls[0];
		expect(call?.[1]).toBe("info");
		expect(call?.[0]).toContain("model=openai/gpt-5.5");
		expect(call?.[0]).toContain("auto=enabled");
		expect(call?.[0]).toContain("rawMode=disabled");
		expect(call?.[0]).toContain("native=ready adapter=openai");
		expect(call?.[0]).toContain("providers=exa/fallback");
	});

	it("#given auto false #when status runs #then reports native disabled", async () => {
		// given
		const harness = createHarness();
		const model = modelFor("openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1");
		loadWebsearchConfig.mockResolvedValue({ ...activeConfig, config: { ...activeConfig.config, auto: false } });
		await harness.sessionStart?.({}, sessionContext("/tmp/status", model, undefined, harness));
		const notify = vi.fn();

		// when
		await harness.statusCommand?.("", { model, ui: { notify } });

		// then
		expect(notify.mock.calls[0]?.[0]).toContain("native=disabled (auto=false)");
	});

	it("#given an unsupported provider #when status runs #then reports the truthful skipped reason", async () => {
		// given
		const harness = createHarness();
		const model = modelFor("my-gateway", "custom-model", "openai-responses", "https://gateway.example.com/v1");
		await harness.sessionStart?.({}, sessionContext("/tmp/status", model, undefined, harness));
		const notify = vi.fn();

		// when
		await harness.statusCommand?.("status", { model, ui: { notify } });

		// then
		const message = String(notify.mock.calls[0]?.[0]);
		expect(message).toContain("native=skipped");
		expect(message).toContain('unsupported provider "my-gateway"');
		expect(message).toContain("nativeOverrides");
	});

	it("#given a native override #when status runs #then reports the configured adapter without credentials", async () => {
		// given
		const harness = createHarness();
		const model = modelFor("my-gateway", "custom-model", "openai-responses", "https://gateway.example.com/v1");
		loadWebsearchConfig.mockResolvedValue({
			ok: true,
			source: "test",
			config: {
				...activeConfig.config,
				nativeOverrides: {
					"my-gateway": { adapter: "openai", endpoint: "https://gateway.example.com/v1/responses" },
				},
			},
		});
		await harness.sessionStart?.({}, sessionContext("/tmp/status", model, undefined, harness));
		const notify = vi.fn();

		// when
		await harness.statusCommand?.("status", { model, ui: { notify } });

		// then
		const message = String(notify.mock.calls[0]?.[0]);
		expect(message).toContain("native=ready adapter=openai");
		expect(message).not.toContain("apiKey");
	});

	it("#given invalid config #when status runs #then reports the error rather than an active search", async () => {
		// given
		const harness = createHarness();
		loadWebsearchConfig.mockResolvedValue(missingConfig);
		await harness.sessionStart?.({}, sessionContext("/tmp/status", undefined, undefined, harness));
		const notify = vi.fn();

		// when
		await harness.statusCommand?.("status", { ui: { notify } });

		// then
		expect(notify.mock.calls[0]?.[1]).toBe("error");
		expect(notify.mock.calls[0]?.[0]).toContain("Web search inactive");
		expect(notify.mock.calls[0]?.[0]).toContain("Missing websearch config");
	});
});
