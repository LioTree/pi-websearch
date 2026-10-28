import { type DomainPolicy, EmptyDomainPolicyError, isHostAllowedByPolicy, mergeDomainFilters } from "./domains.js";
import { CodexStreamError, readCodexResponse } from "./providers/codex-stream.js";
import { buildSearchRequest, normalizeSearchResponse } from "./providers.js";
import type {
	JsonObject,
	NativeRouteStatus,
	RoutingStrategy,
	SearchAttempt,
	SearchDetails,
	SearchFailureKind,
	SearchProviderEntry,
	SearchRequest,
	SearchResultItem,
	WebsearchConfig,
} from "./types.js";

const MAX_ERROR_DETAIL_LENGTH = 500;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
/** Finite wall-clock budget covering native auth resolution and every search attempt. */
export const SEARCH_TOTAL_BUDGET_MS = 180_000;
const MAX_RESULTS_LIMIT = 50;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function normalizeMaxResults(value: number | undefined): number {
	return clampInteger(value ?? 10, 1, MAX_RESULTS_LIMIT);
}

export function effectiveMaxResults(config: WebsearchConfig, request?: Pick<SearchRequest, "maxResults">): number {
	return normalizeMaxResults(config.maxResults ?? request?.maxResults);
}

function policyFrom(source: DomainPolicy): DomainPolicy {
	return {
		...(source.allowedDomains === undefined ? {} : { allowedDomains: source.allowedDomains }),
		...(source.blockedDomains === undefined ? {} : { blockedDomains: source.blockedDomains }),
	};
}

/**
 * Global policy wins over request policy and provider policy. Allowed scopes can
 * only narrow; blocked scopes union. An empty allowed intersection throws
 * EmptyDomainPolicyError before any provider is contacted.
 */
export function effectiveDomainFilters(
	config: Pick<WebsearchConfig, "allowedDomains" | "blockedDomains">,
	request: Pick<SearchRequest, "allowedDomains" | "blockedDomains">,
): DomainPolicy {
	return mergeDomainFilters(policyFrom(config), policyFrom(request));
}

/**
 * Validate the global/request policy before native auth or fetch. Provider-entry
 * conflicts are evaluated per attempt when that provider's request is built, so
 * a conflicting entry is skipped without preventing a valid fallback provider.
 */
export function validateDomainPolicies(
	config: Pick<WebsearchConfig, "allowedDomains" | "blockedDomains">,
	request: Pick<SearchRequest, "allowedDomains" | "blockedDomains">,
): void {
	effectiveDomainFilters(config, request);
}

export function domainPolicyFailure(
	config: WebsearchConfig,
	request: SearchRequest,
	error: EmptyDomainPolicyError,
	options: { mode?: "normal" | "raw"; nativeStatus?: NativeRouteStatus; startedAt?: number } = {},
): SearchDetails {
	const startedAt = options.startedAt ?? Date.now();
	const details: SearchDetails = {
		provider: config.providers[0]?.provider ?? "exa",
		query: request.query,
		results: [],
		durationMs: Date.now() - startedAt,
		truncated: false,
		error: `${error.message}; no search was performed.`,
		failureKind: "no-results",
		strategy: config.strategy,
		stage: "fallback",
		mode: options.mode ?? "normal",
		...(options.nativeStatus ? { native: options.nativeStatus } : {}),
	};
	const first = config.providers[0];
	if (first?.id !== undefined) details.entryId = first.id;
	return details;
}

function effectiveRequest(config: WebsearchConfig, request: SearchRequest): SearchRequest {
	return {
		...request,
		maxResults: effectiveMaxResults(config, request),
		...effectiveDomainFilters(config, request),
	};
}

const CREDENTIAL_HEADER_NAME =
	/(?:^|[-_])(?:authorization|api[-_]?key|apikey|subscription[-_]?token|token|secret|password|passwd|credential|account[-_]?id|key)(?:[-_]|$)/i;
const ENDPOINT_SECRET_QUERY_NAME =
	/(?:^|[-_])(?:access[-_]?token|api[-_]?key|apikey|auth|authorization|key|password|passwd|secret|sig|signature|token|client[-_]?secret|subscription[-_]?key|private[-_]?key)(?:[-_]|$)/i;
const DIAGNOSTIC_SECRET_QUERY =
	/([?&](?:access_token|api_key|apikey|auth|authorization|key|password|secret|sig|signature|token)=)[^&\s)"']+/gi;

function addSecretValue(secrets: Set<string>, value: string | null | undefined): void {
	if (!value) return;
	const candidates = [value];
	const authMatch = value.match(/^(?:Bearer|Basic|Token)\s+(.+)$/i);
	if (authMatch?.[1]) candidates.push(authMatch[1].trim());
	for (const candidate of candidates) {
		if (candidate.length >= 4) secrets.add(candidate);
	}
}

function secretsFromUrl(value: string | undefined): Set<string> {
	const secrets = new Set<string>();
	if (!value) return secrets;
	try {
		const parsed = new URL(value);
		for (const [key, parameterValue] of parsed.searchParams.entries()) {
			if (ENDPOINT_SECRET_QUERY_NAME.test(key)) addSecretValue(secrets, parameterValue);
		}
	} catch {
		// Not a URL; there is nothing reliable to extract.
	}
	return secrets;
}

function collectSecrets(
	config: SearchProviderEntry | undefined,
	endpoint: string | undefined,
	builtHeaders?: Record<string, string>,
): Set<string> {
	const secrets = new Set<string>();
	if (config?.apiKey) addSecretValue(secrets, config.apiKey);
	for (const headers of [config?.headers, builtHeaders]) {
		for (const [name, headerValue] of Object.entries(headers ?? {})) {
			if (CREDENTIAL_HEADER_NAME.test(name)) addSecretValue(secrets, headerValue);
		}
	}
	for (const secret of secretsFromUrl(config?.baseUrl)) secrets.add(secret);
	for (const secret of secretsFromUrl(endpoint)) secrets.add(secret);
	return secrets;
}

/** Redact only values known to be credentials. Never applies name/word heuristics. */
function redactKnownSecrets(value: string, secrets: ReadonlySet<string>): string {
	let result = value;
	for (const secret of secrets) result = result.split(secret).join("[redacted]");
	return result;
}

/** Diagnostics may additionally redact recognizable token shapes and credential query names. */
function redactDiagnostic(value: string, secrets: ReadonlySet<string>): string {
	return redactKnownSecrets(value, secrets)
		.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
		.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted]")
		.replace(DIAGNOSTIC_SECRET_QUERY, "$1[redacted]");
}

function sanitizeUrl(value: string, secrets: ReadonlySet<string>): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

	let changed = Boolean(parsed.username || parsed.password);
	if (changed) {
		parsed.username = "";
		parsed.password = "";
	}

	// Redact a query value only when it contains an actual known credential.
	// Benign parameters such as ?key=configuration remain byte-for-byte intact.
	for (const [key, parameterValue] of [...parsed.searchParams.entries()]) {
		if ([...secrets].some((secret) => parameterValue.includes(secret))) {
			parsed.searchParams.set(key, "[redacted]");
			changed = true;
		}
	}

	const redactedRaw = redactKnownSecrets(value, secrets);
	if (!changed) return redactedRaw;
	return redactKnownSecrets(parsed.href, secrets);
}

function sanitizeResultItem(item: SearchResultItem, secrets: ReadonlySet<string>): SearchResultItem | undefined {
	const url = sanitizeUrl(item.url, secrets);
	if (!url) return undefined;
	const sanitized: SearchResultItem = {
		title: redactKnownSecrets(item.title, secrets),
		url,
	};
	if (item.snippet !== undefined) sanitized.snippet = redactKnownSecrets(item.snippet, secrets);
	if (item.score !== undefined) sanitized.score = item.score;
	if (item.source !== undefined) sanitized.source = redactKnownSecrets(item.source, secrets);
	if (item.publishedAt !== undefined) sanitized.publishedAt = redactKnownSecrets(item.publishedAt, secrets);
	return sanitized;
}

function sanitizeDiagnostic(value: string, secrets: ReadonlySet<string>): string {
	return truncate(redactDiagnostic(value, secrets), MAX_ERROR_DETAIL_LENGTH);
}

function extractErrorDetail(payload: unknown, bodyText: string): string {
	if (isJsonObject(payload)) {
		const obj = payload;
		const error = obj["error"];
		if (typeof error === "string" && error.length > 0) return error;
		if (isJsonObject(error)) {
			const message = error["message"];
			if (typeof message === "string" && message.length > 0) return message;
			const detail = error["detail"];
			if (typeof detail === "string" && detail.length > 0) return detail;
		}
		const message = obj["message"];
		if (typeof message === "string" && message.length > 0) return message;
		const detail = obj["detail"];
		if (typeof detail === "string" && detail.length > 0) return detail;
	}
	const trimmed = bodyText.trim();
	if (!trimmed) return "";
	return trimmed;
}

function httpErrorMessage(status: number, payload: unknown, bodyText: string, secrets: ReadonlySet<string>): string {
	const detail = sanitizeDiagnostic(extractErrorDetail(payload, bodyText), secrets);
	return detail ? `Search failed with HTTP ${status}: ${detail}` : `Search failed with HTTP ${status}`;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortReason(signal);
}

function isTimeoutError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError") return true;
	return error instanceof Error && (error.name === "TimeoutError" || /timed out after \d+ms/i.test(error.message));
}

function providerTimeoutMs(config: SearchProviderEntry, globalTimeoutMs: number): number {
	const configured = config.timeoutMs === undefined ? globalTimeoutMs : Math.min(config.timeoutMs, globalTimeoutMs);
	return Math.max(1, Math.trunc(configured));
}

function searchAbortSignal(
	outerSignal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	throwIfAborted(outerSignal);

	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new DOMException(`Search timed out after ${timeoutMs}ms`, "TimeoutError"));
	}, timeoutMs);
	const onAbort = () => controller.abort(outerSignal ? abortReason(outerSignal) : undefined);
	outerSignal?.addEventListener("abort", onAbort, { once: true });

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			outerSignal?.removeEventListener("abort", onAbort);
		},
	};
}

function providerLabelForFailure(config: SearchProviderEntry | undefined): SearchProviderEntry["provider"] {
	return config?.provider ?? "exa";
}

function failureDetails(
	config: SearchProviderEntry | undefined,
	request: SearchRequest,
	startedAt: number,
	failureKind: SearchFailureKind,
	error: string,
	httpStatus?: number,
	stage?: SearchDetails["stage"],
	secrets: ReadonlySet<string> = new Set<string>(),
): SearchDetails {
	const details: SearchDetails = {
		provider: providerLabelForFailure(config),
		query: request.query,
		results: [],
		durationMs: Date.now() - startedAt,
		truncated: false,
		error: sanitizeDiagnostic(error, secrets),
		failureKind,
		...(httpStatus === undefined ? {} : { httpStatus }),
		...(stage ? { stage } : {}),
	};
	if (config?.id !== undefined) details.entryId = config.id;
	return details;
}

function explicitUnsupportedFailure(status: number, detail: string): boolean {
	if (status !== 400 && status !== 404) return false;
	const text = detail.replace(/["'`]/g, "");
	const tool = "(?:web[_ -]?search(?:[_ -]?preview)?|hosted search|search (?:tool|endpoint))";
	// Invalid search arguments do not prove that the model lacks search capability.
	return [
		new RegExp(`\\b${tool}(?:\\s+tool)?\\s+(?:is\\s+)?(?:not supported|not available|not found|unsupported)\\b`, "i"),
		new RegExp(`\\b(?:unsupported|unknown|unrecognized)\\s+tool(?:\\s+type)?\\s*:?\\s*${tool}\\b`, "i"),
		new RegExp(`\\b(?:model|endpoint)\\b[^.\\n]{0,100}\\bdoes not support\\s+(?:the\\s+)?${tool}\\b`, "i"),
	].some((pattern) => pattern.test(text));
}

function classifyHttpFailure(status: number, detail: string): SearchFailureKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 402 || status === 429) return "quota";
	if (status === 408 || status === 504) return "timeout";
	if (status >= 500) return "network";
	if (explicitUnsupportedFailure(status, detail)) return "unsupported";
	return "request";
}

function codexStreamFailureKind(error: CodexStreamError): SearchFailureKind {
	if (!error.upstream) return "invalid-response";
	if (error.status !== undefined) return classifyHttpFailure(error.status, error.message);
	const code = error.code ?? "";
	if (/quota|rate_limit|usage_limit|usage_not_included|usage.*limit/i.test(code)) return "quota";
	if (/invalid_api_key|invalid_token|authentication|unauthorized|token_expired/i.test(code)) return "auth";
	if (/permission_denied|forbidden/i.test(code)) return "auth";
	if (/timeout|timed_out/i.test(code)) return "timeout";
	if (/server_error|internal_error|overloaded|service_unavailable/i.test(code)) return "network";
	return classifyHttpFailure(400, error.message);
}

function hasStructuredRefusal(value: unknown, depth = 0): boolean {
	if (depth > 6) return false;
	if (Array.isArray(value)) return value.some((item) => hasStructuredRefusal(item, depth + 1));
	if (!isJsonObject(value)) return false;
	for (const [key, field] of Object.entries(value)) {
		if (key === "refusal" && (field === true || (typeof field === "string" && field.trim().length > 0))) return true;
		if ((key === "stop_reason" || key === "finish_reason") && (field === "refusal" || field === "content_filter")) {
			return true;
		}
		if (key === "type" && field === "refusal") return true;
		if (hasStructuredRefusal(field, depth + 1)) return true;
	}
	return false;
}

function domainFiltersForEntry(entry: SearchProviderEntry, request: SearchRequest): DomainPolicy {
	return mergeDomainFilters(policyFrom(request), policyFrom(entry));
}

function resultAllowedByDomains(url: string, filters: DomainPolicy): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return false;
	}
	return isHostAllowedByPolicy(hostname, filters);
}

function normalizeResults(
	provider: SearchProviderEntry["provider"],
	payload: unknown,
	secrets: ReadonlySet<string>,
	filters: DomainPolicy,
): { results: SearchResultItem[]; invalid: number; filtered: number } {
	const raw = normalizeSearchResponse(provider, payload);
	let invalid = 0;
	let filtered = 0;
	const results: SearchResultItem[] = [];
	for (const item of raw) {
		const sanitized = sanitizeResultItem(item, secrets);
		if (!sanitized) {
			invalid += 1;
			continue;
		}
		if (!resultAllowedByDomains(sanitized.url, filters)) {
			filtered += 1;
			continue;
		}
		results.push(sanitized);
	}
	return { results, invalid, filtered };
}

export interface SearchRoutingState {
	roundRobinCursor: number;
	successCounts: number[];
}

export function createSearchRoutingState(providerCount: number): SearchRoutingState {
	return { roundRobinCursor: 0, successCounts: Array.from({ length: providerCount }, () => 0) };
}

export function providerEntryLabel(entry: {
	readonly provider: string;
	readonly id?: string;
	readonly entryId?: string;
}): string {
	const id = entry.entryId ?? entry.id;
	if (!id || id === entry.provider) return entry.provider;
	const nativePrefix = `native-${entry.provider}-`;
	return `${entry.provider}/${id.startsWith(nativePrefix) ? "native" : id}`;
}

function sortedPriorityIndices(providers: SearchProviderEntry[]): number[] {
	return providers
		.map((provider, index) => ({ index, priority: provider.priority ?? index }))
		.sort((left, right) => left.priority - right.priority || left.index - right.index)
		.map((item) => item.index);
}

function providerWeight(provider: SearchProviderEntry, providerCount: number): number {
	const raw = provider.weight ?? 1;
	if (!Number.isFinite(raw)) return 1;
	const cap = Math.max(1, Math.floor(Number.MAX_SAFE_INTEGER / Math.max(1, providerCount)));
	return Math.min(cap, Math.max(1, Math.trunc(raw)));
}

function weightedTotal(providers: SearchProviderEntry[]): number {
	let total = 0;
	for (const provider of providers) total += providerWeight(provider, providers.length);
	return total;
}

function weightedOrder(providers: SearchProviderEntry[], cursor: number): number[] {
	const count = providers.length;
	if (count === 0) return [];
	const weights = providers.map((provider) => providerWeight(provider, count));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	if (total <= 0) return providers.map((_provider, index) => index);
	const normalizedCursor = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
	const position = ((normalizedCursor % total) + total) % total;
	let cumulative = 0;
	let start = 0;
	for (let index = 0; index < weights.length; index += 1) {
		cumulative += weights[index] ?? 0;
		if (position < cumulative) {
			start = index;
			break;
		}
	}
	return Array.from({ length: count }, (_value, offset) => (start + offset) % count);
}

function selectOrder(strategy: RoutingStrategy, providers: SearchProviderEntry[], state: SearchRoutingState): number[] {
	if (strategy === "priority") return sortedPriorityIndices(providers);
	if (strategy === "round-robin") return weightedOrder(providers, state.roundRobinCursor);

	let selected = 0;
	let selectedCount = state.successCounts[0] ?? 0;
	for (let index = 1; index < providers.length; index += 1) {
		const count = state.successCounts[index] ?? 0;
		if (count < selectedCount) {
			selected = index;
			selectedCount = count;
		}
	}
	return [selected, ...providers.map((_provider, index) => index).filter((index) => index !== selected)];
}

function advanceRoundRobin(
	strategy: RoutingStrategy,
	providers: SearchProviderEntry[],
	state: SearchRoutingState,
): void {
	if (strategy !== "round-robin") return;
	const total = weightedTotal(providers);
	if (total > 0) state.roundRobinCursor = (state.roundRobinCursor + 1) % total;
}

export interface ProviderSearchOptions {
	timeoutMs?: number;
	deadline?: number;
	stage?: "native" | "fallback";
}

function entryWithNarrowedLimit(config: SearchProviderEntry, maxResults: number): SearchProviderEntry {
	if (config.maxResults === undefined) return config;
	return { ...config, maxResults: Math.max(1, Math.min(config.maxResults, maxResults)) };
}

export async function performProviderSearch(
	config: SearchProviderEntry,
	request: SearchRequest,
	signal?: AbortSignal,
	options: ProviderSearchOptions = {},
): Promise<SearchDetails> {
	throwIfAborted(signal);
	const startedAt = Date.now();
	const baseSecrets = collectSecrets(config, undefined);
	const globalTimeout = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS));
	const remaining = options.deadline === undefined ? globalTimeout : options.deadline - startedAt;
	if (remaining <= 0) {
		return failureDetails(
			config,
			request,
			startedAt,
			"timeout",
			`Search budget exhausted before provider ${providerEntryLabel(config)}`,
			undefined,
			options.stage,
			baseSecrets,
		);
	}
	const timeoutMs = Math.min(providerTimeoutMs(config, globalTimeout), remaining);
	const abort = searchAbortSignal(signal, timeoutMs);

	let built: ReturnType<typeof buildSearchRequest>;
	try {
		built = buildSearchRequest(entryWithNarrowedLimit(config, request.maxResults), request);
	} catch (error) {
		abort.cleanup();
		if (error instanceof EmptyDomainPolicyError) {
			return failureDetails(
				config,
				request,
				startedAt,
				"no-results",
				`${error.message}; no search was performed.`,
				undefined,
				options.stage,
				baseSecrets,
			);
		}
		return failureDetails(
			config,
			request,
			startedAt,
			"request",
			error instanceof Error ? error.message : "Search request construction failed",
			undefined,
			options.stage,
			baseSecrets,
		);
	}

	const secrets = collectSecrets(config, built.url, built.init.headers);
	let response: Response;
	try {
		const init: RequestInit = {
			...built.init,
			signal: abort.signal,
			redirect: "error",
		};
		if (built.body !== undefined) init.body = JSON.stringify(built.body);
		response = await fetch(built.url, init);
	} catch (error) {
		abort.cleanup();
		if (signal?.aborted) throw abortReason(signal);
		const failureKind: SearchFailureKind = isTimeoutError(error, abort.signal) ? "timeout" : "network";
		return failureDetails(
			config,
			request,
			startedAt,
			failureKind,
			error instanceof Error ? error.message : "Search request failed",
			undefined,
			options.stage,
			secrets,
		);
	}

	let bodyText = "";
	let streamedPayload: JsonObject | undefined;
	try {
		if (
			response.ok &&
			(built.responseFormat === "codex-sse" ||
				(built.responseFormat === "responses-sse" &&
					response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"))
		) {
			streamedPayload = await readCodexResponse(response, abort.signal);
		} else {
			bodyText = await response.text();
		}
	} catch (error) {
		abort.cleanup();
		if (signal?.aborted) throw abortReason(signal);
		const failureKind: SearchFailureKind = isTimeoutError(error, abort.signal)
			? "timeout"
			: error instanceof CodexStreamError
				? codexStreamFailureKind(error)
				: "network";
		return failureDetails(
			config,
			request,
			startedAt,
			failureKind,
			error instanceof Error ? error.message : "Search response read failed",
			error instanceof CodexStreamError ? response.status : undefined,
			options.stage,
			secrets,
		);
	} finally {
		abort.cleanup();
	}

	throwIfAborted(signal);

	let payload: unknown = {};
	let payloadIsStructured = false;
	if (streamedPayload !== undefined) {
		payload = streamedPayload;
		payloadIsStructured = true;
	} else if (config.provider === "duckduckgo-html") {
		payload = { html: bodyText };
		payloadIsStructured = bodyText.trim().length > 0;
	} else if (bodyText.trim().length === 0) {
		payload = {};
	} else {
		try {
			payload = JSON.parse(bodyText);
			payloadIsStructured = isJsonObject(payload);
		} catch {
			payload = {};
		}
	}

	if (!response.ok) {
		const detail = extractErrorDetail(payload, bodyText);
		const failureKind = classifyHttpFailure(response.status, detail);
		return failureDetails(
			config,
			request,
			startedAt,
			failureKind,
			httpErrorMessage(response.status, payload, bodyText, secrets),
			response.status,
			options.stage,
			secrets,
		);
	}

	if (!payloadIsStructured) {
		return failureDetails(
			config,
			request,
			startedAt,
			"invalid-response",
			`Search provider ${providerEntryLabel(config)} returned an empty or invalid response body.`,
			response.status,
			options.stage,
			secrets,
		);
	}

	let normalized: { results: SearchResultItem[]; invalid: number; filtered: number };
	try {
		normalized = normalizeResults(config.provider, payload, secrets, domainFiltersForEntry(config, request));
	} catch (error) {
		if (error instanceof EmptyDomainPolicyError) {
			return failureDetails(
				config,
				request,
				startedAt,
				"no-results",
				error.message,
				response.status,
				options.stage,
				secrets,
			);
		}
		return failureDetails(
			config,
			request,
			startedAt,
			"invalid-response",
			error instanceof Error ? error.message : "Search response normalization failed",
			response.status,
			options.stage,
			secrets,
		);
	}

	if (normalized.results.length === 0) {
		if (isJsonObject(payload) && (payload["error"] !== undefined || payload["success"] === false)) {
			const detail = extractErrorDetail(payload, bodyText);
			return failureDetails(
				config,
				request,
				startedAt,
				"request",
				detail
					? `Search provider ${providerEntryLabel(config)} returned an error: ${detail}`
					: `Search provider ${providerEntryLabel(config)} returned an error payload.`,
				response.status,
				options.stage,
				secrets,
			);
		}
		if (hasStructuredRefusal(payload)) {
			return failureDetails(
				config,
				request,
				startedAt,
				"refusal",
				`Search provider ${providerEntryLabel(config)} returned a refusal for "${request.query}".`,
				response.status,
				options.stage,
				secrets,
			);
		}
		if (normalized.filtered > 0) {
			return failureDetails(
				config,
				request,
				startedAt,
				"no-results",
				`Search provider ${providerEntryLabel(config)} returned no results after domain filters for "${request.query}".`,
				response.status,
				options.stage,
				secrets,
			);
		}
		if (normalized.invalid > 0) {
			return failureDetails(
				config,
				request,
				startedAt,
				"invalid-response",
				`Search provider ${providerEntryLabel(config)} returned no usable source URLs.`,
				response.status,
				options.stage,
				secrets,
			);
		}
		return failureDetails(
			config,
			request,
			startedAt,
			"no-results",
			`Search provider ${providerEntryLabel(config)} returned no results for "${request.query}".`,
			response.status,
			options.stage,
			secrets,
		);
	}

	throwIfAborted(signal);
	const results = normalized.results.slice(0, request.maxResults);
	const details: SearchDetails = {
		provider: config.provider,
		query: request.query,
		results,
		durationMs: Date.now() - startedAt,
		truncated: normalized.results.length > request.maxResults,
	};
	if (config.id !== undefined) details.entryId = config.id;
	if (options.stage) details.stage = options.stage;
	return details;
}

function attemptFromDetails(details: SearchDetails, stage?: "native" | "fallback"): SearchAttempt {
	const attempt: SearchAttempt = {
		provider: details.provider,
		durationMs: details.durationMs,
		resultsCount: details.results.length,
	};
	if (details.entryId) attempt.entryId = details.entryId;
	if (details.error) attempt.error = details.error;
	if (details.failureKind) attempt.failureKind = details.failureKind;
	if (details.httpStatus !== undefined) attempt.httpStatus = details.httpStatus;
	if (stage) attempt.stage = stage;
	return attempt;
}

export type SearchAttemptListener = (
	providerLabel: string,
	attempts: readonly SearchAttempt[],
	routeLabels: readonly string[],
) => void;

export interface PerformSearchOptions {
	nativeEntry?: SearchProviderEntry;
	nativeStatus?: NativeRouteStatus;
	mode?: "normal" | "raw";
	onAttempt?: SearchAttemptListener;
	initialAttempts?: SearchAttempt[];
	startedAt?: number;
	deadline?: number;
}

function aggregateFailureKind(attempts: SearchAttempt[]): SearchFailureKind {
	const kinds = attempts
		.map((attempt) => attempt.failureKind)
		.filter((kind): kind is SearchFailureKind => kind !== undefined);
	if (kinds.length === 0) return "request";
	const first = kinds[0];
	return first !== undefined && kinds.every((kind) => kind === first) ? first : "request";
}

function aggregateError(attempts: SearchAttempt[]): string {
	const detail = attempts.map((attempt) => `${providerEntryLabel(attempt)} ${attempt.error ?? "failed"}`).join("; ");
	return detail ? `All search providers failed: ${detail}` : "All search providers failed.";
}

function successWithAttempts(
	details: SearchDetails,
	attempts: SearchAttempt[],
	native: NativeRouteStatus | undefined,
	mode: "normal" | "raw",
	strategy: RoutingStrategy,
	durationMs: number,
): SearchDetails {
	return {
		...details,
		durationMs,
		strategy,
		mode,
		...(native ? { native } : {}),
		attempts: [...attempts],
	};
}

export async function performSearch(
	config: WebsearchConfig,
	request: SearchRequest,
	signal?: AbortSignal,
	routingState?: SearchRoutingState,
	onAttempt?: SearchAttemptListener,
	options: PerformSearchOptions = {},
): Promise<SearchDetails> {
	throwIfAborted(signal);
	const startedAt = options.startedAt ?? Date.now();
	const deadline = options.deadline ?? startedAt + SEARCH_TOTAL_BUDGET_MS;
	let effective: SearchRequest;
	try {
		validateDomainPolicies(config, request);
		effective = effectiveRequest(config, request);
	} catch (error) {
		if (error instanceof EmptyDomainPolicyError) {
			const nativeStatus = options.nativeStatus
				? {
						...options.nativeStatus,
						status: "skipped" as const,
						reason: "domain policy excludes all sources",
					}
				: undefined;
			return domainPolicyFailure(config, request, error, {
				...(options.mode === undefined ? {} : { mode: options.mode }),
				...(nativeStatus === undefined ? {} : { nativeStatus }),
				startedAt,
			});
		}
		throw error;
	}
	const state = routingState ?? createSearchRoutingState(config.providers.length);
	const order = selectOrder(config.strategy, config.providers, state);
	const attempts: SearchAttempt[] = [...(options.initialAttempts ?? [])];
	const attemptListener = options.onAttempt ?? onAttempt;
	const chainLabels = order.flatMap((index) => {
		const provider = config.providers[index];
		return provider ? [providerEntryLabel(provider)] : [];
	});
	const routeLabels = options.nativeEntry ? [providerEntryLabel(options.nativeEntry), ...chainLabels] : chainLabels;
	const collected = new Map<string, SearchResultItem>();
	let firstSuccessfulDetails: SearchDetails | undefined;
	let nativeStatus = options.nativeStatus;
	const mode = options.mode ?? "normal";

	const requestForEntry = (entry: SearchProviderEntry): SearchRequest =>
		entry.maxResults === undefined
			? effective
			: { ...effective, maxResults: Math.max(1, Math.min(effective.maxResults, entry.maxResults)) };

	let enteredFallback = false;
	const enterFallback = (): void => {
		if (enteredFallback) return;
		enteredFallback = true;
		advanceRoundRobin(config.strategy, config.providers, state);
	};

	if (options.nativeEntry) {
		throwIfAborted(signal);
		attemptListener?.(providerEntryLabel(options.nativeEntry), attempts, routeLabels);
		const nativeDetails = await performProviderSearch(
			options.nativeEntry,
			requestForEntry(options.nativeEntry),
			signal,
			{
				...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
				deadline,
				stage: "native",
			},
		);
		attempts.push(attemptFromDetails(nativeDetails, "native"));
		if (!nativeDetails.error && nativeDetails.results.length > 0) {
			return {
				...nativeDetails,
				durationMs: Date.now() - startedAt,
				strategy: config.strategy,
				mode,
				...(nativeStatus ? { native: nativeStatus } : {}),
				attempts: [...attempts],
			};
		}
		nativeStatus = {
			...(nativeStatus ?? { status: "ready" }),
			status: "skipped",
			reason: nativeDetails.error ?? "native search returned no results",
		};
		enterFallback();
	} else {
		enterFallback();
	}

	for (const index of order) {
		throwIfAborted(signal);
		const provider = config.providers[index];
		if (!provider) continue;
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			attempts.push({
				provider: provider.provider,
				...(provider.id ? { entryId: provider.id } : {}),
				durationMs: 0,
				resultsCount: 0,
				error: "Search budget exhausted before this provider.",
				failureKind: "timeout",
				stage: "fallback",
			});
			continue;
		}
		attemptListener?.(providerEntryLabel(provider), attempts, routeLabels);
		const details = await performProviderSearch(provider, requestForEntry(provider), signal, {
			...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
			deadline,
			stage: "fallback",
		});
		attempts.push(attemptFromDetails(details, "fallback"));

		if (details.error) {
			if (!config.fallback) break;
			continue;
		}

		state.successCounts[index] = (state.successCounts[index] ?? 0) + 1;
		if (config.strategy !== "fill-first") {
			return successWithAttempts(details, attempts, nativeStatus, mode, config.strategy, Date.now() - startedAt);
		}

		firstSuccessfulDetails ??= details;
		for (const item of details.results) {
			if (collected.size >= effective.maxResults) break;
			collected.set(item.url, item);
		}
		if (collected.size >= effective.maxResults) break;
	}

	if (collected.size > 0 && firstSuccessfulDetails) {
		const results = [...collected.values()];
		return {
			provider: firstSuccessfulDetails.provider,
			...(firstSuccessfulDetails.entryId ? { entryId: firstSuccessfulDetails.entryId } : {}),
			query: effective.query,
			results,
			durationMs: Date.now() - startedAt,
			truncated: results.length >= effective.maxResults,
			strategy: config.strategy,
			stage: "fallback",
			mode,
			...(nativeStatus ? { native: nativeStatus } : {}),
			attempts: [...attempts],
		};
	}

	const fallbackProvider = config.providers[0]?.provider ?? "exa";
	const error = aggregateError(attempts);
	const lastAttempt = attempts.at(-1);
	return {
		provider: lastAttempt?.provider ?? fallbackProvider,
		...(lastAttempt?.entryId === undefined ? {} : { entryId: lastAttempt.entryId }),
		query: effective.query,
		results: [],
		durationMs: Date.now() - startedAt,
		truncated: false,
		strategy: config.strategy,
		stage: "fallback",
		mode,
		...(nativeStatus ? { native: nativeStatus } : {}),
		attempts: [...attempts],
		error,
		failureKind: aggregateFailureKind(attempts),
		...(lastAttempt?.httpStatus === undefined ? {} : { httpStatus: lastAttempt.httpStatus }),
	};
}

function formatAttempt(attempt: SearchAttempt): string {
	const status = attempt.error
		? `failed${attempt.failureKind ? `(${attempt.failureKind})` : ""}: ${attempt.error}`
		: `${attempt.resultsCount} result${attempt.resultsCount === 1 ? "" : "s"}`;
	return `${providerEntryLabel(attempt)} ${status}`;
}

export function formatSearchText(details: SearchDetails): string {
	const lines: string[] = [];
	if (details.error) {
		lines.push(details.error);
		if (details.attempts && details.attempts.length > 0) {
			lines.push("", `Routing attempts: ${details.attempts.map(formatAttempt).join(" -> ")}`);
		}
		return lines.join("\n");
	}
	if (details.results.length === 0) return `No web search results found for "${details.query}".`;

	const route =
		details.stage === "native"
			? ` via ${providerEntryLabel(details)} (native)`
			: details.strategy
				? ` via ${providerEntryLabel(details)} (${details.strategy})`
				: ` via ${details.provider}`;
	lines.push(`Web search results for "${details.query}"${route}:`, "");
	if (details.attempts && details.attempts.length > 0) {
		lines.push(`Routing attempts: ${details.attempts.map(formatAttempt).join(" -> ")}`, "");
	}
	for (const [index, item] of details.results.entries()) {
		lines.push(`${index + 1}. ${item.title}`);
		lines.push(`   ${item.url}`);
		if (item.snippet) lines.push(`   ${item.snippet}`);
	}
	lines.push("", "REMINDER: Include relevant sources from the URLs above in the final answer.");
	return lines.join("\n");
}
