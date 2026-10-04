export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface ApiErrorDetail {
  path: string;
  issue: string;
}

/** An error response from the API, in its one documented shape. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ApiErrorDetail[] = [],
  ) {
    super(message);
  }

  /** The issue reported for one field, if any. */
  issueFor(path: string): string | undefined {
    return this.details.find((d) => d.path === path || d.path.startsWith(`${path}.`))?.issue;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Calls the API with the session cookie. The browser adds the Origin header the API checks on
 * state-changing requests.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      credentials: "include",
      headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(
      0,
      "NETWORK",
      "Couldn't reach the server. Check your connection and try again.",
    );
  }
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = (
      body as
        { error?: { code?: string; message?: string; details?: ApiErrorDetail[] } } | undefined
    )?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "INTERNAL",
      error?.message ?? "Something went wrong. Try again.",
      error?.details ?? [],
    );
  }
  return body as T;
}
