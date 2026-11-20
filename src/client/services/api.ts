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

/**
 * Call the API. When the server asks for a fresh device proof
 * (`step_up_required`, ADR-0035), this trusted device proves itself silently
 * and the call is repeated once.
 */
export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T | null> {
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
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    };
    if (opts?.headers) {
      Object.assign(headers, opts.headers);
    }
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) return null;
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
    return res.json();
  } catch (e) {
    if (e instanceof Error && e.message !== "Network error") {
      throw e;
    }
    throw new Error("Network error — check your connection");
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
