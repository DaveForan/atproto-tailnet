let csrfToken = "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function setCsrfToken(token: string) {
  csrfToken = token;
}

/** Shown when the session ended while the dashboard was open. */
export const SESSION_EXPIRED_MESSAGE = "Your session expired — sign in again";
export const NETWORK_ERROR_MESSAGE = "Network error — check your connection";

type SessionListener = () => void;
const sessionListeners = new Set<SessionListener>();

/**
 * Be told when an API call answers 401 (the session ended). The call itself
 * still fails with an `ApiError` (status 401, code `session_expired`), so a
 * mutation never reports success. Returns an unsubscribe function.
 */
export function onSessionExpired(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

export function isSessionExpired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

/**
 * Call the API. When the server asks for a fresh device proof
 * (`step_up_required`, ADR-0035), this trusted device proves itself silently
 * and the call is repeated once.
 */
export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    return await withStepUp<T>(path, opts);
  } catch (e) {
    if (isSessionExpired(e)) for (const l of sessionListeners) l();
    throw e;
  }
}

/**
 * Like `api`, but a 401 resolves to null and tells no listener. Only for
 * asking whether anyone is signed in (`/api/me`) and pages that work signed out.
 */
export async function apiOrNull<T = unknown>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    return await withStepUp<T>(path, opts);
  } catch (e) {
    if (isSessionExpired(e)) return null;
    throw e;
  }
}

async function withStepUp<T>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    return await request<T>(path, opts);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== "step_up_required") throw e;
    const { deviceTrustService } = await import("./device-trust");
    await deviceTrustService.stepUp();
    return request<T>(path, opts);
  }
}

async function request<T>(
  path: string,
  opts?: RequestInit,
): Promise<T | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
  };
  if (opts?.headers) {
    Object.assign(headers, opts.headers);
  }
  let res: Response;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch (e) {
    // An aborted call stays an abort; anything else fetch throws is the network
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error(NETWORK_ERROR_MESSAGE);
  }
  if (res.status === 401) {
    throw new ApiError(SESSION_EXPIRED_MESSAGE, 401, "session_expired");
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new ApiError(
      err.error || "Something went wrong",
      res.status,
      typeof err.code === "string" ? err.code : undefined,
      err && typeof err === "object" ? err : undefined,
    );
  }
  try {
    return (await res.json()) as T;
  } catch {
    // A body cut off by a dropped connection
    throw new Error(NETWORK_ERROR_MESSAGE);
  }
}

export function tenantApi<T = unknown>(
  tenantId: string,
  path: string,
  opts?: RequestInit,
): Promise<T | null> {
  return api<T>(`/api/tenants/${tenantId}${path}`, opts);
}

export async function fetchCsrfToken(): Promise<void> {
  const data = await api<{ token: string }>("/api/csrf-token");
  if (data?.token) setCsrfToken(data.token);
}
