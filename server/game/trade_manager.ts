import crypto from "node:crypto";
import type { Database } from "../database/database.ts";
import { GetItem, IsValidItemId } from "../../shared/items.ts";
import type { TradeStateView } from "../../shared/protocol.ts";
import { CreateLogger } from "../logging/logger.ts";
import { GameError, InsufficientError, NotFoundError, ValidationError } from "../services/errors.ts";
import type { PlayerHub } from "../services/hub.ts";
import type { InventoryService } from "../services/inventory_service.ts";
import type { PlayerService } from "../services/player_service.ts";
import type { NotificationService, ProgressService } from "../services/progress_service.ts";

const log = CreateLogger("trade");
const MAX_TRADE_ENTRIES = 12;
const REQUEST_TTL_MS = 60_000;

interface TradeSide {
  player_id: number;
  username: string;
  items: { item_id: number; quantity: number }[];
  coins: number;
  confirmed: boolean;
}

interface TradeSession {
  trade_id: string;
  status: "pending" | "open" | "locked";
  sides: [TradeSide, TradeSide];
  created_at: number;
  revision: number;
}

// Trades live in memory until both confirm; the commit is one SQLite transaction that re-validates everything.
export class TradeManager {
  private trades = new Map<string, TradeSession>();
  private by_player = new Map<number, string>();

  constructor(
    private db: Database,
    private hub: PlayerHub,
    private player_service: PlayerService,
    private inventory_service: InventoryService,
    private progress_service: ProgressService,
    private notification_service: NotificationService
  ) {}

  private View(trade: TradeSession): TradeStateView {
    return { trade_id: trade.trade_id, status: trade.status, sides: trade.sides.map((side) => ({ ...side, items: side.items.map((item) => ({ ...item })) })) };
  }

  private Push(trade: TradeSession): void {
    const view = this.View(trade);
    for (const side of trade.sides) this.hub.Send(side.player_id, "trade_update", view);
  }

  private Close(trade: TradeSession, reason: string, completed = false): void {
    this.trades.delete(trade.trade_id);
    for (const side of trade.sides) {
      if (this.by_player.get(side.player_id) === trade.trade_id) this.by_player.delete(side.player_id);
      this.hub.Send(side.player_id, "trade_closed", { trade_id: trade.trade_id, reason, completed });
    }
  }

  ActiveTradeOf(player_id: number): string | undefined {
    return this.by_player.get(player_id);
  }

  async Request(from: { player_id: number; username: string }, target_name: unknown): Promise<void> {
    const target = await this.player_service.FindByUsername(String(target_name ?? ""));
    if (!target) throw new NotFoundError("No player with that name.");
    if (target.user_id === from.player_id) throw new ValidationError("You cannot trade with yourself.");
    if (!this.hub.IsOnline(target.user_id)) throw new ValidationError(`${target.username} is not online.`);
    if (this.by_player.has(from.player_id)) throw new ValidationError("Finish your current trade first.");
    if (this.by_player.has(target.user_id)) throw new ValidationError(`${target.username} is already trading.`);
    const trade: TradeSession = {
      trade_id: crypto.randomUUID(),
      status: "pending",
      created_at: Date.now(),
      revision: 0,
      sides: [
        { player_id: from.player_id, username: from.username, items: [], coins: 0, confirmed: false },
        { player_id: target.user_id, username: target.username, items: [], coins: 0, confirmed: false }
      ]
    };
    this.trades.set(trade.trade_id, trade);
    this.by_player.set(from.player_id, trade.trade_id);
    this.by_player.set(target.user_id, trade.trade_id);
    this.hub.Send(target.user_id, "trade_request", { trade_id: trade.trade_id, from_username: from.username });
    this.hub.Send(target.user_id, "notification", { kind: "trade_request", message: `${from.username} wants to trade.`, created_at: Date.now() });
    this.Push(trade);
  }

  private Get(player_id: number, trade_id: unknown): { trade: TradeSession; side: TradeSide; other: TradeSide } {
    if (typeof trade_id !== "string") throw new ValidationError("Invalid trade.");
    const trade = this.trades.get(trade_id);
    if (!trade) throw new NotFoundError("That trade is no longer open.");
    const index = trade.sides.findIndex((side) => side.player_id === player_id);
    if (index < 0) throw new GameError("trade_state", "You are not part of that trade.", 403);
    return { trade, side: trade.sides[index], other: trade.sides[1 - index] };
  }

  Respond(player_id: number, trade_id: unknown, accept: unknown): void {
    const { trade } = this.Get(player_id, trade_id);
    if (trade.status !== "pending") throw new GameError("trade_state", "That trade was already answered.", 409);
    if (trade.sides[1].player_id !== player_id) throw new GameError("trade_state", "Only the invited player can answer.", 403);
    if (accept !== true) return this.Close(trade, "declined");
    trade.status = "open";
    this.Push(trade);
  }

  async Offer(player_id: number, trade_id: unknown, items: unknown, coins: unknown): Promise<void> {
    const { trade, side } = this.Get(player_id, trade_id);
    if (trade.status !== "open") throw new GameError("trade_state", trade.status === "locked" ? "The trade is being completed." : "The trade is not open yet.", 409);
    if (!Array.isArray(items) || items.length > MAX_TRADE_ENTRIES) throw new ValidationError(`Offer up to ${MAX_TRADE_ENTRIES} item stacks.`);
    if (typeof coins !== "number" || !Number.isInteger(coins) || coins < 0 || coins > 1_000_000_000) throw new ValidationError("Invalid coin amount.");
    const merged = new Map<number, number>();
    for (const entry of items) {
      const item_id = (entry as { item_id?: unknown })?.item_id;
      const quantity = (entry as { quantity?: unknown })?.quantity;
      if (!IsValidItemId(item_id)) throw new ValidationError("Unknown item in offer.");
      if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) throw new ValidationError("Invalid quantity in offer.");
      merged.set(item_id, (merged.get(item_id) ?? 0) + quantity);
    }
    for (const [item_id, quantity] of merged) {
      const have = await this.inventory_service.CountItem(player_id, item_id);
      if (have < quantity) throw new InsufficientError(`You only have ${have} ${GetItem(item_id)!.name}.`);
    }
    const player = await this.player_service.GetPlayer(player_id);
    if (player.coins < coins) throw new InsufficientError(`You only have ${player.coins} coins.`);
    if (!this.trades.has(trade.trade_id) || trade.status !== "open") throw new GameError("trade_state", "The trade changed, try again.", 409);
    side.items = [...merged.entries()].map(([item_id, quantity]) => ({ item_id, quantity }));
    side.coins = coins;
    // Any change voids both confirmations.
    for (const entry of trade.sides) entry.confirmed = false;
    trade.revision++;
    this.Push(trade);
  }

  async Confirm(player_id: number, trade_id: unknown, revision?: unknown): Promise<void> {
    const { trade, side } = this.Get(player_id, trade_id);
    if (trade.status !== "open") throw new GameError("trade_state", "The trade is not open.", 409);
    if (revision !== undefined && revision !== trade.revision) throw new GameError("trade_state", "The offer changed. Review it again.", 409);
    side.confirmed = true;
    if (!trade.sides.every((entry) => entry.confirmed)) return this.Push(trade);
    trade.status = "locked";
    this.Push(trade);
    try {
      await this.Commit(trade);
      this.Close(trade, "completed", true);
      for (const entry of trade.sides) {
        await this.notification_service.Notify(entry.player_id, "trade_completed", `Trade with ${trade.sides.find((other) => other !== entry)!.username} completed.`);
        await this.progress_service.Track(entry.player_id, [{ stat_key: "trades_completed" }]);
        await this.inventory_service.PushInventory(entry.player_id);
        await this.player_service.PushSelf(entry.player_id);
      }
    } catch (error) {
      log.Warn("trade commit failed", { trade_id: trade.trade_id, error: String(error) });
      if (!this.trades.has(trade.trade_id)) return;
      trade.status = "open";
      for (const entry of trade.sides) entry.confirmed = false;
      this.Push(trade);
      throw error instanceof GameError ? error : new GameError("trade_failed", "The trade could not be completed.", 409);
    }
  }

  private async Commit(trade: TradeSession): Promise<void> {
    const [a, b] = trade.sides;
    await this.db.Transaction(async () => {
      for (const side of trade.sides) {
        for (const item of side.items) {
          const have = await this.inventory_service.CountItem(side.player_id, item.item_id);
          if (have < item.quantity) throw new InsufficientError(`${side.username} no longer has ${item.quantity} ${GetItem(item.item_id)!.name}.`);
        }
      }
      for (const side of trade.sides) for (const item of side.items) await this.inventory_service.RemoveItem(side.player_id, item.item_id, item.quantity);
      for (const [from, to] of [[a, b], [b, a]] as const) {
        for (const item of from.items) await this.inventory_service.AddItem(to.player_id, item.item_id, item.quantity);
        if (from.coins > 0) {
          await this.player_service.ChangeCoins(from.player_id, -from.coins, "trade_out", { reference_id: trade.trade_id });
          await this.player_service.ChangeCoins(to.player_id, from.coins, "trade_in", { reference_id: trade.trade_id });
        }
      }
      const now = Date.now();
      await this.db.Run("INSERT INTO trades (trade_id, player_a_id, player_b_id, coins_a, coins_b, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)", trade.trade_id, a.player_id, b.player_id, a.coins, b.coins, trade.created_at, now);
      for (const side of trade.sides) for (const item of side.items) await this.db.Run("INSERT INTO trade_items (trade_id, player_id, item_id, quantity) VALUES (?, ?, ?, ?)", trade.trade_id, side.player_id, item.item_id, item.quantity);
    });
  }

  Cancel(player_id: number, trade_id: unknown): void {
    const { trade } = this.Get(player_id, trade_id);
    if (trade.status === "locked") throw new GameError("trade_state", "The trade is already being completed.", 409);
    this.Close(trade, "cancelled");
  }

  // Disconnect or world change: a locked trade is mid-commit and finishes on its own.
  CancelForPlayer(player_id: number, reason: string): void {
    const trade_id = this.by_player.get(player_id);
    if (!trade_id) return;
    const trade = this.trades.get(trade_id);
    if (!trade || trade.status === "locked") return;
    this.Close(trade, reason);
  }

  Sweep(): void {
    const now = Date.now();
    for (const trade of this.trades.values()) if (trade.status === "pending" && now - trade.created_at > REQUEST_TTL_MS) this.Close(trade, "expired");
  }

  History(player_id: number) {
    return this.db.All(
      `SELECT t.trade_id, t.coins_a, t.coins_b, t.completed_at, a.username AS player_a, b.username AS player_b FROM trades t
       JOIN users a ON a.user_id = t.player_a_id JOIN users b ON b.user_id = t.player_b_id WHERE t.player_a_id = ? OR t.player_b_id = ? ORDER BY t.completed_at DESC LIMIT 30`,
      player_id, player_id
    );
  }
}
