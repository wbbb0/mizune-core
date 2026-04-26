/**
 * Thin fetch wrapper.
 * - Adds Content-Type: application/json for POST/PUT/PATCH bodies.
 * - Emits a "401" custom event on the window when auth expires so the
 *   auth store can react and redirect to /login.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
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
    window.dispatchEvent(new CustomEvent("api:unauthorized"));
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const data = await res.json() as { error?: string; message?: string; detail?: string };
      message = data.error?.trim() || data.message?.trim() || data.detail?.trim() || message;
    } catch { /* ignore */ }
    throw new ApiError(res.status, message);
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
