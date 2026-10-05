import type { Database } from "../database/database.ts";
import { CHAT_MAX_LENGTH } from "../../shared/constants.ts";
import { TRIVIA_QUESTIONS } from "../../shared/economy.ts";
import { GameError, NotFoundError, RateLimitError, ValidationError } from "./errors.ts";
import type { PlayerHub } from "./hub.ts";
import type { PlayerService } from "./player_service.ts";
import type { NotificationService, ProgressService } from "./progress_service.ts";

export function SanitizeChat(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("Message must be text.");
  const text = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
  if (!text) throw new ValidationError("Message is empty.");
  if (text.length > CHAT_MAX_LENGTH) throw new ValidationError(`Messages are limited to ${CHAT_MAX_LENGTH} characters.`);
  return text;
}

export class ChatService {
  private block_cache = new Map<number, Set<number>>();

  constructor(private db: Database) {}

  async AssertNotMuted(player_id: number): Promise<void> {
    const row = await this.db.Get<{ muted_until: number | null }>("SELECT muted_until FROM users WHERE user_id = ?", player_id);
    if (row?.muted_until && row.muted_until > Date.now()) throw new GameError("muted", `You are muted until ${new Date(row.muted_until).toUTCString()}.`, 403);
  }

  async Save(channel: "world" | "global" | "private", sender_id: number, body: string, world_id: number | null, recipient_id: number | null): Promise<number> {
    const result = await this.db.Run(
      "INSERT INTO chat_messages (channel, world_id, sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      channel, world_id, sender_id, recipient_id, body, Date.now()
    );
    return result.last_id;
  }

  async History(player_id: number, world_id: number | null) {
    const world = world_id
      ? await this.db.All(`SELECT m.message_id, m.channel, m.body, m.created_at, u.username AS sender_name, m.sender_id FROM chat_messages m JOIN users u ON u.user_id = m.sender_id
          WHERE m.channel = 'world' AND m.world_id = ? ORDER BY m.message_id DESC LIMIT 30`, world_id)
      : [];
    const global = await this.db.All(`SELECT m.message_id, m.channel, m.body, m.created_at, u.username AS sender_name, m.sender_id FROM chat_messages m JOIN users u ON u.user_id = m.sender_id
      WHERE m.channel = 'global' ORDER BY m.message_id DESC LIMIT 30`);
    const private_messages = await this.db.All(`SELECT m.message_id, m.channel, m.body, m.created_at, u.username AS sender_name, m.sender_id, r.username AS recipient_name FROM chat_messages m
      JOIN users u ON u.user_id = m.sender_id JOIN users r ON r.user_id = m.recipient_id
      WHERE m.channel = 'private' AND (m.sender_id = ? OR m.recipient_id = ?) ORDER BY m.message_id DESC LIMIT 30`, player_id, player_id);
    const blocked = await this.BlockedSet(player_id);
    return [...world, ...global, ...private_messages]
      .filter((row) => !blocked.has(Number((row as { sender_id: number }).sender_id)))
      .sort((a, b) => Number((a as { created_at: number }).created_at) - Number((b as { created_at: number }).created_at));
  }

  async BlockedSet(player_id: number): Promise<Set<number>> {
    const cached = this.block_cache.get(player_id);
    if (cached) return cached;
    const rows = await this.db.All<{ blocked_id: number }>("SELECT blocked_id FROM player_blocks WHERE blocker_id = ?", player_id);
    const set = new Set(rows.map((row) => row.blocked_id));
    this.block_cache.set(player_id, set);
    return set;
  }

  async SetBlocked(player_id: number, target_id: number, blocked: boolean): Promise<void> {
    if (player_id === target_id) throw new ValidationError("You cannot block yourself.");
    if (blocked) await this.db.Run("INSERT OR IGNORE INTO player_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)", player_id, target_id, Date.now());
    else await this.db.Run("DELETE FROM player_blocks WHERE blocker_id = ? AND blocked_id = ?", player_id, target_id);
    this.block_cache.delete(player_id);
  }

  ListBlocked(player_id: number) {
    return this.db.All("SELECT b.blocked_id AS player_id, u.username FROM player_blocks b JOIN users u ON u.user_id = b.blocked_id WHERE b.blocker_id = ?", player_id);
  }

  async Report(reporter_id: number, target_id: number, reason: unknown, context: unknown): Promise<void> {
    if (reporter_id === target_id) throw new ValidationError("You cannot report yourself.");
    const text = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
    if (text.length < 3) throw new ValidationError("Give a short reason.");
    const recent = await this.db.Get<{ count: number }>("SELECT COUNT(*) AS count FROM reports WHERE reporter_id = ? AND created_at > ?", reporter_id, Date.now() - 3600_000);
    if ((recent?.count ?? 0) >= 10) throw new RateLimitError("You have sent too many reports recently.");
    await this.db.Run("INSERT INTO reports (reporter_id, target_id, reason, context, created_at) VALUES (?, ?, ?, ?, ?)", reporter_id, target_id, text, typeof context === "string" ? context.slice(0, 500) : null, Date.now());
  }
}

export class FriendService {
  constructor(private db: Database, private hub: PlayerHub, private notification_service: NotificationService, private progress_service: ProgressService) {}

  async Request(player_id: number, target_id: number): Promise<"sent" | "accepted"> {
    if (player_id === target_id) throw new ValidationError("You cannot friend yourself.");
    const reverse = await this.db.Get<{ status: string }>("SELECT status FROM friends WHERE requester_id = ? AND addressee_id = ?", target_id, player_id);
    if (reverse?.status === "accepted") throw new ValidationError("You are already friends.");
    if (reverse?.status === "pending") {
      await this.Respond(player_id, target_id, true);
      return "accepted";
    }
    const result = await this.db.Run("INSERT OR IGNORE INTO friends (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)", player_id, target_id, Date.now());
    if (result.changes === 0) throw new ValidationError("Request already sent.");
    const sender = await this.db.Get<{ username: string }>("SELECT username FROM users WHERE user_id = ?", player_id);
    await this.notification_service.Notify(target_id, "friend_request", `${sender?.username} sent you a friend request.`);
    return "sent";
  }

  async Respond(player_id: number, requester_id: number, accept: boolean): Promise<void> {
    await this.db.Transaction(async () => {
      if (!accept) {
        const result = await this.db.Run("DELETE FROM friends WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'", requester_id, player_id);
        if (result.changes === 0) throw new NotFoundError("No pending request.");
        return;
      }
      const result = await this.db.Run("UPDATE friends SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'", requester_id, player_id);
      if (result.changes === 0) throw new NotFoundError("No pending request.");
    });
    if (accept) {
      await this.progress_service.Track(player_id, [{ stat_key: "friends_made" }]);
      await this.progress_service.Track(requester_id, [{ stat_key: "friends_made" }]);
      const me = await this.db.Get<{ username: string }>("SELECT username FROM users WHERE user_id = ?", player_id);
      await this.notification_service.Notify(requester_id, "friend_accept", `${me?.username} accepted your friend request.`);
    }
  }

  async Remove(player_id: number, friend_id: number): Promise<void> {
    await this.db.Run("DELETE FROM friends WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)", player_id, friend_id, friend_id, player_id);
  }

  async AreFriends(a: number, b: number): Promise<boolean> {
    return !!(await this.db.Get("SELECT 1 FROM friends WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))", a, b, b, a));
  }

  // Only public profile fields; never email or account data.
  async List(player_id: number, current_world_of: (player_id: number) => string | null) {
    const rows = await this.db.All<{ player_id: number; username: string; status: string; direction: string; level: number }>(
      `SELECT u.user_id AS player_id, u.username, f.status, CASE WHEN f.requester_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction, p.level
       FROM friends f JOIN users u ON u.user_id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       JOIN players p ON p.player_id = u.user_id
       WHERE f.requester_id = ? OR f.addressee_id = ? ORDER BY u.username`,
      player_id, player_id, player_id, player_id
    );
    return rows.map((row) => ({
      ...row,
      online: row.status === "accepted" && this.hub.IsOnline(row.player_id),
      current_world: row.status === "accepted" ? current_world_of(row.player_id) : null
    }));
  }
}

export class ActivityService {
  private pending_trivia = new Map<number, { question_index: number; asked_at: number }>();
  private trivia_cooldown = new Map<number, number>();

  constructor(private player_service: PlayerService, private progress_service: ProgressService) {}

  TriviaQuestion(player_id: number) {
    const ready_at = this.trivia_cooldown.get(player_id) ?? 0;
    if (ready_at > Date.now()) throw new GameError("cooldown", `Next trivia question in ${Math.ceil((ready_at - Date.now()) / 1000)}s.`, 429);
    const question_index = Math.floor(Math.random() * TRIVIA_QUESTIONS.length);
    this.pending_trivia.set(player_id, { question_index, asked_at: Date.now() });
    const question = TRIVIA_QUESTIONS[question_index];
    return { question: question.question, answers: question.answers };
  }

  // The pending question is consumed before rewarding, so replays get nothing.
  async TriviaAnswer(player_id: number, answer_index: unknown) {
    const pending = this.pending_trivia.get(player_id);
    if (!pending) throw new ValidationError("Ask for a question first.");
    this.pending_trivia.delete(player_id);
    this.trivia_cooldown.set(player_id, Date.now() + 30_000);
    if (Date.now() - pending.asked_at > 60_000) return { correct: false, correct_index: TRIVIA_QUESTIONS[pending.question_index].correct_index, coins: 0, expired: true };
    const question = TRIVIA_QUESTIONS[pending.question_index];
    const correct = answer_index === question.correct_index;
    let coins = 0;
    if (correct) {
      coins = 40;
      await this.player_service.ChangeCoins(player_id, coins, "trivia_reward");
      const xp = await this.player_service.AwardXp(player_id, 30);
      if (xp.level_up) this.progress_service.LevelUpNotice(player_id, xp.level_up, xp.level_reward);
      await this.progress_service.Track(player_id, [{ stat_key: "trivia_correct" }]);
    }
    return { correct, correct_index: question.correct_index, coins, expired: false };
  }
}
