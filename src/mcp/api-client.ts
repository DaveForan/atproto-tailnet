/**
 * @module mcp/api-client
 * Calls the existing REST API in-process (HTTP to 127.0.0.1:PORT) with the
 * caller's own MCP bearer token, so tools get exactly the user's permissions
 * and reuse all business logic. No logic is duplicated here.
 */
import { INTERNAL_MCP_HEADER, INTERNAL_MCP_SECRET } from "./internal.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiClient {
  call<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
}

export interface HttpApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Builds a readable message from the API's `{error, code?, details?}` bodies. */
function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; code?: unknown; details?: unknown; error_description?: unknown };
    let msg = typeof b.error === "string" ? b.error : typeof b.error_description === "string" ? b.error_description : "";
    if (typeof b.code === "string") msg += ` (code: ${b.code})`;
    if (Array.isArray(b.details) && b.details.length > 0) {
      const parts = b.details
        .slice(0, 5)
        .map((d: { path?: unknown[]; message?: string }) =>
          `${Array.isArray(d.path) ? d.path.join(".") : ""}${d.path?.length ? ": " : ""}${d.message ?? ""}`,
        );
      msg += ` — ${parts.join("; ")}`;
    }
    if (msg) return `${msg} [HTTP ${status}]`;
  }
  if (typeof body === "string" && body) return `${body.slice(0, 300)} [HTTP ${status}]`;
  return `Request failed [HTTP ${status}]`;
}

/**
 * Defense in depth against path traversal through tool arguments: the URL the
 * request will actually hit must have exactly the path that was constructed
 * (no dot segments — WHATWG also normalizes `%2e` — no backslashes, no query
 * or fragment smuggled in), and no segment may carry an encoded slash,
 * backslash or dot segment that Express would decode later.
 */
export function assertSamePath(path: string, url: URL): void {
  if (url.pathname !== path || url.search !== "" || url.hash !== "") {
    throw new Error(`Refusing request: path changed on normalization (${path})`);
  }
  for (const segment of path.split("/").slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`Refusing request: malformed path segment (${path})`);
    }
    if (decoded === "." || decoded === ".." || /[/\\?#]/.test(decoded)) {
      throw new Error(`Refusing request: unsafe path segment (${path})`);
    }
  }
}

export class HttpApiClient implements ApiClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: HttpApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async call<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    if (!path.startsWith("/api/")) throw new Error(`Refusing non-API path: ${path}`);
    const url = new URL(path, this.opts.baseUrl);
    assertSamePath(path, url);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: "application/json",
      [INTERNAL_MCP_HEADER]: INTERNAL_MCP_SECRET,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
    } else {
      parsed = null;
    }
    if (!res.ok) throw new ApiError(res.status, errorMessage(res.status, parsed), parsed);
    return parsed as T;
  }
}
