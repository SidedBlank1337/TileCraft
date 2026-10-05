import type { Database } from "../database/database.ts";
import { MARKET_FEE_RATE, MARKET_LISTING_HOURS, MAX_LISTINGS_PER_PLAYER } from "../../shared/constants.ts";
import { RECIPES_BY_ID } from "../../shared/recipes.ts";
import { SHOP_BY_ITEM, SHOP_ENTRIES } from "../../shared/economy.ts";
import { GetItem, ITEM_LIST } from "../../shared/items.ts";
import { GameError, InsufficientError, NotFoundError, ValidationError } from "./errors.ts";
import { AssertItemId, AssertQuantity, AssertSlot, type InventoryService } from "./inventory_service.ts";
import type { PlayerService } from "./player_service.ts";
import type { NotificationService, ProgressService } from "./progress_service.ts";

function UtcDay(time = Date.now()): string {
  return new Date(time).toISOString().slice(0, 10);
}

// Replay protection for REST mutations: the same request_id from the same player runs once.
export async function ClaimRequestId(db: Database, player_id: number, request_id: unknown): Promise<void> {
  if (request_id === undefined || request_id === null) return;
  if (typeof request_id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(request_id)) throw new ValidationError("Invalid request id.");
  const result = await db.Run("INSERT OR IGNORE INTO idempotency_keys (player_id, request_id, created_at) VALUES (?, ?, ?)", player_id, request_id, Date.now());
  if (result.changes === 0) throw new GameError("duplicate_request", "That action was already processed.", 409);
}

export class CraftingService {
  constructor(private db: Database, private player_service: PlayerService, private inventory_service: InventoryService, private progress_service: ProgressService) {}

  async Craft(player_id: number, recipe_id: unknown, times: unknown = 1) {
    const recipe = typeof recipe_id === "string" ? RECIPES_BY_ID.get(recipe_id) : undefined;
    if (!recipe) throw new NotFoundError("Unknown recipe.");
    const count = AssertQuantity(times, 50);
    const player = await this.player_service.GetPlayer(player_id);
    if (player.level < recipe.unlock_level) throw new ValidationError(`Reach level ${recipe.unlock_level} to craft ${recipe.name}.`);
    await this.db.Transaction(async () => {
      for (const ingredient of recipe.ingredients) {
        const have = await this.inventory_service.CountItem(player_id, ingredient.item_id);
        if (have < ingredient.quantity * count) {
          throw new InsufficientError(`Need ${ingredient.quantity * count} ${GetItem(ingredient.item_id)!.name}, you have ${have}.`);
        }
      }
      for (const ingredient of recipe.ingredients) await this.inventory_service.RemoveItem(player_id, ingredient.item_id, ingredient.quantity * count);
      await this.inventory_service.AddItem(player_id, recipe.result_item_id, recipe.result_quantity * count);
    });
    const xp = await this.player_service.AwardXp(player_id, recipe.xp * count);
    if (xp.level_up) this.progress_service.LevelUpNotice(player_id, xp.level_up, xp.level_reward);
    await this.progress_service.Track(player_id, [{ stat_key: "items_crafted", amount: count }]);
    return { result_item_id: recipe.result_item_id, quantity: recipe.result_quantity * count, xp_gained: xp.xp_gained };
  }

  async UseItem(player_id: number, slot: unknown) {
    const slot_index = AssertSlot(slot);
    const entry = await this.inventory_service.GetSlot(player_id, slot_index);
    const item = entry ? GetItem(entry.item_id) : undefined;
    if (!entry || !item) throw new ValidationError("That slot is empty.");
    if (item.kind !== "consumable" || !item.use_xp) throw new ValidationError(`${item.name} cannot be used.`);
    await this.inventory_service.RemoveFromSlot(player_id, slot_index, 1);
    const xp = await this.player_service.AwardXp(player_id, item.use_xp);
    if (xp.level_up) this.progress_service.LevelUpNotice(player_id, xp.level_up, xp.level_reward);
    return { item_id: item.item_id, xp_gained: xp.xp_gained };
  }
}

export class ShopService {
  constructor(private db: Database, private player_service: PlayerService, private inventory_service: InventoryService, private progress_service: ProgressService) {}

  async Catalog(player_id: number) {
    const rows = await this.db.All<{ item_id: number; quantity: number }>("SELECT item_id, quantity FROM shop_purchases WHERE player_id = ? AND day = ?", player_id, UtcDay());
    const bought = new Map(rows.map((row) => [row.item_id, row.quantity]));
    return SHOP_ENTRIES.map((entry) => ({ ...entry, stock_left: entry.daily_limit - (bought.get(entry.item_id) ?? 0), sell_price: GetItem(entry.item_id)!.sell_price }));
  }

  async Buy(player_id: number, item_id: unknown, quantity: unknown, request_id?: unknown) {
    const id = AssertItemId(item_id);
    const amount = AssertQuantity(quantity, 1000);
    const entry = SHOP_BY_ITEM.get(id);
    if (!entry) throw new NotFoundError("The shop does not sell that.");
    const total = entry.price * amount;
    await this.db.Transaction(async () => {
      await ClaimRequestId(this.db, player_id, request_id);
      const day = UtcDay();
      const row = await this.db.Get<{ quantity: number }>("SELECT quantity FROM shop_purchases WHERE player_id = ? AND item_id = ? AND day = ?", player_id, id, day);
      if ((row?.quantity ?? 0) + amount > entry.daily_limit) throw new InsufficientError(`Only ${entry.daily_limit - (row?.quantity ?? 0)} left in stock today.`);
      if ((await this.inventory_service.FreeCapacity(player_id, id)) < amount) throw new InsufficientError("Your inventory is full.", { hint: "inventory_full" });
      await this.player_service.ChangeCoins(player_id, -total, "shop_buy", { item_id: id, quantity: amount });
      await this.inventory_service.AddItem(player_id, id, amount);
      await this.db.Run(
        `INSERT INTO shop_purchases (player_id, item_id, day, quantity) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, item_id, day) DO UPDATE SET quantity = quantity + excluded.quantity`,
        player_id, id, day, amount
      );
    });
    await this.progress_service.Track(player_id, [{ stat_key: "shop_purchases", amount }]);
    return { item_id: id, quantity: amount, spent: total };
  }

  async Sell(player_id: number, item_id: unknown, quantity: unknown, request_id?: unknown) {
    const id = AssertItemId(item_id);
    const amount = AssertQuantity(quantity);
    const item = GetItem(id)!;
    if (item.sell_price <= 0) throw new ValidationError("That item cannot be sold to the shop.");
    const total = item.sell_price * amount;
    await this.db.Transaction(async () => {
      await ClaimRequestId(this.db, player_id, request_id);
      await this.inventory_service.RemoveItem(player_id, id, amount);
      await this.player_service.ChangeCoins(player_id, total, "shop_sell", { item_id: id, quantity: amount });
    });
    return { item_id: id, quantity: amount, earned: total };
  }
}

export interface ListingRow {
  listing_id: number;
  seller_id: number;
  seller_name: string;
  item_id: number;
  quantity: number;
  initial_quantity: number;
  unit_price: number;
  status: string;
  created_at: number;
  expires_at: number;
}

export class MarketplaceService {
  constructor(
    private db: Database,
    private player_service: PlayerService,
    private inventory_service: InventoryService,
    private progress_service: ProgressService,
    private notification_service: NotificationService
  ) {}

  // Items move into escrow (the listing row) the moment they are listed.
  async CreateListing(player_id: number, input: { slot_index?: unknown; item_id?: unknown; quantity?: unknown; unit_price?: unknown }) {
    const quantity = AssertQuantity(input.quantity, 10_000);
    const unit_price = AssertQuantity(input.unit_price, 10_000_000);
    return this.db.Transaction(async () => {
      const active = await this.db.Get<{ count: number }>("SELECT COUNT(*) AS count FROM marketplace_listings WHERE seller_id = ? AND status = 'active'", player_id);
      if ((active?.count ?? 0) >= MAX_LISTINGS_PER_PLAYER) throw new GameError("listing_limit", `You can have at most ${MAX_LISTINGS_PER_PLAYER} active listings.`, 409);
      let item_id: number;
      if (input.slot_index !== undefined) {
        const slot = await this.inventory_service.RemoveFromSlot(player_id, AssertSlot(input.slot_index), quantity);
        item_id = slot.item_id;
      } else {
        item_id = AssertItemId(input.item_id);
        await this.inventory_service.RemoveItem(player_id, item_id, quantity);
      }
      const now = Date.now();
      const result = await this.db.Run(
        `INSERT INTO marketplace_listings (seller_id, item_id, quantity, initial_quantity, unit_price, status, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        player_id, item_id, quantity, quantity, unit_price, now, now + MARKET_LISTING_HOURS * 3600_000, now
      );
      return { listing_id: result.last_id, item_id, quantity, unit_price };
    });
  }

  async Buy(buyer_id: number, listing_id: unknown, quantity: unknown, request_id?: unknown) {
    if (typeof listing_id !== "number" || !Number.isInteger(listing_id)) throw new ValidationError("Invalid listing.");
    const amount = AssertQuantity(quantity, 10_000);
    const outcome = await this.db.Transaction(async () => {
      await ClaimRequestId(this.db, buyer_id, request_id);
      const listing = await this.db.Get<ListingRow>("SELECT * FROM marketplace_listings WHERE listing_id = ?", listing_id);
      if (!listing) throw new NotFoundError("Listing not found.");
      if (listing.status !== "active" || listing.expires_at <= Date.now()) throw new GameError("listing_unavailable", "That listing is no longer available.", 409);
      if (listing.seller_id === buyer_id) throw new ValidationError("You cannot buy your own listing.");
      if (listing.quantity < amount) throw new InsufficientError(`Only ${listing.quantity} left in this listing.`);
      if ((await this.inventory_service.FreeCapacity(buyer_id, listing.item_id)) < amount) throw new InsufficientError("Your inventory is full.", { hint: "inventory_full" });
      const total = listing.unit_price * amount;
      const fee = Math.floor(total * MARKET_FEE_RATE);
      // Conditional update is the race guard: a second buyer sees changes = 0.
      const claimed = await this.db.Run(
        `UPDATE marketplace_listings SET quantity = quantity - ?, status = CASE WHEN quantity - ? = 0 THEN 'sold' ELSE status END, updated_at = ?
         WHERE listing_id = ? AND status = 'active' AND quantity >= ?`,
        amount, amount, Date.now(), listing_id, amount
      );
      if (claimed.changes === 0) throw new GameError("listing_unavailable", "Someone else bought it first.", 409);
      await this.player_service.ChangeCoins(buyer_id, -total, "market_buy", { reference_id: listing_id, item_id: listing.item_id, quantity: amount });
      await this.inventory_service.AddItem(buyer_id, listing.item_id, amount);
      if (total - fee > 0) await this.player_service.ChangeCoins(listing.seller_id, total - fee, "market_sale", { reference_id: listing_id, item_id: listing.item_id, quantity: amount });
      await this.db.Run(
        `INSERT INTO marketplace_transactions (listing_id, buyer_id, seller_id, item_id, quantity, unit_price, total, fee, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        listing_id, buyer_id, listing.seller_id, listing.item_id, amount, listing.unit_price, total, fee, Date.now()
      );
      await this.db.Run("INSERT INTO admin_logs (admin_id, action, target, details, created_at) VALUES (NULL, 'market_purchase', ?, ?, ?)", String(listing_id), JSON.stringify({ buyer_id, seller_id: listing.seller_id, amount, total, fee }), Date.now());
      return { listing, total, fee };
    });
    const item_name = GetItem(outcome.listing.item_id)!.name;
    await this.progress_service.Track(buyer_id, [{ stat_key: "market_purchases" }]);
    await this.progress_service.Track(outcome.listing.seller_id, [{ stat_key: "market_sales" }]);
    await this.notification_service.Notify(outcome.listing.seller_id, "market_sale", `Sold ${amount}x ${item_name} for ${outcome.total - outcome.fee} coins.`);
    await this.player_service.PushSelf(outcome.listing.seller_id);
    return { listing_id, quantity: amount, total: outcome.total };
  }

  async Cancel(player_id: number, listing_id: unknown, is_site_admin = false) {
    if (typeof listing_id !== "number" || !Number.isInteger(listing_id)) throw new ValidationError("Invalid listing.");
    return this.db.Transaction(async () => {
      const listing = await this.db.Get<ListingRow>("SELECT * FROM marketplace_listings WHERE listing_id = ?", listing_id);
      if (!listing) throw new NotFoundError("Listing not found.");
      if (listing.seller_id !== player_id && !is_site_admin) throw new ValidationError("That is not your listing.");
      const claimed = await this.db.Run("UPDATE marketplace_listings SET status = 'cancelled', quantity = 0, updated_at = ? WHERE listing_id = ? AND status = 'active'", Date.now(), listing_id);
      if (claimed.changes === 0) throw new GameError("listing_unavailable", "That listing is no longer active.", 409);
      if (listing.quantity > 0) await this.inventory_service.AddItem(listing.seller_id, listing.item_id, listing.quantity);
      return { returned: listing.quantity };
    });
  }

  // Expired listings return escrow to the seller; if their bag is full the listing stays until it fits.
  async ExpireListings(): Promise<number> {
    const rows = await this.db.All<ListingRow>("SELECT * FROM marketplace_listings WHERE status = 'active' AND expires_at <= ? LIMIT 100", Date.now());
    let expired = 0;
    for (const listing of rows) {
      try {
        await this.db.Transaction(async () => {
          const claimed = await this.db.Run("UPDATE marketplace_listings SET status = 'expired', quantity = 0, updated_at = ? WHERE listing_id = ? AND status = 'active'", Date.now(), listing.listing_id);
          if (claimed.changes === 0) return;
          if (listing.quantity > 0) await this.inventory_service.AddItem(listing.seller_id, listing.item_id, listing.quantity);
          expired++;
        });
      } catch {
        // Seller inventory full: retried next sweep.
      }
    }
    return expired;
  }

  async Search(query: { search?: unknown; category?: unknown; sort?: unknown; seller?: unknown }) {
    const where: string[] = ["l.status = 'active'", "l.expires_at > ?"];
    const params: unknown[] = [Date.now()];
    const search = typeof query.search === "string" ? query.search.trim().toLowerCase().slice(0, 40) : "";
    let item_filter: number[] | null = null;
    if (search || (typeof query.category === "string" && query.category !== "all")) {
      item_filter = ITEM_LIST.filter((item) =>
        (!search || item.name.toLowerCase().includes(search) || item.item_key.includes(search)) &&
        (typeof query.category !== "string" || query.category === "all" || item.kind === query.category)
      ).map((item) => item.item_id);
      if (item_filter.length === 0) return [];
      where.push(`l.item_id IN (${item_filter.map(() => "?").join(",")})`);
      params.push(...item_filter);
    }
    if (typeof query.seller === "string" && query.seller) {
      where.push("u.username = ?");
      params.push(query.seller);
    }
    const order = query.sort === "price_desc" ? "l.unit_price DESC" : query.sort === "newest" ? "l.created_at DESC" : query.sort === "quantity" ? "l.quantity DESC" : "l.unit_price ASC";
    return this.db.All<ListingRow>(
      `SELECT l.*, u.username AS seller_name FROM marketplace_listings l JOIN users u ON u.user_id = l.seller_id WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 100`,
      ...params
    );
  }

  MyListings(player_id: number) {
    return this.db.All<ListingRow>(
      `SELECT l.*, u.username AS seller_name FROM marketplace_listings l JOIN users u ON u.user_id = l.seller_id WHERE l.seller_id = ? ORDER BY l.status = 'active' DESC, l.created_at DESC LIMIT 60`,
      player_id
    );
  }

  History(player_id: number) {
    return this.db.All(
      `SELECT t.*, b.username AS buyer_name, s.username AS seller_name FROM marketplace_transactions t
       JOIN users b ON b.user_id = t.buyer_id JOIN users s ON s.user_id = t.seller_id
       WHERE t.buyer_id = ? OR t.seller_id = ? ORDER BY t.created_at DESC LIMIT 60`,
      player_id, player_id
    );
  }

  PriceHistory(item_id: number) {
    return this.db.All("SELECT unit_price, quantity, created_at FROM marketplace_transactions WHERE item_id = ? ORDER BY created_at DESC LIMIT 30", item_id);
  }
}
