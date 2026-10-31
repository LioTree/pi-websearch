# pi-websearch

Maintained fork of [code-yeongyu/pi-websearch](https://github.com/code-yeongyu/pi-websearch). Releases and development continue at [LioTree/pi-websearch](https://github.com/LioTree/pi-websearch).

Provider-backed `web_search` tool for pi. The extension exposes one tool for every model. Normal calls prefer the active model provider's server-hosted search when pi can supply credentials for a recognized provider and protocol; otherwise they use the search provider chain (anonymous Exa MCP by default, or your explicit configuration). An optional raw mode returns direct search-engine results without a model-generated answer.

No configuration is required. Without a config file, normal calls try the active model's native search first, then Exa's official anonymous MCP search. Anonymous Exa is rate-limited. Failures are reported; DuckDuckGo is not silently added. An existing config file keeps its exact provider chain.

## Installation

Install the tagged release:

```bash
pi install git:github.com/LioTree/pi-websearch@v0.5.2
```

To track ongoing development, use `git:github.com/LioTree/pi-websearch@main` instead. Run `/reload` in an existing session after installing or updating. Configuration is optional; see below to change providers or enable raw mode.

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

If none of these files exists, the extension activates with `auto: true`, `strategy: "priority"`, `fallback: true`, and one provider: `{ "provider": "exa-mcp" }`. Raw mode stays off by default. This default is not appended to an explicit configuration.

An unreadable file, invalid JSON, an unknown provider or configuration key, whitespace-only identifiers, domains, or keys, an invalid routing strategy, a non-boolean flag, an invalid result limit or timeout, conflicting domain filters, invalid headers, or invalid native overrides make the whole config invalid and report the config path. An existing invalid file remains an error; it is never replaced by the anonymous default. Entries are never silently filtered.

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

1. Load the configured providers, or use the anonymous Exa MCP default if no config file exists.
2. If `auto` is `true`, resolve a native adapter for the active model only. A recognized provider and protocol, or an explicit `nativeOverrides` entry, produces one native attempt. `auto: false`, an unsupported provider, an incompatible protocol, a disabled override, missing credentials, or an unsafe URL is reported as a native skip reason.
3. Try the provider's native search first with pi's credentials for the active model. The endpoint is derived from the resolved base URL using adapter-specific rules, or taken from the complete override endpoint.
4. If the native attempt fails, continue with the configured provider chain. This happens regardless of `fallback`, so a failed native attempt never disables generic search.
5. Within the configured chain, `fallback` controls whether another entry is tried after an entry fails. `priority`, `round-robin`, and `fill-first` apply only to that chain.

A native call never borrows credentials or endpoints from another provider, and it is not attempted unless the active model matches. Without a configuration file, the fallback chain contains only anonymous Exa MCP.

Migration from 0.4.x: `provider_native_bypass` is removed, so OpenAI and Anthropic models are no longer disabled by provider identity. Cross-provider native discovery, model-id prefix matching, and OpenRouter id unwrapping are removed; only the active model is considered. `fallback: false` now affects only retries inside the configured provider chain; a native failure still falls through to that chain.

### Hosted search answers

All model-search adapters use the same two instructions: "Search the web and return a concise answer grounded only in the web results. Include clickable source citations in the response text when possible." This covers OpenAI, both Codex transports, Anthropic, xAI, and Perplexity/Z.ai entries with a model. Anthropic OAuth retains its existing transport identity prefix before these instructions.

The tool returns the generated answer once, followed by structured sources. These answers are not webpage excerpts; sources without their own excerpts have no snippet. Anthropic web citations stay attached to their text blocks. Perplexity keeps the original answer text and appends a clickable provider-index citation mapping without rewriting code or existing links. Perplexity and Z.ai retain genuine per-source snippets when supplied. Direct-search providers (including Perplexity/Z.ai without a model) keep their per-page result format and do not receive model instructions.

A model-search answer with invalid or domain-excluded sources is rejected rather than partially scrubbed: the synthesis may depend on those sources even after links are removed. Normal fallback rules then apply. URL filtering does not prove that every factual claim came only from allowed sources.

### Opt-in raw search mode

Set `"rawMode": true` to expose the optional `mode: "raw"` tool parameter:

```json
{
	"rawMode": true,
	"auto": true,
	"providers": [{ "provider": "exa-mcp" }]
}
```

Raw mode requires at least one direct-search provider at config load time. If the configured entries are all model-answer adapters, loading fails instead of exposing an unusable mode.

A raw call skips native resolution and filters the configured list to direct-search entries, preserving their order, priorities, routing strategy, fallback policy, and domain filters. Direct-search providers are Exa MCP, DuckDuckGo HTML, Brave, Exa REST, Tavily, SERPdive, Serper, Google CSE, Kagi, Kimi's search endpoint, DeepSeek Search, and Perplexity or Z.ai entries without a `model`. OpenAI, Codex (both legacy API-key and subscription entries), Anthropic, xAI, and Perplexity or Z.ai entries with a `model` are model-answer adapters and are excluded.

Omit `mode` by default; normal routing uses native search with automatic fallback to configured providers. Use raw only for one same-query retry after a refusal or no usable sources, or an explicit request for direct search-engine results without model synthesis. Requests for URLs, citations, or official docs alone do not justify raw.

Raw returns titles, URLs, and snippets, not full pages or guaranteed verbatim text; services may process snippets. There is no heuristic refusal detection or automatic raw fallback. When raw mode is enabled, normal calls using a model-answer adapter include a conditional retry hint.

## Providers

- `duckduckgo-html`: DuckDuckGo HTML search endpoint. Requires no `apiKey`.
- `exa-mcp`: Exa's official hosted MCP `web_search_exa`. Anonymous and rate-limited; no key required. The default when no config file exists.
- `exa`: direct Exa REST search. Requires credentials. Separate protocol from `exa-mcp`.
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

### Anonymous Exa MCP

`exa-mcp` sends a stateless JSON-RPC `tools/call` request to `https://mcp.exa.ai/mcp`, calling `web_search_exa` with `query` and `numResults` (capped at 50). It accepts JSON and Streamable HTTP SSE responses. It does not register a second pi tool, invoke a local MCP server, or add an extra LLM answer. The [official server source](https://github.com/exa-labs/exa-mcp-server/blob/master/src/tools/webSearch.ts) calls Exa search with content highlights and formats each result as title, URL, publication metadata, and highlights or text. The adapter parses that fixed result format into typed sources; it also accepts structured results when supplied. Unrecognized text is rejected rather than treated as a generated answer or a list of citations.

Domain restrictions are appended as search operators and enforced again on returned URLs. The service can return fewer results than requested. Responses are bounded to 8 MiB, approximately 1 MiB per SSE event, and 10,000 data events, within the existing per-attempt timeout and total budget. Cancellation stops the client reader; truncated or malformed responses fail without returning partial results. This backend uses the hosted service's stateless call path, not a general MCP client: it does not negotiate sessions, reconnect streams, or send server-side cancellation notifications. An aborted server-side search may still finish.

The [official hosted service](https://github.com/exa-labs/exa-mcp-server#authentication) allows anonymous requests with rate limits. No fixed anonymous quota or availability is guaranteed. HTTP 429, MCP tool errors, and the server's explicit free-tier rate-limit notice are reported as failures. The no-config default has no further fallback; add other providers explicitly if wanted. `apiKey` (sent as `x-api-key`) or authentication `headers` can be supplied to an explicit `exa-mcp` entry for higher service limits. Existing `exa` REST configurations and explicit `duckduckgo-html` entries are unchanged.

### OpenAI Responses with API keys or ChatGPT OAuth

The `openai` adapter keeps the active model's resolved endpoint and effective authorization. Both API-key and OAuth calls use message-array input, `store: false`, and `stream: true`; no account header or JWT claim is required to select this format. OpenAI OAuth at `https://api.openai.com/v1/responses` is not redirected to the legacy Codex backend. The bounded Responses SSE decoder requires a successful terminal event. Gateways explicitly returning `application/json` remain supported; explicit failed or incomplete statuses do not yield partial sources.

### Codex / ChatGPT subscription search

Sign in through pi and select an `openai-codex` model. With `auto: true` (the default, including without a config file), normal calls reuse the active model's pi-resolved credentials and URL, with no separate OpenAI API key or model-name whitelist. Pi resolves/refreshes credentials on each search. If pi resolves an `openai` Responses session to the ChatGPT backend, the native request also uses this subscription transport. This does not discover or borrow other logged-in accounts.

The native `codex` adapter maps to the separate `openai-codex` search backend. It uses the resolved `/codex/responses` endpoint (normally `https://chatgpt.com/backend-api/codex/responses`), bearer authorization, and a `chatgpt-account-id` from the outgoing token or explicit resolved headers. Requests use structured user input, instructions, `store: false`, `stream: true`, and the hosted `web_search` tool. Only the query and domain restrictions are sent, not the conversation history. Renamed gateways opt in with `nativeOverrides[provider] = { "adapter": "codex" }`; `endpoint`, when present, is a complete search URL.

Only a successful terminal SSE response can return structured sources or URL citations. Stream errors (including quota errors inside HTTP 200), failures, incomplete responses, truncated streams, and no usable sources fall through to the configured chain. Cancellation stops the reader without starting fallback. SSE parsing is bounded to 8 MiB per stream, approximately 1 MiB of data per event, and 10,000 data events, within the existing timeout/budget.

Explicit raw calls still skip subscription auth and exclude both Codex backends. The old configured `provider: "codex"` remains the API-key Responses adapter. An explicit `provider: "openai-codex"` entry, if used, requires its own bearer credential and account identity; it does not look up another pi account. Prefer native routing rather than copying login tokens into configuration. The subscription wire format follows pi's Codex transport; this is not a claim that every account/model or gateway has been live-tested.

### DeepSeek Search

The [official Search API](https://api-docs.deepseek.com/guides/search/) returns structured sources from DeepSeek's search engine. With `auto: true` and an active `deepseek` model, native search reuses that model's pi-resolved credentials and base URL. It does not send a `model` field, so the chat protocol and model alias do not limit search eligibility.

This is the dedicated Search API, not the Responses API's hosted `web_search` tool. DeepSeek documents hosted `web_search` as supported only with `deepseek-v4-pro`; the Search API has no such model restriction, so a `deepseek-flash` session still searches through `/v1/tools/search`. The Search API is billed separately from chat and has its own QPS limit (HTTP 429, treated as quota and not cached as unsupported). Unknown gateway provider names require `nativeOverrides[provider] = { "adapter": "deepseek" }`; set `endpoint` when the gateway uses a different search path.

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

- Anonymous Exa MCP was live-smoke-tested against the official endpoint. Its free quota, availability, and result text format are controlled by Exa; future protocol or format changes can cause a reported failure. Raw snippets are service-provided content/highlights, not guaranteed verbatim page text.
- Native provider search is implemented against each provider's documented request shape. Tests include the real pi SDK lifecycle with isolated settings and fake credentials, but search responses are mocked; this does not claim live verification of every provider, gateway, or model. A gateway may reject the hosted search tool even when it accepts the same wire protocol.
- Codex subscription search uses ChatGPT's Codex backend, not the public API-key Responses endpoint. Account/model availability and backend changes can still cause fallback; no live subscription verification is claimed. The explicit legacy `codex` provider continues to use an API key.
- Native overrides cannot carry credentials. Only pi-resolved credentials for the active model are used.
- When an endpoint explicitly rejects the hosted search tool, the extension may skip that native route for five minutes for the current model, endpoint, account credentials, and config fingerprint. The cache applies only to explicit unsupported tool or search failures; invalid search arguments, authentication failures, and quota failures are not cached as unsupported.
- Cancellation prevents new search fetches and aborts an in-flight fetch through `AbortSignal`; late results are ignored. pi's public authentication API cannot abort a credential refresh that is already running, so that refresh may finish after cancellation without causing a search request.
- The HTTPS/public-host guard rejects literal `localhost`, private-IP, and credentialed URLs syntactically. It does not resolve DNS, pin resolved addresses, or provide full SSRF protection; a public hostname can still resolve to a private address.
- Raw mode is a direct-query escape hatch, not a page-content extractor.
