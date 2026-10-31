import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { performProviderSearch } from "../src/websearch/search.js";
import type { SearchProviderEntry } from "../src/websearch/types.js";

const entry: SearchProviderEntry = {
	id: "test-entry",
	provider: "exa",
	apiKey: "test-secret",
	baseUrl: "https://search.example/?token=endpoint-secret",
};
const request = { query: "lifecycle", maxResults: 2 };

describe("search attempt lifecycle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it.each([
		["fetch", new Error("test-secret endpoint-secret"), "[redacted] [redacted]"],
		["fetch", "test-secret", "Search request failed"],
		["body", new Error("test-secret endpoint-secret"), "[redacted] [redacted]"],
		["body", "test-secret", "Search response read failed"],
	] as const)(
		"#given a %s failure #when the attempt ends #then preserves diagnostics and releases resources",
		async (phase, error, message) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const response = new Response("{}");
			vi.spyOn(response, "text").mockRejectedValue(error);
			const fetchMock = vi.fn(async () => {
				if (phase === "fetch") throw error;
				return response;
			});
			vi.stubGlobal("fetch", fetchMock);

			const details = await performProviderSearch(entry, request, controller.signal, { stage: "native" });

			expect(details).toEqual({
				provider: "exa",
				entryId: "test-entry",
				query: "lifecycle",
				results: [],
				durationMs: 0,
				truncated: false,
				error: message,
				failureKind: "network",
				stage: "native",
			});
			expect(vi.getTimerCount()).toBe(0);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		},
	);

	it.each([
		[200, '{"results":[{"title":"Page","url":"https://example.com/"}]}', undefined],
		[200, "not JSON", "invalid-response"],
		[401, '{"error":"test-secret endpoint-secret"}', "auth"],
	] as const)(
		"#given HTTP %s #when the body is processed #then releases the timer and abort listener",
		async (status, body, failureKind) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body, { status })),
			);

			const details = await performProviderSearch(entry, request, controller.signal, { stage: "fallback" });

			expect(details).toMatchObject({ provider: "exa", entryId: "test-entry", stage: "fallback" });
			expect(details.failureKind).toBe(failureKind);
			if (failureKind) expect(details.httpStatus).toBe(status);
			else expect(details.results).toEqual([{ title: "Page", url: "https://example.com/" }]);
			if (status === 401) expect(details.error).toBe("Search failed with HTTP 401: [redacted] [redacted]");
			expect(vi.getTimerCount()).toBe(0);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		},
	);

	it("#given incompatible entry domains #when request construction fails #then rejects before fetch and releases resources", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const details = await performProviderSearch(
			{ ...entry, allowedDomains: ["one.example"] },
			{ ...request, allowedDomains: ["two.example"] },
			controller.signal,
			{ stage: "fallback" },
		);

		expect(details).toMatchObject({ entryId: "test-entry", stage: "fallback", failureKind: "no-results" });
		expect(details.error).toContain("no search was performed");
		expect(details.httpStatus).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("#given cancellation while reading the body #when the reader rejects #then propagates the caller reason and releases resources", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const reason = new Error("caller cancellation");
		const response = new Response("{}");
		vi.spyOn(response, "text").mockImplementation(async () => {
			controller.abort(reason);
			throw new Error("reader failure");
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);

		await expect(performProviderSearch(entry, request, controller.signal)).rejects.toBe(reason);
		expect(vi.getTimerCount()).toBe(0);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
