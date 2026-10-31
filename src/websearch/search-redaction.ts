import type { SearchProviderEntry, SearchResultItem } from "./types.js";

const MAX_ERROR_DETAIL_LENGTH = 500;

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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

export function collectSecrets(
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
export function redactKnownSecrets(value: string, secrets: ReadonlySet<string>): string {
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

export function sanitizeResultItem(item: SearchResultItem, secrets: ReadonlySet<string>): SearchResultItem | undefined {
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

export function sanitizeDiagnostic(value: string, secrets: ReadonlySet<string>): string {
	return truncate(redactDiagnostic(value, secrets), MAX_ERROR_DETAIL_LENGTH);
}
