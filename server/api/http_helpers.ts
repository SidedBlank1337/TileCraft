import type { NextFunction, Request, Response } from "express";
import { GameError } from "../services/errors.ts";
import { CreateLogger } from "../logging/logger.ts";
import type { SessionUser } from "../auth/auth_service.ts";

const log = CreateLogger("http");
export const SESSION_COOKIE = "tc_session";

export function ReadSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function SessionCookie(token: string, expires_at: number, secure: boolean): string {
  const max_age = Math.max(0, Math.floor((expires_at - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${max_age}${secure ? "; Secure" : ""}`;
}

export function ClearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function IsAllowedOrigin(origin: string, host: string | undefined, allowed: string[]): boolean {
  try {
    const parsed = new URL(origin);
    if (host && parsed.host === host) return true;
    return allowed.includes(parsed.origin);
  } catch {
    return false;
  }
}

export interface AuthedRequest extends Request {
  user?: SessionUser;
}

type Handler = (request: AuthedRequest, response: Response) => Promise<unknown>;

// Wraps a route: GameErrors become player-facing JSON, everything else is logged and hidden.
export function Route(handler: Handler) {
  return (request: AuthedRequest, response: Response, next: NextFunction) => {
    handler(request, response)
      .then((result) => {
        if (!response.headersSent) response.json(result ?? { ok: true });
      })
      .catch((error) => SendError(response, error, request))
      .catch(next);
  };
}

export function SendError(response: Response, error: unknown, request?: Request): void {
  if (response.headersSent) return;
  if (error instanceof GameError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  log.Error("unhandled route error", { path: request?.path, error: error instanceof Error ? error.stack : String(error) });
  response.status(500).json({ error: { code: "server_error", message: "Something went wrong. Please try again." } });
}

export function IntParam(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new GameError("invalid", "Invalid id.", 400);
  return parsed;
}
