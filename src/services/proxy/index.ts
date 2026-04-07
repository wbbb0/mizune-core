import type { AppConfig } from "#config/config.ts";
import { getDefaultMainModelRefs, getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import {
	Agent,
	ProxyAgent,
	Socks5ProxyAgent,
	fetch as undiciFetch,
	type RequestInit as UndiciRequestInit,
	type Dispatcher
} from "undici";

export type ProxyConsumer = "search" | "browser" | "llm";

export interface ProxyResolveOptions {
	modelRef?: string;
	browserMethod?: "playwright";
	searchProxyEnabled?: boolean;
}

interface ResolvedProxyTarget {
	type: "http" | "https" | "socks5";
	url: string;
}

interface ResolvedProxyConfig {
	http?: ResolvedProxyTarget;
	https?: ResolvedProxyTarget;
}

const directHttpDispatcher = new Agent();
const directHttpsDispatcher = new Agent();
const proxyDispatcherCache = new Map<string, Dispatcher>();

export function isProxyEnabled(
	config: AppConfig,
	consumer: ProxyConsumer,
	options: ProxyResolveOptions = {}
): boolean {
	if (consumer === "search") {
		return options.searchProxyEnabled ?? false;
	}

	if (consumer === "browser") {
		return config.browser.playwright.proxy;
	}

	const resolvedModelRef = options.modelRef ?? getDefaultMainModelRefs(config);
	const modelProfile = getPrimaryModelProfile(config, resolvedModelRef);
	if (!modelProfile) {
		return false;
	}

	return Boolean(config.llm.providers[modelProfile.provider]?.proxy);
}

export function resolveProxyUrls(
	config: AppConfig,
	consumer: ProxyConsumer,
	options: ProxyResolveOptions = {}
): {
	http?: string;
	https?: string;
} {
	const resolved = resolveProxyConfig(config, consumer, options);
	return {
		...(resolved.http ? { http: resolved.http.url } : {}),
		...(resolved.https ? { https: resolved.https.url } : {})
	};
}

export function getDispatcherForUrl(
	config: AppConfig,
	consumer: ProxyConsumer,
	requestUrl: string,
	options: ProxyResolveOptions = {}
): Dispatcher {
	const protocol = new URL(requestUrl).protocol;
	const proxyConfig = resolveProxyConfig(config, consumer, options);

	if (protocol === "http:") {
		return proxyConfig.http
			? getOrCreateProxyDispatcher(proxyConfig.http)
			: directHttpDispatcher;
	}

	return proxyConfig.https
		? getOrCreateProxyDispatcher(proxyConfig.https)
		: directHttpsDispatcher;
}

export async function fetchWithProxy(
	config: AppConfig,
	consumer: ProxyConsumer,
	requestUrl: string,
	init?: UndiciRequestInit,
	options: ProxyResolveOptions = {}
): Promise<Response> {
	if (!isProxyEnabled(config, consumer, options)) {
		const directInit = init == null
			? undefined
			: (() => {
				const { dispatcher: _dispatcher, ...rest } = init;
				return rest as RequestInit;
			})();
		return fetch(requestUrl, directInit);
	}

	const dispatcher = getDispatcherForUrl(config, consumer, requestUrl, options);
	const requestInit: UndiciRequestInit = {
		...init,
		dispatcher
	};
	return undiciFetch(requestUrl, requestInit);
}

function resolveProxyConfig(
	config: AppConfig,
	consumer: ProxyConsumer,
	options: ProxyResolveOptions
): ResolvedProxyConfig {
	if (!isProxyEnabled(config, consumer, options)) {
		return {};
	}

	const http = normalizeProxyTarget(config.proxy.http);
	const https = normalizeProxyTarget(config.proxy.https) ?? http;
	return {
		...(http ? { http } : {}),
		...(https ? { https } : {})
	};
}

function normalizeProxyTarget(proxyConfig: AppConfig["proxy"]["http"]): ResolvedProxyTarget | undefined {
	if (!proxyConfig) {
		return undefined;
	}

	return {
		type: proxyConfig.type,
		url: buildProxyUrl(proxyConfig)
	};
}

function buildProxyUrl(proxyConfig: NonNullable<AppConfig["proxy"]["http"]>): string {
	const auth = buildProxyAuth(proxyConfig.username, proxyConfig.password);
	const host = formatProxyHost(proxyConfig.host);
	return `${proxyConfig.type}://${auth}${host}:${proxyConfig.port}`;
}

function buildProxyAuth(username?: string, password?: string): string {
	if (!username && !password) {
		return "";
	}

	const encodedUsername = encodeURIComponent(username ?? "");
	const encodedPassword = password != null
		? `:${encodeURIComponent(password)}`
		: "";
	return `${encodedUsername}${encodedPassword}@`;
}

function formatProxyHost(host: string): string {
	return host.includes(":") && !host.startsWith("[")
		? `[${host}]`
		: host;
}

function getOrCreateProxyDispatcher(target: ResolvedProxyTarget): Dispatcher {
	const cached = proxyDispatcherCache.get(target.url);
	if (cached) {
		return cached;
	}

	const dispatcher = target.type === "socks5"
		? new Socks5ProxyAgent(target.url)
		: new ProxyAgent(target.url);
	proxyDispatcherCache.set(target.url, dispatcher);
	return dispatcher;
}
