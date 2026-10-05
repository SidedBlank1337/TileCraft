import express from "express";
import type { Services } from "../service_container.ts";
import { COSMETICS } from "../../shared/cosmetics.ts";
import { RECIPES } from "../../shared/recipes.ts";
import { LevelFromLifetimeXp } from "../../shared/levels.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../services/errors.ts";
import { IntParam, Route } from "./http_helpers.ts";

export function CreateGameRouter(services: Services) {
  const router = express.Router();
  const S = services;

  // ---------- player ----------
  router.get("/player", Route(async (request) => {
    const player_id = request.user!.user_id;
    const self = await S.player_service.GetSelfView(player_id);
    const row = await S.player_service.GetPlayer(player_id);
    return {
      player: self,
      settings: JSON.parse(row.settings || "{}"),
      playtime_seconds: row.playtime_seconds,
      stats: await S.progress_service.GetStats(player_id),
      achievements: (await S.progress_service.AchievementBoard(player_id)).filter((entry) => entry.unlocked_at),
      owned_cosmetics: await S.player_service.OwnedCosmetics(player_id),
      created_at: row.created_at,
      current_world: S.world_manager.CurrentWorldName(player_id)
    };
  }));

  router.get("/profile/:username", Route(async (request) => {
    const user = await S.player_service.FindByUsername(String(request.params.username));
    if (!user) throw new NotFoundError("No player with that name.");
    const row = await S.player_service.GetPlayer(user.user_id);
    const stats = await S.progress_service.GetStats(user.user_id);
    const public_stats = ["blocks_broken", "blocks_placed", "trees_harvested", "worlds_created", "worlds_visited", "items_crafted", "fish_caught"];
    return {
      player_id: user.user_id,
      username: row.username,
      level: LevelFromLifetimeXp(row.lifetime_xp).level,
      appearance: S.player_service.ParseAppearance(row.appearance),
      playtime_seconds: row.playtime_seconds,
      stats: Object.fromEntries(public_stats.map((key) => [key, stats[key] ?? 0])),
      achievements: (await S.progress_service.AchievementBoard(user.user_id)).filter((entry) => entry.unlocked_at).map((entry) => entry.name),
      online: S.hub.IsOnline(user.user_id),
      is_friend: await S.friend_service.AreFriends(request.user!.user_id, user.user_id)
    };
  }));

  router.post("/player/settings", Route(async (request) => ({ settings: await S.player_service.SaveSettings(request.user!.user_id, request.body?.settings) })));

  router.get("/cosmetics", Route(async (request) => ({ cosmetics: COSMETICS, owned: await S.player_service.OwnedCosmetics(request.user!.user_id) })));
  router.post("/cosmetics/buy", Route(async (request) => {
    await S.player_service.BuyCosmetic(request.user!.user_id, request.body?.cosmetic_key);
    await S.player_service.PushSelf(request.user!.user_id);
    return { owned: await S.player_service.OwnedCosmetics(request.user!.user_id) };
  }));
  router.post("/cosmetics/equip", Route(async (request) => {
    const appearance = await S.player_service.EquipCosmetics(request.user!.user_id, request.body?.appearance);
    const client = S.world_manager.FindClient(request.user!.user_id);
    if (client) {
      client.appearance = appearance;
      client.world?.Broadcast("player_appearance", { player_id: client.player_id, appearance });
    }
    await S.player_service.PushSelf(request.user!.user_id);
    return { appearance };
  }));

  // ---------- inventory ----------
  router.get("/inventory", Route(async (request) => ({ slots: await S.inventory_service.GetInventory(request.user!.user_id) })));
  const InventoryAction = (work: (player_id: number, body: Record<string, unknown>) => Promise<unknown>) =>
    Route(async (request) => {
      const player_id = request.user!.user_id;
      const result = await work(player_id, request.body ?? {});
      await S.inventory_service.PushInventory(player_id);
      return { result: result ?? null, slots: await S.inventory_service.GetInventory(player_id) };
    });
  router.post("/inventory/move", InventoryAction((player_id, body) => S.inventory_service.MoveSlot(player_id, body.from_slot, body.to_slot)));
  router.post("/inventory/split", InventoryAction((player_id, body) => S.inventory_service.SplitSlot(player_id, body.slot_index, body.quantity)));
  router.post("/inventory/sort", InventoryAction((player_id) => S.inventory_service.SortInventory(player_id)));
  router.post("/inventory/use", InventoryAction(async (player_id, body) => {
    const result = await S.crafting_service.UseItem(player_id, body.slot_index);
    await S.player_service.PushSelf(player_id);
    return result;
  }));

  // ---------- worlds ----------
  router.post("/worlds", Route(async (request) => ({ world: await S.world_service.WorldInfo((await S.world_service.CreateWorld(request.user!.user_id, request.body ?? {})).world_id) })));
  router.get("/worlds", Route(async (request) => ({ worlds: await S.world_service.Browse(request.user!.user_id, request.query) })));
  router.get("/worlds/by-name/:name", Route(async (request) => {
    const world = await S.world_service.GetWorldByName(request.params.name);
    const access = await S.world_service.GetAccess(world, request.user!.user_id, request.user!.is_admin);
    if (access.role === "none") throw new NotFoundError("World not found.");
    return { world: await S.world_service.WorldInfo(world.world_id), access };
  }));
  router.get("/worlds/:id", Route(async (request) => {
    const world_id = IntParam(request.params.id);
    const world = await S.world_service.GetWorldById(world_id);
    const access = await S.world_service.GetAccess(world, request.user!.user_id, request.user!.is_admin);
    if (access.role === "none") throw new NotFoundError("World not found.");
    return { world: { ...(await S.world_service.WorldInfo(world_id)), settings: JSON.parse(world.settings), background: world.background, seed: access.can_manage ? world.seed : undefined }, access };
  }));
  router.patch("/worlds/:id", Route(async (request) => {
    const world_id = IntParam(request.params.id);
    await S.world_service.UpdateWorld(request.user!.user_id, request.user!.is_admin, world_id, request.body ?? {});
    await S.world_manager.Refresh(world_id);
    return { world: await S.world_service.WorldInfo(world_id) };
  }));
  router.delete("/worlds/:id", Route(async (request) => {
    const world_id = IntParam(request.params.id);
    await S.world_service.DeleteWorld(request.user!.user_id, request.user!.is_admin, world_id, request.body?.confirm_name);
    S.world_manager.Discard(world_id);
    return { ok: true };
  }));
  router.post("/worlds/:id/favorite", Route(async (request) => ({ favorite: await S.world_service.ToggleFavorite(request.user!.user_id, IntParam(request.params.id)) })));
  router.get("/worlds/:id/permissions", Route(async (request) => S.world_service.PermissionsFor(request.user!.user_id, request.user!.is_admin, IntParam(request.params.id))));
  router.post("/worlds/:id/permissions", Route(async (request) => {
    const world_id = IntParam(request.params.id);
    const result = await S.world_service.SetPermission(request.user!.user_id, request.user!.is_admin, world_id, request.body?.username, request.body?.role);
    await S.world_manager.Refresh(world_id);
    return result;
  }));
  router.post("/worlds/:id/invite", Route(async (request) => {
    await S.world_service.Invite(request.user!.user_id, request.user!.is_admin, IntParam(request.params.id), request.body?.username);
    return { ok: true };
  }));
  router.post("/worlds/:id/invitations/:invitation_id/revoke", Route(async (request) => {
    await S.world_service.RevokeInvite(request.user!.user_id, request.user!.is_admin, IntParam(request.params.id), IntParam(request.params.invitation_id));
    await S.world_manager.Refresh(IntParam(request.params.id));
    return { ok: true };
  }));
  router.post("/worlds/:id/kick", Route(async (request) => {
    const world_id = IntParam(request.params.id);
    const world = await S.world_service.GetWorldById(world_id);
    const access = await S.world_service.GetAccess(world, request.user!.user_id, request.user!.is_admin);
    if (!access.can_moderate) throw new ForbiddenError("Only world managers can kick.");
    const target = await S.player_service.FindByUsername(String(request.body?.username ?? ""));
    if (!target) throw new NotFoundError("No player with that name.");
    const target_access = await S.world_service.GetAccess(world, target.user_id, false);
    if (target_access.role === "owner" || (target_access.role === "admin" && access.role !== "owner" && !request.user!.is_admin)) throw new ForbiddenError("You cannot kick that player.");
    const client = S.world_manager.FindClient(target.user_id);
    if (!client || client.world?.row.world_id !== world_id) throw new ValidationError("That player is not in this world.");
    S.world_manager.Kick(client, `You were kicked from ${world.world_name}.`);
    return { ok: true };
  }));
  router.get("/invitations", Route(async (request) => ({ invitations: await S.world_service.MyInvitations(request.user!.user_id) })));
  router.post("/invitations/:id", Route(async (request) => {
    await S.world_service.RespondInvite(request.user!.user_id, IntParam(request.params.id), request.body?.accept === true);
    return { ok: true };
  }));

  // ---------- crafting / shop / market ----------
  router.get("/recipes", Route(async () => ({ recipes: RECIPES })));
  router.post("/craft", Route(async (request) => {
    const result = await S.crafting_service.Craft(request.user!.user_id, request.body?.recipe_id, request.body?.times ?? 1);
    await S.inventory_service.PushInventory(request.user!.user_id);
    await S.player_service.PushSelf(request.user!.user_id);
    return result;
  }));

  router.get("/shop", Route(async (request) => ({ entries: await S.shop_service.Catalog(request.user!.user_id) })));
  router.post("/shop/buy", Route(async (request) => {
    const result = await S.shop_service.Buy(request.user!.user_id, request.body?.item_id, request.body?.quantity, request.body?.request_id);
    await S.inventory_service.PushInventory(request.user!.user_id);
    await S.player_service.PushSelf(request.user!.user_id);
    return result;
  }));
  router.post("/shop/sell", Route(async (request) => {
    const result = await S.shop_service.Sell(request.user!.user_id, request.body?.item_id, request.body?.quantity, request.body?.request_id);
    await S.inventory_service.PushInventory(request.user!.user_id);
    await S.player_service.PushSelf(request.user!.user_id);
    return result;
  }));

  router.get("/market", Route(async (request) => ({ listings: await S.marketplace_service.Search(request.query) })));
  router.get("/market/mine", Route(async (request) => ({ listings: await S.marketplace_service.MyListings(request.user!.user_id) })));
  router.get("/market/history", Route(async (request) => ({ history: await S.marketplace_service.History(request.user!.user_id) })));
  router.get("/market/price/:item_id", Route(async (request) => ({ history: await S.marketplace_service.PriceHistory(IntParam(request.params.item_id)) })));
  router.post("/market/list", Route(async (request) => {
    const result = await S.marketplace_service.CreateListing(request.user!.user_id, request.body ?? {});
    await S.inventory_service.PushInventory(request.user!.user_id);
    return result;
  }));
  router.post("/market/buy", Route(async (request) => {
    const result = await S.marketplace_service.Buy(request.user!.user_id, request.body?.listing_id, request.body?.quantity, request.body?.request_id);
    await S.inventory_service.PushInventory(request.user!.user_id);
    await S.player_service.PushSelf(request.user!.user_id);
    return result;
  }));
  router.post("/market/cancel", Route(async (request) => {
    const result = await S.marketplace_service.Cancel(request.user!.user_id, request.body?.listing_id);
    await S.inventory_service.PushInventory(request.user!.user_id);
    return result;
  }));

  // ---------- progression ----------
  router.get("/quests", Route(async (request) => ({ quests: await S.progress_service.QuestBoard(request.user!.user_id) })));
  router.post("/quests/claim", Route(async (request) => {
    const result = await S.progress_service.ClaimQuest(request.user!.user_id, request.body?.quest_key);
    await S.inventory_service.PushInventory(request.user!.user_id);
    await S.player_service.PushSelf(request.user!.user_id);
    return result;
  }));
  router.get("/achievements", Route(async (request) => ({ achievements: await S.progress_service.AchievementBoard(request.user!.user_id) })));
  router.get("/events", Route(async () => ({ events: S.event_service.ActiveEvents() })));

  // ---------- social ----------
  router.get("/friends", Route(async (request) => ({ friends: await S.friend_service.List(request.user!.user_id, (player_id) => S.world_manager.CurrentWorldName(player_id)) })));
  const TargetId = async (username: unknown) => {
    const target = await S.player_service.FindByUsername(String(username ?? ""));
    if (!target) throw new NotFoundError("No player with that name.");
    return target.user_id;
  };
  router.post("/friends/request", Route(async (request) => ({ status: await S.friend_service.Request(request.user!.user_id, await TargetId(request.body?.username)) })));
  router.post("/friends/respond", Route(async (request) => {
    await S.friend_service.Respond(request.user!.user_id, await TargetId(request.body?.username), request.body?.accept === true);
    return { ok: true };
  }));
  router.post("/friends/remove", Route(async (request) => {
    await S.friend_service.Remove(request.user!.user_id, await TargetId(request.body?.username));
    return { ok: true };
  }));
  router.get("/blocks", Route(async (request) => ({ blocked: await S.chat_service.ListBlocked(request.user!.user_id) })));
  router.post("/blocks", Route(async (request) => {
    await S.chat_service.SetBlocked(request.user!.user_id, await TargetId(request.body?.username), request.body?.blocked !== false);
    return { ok: true };
  }));
  router.post("/reports", Route(async (request) => {
    await S.chat_service.Report(request.user!.user_id, await TargetId(request.body?.username), request.body?.reason, request.body?.context);
    return { ok: true };
  }));
  router.get("/trades", Route(async (request) => ({ trades: await S.trade_manager.History(request.user!.user_id) })));

  router.get("/notifications", Route(async (request) => ({ notifications: await S.notification_service.List(request.user!.user_id) })));
  router.post("/notifications/read", Route(async (request) => {
    await S.notification_service.MarkRead(request.user!.user_id);
    return { ok: true };
  }));

  // ---------- activities ----------
  router.get("/trivia", Route(async (request) => S.activity_service.TriviaQuestion(request.user!.user_id)));
  router.post("/trivia/answer", Route(async (request) => {
    const result = await S.activity_service.TriviaAnswer(request.user!.user_id, request.body?.answer_index);
    await S.player_service.PushSelf(request.user!.user_id);
    return result;
  }));

  return router;
}
