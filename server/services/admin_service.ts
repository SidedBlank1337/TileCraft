import type { Database } from "../database/database.ts";
import { GetItem, ITEMS_BY_KEY } from "../../shared/items.ts";
import { GameError, NotFoundError, ValidationError } from "./errors.ts";
import type { Services } from "../service_container.ts";

export class AdminService {
  constructor(private db: Database, private services: Services) {}

  private async Log(admin_id: number, action: string, target: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.db.Run("INSERT INTO admin_logs (admin_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)", admin_id, action, target, JSON.stringify(details), Date.now());
  }

  private async Target(username: unknown) {
    const user = await this.services.player_service.FindByUsername(String(username ?? ""));
    if (!user) throw new NotFoundError("No player with that name.");
    return user;
  }

  ResolveItem(raw: unknown): number {
    if (typeof raw === "number" && GetItem(raw)) return raw;
    if (typeof raw === "string") {
      if (/^\d+$/.test(raw) && GetItem(Number(raw))) return Number(raw);
      const item = ITEMS_BY_KEY.get(raw.toLowerCase());
      if (item) return item.item_id;
    }
    throw new ValidationError("Unknown item.");
  }

  SearchPlayers(query: unknown) {
    const text = typeof query === "string" ? query.trim().slice(0, 32) : "";
    return this.db.All(
      `SELECT u.user_id AS player_id, u.username, u.is_admin, u.banned_until, u.muted_until, u.created_at, u.last_login_at, p.coins, p.level, p.playtime_seconds
       FROM users u JOIN players p ON p.player_id = u.user_id WHERE u.username LIKE ? ORDER BY u.username LIMIT 50`,
      `%${text}%`
    );
  }

  async PlayerDetail(username: unknown) {
    const user = await this.Target(username);
    const player = await this.services.player_service.GetPlayer(user.user_id);
    return {
      player,
      stats: await this.services.progress_service.GetStats(user.user_id),
      inventory: await this.services.inventory_service.GetInventory(user.user_id),
      transactions: await this.db.All("SELECT * FROM transactions WHERE player_id = ? ORDER BY transaction_id DESC LIMIT 100", user.user_id),
      security: await this.services.security_service.List(100, user.user_id),
      worlds: await this.db.All("SELECT world_id, world_name, world_type, locked FROM worlds WHERE owner_id = ?", user.user_id),
      online_world: this.services.world_manager.CurrentWorldName(user.user_id)
    };
  }

  SearchWorlds(query: unknown) {
    const text = typeof query === "string" ? query.trim().toUpperCase().slice(0, 20) : "";
    return this.db.All(
      `SELECT w.world_id, w.world_name, w.world_type, w.locked, w.total_visits, w.width, w.height, w.created_at, u.username AS owner_name,
       (SELECT COUNT(*) FROM trees t WHERE t.world_id = w.world_id) AS tree_count, (SELECT COUNT(*) FROM item_drops d WHERE d.world_id = w.world_id) AS drop_count
       FROM worlds w JOIN users u ON u.user_id = w.owner_id WHERE w.world_name LIKE ? ORDER BY w.total_visits DESC LIMIT 50`,
      `%${text}%`
    ).then((rows) => rows.map((row) => ({ ...row, current_players: this.services.world_manager.LiveCount(Number((row as { world_id: number }).world_id)) })));
  }

  async Ban(admin_id: number, username: unknown, hours: unknown, reason: unknown) {
    const user = await this.Target(username);
    if (user.user_id === admin_id) throw new ValidationError("You cannot ban yourself.");
    const duration = typeof hours === "number" && hours > 0 && hours <= 24 * 3650 ? hours : 24 * 3650;
    const until = Date.now() + duration * 3600_000;
    await this.db.Run("UPDATE users SET banned_until = ?, ban_reason = ? WHERE user_id = ?", until, typeof reason === "string" ? reason.slice(0, 200) : null, user.user_id);
    await this.services.auth_service.RevokeAllSessions(user.user_id);
    this.services.disconnect_player(user.user_id, "You have been banned.");
    await this.Log(admin_id, "ban", user.username, { hours: duration });
    return { banned_until: until };
  }

  async Unban(admin_id: number, username: unknown) {
    const user = await this.Target(username);
    await this.db.Run("UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE user_id = ?", user.user_id);
    await this.Log(admin_id, "unban", user.username);
  }

  async Mute(admin_id: number, username: unknown, minutes: unknown) {
    const user = await this.Target(username);
    const duration = typeof minutes === "number" && minutes >= 0 && minutes <= 60 * 24 * 30 ? minutes : 60;
    await this.db.Run("UPDATE users SET muted_until = ? WHERE user_id = ?", duration === 0 ? null : Date.now() + duration * 60_000, user.user_id);
    await this.Log(admin_id, duration === 0 ? "unmute" : "mute", user.username, { minutes: duration });
  }

  async Kick(admin_id: number, username: unknown) {
    const user = await this.Target(username);
    const client = this.services.world_manager.FindClient(user.user_id);
    if (!client) throw new ValidationError("That player is not in a world.");
    this.services.world_manager.Kick(client, "You were kicked by an administrator.");
    await this.Log(admin_id, "kick", user.username);
  }

  async SetWorldLock(admin_id: number, world_name: unknown, locked: boolean) {
    const world = await this.services.world_service.GetWorldByName(world_name);
    await this.db.Run("UPDATE worlds SET locked = ?, updated_at = ? WHERE world_id = ?", locked ? 1 : 0, Date.now(), world.world_id);
    await this.services.world_manager.Refresh(world.world_id);
    await this.Log(admin_id, locked ? "lock_world" : "unlock_world", world.world_name);
  }

  async GiveItem(admin_id: number, username: unknown, item: unknown, quantity: unknown) {
    const user = await this.Target(username);
    const item_id = this.ResolveItem(item);
    const amount = typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0 && quantity <= 10_000 ? quantity : NaN;
    if (Number.isNaN(amount)) throw new ValidationError("Quantity must be 1-10,000.");
    await this.services.inventory_service.AddItem(user.user_id, item_id, amount);
    await this.db.Run("INSERT INTO transactions (player_id, type, amount, item_id, quantity, reference_id, created_at) VALUES (?, 'admin_give_item', 0, ?, ?, ?, ?)", user.user_id, item_id, amount, `admin:${admin_id}`, Date.now());
    await this.services.inventory_service.PushInventory(user.user_id);
    await this.Log(admin_id, "give_item", user.username, { item_id, amount });
  }

  async TakeItem(admin_id: number, username: unknown, item: unknown, quantity: unknown) {
    const user = await this.Target(username);
    const item_id = this.ResolveItem(item);
    const amount = typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0 ? quantity : NaN;
    if (Number.isNaN(amount)) throw new ValidationError("Invalid quantity.");
    await this.services.inventory_service.RemoveItem(user.user_id, item_id, amount);
    await this.db.Run("INSERT INTO transactions (player_id, type, amount, item_id, quantity, reference_id, created_at) VALUES (?, 'admin_take_item', 0, ?, ?, ?, ?)", user.user_id, item_id, -amount, `admin:${admin_id}`, Date.now());
    await this.services.inventory_service.PushInventory(user.user_id);
    await this.Log(admin_id, "take_item", user.username, { item_id, amount });
  }

  async AdjustCoins(admin_id: number, username: unknown, delta: unknown) {
    const user = await this.Target(username);
    if (typeof delta !== "number" || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100_000_000) throw new ValidationError("Invalid coin amount.");
    const balance = await this.services.player_service.ChangeCoins(user.user_id, delta, "admin_adjustment", { reference_id: `admin:${admin_id}` });
    await this.services.player_service.PushSelf(user.user_id);
    await this.Log(admin_id, "adjust_coins", user.username, { delta });
    return { balance };
  }

  async Teleport(admin_id: number, data: { username?: unknown; to_username?: unknown; x?: unknown; y?: unknown }) {
    const admin_client = this.services.world_manager.FindClient(admin_id);
    if (!admin_client) throw new ValidationError("Join a world first.");
    if (data.to_username !== undefined) {
      const target = await this.Target(data.to_username);
      const target_client = this.services.world_manager.FindClient(target.user_id);
      if (!target_client?.world) throw new ValidationError("That player is not in a world.");
      if (admin_client.world !== target_client.world) await this.services.world_manager.Join(admin_client, target_client.world.row.world_name);
      await this.services.world_manager.AdminTeleport(admin_client, Math.floor(target_client.x / 32), Math.floor(target_client.y / 32));
    } else {
      if (typeof data.x !== "number" || typeof data.y !== "number") throw new ValidationError("Give x and y tile coordinates.");
      await this.services.world_manager.AdminTeleport(admin_client, Math.floor(data.x), Math.floor(data.y));
    }
    await this.Log(admin_id, "teleport", String(data.to_username ?? `${data.x},${data.y}`));
  }

  async SetAdmin(admin_id: number, username: unknown, is_admin: boolean) {
    const user = await this.Target(username);
    if (user.user_id === admin_id && !is_admin) throw new ValidationError("You cannot remove your own admin role.");
    await this.db.Run("UPDATE users SET is_admin = ? WHERE user_id = ?", is_admin ? 1 : 0, user.user_id);
    await this.Log(admin_id, is_admin ? "grant_admin" : "revoke_admin", user.username);
  }

  Transactions(limit = 200) {
    return this.db.All(`SELECT t.*, u.username FROM transactions t JOIN users u ON u.user_id = t.player_id ORDER BY t.transaction_id DESC LIMIT ?`, limit);
  }

  Reports() {
    return this.db.All(`SELECT r.*, a.username AS reporter_name, b.username AS target_name FROM reports r JOIN users a ON a.user_id = r.reporter_id JOIN users b ON b.user_id = r.target_id ORDER BY r.status = 'open' DESC, r.created_at DESC LIMIT 100`);
  }

  async CloseReport(admin_id: number, report_id: unknown) {
    if (typeof report_id !== "number") throw new ValidationError("Invalid report.");
    await this.db.Run("UPDATE reports SET status = 'closed' WHERE report_id = ?", report_id);
    await this.Log(admin_id, "close_report", String(report_id));
  }

  AdminLogs() {
    return this.db.All(`SELECT l.*, u.username AS admin_name FROM admin_logs l LEFT JOIN users u ON u.user_id = l.admin_id ORDER BY l.admin_log_id DESC LIMIT 200`);
  }

  async Overview() {
    const counts = await this.db.Get<Record<string, number>>(
      `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM worlds) AS worlds, (SELECT COUNT(*) FROM marketplace_listings WHERE status = 'active') AS active_listings,
       (SELECT COALESCE(SUM(coins), 0) FROM players) AS coins_in_circulation, (SELECT COUNT(*) FROM security_logs WHERE created_at > ?) AS security_events_24h,
       (SELECT COUNT(*) FROM reports WHERE status = 'open') AS open_reports`,
      Date.now() - 86_400_000
    );
    return {
      ...counts,
      live_worlds: this.services.world_manager.worlds.size,
      online_players: [...this.services.world_manager.worlds.values()].reduce((sum, world) => sum + world.players.size, 0),
      events: this.services.event_service.ActiveEvents(),
      top_blocks: await this.db.All("SELECT b.item_id, d.name, b.broken_count, b.placed_count FROM block_statistics b JOIN item_definitions d ON d.item_id = b.item_id ORDER BY b.broken_count DESC LIMIT 10")
    };
  }

  // Chat commands: "/give user item qty" etc. Returns a reply line for the admin.
  async RunCommand(admin_id: number, text: string): Promise<string> {
    const [command, ...args] = text.slice(1).trim().split(/\s+/);
    const number_arg = (value: string | undefined) => (value === undefined ? NaN : Number(value));
    switch ((command ?? "").toLowerCase()) {
      case "give":
        await this.GiveItem(admin_id, args[0], args[1], number_arg(args[2] ?? "1"));
        return `Gave ${args[2] ?? 1}x ${args[1]} to ${args[0]}.`;
      case "take":
        await this.TakeItem(admin_id, args[0], args[1], number_arg(args[2] ?? "1"));
        return `Took ${args[2] ?? 1}x ${args[1]} from ${args[0]}.`;
      case "coins": {
        const result = await this.AdjustCoins(admin_id, args[0], number_arg(args[1]));
        return `${args[0]} now has ${result.balance} coins.`;
      }
      case "ban":
        await this.Ban(admin_id, args[0], args[1] ? number_arg(args[1]) : undefined, args.slice(2).join(" "));
        return `Banned ${args[0]}.`;
      case "unban":
        await this.Unban(admin_id, args[0]);
        return `Unbanned ${args[0]}.`;
      case "kick":
        await this.Kick(admin_id, args[0]);
        return `Kicked ${args[0]}.`;
      case "mute":
        await this.Mute(admin_id, args[0], args[1] ? number_arg(args[1]) : 60);
        return `Muted ${args[0]}.`;
      case "tp":
        if (args.length >= 2 && /^\d+$/.test(args[0])) await this.Teleport(admin_id, { x: number_arg(args[0]), y: number_arg(args[1]) });
        else await this.Teleport(admin_id, { to_username: args[0] });
        return "Teleported.";
      case "world": {
        const action = args[0];
        if (action !== "lock" && action !== "unlock") return "Usage: /world lock|unlock NAME";
        await this.SetWorldLock(admin_id, args[1], action === "lock");
        return `World ${args[1]} ${action}ed.`;
      }
      case "item": {
        const item_id = this.ResolveItem(args[0]);
        const item = GetItem(item_id)!;
        return `${item.item_id} ${item.item_key} "${item.name}" kind=${item.kind} sell=${item.sell_price}`;
      }
      case "event": {
        const started = await this.services.event_service.Start(args[0] ?? "", number_arg(args[1] ?? "60"), admin_id);
        await this.Log(admin_id, "start_event", started.event_key);
        this.services.broadcast_all("event_update", { events: this.services.event_service.ActiveEvents() });
        return `Event ${started.event_key} started.`;
      }
      default:
        throw new GameError("unknown_command", "Commands: /give /take /coins /ban /unban /kick /mute /tp /world /item /event", 400);
    }
  }
}
