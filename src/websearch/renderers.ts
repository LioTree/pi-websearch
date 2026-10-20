import { Text } from "@earendil-works/pi-tui";

import { providerEntryLabel } from "./search.js";
import type {
	NativeRouteStatus,
	SearchDetails,
	SearchErrorDetails,
	SearchProgressDetails,
	SearchRenderDetails,
} from "./types.js";

interface ThemeLike {
	bold(value: string): string;
	fg(key: string, value: string): string;
}

interface SearchArgs {
	query: string;
	allowed_domains?: string[];
	blocked_domains?: string[];
}

interface ResultLike<TDetails> {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: TDetails;
}

interface RenderResultOptions {
	expanded?: boolean;
	isPartial?: boolean;
}

function shorten(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function durationText(durationMs: number): string {
	return durationMs >= 1000 ? `${Math.round(durationMs / 1000)}s` : `${durationMs}ms`;
}

function attemptStatus(attempt: { error?: string; failureKind?: string; resultsCount: number }): string {
	if (attempt.error) return `failed${attempt.failureKind ? `(${attempt.failureKind})` : ""}`;
	return `${attempt.resultsCount}`;
}

function attemptLabel(details: SearchDetails): string {
	return details.attempts
		? details.attempts.map((attempt) => `${providerEntryLabel(attempt)}:${attemptStatus(attempt)}`).join(" -> ")
		: "";
}

function nativeStatusLabel(native: NativeRouteStatus): string {
	const provider = native.provider ?? native.adapter ?? "route";
	const adapter = native.adapter && native.adapter !== native.provider ? `/${native.adapter}` : "";
	const model = native.model ? ` ${native.model}` : "";
	const reason = native.reason ? `: ${native.reason}` : "";
	return `native ${provider}${adapter}${model} ${native.status}${reason}`;
}

function routeStateLabel(details: SearchProgressDetails): string {
	const labels = details.routeLabels ?? details.providerLabels;
	if (labels.length === 0) return "";
	const attempts = details.attempts ?? [];
	return labels
		.map((label, index) => {
			const attempt = attempts[index];
			if (attempt) return `${label}:${attemptStatus(attempt)}`;
			return `${label}:${index === attempts.length ? "searching" : "pending"}`;
		})
		.join(" -> ");
}

function isSearchProgressDetails(details: SearchRenderDetails | undefined): details is SearchProgressDetails {
	return details !== undefined && "phase" in details && details.phase === "searching";
}

function isSearchErrorDetails(details: SearchRenderDetails): details is SearchErrorDetails {
	return "phase" in details && details.phase === "error";
}

export function renderSearchCall(args: SearchArgs, theme: ThemeLike): Text {
	const head = theme.fg("toolTitle", theme.bold("web_search "));
	const query = theme.fg("accent", `"${shorten(args.query, 90)}"`);
	const domains = args.allowed_domains ?? args.blocked_domains;
	const filter = domains?.length ? theme.fg("muted", ` domains:${domains.length}`) : "";
	return new Text(head + query + filter, 0, 0);
}

export function renderSearchResult(
	result: ResultLike<SearchRenderDetails>,
	options: RenderResultOptions,
	theme: ThemeLike,
): Text {
	if (options.isPartial) {
		const details = result.details;
		if (isSearchProgressDetails(details)) {
			const nativeLine =
				details.native && details.native.status === "skipped"
					? theme.fg("muted", nativeStatusLabel(details.native))
					: undefined;
			if (details.currentProvider) {
				const line = theme.fg(
					"warning",
					`Searching "${shorten(details.query, 80)}" via ${details.currentProvider} (max ${details.maxResults})`,
				);
				const route = routeStateLabel(details);
				const rows = [line];
				if (options.expanded && route) rows.push(theme.fg("muted", `route ${route}`));
				if (options.expanded && nativeLine) rows.push(nativeLine);
				return new Text(rows.join("\n"), 0, 0);
			}
			const route = details.providerLabels.length > 0 ? details.providerLabels.join(" -> ") : "configured providers";
			const rows = [
				theme.fg("warning", `Searching "${shorten(details.query, 80)}" via ${route} (max ${details.maxResults})`),
			];
			if (options.expanded && nativeLine) rows.push(nativeLine);
			return new Text(rows.join("\n"), 0, 0);
		}
		return new Text(theme.fg("warning", result.content[0]?.text ?? "Searching the web..."), 0, 0);
	}

	const details = result.details;
	if (!details) return new Text(theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);
	if (isSearchProgressDetails(details)) return new Text(theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);
	if (isSearchErrorDetails(details)) return new Text(theme.fg("error", details.error), 0, 0);

	const nativeLine = details.native ? nativeStatusLabel(details.native) : "";
	if (details.error) {
		const rows = [theme.fg("error", details.error)];
		const attempts = attemptLabel(details);
		if (attempts) rows.push(theme.fg("muted", `route ${attempts}`));
		if (nativeLine) rows.push(theme.fg("muted", nativeLine));
		return new Text(rows.join("\n"), 0, 0);
	}

	const count = details.results.length;
	const provider = providerEntryLabel(details);
	const stage = details.stage === "native" ? "native" : details.strategy;
	const summary =
		theme.fg("success", `${count} result${count === 1 ? "" : "s"}`) +
		theme.fg("muted", ` via ${provider}${stage ? ` (${stage})` : ""} in ${durationText(details.durationMs)}`) +
		(details.truncated ? theme.fg("warning", " (truncated)") : "");

	if (count === 0) {
		const rows = [summary];
		if (details.native) rows.push(theme.fg("muted", nativeLine));
		return new Text(rows.join("\n"), 0, 0);
	}

	const attempts = attemptLabel(details);
	const rows = [summary];
	if (nativeLine && (options.expanded || details.native?.status === "skipped")) {
		rows.push(theme.fg("muted", nativeLine));
	}
	if (options.expanded && attempts) rows.push(theme.fg("muted", `route ${attempts}`));
	const visibleLimit = options.expanded ? 8 : 3;
	for (const item of details.results.slice(0, visibleLimit)) {
		rows.push(`${theme.fg("accent", shorten(item.title, 80))} ${theme.fg("dim", shorten(item.url, 100))}`);
		if (item.snippet) rows.push(theme.fg("muted", `  ${shorten(item.snippet, 140)}`));
	}
	if (details.results.length > visibleLimit) {
		rows.push(theme.fg("dim", `… ${details.results.length - visibleLimit} more sources`));
	}
	return new Text(rows.join("\n"), 0, 0);
}
