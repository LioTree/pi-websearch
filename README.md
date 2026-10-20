# pi-websearch

Provider-backed `web_search` tool for pi. The extension exposes one tool for every model. Normal calls prefer the active model provider's server-hosted search when pi can supply credentials for a recognized provider and protocol; otherwise they use the explicitly configured provider chain. An optional raw mode returns direct search-engine results without a model-generated answer.

Configuration is explicit. There is no built-in free default provider: if no config file exists, the extension refuses to activate and reports a startup error.

## Tool Schema

The default public tool schema is:

```json
{
	"query": "The search query to use",
	"allowed_domains": ["example.com"],
	"blocked_domains": ["spam.example.com"]
}
```

Only `query` is required. `allowed_domains` and `blocked_domains` are mutually exclusive in a single call. Result limits are configured, not exposed in the schema. The effective result count is capped at 50 per call even when a larger configured value is accepted.

When `"rawMode": true` is configured, the schema adds an optional `mode: "raw"` parameter. Omitting it keeps normal native-first routing.

## Configuration

The loader checks these paths in order and uses the first file that exists:

1. `.pi/websearch.json` in the current project
2. `~/websearch.json`
3. `~/.pi/websearch.json`

A missing file is a `missing_config` startup error. Invalid JSON, an unknown provider or configuration key, whitespace-only identifiers, domains, or keys, an invalid routing strategy, a non-boolean flag, an invalid result limit or timeout, conflicting domain filters, invalid headers, or invalid native overrides make the whole config invalid and report the config path. Entries are never silently filtered or replaced with defaults.

Legacy single-provider syntax remains supported:

```json
{
	"backend": "perplexity",
	"apiKey": "pplx-...",
	"maxResults": 8,
	"allowedDomains": ["docs.example.com"]
}
```

Use `"provider"` instead of `"backend"` when preferred. Do not combine the single-provider form with a `providers` array.

Multiple entries enable an explicit routing chain and global policy:

```json
{
	"strategy": "priority",
	"fallback": true,
	"auto": true,
	"maxResults": 8,
	"timeoutMs": 20000,
	"allowedDomains": ["docs.example.com"],
	"providers": [
		{
			"id": "brave-search",
			"provider": "brave",
			"apiKey": "<local-only-key>",
			"priority": 10
		},
		{
			"id": "exa-search",
			"provider": "exa",
			"headers": { "x-api-key": "<local-only-key>" },
			"priority": 20
		}
	]
}
```

Global fields apply to every attempt: `maxResults`, `timeoutMs`, `allowedDomains`, and `blockedDomains`. A provider entry may narrow those limits or add its own. Provider entries support `id`, `provider` (or `backend`), `apiKey`, `headers`, `baseUrl`, `searchEngineId`, `maxResults`, `model`, `codexMode`, `searchContextSize`, `allowedDomains`, `blockedDomains`, `userLocation`, `timeoutMs`, `priority`, and `weight`.

`maxResults` must be a positive safe integer; values above 50 are accepted by config validation but the runtime caps returned results at 50. `timeoutMs` must be a positive integer no greater than `2147483647`, the maximum `setTimeout` delay.

Each tool call has a fixed 180-second wall-clock budget covering native credential resolution, the native attempt, every configured-chain attempt, and retries. `timeoutMs` is a per-attempt ceiling and cannot extend that total budget.

`headers` values are strings, or `null` to delete a default header during the case-insensitive merge. A non-empty provider credential header can satisfy the credential requirement without `apiKey`: `Authorization` for bearer-auth providers; `x-api-key` for Exa, Serper (`X-API-KEY`), and Anthropic API-key mode; or Brave's `X-Subscription-Token`. Unrelated headers such as `User-Agent` or `X-Trace-Id` do not count. `cf-aig-authorization` is additive Cloudflare AI Gateway auth and does not replace the provider's primary credential. Google CSE requires `apiKey` because it sends the key in the query string; headers cannot replace it. `baseUrl` must be a public HTTPS URL without embedded credentials.

### Native overrides

Normal routing uses the active model only. pi-websearch uses these provider identity and protocol pairs as candidate native adapters:

| pi provider | Required `model.api` | Native adapter |
| --- | --- | --- |
| `openai` | `openai-responses` | `openai` |
| `anthropic` | `anthropic-messages` | `anthropic` |
| `xai` | `openai-responses` | `xai` |
| `zai`, `z-ai`, or `zai-coding-cn` | `openai-completions` | `z-ai` |
| `perplexity` | `openai-completions` | `perplexity` |
| `kimi-coding` | any | `kimi` |
| `deepseek` | any (dedicated Search API) | `deepseek` |
| `openai-codex` | `openai-codex-responses` | `codex` (ChatGPT subscription transport) |

The table is a candidate mapping, not a whitelist of verified model IDs or a guarantee that hosted search is enabled. Only the provider's actual response proves that the search tool worked.

There is no model-id prefix matching and no discovery of other available models. OpenRouter, Azure, GitHub Copilot, and renamed gateways are not inferred from their `api` value because the same wire protocol does not imply that the vendor's hosted search tool is available.

For another gateway, opt in by provider identity:

```json
{
	"auto": true,
	"nativeOverrides": {
		"my-openai-gateway": {
			"adapter": "openai",
			"endpoint": "https://gateway.example.com/v1/responses",
			"model": "gpt-5.5"
		},
		"openrouter": false
	},
	"providers": [{ "provider": "exa", "apiKey": "<local-only-key>" }]
}
```

`adapter` is required and is one of `openai`, `codex`, `anthropic`, `xai`, `perplexity`, `z-ai`, `kimi`, or `deepseek`. Selecting `codex` uses the ChatGPT subscription transport, not the legacy API-key provider of the same name. `endpoint` is optional but, when present, must be the complete public HTTPS search URL. `model` is optional and defaults to the active pi model id. `false` disables native search for that provider.

Native overrides contain settings only. They must not contain `apiKey`, `headers`, or any other credentials. The native path inherits pi's resolved credentials for the active model through `ExtensionContext.modelRegistry.getApiKeyAndHeaders`, including resolved `apiKey`, headers, and base URL.

## Routing

For a normal call:

1. Load the configured providers.
2. If `auto` is `true`, resolve a native adapter for the active model only. A recognized provider and protocol, or an explicit `nativeOverrides` entry, produces one native attempt. `auto: false`, an unsupported provider, an incompatible protocol, a disabled override, missing credentials, or an unsafe URL is reported as a native skip reason.
3. Try the provider's native search first with pi's credentials for the active model. The endpoint is derived from the resolved base URL using adapter-specific rules, or taken from the complete override endpoint.
4. If the native attempt fails, continue with the configured provider chain. This happens regardless of `fallback`, so a failed native attempt never disables generic search.
5. Within the configured chain, `fallback` controls whether another entry is tried after an entry fails. `priority`, `round-robin`, and `fill-first` apply only to that chain.

A native call never borrows credentials or endpoints from another provider, and it is not attempted unless the active model matches. No configuration file means no search attempt.

Migration from 0.4.x: `provider_native_bypass` is removed, so OpenAI and Anthropic models are no longer disabled by provider identity. Cross-provider native discovery, model-id prefix matching, and OpenRouter id unwrapping are removed; only the active model is considered. `fallback: false` now affects only retries inside the configured provider chain; a native failure still falls through to that chain.

### Opt-in raw search mode

Set `"rawMode": true` to expose the optional `mode: "raw"` tool parameter:

```json
{
	"rawMode": true,
	"auto": true,
	"providers": [{ "provider": "brave", "apiKey": "<local-only-key>" }]
}
```

Raw mode requires at least one direct-search provider at config load time. If the configured entries are all model-answer adapters, loading fails instead of exposing an unusable mode.

A raw call skips native resolution and filters the configured list to direct-search entries, preserving their order, priorities, routing strategy, fallback policy, and domain filters. Direct-search providers are DuckDuckGo HTML, Brave, Exa, Tavily, SERPdive, Serper, Google CSE, Kagi, Kimi's search endpoint, DeepSeek Search, and Perplexity or Z.ai entries without a `model`. OpenAI, Codex (both legacy API-key and subscription entries), Anthropic, xAI, and Perplexity or Z.ai entries with a `model` are model-answer adapters and are excluded.

Raw results contain titles, URLs, and snippets without an additional model-generated answer. Snippets may still be processed by the search service. Raw mode does not fetch full pages or guarantee verbatim page text. There is no heuristic refusal detection or automatic raw fallback; normal calls that used a model-answer adapter include a retry hint when raw mode is enabled.

## Providers

- `duckduckgo-html`: DuckDuckGo HTML search endpoint. Requires no `apiKey`.
- `exa`: direct Exa search. Requires credentials.
- `tavily`: direct Tavily search. Requires credentials.
- `serpdive`: direct SERPdive search with extracted page content. Requires credentials.
- `brave`: Brave Search API. Requires credentials.
- `serper`: Serper Google search API. Requires credentials.
- `google-cse`: Google Custom Search JSON API. Requires `apiKey` and `searchEngineId`; header-only auth is not supported.
- `deepseek`: DeepSeek Search API (`POST /v1/tools/search`). Requires a DeepSeek API key or bearer authorization header. Direct search; no chat model is invoked.
- `z-ai`: Z.ai web search endpoint or model-backed adapter when `model` is set. Requires credentials.
- `openai`: OpenAI Responses API hosted `web_search` tool. Requires credentials.
- `codex`: legacy OpenAI Responses API hosted `web_search` tool using an API key. Requires credentials; unchanged by subscription support.
- `openai-codex`: ChatGPT Codex subscription `web_search` with SSE responses. Normally selected by native routing with pi's existing login, not manually configured tokens.
- `anthropic`: Anthropic Messages API with the server `web_search_20250305` tool. Requires credentials.
- `perplexity`: Perplexity Search API, or a model-backed entry when `model` is set. Requires credentials.
- `xai`: xAI Responses API hosted `web_search` tool. Requires credentials. More than five allowed or excluded domains skips the attempt and falls through according to the routing policy instead of silently dropping domains.
- `kimi`: Kimi search endpoint. Requires credentials or authentication headers.
- `kagi`: Kagi Search API (`POST /search`). Requires credentials.

Credentials may be supplied with `apiKey`, `headers`, or both. Authenticated requests refuse redirects rather than forwarding credentials to another origin.

### Codex / ChatGPT subscription search

Sign in through pi and select an `openai-codex` model. With `auto: true` and a valid websearch configuration, normal calls reuse the active model's pi-resolved credentials and URL, with no separate OpenAI API key or model-name whitelist. Pi resolves/refreshes credentials on each search. If pi resolves an `openai` Responses session to the ChatGPT backend, the native request also uses this subscription transport. This does not discover or borrow other logged-in accounts.

The native `codex` adapter maps to the separate `openai-codex` search backend. It uses the resolved `/codex/responses` endpoint (normally `https://chatgpt.com/backend-api/codex/responses`), bearer authorization, and a `chatgpt-account-id` from the outgoing token or explicit resolved headers. Requests use structured user input, instructions, `store: false`, `stream: true`, and the hosted `web_search` tool. Only the query and domain restrictions are sent, not the conversation history. Renamed gateways opt in with `nativeOverrides[provider] = { "adapter": "codex" }`; `endpoint`, when present, is a complete search URL.

Only a successful terminal SSE response can return structured sources or URL citations. Stream errors (including quota errors inside HTTP 200), failures, incomplete responses, truncated streams, and no usable sources fall through to the configured chain. Cancellation stops the reader without starting fallback. SSE parsing is bounded to 8 MiB per stream, approximately 1 MiB of data per event, and 10,000 data events, within the existing timeout/budget.

Explicit raw calls still skip subscription auth and exclude both Codex backends. The old configured `provider: "codex"` remains the API-key Responses adapter. An explicit `provider: "openai-codex"` entry, if used, requires its own bearer credential and account identity; it does not look up another pi account. Prefer native routing rather than copying login tokens into configuration. The subscription wire format follows pi's Codex transport; this is not a claim that every account/model or gateway has been live-tested.

### DeepSeek Search

The [official Search API](https://api-docs.deepseek.com/guides/search/) returns structured sources from DeepSeek's search engine. With `auto: true` and an active `deepseek` model, native search reuses that model's pi-resolved credentials and base URL. It does not send a `model` field, so the chat protocol and model alias do not limit search eligibility. Unknown gateway provider names require `nativeOverrides[provider] = { "adapter": "deepseek" }`; set `endpoint` when the gateway uses a different search path.

The endpoint is `/v1/tools/search`; native URL derivation handles root, `/v1`, `/beta`, and `/anthropic` bases while retaining a gateway path prefix. As with other configured backends, a provider entry's `baseUrl` or a native override's `endpoint` must be the complete search URL.

To use DeepSeek as a configured fallback or raw backend, add `{ "provider": "deepseek", "apiKey": "<local-only-key>" }` to `providers`. Raw calls still skip native credential resolution; they use only explicitly configured direct-search entries, including DeepSeek when present.

DeepSeek accepts 1–128 Unicode characters **including appended domain operators**, and 1–50 results. Overlong queries are rejected before sending, never truncated, and continue according to the routing/fallback policy. The adapter requests `need_content: false`, prefers the model-oriented `summary` over the short `snippet`, and retains site, score, and publication date. It does not call the separate Fetch API or claim live provider verification.

## Status

Run `/websearch status` to inspect the loaded state. It reports the current active provider/model, `auto`, raw mode, the native adapter candidate or a truthful skip reason, the routing strategy, fallback, and configured provider labels.

Status uses the synchronous native adapter inspection and does not resolve credentials or refresh a login. Startup config errors are shown as UI notifications when UI is available; in non-UI modes the same error is returned by the tool.

## Development

```bash
bun install
bun run test
bun run typecheck
bun run check
pi -e ./src/index.ts
```

npm remains a supported consumer install (`npm install` / `npm ci` / `npm test`).

## Limitations

- Native provider search is implemented against each provider's documented request shape. Tests include the real pi SDK lifecycle with isolated settings and fake credentials, but search responses are mocked; this does not claim live verification of every provider, gateway, or model. A gateway may reject the hosted search tool even when it accepts the same wire protocol.
- Codex subscription search uses ChatGPT's Codex backend, not the public API-key Responses endpoint. Account/model availability and backend changes can still cause fallback; no live subscription verification is claimed. The explicit legacy `codex` provider continues to use an API key.
- Native overrides cannot carry credentials. Only pi-resolved credentials for the active model are used.
- When an endpoint explicitly rejects the hosted search tool, the extension may skip that native route for five minutes for the current model, endpoint, account credentials, and config fingerprint. The cache applies only to explicit unsupported tool or search failures; invalid search arguments, authentication failures, and quota failures are not cached as unsupported.
- Cancellation prevents new search fetches and aborts an in-flight fetch through `AbortSignal`; late results are ignored. pi's public authentication API cannot abort a credential refresh that is already running, so that refresh may finish after cancellation without causing a search request.
- The HTTPS/public-host guard rejects literal `localhost`, private-IP, and credentialed URLs syntactically. It does not resolve DNS, pin resolved addresses, or provide full SSRF protection; a public hostname can still resolve to a private address.
- Raw mode is a direct-query escape hatch, not a page-content extractor.
