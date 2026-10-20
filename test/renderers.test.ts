import { describe, expect, it } from "vitest";

import { renderSearchCall, renderSearchResult } from "../src/websearch/renderers.js";
import type { SearchDetails, SearchProgressDetails } from "../src/websearch/types.js";

const theme = {
	bold: (value: string) => value,
	fg: (_key: string, value: string) => value,
};

describe("renderSearchCall", () => {
	it("#given search args #when rendering call #then includes query and provider hint", () => {
		// given / when
		const component = renderSearchCall({ query: "pi extensions", allowed_domains: ["example.com"] }, theme);

		// then
		expect(component.render(80).join("\n")).toContain("web_search");
		expect(component.render(80).join("\n")).toContain("pi extensions");
	});
});

describe("renderSearchResult", () => {
	it("#given progress details #when rendering partial result #then includes route and result limit", () => {
		// given / when
		const component = renderSearchResult(
			{
				content: [{ type: "text", text: 'Searching "pi extensions" via default/duckduckgo-html (max 10)' }],
				details: {
					phase: "searching",
					query: "pi extensions",
					providerLabels: ["default/duckduckgo-html"],
					maxResults: 10,
				},
			},
			{ isPartial: true },
			theme,
		);

		// then
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("Searching");
		expect(rendered).toContain("default/duckduckgo-html");
		expect(rendered).toContain("max 10");
	});

	it("#given native skipped progress #when expanded #then shows the native status and reason", () => {
		// given
		const details: SearchProgressDetails = {
			phase: "searching",
			query: "native skip",
			providerLabels: ["exa/primary"],
			routeLabels: ["exa/primary"],
			currentProvider: "exa/primary",
			maxResults: 10,
			mode: "normal",
			native: {
				status: "skipped",
				provider: "openai",
				model: "gpt-5.5",
				adapter: "openai",
				reason: "tool not supported",
			},
		};

		// when
		const rendered = renderSearchResult(
			{ content: [{ type: "text", text: "" }], details },
			{ isPartial: true, expanded: true },
			theme,
		)
			.render(120)
			.join("\n");

		// then
		expect(rendered).toContain("native openai gpt-5.5 skipped: tool not supported");
	});

	it("#given search details #when rendering expanded result #then includes source rows", () => {
		// given
		const details: SearchDetails = {
			provider: "exa",
			entryId: "exa-search",
			query: "pi extensions",
			results: [{ title: "Pi", url: "https://example.com/pi", snippet: "Pi docs" }],
			durationMs: 42,
			truncated: false,
			strategy: "priority",
			attempts: [{ provider: "exa", entryId: "exa-search", durationMs: 42, resultsCount: 1 }],
		};

		// when
		const component = renderSearchResult(
			{ content: [{ type: "text", text: "ok" }], details },
			{ expanded: true },
			theme,
		);

		// then
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("1 result");
		expect(rendered).toContain("exa/exa-search");
		expect(rendered).toContain("route exa/exa-search:1");
		expect(rendered).toContain("https://example.com/pi");
	});

	it("#given native success #when rendering #then labels the native stage", () => {
		// given
		const details: SearchDetails = {
			provider: "openai",
			entryId: "native",
			query: "native",
			results: [{ title: "Native", url: "https://example.com/native" }],
			durationMs: 7,
			truncated: false,
			stage: "native",
			mode: "normal",
			native: { status: "ready", provider: "openai", model: "gpt-5.5", adapter: "openai" },
			attempts: [{ provider: "openai", entryId: "native", durationMs: 7, resultsCount: 1, stage: "native" }],
		};

		// when
		const rendered = renderSearchResult({ content: [{ type: "text", text: "ok" }], details }, {}, theme)
			.render(120)
			.join("\n");

		// then
		expect(rendered).toContain("via openai/native (native)");
	});

	it("#given fallback after native failure #when rendering #then shows native skip reason and route trace", () => {
		// given
		const details: SearchDetails = {
			provider: "exa",
			entryId: "backup",
			query: "fallback",
			results: [{ title: "Backup", url: "https://example.com/backup" }],
			durationMs: 12,
			truncated: false,
			strategy: "priority",
			stage: "fallback",
			mode: "normal",
			native: { status: "skipped", provider: "openai", adapter: "openai", reason: "HTTP 400" },
			attempts: [
				{
					provider: "openai",
					entryId: "native",
					durationMs: 5,
					resultsCount: 0,
					stage: "native",
					failureKind: "request",
					error: "HTTP 400",
				},
				{ provider: "exa", entryId: "backup", durationMs: 7, resultsCount: 1, stage: "fallback" },
			],
		};

		// when
		const rendered = renderSearchResult({ content: [{ type: "text", text: "ok" }], details }, {}, theme)
			.render(120)
			.join("\n");

		// then
		expect(rendered).toContain("native openai skipped: HTTP 400");
		expect(rendered).toContain("via exa/backup (priority)");
	});

	it("#given terminal error with attempts #when rendering #then preserves the failed route trace", () => {
		// given
		const details: SearchDetails = {
			provider: "exa",
			query: "all fail",
			results: [],
			durationMs: 20,
			truncated: false,
			error: "All search providers failed: exa/auth failed(auth)",
			failureKind: "request",
			stage: "fallback",
			native: { status: "skipped", provider: "openai", adapter: "openai", reason: "no active model" },
			attempts: [
				{
					provider: "exa",
					entryId: "primary",
					durationMs: 20,
					resultsCount: 0,
					stage: "fallback",
					failureKind: "auth",
					error: "Search failed with HTTP 401",
				},
			],
		};

		// when
		const rendered = renderSearchResult({ content: [{ type: "text", text: "error" }], details }, {}, theme)
			.render(120)
			.join("\n");

		// then
		expect(rendered).toContain("All search providers failed");
		expect(rendered).toContain("route exa/primary:failed(auth)");
		expect(rendered).toContain("native openai skipped: no active model");
	});

	it("#given search details #when rendering collapsed result #then includes top source rows", () => {
		// given
		const details: SearchDetails = {
			provider: "exa",
			entryId: "exa-search",
			query: "pi extensions",
			results: [
				{ title: "Pi", url: "https://example.com/pi", snippet: "Pi docs" },
				{ title: "Extensions", url: "https://example.com/extensions" },
			],
			durationMs: 42,
			truncated: false,
			strategy: "priority",
		};

		// when
		const component = renderSearchResult({ content: [{ type: "text", text: "ok" }], details }, {}, theme);

		// then
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("2 results");
		expect(rendered).toContain("Pi");
		expect(rendered).toContain("https://example.com/pi");
		expect(rendered).toContain("Pi docs");
	});

	it("#given error details #when rendering result #then displays the error message", () => {
		// given / when
		const component = renderSearchResult(
			{
				content: [{ type: "text", text: "Invalid provider config" }],
				details: { phase: "error", query: "pi extensions", error: "Invalid provider config" },
			},
			{},
			theme,
		);

		// then
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("Invalid provider config");
	});

	it("#given partial progress with routeLabels #when rendering expanded #then adds the three-state route line", () => {
		// given
		const details: SearchProgressDetails = {
			phase: "searching",
			query: "route states",
			providerLabels: ["exa/primary", "duckduckgo-html/backup", "brave/extra"],
			routeLabels: ["exa/primary", "duckduckgo-html/backup", "brave/extra"],
			currentProvider: "duckduckgo-html/backup",
			attempts: [{ provider: "exa", entryId: "primary", durationMs: 100, resultsCount: 0, error: "boom" }],
			maxResults: 10,
		};

		// when
		const expanded = renderSearchResult(
			{ content: [{ type: "text", text: "" }], details },
			{ isPartial: true, expanded: true },
			theme,
		)
			.render(120)
			.join("\n");

		// then
		expect(expanded).toContain('Searching "route states" via duckduckgo-html/backup (max 10)');
		expect(expanded).toContain("route exa/primary:failed -> duckduckgo-html/backup:searching -> brave/extra:pending");
	});
});
