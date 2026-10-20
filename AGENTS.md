# Repository Conventions

Conventions for human contributors and AI agents working on this repository.

## Style

- Terse technical prose. No emojis in commits, issues, PR comments, or code.
- TypeScript strict mode. No `any`, no `unknown` casts where avoidable, no `@ts-ignore`, no `@ts-expect-error`, no enums.
- ESM modules with `.js` suffix in import paths (Node16 resolution).
- Tabs for indentation. Double quotes for strings.
- Tests use vitest with `#given .. #when .. #then` description style or plain `// given / // when / // then` body comments.

## Commands

- `bun install` — install dependencies (preferred for development).
- `npm install` / `npm ci` — supported consumer install paths.
- `bun run test` / `npm test` — run vitest test suite once.
- `bun run typecheck` — strict TypeScript check.
- `bun run check` — type check + biome.
- `pi -e ./src/index.ts` — load the extension into a local pi session for manual smoke testing.

## Constraints

- No Bun APIs. Runtime is Node 22.19+. Bun is used as the development/CI toolchain, not as a runtime API.
- The extension is standalone and depends only on the public pi extension API.
- Provider configuration is explicit: no config means the extension refuses to activate and surfaces a TUI startup error. Config loading rejects unknown keys and whitespace-only identifiers, domains, keys, and native override values.
- Provider headers count as credentials only for documented auth names (`Authorization`, `x-api-key`, Brave `X-Subscription-Token`, Serper `X-API-KEY`); unrelated tracing headers and gateway-only `cf-aig-authorization` do not satisfy provider auth. Google CSE always requires `apiKey`.
- Exa, Tavily, Brave, Serper, Google CSE, DeepSeek, Z.ai, OpenAI/Codex hosted search, Anthropic Messages search, Perplexity, xAI, and Kagi require their documented credentials.
- `auto` (default `true`) resolves only the active `ExtensionContext.model`. Native routing is keyed by provider identity plus required `model.api`: `openai`/`openai-responses`, `anthropic`/`anthropic-messages`, `xai`/`openai-responses`, `zai`, `z-ai`, or `zai-coding-cn` with `openai-completions`, `perplexity`/`openai-completions`, `kimi-coding`, `deepseek` (dedicated Search API, independent of chat protocol), and `openai-codex`/`openai-codex-responses` (the native `codex` adapter uses the separate `openai-codex` search backend). There is no model-id prefix matching, OpenRouter id unwrapping, or `getAvailable()` discovery. Unknown or renamed gateways opt in with `nativeOverrides[provider] = { adapter, endpoint?, model? }`; `false` disables native for that provider. Overrides carry no credentials: the native entry inherits pi-resolved `apiKey`, headers, and base URL via `ExtensionContext.modelRegistry.getApiKeyAndHeaders`, unless a complete override endpoint is set.
- Native search is attempted first for normal calls and always falls through to the configured chain on failure; `fallback` controls retries within the configured chain only. `rawMode: true` requires at least one direct-search provider at load time and adds the optional `mode: "raw"` parameter; a raw call skips native and filters to direct-search entries. The tool is always registered and resolves model/auth/config from the context of each call; `provider_native_bypass` and cross-provider discovery are removed. `/websearch status` uses synchronous adapter inspection and must not resolve credentials.
- Each call has a fixed 180-second wall-clock budget covering native credential resolution and all attempts; per-entry `timeoutMs` cannot extend it. Effective results are capped at 50 even when config accepts a larger `maxResults`.
- The five-minute native unsupported cache is isolated by account credentials and applies only to explicit unsupported tool or search failures, never invalid arguments, auth, or quota. Cancellation prevents new search fetches and discards late results, but pi's public auth API cannot abort a credential refresh already running.
- Provider identity/protocol pairs are candidate adapters, not a verified model-ID whitelist; only an actual provider response proves hosted search. HTTPS/public-host validation is syntactic only (literal local/private/credentialed URLs), with no DNS resolution or pinning and no claim of full SSRF protection.
- DeepSeek uses `POST /v1/tools/search` with bearer auth, `count` 1–50, and `need_content: false`. It is a direct-search provider eligible for raw calls when explicitly configured. The query including domain operators must contain 1–128 Unicode characters; reject overlong queries without truncating them. Native calls inherit pi auth; unknown gateway names require an override.
- Codex subscription search uses its own `/codex/responses` transport: effective bearer credential plus account ID, structured input, instructions, `store: false`, `stream: true`, and SSE decoding. Only successful terminal responses yield structured sources; stream failures/truncation fall back, cancellation does not. HTTP-200 stream auth/quota errors must not be cached as unsupported. Legacy explicit `codex` remains API-key Responses; `openai-codex` is a separate model-answer provider excluded from raw. No live subscription verification is claimed.
- TUI rendering reads typed `details` returned by tool `execute`; renderers never parse formatted strings.
