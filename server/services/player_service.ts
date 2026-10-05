import type { Database } from "../database/database.ts";
import { STARTING_COINS } from "../../shared/constants.ts";
import { COSMETICS, COSMETICS_BY_KEY, DEFAULT_APPEARANCE, type Appearance, type CosmeticSlot } from "../../shared/cosmetics.ts";
import { LevelFromLifetimeXp, LevelReward } from "../../shared/levels.ts";
import type { PlayerSelfView } from "../../shared/protocol.ts";
import { InsufficientError, NotFoundError, ValidationError } from "./errors.ts";
import type { EventService } from "./event_service.ts";
import type { PlayerHub } from "./hub.ts";

export interface PlayerRow {
  player_id: number;
  username: string;
  coins: number;
  lifetime_xp: number;
  level: number;
  playtime_seconds: number;
  appearance: string;
  settings: string;
  is_admin: number;
  is_guest: number;
  created_at: number;
}

export interface XpResult {
  xp_gained: number;
  level: number;
  level_up: number | null;
  level_reward: number;
}

const STARTER_ITEMS: [number, number][] = [[1, 30], [4, 15], [12, 20], [130, 4], [111, 2], [101, 4]];

export class PlayerService {
  constructor(private db: Database, private event_service: EventService, private hub: PlayerHub) {}

  async CreatePlayer(player_id: number): Promise<void> {
    await this.db.Transaction(async () => {
      const now = Date.now();
      await this.db.Run("INSERT INTO players (player_id, coins, appearance, updated_at) VALUES (?, ?, ?, ?)", player_id, STARTING_COINS, JSON.stringify(DEFAULT_APPEARANCE), now);
      await this.db.Run("INSERT INTO transactions (player_id, type, amount, balance_after, created_at) VALUES (?, 'starting_coins', ?, ?, ?)", player_id, STARTING_COINS, STARTING_COINS, now);
      for (const cosmetic of COSMETICS.filter((entry) => entry.default_owned)) {
        await this.db.Run("INSERT INTO player_cosmetics (player_id, cosmetic_key, acquired_at) VALUES (?, ?, ?)", player_id, cosmetic.cosmetic_key, now);
      }
      let slot_index = 0;
      for (const [item_id, quantity] of STARTER_ITEMS) {
        await this.db.Run("INSERT INTO player_inventory (player_id, slot_index, item_id, quantity) VALUES (?, ?, ?, ?)", player_id, slot_index++, item_id, quantity);
      }
    });
  }

  async GetPlayer(player_id: number): Promise<PlayerRow> {
    const row = await this.db.Get<PlayerRow>(
      `SELECT p.player_id, u.username, p.coins, p.lifetime_xp, p.level, p.playtime_seconds, p.appearance, p.settings, u.is_admin, u.is_guest, u.created_at
       FROM players p JOIN users u ON u.user_id = p.player_id WHERE p.player_id = ?`,
      player_id
    );
    if (!row) throw new NotFoundError("Player not found.");
    return row;
  }

  async FindByUsername(username: string): Promise<{ user_id: number; username: string } | undefined> {
    if (typeof username !== "string" || username.length > 32) return undefined;
    return this.db.Get("SELECT user_id, username FROM users WHERE username = ?", username.trim().replace(/^@/, ""));
  }

  ParseAppearance(raw: string): Appearance {
    try {
      const parsed = JSON.parse(raw) as Appearance;
      return { ...DEFAULT_APPEARANCE, ...parsed };
    } catch {
      return { ...DEFAULT_APPEARANCE };
    }
  }

  async GetSelfView(player_id: number): Promise<PlayerSelfView> {
    const row = await this.GetPlayer(player_id);
    const progress = LevelFromLifetimeXp(row.lifetime_xp);
    return {
      player_id: row.player_id,
      username: row.username,
      coins: row.coins,
      lifetime_xp: row.lifetime_xp,
      level: progress.level,
      xp_into_level: progress.xp_into_level,
      xp_needed: progress.xp_needed,
      is_admin: row.is_admin === 1,
      is_guest: row.is_guest === 1,
      appearance: this.ParseAppearance(row.appearance)
    };
  }

  async PushSelf(player_id: number): Promise<void> {
    if (!this.hub.IsOnline(player_id)) return;
    this.hub.Send(player_id, "player_update", await this.GetSelfView(player_id));
  }

  // The only path that changes coins: guarded against negative balances and always ledgered.
  async ChangeCoins(player_id: number, delta: number, type: string, extra: { reference_id?: string | number | null; item_id?: number | null; quantity?: number | null } = {}): Promise<number> {
    if (!Number.isSafeInteger(delta) || delta === 0) {
      if (delta === 0) return (await this.GetPlayer(player_id)).coins;
      throw new ValidationError("Invalid coin amount.");
    }
    return this.db.Transaction(async () => {
      const result = delta < 0
        ? await this.db.Run("UPDATE players SET coins = coins + ?, updated_at = ? WHERE player_id = ? AND coins >= ?", delta, Date.now(), player_id, -delta)
        : await this.db.Run("UPDATE players SET coins = coins + ?, updated_at = ? WHERE player_id = ?", delta, Date.now(), player_id);
      if (result.changes === 0) {
        const row = await this.db.Get<{ coins: number }>("SELECT coins FROM players WHERE player_id = ?", player_id);
        if (!row) throw new NotFoundError("Player not found.");
        throw new InsufficientError(`You need ${-delta} coins but have ${row.coins}.`, { required: -delta, available: row.coins });
      }
      const row = await this.db.Get<{ coins: number }>("SELECT coins FROM players WHERE player_id = ?", player_id);
      await this.db.Run(
        "INSERT INTO transactions (player_id, type, amount, balance_after, item_id, quantity, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        player_id, type, delta, row!.coins, extra.item_id ?? null, extra.quantity ?? null, extra.reference_id == null ? null : String(extra.reference_id), Date.now()
      );
      if (delta > 0) {
        await this.db.Run(
          "INSERT INTO player_statistics (player_id, stat_key, value) VALUES (?, 'coins_earned', ?) ON CONFLICT(player_id, stat_key) DO UPDATE SET value = value + excluded.value",
          player_id, delta
        );
      }
      return row!.coins;
    });
  }

  async AwardXp(player_id: number, base_xp: number, apply_event = true): Promise<XpResult> {
    const multiplier = apply_event ? this.event_service.Effects().xp_multiplier : 1;
    const xp_gained = Math.max(0, Math.floor(base_xp * multiplier));
    if (xp_gained === 0) {
      const row = await this.GetPlayer(player_id);
      return { xp_gained: 0, level: row.level, level_up: null, level_reward: 0 };
    }
    return this.db.Transaction(async () => {
      const row = await this.GetPlayer(player_id);
      const lifetime_xp = row.lifetime_xp + xp_gained;
      const { level } = LevelFromLifetimeXp(lifetime_xp);
      await this.db.Run("UPDATE players SET lifetime_xp = ?, level = ?, updated_at = ? WHERE player_id = ?", lifetime_xp, level, Date.now(), player_id);
      let level_reward = 0;
      if (level > row.level) {
        for (let reached = row.level + 1; reached <= level; reached++) level_reward += LevelReward(reached);
        await this.ChangeCoins(player_id, level_reward, "level_reward", { reference_id: `level_${level}` });
        await this.db.Run(
          "INSERT INTO player_statistics (player_id, stat_key, value) VALUES (?, 'level', ?) ON CONFLICT(player_id, stat_key) DO UPDATE SET value = MAX(value, excluded.value)",
          player_id, level
        );
      }
      return { xp_gained, level, level_up: level > row.level ? level : null, level_reward };
    });
  }

  async AddPlaytime(player_id: number, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    await this.db.Run("UPDATE players SET playtime_seconds = playtime_seconds + ? WHERE player_id = ?", Math.floor(seconds), player_id);
  }

  async OwnedCosmetics(player_id: number): Promise<string[]> {
    const rows = await this.db.All<{ cosmetic_key: string }>("SELECT cosmetic_key FROM player_cosmetics WHERE player_id = ?", player_id);
    return rows.map((row) => row.cosmetic_key);
  }

  async GrantCosmetic(player_id: number, cosmetic_key: string): Promise<boolean> {
    if (!COSMETICS_BY_KEY.has(cosmetic_key)) throw new NotFoundError("Unknown cosmetic.");
    const result = await this.db.Run("INSERT OR IGNORE INTO player_cosmetics (player_id, cosmetic_key, acquired_at) VALUES (?, ?, ?)", player_id, cosmetic_key, Date.now());
    return result.changes > 0;
  }

  async BuyCosmetic(player_id: number, cosmetic_key: unknown): Promise<void> {
    const cosmetic = typeof cosmetic_key === "string" ? COSMETICS_BY_KEY.get(cosmetic_key) : undefined;
    if (!cosmetic) throw new NotFoundError("Unknown cosmetic.");
    if (cosmetic.price <= 0) throw new ValidationError("That cosmetic is earned, not bought.");
    await this.db.Transaction(async () => {
      const result = await this.db.Run("INSERT OR IGNORE INTO player_cosmetics (player_id, cosmetic_key, acquired_at) VALUES (?, ?, ?)", player_id, cosmetic.cosmetic_key, Date.now());
      if (result.changes === 0) throw new ValidationError("You already own that.");
      await this.ChangeCoins(player_id, -cosmetic.price, "cosmetic_purchase", { reference_id: cosmetic.cosmetic_key });
    });
  }

  async EquipCosmetics(player_id: number, requested: unknown): Promise<Appearance> {
    if (!requested || typeof requested !== "object") throw new ValidationError("Invalid appearance.");
    const owned = new Set(await this.OwnedCosmetics(player_id));
    const row = await this.GetPlayer(player_id);
    const appearance = this.ParseAppearance(row.appearance);
    const slots: CosmeticSlot[] = ["hair", "hat", "shirt", "pants", "shoes", "accessory", "title"];
    for (const slot of slots) {
      const value = (requested as Record<string, unknown>)[slot];
      if (value === undefined) continue;
      if (value === null || value === "") {
        if (slot === "hat" || slot === "accessory") delete appearance[slot];
        continue;
      }
      const cosmetic = typeof value === "string" ? COSMETICS_BY_KEY.get(value) : undefined;
      if (!cosmetic || cosmetic.slot !== slot) throw new ValidationError(`Invalid ${slot}.`);
      if (!owned.has(cosmetic.cosmetic_key)) throw new ValidationError(`You do not own ${cosmetic.name}.`);
      appearance[slot] = cosmetic.cosmetic_key;
    }
    await this.db.Run("UPDATE players SET appearance = ?, updated_at = ? WHERE player_id = ?", JSON.stringify(appearance), Date.now(), player_id);
    return appearance;
  }

  async SaveSettings(player_id: number, settings: unknown): Promise<Record<string, unknown>> {
    if (!settings || typeof settings !== "object") throw new ValidationError("Invalid settings.");
    const clean: Record<string, unknown> = {};
    for (const key of ["master_volume", "music_volume", "sfx_volume"]) {
      const value = (settings as Record<string, unknown>)[key];
      if (typeof value === "number" && value >= 0 && value <= 1) clean[key] = value;
    }
    for (const key of ["muted", "music_enabled", "show_names"]) {
      const value = (settings as Record<string, unknown>)[key];
      if (typeof value === "boolean") clean[key] = value;
    }
    await this.db.Run("UPDATE players SET settings = ? WHERE player_id = ?", JSON.stringify(clean), player_id);
    return clean;
  }
}
