import type { Database } from "../database/database.ts";
import { EVENTS_BY_KEY, MergeEffects, type EventEffects } from "../../shared/economy.ts";
import { NotFoundError, ValidationError } from "./errors.ts";

interface EventRow {
  event_id: number;
  event_key: string;
  starts_at: number;
  ends_at: number;
}

export class EventService {
  private active: EventRow[] = [];
  private loaded_at = 0;

  constructor(private db: Database) {}

  async Refresh(): Promise<void> {
    const now = Date.now();
    this.active = await this.db.All<EventRow>("SELECT event_id, event_key, starts_at, ends_at FROM events WHERE starts_at <= ? AND ends_at > ? ORDER BY starts_at", now, now);
    this.loaded_at = now;
  }

  // Cached for 10s so hot paths (every block hit) do not query.
  Effects(): EventEffects {
    const now = Date.now();
    if (now - this.loaded_at > 10_000) void this.Refresh();
    return MergeEffects(this.active.filter((row) => row.ends_at > now).map((row) => EVENTS_BY_KEY.get(row.event_key)?.effects ?? {}));
  }

  ActiveEvents() {
    const now = Date.now();
    return this.active
      .filter((row) => row.ends_at > now)
      .map((row) => ({ ...row, name: EVENTS_BY_KEY.get(row.event_key)?.name ?? row.event_key, description: EVENTS_BY_KEY.get(row.event_key)?.description ?? "" }));
  }

  async Start(event_key: string, duration_minutes: number, started_by: number | null): Promise<EventRow> {
    if (!EVENTS_BY_KEY.has(event_key)) throw new NotFoundError("Unknown event.");
    if (!Number.isInteger(duration_minutes) || duration_minutes < 1 || duration_minutes > 60 * 24 * 14) throw new ValidationError("Duration must be 1 minute to 14 days.");
    const now = Date.now();
    const ends_at = now + duration_minutes * 60_000;
    const result = await this.db.Run("INSERT INTO events (event_key, starts_at, ends_at, started_by, created_at) VALUES (?, ?, ?, ?, ?)", event_key, now, ends_at, started_by, now);
    await this.Refresh();
    return { event_id: result.last_id, event_key, starts_at: now, ends_at };
  }

  async Stop(event_id: number): Promise<void> {
    const now = Date.now();
    await this.db.Run("UPDATE events SET ends_at = MAX(?, starts_at + 1) WHERE event_id = ? AND ends_at > ?", now, event_id, now);
    await this.Refresh();
  }
}
