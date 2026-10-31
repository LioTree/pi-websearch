import type { RoutingStrategy, SearchProviderEntry } from "./types.js";

export interface SearchRoutingState {
	roundRobinCursor: number;
	successCounts: number[];
}

export function createSearchRoutingState(providerCount: number): SearchRoutingState {
	return { roundRobinCursor: 0, successCounts: Array.from({ length: providerCount }, () => 0) };
}

export function providerEntryLabel(entry: {
	readonly provider: string;
	readonly id?: string;
	readonly entryId?: string;
}): string {
	const id = entry.entryId ?? entry.id;
	if (!id || id === entry.provider) return entry.provider;
	const nativePrefix = `native-${entry.provider}-`;
	return `${entry.provider}/${id.startsWith(nativePrefix) ? "native" : id}`;
}

function sortedPriorityIndices(providers: SearchProviderEntry[]): number[] {
	return providers
		.map((provider, index) => ({ index, priority: provider.priority ?? index }))
		.sort((left, right) => left.priority - right.priority || left.index - right.index)
		.map((item) => item.index);
}

function providerWeight(provider: SearchProviderEntry, providerCount: number): number {
	const raw = provider.weight ?? 1;
	if (!Number.isFinite(raw)) return 1;
	const cap = Math.max(1, Math.floor(Number.MAX_SAFE_INTEGER / Math.max(1, providerCount)));
	return Math.min(cap, Math.max(1, Math.trunc(raw)));
}

function weightedTotal(providers: SearchProviderEntry[]): number {
	let total = 0;
	for (const provider of providers) total += providerWeight(provider, providers.length);
	return total;
}

function weightedOrder(providers: SearchProviderEntry[], cursor: number): number[] {
	const count = providers.length;
	if (count === 0) return [];
	const weights = providers.map((provider) => providerWeight(provider, count));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	if (total <= 0) return providers.map((_provider, index) => index);
	const normalizedCursor = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
	const position = ((normalizedCursor % total) + total) % total;
	let cumulative = 0;
	let start = 0;
	for (let index = 0; index < weights.length; index += 1) {
		cumulative += weights[index] ?? 0;
		if (position < cumulative) {
			start = index;
			break;
		}
	}
	return Array.from({ length: count }, (_value, offset) => (start + offset) % count);
}

export function selectOrder(
	strategy: RoutingStrategy,
	providers: SearchProviderEntry[],
	state: SearchRoutingState,
): number[] {
	if (strategy === "priority") return sortedPriorityIndices(providers);
	if (strategy === "round-robin") return weightedOrder(providers, state.roundRobinCursor);

	let selected = 0;
	let selectedCount = state.successCounts[0] ?? 0;
	for (let index = 1; index < providers.length; index += 1) {
		const count = state.successCounts[index] ?? 0;
		if (count < selectedCount) {
			selected = index;
			selectedCount = count;
		}
	}
	return [selected, ...providers.map((_provider, index) => index).filter((index) => index !== selected)];
}

export function advanceRoundRobin(
	strategy: RoutingStrategy,
	providers: SearchProviderEntry[],
	state: SearchRoutingState,
): void {
	if (strategy !== "round-robin") return;
	const total = weightedTotal(providers);
	if (total > 0) state.roundRobinCursor = (state.roundRobinCursor + 1) % total;
}
