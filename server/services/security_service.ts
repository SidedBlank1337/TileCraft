import type { Database } from "../database/database.ts";
import { CreateLogger } from "../logging/logger.ts";

const log = CreateLogger("security");

export class SecurityService {
  constructor(private db: Database) {}

  // Never pass credentials or tokens in details; the logger scrubs keys but the DB row does not.
  async Record(player_id: number | null, kind: string, details: Record<string, unknown> = {}, ip: string | null = null): Promise<void> {
    log.Warn(kind, { player_id, ...details });
    await this.db.Run(
      "INSERT INTO security_logs (player_id, kind, details, ip, created_at) VALUES (?, ?, ?, ?, ?)",
      player_id, kind, JSON.stringify(details).slice(0, 2000), ip, Date.now()
    ).catch((error) => log.Error("security log write failed", { error: String(error) }));
  }

  List(limit = 100, player_id?: number) {
    if (player_id) return this.db.All("SELECT * FROM security_logs WHERE player_id = ? ORDER BY security_log_id DESC LIMIT ?", player_id, limit);
    return this.db.All("SELECT * FROM security_logs ORDER BY security_log_id DESC LIMIT ?", limit);
  }
}

// Sliding-window counter keyed by any string (ip, player, player+action).
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private limit: number, private window_ms: number) {}

  Allow(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((time) => now - time < this.window_ms);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  Sweep(): void {
    const now = Date.now();
    for (const [key, list] of this.hits) {
      if (list.every((time) => now - time >= this.window_ms)) this.hits.delete(key);
    }
  }
}
