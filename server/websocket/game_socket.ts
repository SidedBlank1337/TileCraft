import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { CLIENT_EVENTS, type ClientEventName, type PlayerSelfView } from "../../shared/protocol.ts";
import { DEFAULT_APPEARANCE } from "../../shared/cosmetics.ts";
import { CreateLogger } from "../logging/logger.ts";
import { GameError, ValidationError } from "../services/errors.ts";
import { RateLimiter } from "../services/security_service.ts";
import { SanitizeChat } from "../services/social_services.ts";
import type { Services } from "../service_container.ts";
import type { GameClient } from "../game/world_manager.ts";
import { ReadSessionCookie, IsAllowedOrigin } from "../api/http_helpers.ts";

const log = CreateLogger("websocket");
const MAX_PAYLOAD_BYTES = 8 * 1024;
const CLIENT_EVENT_SET = new Set<string>(CLIENT_EVENTS);

interface Connection {
  socket: WebSocket;
  client: GameClient;
  session_id: string;
  alive: boolean;
  queue: Promise<void>;
  message_times: number[];
  ip: string;
}

export class GameSocketServer {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  private connections = new Map<number, Connection>();
  private chat_limiter = new RateLimiter(6, 6000);
  private global_chat_limiter = new RateLimiter(3, 10_000);
  private timers: NodeJS.Timeout[] = [];

  constructor(private services: Services, private allowed_origins: string[]) {
    services.hub.Attach((player_id, event, data) => this.SendTo(player_id, event, data), (player_id) => this.connections.has(player_id));
    services.disconnect_player = (player_id, message) => {
      const connection = this.connections.get(player_id);
      if (!connection) return;
      this.Send(connection, "kicked", { message });
      connection.socket.close(4003, "disconnected");
    };
    services.refresh_identity = (player_id, username) => {
      const connection = this.connections.get(player_id);
      if (!connection) return;
      connection.client.is_guest = false;
      connection.client.username = username;
      const world = connection.client.world;
      if (world) void services.world_manager.Join(connection.client, world.row.world_name).catch(() => undefined);
    };
    services.broadcast_all = (event, data) => {
      for (const connection of this.connections.values()) this.Send(connection, event, data);
    };
    this.timers.push(setInterval(() => this.Heartbeat(), 20_000));
    this.timers.push(setInterval(() => void this.RevalidateSessions(), 60_000));
  }

  get online_count(): number {
    return this.connections.size;
  }

  async HandleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const origin = request.headers.origin;
      if (origin && !IsAllowedOrigin(origin, request.headers.host, this.allowed_origins)) {
        await this.services.security_service.Record(null, "websocket_bad_origin", { origin }, request.socket.remoteAddress ?? null);
        return reject(403, "Forbidden");
      }
      const user = await this.services.auth_service.ValidateToken(ReadSessionCookie(request.headers.cookie));
      if (!user) {
        await this.services.security_service.Record(null, "websocket_unauthenticated", {}, request.socket.remoteAddress ?? null);
        return reject(401, "Unauthorized");
      }
      // Load the player before the upgrade so message listeners attach synchronously and no early packet is lost.
      const self = await this.services.player_service.GetSelfView(user.user_id);
      this.wss.handleUpgrade(request, socket, head, (ws) => void this.OnConnect(ws, user, self, request.socket.remoteAddress ?? "unknown"));
    } catch (error) {
      log.Error("upgrade failed", { error: String(error) });
      reject(500, "Internal Server Error");
    }
  }

  private async OnConnect(socket: WebSocket, user: { user_id: number; username: string; is_admin: boolean; session_id: string }, self: PlayerSelfView, ip: string): Promise<void> {
    // One live connection per player: the newest wins so actions are never processed twice.
    const previous = this.connections.get(user.user_id);
    if (previous) {
      this.Send(previous, "kicked", { message: "You connected from another tab." });
      this.Cleanup(previous);
      previous.socket.close(4001, "replaced");
    }
    const connection: Connection = {
      socket, session_id: user.session_id, alive: true, queue: Promise.resolve(), message_times: [], ip,
      client: {
        player_id: user.user_id, username: user.username, is_admin: self.is_admin, is_guest: self.is_guest, appearance: self.appearance ?? DEFAULT_APPEARANCE, level: self.level,
        Send: (event, data) => this.Send(connection, event, data),
        world: null, access: null, x: 0, y: 0, vx: 0, vy: 0, facing: 1, anim: "idle", moved: false, last_move_at: Date.now(), last_grounded_y: 0,
        last_hit_at: 0, last_place_at: 0, joined_at: Date.now(), violations: 0, fishing_until: 0, busy: false
      }
    };
    this.connections.set(user.user_id, connection);
    socket.on("pong", () => (connection.alive = true));
    socket.on("message", (raw, is_binary) => this.OnMessage(connection, raw as Buffer, is_binary));
    socket.on("close", () => {
      if (this.connections.get(user.user_id) === connection) this.Cleanup(connection);
    });
    socket.on("error", (error) => log.Warn("socket error", { player_id: user.user_id, error: String(error) }));
    this.Send(connection, "hello", {
      player: self,
      inventory: await this.services.inventory_service.GetInventory(user.user_id),
      events: this.services.event_service.ActiveEvents(),
      server_time: Date.now()
    });
    log.Info("player connected", { player_id: user.user_id, online: this.connections.size });
  }

  private Cleanup(connection: Connection): void {
    const player_id = connection.client.player_id;
    if (this.connections.get(player_id) === connection) this.connections.delete(player_id);
    this.services.world_manager.Leave(connection.client, "disconnect");
    this.services.trade_manager.CancelForPlayer(player_id, "player disconnected");
  }

  private OnMessage(connection: Connection, raw: Buffer, is_binary: boolean): void {
    const now = Date.now();
    connection.message_times = connection.message_times.filter((time) => now - time < 1000);
    connection.message_times.push(now);
    if (connection.message_times.length > 120) {
      void this.services.security_service.Record(connection.client.player_id, "websocket_flood", { per_second: connection.message_times.length }, connection.ip);
      connection.socket.close(4008, "flood");
      return;
    }
    if (connection.message_times.length > 60) return;

    let parsed: unknown;
    try {
      if (is_binary) throw new Error("binary");
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      this.ProtocolViolation(connection, "malformed_json");
      return;
    }
    const message = parsed as { event?: unknown; data?: unknown };
    if (!message || typeof message !== "object" || typeof message.event !== "string" || !CLIENT_EVENT_SET.has(message.event)) {
      this.ProtocolViolation(connection, "unknown_event", { event: String((message as { event?: unknown })?.event).slice(0, 40) });
      return;
    }
    const data = message.data ?? {};
    if (typeof data !== "object" || Array.isArray(data) || data === null) {
      this.ProtocolViolation(connection, "bad_payload", { event: message.event });
      return;
    }
    const event = message.event as ClientEventName;
    const payload = data as Record<string, unknown>;

    if (event === "player_move") {
      this.Guard(connection, event, () => this.services.world_manager.HandleMove(connection.client, payload));
      return;
    }
    if (event === "ping") {
      this.Send(connection, "pong", { t: payload.t, server_time: Date.now() });
      return;
    }
    // Everything else runs strictly in order per player, so concurrent packets cannot race each other.
    connection.queue = connection.queue.then(() => this.Guard(connection, event, () => this.Dispatch(connection, event, payload)));
  }

  private ProtocolViolation(connection: Connection, kind: string, details: Record<string, unknown> = {}): void {
    void this.services.security_service.Record(connection.client.player_id, `protocol_${kind}`, details, connection.ip);
    this.Send(connection, "error", { code: "protocol", message: "Invalid message." });
  }

  private async Guard(connection: Connection, event: string, work: () => unknown): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (error instanceof GameError) this.Send(connection, "error", { code: error.code, message: error.message, event });
      else {
        log.Error("handler failed", { event, player_id: connection.client.player_id, error: error instanceof Error ? error.stack : String(error) });
        this.Send(connection, "error", { code: "server_error", message: "Something went wrong. Please try again.", event });
      }
    }
  }

  private async Dispatch(connection: Connection, event: ClientEventName, data: Record<string, unknown>): Promise<void> {
    const client = connection.client;
    const manager = this.services.world_manager;
    const trades = this.services.trade_manager;
    if (client.is_guest && event.startsWith("trade_") && event !== "trade_cancel") throw new GameError("tile_id_required", "Create a TileID to trade.", 403);
    switch (event) {
      case "join_world":
        await manager.Join(client, data.world_name);
        return;
      case "leave_world":
        manager.Leave(client, "left");
        this.Send(connection, "world_left", {});
        return;
      case "block_hit":
        return manager.HandleHit(client, data);
      case "block_place":
        return manager.HandlePlace(client, data);
      case "item_pickup":
        return manager.HandlePickup(client, data);
      case "item_drop":
        return manager.HandleDropItem(client, data);
      case "interact":
        return manager.HandleInteract(client, data);
      case "chat_send":
        return this.HandleChat(connection, data);
      case "trade_request":
        return trades.Request({ player_id: client.player_id, username: client.username }, data.username);
      case "trade_respond":
        return trades.Respond(client.player_id, data.trade_id, data.accept);
      case "trade_offer":
        return trades.Offer(client.player_id, data.trade_id, data.items, data.coins);
      case "trade_confirm":
        return trades.Confirm(client.player_id, data.trade_id, data.revision);
      case "trade_cancel":
        return trades.Cancel(client.player_id, data.trade_id);
      default:
        return;
    }
  }

  private async HandleChat(connection: Connection, data: Record<string, unknown>): Promise<void> {
    const client = connection.client;
    const body = SanitizeChat(data.text);
    const channel = data.channel === "global" || data.channel === "private" ? data.channel : "world";
    if (!this.chat_limiter.Allow(`chat:${client.player_id}`)) throw new GameError("rate_limited", "You are sending messages too fast.", 429);

    if (body.startsWith("/")) return this.HandleCommand(connection, body);
    await this.services.chat_service.AssertNotMuted(client.player_id);

    const created_at = Date.now();
    if (channel === "world") {
      const world = client.world;
      if (!world) throw new ValidationError("Join a world to use world chat.");
      if (!world.settings.chat_enabled && !client.access?.can_manage) throw new ValidationError("Chat is disabled in this world.");
      const message_id = await this.services.chat_service.Save("world", client.player_id, body, world.row.world_id, null);
      const message = { message_id, channel, body, created_at, sender_id: client.player_id, sender_name: client.username };
      for (const other of world.players.values()) {
        const blocked = await this.services.chat_service.BlockedSet(other.player_id);
        if (!blocked.has(client.player_id)) other.Send("chat_message", message);
      }
    } else if (channel === "global") {
      if (!this.global_chat_limiter.Allow(`global:${client.player_id}`)) throw new GameError("rate_limited", "Global chat is limited to 3 messages per 10 seconds.", 429);
      const message_id = await this.services.chat_service.Save("global", client.player_id, body, null, null);
      const message = { message_id, channel, body, created_at, sender_id: client.player_id, sender_name: client.username };
      for (const other of this.connections.values()) {
        const blocked = await this.services.chat_service.BlockedSet(other.client.player_id);
        if (!blocked.has(client.player_id)) this.Send(other, "chat_message", message);
      }
    } else {
      await this.SendPrivate(connection, data.to_username, body);
    }
    await this.services.progress_service.Track(client.player_id, [{ stat_key: "chat_messages" }]);
  }

  private async SendPrivate(connection: Connection, to_username: unknown, body: string): Promise<void> {
    const client = connection.client;
    const target = await this.services.player_service.FindByUsername(String(to_username ?? ""));
    if (!target) throw new ValidationError("No player with that name.");
    if (target.user_id === client.player_id) throw new ValidationError("You cannot message yourself.");
    const blocked = await this.services.chat_service.BlockedSet(target.user_id);
    if (blocked.has(client.player_id)) throw new ValidationError(`${target.username} is not accepting your messages.`);
    const message_id = await this.services.chat_service.Save("private", client.player_id, body, null, target.user_id);
    const message = { message_id, channel: "private", body, created_at: Date.now(), sender_id: client.player_id, sender_name: client.username, recipient_name: target.username };
    this.SendTo(target.user_id, "chat_message", message);
    this.Send(connection, "chat_message", message);
  }

  private async HandleCommand(connection: Connection, body: string): Promise<void> {
    const client = connection.client;
    const [command, ...rest] = body.slice(1).split(" ");
    const reply = (text: string) => this.Send(connection, "chat_message", { message_id: 0, channel: "system", body: text, created_at: Date.now(), sender_id: 0, sender_name: "System" });
    switch (command.toLowerCase()) {
      case "help":
        reply("Commands: /msg NAME text, /trade NAME, /setspawn (world managers), /who" + (client.is_admin ? ". Admin: /give /take /coins /ban /unban /kick /mute /tp /world /item /event" : ""));
        return;
      case "msg":
      case "w":
        await this.services.chat_service.AssertNotMuted(client.player_id);
        return this.SendPrivate(connection, rest[0], SanitizeChat(rest.slice(1).join(" ")));
      case "trade":
        if (client.is_guest) throw new GameError("tile_id_required", "Create a TileID to trade.", 403);
        return this.services.trade_manager.Request({ player_id: client.player_id, username: client.username }, rest[0]);
      case "setspawn":
        if (client.is_guest) throw new GameError("tile_id_required", "Create a TileID first.", 403);
        await this.services.world_manager.SetSpawnHere(client);
        reply("Spawn point moved here.");
        return;
      case "who":
        reply(client.world ? `In ${client.world.row.world_name}: ${[...client.world.players.values()].map((other) => other.username).join(", ")}` : `${this.connections.size} players online.`);
        return;
    }
    // Admin rights are re-read from the DB on every command, never from the socket state.
    const fresh = await this.services.player_service.GetPlayer(client.player_id);
    if (fresh.is_admin !== 1) {
      void this.services.security_service.Record(client.player_id, "admin_command_denied", { command: command.slice(0, 20) });
      throw new GameError("forbidden", "Unknown command. Try /help.", 403);
    }
    reply(await this.services.admin_service.RunCommand(client.player_id, body));
  }

  private Send(connection: Connection, event: string, data: unknown): void {
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify({ event, data }));
  }

  private SendTo(player_id: number, event: string, data: unknown): void {
    const connection = this.connections.get(player_id);
    if (connection) this.Send(connection, event, data);
  }

  private Heartbeat(): void {
    for (const connection of this.connections.values()) {
      if (!connection.alive) {
        connection.socket.terminate();
        this.Cleanup(connection);
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  private async RevalidateSessions(): Promise<void> {
    for (const connection of [...this.connections.values()]) {
      const row = await this.services.db.Get<{ expires_at: number; banned_until: number | null }>(
        "SELECT s.expires_at, u.banned_until FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ?", connection.session_id
      );
      if (!row || row.expires_at <= Date.now() || (row.banned_until && row.banned_until > Date.now())) {
        this.Send(connection, "session_expired", {});
        connection.socket.close(4002, "session");
      }
    }
  }

  async Close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    for (const connection of this.connections.values()) connection.socket.close(1001, "server shutdown");
    this.wss.close();
  }
}
