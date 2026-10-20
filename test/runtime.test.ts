import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import websearchExtension from "../src/index.js";

const sessions: AgentSession[] = [];
const directories: string[] = [];

function codexToken(account = "runtime-codex-account"): string {
	return `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}

function codexResponse(errorCode?: string): Response {
	const data = errorCode
		? { type: "error", error: { code: errorCode, message: "Subscription search failed" } }
		: {
				type: "response.completed",
				response: {
					status: "completed",
					output: [{ type: "web_search_call", action: { sources: [{ url: "https://docs.example/" }] } }],
				},
			};
	return new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

async function isolatedSession(
	rawMode: boolean,
	fallback = true,
	provider = "test-gateway",
	configuredProvider: "exa" | "deepseek" = "exa",
) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-websearch-runtime-"));
	directories.push(cwd);
	await mkdir(join(cwd, ".pi"));
	await writeFile(
		join(cwd, ".pi", "websearch.json"),
		JSON.stringify({
			rawMode,
			fallback,
			nativeOverrides: { "test-gateway": { adapter: "openai" } },
			providers: [
				{
					provider: configuredProvider,
					apiKey: "fallback-test-credential",
					baseUrl: "https://fallback.example/search",
				},
			],
		}),
	);
	const agentDir = join(cwd, "agent");
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: join(cwd, "catalog.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(provider, {
		api:
			provider === "openai-codex"
				? "openai-codex-responses"
				: provider === "deepseek"
					? "openai-completions"
					: "openai-responses",
		baseUrl: provider === "openai-codex" ? "https://chatgpt.com/backend-api" : "https://native.example/v1",
		apiKey: provider === "openai-codex" ? codexToken() : "native-test-credential",
		models: ["first-alias", "second-alias"].map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		})),
	});
	const model = modelRuntime.getModel(provider, "first-alias");
	if (!model) throw new Error("Test model was not registered");
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [websearchExtension],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: ["web_search"],
	});
	sessions.push(session);
	expect(extensionsResult.errors).toEqual([]);
	const errors: string[] = [];
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
	expect(errors).toEqual([]);
	return { session, modelRuntime };
}

function toolFor(session: AgentSession) {
	const tools = session.agent.state.tools.filter((tool) => tool.name === "web_search");
	expect(tools).toHaveLength(1);
	const tool = tools[0];
	if (!tool) throw new Error("web_search was not activated");
	return tool;
}

function successPayload(native: boolean): Response {
	return new Response(
		JSON.stringify(
			native
				? { output: [{ type: "web_search_call", action: { sources: [{ url: "https://docs.example/" }] } }] }
				: { results: [{ title: "Docs", url: "https://docs.example/" }] },
		),
	);
}

describe("real pi SDK extension lifecycle", () => {
	afterEach(async () => {
		for (const session of sessions.splice(0)) session.dispose();
		vi.unstubAllGlobals();
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it.each([false, true])(
		"#given rawMode %s #when binding the real runtime #then replaces the startup tool schema",
		async (rawMode) => {
			// given
			const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => successPayload(true));
			vi.stubGlobal("fetch", fetch);
			// when
			const { session } = await isolatedSession(rawMode);
			const tool = toolFor(session);
			// then
			expect(JSON.stringify(tool.parameters).includes('"mode"')).toBe(rawMode);
			const result = await tool.execute("native-search", { query: "runtime search" });
			expect(JSON.stringify(result.details)).toContain('"stage":"native"');
			expect(fetch).toHaveBeenCalledOnce();
			expect(String(fetch.mock.calls[0]?.[0])).toBe("https://native.example/v1/responses");
		},
	);

	it.each([false, true])(
		"#given DeepSeek and rawMode %s #when executing through pi #then uses its Search API without an answer-provider retry hint",
		async (rawMode) => {
			const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => successPayload(false));
			vi.stubGlobal("fetch", fetch);
			const { session } = await isolatedSession(rawMode, false, "deepseek");
			const result = await toolFor(session).execute("deepseek-search", { query: "runtime deepseek search" });
			expect(JSON.stringify(result.details)).toContain('"stage":"native"');
			expect(fetch).toHaveBeenCalledOnce();
			expect(String(fetch.mock.calls[0]?.[0])).toBe("https://native.example/v1/tools/search");
			expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
				query: "runtime deepseek search",
				count: 10,
				need_content: false,
			});
			expect(JSON.stringify(result.content)).not.toContain("If these results are a refusal");
		},
	);

	it("#given DeepSeek and raw enabled #when pi executes an explicit raw call #then skips DeepSeek native auth and uses only the configured engine", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => successPayload(false));
		vi.stubGlobal("fetch", fetch);
		const { session, modelRuntime } = await isolatedSession(true, false, "deepseek");
		const getAuth = vi.spyOn(modelRuntime, "getAuth");
		await toolFor(session).execute("deepseek-raw-search", { query: "runtime deepseek search", mode: "raw" });
		expect(getAuth).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://fallback.example/search");
	});

	it("#given an explicit DeepSeek raw backend #when pi executes raw search #then uses configured credentials rather than native credentials", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => successPayload(false));
		vi.stubGlobal("fetch", fetch);
		const { session, modelRuntime } = await isolatedSession(true, false, "deepseek", "deepseek");
		const getAuth = vi.spyOn(modelRuntime, "getAuth");
		const result = await toolFor(session).execute("deepseek-direct-raw", {
			query: "runtime direct search",
			mode: "raw",
		});
		expect(getAuth).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://fallback.example/search");
		expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer fallback-test-credential" });
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			query: "runtime direct search",
			count: 10,
			need_content: false,
		});
		expect(JSON.stringify(result.details)).toContain('"mode":"raw"');
	});

	it("#given Codex subscription auth in pi #when executing web_search #then uses its own account and streaming endpoint without fallback", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => codexResponse());
		vi.stubGlobal("fetch", fetch);
		const { session } = await isolatedSession(true, false, "openai-codex");
		const result = await toolFor(session).execute("codex-native", { query: "runtime subscription search" });
		expect(JSON.stringify(result.details)).toContain('"stage":"native"');
		expect(JSON.stringify(result.details)).toContain('"provider":"openai-codex"');
		expect(fetch).toHaveBeenCalledOnce();
		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
			Authorization: `Bearer ${codexToken()}`,
			"chatgpt-account-id": "runtime-codex-account",
		});
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
			model: "first-alias",
			store: false,
			stream: true,
		});
	});

	it("#given a Codex session #when pi changes the model and credentials #then the next search uses the new model and account", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => codexResponse());
		vi.stubGlobal("fetch", fetch);
		const { session, modelRuntime } = await isolatedSession(false, false, "openai-codex");
		await toolFor(session).execute("codex-first", { query: "runtime search" });
		await modelRuntime.setRuntimeApiKey("openai-codex", codexToken("rotated-runtime-account"));
		const nextModel = modelRuntime.getModel("openai-codex", "second-alias");
		if (!nextModel) throw new Error("Second Codex model was not registered");
		await session.setModel(nextModel);
		await toolFor(session).execute("codex-second", { query: "runtime search" });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
			Authorization: `Bearer ${codexToken("rotated-runtime-account")}`,
			"chatgpt-account-id": "rotated-runtime-account",
		});
		expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ model: "second-alias" });
	});

	it("#given Codex subscription quota failures #when pi calls search twice #then both calls fall back without caching quota as unsupported", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = String(input);
			urls.push(url);
			return url.includes("chatgpt.com") ? codexResponse("insufficient_quota") : successPayload(false);
		});
		const { session } = await isolatedSession(false, false, "openai-codex");
		for (const id of ["first", "second"]) {
			const result = await toolFor(session).execute(id, { query: "runtime search" });
			expect(JSON.stringify(result.details)).toContain('"stage":"fallback"');
			expect(JSON.stringify(result.details)).toContain('"failureKind":"quota"');
		}
		expect(urls).toEqual([
			"https://chatgpt.com/backend-api/codex/responses",
			"https://fallback.example/search",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://fallback.example/search",
		]);
	});

	it("#given an active Codex subscription and raw enabled #when pi executes raw #then never reads subscription auth or calls its endpoint", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => successPayload(false));
		vi.stubGlobal("fetch", fetch);
		const { session, modelRuntime } = await isolatedSession(true, false, "openai-codex");
		const getAuth = vi.spyOn(modelRuntime, "getAuth");
		await toolFor(session).execute("codex-raw", { query: "runtime raw search", mode: "raw" });
		expect(getAuth).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://fallback.example/search");
	});

	it("#given fallback disabled inside the chain #when native fails through the real runtime #then still searches the configured engine", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = String(input);
			urls.push(url);
			return url.includes("native.example")
				? new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 })
				: successPayload(false);
		});
		const { session } = await isolatedSession(false, false);
		// when
		const result = await toolFor(session).execute("fallback-search", { query: "runtime search" });
		// then
		expect(urls).toEqual(["https://native.example/v1/responses", "https://fallback.example/search"]);
		expect(JSON.stringify(result.details)).toContain('"stage":"fallback"');
	});

	it("#given raw mode #when executing through the real runtime #then skips native auth and transport", async () => {
		// given
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			urls.push(String(input));
			return successPayload(false);
		});
		const { session, modelRuntime } = await isolatedSession(true);
		const getAuth = vi.spyOn(modelRuntime, "getAuth");
		// when
		await toolFor(session).execute("raw-search", { query: "runtime search", mode: "raw" });
		// then
		expect(getAuth).not.toHaveBeenCalled();
		expect(urls).toEqual(["https://fallback.example/search"]);
	});

	it("#given a bound session #when switching models #then the next native request uses the new model", async () => {
		// given
		const bodies: unknown[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return successPayload(true);
		});
		const { session, modelRuntime } = await isolatedSession(false);
		await toolFor(session).execute("first-search", { query: "runtime search" });
		const model = modelRuntime.getModel("test-gateway", "second-alias");
		if (!model) throw new Error("Second model was not registered");
		// when
		await session.setModel(model);
		await toolFor(session).execute("second-search", { query: "runtime search" });
		// then
		expect(bodies).toEqual([
			expect.objectContaining({ model: "first-alias" }),
			expect.objectContaining({ model: "second-alias" }),
		]);
	});
});
