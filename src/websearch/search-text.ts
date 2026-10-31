import { providerEntryLabel } from "./routing-order.js";
import type { SearchAttempt, SearchDetails } from "./types.js";

function formatAttempt(attempt: SearchAttempt): string {
	const status = attempt.error
		? `failed${attempt.failureKind ? `(${attempt.failureKind})` : ""}: ${attempt.error}`
		: `${attempt.resultsCount} result${attempt.resultsCount === 1 ? "" : "s"}`;
	return `${providerEntryLabel(attempt)} ${status}`;
}

export function formatSearchText(details: SearchDetails): string {
	const lines: string[] = [];
	if (details.error) {
		lines.push(details.error);
		if (details.attempts && details.attempts.length > 0) {
			lines.push("", `Routing attempts: ${details.attempts.map(formatAttempt).join(" -> ")}`);
		}
		return lines.join("\n");
	}
	if (details.results.length === 0) return `No web search results found for "${details.query}".`;

	const route =
		details.stage === "native"
			? ` via ${providerEntryLabel(details)} (native)`
			: details.strategy
				? ` via ${providerEntryLabel(details)} (${details.strategy})`
				: ` via ${details.provider}`;
	lines.push(`Web search results for "${details.query}"${route}:`, "");
	if (details.attempts && details.attempts.length > 0) {
		lines.push(`Routing attempts: ${details.attempts.map(formatAttempt).join(" -> ")}`, "");
	}
	if (details.answer) lines.push("Search answer:", details.answer, "", "Sources:");
	for (const [index, item] of details.results.entries()) {
		lines.push(`${index + 1}. ${item.title}`);
		lines.push(`   ${item.url}`);
		if (item.snippet) lines.push(`   ${item.snippet}`);
	}
	lines.push("", "REMINDER: Include relevant sources from the URLs above in the final answer.");
	return lines.join("\n");
}
