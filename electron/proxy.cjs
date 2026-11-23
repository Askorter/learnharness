"use strict";
/**
 * Electron main-process HTTP/HTTPS proxy synchronization.
 * Mirrors src/core/proxy.ts + src/server/proxy.ts so main-process fetch
 * (ChatGPT / subscription OAuth) and Electron's defaultSession (renderer
 * WebSockets such as Deepgram dictation) follow data/settings.json without
 * restarting the app.
 */

const fs = require("node:fs");
const path = require("node:path");

const CONTROL_OR_SPACE = /[\s\x00-\x1f\x7f]/;

function normalizeProxyUrl(value) {
	return typeof value === "string" ? value.trim() : "";
}

function isValidProxyUrl(value) {
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

function parseNoProxyList(noProxy) {
	if (typeof noProxy !== "string" || !noProxy) return [];
	return noProxy
		.split(/[,\s]+/)
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

function normalizeHostname(raw) {
	const trimmed = String(raw || "").trim().toLowerCase();
	const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]")
		? trimmed.slice(1, -1)
		: trimmed;
	return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

function stripOptionalPort(entry) {
	if (entry.startsWith("[")) {
		const end = entry.indexOf("]");
		if (end !== -1) return entry.slice(1, end);
	}
	const firstColon = entry.indexOf(":");
	if (firstColon !== -1 && entry.indexOf(":", firstColon + 1) === -1) {
		return entry.slice(0, firstColon);
	}
	return entry;
}

function shouldBypassProxy(hostname, noProxy) {
	const host = normalizeHostname(hostname);
	if (!host) return true;
	if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1") {
		return true;
	}
	for (const rawEntry of parseNoProxyList(noProxy)) {
		if (rawEntry === "*") return true;
		const stripped = stripOptionalPort(rawEntry);
		const normalized = normalizeHostname(
			stripped.startsWith("*.") ? stripped.slice(2) : stripped.startsWith(".") ? stripped.slice(1) : stripped,
		);
		if (!normalized) continue;
		if (host === normalized || host.endsWith(`.${normalized}`)) return true;
	}
	return false;
}

function normalizeProxySettings(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { enabled: false, url: "", noProxy: "" };
	}
	const url = normalizeProxyUrl(raw.url);
	const noProxy = typeof raw.noProxy === "string" ? raw.noProxy.trim() : "";
	const enabled = raw.enabled === true && isValidProxyUrl(url);
	return { enabled, url, noProxy };
}

function readProxySettings(dataDir) {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
		return normalizeProxySettings(parsed?.general?.proxy);
	} catch {
		return { enabled: false, url: "", noProxy: "" };
	}
}

function buildElectronProxyBypassRules(noProxy) {
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

function buildElectronProxyConfig(proxy) {
	const normalized = normalizeProxySettings(proxy);
	if (!normalized.enabled) return { mode: "direct" };
	return {
		mode: "fixed_servers",
		proxyRules: normalized.url,
		proxyBypassRules: buildElectronProxyBypassRules(normalized.noProxy),
	};
}

let activeDispatcher = null;
let activeKey = "";

function loadUndici() {
	try {
		return require("undici");
	} catch {
		return null;
	}
}

function buildUndiciNoProxy(noProxy) {
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

function createRoutingDispatcher(undici, proxyUrl, noProxy) {
	return new undici.EnvHttpProxyAgent({
		httpProxy: proxyUrl,
		httpsProxy: proxyUrl,
		noProxy: buildUndiciNoProxy(noProxy),
	});
}

async function applyElectronProxy(proxy, { session, undici } = {}) {
	const normalized = normalizeProxySettings(proxy);
	const nextKey = normalized.enabled ? `on:${normalized.url}|${normalized.noProxy}` : "off";

	const runtimeUndici = undici ?? loadUndici();
	if (runtimeUndici && (nextKey !== activeKey || !activeDispatcher)) {
		const prev = activeDispatcher;
		const next = normalized.enabled
			? createRoutingDispatcher(runtimeUndici, normalized.url, normalized.noProxy)
			: new runtimeUndici.Agent();
		runtimeUndici.setGlobalDispatcher(next);
		activeDispatcher = next;
		activeKey = nextKey;
		if (prev && typeof prev.close === "function") {
			void prev.close().catch(() => {});
		}
	}

	if (session && typeof session.setProxy === "function") {
		await session.setProxy(buildElectronProxyConfig(normalized));
	}
	return normalized;
}

module.exports = {
	isValidProxyUrl,
	shouldBypassProxy,
	normalizeProxySettings,
	readProxySettings,
	buildElectronProxyBypassRules,
	buildElectronProxyConfig,
	applyElectronProxy,
};
