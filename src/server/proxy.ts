/**
 * Server-side HTTP/HTTPS proxy runtime.
 *
 * Applies the explicit in-app proxy setting to Node's global undici dispatcher
 * (covering pi-ai model calls, remote model catalog, web search, custom
 * providers, etc.) and injects the active proxy into safeFetch (web_fetch).
 *
 * Explicit-only contract: when the in-app proxy is disabled, global fetch uses
 * a clean direct Agent and never implicitly reads HTTP_PROXY / HTTPS_PROXY.
 */

import { Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { buildUndiciNoProxy, isProxyActive, normalizeProxyUrl, type ProxySettings } from "../core/proxy.ts";
import { setSafeFetchProxy } from "../agent/tools/safe-fetch.ts";
import { readSettings } from "../store/settings.ts";

export function createProxyRoutingDispatcher(proxyUrl: string, noProxy?: string): Dispatcher {
	return new EnvHttpProxyAgent({
		httpProxy: proxyUrl,
		httpsProxy: proxyUrl,
		noProxy: buildUndiciNoProxy(noProxy),
	});
}

let activeGlobalDispatcher: Dispatcher | null = null;
let activeSafeFetchAgent: ProxyAgent | null = null;
let activeKey = "";

function closeQuietly(dispatcher: Dispatcher | null): void {
	if (!dispatcher) return;
	void dispatcher.close().catch(() => {});
}

/** Apply (or clear) the process-wide HTTP/HTTPS proxy immediately. */
export function applyProxySettings(proxy?: ProxySettings | null): void {
	const active = isProxyActive(proxy);
	const url = active ? normalizeProxyUrl(proxy.url) : "";
	const noProxy = active ? (proxy.noProxy ?? "").trim() : "";
	const nextKey = active ? `on:${url}|${noProxy}` : "off";
	if (nextKey === activeKey && activeGlobalDispatcher !== null) return;

	const prevGlobal = activeGlobalDispatcher;
	const prevSafe = activeSafeFetchAgent;

	if (active) {
		const routing = createProxyRoutingDispatcher(url, noProxy);
		const safeAgent = new ProxyAgent(url);
		setGlobalDispatcher(routing);
		setSafeFetchProxy({ dispatcher: safeAgent, noProxy });
		activeGlobalDispatcher = routing;
		activeSafeFetchAgent = safeAgent;
	} else {
		const direct = new Agent();
		setGlobalDispatcher(direct);
		setSafeFetchProxy(null);
		activeGlobalDispatcher = direct;
		activeSafeFetchAgent = null;
	}

	activeKey = nextKey;
	closeQuietly(prevGlobal);
	closeQuietly(prevSafe);
}

/** Boot-time initialization from data/settings.json. */
export function initializeProxy(): void {
	const settings = readSettings();
	applyProxySettings(settings?.general?.proxy);
}
