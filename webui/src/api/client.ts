/**
 * Thin fetch wrapper.
 * - Adds Content-Type: application/json for POST/PUT/PATCH bodies.
 * - Emits a "401" custom event on the window when auth expires so the
 *   auth store can react and redirect to /login.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly authChallenge = false
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readErrorResponse(res: Response): Promise<{ message: string; isJson: boolean }> {
  let message = res.statusText || `HTTP ${res.status}`;
  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.toLowerCase().includes("application/json");

  if (isJson) {
    try {
      const data = await res.json() as { error?: string; message?: string; detail?: string };
      message = data.error?.trim() || data.message?.trim() || data.detail?.trim() || message;
    } catch { /* ignore malformed error payload */ }
  }

  return { message, isJson };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: {}
  };

  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(path, init);

  if (res.status === 401) {
    const error = await readErrorResponse(res);
    if (error.isJson) {
      window.dispatchEvent(new CustomEvent("api:unauthorized"));
    }
    throw new ApiError(401, error.message, error.isJson);
  }

  if (!res.ok) {
    const error = await readErrorResponse(res);
    throw new ApiError(res.status, error.message);
  }

  // 204 No Content
  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export const api = {
  get:    <T>(path: string)                => request<T>("GET",    path),
  post:   <T>(path: string, body?: unknown) => request<T>("POST",   path, body),
  put:    <T>(path: string, body?: unknown) => request<T>("PUT",    path, body),
  patch:  <T>(path: string, body?: unknown) => request<T>("PATCH",  path, body),
  delete: <T>(path: string)                => request<T>("DELETE", path),

  /** Open an SSE EventSource.  The caller is responsible for closing it. */
  sse(path: string): EventSource {
    return new EventSource(path, { withCredentials: true });
  }
};
