"use client";

import { useEffect, useState } from "react";
import { isValidProxyUrl, normalizeProxyUrl, type ProxySettings } from "@/src/core";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

const PROXY_URL_HINT = "HTTP or HTTPS proxy URL, e.g. http://127.0.0.1:7890.";
const NO_PROXY_HINT = "Comma-separated hosts or domain suffixes. localhost, 127.0.0.1, and ::1 are always bypassed.";

export function ProxySettingsPanel({
	proxy,
	onSave,
}: {
	proxy?: ProxySettings;
	onSave: (next: ProxySettings) => Promise<boolean>;
}) {
	const savedEnabled = proxy?.enabled === true;
	const savedUrl = proxy?.url ?? "";
	const savedNoProxy = proxy?.noProxy ?? "";

	const [enabled, setEnabled] = useState(savedEnabled);
	const [url, setUrl] = useState(savedUrl);
	const [noProxy, setNoProxy] = useState(savedNoProxy);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedNotice, setSavedNotice] = useState(false);

	useEffect(() => {
		setEnabled(savedEnabled);
		setUrl(savedUrl);
		setNoProxy(savedNoProxy);
	}, [savedEnabled, savedUrl, savedNoProxy]);

	const normalizedUrl = normalizeProxyUrl(url);
	const trimmedNoProxy = noProxy.trim();
	const dirty = enabled !== savedEnabled || normalizedUrl !== savedUrl || trimmedNoProxy !== savedNoProxy;

	const persist = async (next: ProxySettings) => {
		setSaving(true);
		setError(null);
		setSavedNotice(false);
		try {
			const ok = await onSave(next);
			if (ok) {
				window.lh?.setProxy?.(next);
				setSavedNotice(true);
			}
		} finally {
			setSaving(false);
		}
	};

	const handleToggle = (on: boolean) => {
		setEnabled(on);
		setSavedNotice(false);
		if (on && !isValidProxyUrl(normalizedUrl)) {
			setError("Enter a valid http:// or https:// proxy URL, then click Save.");
			return;
		}
		setError(null);
		void persist({
			enabled: on,
			...(normalizedUrl ? { url: normalizedUrl } : {}),
			...(trimmedNoProxy ? { noProxy: trimmedNoProxy } : {}),
		});
	};

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (saving) return;
		if (enabled && !isValidProxyUrl(normalizedUrl)) {
			setError("Proxy URL must be a valid http:// or https:// URL when proxy is enabled.");
			return;
		}
		void persist({
			enabled,
			...(normalizedUrl ? { url: normalizedUrl } : {}),
			...(trimmedNoProxy ? { noProxy: trimmedNoProxy } : {}),
		});
	};

	return (
		<SettingsGroup label="Network" testid="group-network">
			<form onSubmit={handleSubmit} className="flex flex-col gap-3">
				<SettingsRow
					label="HTTP/HTTPS proxy"
					hint="Route model requests, OAuth sign-in, web search, and dictation through a proxy. Takes effect immediately."
					testid="row-proxy-enabled"
				>
					<Toggle
						checked={enabled}
						onChange={handleToggle}
						disabled={saving}
						label="Enable HTTP/HTTPS proxy"
					/>
				</SettingsRow>

				<div className="flex flex-col gap-1.5" data-testid="row-proxy-url">
					<label htmlFor="lh-proxy-url" className="font-prose text-(length:--lh-prose-size) text-foreground">
						Proxy URL
					</label>
					<input
						id="lh-proxy-url"
						type="text"
						value={url}
						onChange={(e) => {
							setUrl(e.target.value);
							setError(null);
							setSavedNotice(false);
						}}
						placeholder="http://127.0.0.1:7890"
						autoComplete="off"
						spellCheck={false}
						disabled={saving}
						data-testid="proxy-url-input"
						className="h-8 w-full rounded-sm border border-border bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/50 focus:outline-none disabled:opacity-50"
					/>
					<span className="text-xs text-muted-foreground/70">{PROXY_URL_HINT}</span>
				</div>

				<div className="flex flex-col gap-1.5" data-testid="row-proxy-noproxy">
					<label htmlFor="lh-proxy-noproxy" className="font-prose text-(length:--lh-prose-size) text-foreground">
						No proxy
					</label>
					<input
						id="lh-proxy-noproxy"
						type="text"
						value={noProxy}
						onChange={(e) => {
							setNoProxy(e.target.value);
							setError(null);
							setSavedNotice(false);
						}}
						placeholder="internal.example.com, .local"
						autoComplete="off"
						spellCheck={false}
						disabled={saving}
						data-testid="proxy-noproxy-input"
						className="h-8 w-full rounded-sm border border-border bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/50 focus:outline-none disabled:opacity-50"
					/>
					<span className="text-xs text-muted-foreground/70">{NO_PROXY_HINT}</span>
				</div>

				<div className="flex items-center justify-between gap-3 pt-1">
					<div className="min-w-0 text-xs">
						{error && <span role="alert" className="text-destructive" data-testid="proxy-error">{error}</span>}
						{!error && savedNotice && <span role="status" className="text-muted-foreground" data-testid="proxy-saved">Saved</span>}
					</div>
					<Button
						type="submit"
						size="xs"
						variant="outline"
						disabled={saving || !dirty}
						data-testid="proxy-save"
						className="cursor-pointer disabled:cursor-not-allowed"
					>
						{saving ? "Saving…" : "Save"}
					</Button>
				</div>
			</form>
		</SettingsGroup>
	);
}
