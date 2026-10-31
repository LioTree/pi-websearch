import { mergeDomainFilters } from "../domains.js";
import type {
	BuiltSearchRequest,
	JsonObject,
	JsonValue,
	SearchProviderConfig,
	SearchRequest,
	SearchResultItem,
} from "../types.js";

export const SEARCH_INSTRUCTIONS =
	"Search the web and return a concise answer grounded only in the web results.\nInclude clickable source citations in the response text when possible.";

/** Keep provider citation targets intact when embedding them in Markdown. */
export function citationLink(label: string, url: string): string {
	const target = url.replace(
		/[\\\\()<>\s]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
	return `[${label}](${target})`;
}

export function chatCompletionAnswer(data: JsonObject): string | undefined {
	const choice = getObject(getArray(data["choices"])[0]);
	return getString(getObject(choice?.["message"])?.["content"]);
}

export interface BuildContext {
	config: SearchProviderConfig;
	request: SearchRequest;
	maxResults: number;
	allowedDomains: string[] | undefined;
	blockedDomains: string[] | undefined;
}

export interface ProviderModule {
	buildRequest(ctx: BuildContext): BuiltSearchRequest;
	normalizeResponse(data: JsonObject): SearchResultItem[];
	normalizeAnswer?(data: JsonObject): string | undefined;
}

export type HeaderSource = Record<string, string | null> | undefined;

const PRIMARY_AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key"]);
const GATEWAY_AUTH_HEADER_NAMES = new Set(["cf-aig-authorization"]);

/** Case-insensitive header merge preserving explicit null tombstones. */
export function mergeHeadersWithTombstones(...sources: HeaderSource[]): Record<string, string | null> {
	const merged = new Map<string, { name: string; value: string | null }>();
	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			merged.set(name.toLowerCase(), { name, value });
		}
	}
	return Object.fromEntries([...merged.values()].map(({ name, value }) => [name, value]));
}

/** Case-insensitive header merge. Later sources win; a null value deletes the header. */
export function mergeHeaders(...sources: HeaderSource[]): Record<string, string> {
	const merged = mergeHeadersWithTombstones(...sources);
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(merged)) {
		if (value !== null) headers[name] = value;
	}
	return headers;
}

export function getHeader(headers: Record<string, string>, name: string): string | undefined {
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected) return value;
	}
	return undefined;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
	const expected = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === expected) delete headers[key];
	}
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
	deleteHeader(headers, name);
	headers[name] = value;
}

/** Whether an explicit primary provider credential header is present (gateway auth does not count). */
export function hasPrimaryAuthHeader(headers: HeaderSource): boolean {
	if (!headers) return false;
	return Object.entries(headers).some(
		([name, value]) => PRIMARY_AUTH_HEADER_NAMES.has(name.toLowerCase()) && value !== null && value.trim().length > 0,
	);
}

/** Whether any usable auth header is present, including Cloudflare gateway auth. */
export function hasAuthHeader(headers: HeaderSource): boolean {
	if (!headers) return false;
	return Object.entries(headers).some(
		([name, value]) =>
			(PRIMARY_AUTH_HEADER_NAMES.has(name.toLowerCase()) || GATEWAY_AUTH_HEADER_NAMES.has(name.toLowerCase())) &&
			value !== null &&
			value.trim().length > 0,
	);
}

export function hasHeaderTombstone(headers: HeaderSource, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	return Object.entries(headers).some(([key, value]) => key.toLowerCase() === expected && value === null);
}

function defaultContentHeaders(): Record<string, string> {
	return { Accept: "application/json", "Content-Type": "application/json" };
}

export function contentHeaders(...sources: HeaderSource[]): Record<string, string> {
	return mergeHeaders(defaultContentHeaders(), ...sources);
}

function withAuthHeader(
	config: SearchProviderConfig,
	headerName: string,
	prefix: string,
	baseHeaders?: HeaderSource,
): Record<string, string> {
	const headers = mergeHeaders(baseHeaders ?? defaultContentHeaders());
	if (config.apiKey && !hasPrimaryAuthHeader(config.headers)) {
		setHeader(headers, headerName, `${prefix}${config.apiKey}`);
	}
	// Explicit headers are applied last so their values override generated defaults and null deletes.
	return mergeHeaders(headers, config.headers);
}

export function bearerHeaders(config: SearchProviderConfig, baseHeaders?: HeaderSource): Record<string, string> {
	return withAuthHeader(config, "Authorization", "Bearer ", baseHeaders);
}

export function keyedHeaders(
	config: SearchProviderConfig,
	headerName: string,
	baseHeaders?: HeaderSource,
): Record<string, string> {
	return withAuthHeader(config, headerName, "", baseHeaders);
}

const ANTHROPIC_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
const ANTHROPIC_CLI_VERSION = "2.1.0";

function mergeBetaList(existing: string | undefined, required: string): string {
	const values = [...(existing?.split(",") ?? []), ...required.split(",")]
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return [...new Set(values)].join(",");
}

export function isAnthropicOAuth(config: SearchProviderConfig): boolean {
	// Preserve OAuth request mode even when a gateway overrides the outgoing auth header.
	if (config.apiKey?.includes("sk-ant-oat")) return true;
	const headers = mergeHeaders(config.headers);
	const credential = getHeader(headers, "Authorization") ?? getHeader(headers, "x-api-key");
	return credential?.includes("sk-ant-oat") ?? false;
}

/** Anthropic API-key mode uses x-api-key; OAuth mode uses Bearer plus Claude Code identity headers. */
export function anthropicHeaders(config: SearchProviderConfig): Record<string, string> {
	const headers = mergeHeaders({ ...defaultContentHeaders(), "anthropic-version": "2023-06-01" });
	const oauth = isAnthropicOAuth(config);
	if (config.apiKey && !hasPrimaryAuthHeader(config.headers)) {
		setHeader(headers, oauth ? "Authorization" : "x-api-key", oauth ? `Bearer ${config.apiKey}` : config.apiKey);
	}
	if (oauth) {
		setHeader(headers, "user-agent", `claude-cli/${ANTHROPIC_CLI_VERSION}`);
		setHeader(headers, "x-app", "cli");
	}
	const merged = mergeHeaders(headers, config.headers);
	if (oauth && !hasHeaderTombstone(config.headers, "anthropic-beta")) {
		setHeader(merged, "anthropic-beta", mergeBetaList(getHeader(merged, "anthropic-beta"), ANTHROPIC_OAUTH_BETA));
	}
	return merged;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * Fold domain constraints into a provider query. Multiple allowed domains are ORed so
 * they remain alternatives rather than an impossible AND; blocked domains stay negative.
 * Adapters that can express filters natively should not also duplicate allowed scopes here.
 */
export function appendDomainFilters(query: string, allowedDomains?: string[], blockedDomains?: string[]): string {
	const parts = [query];
	const allowed = (allowedDomains ?? []).filter((domain) => domain.length > 0);
	if (allowed.length === 1) {
		parts.push(`site:${allowed[0]}`);
	} else if (allowed.length > 1) {
		parts.push(`(${allowed.map((domain) => `site:${domain}`).join(" OR ")})`);
	}
	for (const domain of blockedDomains ?? []) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

/**
 * Merge provider-entry policy with the request policy (which already includes global
 * constraints). Throw EmptyDomainPolicyError for an empty allowed intersection so the
 * caller can convert it to no-results before any network request.
 */
export function resolveDomainFilters(
	config: SearchProviderConfig,
	request: SearchRequest,
): { allowedDomains?: string[]; blockedDomains?: string[] } {
	return mergeDomainFilters(config, request);
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getObject(value: JsonValue | undefined): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function getArray(value: JsonValue | undefined): JsonValue[] {
	return Array.isArray(value) ? value : [];
}

export function getString(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function getNumber(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}

export function result(
	title: string | undefined,
	url: string | undefined,
	snippet?: string,
	source?: string,
	score?: number,
): SearchResultItem | null {
	if (!title || !url) return null;
	const item: SearchResultItem = { title, url };
	if (snippet) item.snippet = snippet;
	if (source) item.source = source;
	if (score !== undefined) item.score = score;
	return item;
}

/** Merge source evidence without replacing existing per-page snippets. */
export function uniqueSources(items: SearchResultItem[]): SearchResultItem[] {
	const sources = new Map<string, SearchResultItem>();
	for (const item of items) {
		if (!sources.has(item.url)) sources.set(item.url, item);
	}
	return [...sources.values()];
}

export function collect(items: Array<SearchResultItem | null>, max = 50): SearchResultItem[] {
	return items.filter((item): item is SearchResultItem => item !== null).slice(0, max);
}

export function parseObjectPayload(payload: unknown): JsonObject {
	if (isJsonObject(payload)) return payload;
	return {};
}
