import { type DomainPolicy, EmptyDomainPolicyError, isHostAllowedByPolicy, mergeDomainFilters } from "./domains.js";
import { CodexStreamError, readCodexResponse } from "./providers/codex-stream.js";
import { ExaMcpError, readExaMcpResponse } from "./providers/exa-mcp.js";
import {
	buildSearchRequest,
	isDirectSearchProvider,
	normalizeSearchAnswer,
	normalizeSearchResponse,
} from "./providers.js";
import {
	advanceRoundRobin,
	createSearchRoutingState,
	providerEntryLabel,
	type SearchRoutingState,
	selectOrder,
} from "./routing-order.js";
import { collectSecrets, redactKnownSecrets, sanitizeDiagnostic, sanitizeResultItem } from "./search-redaction.js";
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

export { createSearchRoutingState, providerEntryLabel, type SearchRoutingState } from "./routing-order.js";
export { formatSearchText } from "./search-text.js";

const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
/** Finite wall-clock budget covering native auth resolution and every search attempt. */
export const SEARCH_TOTAL_BUDGET_MS = 180_000;
const MAX_RESULTS_LIMIT = 50;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * Global policy wins over request policy and provider policy. Allowed scopes can
 * only narrow; blocked scopes union. An empty allowed intersection throws
 * EmptyDomainPolicyError before any provider is contacted.
 */
export function effectiveDomainFilters(
	config: Pick<WebsearchConfig, "allowedDomains" | "blockedDomains">,
	request: Pick<SearchRequest, "allowedDomains" | "blockedDomains">,
): DomainPolicy {
	return mergeDomainFilters(config, request);
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
	return mergeDomainFilters(request, entry);
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
	let secrets = collectSecrets(config, undefined);
	const fail = (failureKind: SearchFailureKind, error: string, httpStatus?: number): SearchDetails => ({
		provider: config.provider,
		query: request.query,
		results: [],
		durationMs: Date.now() - startedAt,
		truncated: false,
		error: sanitizeDiagnostic(error, secrets),
		failureKind,
		...(httpStatus === undefined ? {} : { httpStatus }),
		...(options.stage ? { stage: options.stage } : {}),
		...(config.id === undefined ? {} : { entryId: config.id }),
	});
	const globalTimeout = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS));
	const remaining = options.deadline === undefined ? globalTimeout : options.deadline - startedAt;
	if (remaining <= 0) {
		return fail("timeout", `Search budget exhausted before provider ${providerEntryLabel(config)}`);
	}
	const timeoutMs = Math.min(providerTimeoutMs(config, globalTimeout), remaining);
	const abort = searchAbortSignal(signal, timeoutMs);
	let response: Response | undefined;
	let bodyText = "";
	let streamedPayload: JsonObject | undefined;
	try {
		let built: ReturnType<typeof buildSearchRequest>;
		try {
			built = buildSearchRequest(entryWithNarrowedLimit(config, request.maxResults), request);
		} catch (error) {
			if (error instanceof EmptyDomainPolicyError) {
				return fail("no-results", `${error.message}; no search was performed.`);
			}
			return fail("request", error instanceof Error ? error.message : "Search request construction failed");
		}

		secrets = collectSecrets(config, built.url, built.init.headers);
		try {
			const init: RequestInit = { ...built.init, signal: abort.signal, redirect: "error" };
			if (built.body !== undefined) init.body = JSON.stringify(built.body);
			response = await fetch(built.url, init);
			if (response.ok && built.responseFormat === "exa-mcp") {
				streamedPayload = await readExaMcpResponse(response, abort.signal);
			} else if (
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
			if (signal?.aborted) throw abortReason(signal);
			let kind: SearchFailureKind = "network";
			if (isTimeoutError(error, abort.signal)) kind = "timeout";
			else if (response && error instanceof CodexStreamError) kind = codexStreamFailureKind(error);
			else if (response && error instanceof ExaMcpError) kind = error.failureKind;
			const message = response ? "Search response read failed" : "Search request failed";
			const status =
				error instanceof CodexStreamError || error instanceof ExaMcpError ? response?.status : undefined;
			return fail(kind, error instanceof Error ? error.message : message, status);
		}
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
		return fail(failureKind, httpErrorMessage(response.status, payload, bodyText, secrets), response.status);
	}

	if (!payloadIsStructured) {
		return fail(
			"invalid-response",
			`Search provider ${providerEntryLabel(config)} returned an empty or invalid response body.`,
			response.status,
		);
	}

	let normalized: { results: SearchResultItem[]; invalid: number; filtered: number };
	let filters: DomainPolicy;
	try {
		filters = domainFiltersForEntry(config, request);
		normalized = normalizeResults(config.provider, payload, secrets, filters);
	} catch (error) {
		if (error instanceof EmptyDomainPolicyError) {
			return fail("no-results", error.message, response.status);
		}
		return fail(
			error instanceof ExaMcpError ? error.failureKind : "invalid-response",
			error instanceof Error ? error.message : "Search response normalization failed",
			response.status,
		);
	}

	if (normalized.results.length === 0) {
		if (isJsonObject(payload) && (payload["error"] !== undefined || payload["success"] === false)) {
			const detail = extractErrorDetail(payload, bodyText);
			return fail(
				"request",
				detail
					? `Search provider ${providerEntryLabel(config)} returned an error: ${detail}`
					: `Search provider ${providerEntryLabel(config)} returned an error payload.`,
				response.status,
			);
		}
		if (hasStructuredRefusal(payload)) {
			return fail(
				"refusal",
				`Search provider ${providerEntryLabel(config)} returned a refusal for "${request.query}".`,
				response.status,
			);
		}
		if (normalized.filtered > 0) {
			return fail(
				"no-results",
				`Search provider ${providerEntryLabel(config)} returned no results after domain filters for "${request.query}".`,
				response.status,
			);
		}
		if (normalized.invalid > 0) {
			return fail(
				"invalid-response",
				`Search provider ${providerEntryLabel(config)} returned no usable source URLs.`,
				response.status,
			);
		}
		return fail(
			"no-results",
			`Search provider ${providerEntryLabel(config)} returned no results for "${request.query}".`,
			response.status,
		);
	}

	throwIfAborted(signal);
	const answer = isDirectSearchProvider(config) ? undefined : normalizeSearchAnswer(config.provider, payload);
	// Prose/Markdown delimiters are not part of a URL's host. Match schemes
	// case-insensitively and remove terminal sentence punctuation.
	const answerUrls = (answer?.match(/https?:\/\/[^\s<>"'`[\](){}，。；、！？,;]+/gi) ?? []).map((url) =>
		url.replace(/[.!?:]+$/, ""),
	);
	if (
		answer &&
		(normalized.filtered > 0 ||
			normalized.invalid > 0 ||
			answerUrls.some((url) => !resultAllowedByDomains(url, filters)))
	) {
		return fail(
			"no-results",
			"Search answer includes invalid or excluded sources; mixed-source synthesis cannot be safely filtered.",
			response.status,
		);
	}
	const results = normalized.results.slice(0, request.maxResults);
	const details: SearchDetails = {
		provider: config.provider,
		query: request.query,
		results,
		durationMs: Date.now() - startedAt,
		truncated: normalized.results.length > request.maxResults,
	};
	if (answer) details.answer = redactKnownSecrets(answer, secrets);
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
	const answers: string[] = [];
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
		if (details.answer) answers.push(`${providerEntryLabel(details)}:\n${details.answer}`);
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
			...(answers.length ? { answer: answers.join("\n\n") } : {}),
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
