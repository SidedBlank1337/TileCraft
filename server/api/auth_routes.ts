import express, { type NextFunction, type Response } from "express";
import type { Services } from "../service_container.ts";
import { AuthError, ForbiddenError, RateLimitError } from "../services/errors.ts";
import { RateLimiter } from "../services/security_service.ts";
import { ClearSessionCookie, IsAllowedOrigin, ReadSessionCookie, Route, SendError, SessionCookie, type AuthedRequest } from "./http_helpers.ts";

export interface ApiConfig {
  secure_cookies: boolean;
  allowed_origins: string[];
}

export function CreateAuthMiddleware(services: Services, config: ApiConfig) {
  const player_limiter = new RateLimiter(240, 60_000);
  setInterval(() => player_limiter.Sweep(), 60_000).unref();

  const RequireOrigin = (request: AuthedRequest, response: Response, next: NextFunction) => {
    if (request.method === "GET" || request.method === "HEAD") return next();
    const origin = request.headers.origin;
    // Browsers always send Origin on cross-site POSTs; a mismatch means CSRF.
    if (origin && !IsAllowedOrigin(origin, request.headers.host, config.allowed_origins)) {
      void services.security_service.Record(null, "csrf_origin_rejected", { origin, path: request.path }, request.ip ?? null);
      return SendError(response, new ForbiddenError("Cross-site request rejected."));
    }
    next();
  };

  const RequireAuth = (request: AuthedRequest, response: Response, next: NextFunction) => {
    services.auth_service
      .ValidateToken(ReadSessionCookie(request.headers.cookie))
      .then((user) => {
        if (!user) return SendError(response, new AuthError());
        if (!player_limiter.Allow(`player:${user.user_id}`)) {
          void services.security_service.Record(user.user_id, "request_spike", { path: request.path });
          return SendError(response, new RateLimitError());
        }
        request.user = user;
        next();
      })
      .catch((error) => SendError(response, error, request));
  };

  // is_admin is read from the users table on every admin request.
  const RequireAdmin = (request: AuthedRequest, response: Response, next: NextFunction) => {
    services.db
      .Get<{ is_admin: number }>("SELECT is_admin FROM users WHERE user_id = ?", request.user!.user_id)
      .then((row) => {
        if (row?.is_admin !== 1) {
          void services.security_service.Record(request.user!.user_id, "admin_route_denied", { path: request.path });
          return SendError(response, new ForbiddenError());
        }
        next();
      })
      .catch((error) => SendError(response, error, request));
  };

  // Guests may look around and change their own settings; every other write needs a TileID.
  const GUEST_ALLOWED = new Set(["/player/settings", "/notifications/read"]);
  const RequireTileId = (request: AuthedRequest, response: Response, next: NextFunction) => {
    if (!request.user?.is_guest || request.method === "GET" || GUEST_ALLOWED.has(request.path)) return next();
    SendError(response, new ForbiddenError("Create a TileID to do that."));
  };

  return { RequireOrigin, RequireAuth, RequireAdmin, RequireTileId };
}

export function CreateAuthRouter(services: Services, config: ApiConfig, RequireAuth: ReturnType<typeof CreateAuthMiddleware>["RequireAuth"]) {
  const router = express.Router();
  const auth_limiter = new RateLimiter(10, 60_000);
  setInterval(() => auth_limiter.Sweep(), 60_000).unref();

  const LimitAuth = (request: AuthedRequest) => {
    if (!auth_limiter.Allow(`auth:${request.ip}`)) throw new RateLimitError("Too many attempts. Wait a minute and try again.");
  };

  router.post("/register", Route(async (request) => {
    LimitAuth(request);
    const body = request.body ?? {};
    await services.auth_service.Register(body);
    return { ok: true };
  }));

  router.post("/login", Route(async (request, response) => {
    LimitAuth(request);
    try {
      const result = await services.auth_service.Login(request.body?.login, request.body?.password);
      response.setHeader("Set-Cookie", SessionCookie(result.token, result.expires_at, config.secure_cookies));
      return { player: await services.player_service.GetSelfView(result.user.user_id) };
    } catch (error) {
      // Only the identifier length is logged, never the identifier or password.
      void services.security_service.Record(null, "authentication_failure", { login_length: String(request.body?.login ?? "").length }, request.ip ?? null);
      throw error;
    }
  }));

  router.post("/guest", Route(async (request, response) => {
    LimitAuth(request);
    const result = await services.auth_service.CreateGuest(request.body?.name);
    response.setHeader("Set-Cookie", SessionCookie(result.token, result.expires_at, config.secure_cookies));
    return { player: await services.player_service.GetSelfView(result.user.user_id) };
  }));

  router.post("/upgrade", RequireAuth, Route(async (request) => {
    LimitAuth(request);
    const result = await services.auth_service.UpgradeGuest(request.user!.user_id, request.body ?? {});
    services.refresh_identity(request.user!.user_id, result.username);
    return { player: await services.player_service.GetSelfView(request.user!.user_id) };
  }));

  router.post("/logout", RequireAuth, Route(async (request, response) => {
    await services.auth_service.Logout(request.user!.session_id);
    services.disconnect_player(request.user!.user_id, "You logged out.");
    response.setHeader("Set-Cookie", ClearSessionCookie(config.secure_cookies));
    return { ok: true };
  }));

  router.get("/me", RequireAuth, Route(async (request) => ({ player: await services.player_service.GetSelfView(request.user!.user_id) })));

  return router;
}
