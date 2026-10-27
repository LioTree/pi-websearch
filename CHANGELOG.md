# Changelog

## 0.5.1 - 2026-10-27

### Fixed

- OpenAI ChatGPT OAuth search at the existing Responses endpoint now sends structured message input, `store: false`, and `stream: true`, and decodes bounded SSE responses. The endpoint and effective credentials are preserved; requests are not redirected to the legacy Codex backend.
- Subscription detection uses the effective bearer token's ChatGPT account claim or an explicit account header. API-key requests retain their existing transport.
- Added regression coverage for native routing, streamed sources, credential overrides, account headers, and truncated streams. Validation: 425 tests and strict type/style checks passed; no live account verification performed for this release.

## 0.5.0 - 2026-10-20

### Added

- Opt-in raw search (`rawMode: true`, `mode: "raw"`) skips native search and model-answer backends while retaining the configured direct-search chain.
- Codex/ChatGPT subscription native search for active `openai-codex` models and `adapter: "codex"` overrides. A separate `openai-codex` search backend uses pi-resolved credentials, account identity, Codex request fields, and bounded SSE parsing. OpenAI auth resolved to ChatGPT uses the same transport. Legacy configured `codex` API-key entries are unchanged. Failed/incomplete/truncated streams fall back; cancellation closes the reader without starting another provider.
- DeepSeek Search API (`POST /v1/tools/search`) as a native adapter for the active `deepseek` provider and as an explicit direct-search backend. Native search inherits pi credentials; renamed gateways opt in with `adapter: "deepseek"`. Raw mode accepts configured DeepSeek entries. Queries including domain operators are limited to 128 Unicode characters without truncation; full page content is not requested.

### Changed

- Configuration is explicit: a missing config file is `missing_config` instead of a hidden DuckDuckGo default. Config parsing rejects invalid providers, entries, unknown keys, booleans, strategies, result limits, timeouts, headers, whitespace-only values, and native overrides with the config path in the error.
- Credential headers are matched per provider. `User-Agent`, `X-Trace-Id`, and other non-auth headers no longer satisfy missing credentials; `cf-aig-authorization` remains gateway-only. Google CSE requires `apiKey` because the key is sent in the query string.
- One `web_search` tool is registered for every model. Normal calls try the active provider's native search first and then the configured provider chain; a native failure no longer disables generic search. `auto: false` disables native routing.
- Removed `provider_native_bypass`, cross-provider native discovery, and OpenRouter model-id unwrapping. Only the active model is considered, and `fallback: false` now controls retries inside the configured provider chain only; a native failure still falls through to that chain.
- Each call has a fixed 180-second wall-clock budget covering native credential resolution and all attempts. The effective result count is capped at 50; configured `maxResults` values above 50 are clamped at execution.
- Native capability is keyed by provider identity plus required model API, not model-id prefixes, and only the active model is considered. Credentials, headers, and resolved base URLs come from pi for that model.
- `nativeOverrides` opts unrecognized or renamed gateways into a native adapter with an optional complete endpoint and model; `false` disables native per provider. Overrides cannot contain credentials.
- Provider entries accept `headers` with case-insensitive merge and `null` deletion, including header-only authentication. `cf-aig-authorization` is treated as additive Cloudflare AI Gateway authentication, not a replacement for the provider's primary credential. Authenticated requests refuse redirects.
- `rawMode: true` is validated at load time and requires at least one direct-search provider. Raw calls skip native routing and filter out model-answer providers. Successful native direct-search adapters no longer get the model-answer raw retry hint.
- `/websearch status` reports the active model, mode flags, native adapter candidate or skip reason, and provider chain without resolving credentials.
- Structured source parsing and typed failure diagnostics replace prose-URL harvesting; native and fallback attempts are retained in details.
- Model-backed Perplexity and Z.ai entries select chat endpoints by default. Anthropic OAuth search includes the CLI identity required by pi's adapter, including header-only tokens; page age is retained as metadata rather than replacing source snippets. Responses citations are collected across output blocks and merged with other structured search sources.
- xAI falls back when domain filters exceed the API limit rather than silently dropping domains.
- Credentials echoed by upstream services are redacted without rewriting unrelated result URLs or snippets, including credentials supplied in endpoint query parameters.
- The native unsupported cache is limited to five minutes and isolated by account credentials. Only explicit unsupported tool or search failures are cached, not invalid arguments, authentication, or quota failures.

### Limitations

- Codex subscription support follows pi's ChatGPT backend wire format and is covered by mocked transport and real SDK lifecycle tests, not live account verification. Account/model availability and backend changes may cause fallback. Legacy `codex` remains the API-key Responses provider.
- Provider and gateway behavior is covered by mocked tests only; no live verification is claimed. Provider identity/protocol pairs are candidate adapters, not a whitelist of verified model IDs: only a successful provider response proves hosted search works.
- Cancellation prevents new search fetches and ignores late results, but pi's public authentication API cannot abort a credential refresh already running.
- HTTPS/public-host validation is syntactic only: it rejects literal localhost, private-IP, and credentialed URLs but does not resolve or pin DNS and is not full SSRF protection.

## 0.4.0 - 2026-09-24

### Added

- Kagi search provider (`POST https://kagi.com/api/v1/search`, Bearer auth, lens domain filters) — thanks @ankarhem (#9).
- SERPdive search provider (`POST https://api.serpdive.com/v1/search`, Bearer auth, extracted page content as snippet) — thanks @edendalexis (#7).

### Changed

- Move CI to Bun `1.4.2` (`oven-sh/setup-bun@v2`) with a Node 22/24 matrix on Ubuntu and macOS, plus an `npm ci` consumer job.
- Add `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` as exact `0.87.1` devDependencies. Peer range for `@earendil-works/pi-*` stays `*` so date-versioned downstream runtimes still resolve.
- Accept `ExtensionContext` in `web_search` execute and `string | null` native auth headers so the tool type-checks against pi 0.87.
- Refresh toolchain: `@biomejs/biome` 2.5.5 → 2.5.14, `vitest` 4.1.x → 5.0.1, `@types/node` 25.x → 26.6.2, `@typescript/native-preview` → `7.0.0-dev.20260707.2`, `typebox` 1.3.34 (dev). `typescript` stays 7.0.2 (exact).
- Document Bun as the preferred install/dev toolchain; npm remains a supported consumer path.

### CI

- `actions/checkout@v7`, `actions/setup-node@v7`.
- Jobs: `test` (`bun install --frozen-lockfile`, `bun run check`, `bun run test`, `npm pack --dry-run`) and `npm-consumer` (`npm ci`, `npm test`).
