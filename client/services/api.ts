export class ApiError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

let unauthorized_handler: () => void = () => undefined;

export function OnUnauthorized(handler: () => void): void {
  unauthorized_handler = handler;
}

// Cookies carry the session; nothing secret is ever stored in JS.
export async function Api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError("network", "Cannot reach the server.", 0);
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/")) unauthorized_handler();
    throw new ApiError(json?.error?.code ?? "error", json?.error?.message ?? "Request failed.", response.status, json?.error?.details);
  }
  return json as T;
}

export function RequestId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
