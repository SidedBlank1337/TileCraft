import express from "express";
import type { Services } from "../service_container.ts";
import { EVENT_DEFINITIONS } from "../../shared/economy.ts";
import { IntParam, Route } from "./http_helpers.ts";

export function CreateAdminRouter(services: Services) {
  const router = express.Router();
  const admin = services.admin_service;

  router.get("/overview", Route(async () => admin.Overview()));
  router.get("/players", Route(async (request) => ({ players: await admin.SearchPlayers(request.query.search) })));
  router.get("/players/:username", Route(async (request) => admin.PlayerDetail(request.params.username)));
  router.get("/worlds", Route(async (request) => ({ worlds: await admin.SearchWorlds(request.query.search) })));
  router.get("/transactions", Route(async () => ({ transactions: await admin.Transactions() })));
  router.get("/security", Route(async () => ({ logs: await services.security_service.List(200) })));
  router.get("/reports", Route(async () => ({ reports: await admin.Reports() })));
  router.get("/logs", Route(async () => ({ logs: await admin.AdminLogs() })));
  router.get("/events", Route(async () => ({ definitions: EVENT_DEFINITIONS, active: services.event_service.ActiveEvents() })));

  const me = (request: { user?: { user_id: number } }) => request.user!.user_id;
  router.post("/ban", Route(async (request) => admin.Ban(me(request), request.body?.username, request.body?.hours, request.body?.reason)));
  router.post("/unban", Route(async (request) => admin.Unban(me(request), request.body?.username)));
  router.post("/mute", Route(async (request) => admin.Mute(me(request), request.body?.username, request.body?.minutes)));
  router.post("/kick", Route(async (request) => admin.Kick(me(request), request.body?.username)));
  router.post("/teleport", Route(async (request) => admin.Teleport(me(request), request.body ?? {})));
  router.post("/world-lock", Route(async (request) => admin.SetWorldLock(me(request), request.body?.world_name, request.body?.locked === true)));
  router.post("/give-item", Route(async (request) => admin.GiveItem(me(request), request.body?.username, request.body?.item, request.body?.quantity)));
  router.post("/take-item", Route(async (request) => admin.TakeItem(me(request), request.body?.username, request.body?.item, request.body?.quantity)));
  router.post("/coins", Route(async (request) => admin.AdjustCoins(me(request), request.body?.username, request.body?.delta)));
  router.post("/set-admin", Route(async (request) => admin.SetAdmin(me(request), request.body?.username, request.body?.is_admin === true)));
  router.post("/reports/:id/close", Route(async (request) => admin.CloseReport(me(request), IntParam(request.params.id))));
  router.post("/events/start", Route(async (request) => {
    const started = await services.event_service.Start(String(request.body?.event_key ?? ""), Number(request.body?.duration_minutes), me(request));
    services.broadcast_all("event_update", { events: services.event_service.ActiveEvents() });
    return started;
  }));
  router.post("/events/:id/stop", Route(async (request) => {
    await services.event_service.Stop(IntParam(request.params.id));
    services.broadcast_all("event_update", { events: services.event_service.ActiveEvents() });
    return { ok: true };
  }));
  router.get("/database", Route(async () => {
    const integrity = await services.db.Get<{ integrity_check: string }>("PRAGMA integrity_check");
    const tables = await services.db.All<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const counts: Record<string, number> = {};
    for (const table of tables) {
      if (!/^[a-z_]+$/.test(table.name)) continue;
      counts[table.name] = (await services.db.Get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table.name}`))?.count ?? 0;
    }
    return { integrity: integrity?.integrity_check, counts };
  }));

  return router;
}
