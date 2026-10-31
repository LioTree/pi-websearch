import type { JsonObject, JsonValue } from "../types.js";
import { getArray, getNumber, getObject, getString, isJsonObject } from "./shared.js";

const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_CHARS = 1024 * 1024;
const MAX_EVENTS = 10_000;

export class CodexStreamError extends Error {
	readonly code: string | undefined;
	readonly status: number | undefined;
	readonly upstream: boolean;

	constructor(message: string, options: { code?: string; status?: number; upstream?: boolean } = {}) {
		super(message);
		this.name = "CodexStreamError";
		this.code = options.code;
		this.status = options.status;
		this.upstream = options.upstream ?? false;
	}
}

function eventFailure(event: JsonObject, fallback: string): CodexStreamError {
	const response = getObject(event["response"]);
	const rawError = event["error"] ?? response?.["error"];
	const error = getObject(rawError);
	const message = getString(error?.["message"]) ?? getString(event["message"]) ?? getString(rawError);
	const code = getString(error?.["code"]) ?? getString(event["code"]) ?? getString(error?.["type"]);
	const status = getNumber(error?.["status"]) ?? getNumber(event["status"]);
	return new CodexStreamError(message || fallback, {
		...(code ? { code } : {}),
		...(status !== undefined && status >= 400 && status <= 599 ? { status } : {}),
		upstream: Boolean(message || code || error),
	});
}

function outputItemKey(item: JsonValue): string {
	const id = getString(getObject(item)?.["id"]);
	return id ? `id:${id}` : `value:${JSON.stringify(item)}`;
}

/** Read through a successful terminal event, not EOF. Failed/truncated streams never yield partial sources. */
export async function readCodexResponse(response: Response, signal: AbortSignal): Promise<JsonObject> {
	signal.throwIfAborted();
	if (!response.body) throw new CodexStreamError("Codex returned no response stream.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const completedItems = new Map<string, JsonObject>();
	let buffer = "";
	let pendingCr = false;
	let dataLines: string[] = [];
	let eventType = "";
	let eventChars = 0;
	let bytes = 0;
	let events = 0;
	let cancelled = false;
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		// Do not let an underlying cancel hook hold up cancellation or a completed search.
		void reader.cancel().catch(() => {});
	};
	const onAbort = () => cancel();
	signal.addEventListener("abort", onAbort, { once: true });

	function dispatch(): JsonObject | undefined {
		const data = dataLines.join("\n");
		const declaredType = eventType;
		dataLines = [];
		eventType = "";
		eventChars = 0;
		if (!data.trim()) return undefined;
		if (++events > MAX_EVENTS) throw new CodexStreamError("Codex response exceeded the stream event limit.");
		if (data.trim() === "[DONE]") throw new CodexStreamError("Codex stream ended before a completed response.");
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			throw new CodexStreamError("Codex returned invalid SSE JSON.");
		}
		if (!isJsonObject(parsed)) throw new CodexStreamError("Codex returned a non-object SSE event.");
		const type = getString(parsed["type"]) ?? declaredType;
		const terminal = getObject(parsed["response"]);
		if (type === "error" || type === "response.failed" || type === "response.incomplete") {
			throw eventFailure(parsed, `Codex ${type} without a successful response.`);
		}
		if (type === "response.output_item.done") {
			const item = getObject(parsed["item"]);
			if (item && (item["type"] === "web_search_call" || item["type"] === "message")) {
				completedItems.set(outputItemKey(item), item);
			}
		}
		if (type !== "response.completed" && type !== "response.done") return undefined;
		if (!terminal) throw new CodexStreamError("Codex completed event has no response object.");
		if (terminal["error"] || (terminal["status"] !== undefined && terminal["status"] !== "completed")) {
			throw eventFailure(parsed, "Codex terminal response did not complete successfully.");
		}
		// Some gateways omit output items from the terminal snapshot. Merge only
		// completed items by identity. The terminal snapshot wins when an item is
		// present in both, regardless of JSON key order or updated fields.
		const output = new Map<string, JsonValue>();
		for (const item of [...completedItems.values(), ...getArray(terminal["output"])]) {
			output.set(outputItemKey(item), item);
		}
		return { ...terminal, output: [...output.values()] };
	}

	function line(value: string): JsonObject | undefined {
		if (value === "") return dispatch();
		if (value.startsWith(":")) return undefined;
		const colon = value.indexOf(":");
		const field = colon === -1 ? value : value.slice(0, colon);
		const raw = colon === -1 ? "" : value.slice(colon + 1);
		const content = raw.startsWith(" ") ? raw.slice(1) : raw;
		if (field === "data") {
			eventChars += content.length + 1;
			if (eventChars > MAX_EVENT_CHARS) throw new CodexStreamError("Codex SSE event exceeded the size limit.");
			dataLines.push(content);
		} else if (field === "event") {
			eventType = content;
		}
		return undefined;
	}

	try {
		signal.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			bytes += value?.byteLength ?? 0;
			if (bytes > MAX_STREAM_BYTES) throw new CodexStreamError("Codex response exceeded the stream size limit.");
			let decoded = done ? decoder.decode() : decoder.decode(value, { stream: true });
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
			if (buffer.length + eventChars > MAX_EVENT_CHARS)
				throw new CodexStreamError("Codex SSE event exceeded the size limit.");
			if (!done) continue;
			if (buffer) {
				const payload = line(buffer);
				if (payload) return payload;
			}
			const payload = dispatch();
			if (payload) return payload;
			throw new CodexStreamError("Codex stream ended before a completed response.");
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		cancel();
		reader.releaseLock();
	}
}
