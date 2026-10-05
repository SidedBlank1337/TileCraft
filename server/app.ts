import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { Database } from "./database/database.ts";
import { CreateServices, type Services } from "./service_container.ts";
import { CreateAuthMiddleware, CreateAuthRouter, type ApiConfig } from "./api/auth_routes.ts";
import { CreateGameRouter } from "./api/game_routes.ts";
import { CreateAdminRouter } from "./api/admin_routes.ts";
import { GameSocketServer } from "./websocket/game_socket.ts";
import { CreateLogger } from "./logging/logger.ts";

const log = CreateLogger("server");

export interface AppConfig extends ApiConfig {
  database_path: string;
  static_dir: string | null;
  run_timers?: boolean;
}

export interface GameServer {
  services: Services;
  server: http.Server;
  sockets: GameSocketServer;
  Stop(): Promise<void>;
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join("; ");

export async function CreateGameServer(config: AppConfig): Promise<GameServer> {
  const db = await Database.Open(config.database_path);
  const services = await CreateServices(db);
  const app = express();
  const started_at = Date.now();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  const sockets = new GameSocketServer(services, config.allowed_origins);
  const { RequireOrigin, RequireAuth, RequireAdmin, RequireTileId } = CreateAuthMiddleware(services, config);

  app.get("/health", async (_request, response) => {
    let database = "ok";
    try {
      await db.Get("SELECT 1");
    } catch {
      database = "error";
    }
    response.json({
      status: database === "ok" ? "ok" : "degraded",
      uptime_seconds: Math.floor((Date.now() - started_at) / 1000),
      database,
      online_players: sockets.online_count,
      live_worlds: services.world_manager.worlds.size,
      active_events: services.event_service.ActiveEvents().map((event) => event.event_key),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version
    });
  });

  app.use("/api", RequireOrigin);
  app.use("/api/auth", CreateAuthRouter(services, config, RequireAuth));
  app.use("/api/admin", RequireAuth, RequireAdmin, CreateAdminRouter(services));
  app.use("/api", RequireAuth, RequireTileId, CreateGameRouter(services));
  app.use("/api", (_request, response) => {
    response.status(404).json({ error: { code: "not_found", message: "Unknown endpoint." } });
  });

  if (config.static_dir && fs.existsSync(config.static_dir)) {
    const static_dir = config.static_dir;
    app.use(express.static(static_dir, { index: false, maxAge: "1h" }));
    app.get("*", (_request, response) => response.sendFile(path.join(static_dir, "index.html")));
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number })?.status;
    if (status === 400 || status === 413) {
      response.status(status).json({ error: { code: "bad_request", message: "Malformed request." } });
      return;
    }
    log.Error("express error", { error: String(error) });
    response.status(500).json({ error: { code: "server_error", message: "Something went wrong." } });
  });

  const server = http.createServer(app);
  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/ws")) return socket.destroy();
    void sockets.HandleUpgrade(request, socket, head);
  });

  const Safe = (name: string, work: () => Promise<unknown>) => () => void work().catch((error) => log.Error(`${name} failed`, { error: String(error) }));
  const timers = [
    setInterval(Safe("tick", () => services.world_manager.Tick()), 50),
    setInterval(Safe("maintain", () => services.world_manager.Maintain()), 5000),
    setInterval(Safe("tree_notify", () => services.world_manager.TreeReadyNotifications()), 15_000),
    setInterval(() => services.trade_manager.Sweep(), 10_000),
    setInterval(Safe("expire_listings", () => services.marketplace_service.ExpireListings()), 60_000),
    setInterval(Safe("purge_sessions", () => services.auth_service.PurgeExpired()), 3600_000),
    setInterval(Safe("events", () => services.event_service.Refresh()), 30_000)
  ];

  return {
    services,
    server,
    sockets,
    async Stop() {
      for (const timer of timers) clearInterval(timer);
      await sockets.Close();
      await services.world_manager.FlushAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.Close();
    }
  };
}
