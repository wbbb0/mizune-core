import { fetch as undiciFetch, type Dispatcher, type HeadersInit as UndiciHeadersInit, type RequestInit as UndiciRequestInit } from "undici";

const DEFAULT_USER_AGENT = "llm-bot/0.1";
type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

export class WebHttpClient {
  constructor(
    private readonly options?: {
      getDispatcher?: (url: string) => Dispatcher;
    }
  ) {}

  async fetch(url: string, init?: UndiciRequestInit): Promise<UndiciResponse> {
    const headers = new Headers(normalizeHeadersInit(init?.headers));
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", DEFAULT_USER_AGENT);
    }

    const dispatcher = this.options?.getDispatcher?.(url);

    const requestInit: UndiciRequestInit = {
      ...init,
      headers: Array.from(headers.entries()),
      ...(dispatcher ? { dispatcher } : {})
    };

    return undiciFetch(url, requestInit);
  }

  async resolveRedirectUrl(url: string, maxHops = 8): Promise<string> {
    let current = url;

    for (let hop = 0; hop < maxHops; hop += 1) {
      const response = await this.fetch(current, {
        method: "GET",
        redirect: "manual"
      });
      await response.body?.cancel();

      if (response.status >= 300 && response.status < 400) {
        const nextLocation = response.headers.get("location");
        if (!nextLocation) {
          return current;
        }
        current = new URL(nextLocation, current).toString();
        continue;
      }

      return response.url || current;
    }

    return current;
  }

  async readText(response: UndiciResponse, maxChars: number): Promise<{ text: string; truncated: boolean }> {
    if (!response.body) {
      return { text: "", truncated: false };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf8");
    let text = "";
    let truncated = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      if (text.length >= maxChars) {
        truncated = true;
        break;
      }
    }

    if (truncated) {
      await reader.cancel();
    } else {
      text += decoder.decode();
    }

    return {
      text: text.slice(0, maxChars),
      truncated
    };
  }
}

function normalizeHeadersInit(input: UndiciHeadersInit | undefined): Array<[string, string]> | undefined {
  if (!input) {
    return undefined;
  }

  if (Array.isArray(input)) {
    return input.map(([key, value]) => [key, value]);
  }

  const iterator = (input as { [Symbol.iterator]?: () => Iterator<[string, string]> })[Symbol.iterator];
  if (typeof iterator === "function") {
    return Array.from(input as Iterable<[string, string]>, ([key, value]) => [key, value]);
  }

  if (typeof input === "object") {
    return Object.entries(input).flatMap(([key, value]) => (
      value == null ? [] : [[key, value]]
    ));
  }

  return undefined;
}
