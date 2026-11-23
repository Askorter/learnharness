import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import { fetch as undiciFetch } from "undici";
import {
	buildElectronProxyBypassRules,
	isProxyActive,
	isValidProxyUrl,
	resolveSettings,
	sanitizeUserSettings,
	shouldBypassProxy,
} from "../src/core/index.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";
import { applyProxySettings, createProxyRoutingDispatcher } from "../src/server/proxy.ts";
import { safeFetch, setSafeFetchProxy } from "../src/agent/tools/safe-fetch.ts";

const require = createRequire(import.meta.url);
const electronProxy = require("../electron/proxy.cjs") as {
	normalizeProxySettings: (raw: unknown) => { enabled: boolean; url: string; noProxy: string };
	buildElectronProxyConfig: (proxy: unknown) => { mode: string; proxyRules?: string; proxyBypassRules?: string };
	applyElectronProxy: (proxy: unknown, opts?: { session?: { setProxy: (cfg: unknown) => Promise<void> } }) => Promise<unknown>;
};

afterEach(() => {
	applyProxySettings(null);
	setSafeFetchProxy(null);
});

describe("core/proxy helpers", () => {
	it("validates http and https proxy URLs only", () => {
		assert.equal(isValidProxyUrl("http://127.0.0.1:7890"), true);
		assert.equal(isValidProxyUrl("https://proxy.example.com:8443"), true);
		assert.equal(isValidProxyUrl("  http://user:pass@127.0.0.1:7890  "), true);
		assert.equal(isValidProxyUrl("socks5://127.0.0.1:7891"), false);
		assert.equal(isValidProxyUrl("127.0.0.1:7890"), false);
		assert.equal(isValidProxyUrl(""), false);
		assert.equal(isValidProxyUrl("http://bad host:7890"), false);
	});

	it("always bypasses loopback hosts and matches noProxy patterns", () => {
		assert.equal(shouldBypassProxy("localhost"), true);
		assert.equal(shouldBypassProxy("sub.localhost"), true);
		assert.equal(shouldBypassProxy("127.0.0.1"), true);
		assert.equal(shouldBypassProxy("::1"), true);
		assert.equal(shouldBypassProxy("[::1]"), true);
		assert.equal(shouldBypassProxy("api.openai.com"), false);

		assert.equal(shouldBypassProxy("internal.corp.local", ".corp.local, example.org"), true);
		assert.equal(shouldBypassProxy("corp.local", ".corp.local"), true);
		assert.equal(shouldBypassProxy("sub.example.org", "example.org"), true);
		assert.equal(shouldBypassProxy("notexample.org", "example.org"), false);
		assert.equal(shouldBypassProxy("api.openai.com", "*"), true);
		assert.equal(shouldBypassProxy("myhost.local", "myhost.local:8080"), true);
	});

	it("builds Electron bypass rules including loopback defaults", () => {
		const rules = buildElectronProxyBypassRules("internal.local, .corp.test");
		assert.ok(rules.includes("<local>"));
		assert.ok(rules.includes("127.0.0.1"));
		assert.ok(rules.includes("localhost"));
		assert.ok(rules.includes("[::1]"));
		assert.ok(rules.includes("internal.local"));
		assert.ok(rules.includes(".corp.test"));
	});

	it("checks active state strictly", () => {
		assert.equal(isProxyActive({ enabled: true, url: "http://127.0.0.1:7890" }), true);
		assert.equal(isProxyActive({ enabled: false, url: "http://127.0.0.1:7890" }), false);
		assert.equal(isProxyActive({ enabled: true, url: "" }), false);
		assert.equal(isProxyActive(null), false);
	});
});

describe("settings validation, sanitization, and resolution for proxy", () => {
	it("parses valid general proxy settings and preserves url when disabled", () => {
		const onRes = parseGeneralSettingsBody({
			autoUpdate: true,
			proxy: { enabled: true, url: " http://127.0.0.1:7890 ", noProxy: " .local " },
		});
		assert.equal(onRes.ok, true);
		if (onRes.ok) {
			assert.deepEqual(onRes.settings.proxy, {
				enabled: true,
				url: "http://127.0.0.1:7890",
				noProxy: ".local",
			});
		}

		const offRes = parseGeneralSettingsBody({
			proxy: { enabled: false, url: "http://127.0.0.1:7890", noProxy: "corp.local" },
		});
		assert.equal(offRes.ok, true);
		if (offRes.ok) {
			assert.equal(offRes.settings.proxy?.enabled, false);
			assert.equal(offRes.settings.proxy?.url, "http://127.0.0.1:7890");
		}
	});

	it("rejects enabled proxy with missing or non-http(s) URL", () => {
		const emptyUrl = parseGeneralSettingsBody({ proxy: { enabled: true, url: "" } });
		assert.equal(emptyUrl.ok, false);

		const socksUrl = parseGeneralSettingsBody({ proxy: { enabled: true, url: "socks5://127.0.0.1:7891" } });
		assert.equal(socksUrl.ok, false);
	});

	it("sanitizes corrupt on-disk enabled proxy to disabled and resolves factory defaults", () => {
		const sanitized = sanitizeUserSettings({
			version: 1,
			general: { proxy: { enabled: true, url: "not-a-url", noProxy: "example.com" } },
		});
		assert.ok(sanitized);
		assert.equal(sanitized.general?.proxy?.enabled, false);
		assert.equal(sanitized.general?.proxy?.noProxy, "example.com");

		const resolved = resolveSettings(null);
		assert.deepEqual(resolved.general.proxy, { enabled: false, url: "", noProxy: "" });
	});
});

describe("electron/proxy.cjs", () => {
	it("builds fixed_servers vs direct session proxy config", async () => {
		const seen: unknown[] = [];
		const fakeSession = {
			setProxy: async (cfg: unknown) => {
				seen.push(cfg);
			},
		};
		await electronProxy.applyElectronProxy(
			{ enabled: true, url: "http://127.0.0.1:7890", noProxy: "corp.local" },
			{ session: fakeSession },
		);
		assert.equal(seen.length, 1);
		assert.equal((seen[0] as { mode: string }).mode, "fixed_servers");
		assert.equal((seen[0] as { proxyRules: string }).proxyRules, "http://127.0.0.1:7890");

		await electronProxy.applyElectronProxy(
			{ enabled: false, url: "http://127.0.0.1:7890" },
			{ session: fakeSession },
		);
		assert.equal(seen.length, 2);
		assert.deepEqual(seen[1], { mode: "direct" });
	});
});

describe("server proxy routing and safeFetch integration", () => {
	it("routes non-bypassed traffic through the HTTP proxy and bypasses loopback", async () => {
		const proxiedTargets: string[] = [];
		const proxyServer = http.createServer((req, res) => {
			proxiedTargets.push(req.url ?? "");
			res.writeHead(200, { "content-type": "text/plain", connection: "close" });
			res.end("via-proxy");
		});
		proxyServer.on("connect", (req, clientSocket) => {
			proxiedTargets.push(req.url ?? "");
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			clientSocket.once("data", () => {
				clientSocket.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia-proxy");
			});
		});
		const directServer = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain", connection: "close" });
			res.end("via-direct");
		});
		await Promise.all([
			new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve)),
			new Promise<void>((resolve) => directServer.listen(0, "127.0.0.1", resolve)),
		]);
		try {
			const proxyPort = (proxyServer.address() as { port: number }).port;
			const directPort = (directServer.address() as { port: number }).port;
			const proxyUrl = `http://127.0.0.1:${proxyPort}`;
			const dispatcher = createProxyRoutingDispatcher(proxyUrl, "bypass.example");
			try {
				const proxiedRes = await undiciFetch("http://public.example/hello", { dispatcher });
				assert.equal(await proxiedRes.text(), "via-proxy");
				assert.equal(proxiedTargets.length, 1);

				const directRes = await undiciFetch(`http://127.0.0.1:${directPort}/ping`, { dispatcher });
				assert.equal(await directRes.text(), "via-direct");
				assert.equal(proxiedTargets.length, 1);
			} finally {
				await dispatcher.close();
			}

			applyProxySettings({ enabled: true, url: proxyUrl });
			const safeRes = await safeFetch("http://public.example/from-safe-fetch");
			assert.equal(await safeRes.text(), "via-proxy");

			await assert.rejects(
				() => safeFetch("http://169.254.169.254/latest/meta-data/"),
				/refusing to connect to a private or local address/,
			);
			await assert.rejects(
				() => safeFetch(`http://127.0.0.1:${directPort}/secret`),
				/refusing to connect to a private or local address/,
			);
		} finally {
			proxyServer.close();
			proxyServer.closeAllConnections();
			directServer.close();
			directServer.closeAllConnections();
		}
	});
});
