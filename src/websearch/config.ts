import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isAllowedProviderBaseUrl } from "./provider-endpoints.js";
import { isDirectSearchProvider } from "./providers.js";
import type {
	CodexSearchMode,
	ConfigLoadResult,
	JsonObject,
	NativeSearchAdapter,
	NativeSearchOverride,
	ProviderValidationResult,
	RoutingStrategy,
	SearchContextSize,
	SearchPolicy,
	SearchProvider,
	SearchProviderConfig,
	SearchProviderEntry,
	SearchUserLocation,
	WebsearchConfig,
} from "./types.js";

const PROVIDERS: readonly SearchProvider[] = [
	"exa",
	"exa-mcp",
	"tavily",
	"serpdive",
	"brave",
	"duckduckgo-html",
	"serper",
	"google-cse",
	"deepseek",
	"z-ai",
	"openai",
	"openai-codex",
	"codex",
	"anthropic",
	"perplexity",
	"xai",
	"kimi",
	"kagi",
];
const CONTEXT_SIZES: readonly SearchContextSize[] = ["low", "medium", "high"];
const CODEX_MODES: readonly CodexSearchMode[] = ["cached", "live"];
const STRATEGIES: readonly RoutingStrategy[] = ["priority", "round-robin", "fill-first"];
const NATIVE_ADAPTERS: readonly NativeSearchAdapter[] = [
	"openai",
	"codex",
	"anthropic",
	"xai",
	"perplexity",
	"z-ai",
	"kimi",
	"deepseek",
];
const MAX_TIMER_MS = 2_147_483_647;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const NATIVE_OVERRIDE_KEYS = new Set(["adapter", "endpoint", "model"]);
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SINGLE_PROVIDER_ONLY_KEYS = [
	"apiKey",
	"backend",
	"baseUrl",
	"codexMode",
	"headers",
	"id",
	"model",
	"priority",
	"provider",
	"searchContextSize",
	"searchEngineId",
	"userLocation",
	"weight",
] as const;
const GLOBAL_CONFIG_KEYS = new Set([
	"strategy",
	"fallback",
	"auto",
	"rawMode",
	"providers",
	"nativeOverrides",
	"maxResults",
	"timeoutMs",
	"allowedDomains",
	"blockedDomains",
]);
const PROVIDER_ENTRY_KEYS = new Set([
	"provider",
	"backend",
	"id",
	"apiKey",
	"headers",
	"baseUrl",
	"searchEngineId",
	"maxResults",
	"model",
	"codexMode",
	"searchContextSize",
	"allowedDomains",
	"blockedDomains",
	"userLocation",
	"timeoutMs",
	"priority",
	"weight",
]);
const SINGLE_PROVIDER_CONFIG_KEYS = new Set([...GLOBAL_CONFIG_KEYS, ...PROVIDER_ENTRY_KEYS]);
const CREDENTIAL_HEADERS: Record<SearchProvider, readonly string[]> = {
	exa: ["x-api-key"],
	"exa-mcp": ["authorization", "x-api-key"],
	tavily: ["authorization"],
	serpdive: ["authorization"],
	brave: ["x-subscription-token"],
	"duckduckgo-html": [],
	serper: ["x-api-key"],
	"google-cse": [],
	deepseek: ["authorization"],
	"z-ai": ["authorization"],
	openai: ["authorization"],
	"openai-codex": ["authorization"],
	codex: ["authorization"],
	anthropic: ["authorization", "x-api-key"],
	perplexity: ["authorization"],
	xai: ["authorization"],
	kimi: ["authorization"],
	kagi: ["authorization"],
};

export interface ConfigLoadOptions {
	cwd: string;
	homeDir?: string;
}

type ConfigParseResult<TValue> = { ok: true; value: TValue } | { ok: false; message: string };

class ConfigParseError extends Error {}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<TValue extends string>(values: readonly TValue[], value: unknown): value is TValue {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function fieldPath(base: string, key: string): string {
	return base.length > 0 ? `${base}.${key}` : key;
}

function fail(path: string, message: string): never {
	throw new ConfigParseError(`${path} ${message}`);
}

function assertKnownKeys(raw: JsonObject, allowed: ReadonlySet<string>, base: string): void {
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) fail(fieldPath(base, key), "is not a supported configuration key.");
	}
}

function readOptionalString(raw: JsonObject, key: string, base: string): string | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		fail(fieldPath(base, key), "must be a non-empty string.");
	}
	return value.trim();
}

function readOptionalBoolean(raw: JsonObject, key: string, base: string): boolean | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") fail(fieldPath(base, key), "must be a boolean.");
	return value;
}

function readOptionalEnum<TValue extends string>(
	raw: JsonObject,
	key: string,
	base: string,
	values: readonly TValue[],
): TValue | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (!oneOf(values, value)) {
		fail(fieldPath(base, key), `must be one of: ${values.join(", ")}.`);
	}
	return value;
}

function readOptionalNumber(raw: JsonObject, key: string, base: string): number | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail(fieldPath(base, key), "must be a finite number.");
	}
	return value;
}

function readOptionalPositiveInteger(raw: JsonObject, key: string, base: string, maximum?: number): number | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		fail(fieldPath(base, key), "must be a positive safe integer.");
	}
	if (maximum !== undefined && value > maximum) {
		fail(fieldPath(base, key), `must be at most ${maximum} (the setTimeout limit).`);
	}
	return value;
}

function readOptionalDomainList(raw: JsonObject, key: string, base: string): string[] | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) fail(fieldPath(base, key), "must be an array of domains.");
	const domains: string[] = [];
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string" || item.trim().length === 0) {
			fail(`${fieldPath(base, key)}[${index}]`, "must be a non-empty string.");
		}
		domains.push(item.trim());
	}
	return domains;
}

function readOptionalHeaders(raw: JsonObject, key: string, base: string): Record<string, string | null> | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) fail(fieldPath(base, key), "must be an object of header values.");
	const headers: Record<string, string | null> = {};
	for (const [name, headerValue] of Object.entries(value)) {
		if (!HEADER_NAME.test(name) || RESERVED_OBJECT_KEYS.has(name)) {
			fail(`${fieldPath(base, key)}.${name}`, "is not a valid HTTP header name.");
		}
		if (headerValue === null) {
			headers[name] = null;
			continue;
		}
		if (typeof headerValue !== "string") {
			fail(`${fieldPath(base, key)}.${name}`, "must be a string or null.");
		}
		if (CONTROL_CHARACTER.test(headerValue)) {
			fail(`${fieldPath(base, key)}.${name}`, "must not contain control characters.");
		}
		headers[name] = headerValue;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function readOptionalLocation(raw: JsonObject, key: string, base: string): SearchUserLocation | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) fail(fieldPath(base, key), "must be an object.");
	const path = fieldPath(base, key);
	const location: SearchUserLocation = {};
	const country = readOptionalString(value, "country", path);
	const region = readOptionalString(value, "region", path);
	const city = readOptionalString(value, "city", path);
	const timezone = readOptionalString(value, "timezone", path);
	if (country !== undefined) location.country = country;
	if (region !== undefined) location.region = region;
	if (city !== undefined) location.city = city;
	if (timezone !== undefined) location.timezone = timezone;
	return Object.keys(location).length > 0 ? location : undefined;
}

function endpointProblem(endpoint: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch {
		return "must be a full public HTTPS URL without credentials.";
	}
	if (!isAllowedProviderBaseUrl(endpoint)) {
		return "must be a full public HTTPS URL without credentials.";
	}
	if (parsed.pathname === "/" || parsed.pathname.length === 0) {
		return "must include a full search endpoint path, not just a host.";
	}
	if (parsed.hash.length > 0) {
		return "must not include a URL fragment.";
	}
	return undefined;
}

function readOptionalNativeOverrides(
	raw: JsonObject,
	key: string,
	base: string,
): Record<string, NativeSearchOverride | false> | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) fail(fieldPath(base, key), "must be an object keyed by provider name.");
	const path = fieldPath(base, key);
	const overrides: Record<string, NativeSearchOverride | false> = {};
	for (const [providerName, overrideValue] of Object.entries(value)) {
		const overridePath = `${path}.${providerName}`;
		if (providerName.trim().length === 0) fail(overridePath, "must use a non-empty provider name.");
		if (RESERVED_OBJECT_KEYS.has(providerName)) fail(overridePath, "must use a normal provider name.");
		if (overrideValue === false) {
			overrides[providerName] = false;
			continue;
		}
		if (!isJsonObject(overrideValue)) fail(overridePath, "must be an object or false.");
		for (const overrideKey of Object.keys(overrideValue)) {
			if (!NATIVE_OVERRIDE_KEYS.has(overrideKey)) {
				fail(
					`${overridePath}.${overrideKey}`,
					"is not supported; native overrides inherit credentials from pi and must not repeat them.",
				);
			}
		}
		const adapter = readOptionalEnum(overrideValue, "adapter", overridePath, NATIVE_ADAPTERS);
		if (adapter === undefined)
			fail(`${overridePath}.adapter`, `is required and must be one of: ${NATIVE_ADAPTERS.join(", ")}.`);
		const endpoint = readOptionalString(overrideValue, "endpoint", overridePath);
		const model = readOptionalString(overrideValue, "model", overridePath);
		const override: NativeSearchOverride = { adapter };
		if (endpoint !== undefined) {
			const problem = endpointProblem(endpoint);
			if (problem) fail(`${overridePath}.endpoint`, problem);
			override.endpoint = endpoint;
		}
		if (model !== undefined) override.model = model;
		overrides[providerName] = override;
	}
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function providerEntryFromObject(
	raw: JsonObject,
	base: string,
	allowedKeys: ReadonlySet<string> = PROVIDER_ENTRY_KEYS,
): SearchProviderEntry {
	assertKnownKeys(raw, allowedKeys, base);
	const providerValue = raw["provider"];
	const backendValue = raw["backend"];
	if (providerValue !== undefined && backendValue !== undefined && providerValue !== backendValue) {
		fail(fieldPath(base, "provider"), "and backend must match when both are specified.");
	}
	const selected = providerValue ?? backendValue;
	const selectedKey = providerValue !== undefined ? "provider" : "backend";
	if (!oneOf(PROVIDERS, selected)) {
		fail(fieldPath(base, selectedKey), `must be one of: ${PROVIDERS.join(", ")}.`);
	}

	const config: SearchProviderEntry = { provider: selected };
	const id = readOptionalString(raw, "id", base);
	const apiKey = readOptionalString(raw, "apiKey", base);
	const baseUrl = readOptionalString(raw, "baseUrl", base);
	const searchEngineId = readOptionalString(raw, "searchEngineId", base);
	const maxResults = readOptionalPositiveInteger(raw, "maxResults", base);
	const model = readOptionalString(raw, "model", base);
	const codexMode = readOptionalEnum(raw, "codexMode", base, CODEX_MODES);
	const searchContextSize = readOptionalEnum(raw, "searchContextSize", base, CONTEXT_SIZES);
	const allowedDomains = readOptionalDomainList(raw, "allowedDomains", base);
	const blockedDomains = readOptionalDomainList(raw, "blockedDomains", base);
	const userLocation = readOptionalLocation(raw, "userLocation", base);
	const timeoutMs = readOptionalPositiveInteger(raw, "timeoutMs", base, MAX_TIMER_MS);
	const priority = readOptionalNumber(raw, "priority", base);
	const weight = readOptionalNumber(raw, "weight", base);
	const headers = readOptionalHeaders(raw, "headers", base);

	if (id !== undefined) config.id = id;
	if (apiKey !== undefined) config.apiKey = apiKey;
	if (headers !== undefined) config.headers = headers;
	if (baseUrl !== undefined) config.baseUrl = baseUrl;
	if (searchEngineId !== undefined) config.searchEngineId = searchEngineId;
	if (maxResults !== undefined) config.maxResults = maxResults;
	if (model !== undefined) config.model = model;
	if (codexMode !== undefined) config.codexMode = codexMode;
	if (searchContextSize !== undefined) config.searchContextSize = searchContextSize;
	if (allowedDomains !== undefined) config.allowedDomains = allowedDomains;
	if (blockedDomains !== undefined) config.blockedDomains = blockedDomains;
	if (userLocation !== undefined) config.userLocation = userLocation;
	if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
	if (priority !== undefined) config.priority = priority;
	if (weight !== undefined) config.weight = weight;

	return config;
}

function applyPolicy(config: WebsearchConfig, raw: JsonObject, base: string): void {
	const maxResults = readOptionalPositiveInteger(raw, "maxResults", base);
	const timeoutMs = readOptionalPositiveInteger(raw, "timeoutMs", base, MAX_TIMER_MS);
	const allowedDomains = readOptionalDomainList(raw, "allowedDomains", base);
	const blockedDomains = readOptionalDomainList(raw, "blockedDomains", base);
	if (maxResults !== undefined) config.maxResults = maxResults;
	if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
	if (allowedDomains !== undefined) config.allowedDomains = allowedDomains;
	if (blockedDomains !== undefined) config.blockedDomains = blockedDomains;
}

function configFromObject(raw: JsonObject): ConfigParseResult<WebsearchConfig> {
	try {
		const strategy = readOptionalEnum(raw, "strategy", "config", STRATEGIES) ?? "priority";
		const fallback = readOptionalBoolean(raw, "fallback", "config") ?? true;
		const auto = readOptionalBoolean(raw, "auto", "config") ?? true;
		const rawMode = readOptionalBoolean(raw, "rawMode", "config");
		const providersValue = raw["providers"];
		const hasSingleProvider = raw["provider"] !== undefined || raw["backend"] !== undefined;

		if (providersValue !== undefined && hasSingleProvider) {
			fail("config", "must not specify both provider/backend and providers.");
		}

		let providers: SearchProviderEntry[];
		if (providersValue !== undefined) {
			for (const key of SINGLE_PROVIDER_ONLY_KEYS) {
				if (raw[key] !== undefined) {
					fail(`config.${key}`, "belongs inside a providers entry when providers is used.");
				}
			}
			assertKnownKeys(raw, GLOBAL_CONFIG_KEYS, "config");
			if (!Array.isArray(providersValue) || providersValue.length === 0) {
				fail("config.providers", "must be a non-empty array of provider entries.");
			}
			providers = providersValue.map((entry, index) => {
				if (!isJsonObject(entry)) fail(`config.providers[${index}]`, "must be an object.");
				return providerEntryFromObject(entry, `config.providers[${index}]`);
			});
		} else if (hasSingleProvider) {
			providers = [providerEntryFromObject(raw, "config", SINGLE_PROVIDER_CONFIG_KEYS)];
		} else {
			assertKnownKeys(raw, SINGLE_PROVIDER_CONFIG_KEYS, "config");
			fail("config", "must specify provider (or backend), or a non-empty providers array.");
		}

		const config: WebsearchConfig = { strategy, fallback, auto, providers };
		if (rawMode !== undefined) config.rawMode = rawMode;
		applyPolicy(config, raw, "config");
		const nativeOverrides = readOptionalNativeOverrides(raw, "nativeOverrides", "config");
		if (nativeOverrides !== undefined) config.nativeOverrides = nativeOverrides;

		return { ok: true, value: config };
	} catch (error) {
		if (error instanceof ConfigParseError) return { ok: false, message: error.message };
		throw error;
	}
}

function parseJsonObject(content: string): JsonObject | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	return isJsonObject(parsed) ? parsed : null;
}

function hasApiKey(config: SearchProviderConfig): boolean {
	return typeof config.apiKey === "string" && config.apiKey.trim().length > 0;
}

function hasCredentialHeader(config: SearchProviderConfig): boolean {
	const names = CREDENTIAL_HEADERS[config.provider];
	return Object.entries(config.headers ?? {}).some(
		([name, value]) => names.includes(name.toLowerCase()) && typeof value === "string" && value.trim().length > 0,
	);
}

function hasCredentials(config: SearchProviderConfig): boolean {
	return hasApiKey(config) || hasCredentialHeader(config);
}

function headersProblem(headers: SearchProviderConfig["headers"]): string | undefined {
	if (headers === undefined) return undefined;
	if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
		return "Provider headers must be an object of header values.";
	}
	for (const [name, value] of Object.entries(headers)) {
		if (!HEADER_NAME.test(name) || RESERVED_OBJECT_KEYS.has(name)) return `Invalid provider header name: ${name}.`;
		if (value !== null && typeof value !== "string") return `Provider header ${name} must be a string or null.`;
		if (typeof value === "string" && CONTROL_CHARACTER.test(value)) {
			return `Provider header ${name} must not contain control characters.`;
		}
	}
	return undefined;
}

function policyProblem(policy: SearchPolicy, label: string): string | undefined {
	if (policy.maxResults !== undefined && (!Number.isSafeInteger(policy.maxResults) || policy.maxResults <= 0)) {
		return `${label} maxResults must be a positive safe integer.`;
	}
	if (
		policy.timeoutMs !== undefined &&
		(!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0 || policy.timeoutMs > MAX_TIMER_MS)
	) {
		return `${label} timeoutMs must be a positive integer no greater than ${MAX_TIMER_MS}.`;
	}
	for (const key of ["allowedDomains", "blockedDomains"] as const) {
		const domains = policy[key];
		if (
			domains !== undefined &&
			(!Array.isArray(domains) || domains.some((domain) => typeof domain !== "string" || domain.trim().length === 0))
		) {
			return `${label} ${key} must be an array of non-empty domains.`;
		}
	}
	if (policy.allowedDomains !== undefined && policy.blockedDomains !== undefined) {
		return `${label} cannot specify both allowedDomains and blockedDomains.`;
	}
	return undefined;
}

function nativeOverridesProblem(overrides: WebsearchConfig["nativeOverrides"]): string | undefined {
	if (overrides === undefined) return undefined;
	if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
		return "Websearch config nativeOverrides must be an object keyed by provider name.";
	}
	for (const [providerName, override] of Object.entries(overrides)) {
		if (providerName.trim().length === 0)
			return "Websearch config nativeOverrides keys must be non-empty provider names.";
		if (RESERVED_OBJECT_KEYS.has(providerName))
			return "Websearch config nativeOverrides keys must be normal provider names.";
		if (override === false) continue;
		if (typeof override !== "object" || override === null || Array.isArray(override)) {
			return `Websearch config nativeOverrides.${providerName} must be an object or false.`;
		}
		for (const key of Object.keys(override)) {
			if (!NATIVE_OVERRIDE_KEYS.has(key)) {
				return `Websearch config nativeOverrides.${providerName}.${key} is not supported; native overrides inherit credentials from pi.`;
			}
		}
		if (!oneOf(NATIVE_ADAPTERS, override.adapter)) {
			return `Websearch config nativeOverrides.${providerName}.adapter must be one of: ${NATIVE_ADAPTERS.join(", ")}.`;
		}
		if (override.endpoint !== undefined) {
			if (typeof override.endpoint !== "string" || override.endpoint.trim().length === 0) {
				return `Websearch config nativeOverrides.${providerName}.endpoint must be a full public HTTPS URL.`;
			}
			const problem = endpointProblem(override.endpoint.trim());
			if (problem) return `Websearch config nativeOverrides.${providerName}.endpoint ${problem}`;
		}
		if (override.model !== undefined && (typeof override.model !== "string" || override.model.trim().length === 0)) {
			return `Websearch config nativeOverrides.${providerName}.model must be a non-empty string.`;
		}
	}
	return undefined;
}

export function validateProviderConfig(config: SearchProviderEntry): ProviderValidationResult {
	if (!PROVIDERS.includes(config.provider)) {
		return { ok: false, reason: "invalid_config", message: `Unsupported provider: ${config.provider}` };
	}

	const policy = policyProblem(config, "Provider config");
	if (policy) return { ok: false, reason: "invalid_config", message: policy };

	const headers = headersProblem(config.headers);
	if (headers) return { ok: false, reason: "invalid_config", message: headers };

	if (config.weight !== undefined && (!Number.isFinite(config.weight) || config.weight <= 0)) {
		return { ok: false, reason: "invalid_config", message: "Provider weight must be greater than 0." };
	}

	if (config.priority !== undefined && !Number.isFinite(config.priority)) {
		return { ok: false, reason: "invalid_config", message: "Provider priority must be a finite number." };
	}

	if (config.baseUrl && !isAllowedProviderBaseUrl(config.baseUrl)) {
		return {
			ok: false,
			reason: "invalid_config",
			message: `Provider ${config.provider} baseUrl must be a public HTTPS URL without credentials.`,
		};
	}

	if (config.provider === "google-cse") {
		if (!config.searchEngineId || config.searchEngineId.trim().length === 0) {
			return { ok: false, reason: "missing_api_key", message: "Provider google-cse requires searchEngineId." };
		}
		if (!hasApiKey(config)) {
			return {
				ok: false,
				reason: "missing_api_key",
				message: "Provider google-cse requires apiKey; headers cannot replace the key query parameter.",
			};
		}
	}

	if (config.provider !== "duckduckgo-html" && config.provider !== "exa-mcp" && !hasCredentials(config)) {
		const suffix =
			config.provider === "codex" || config.provider === "openai" ? " for hosted Responses API search" : "";
		return {
			ok: false,
			reason: "missing_api_key",
			message: `Provider ${config.provider} requires apiKey or authentication headers${suffix}.`,
		};
	}

	return { ok: true, config };
}

export function validateWebsearchConfig(
	config: WebsearchConfig,
): ProviderValidationResult | { ok: true; config: WebsearchConfig } {
	if (!STRATEGIES.includes(config.strategy)) {
		return { ok: false, reason: "invalid_config", message: `Unsupported routing strategy: ${config.strategy}` };
	}
	if (typeof config.auto !== "boolean") {
		return { ok: false, reason: "invalid_config", message: "Websearch config auto must be a boolean." };
	}
	if (typeof config.fallback !== "boolean") {
		return { ok: false, reason: "invalid_config", message: "Websearch config fallback must be a boolean." };
	}
	if (config.rawMode !== undefined && typeof config.rawMode !== "boolean") {
		return { ok: false, reason: "invalid_config", message: "Websearch config rawMode must be a boolean." };
	}

	const policy = policyProblem(config, "Websearch config");
	if (policy) return { ok: false, reason: "invalid_config", message: policy };

	const nativeOverrides = nativeOverridesProblem(config.nativeOverrides);
	if (nativeOverrides) return { ok: false, reason: "invalid_config", message: nativeOverrides };

	if (!Array.isArray(config.providers) || config.providers.length === 0) {
		return { ok: false, reason: "invalid_config", message: "Websearch config requires at least one provider." };
	}

	for (const provider of config.providers) {
		const validation = validateProviderConfig(provider);
		if (!validation.ok) return validation;
	}

	if (config.rawMode === true && !config.providers.some((provider) => isDirectSearchProvider(provider))) {
		return {
			ok: false,
			reason: "invalid_config",
			message:
				"Websearch config rawMode requires at least one direct-search provider such as duckduckgo-html, brave, or exa.",
		};
	}

	return { ok: true, config };
}

/** Used only when no configuration file exists; explicit configs are never merged with this chain. */
export function defaultWebsearchConfig(): WebsearchConfig {
	return { strategy: "priority", fallback: true, auto: true, providers: [{ provider: "exa-mcp" }] };
}

export async function loadWebsearchConfig(options: ConfigLoadOptions): Promise<ConfigLoadResult> {
	const home = options.homeDir ?? homedir();
	const paths = [
		join(options.cwd, ".pi", "websearch.json"),
		join(home, "websearch.json"),
		join(home, ".pi", "websearch.json"),
	];

	for (const path of paths) {
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			const message = error instanceof Error ? error.message : "unknown read error";
			return { ok: false, reason: "invalid_config", message: `Cannot read ${path}: ${message}`, source: path };
		}
		const raw = parseJsonObject(content);
		if (!raw) {
			return { ok: false, reason: "invalid_config", message: `Invalid JSON object in ${path}`, source: path };
		}
		const parsed = configFromObject(raw);
		if (!parsed.ok) {
			return { ok: false, reason: "invalid_config", message: `${path}: ${parsed.message}`, source: path };
		}
		const validation = validateWebsearchConfig(parsed.value);
		if (!validation.ok) return { ...validation, source: path, message: `${path}: ${validation.message}` };
		return { ok: true, config: parsed.value, source: path };
	}

	return { ok: true, config: defaultWebsearchConfig(), source: "default" };
}
