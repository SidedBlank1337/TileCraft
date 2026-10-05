import type { Database } from "../database/database.ts";
import { CHUNK_SIZE, MAX_WORLDS_PER_PLAYER, WORLD_SIZES, WORLD_TYPES, BACKGROUNDS, type WorldRole, type WorldSize, type WorldType } from "../../shared/constants.ts";
import { DEFAULT_WORLD_SETTINGS, type WorldSettings } from "../../shared/protocol.ts";
import { ValidateWorldName } from "../../shared/world_names.ts";
import { GenerateWorld } from "../game/world_generator.ts";
import { ForbiddenError, GameError, NotFoundError, ValidationError } from "./errors.ts";
import type { PlayerService } from "./player_service.ts";
import type { ProgressService, NotificationService } from "./progress_service.ts";

export interface WorldRow {
  world_id: number;
  world_name: string;
  owner_id: number;
  owner_name: string;
  width: number;
  height: number;
  seed: number;
  world_type: WorldType;
  description: string;
  background: string;
  spawn_x: number;
  spawn_y: number;
  weather: string;
  locked: number;
  player_limit: number;
  settings: string;
  total_visits: number;
  created_at: number;
  updated_at: number;
}

export interface WorldAccess {
  role: WorldRole | "none";
  can_enter: boolean;
  can_build: boolean;
  can_manage: boolean;
  can_moderate: boolean;
  reason?: string;
}

const ROLE_RANK: Record<string, number> = { banned: -1, none: 0, visitor: 1, member: 2, builder: 3, admin: 4, owner: 5 };

export function ParseSettings(raw: string): WorldSettings {
  try {
    return { ...DEFAULT_WORLD_SETTINGS, ...(JSON.parse(raw) as Partial<WorldSettings>) };
  } catch {
    return { ...DEFAULT_WORLD_SETTINGS };
  }
}

export function SplitChunks(width: number, height: number, tiles: Uint16Array, chunk_x: number, chunk_y: number): Buffer {
  const out = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let y = 0; y < CHUNK_SIZE; y++) {
    const world_y = chunk_y * CHUNK_SIZE + y;
    if (world_y >= height) break;
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const world_x = chunk_x * CHUNK_SIZE + x;
      if (world_x >= width) break;
      out[y * CHUNK_SIZE + x] = tiles[world_y * width + world_x];
    }
  }
  return Buffer.from(out.buffer);
}

function MergeChunk(width: number, height: number, tiles: Uint16Array, chunk_x: number, chunk_y: number, blob: Buffer): void {
  const data = new Uint16Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  for (let y = 0; y < CHUNK_SIZE; y++) {
    const world_y = chunk_y * CHUNK_SIZE + y;
    if (world_y >= height) break;
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const world_x = chunk_x * CHUNK_SIZE + x;
      if (world_x >= width) break;
      tiles[world_y * width + world_x] = data[y * CHUNK_SIZE + x] ?? 0;
    }
  }
}

const WORLD_SELECT = `SELECT w.*, u.username AS owner_name FROM worlds w JOIN users u ON u.user_id = w.owner_id`;

export class WorldService {
  live_counts: (world_id: number) => number = () => 0;

  constructor(
    private db: Database,
    private player_service: PlayerService,
    private progress_service: ProgressService,
    private notification_service: NotificationService
  ) {}

  async CreateWorld(owner_id: number, input: Record<string, unknown>): Promise<WorldRow> {
    const name_check = ValidateWorldName(typeof input.world_name === "string" ? input.world_name : "");
    if (!name_check.ok) throw new ValidationError(name_check.error, { field: "world_name" });
    const world_type = input.world_type as WorldType;
    if (!WORLD_TYPES.includes(world_type)) throw new ValidationError("Pick a valid world type.", { field: "world_type" });
    const world_size = (input.world_size ?? "medium") as WorldSize;
    if (!(world_size in WORLD_SIZES)) throw new ValidationError("Pick a valid world size.", { field: "world_size" });
    const description = typeof input.description === "string" ? input.description.trim().slice(0, 200) : "";
    let seed: number;
    if (input.seed === undefined || input.seed === null || input.seed === "") seed = Math.floor(Math.random() * 2_000_000_000);
    else {
      const parsed = typeof input.seed === "number" ? input.seed : Number(input.seed);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_000_000_000) throw new ValidationError("Seed must be a whole number from 0 to 2,000,000,000.", { field: "seed" });
      seed = parsed;
    }

    const { width, height } = WORLD_SIZES[world_size];
    const generated = GenerateWorld(width, height, seed, world_type);
    const settings: WorldSettings = { ...DEFAULT_WORLD_SETTINGS, members_can_build: world_type !== "trading" };
    const world_id = await this.db.Transaction(async () => {
      const owned = await this.db.Get<{ count: number }>("SELECT COUNT(*) AS count FROM worlds WHERE owner_id = ?", owner_id);
      if ((owned?.count ?? 0) >= MAX_WORLDS_PER_PLAYER) throw new GameError("world_limit", `You can own at most ${MAX_WORLDS_PER_PLAYER} worlds.`, 409);
      if (await this.db.Get("SELECT 1 FROM worlds WHERE world_name = ?", name_check.name)) throw new GameError("world_taken", "A world with that name already exists.", 409, { field: "world_name" });
      const now = Date.now();
      const result = await this.db.Run(
        `INSERT INTO worlds (world_name, owner_id, width, height, seed, world_type, description, background, spawn_x, spawn_y, player_limit, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        name_check.name, owner_id, width, height, seed, world_type, description, world_type === "adventure" ? "dusk" : "noon",
        generated.spawn_x, generated.spawn_y, world_type === "private" ? 10 : 30, JSON.stringify(settings), now, now
      );
      await this.SaveChunks(result.last_id, width, height, generated.foreground, generated.background, null);
      return result.last_id;
    });
    await this.progress_service.Track(owner_id, [{ stat_key: "worlds_created" }]);
    return this.GetWorldById(world_id);
  }

  async SaveChunks(world_id: number, width: number, height: number, foreground: Uint16Array, background: Uint16Array, dirty: Set<string> | null): Promise<void> {
    await this.db.Transaction(async () => {
      const now = Date.now();
      for (let chunk_y = 0; chunk_y < Math.ceil(height / CHUNK_SIZE); chunk_y++) {
        for (let chunk_x = 0; chunk_x < Math.ceil(width / CHUNK_SIZE); chunk_x++) {
          if (dirty && !dirty.has(`${chunk_x},${chunk_y}`)) continue;
          await this.db.Run(
            `INSERT INTO world_chunks (world_id, chunk_x, chunk_y, foreground, background, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(world_id, chunk_x, chunk_y) DO UPDATE SET foreground = excluded.foreground, background = excluded.background, updated_at = excluded.updated_at`,
            world_id, chunk_x, chunk_y, SplitChunks(width, height, foreground, chunk_x, chunk_y), SplitChunks(width, height, background, chunk_x, chunk_y), now
          );
        }
      }
      await this.db.Run("UPDATE worlds SET updated_at = ? WHERE world_id = ?", now, world_id);
    });
  }

  async LoadTiles(world: WorldRow): Promise<{ foreground: Uint16Array; background: Uint16Array }> {
    const foreground = new Uint16Array(world.width * world.height);
    const background = new Uint16Array(world.width * world.height);
    const rows = await this.db.All<{ chunk_x: number; chunk_y: number; foreground: Buffer; background: Buffer }>(
      "SELECT chunk_x, chunk_y, foreground, background FROM world_chunks WHERE world_id = ?", world.world_id
    );
    if (rows.length === 0) throw new GameError("world_corrupt", "World data is missing.", 500);
    for (const row of rows) {
      MergeChunk(world.width, world.height, foreground, row.chunk_x, row.chunk_y, row.foreground);
      MergeChunk(world.width, world.height, background, row.chunk_x, row.chunk_y, row.background);
    }
    return { foreground, background };
  }

  async GetWorldById(world_id: number): Promise<WorldRow> {
    const row = await this.db.Get<WorldRow>(`${WORLD_SELECT} WHERE w.world_id = ?`, world_id);
    if (!row) throw new NotFoundError("World not found.");
    return row;
  }

  async GetWorldByName(raw_name: unknown): Promise<WorldRow> {
    const check = ValidateWorldName(typeof raw_name === "string" ? raw_name : "");
    if (!check.ok) throw new NotFoundError("World not found.");
    const row = await this.db.Get<WorldRow>(`${WORLD_SELECT} WHERE w.world_name = ?`, check.name);
    if (!row) throw new NotFoundError(`World ${check.name} does not exist.`);
    return row;
  }

  async GetAccess(world: WorldRow, player_id: number, is_site_admin: boolean): Promise<WorldAccess> {
    const settings = ParseSettings(world.settings);
    let role: WorldAccess["role"];
    if (world.owner_id === player_id) role = "owner";
    else {
      const permission = await this.db.Get<{ role: WorldRole }>("SELECT role FROM world_permissions WHERE world_id = ? AND player_id = ?", world.world_id, player_id);
      if (permission) role = permission.role;
      else if (world.world_type === "private") {
        const invite = await this.db.Get("SELECT 1 FROM world_invitations WHERE world_id = ? AND invitee_id = ? AND status IN ('pending','accepted')", world.world_id, player_id);
        role = invite ? "visitor" : "none";
      } else role = "visitor";
    }
    if (is_site_admin && role !== "owner") role = "admin";
    const rank = ROLE_RANK[role];
    const can_enter = role !== "banned" && role !== "none" && (world.locked === 0 || rank >= ROLE_RANK.builder);
    const can_build =
      rank >= ROLE_RANK.builder ||
      (role === "member" && settings.members_can_build) ||
      (role === "visitor" && settings.visitors_can_build && world.locked === 0);
    let reason: string | undefined;
    if (role === "banned") reason = "You are banned from this world.";
    else if (role === "none") reason = "This world is private. Ask the owner for an invitation.";
    else if (!can_enter) reason = "This world is locked.";
    return { role, can_enter, can_build, can_manage: rank >= ROLE_RANK.admin, can_moderate: rank >= ROLE_RANK.admin, reason };
  }

  private async RequireManager(world_id: number, actor_id: number, is_site_admin: boolean, owner_only = false): Promise<{ world: WorldRow; access: WorldAccess }> {
    const world = await this.GetWorldById(world_id);
    const access = await this.GetAccess(world, actor_id, is_site_admin);
    if (owner_only ? access.role !== "owner" && !is_site_admin : !access.can_manage) throw new ForbiddenError("Only the world owner or its admins can do that.");
    return { world, access };
  }

  async UpdateWorld(actor_id: number, is_site_admin: boolean, world_id: number, patch: Record<string, unknown>): Promise<WorldRow> {
    const { world, access } = await this.RequireManager(world_id, actor_id, is_site_admin);
    const updates: Record<string, unknown> = {};
    if (patch.world_name !== undefined) {
      if (access.role !== "owner" && !is_site_admin) throw new ForbiddenError("Only the owner can rename the world.");
      const check = ValidateWorldName(String(patch.world_name));
      if (!check.ok) throw new ValidationError(check.error, { field: "world_name" });
      if (check.name !== world.world_name) {
        if (await this.db.Get("SELECT 1 FROM worlds WHERE world_name = ?", check.name)) throw new GameError("world_taken", "A world with that name already exists.", 409);
        updates.world_name = check.name;
      }
    }
    if (patch.description !== undefined) updates.description = String(patch.description).trim().slice(0, 200);
    if (patch.world_type !== undefined) {
      if (!WORLD_TYPES.includes(patch.world_type as WorldType)) throw new ValidationError("Invalid world type.");
      updates.world_type = patch.world_type;
    }
    if (patch.locked !== undefined) updates.locked = patch.locked === true ? 1 : 0;
    if (patch.player_limit !== undefined) {
      const limit = Number(patch.player_limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("Player limit must be 1-100.");
      updates.player_limit = limit;
    }
    if (patch.background !== undefined) {
      if (!BACKGROUNDS.includes(patch.background as (typeof BACKGROUNDS)[number])) throw new ValidationError("Invalid background.");
      updates.background = patch.background;
    }
    if (patch.settings !== undefined) {
      if (!patch.settings || typeof patch.settings !== "object") throw new ValidationError("Invalid settings.");
      const current = ParseSettings(world.settings);
      for (const key of Object.keys(DEFAULT_WORLD_SETTINGS) as (keyof WorldSettings)[]) {
        const value = (patch.settings as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (typeof value !== "boolean") throw new ValidationError(`Setting ${key} must be true or false.`);
        current[key] = value;
      }
      updates.settings = JSON.stringify(current);
    }
    if (patch.reset_settings === true) updates.settings = JSON.stringify(DEFAULT_WORLD_SETTINGS);
    const keys = Object.keys(updates);
    if (keys.length > 0) {
      await this.db.Run(
        `UPDATE worlds SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE world_id = ?`,
        ...keys.map((key) => updates[key]), Date.now(), world_id
      );
    }
    return this.GetWorldById(world_id);
  }

  async SetSpawn(world_id: number, x: number, y: number): Promise<void> {
    await this.db.Run("UPDATE worlds SET spawn_x = ?, spawn_y = ?, updated_at = ? WHERE world_id = ?", x, y, Date.now(), world_id);
  }

  async SetPermission(actor_id: number, is_site_admin: boolean, world_id: number, username: unknown, role: unknown): Promise<{ player_id: number; role: string }> {
    const { world, access } = await this.RequireManager(world_id, actor_id, is_site_admin);
    const target = await this.player_service.FindByUsername(String(username ?? ""));
    if (!target) throw new NotFoundError("No player with that name.");
    if (target.user_id === world.owner_id) throw new ValidationError("The owner's role cannot change.");
    if (target.user_id === actor_id) throw new ValidationError("You cannot change your own role.");
    const valid_roles = ["admin", "builder", "member", "banned", "visitor"];
    if (typeof role !== "string" || !valid_roles.includes(role)) throw new ValidationError("Invalid role.");
    const current = await this.db.Get<{ role: string }>("SELECT role FROM world_permissions WHERE world_id = ? AND player_id = ?", world_id, target.user_id);
    const is_owner = access.role === "owner" || is_site_admin;
    if (!is_owner && (role === "admin" || current?.role === "admin")) throw new ForbiddenError("Only the owner can manage world admins.");
    if (role === "visitor") await this.db.Run("DELETE FROM world_permissions WHERE world_id = ? AND player_id = ?", world_id, target.user_id);
    else {
      await this.db.Run(
        `INSERT INTO world_permissions (world_id, player_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(world_id, player_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`,
        world_id, target.user_id, role, actor_id, Date.now()
      );
    }
    if (role === "banned") await this.db.Run("UPDATE world_invitations SET status = 'revoked' WHERE world_id = ? AND invitee_id = ?", world_id, target.user_id);
    return { player_id: target.user_id, role };
  }

  ListPermissions(world_id: number) {
    return this.db.All(
      `SELECT p.player_id, u.username, p.role, p.created_at FROM world_permissions p JOIN users u ON u.user_id = p.player_id WHERE p.world_id = ? ORDER BY p.role, u.username`,
      world_id
    );
  }

  async PermissionsFor(actor_id: number, is_site_admin: boolean, world_id: number) {
    await this.RequireManager(world_id, actor_id, is_site_admin);
    return { permissions: await this.ListPermissions(world_id), invitations: await this.db.All(
      `SELECT i.invitation_id, u.username, i.status, i.created_at FROM world_invitations i JOIN users u ON u.user_id = i.invitee_id WHERE i.world_id = ? ORDER BY i.created_at DESC`, world_id
    ) };
  }

  async Invite(actor_id: number, is_site_admin: boolean, world_id: number, username: unknown): Promise<void> {
    const { world } = await this.RequireManager(world_id, actor_id, is_site_admin);
    const target = await this.player_service.FindByUsername(String(username ?? ""));
    if (!target) throw new NotFoundError("No player with that name.");
    if (target.user_id === world.owner_id) throw new ValidationError("The owner does not need an invitation.");
    await this.db.Run(
      `INSERT INTO world_invitations (world_id, inviter_id, invitee_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT(world_id, invitee_id) DO UPDATE SET status = 'pending', inviter_id = excluded.inviter_id, created_at = excluded.created_at`,
      world_id, actor_id, target.user_id, Date.now()
    );
    await this.db.Run("DELETE FROM world_permissions WHERE world_id = ? AND player_id = ? AND role = 'banned'", world_id, target.user_id);
    await this.notification_service.Notify(target.user_id, "world_invite", `You were invited to ${world.world_name}.`);
  }

  async RevokeInvite(actor_id: number, is_site_admin: boolean, world_id: number, invitation_id: number): Promise<void> {
    await this.RequireManager(world_id, actor_id, is_site_admin);
    await this.db.Run("UPDATE world_invitations SET status = 'revoked' WHERE invitation_id = ? AND world_id = ?", invitation_id, world_id);
  }

  async RespondInvite(player_id: number, invitation_id: number, accept: boolean): Promise<void> {
    await this.db.Transaction(async () => {
      const invite = await this.db.Get<{ world_id: number }>("SELECT world_id FROM world_invitations WHERE invitation_id = ? AND invitee_id = ? AND status = 'pending'", invitation_id, player_id);
      if (!invite) throw new NotFoundError("Invitation not found.");
      await this.db.Run("UPDATE world_invitations SET status = ? WHERE invitation_id = ?", accept ? "accepted" : "declined", invitation_id);
      if (accept) {
        await this.db.Run("INSERT OR IGNORE INTO world_permissions (world_id, player_id, role, created_at) VALUES (?, ?, 'member', ?)", invite.world_id, player_id, Date.now());
      }
    });
  }

  MyInvitations(player_id: number) {
    return this.db.All(
      `SELECT i.invitation_id, w.world_name, u.username AS inviter_name, i.created_at FROM world_invitations i
       JOIN worlds w ON w.world_id = i.world_id JOIN users u ON u.user_id = i.inviter_id WHERE i.invitee_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
      player_id
    );
  }

  async DeleteWorld(actor_id: number, is_site_admin: boolean, world_id: number, confirm_name: unknown): Promise<void> {
    const { world } = await this.RequireManager(world_id, actor_id, is_site_admin, true);
    if (confirm_name !== world.world_name) throw new ValidationError("Type the world name exactly to confirm deletion.");
    await this.db.Transaction(async () => {
      // Drops are destroyed with the world; marketplace and inventory are unaffected.
      await this.db.Run("DELETE FROM worlds WHERE world_id = ?", world_id);
    });
  }

  async RecordVisit(world_id: number, player_id: number): Promise<boolean> {
    const now = Date.now();
    const existing = await this.db.Get("SELECT 1 FROM world_visits WHERE world_id = ? AND player_id = ?", world_id, player_id);
    await this.db.Run(
      `INSERT INTO world_visits (world_id, player_id, visit_count, last_visited_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(world_id, player_id) DO UPDATE SET visit_count = visit_count + 1, last_visited_at = excluded.last_visited_at`,
      world_id, player_id, now
    );
    await this.db.Run("UPDATE worlds SET total_visits = total_visits + 1 WHERE world_id = ?", world_id);
    return !existing;
  }

  async ToggleFavorite(player_id: number, world_id: number): Promise<boolean> {
    await this.GetWorldById(world_id);
    const removed = await this.db.Run("DELETE FROM world_favorites WHERE world_id = ? AND player_id = ?", world_id, player_id);
    if (removed.changes > 0) return false;
    await this.db.Run("INSERT INTO world_favorites (world_id, player_id, created_at) VALUES (?, ?, ?)", world_id, player_id, Date.now());
    return true;
  }

  private Present(row: WorldRow & { last_visited_at?: number; favorite?: number }) {
    return {
      world_id: row.world_id,
      world_name: row.world_name,
      owner_name: row.owner_name,
      world_type: row.world_type,
      description: row.description,
      width: row.width,
      height: row.height,
      current_players: this.live_counts(row.world_id),
      player_limit: row.player_limit,
      total_visits: row.total_visits,
      locked: row.locked === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_visited_at: row.last_visited_at ?? null,
      favorite: row.favorite === 1
    };
  }

  async Browse(player_id: number, query: { search?: unknown; filter?: unknown; world_type?: unknown }) {
    const search = typeof query.search === "string" ? query.search.trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 16) : "";
    const filter = typeof query.filter === "string" ? query.filter : "public";
    let sql = `SELECT w.*, u.username AS owner_name, v.last_visited_at, CASE WHEN f.player_id IS NULL THEN 0 ELSE 1 END AS favorite
      FROM worlds w JOIN users u ON u.user_id = w.owner_id
      LEFT JOIN world_visits v ON v.world_id = w.world_id AND v.player_id = ?1
      LEFT JOIN world_favorites f ON f.world_id = w.world_id AND f.player_id = ?1 WHERE 1 = 1`;
    const named: unknown[] = [player_id];
    if (filter === "mine") sql += " AND w.owner_id = ?1";
    else if (filter === "favorites") sql += " AND f.player_id IS NOT NULL";
    else if (filter === "recent") sql += " AND v.player_id IS NOT NULL";
    else sql += ` AND (w.world_type <> 'private' OR w.owner_id = ?1 OR EXISTS (SELECT 1 FROM world_permissions p WHERE p.world_id = w.world_id AND p.player_id = ?1 AND p.role <> 'banned'))`;
    if (search) {
      sql += " AND w.world_name LIKE ?2";
      named.push(`%${search}%`);
    }
    if (typeof query.world_type === "string" && WORLD_TYPES.includes(query.world_type as WorldType)) {
      sql += ` AND w.world_type = ?${named.length + 1}`;
      named.push(query.world_type);
    }
    sql += filter === "recent" ? " ORDER BY v.last_visited_at DESC" : " ORDER BY w.total_visits DESC, w.created_at DESC";
    sql += " LIMIT 60";
    const rows = await this.db.All<WorldRow & { last_visited_at?: number; favorite?: number }>(sql, ...named);
    const list = rows.map((row) => this.Present(row));
    if (filter === "public" || filter === "popular") list.sort((a, b) => b.current_players - a.current_players || b.total_visits - a.total_visits);
    return list;
  }

  async WorldInfo(world_id: number) {
    return this.Present(await this.GetWorldById(world_id));
  }
}
