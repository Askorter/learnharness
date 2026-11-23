/**
 * Pure HTTP/HTTPS proxy settings helpers — shared by core settings,
 * server undici routing, safe-fetch, and the settings UI.
 * Browser-safe: no Node builtins, no IO.
 */

export interface ProxySettings {
	/** Explicit opt-in switch. When false, saved url/noProxy are preserved but inactive. */
	enabled?: boolean;
	/** HTTP or HTTPS proxy URL (e.g. "http://127.0.0.1:7890"). */
	url?: string;
	/** Comma-separated hosts or domain suffixes that bypass the proxy. */
	noProxy?: string;
}

export const DEFAULT_PROXY_SETTINGS: Required<ProxySettings> = {
	enabled: false,
	url: "",
	noProxy: "",
};

const CONTROL_OR_SPACE = /[\s\x00-\x1f\x7f]/;

/** Normalize a raw proxy URL input by trimming surrounding whitespace. */
export function normalizeProxyUrl(value: string): string {
	return value.trim();
}

/** True when `value` is a syntactically valid http:// or https:// proxy URL. */
export function isValidProxyUrl(value: string): boolean {
	const trimmed = normalizeProxyUrl(value);
	if (!trimmed || CONTROL_OR_SPACE.test(trimmed)) return false;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		return parsed.hostname.length > 0;
	} catch {
		return false;
	}
}

/** Parse a comma- or whitespace-separated noProxy string into normalized tokens. */
export function parseNoProxyList(noProxy?: string): string[] {
	if (!noProxy) return [];
	return noProxy
		.split(/[,\s]+/)
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

function normalizeHostname(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]")
		? trimmed.slice(1, -1)
		: trimmed;
	return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

function stripOptionalPort(entry: string): string {
	if (entry.startsWith("[")) {
		const end = entry.indexOf("]");
		if (end !== -1) return entry.slice(1, end);
	}
	// Only strip :port when there is a single colon (IPv6 literals have multiple colons).
	const firstColon = entry.indexOf(":");
	if (firstColon !== -1 && entry.indexOf(":", firstColon + 1) === -1) {
		return entry.slice(0, firstColon);
	}
	return entry;
}

/** True when `hostname` should bypass the proxy. Loopback hosts are ALWAYS bypassed. */
export function shouldBypassProxy(hostname: string, noProxy?: string): boolean {
	const host = normalizeHostname(hostname);
	if (!host) return true;
	if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1") {
		return true;
	}
	for (const rawEntry of parseNoProxyList(noProxy)) {
		if (rawEntry === "*") return true;
		const stripped = stripOptionalPort(rawEntry);
		const normalized = normalizeHostname(stripped.startsWith("*.") ? stripped.slice(2) : stripped.startsWith(".") ? stripped.slice(1) : stripped);
		if (!normalized) continue;
		if (host === normalized || host.endsWith(`.${normalized}`)) return true;
	}
	return false;
}

/** True when the proxy is both enabled and carries a valid http(s) URL. */
export function isProxyActive(
	proxy?: ProxySettings | null,
): proxy is { enabled: true; url: string; noProxy?: string } {
	return Boolean(proxy?.enabled === true && typeof proxy.url === "string" && isValidProxyUrl(proxy.url));
}

/** Build undici EnvHttpProxyAgent `noProxy` string, always excluding loopback. */
export function buildUndiciNoProxy(noProxy?: string): string {
	const base = ["localhost", "127.0.0.1", "[::1]", "::1"];
	const seen = new Set(base);
	for (const entry of parseNoProxyList(noProxy)) {
		if (!seen.has(entry)) {
			seen.add(entry);
			base.push(entry);
		}
	}
	return base.join(",");
}

/** Build Electron session.setProxy `proxyBypassRules` string, always excluding loopback. */
export function buildElectronProxyBypassRules(noProxy?: string): string {
	const base = ["<local>", "localhost", "127.0.0.1", "[::1]", "*.localhost"];
	const seen = new Set(base);
	for (const entry of parseNoProxyList(noProxy)) {
		if (!seen.has(entry)) {
			seen.add(entry);
			base.push(entry);
		}
	}
	return base.join(",");
}
