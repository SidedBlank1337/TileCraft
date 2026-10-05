import type { Database } from "../database/database.ts";
import { ACHIEVEMENTS, QUESTS, type Reward } from "../../shared/progression.ts";
import { COSMETICS_BY_KEY } from "../../shared/cosmetics.ts";
import { GetItem } from "../../shared/items.ts";
import { InsufficientError, NotFoundError, ValidationError } from "./errors.ts";
import type { PlayerHub } from "./hub.ts";
import type { InventoryService } from "./inventory_service.ts";
import type { PlayerService } from "./player_service.ts";

export interface StatChange {
  stat_key: string;
  amount?: number;
  mode?: "add" | "max";
}

export class NotificationService {
  constructor(private db: Database, private hub: PlayerHub) {}

  async Notify(player_id: number, kind: string, message: string, persist = true): Promise<void> {
    const created_at = Date.now();
    let notification_id = 0;
    if (persist) {
      const result = await this.db.Run("INSERT INTO notifications (player_id, kind, message, created_at) VALUES (?, ?, ?, ?)", player_id, kind, message.slice(0, 300), created_at);
      notification_id = result.last_id;
    }
    this.hub.Send(player_id, "notification", { notification_id, kind, message, created_at });
  }

  List(player_id: number) {
    return this.db.All("SELECT notification_id, kind, message, read_at, created_at FROM notifications WHERE player_id = ? ORDER BY notification_id DESC LIMIT 50", player_id);
  }

  async MarkRead(player_id: number): Promise<void> {
    await this.db.Run("UPDATE notifications SET read_at = ? WHERE player_id = ? AND read_at IS NULL", Date.now(), player_id);
  }
}

export class ProgressService {
  constructor(
    private db: Database,
    private player_service: PlayerService,
    private inventory_service: InventoryService,
    private notification_service: NotificationService
  ) {}

  async GetStats(player_id: number): Promise<Record<string, number>> {
    const rows = await this.db.All<{ stat_key: string; value: number }>("SELECT stat_key, value FROM player_statistics WHERE player_id = ?", player_id);
    return Object.fromEntries(rows.map((row) => [row.stat_key, row.value]));
  }

  async Track(player_id: number, changes: StatChange[]): Promise<void> {
    const unlocked = await this.db.Transaction(async () => {
      for (const change of changes) {
        const amount = Math.floor(change.amount ?? 1);
        if (amount <= 0 && change.mode !== "max") continue;
        if (change.mode === "max") {
          await this.db.Run(
            "INSERT INTO player_statistics (player_id, stat_key, value) VALUES (?, ?, ?) ON CONFLICT(player_id, stat_key) DO UPDATE SET value = MAX(value, excluded.value)",
            player_id, change.stat_key, amount
          );
        } else {
          await this.db.Run(
            "INSERT INTO player_statistics (player_id, stat_key, value) VALUES (?, ?, ?) ON CONFLICT(player_id, stat_key) DO UPDATE SET value = value + excluded.value",
            player_id, change.stat_key, amount
          );
        }
      }
      return this.CheckAchievements(player_id);
    });
    for (const name of unlocked) await this.notification_service.Notify(player_id, "achievement", `Achievement unlocked: ${name}`);
    if (unlocked.length) {
      await this.player_service.PushSelf(player_id);
      await this.inventory_service.PushInventory(player_id);
    }
  }

  // Runs inside the Track transaction; PRIMARY KEY on player_achievements makes double unlocks impossible.
  private async CheckAchievements(player_id: number): Promise<string[]> {
    const stats = await this.GetStats(player_id);
    const owned = new Set((await this.db.All<{ achievement_key: string }>("SELECT achievement_key FROM player_achievements WHERE player_id = ?", player_id)).map((row) => row.achievement_key));
    const unlocked: string[] = [];
    for (const achievement of ACHIEVEMENTS) {
      if (owned.has(achievement.achievement_key) || (stats[achievement.stat_key] ?? 0) < achievement.goal) continue;
      const result = await this.db.Run("INSERT OR IGNORE INTO player_achievements (player_id, achievement_key, unlocked_at) VALUES (?, ?, ?)", player_id, achievement.achievement_key, Date.now());
      if (result.changes === 0) continue;
      await this.GrantReward(player_id, achievement.reward, `achievement:${achievement.achievement_key}`, "achievement_reward");
      unlocked.push(achievement.name);
    }
    return unlocked;
  }

  async GrantReward(player_id: number, reward: Reward, reference_id: string, ledger_type: string): Promise<void> {
    await this.db.Transaction(async () => {
      for (const entry of reward.items ?? []) {
        const free = await this.inventory_service.FreeCapacity(player_id, entry.item_id);
        if (free < entry.quantity) throw new InsufficientError("Make room in your inventory to receive the reward.", { hint: "inventory_full" });
        await this.inventory_service.AddItem(player_id, entry.item_id, entry.quantity);
      }
      if (reward.coins) await this.player_service.ChangeCoins(player_id, reward.coins, ledger_type, { reference_id });
      if (reward.cosmetic_key) await this.player_service.GrantCosmetic(player_id, reward.cosmetic_key);
      if (reward.xp) {
        const xp = await this.player_service.AwardXp(player_id, reward.xp, false);
        if (xp.level_up) this.LevelUpNotice(player_id, xp.level_up, xp.level_reward);
      }
    });
  }

  LevelUpNotice(player_id: number, level: number, reward: number): void {
    void this.notification_service.Notify(player_id, "level_up", `Level up! You reached level ${level} (+${reward} coins).`);
  }

  async QuestBoard(player_id: number) {
    const stats = await this.GetStats(player_id);
    const claimed = new Set((await this.db.All<{ quest_key: string }>("SELECT quest_key FROM player_quests WHERE player_id = ?", player_id)).map((row) => row.quest_key));
    return QUESTS.map((quest) => ({
      ...quest,
      progress: Math.min(stats[quest.stat_key] ?? 0, quest.goal),
      completed: (stats[quest.stat_key] ?? 0) >= quest.goal,
      claimed: claimed.has(quest.quest_key),
      reward_text: RewardText(quest.reward)
    }));
  }

  async ClaimQuest(player_id: number, quest_key: unknown): Promise<{ reward: Reward }> {
    const quest = QUESTS.find((entry) => entry.quest_key === quest_key);
    if (!quest) throw new NotFoundError("Unknown quest.");
    await this.db.Transaction(async () => {
      const stats = await this.GetStats(player_id);
      if ((stats[quest.stat_key] ?? 0) < quest.goal) throw new ValidationError("That quest is not finished yet.");
      const result = await this.db.Run("INSERT OR IGNORE INTO player_quests (player_id, quest_key, claimed_at) VALUES (?, ?, ?)", player_id, quest.quest_key, Date.now());
      if (result.changes === 0) throw new ValidationError("You already claimed that quest.");
      await this.GrantReward(player_id, quest.reward, `quest:${quest.quest_key}`, "quest_reward");
    });
    await this.notification_service.Notify(player_id, "quest", `Quest complete: ${quest.name}`);
    return { reward: quest.reward };
  }

  async AchievementBoard(player_id: number) {
    const stats = await this.GetStats(player_id);
    const rows = await this.db.All<{ achievement_key: string; unlocked_at: number }>("SELECT achievement_key, unlocked_at FROM player_achievements WHERE player_id = ?", player_id);
    const unlocked = new Map(rows.map((row) => [row.achievement_key, row.unlocked_at]));
    return ACHIEVEMENTS.map((achievement) => ({
      ...achievement,
      progress: Math.min(stats[achievement.stat_key] ?? 0, achievement.goal),
      unlocked_at: unlocked.get(achievement.achievement_key) ?? null,
      reward_text: RewardText(achievement.reward)
    }));
  }
}

export function RewardText(reward: Reward): string {
  const parts: string[] = [];
  if (reward.coins) parts.push(`${reward.coins} coins`);
  if (reward.xp) parts.push(`${reward.xp} XP`);
  for (const entry of reward.items ?? []) parts.push(`${entry.quantity}x ${GetItem(entry.item_id)?.name ?? "item"}`);
  if (reward.cosmetic_key) parts.push(COSMETICS_BY_KEY.get(reward.cosmetic_key)?.name ?? reward.cosmetic_key);
  return parts.join(", ");
}
