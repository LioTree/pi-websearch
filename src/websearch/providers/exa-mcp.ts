import { providerUrl } from "../provider-endpoints.js";
import type { BuiltSearchRequest, JsonObject, SearchFailureKind, SearchResultItem } from "../types.js";
import type { BuildContext, ProviderModule } from "./shared.js";
import {
	appendDomainFilters,
	clamp,
	getArray,
	getNumber,
	getObject,
	getString,
	isJsonObject,
	keyedHeaders,
} from "./shared.js";

const REQUEST_ID = 1;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_CHARS = 1024 * 1024;
const MAX_EVENTS = 10_000;

export class ExaMcpError extends Error {
	constructor(
		message: string,
		readonly failureKind: SearchFailureKind = "invalid-response",
	) {
		super(message);
		this.name = "ExaMcpError";
	}
}

function parseEnvelope(text: string): JsonObject | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new ExaMcpError("Exa MCP returned invalid JSON.");
	}
	if (!isJsonObject(value) || value["jsonrpc"] !== "2.0") {
		throw new ExaMcpError("Exa MCP returned an invalid JSON-RPC envelope.");
	}
	// Streamable HTTP can include notifications before the tools/call response.
	if (value["id"] === undefined && typeof value["method"] === "string") return undefined;
	if (value["id"] !== REQUEST_ID || (value["result"] === undefined) === (value["error"] === undefined)) {
		throw new ExaMcpError("Exa MCP returned a mismatched or invalid tools/call response.");
	}
	return value;
}

/** Stateless hosted tools/call, with bounded JSON or Streamable HTTP SSE decoding. */
export async function readExaMcpResponse(response: Response, signal: AbortSignal): Promise<JsonObject> {
	signal.throwIfAborted();
	const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (mediaType !== "application/json" && mediaType !== "text/event-stream") {
		void response.body?.cancel().catch(() => {});
		throw new ExaMcpError("Exa MCP returned an unsupported response content type.");
	}
	if (!response.body) throw new ExaMcpError("Exa MCP returned no response body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let pendingCr = false;
	let dataLines: string[] = [];
	let eventChars = 0;
	let events = 0;
	let bytes = 0;
	let cancelled = false;
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });

	function line(value: string): JsonObject | undefined {
		if (value === "") {
			const data = dataLines.join("\n");
			dataLines = [];
			eventChars = 0;
			if (!data.trim()) return undefined;
			if (++events > MAX_EVENTS) throw new ExaMcpError("Exa MCP exceeded the SSE event limit.");
			return parseEnvelope(data);
		}
		if (value.startsWith(":")) return undefined;
		const colon = value.indexOf(":");
		const field = colon === -1 ? value : value.slice(0, colon);
		const raw = colon === -1 ? "" : value.slice(colon + 1);
		if (field === "data") {
			const content = raw.startsWith(" ") ? raw.slice(1) : raw;
			eventChars += content.length + 1;
			if (eventChars > MAX_EVENT_CHARS) throw new ExaMcpError("Exa MCP exceeded the SSE event size limit.");
			dataLines.push(content);
		}
		return undefined;
	}

	try {
		signal.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			bytes += value?.byteLength ?? 0;
			if (bytes > MAX_RESPONSE_BYTES) throw new ExaMcpError("Exa MCP exceeded the response size limit.");
			let decoded = done ? decoder.decode() : decoder.decode(value, { stream: true });
			if (mediaType === "application/json") {
				buffer += decoded;
				if (!done) continue;
				const payload = parseEnvelope(buffer);
				if (!payload) throw new ExaMcpError("Exa MCP returned a notification instead of a result.");
				return payload;
			}
			if (pendingCr && decoded.length > 0) {
				pendingCr = false;
				if (decoded.startsWith("\n")) decoded = decoded.slice(1);
			}
			if (decoded.length > 0) pendingCr = decoded.endsWith("\r");
			buffer += decoded;
			const newline = /\r\n|[\r\n]/g;
			let consumed = 0;
			for (let match = newline.exec(buffer); match; match = newline.exec(buffer)) {
				const payload = line(buffer.slice(consumed, match.index));
				consumed = newline.lastIndex;
				if (payload) return payload;
			}
			buffer = buffer.slice(consumed);
			if (buffer.length + eventChars > MAX_EVENT_CHARS) {
				throw new ExaMcpError("Exa MCP exceeded the SSE event size limit.");
			}
			if (done) throw new ExaMcpError("Exa MCP stream ended before a complete tools/call response.");
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}
}

function toolFailure(message: string, raw?: JsonObject): ExaMcpError {
	const formattedStatus = /^web_search_exa error \((\d{3})\):/.exec(message)?.[1];
	const status = raw?.["status"] ?? raw?.["statusCode"] ?? raw?.["code"] ?? Number(formattedStatus);
	let kind: SearchFailureKind = "request";
	if (status === 429 || status === 402 || /rate[ _-]?limit|quota|usage limit/i.test(message)) kind = "quota";
	else if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authentication/i.test(message))
		kind = "auth";
	else if (status === 408 || status === 504 || /timed? ?out|timeout/i.test(message)) kind = "timeout";
	else if (typeof status === "number" && status >= 500 && status <= 599) kind = "network";
	return new ExaMcpError(`Exa MCP search failed: ${message}`, kind);
}

function textResults(rawText: string): SearchResultItem[] {
	// The official server can prepend one-line service notices before its result records.
	const text = rawText.trim().replace(/^(?:Note: [^\n]*\n)+\n/, "");
	if (text === "No search results found. Please try a different query.") return [];
	// This is Exa's fixed search-result serialization, not a model-generated answer.
	// Split only at a separator followed by the next result's metadata header.
	const blocks = text.trim().split(/\n\n---\n\n(?=Title: [^\n]+\nURL: )/);
	return blocks.map((block) => {
		const match =
			/^Title: ([^\n]+)\nURL: ([^\n]+)\n(?:Published: ([^\n]*)\n)?(?:Author: [^\n]*(?:\n|$))?(?:Highlights:\n|Text: )?([\s\S]*)$/.exec(
				block,
			);
		if (!match?.[1] || !match[2]) throw new ExaMcpError("Exa MCP returned unrecognized search-result text.");
		const item: SearchResultItem = { title: match[1], url: match[2] };
		if (match[3] && match[3] !== "N/A") item.publishedAt = match[3];
		if (match[4]?.trim()) item.snippet = match[4].trim();
		return item;
	});
}

export const exaMcpProvider: ProviderModule = {
	buildRequest({ config, request, maxResults, allowedDomains, blockedDomains }: BuildContext): BuiltSearchRequest {
		return {
			url: providerUrl(config),
			responseFormat: "exa-mcp",
			init: {
				method: "POST",
				headers: keyedHeaders(config, "x-api-key", {
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
				}),
			},
			body: {
				jsonrpc: "2.0",
				id: REQUEST_ID,
				method: "tools/call",
				params: {
					name: "web_search_exa",
					arguments: {
						query: appendDomainFilters(request.query, allowedDomains, blockedDomains),
						numResults: clamp(maxResults, 1, 50),
					},
				},
			},
		};
	},
	normalizeResponse(data: JsonObject): SearchResultItem[] {
		if (data["jsonrpc"] !== "2.0" || data["id"] !== REQUEST_ID) {
			throw new ExaMcpError("Exa MCP returned an invalid JSON-RPC response.");
		}
		const error = getObject(data["error"]);
		if (error) throw toolFailure(getString(error["message"]) ?? "JSON-RPC error", getObject(error["data"]) ?? error);
		const tool = getObject(data["result"]);
		if (!tool || data["error"] !== undefined) throw new ExaMcpError("Exa MCP returned no valid tool result.");
		const texts = getArray(tool["content"]).flatMap((part) => {
			const item = getObject(part);
			return item?.["type"] === "text" && typeof item["text"] === "string" ? [item["text"]] : [];
		});
		if (getObject(tool["_meta"])?.["ai.exa/rateLimited"] === true) {
			throw new ExaMcpError(`Exa MCP anonymous rate limit: ${texts.join("\n") || "free quota exhausted"}`, "quota");
		}
		if (tool["isError"] === true) throw toolFailure(texts.join("\n") || "tool returned isError");
		const structured = getObject(tool["structuredContent"]);
		if (structured && Array.isArray(structured["results"])) {
			return structured["results"].map((raw) => {
				const source = getObject(raw);
				const title = getString(source?.["title"]);
				const url = getString(source?.["url"]);
				if (!source || !title || !url) throw new ExaMcpError("Exa MCP returned invalid structured search results.");
				const item: SearchResultItem = { title, url };
				const highlights = getArray(source["highlights"]).filter(
					(part): part is string => typeof part === "string",
				);
				const snippet = highlights.join("\n") || getString(source["text"]) || getString(source["snippet"]);
				const published = getString(source["publishedDate"]);
				const score = getNumber(source["score"]);
				if (snippet) item.snippet = snippet;
				if (published) item.publishedAt = published;
				if (score !== undefined) item.score = score;
				return item;
			});
		}
		if (texts.length === 0) throw new ExaMcpError("Exa MCP returned no search-result text.");
		return texts.flatMap((text) => textResults(text.replace(/\r\n?/g, "\n")));
	},
};
