import type { BuiltSearchRequest, JsonObject, SearchResultItem } from "../types.js";
import { buildResponsesRequest, normalizeResponsesPayload } from "./openai-responses.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import { bearerHeaders, getHeader, getObject, getString, hasHeaderTombstone, isJsonObject } from "./shared.js";

function tokenAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (!isJsonObject(payload)) return undefined;
		return getString(getObject(payload["https://api.openai.com/auth"])?.["chatgpt_account_id"]);
	} catch {
		return undefined;
	}
}

function subscriptionHeaders(ctx: BuildContext): Record<string, string> {
	const headers = bearerHeaders(ctx.config, {
		Accept: "text/event-stream",
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
		originator: "pi",
		"User-Agent": "pi-websearch",
	});
	// Derive identity from the effective outgoing token, never a superseded apiKey.
	const token = getHeader(headers, "Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
	if (!token) throw new Error("Codex subscription search requires a bearer credential.");
	let accountId = getHeader(headers, "chatgpt-account-id");
	if (!accountId && !hasHeaderTombstone(ctx.config.headers, "chatgpt-account-id")) {
		accountId = tokenAccountId(token);
		if (accountId) headers["chatgpt-account-id"] = accountId;
	}
	if (!accountId?.trim() || /[\r\n]/.test(accountId)) {
		throw new Error(
			"Codex subscription search requires an account ID header or a token containing chatgpt_account_id.",
		);
	}
	return headers;
}

/** ChatGPT subscription transport, separate from the legacy `codex` API-key backend. */
export const codexSubscriptionProvider: ProviderModule = {
	buildRequest(ctx: BuildContext): BuiltSearchRequest {
		const built = buildResponsesRequest(ctx);
		return {
			...built,
			responseFormat: "codex-sse",
			init: { method: "POST", headers: subscriptionHeaders(ctx) },
			body: {
				...built.body,
				instructions: "Use web search for the user's query. Return concise findings with source citations.",
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: getString(built.body?.["input"]) ?? ctx.request.query }],
					},
				],
				store: false,
				stream: true,
				parallel_tool_calls: true,
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		return normalizeResponsesPayload(data, { citationsFallback: false });
	},
};
