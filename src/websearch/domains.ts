export interface DomainPolicy {
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export class EmptyDomainPolicyError extends Error {
	readonly policy: DomainPolicy;

	constructor(policy: DomainPolicy) {
		const allowed = policy.allowedDomains?.length ? policy.allowedDomains.join(", ") : "(none)";
		const blocked = policy.blockedDomains?.length ? policy.blockedDomains.join(", ") : "(none)";
		super(`Domain policy excludes every source (allowed: ${allowed}; blocked: ${blocked})`);
		this.name = "EmptyDomainPolicyError";
		this.policy = policy;
	}
}

export function canonicalDomain(value: string): string {
	return value.trim().toLowerCase().replace(/^\*\./, "").replace(/\.+$/, "");
}

export function domainWithin(domain: string, parent: string): boolean {
	const child = canonicalDomain(domain);
	const ancestor = canonicalDomain(parent);
	if (child.length === 0 || ancestor.length === 0) return false;
	return child === ancestor || child.endsWith(`.${ancestor}`);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function canonicalList(values: string[] | undefined): string[] | undefined {
	if (values === undefined) return undefined;
	return unique(values.map(canonicalDomain).filter((value) => value.length > 0));
}

/**
 * Intersect two allowed-domain scopes hierarchically. The narrower scope wins:
 * example.com ∩ docs.example.com = docs.example.com, and disjoint scopes
 * produce an empty intersection that is rejected by mergeDomainFilters.
 */
function narrowAllowedScopes(left: string[], right: string[]): string[] {
	const intersection: string[] = [];
	for (const leftDomain of left) {
		for (const rightDomain of right) {
			if (domainWithin(leftDomain, rightDomain)) intersection.push(leftDomain);
			else if (domainWithin(rightDomain, leftDomain)) intersection.push(rightDomain);
		}
	}
	return unique(intersection);
}

/**
 * Merge domain policies from global, request, and provider scopes.
 *
 * Allowed scopes can only narrow; blocked scopes union. Allowed scopes fully
 * covered by a blocked parent are removed, while an allowed parent with a
 * blocked child is preserved (the caller postfilters the child). An empty
 * allowed intersection is an error rather than a fabricated sentinel domain.
 */
export function mergeDomainFilters(...policies: DomainPolicy[]): DomainPolicy {
	let allowed: string[] | undefined;
	const blocked: string[] = [];

	for (const policy of policies) {
		const policyAllowed = canonicalList(policy.allowedDomains);
		const policyBlocked = canonicalList(policy.blockedDomains);
		if (policyAllowed !== undefined) {
			allowed = allowed === undefined ? [...policyAllowed] : narrowAllowedScopes(allowed, policyAllowed);
		}
		if (policyBlocked !== undefined) blocked.push(...policyBlocked);
	}

	const mergedBlocked = unique(blocked);
	if (allowed !== undefined) {
		allowed = allowed.filter((domain) => !mergedBlocked.some((blockedDomain) => domainWithin(domain, blockedDomain)));
	}

	const merged: DomainPolicy = {
		...(allowed === undefined ? {} : { allowedDomains: allowed }),
		...(mergedBlocked.length === 0 ? {} : { blockedDomains: mergedBlocked }),
	};
	if (merged.allowedDomains !== undefined && merged.allowedDomains.length === 0) {
		throw new EmptyDomainPolicyError(merged);
	}
	return merged;
}

/** Case-, wildcard-, and subdomain-boundary-safe result host check. */
export function isHostAllowedByPolicy(hostname: string, policy: DomainPolicy): boolean {
	const host = canonicalDomain(hostname);
	if (host.length === 0) return false;
	const allowed = canonicalList(policy.allowedDomains);
	if (allowed !== undefined && !allowed.some((domain) => domainWithin(host, domain))) return false;
	const blocked = canonicalList(policy.blockedDomains);
	if (blocked?.some((domain) => domainWithin(host, domain))) return false;
	return true;
}
