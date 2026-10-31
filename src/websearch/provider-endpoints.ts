import type { NativeSearchAdapter, SearchProvider, SearchProviderConfig } from "./types.js";

const DEFAULT_PROVIDER_URLS: Record<SearchProvider, string> = {
	exa: "https://api.exa.ai/search",
	"exa-mcp": "https://mcp.exa.ai/mcp",
	tavily: "https://api.tavily.com/search",
	serpdive: "https://api.serpdive.com/v1/search",
	brave: "https://api.search.brave.com/res/v1/web/search",
	"duckduckgo-html": "https://html.duckduckgo.com/html/",
	serper: "https://google.serper.dev/search",
	"google-cse": "https://customsearch.googleapis.com/customsearch/v1",
	deepseek: "https://api.deepseek.com/v1/tools/search",
	"z-ai": "https://api.z.ai/api/paas/v4/web_search",
	openai: "https://api.openai.com/v1/responses",
	"openai-codex": "https://chatgpt.com/backend-api/codex/responses",
	codex: "https://api.openai.com/v1/responses",
	anthropic: "https://api.anthropic.com/v1/messages",
	perplexity: "https://api.perplexity.ai/search",
	xai: "https://api.x.ai/v1/responses",
	kimi: "https://api.kimi.com/coding/v1/search",
	kagi: "https://kagi.com/api/v1/search",
};

export function defaultProviderUrl(provider: SearchProvider): string {
	return DEFAULT_PROVIDER_URLS[provider];
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const first = parts[0] ?? -1;
	const second = parts[1] ?? -1;
	if (first === 10 || first === 127 || first === 0 || (first === 169 && second === 254)) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	return first === 192 && second === 168;
}

function isPrivateIpv6(hostname: string): boolean {
	return (
		hostname === "::" ||
		hostname === "::1" ||
		hostname.startsWith("::ffff:") ||
		/^f[cd][0-9a-f]{2}:/.test(hostname) ||
		/^fe[89ab][0-9a-f]:/.test(hostname)
	);
}

function isPrivateHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
	if (normalized.includes(":")) return isPrivateIpv6(normalized);
	return normalized === "localhost" || normalized.endsWith(".localhost") || isPrivateIpv4(normalized);
}

export function isAllowedProviderBaseUrl(baseUrl: string): boolean {
	let configured: URL;
	try {
		configured = new URL(baseUrl);
	} catch {
		return false;
	}
	return (
		configured.protocol === "https:" &&
		configured.username === "" &&
		configured.password === "" &&
		!configured.hostname.endsWith("..") &&
		!isPrivateHostname(configured.hostname)
	);
}

export function providerUrl(config: SearchProviderConfig): string {
	if (config.baseUrl) return config.baseUrl;
	if (config.model && config.provider === "perplexity") return "https://api.perplexity.ai/chat/completions";
	if (config.model && config.provider === "z-ai") return "https://api.z.ai/api/paas/v4/chat/completions";
	return defaultProviderUrl(config.provider);
}

function trimTrailingSlashes(pathname: string): string {
	return pathname.replace(/\/+$/, "");
}

function appendPath(pathname: string, suffix: string): string {
	return `${trimTrailingSlashes(pathname)}${suffix}`;
}

/**
 * Resolve the full search endpoint for a native adapter from a provider base URL.
 * Hosted tools follow their chat API's path rules; dedicated search adapters use their
 * documented search paths. There is no universal /v1 insertion across adapters.
 */
export function nativeSearchEndpoint(adapter: NativeSearchAdapter, baseUrl: string): string {
	const url = new URL(baseUrl);
	const pathname = trimTrailingSlashes(url.pathname);

	switch (adapter) {
		case "openai":
		case "xai":
			url.pathname = pathname.endsWith("/responses") ? pathname : appendPath(pathname, "/responses");
			break;
		case "anthropic":
			if (pathname.endsWith("/v1/messages")) {
				url.pathname = pathname;
			} else if (pathname.endsWith("/v1")) {
				url.pathname = `${pathname}/messages`;
			} else {
				url.pathname = appendPath(pathname, "/v1/messages");
			}
			break;
		case "z-ai":
			url.pathname = pathname.endsWith("/chat/completions") ? pathname : appendPath(pathname, "/chat/completions");
			break;
		case "perplexity":
			url.pathname = pathname.endsWith("/chat/completions") ? pathname : appendPath(pathname, "/chat/completions");
			break;
		case "deepseek": {
			if (pathname.endsWith("/v1/tools/search")) {
				url.pathname = pathname;
			} else {
				// Search is separate from the OpenAI, beta and Anthropic chat API prefixes.
				const prefix = pathname.replace(/\/(?:anthropic|beta)(?:\/v1)?$/, "");
				url.pathname = prefix.endsWith("/v1") ? `${prefix}/tools/search` : appendPath(prefix, "/v1/tools/search");
			}
			break;
		}
		case "kimi":
			if (pathname.endsWith("/v1/search")) {
				url.pathname = pathname;
			} else if (pathname.endsWith("/coding/v1")) {
				url.pathname = `${pathname}/search`;
			} else if (pathname.endsWith("/coding")) {
				url.pathname = `${pathname}/v1/search`;
			} else if (pathname.endsWith("/v1")) {
				url.pathname = `${pathname}/search`;
			} else {
				url.pathname = appendPath(pathname, "/v1/search");
			}
			break;
		case "codex":
			if (pathname.endsWith("/codex/responses")) {
				url.pathname = pathname;
			} else if (pathname.endsWith("/codex")) {
				url.pathname = `${pathname}/responses`;
			} else {
				url.pathname = appendPath(pathname, "/codex/responses");
			}
			break;
		default:
			throw new Error(`Unsupported native search adapter: ${String(adapter)}`);
	}

	url.hash = "";
	return url.href;
}
