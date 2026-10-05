import crypto from "node:crypto";
import type { Database } from "../database/database.ts";
import { DROP_PICKUP_RANGE_TILES, INTERACT_RANGE_TILES, MIN_HIT_INTERVAL_MS, PLACE_COOLDOWN_MS, TILE_SIZE } from "../../shared/constants.ts";
import { AIR_ID, GetItem, HitsToBreak, TreeStage } from "../../shared/items.ts";
import type { Appearance } from "../../shared/cosmetics.ts";
import { PLAYER_HEIGHT, PLAYER_WIDTH, MOVE_SPEED, JUMP_VELOCITY, MAX_FALL_SPEED } from "../../shared/physics.ts";
import { EncodeTiles, type DropView, type PublicPlayer, type TreeView, type WorldSettings } from "../../shared/protocol.ts";
import { CreateLogger } from "../logging/logger.ts";
import { GameError, ValidationError } from "../services/errors.ts";
import type { Services } from "../service_container.ts";
import { ParseSettings, type WorldAccess, type WorldRow } from "../services/world_service.ts";

const log = CreateLogger("world");
const MAX_DROPS_PER_WORLD = 400;
const UNLOAD_IDLE_MS = 120_000;

export interface GameClient {
  player_id: number;
  username: string;
  is_admin: boolean;
  is_guest: boolean;
  appearance: Appearance;
  level: number;
  Send(event: string, data: unknown): void;
  world: LiveWorld | null;
  access: WorldAccess | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  anim: string;
  moved: boolean;
  last_move_at: number;
  last_grounded_y: number;
  last_hit_at: number;
  last_place_at: number;
  joined_at: number;
  violations: number;
  fishing_until: number;
  busy: boolean;
}

interface TreeRecord {
  x: number;
  y: number;
  item_id: number;
  planted_at: number;
  grow_ms: number;
}

interface HitProgress {
  hits: number;
  last_hit_at: number;
}

export class LiveWorld {
  row: WorldRow;
  settings: WorldSettings;
  foreground: Uint16Array;
  background: Uint16Array;
  trees = new Map<number, TreeRecord>();
  drops = new Map<string, DropView & { created_at: number }>();
  players = new Map<number, GameClient>();
  dirty_chunks = new Set<string>();
  hit_progress = new Map<number, HitProgress>();
  empty_since = Date.now();

  constructor(row: WorldRow, foreground: Uint16Array, background: Uint16Array) {
    this.row = row;
    this.settings = ParseSettings(row.settings);
    this.foreground = foreground;
    this.background = background;
  }

  get width() { return this.row.width; }
  get height() { return this.row.height; }

  Index(x: number, y: number): number {
    return y * this.row.width + x;
  }

  InBounds(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.row.width && y < this.row.height;
  }

  IsSolid = (x: number, y: number): boolean => {
    if (x < 0 || x >= this.row.width || y >= this.row.height) return true;
    if (y < 0) return false;
    return GetItem(this.foreground[this.Index(x, y)])?.collision ?? false;
  };

  SetTile(x: number, y: number, layer: "foreground" | "background", item_id: number): void {
    this[layer][this.Index(x, y)] = item_id;
    this.dirty_chunks.add(`${Math.floor(x / 32)},${Math.floor(y / 32)}`);
  }

  Broadcast(event: string, data: unknown, except_id?: number): void {
    for (const client of this.players.values()) if (client.player_id !== except_id) client.Send(event, data);
  }

  SpawnPixel(): { x: number; y: number } {
    return { x: this.row.spawn_x * TILE_SIZE + (TILE_SIZE - PLAYER_WIDTH) / 2, y: (this.row.spawn_y + 1) * TILE_SIZE - PLAYER_HEIGHT };
  }
}

export function PublicPlayerView(client: GameClient): PublicPlayer {
  return {
    player_id: client.player_id, username: client.username, x: client.x, y: client.y, facing: client.facing,
    anim: client.anim, level: client.level, appearance: client.appearance, role: client.access?.role ?? "visitor"
  };
}

function RandomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function IsFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export class WorldManager {
  worlds = new Map<number, LiveWorld>();
  private loading = new Map<number, Promise<LiveWorld>>();

  constructor(private db: Database, private services: Services) {}

  LiveCount(world_id: number): number {
    return this.worlds.get(world_id)?.players.size ?? 0;
  }

  CurrentWorldName(player_id: number): string | null {
    for (const world of this.worlds.values()) if (world.players.has(player_id)) return world.row.world_name;
    return null;
  }

  FindClient(player_id: number): GameClient | undefined {
    for (const world of this.worlds.values()) {
      const client = world.players.get(player_id);
      if (client) return client;
    }
    return undefined;
  }

  private async Load(world_id: number): Promise<LiveWorld> {
    const existing = this.worlds.get(world_id);
    if (existing) return existing;
    const pending = this.loading.get(world_id);
    if (pending) return pending;
    const promise = (async () => {
      const row = await this.services.world_service.GetWorldById(world_id);
      const tiles = await this.services.world_service.LoadTiles(row);
      const world = new LiveWorld(row, tiles.foreground, tiles.background);
      const trees = await this.db.All<TreeRecord>("SELECT x, y, item_id, planted_at, grow_ms FROM trees WHERE world_id = ?", world_id);
      for (const tree of trees) world.trees.set(world.Index(tree.x, tree.y), tree);
      const drops = await this.db.All<DropView & { created_at: number }>("SELECT drop_id, item_id, quantity, x, y, created_at FROM item_drops WHERE world_id = ?", world_id);
      for (const drop of drops) world.drops.set(drop.drop_id, drop);
      this.worlds.set(world_id, world);
      log.Info("world loaded", { world_id, world_name: row.world_name, trees: trees.length, drops: drops.length });
      return world;
    })();
    this.loading.set(world_id, promise);
    try {
      return await promise;
    } finally {
      this.loading.delete(world_id);
    }
  }

  async Join(client: GameClient, world_name: unknown): Promise<void> {
    const row = await this.services.world_service.GetWorldByName(world_name);
    const access = await this.services.world_service.GetAccess(row, client.player_id, client.is_admin);
    if (client.is_guest) access.can_build = access.can_manage = access.can_moderate = false;
    if (!access.can_enter) throw new GameError("world_denied", access.reason ?? "You cannot enter this world.", 403);
    const world = await this.Load(row.world_id);
    if (client.world && client.world !== world) this.Leave(client, "switch");
    if (!world.players.has(client.player_id) && world.players.size >= world.row.player_limit && !access.can_manage) {
      throw new GameError("world_full", "That world is full.", 409);
    }
    const spawn = world.SpawnPixel();
    Object.assign(client, { world, access, x: spawn.x, y: spawn.y, vx: 0, vy: 0, moved: false, last_move_at: Date.now(), last_grounded_y: spawn.y, joined_at: Date.now(), fishing_until: 0 });
    world.players.set(client.player_id, client);
    client.Send("world_state", this.StateFor(world, client));
    world.Broadcast("player_join", PublicPlayerView(client), client.player_id);
    const first_visit = await this.services.world_service.RecordVisit(world.row.world_id, client.player_id);
    await this.db.Run("UPDATE players SET last_world_id = ? WHERE player_id = ?", world.row.world_id, client.player_id);
    if (first_visit) await this.services.progress_service.Track(client.player_id, [{ stat_key: "worlds_visited" }]);
    client.Send("chat_history", { messages: await this.services.chat_service.History(client.player_id, world.row.world_id) });
  }

  StateFor(world: LiveWorld, client: GameClient) {
    const trees: TreeView[] = [...world.trees.values()].map((tree) => ({ ...tree, grow_ms: this.EffectiveGrowMs(tree) }));
    return {
      world_id: world.row.world_id,
      world_name: world.row.world_name,
      owner_name: world.row.owner_name,
      description: world.row.description,
      world_type: world.row.world_type,
      width: world.width,
      height: world.height,
      background: world.row.background,
      spawn_x: world.row.spawn_x,
      spawn_y: world.row.spawn_y,
      foreground: EncodeTiles(world.foreground),
      background_tiles: EncodeTiles(world.background),
      trees,
      drops: [...world.drops.values()].map(({ created_at: _created_at, ...drop }) => drop),
      players: [...world.players.values()].map(PublicPlayerView),
      your_role: client.access?.role ?? "visitor",
      can_build: client.access?.can_build ?? false,
      can_manage: client.access?.can_manage ?? false,
      settings: world.settings,
      locked: world.row.locked === 1,
      server_time: Date.now()
    };
  }

  Leave(client: GameClient, reason: string): void {
    const world = client.world;
    if (!world) return;
    world.players.delete(client.player_id);
    world.Broadcast("player_leave", { player_id: client.player_id, reason });
    if (world.players.size === 0) world.empty_since = Date.now();
    void this.services.player_service.AddPlaytime(client.player_id, (Date.now() - client.joined_at) / 1000);
    client.world = null;
    client.access = null;
    this.services.trade_manager.CancelForPlayer(client.player_id, "left the world");
  }

  // Re-reads the world row after an owner/admin edit and re-evaluates everyone's access.
  async Refresh(world_id: number): Promise<void> {
    const world = this.worlds.get(world_id);
    if (!world) return;
    world.row = await this.services.world_service.GetWorldById(world_id);
    world.settings = ParseSettings(world.row.settings);
    for (const client of [...world.players.values()]) {
      const access = await this.services.world_service.GetAccess(world.row, client.player_id, client.is_admin);
      if (!access.can_enter) {
        this.Kick(client, access.reason ?? "You no longer have access to this world.");
        continue;
      }
      client.access = access;
      client.Send("world_settings", { world_name: world.row.world_name, description: world.row.description, settings: world.settings, your_role: access.role, can_build: access.can_build, can_manage: access.can_manage, locked: world.row.locked === 1, background: world.row.background, world_type: world.row.world_type, spawn_x: world.row.spawn_x, spawn_y: world.row.spawn_y });
    }
  }

  Kick(client: GameClient, message: string): void {
    this.Leave(client, "kicked");
    client.Send("kicked", { message });
  }

  async Unload(world_id: number, kick_message?: string): Promise<void> {
    const world = this.worlds.get(world_id);
    if (!world) return;
    for (const client of [...world.players.values()]) this.Kick(client, kick_message ?? "This world was closed.");
    await this.FlushWorld(world);
    this.worlds.delete(world_id);
  }

  // Deleting must not flush: the row is gone and chunk inserts would violate the FK.
  Discard(world_id: number): void {
    const world = this.worlds.get(world_id);
    if (!world) return;
    for (const client of [...world.players.values()]) this.Kick(client, "This world was deleted.");
    this.worlds.delete(world_id);
  }

  async FlushWorld(world: LiveWorld): Promise<void> {
    if (world.dirty_chunks.size === 0) return;
    const dirty = new Set(world.dirty_chunks);
    world.dirty_chunks.clear();
    try {
      await this.services.world_service.SaveChunks(world.row.world_id, world.width, world.height, world.foreground, world.background, dirty);
    } catch (error) {
      for (const key of dirty) world.dirty_chunks.add(key);
      log.Error("world flush failed", { world_id: world.row.world_id, error: String(error) });
    }
  }

  async FlushAll(): Promise<void> {
    for (const world of this.worlds.values()) await this.FlushWorld(world);
  }

  async Tick(): Promise<void> {
    const now = Date.now();
    for (const world of this.worlds.values()) {
      const moved = [...world.players.values()].filter((client) => client.moved);
      if (moved.length) {
        const payload = moved.map((client) => ({ player_id: client.player_id, x: client.x, y: client.y, vx: client.vx, vy: client.vy, facing: client.facing, anim: client.anim }));
        for (const client of moved) client.moved = false;
        for (const client of world.players.values()) client.Send("players_moved", { players: payload.filter((entry) => entry.player_id !== client.player_id) });
      }
      for (const [index, progress] of world.hit_progress) if (now - progress.last_hit_at > 4000) world.hit_progress.delete(index);
    }
  }

  async Maintain(): Promise<void> {
    const now = Date.now();
    await this.FlushAll();
    for (const [world_id, world] of this.worlds) {
      if (world.players.size === 0 && now - world.empty_since > UNLOAD_IDLE_MS) {
        await this.FlushWorld(world);
        if (world.players.size === 0) this.worlds.delete(world_id);
      }
      for (const drop of world.drops.values()) {
        if (now - drop.created_at > 30 * 60_000) await this.RemoveDropRecord(world, drop.drop_id);
      }
    }
  }

  // ---------- validation helpers ----------

  private RequireWorld(client: GameClient): LiveWorld {
    if (!client.world) throw new ValidationError("Join a world first.");
    return client.world;
  }

  // Guests can walk, jump and chat only.
  private RequireTileId(client: GameClient): void {
    if (client.is_guest) throw new GameError("tile_id_required", "Create a TileID to interact with the world.", 403);
  }

  private ReadTile(world: LiveWorld, data: Record<string, unknown>): { x: number; y: number } {
    const x = data.x;
    const y = data.y;
    if (typeof x !== "number" || typeof y !== "number" || !world.InBounds(x, y)) {
      void this.services.security_service.Record(null, "invalid_coordinates", { x: String(x), y: String(y), world_id: world.row.world_id });
      throw new ValidationError("Invalid tile.");
    }
    return { x, y };
  }

  private InRange(client: GameClient, x: number, y: number, range_tiles: number): boolean {
    const center_x = client.x + PLAYER_WIDTH / 2;
    const center_y = client.y + PLAYER_HEIGHT / 2;
    const dx = (x + 0.5) * TILE_SIZE - center_x;
    const dy = (y + 0.5) * TILE_SIZE - center_y;
    return Math.hypot(dx, dy) <= (range_tiles + 0.75) * TILE_SIZE;
  }

  private EffectiveGrowMs(tree: TreeRecord): number {
    return Math.max(1000, Math.floor(tree.grow_ms / this.services.event_service.Effects().growth_multiplier));
  }

  // ---------- movement ----------

  HandleMove(client: GameClient, data: Record<string, unknown>): void {
    const world = this.RequireWorld(client);
    const { x, y, vx, vy, facing } = data;
    if (!IsFiniteNumber(x) || !IsFiniteNumber(y) || !IsFiniteNumber(vx) || !IsFiniteNumber(vy)) throw new ValidationError("Malformed movement.");
    const now = Date.now();
    const dt = Math.min(1000, Math.max(16, now - client.last_move_at)) / 1000;
    const max_x = world.width * TILE_SIZE - PLAYER_WIDTH;
    const max_y = world.height * TILE_SIZE - PLAYER_HEIGHT;
    const dx = Math.abs(x - client.x);
    const dy = y - client.y;
    let problem: string | null = null;
    if (x < 0 || y < -TILE_SIZE * 4 || x > max_x || y > max_y) problem = "out_of_bounds";
    else if (dx > MOVE_SPEED * dt * 1.4 + 26) problem = "speed";
    else if (dy < -(JUMP_VELOCITY * dt * 1.3 + 26) || dy > MAX_FALL_SPEED * dt * 1.4 + 26) problem = "vertical_speed";
    else if (this.BodyInsideSolid(world, x, y)) problem = "inside_solid";
    else {
      const grounded = this.BodyInsideSolid(world, x, y + 3, 1);
      if (grounded) client.last_grounded_y = y;
      // A jump rises about 2.9 tiles; sustained rise beyond 4.5 means flying.
      else if (client.last_grounded_y - y > TILE_SIZE * 4.5) problem = "flying";
    }
    if (problem) {
      client.violations++;
      if (client.violations % 10 === 1) void this.services.security_service.Record(client.player_id, "impossible_movement", { problem, world_id: world.row.world_id, dx: Math.round(dx), dy: Math.round(dy) });
      if (problem === "flying") client.last_grounded_y = client.y;
      client.last_move_at = now;
      client.Send("player_correct", { x: client.x, y: client.y });
      return;
    }
    if (client.violations > 0 && Math.random() < 0.05) client.violations--;
    client.x = x;
    client.y = y;
    client.vx = Math.max(-MOVE_SPEED, Math.min(MOVE_SPEED, vx));
    client.vy = Math.max(-JUMP_VELOCITY, Math.min(MAX_FALL_SPEED, vy));
    client.facing = facing === -1 ? -1 : 1;
    client.anim = typeof data.anim === "string" && ["idle", "walk", "jump", "fall", "punch"].includes(data.anim) ? data.anim : "idle";
    client.last_move_at = now;
    client.moved = true;
  }

  private BodyInsideSolid(world: LiveWorld, x: number, y: number, inset = 3): boolean {
    const left = Math.floor((x + inset) / TILE_SIZE);
    const right = Math.floor((x + PLAYER_WIDTH - inset) / TILE_SIZE);
    const top = Math.floor((y + inset) / TILE_SIZE);
    const bottom = Math.floor((y + PLAYER_HEIGHT - inset) / TILE_SIZE);
    for (let tile_y = top; tile_y <= bottom; tile_y++) for (let tile_x = left; tile_x <= right; tile_x++) if (world.IsSolid(tile_x, tile_y)) return true;
    return false;
  }

  // ---------- breaking ----------

  async HandleHit(client: GameClient, data: Record<string, unknown>): Promise<void> {
    const world = this.RequireWorld(client);
    this.RequireTileId(client);
    const { x, y } = this.ReadTile(world, data);
    const now = Date.now();
    if (now - client.last_hit_at < MIN_HIT_INTERVAL_MS * 0.8) {
      client.violations++;
      if (client.violations % 20 === 1) void this.services.security_service.Record(client.player_id, "hit_too_fast", { interval: now - client.last_hit_at });
      return;
    }
    if (!this.InRange(client, x, y, INTERACT_RANGE_TILES)) throw new ValidationError("That is too far away.");
    client.last_hit_at = now;
    const index = world.Index(x, y);
    const fg = world.foreground[index];

    if (fg === 18) return this.StartFishing(client, world, x, y);

    const tree = world.trees.get(index);
    if (!client.access?.can_build) {
      void this.services.security_service.Record(client.player_id, "unauthorized_break", { world_id: world.row.world_id, x, y });
      throw new GameError("no_permission", "You do not have permission to break blocks here.", 403);
    }
    if (tree) return this.HitTree(client, world, tree, index);

    const layer: "foreground" | "background" = fg !== AIR_ID ? "foreground" : "background";
    const tile_id = layer === "foreground" ? fg : world.background[index];
    if (tile_id === AIR_ID) return;
    const item = GetItem(tile_id);
    if (!item || !item.breakable) throw new ValidationError("That block cannot be broken.");
    const tool_tier = await this.services.inventory_service.BestToolTier(client.player_id);
    if (tool_tier < item.required_tool_tier) throw new ValidationError(`You need a stronger pick to break ${item.name}.`);
    const needed = HitsToBreak(item, tool_tier);
    const progress = world.hit_progress.get(index) ?? { hits: 0, last_hit_at: now };
    progress.hits += 1;
    progress.last_hit_at = now;
    world.hit_progress.set(index, progress);
    world.Broadcast("block_damage", { x, y, hits: progress.hits, needed, by: client.player_id });
    if (progress.hits < needed) return;

    // Tile could have changed during the tool-tier await; only break what we validated.
    if ((layer === "foreground" ? world.foreground[index] : world.background[index]) !== tile_id) return;
    world.hit_progress.delete(index);
    world.SetTile(x, y, layer, AIR_ID);
    world.Broadcast("tile_update", { x, y, foreground: world.foreground[index], background: world.background[index] });
    await this.RewardBreak(client, world, item.item_id, x, y);
  }

  private async RewardBreak(client: GameClient, world: LiveWorld, tile_id: number, x: number, y: number): Promise<void> {
    const item = GetItem(tile_id)!;
    const effects = this.services.event_service.Effects();
    const is_ore = item.pattern === "ore" || tile_id === 9 || tile_id === 10;
    for (const drop of item.drops) {
      if (Math.random() > drop.chance) continue;
      let quantity = RandomInt(drop.min, drop.max);
      if (is_ore && drop.item_id === tile_id) quantity = Math.round(quantity * effects.drop_multiplier);
      if (quantity > 0) await this.CreateDrop(world, client, drop.item_id, quantity, x, y);
    }
    if (item.seed_id && Math.random() < 0.12) await this.CreateDrop(world, client, item.seed_id, 1, x, y);
    if ((tile_id === 4 || tile_id === 5) && effects.meteor_chance > 0 && Math.random() < effects.meteor_chance) await this.CreateDrop(world, client, 212, 1, x, y);

    let coins = Math.round(item.coins_on_break * (is_ore ? effects.coin_multiplier : 1));
    if ((tile_id === 4 || tile_id === 5) && effects.treasure_bonus > 0 && Math.random() < effects.treasure_bonus) coins += RandomInt(15, 60);
    if (coins > 0) await this.services.player_service.ChangeCoins(client.player_id, coins, tile_id === 20 ? "treasure_chest" : "mining", { item_id: tile_id });
    const xp = await this.services.player_service.AwardXp(client.player_id, item.xp_on_break);
    if (xp.level_up) this.services.progress_service.LevelUpNotice(client.player_id, xp.level_up, xp.level_reward);
    const stats = [{ stat_key: "blocks_broken" }];
    if (is_ore) stats.push({ stat_key: "ores_mined" });
    if (tile_id === 20) stats.push({ stat_key: "treasures_found" });
    await this.services.progress_service.Track(client.player_id, stats);
    await this.db.Run("INSERT INTO block_statistics (item_id, broken_count) VALUES (?, 1) ON CONFLICT(item_id) DO UPDATE SET broken_count = broken_count + 1", tile_id);
    if (coins > 0 || xp.xp_gained > 0) await this.services.player_service.PushSelf(client.player_id);
    if (tile_id === 20) client.Send("notification", { kind: "treasure", message: `You opened a buried chest! +${coins} coins`, created_at: Date.now() });
  }

  private async HitTree(client: GameClient, world: LiveWorld, tree: TreeRecord, index: number): Promise<void> {
    const seed = GetItem(tree.item_id)!;
    const stage = TreeStage(Date.now() - tree.planted_at, this.EffectiveGrowMs(tree));
    // Claim the tree synchronously so two harvest packets cannot both pay out.
    world.trees.delete(index);
    const removed = await this.db.Run("DELETE FROM trees WHERE world_id = ? AND x = ? AND y = ?", world.row.world_id, tree.x, tree.y);
    if (removed.changes === 0) return;
    world.SetTile(tree.x, tree.y, "foreground", AIR_ID);
    world.Broadcast("tile_update", { x: tree.x, y: tree.y, foreground: AIR_ID, background: world.background[index], tree_removed: true });
    if (stage < 4) {
      await this.CreateDrop(world, client, tree.item_id, 1, tree.x, tree.y);
      return;
    }
    const definition = seed.tree!;
    await this.CreateDrop(world, client, definition.yield_item_id, RandomInt(definition.yield_min, definition.yield_max), tree.x, tree.y);
    if (Math.random() < definition.seed_return_chance) await this.CreateDrop(world, client, tree.item_id, Math.random() < 0.25 ? 2 : 1, tree.x, tree.y);
    const xp = await this.services.player_service.AwardXp(client.player_id, 10 + Math.floor(definition.grow_ms / 30_000));
    if (xp.level_up) this.services.progress_service.LevelUpNotice(client.player_id, xp.level_up, xp.level_reward);
    await this.services.progress_service.Track(client.player_id, [{ stat_key: "trees_harvested" }]);
    await this.services.player_service.PushSelf(client.player_id);
  }

  // ---------- placing ----------

  async HandlePlace(client: GameClient, data: Record<string, unknown>): Promise<void> {
    const world = this.RequireWorld(client);
    this.RequireTileId(client);
    const { x, y } = this.ReadTile(world, data);
    const slot_index = data.slot_index;
    if (typeof slot_index !== "number" || !Number.isInteger(slot_index) || slot_index < 0 || slot_index >= 40) throw new ValidationError("Invalid slot.");
    const now = Date.now();
    if (now - client.last_place_at < PLACE_COOLDOWN_MS * 0.8) return;
    client.last_place_at = now;
    if (!client.access?.can_build) {
      void this.services.security_service.Record(client.player_id, "unauthorized_place", { world_id: world.row.world_id, x, y });
      throw new GameError("no_permission", "You do not have permission to build here.", 403);
    }
    if (!this.InRange(client, x, y, INTERACT_RANGE_TILES)) throw new ValidationError("That is too far away.");
    const slot = await this.services.inventory_service.GetSlot(client.player_id, slot_index);
    if (!slot) throw new ValidationError("That slot is empty.");
    const item = GetItem(slot.item_id);
    if (!item || !item.placeable) throw new ValidationError("That item cannot be placed.");
    if (item.kind === "consumable") throw new ValidationError("Use that from your inventory.");

    const index = world.Index(x, y);
    const fg = world.foreground[index];
    let layer: "foreground" | "background";
    if (item.kind === "background") {
      if (world.background[index] !== AIR_ID) throw new ValidationError("There is already a wall there.");
      layer = "background";
    } else {
      if ((fg !== AIR_ID && fg !== 18) || world.trees.has(index)) throw new ValidationError("That spot is occupied.");
      if (item.kind === "seed") {
        if (fg === 18) throw new ValidationError("Seeds cannot grow in water.");
        if (y + 1 >= world.height || !GetItem(world.foreground[world.Index(x, y + 1)])?.collision) throw new ValidationError("Seeds need solid ground below.");
      }
      if (item.collision && this.TileOverlapsPlayer(world, x, y)) throw new ValidationError("Someone is standing there.");
      layer = "foreground";
    }

    // Mutate memory first (synchronous claim), then take the item; revert on failure.
    const previous = world[layer][index];
    world.SetTile(x, y, layer, item.item_id);
    let tree: TreeRecord | null = null;
    if (item.kind === "seed") {
      const on_rich_soil = world.foreground[world.Index(x, y + 1)] === 3;
      tree = { x, y, item_id: item.item_id, planted_at: now, grow_ms: Math.floor(item.tree!.grow_ms * (on_rich_soil ? 0.75 : 1)) };
      world.trees.set(index, tree);
    }
    try {
      await this.db.Transaction(async () => {
        await this.services.inventory_service.RemoveFromSlot(client.player_id, slot_index, 1);
        if (tree) {
          await this.db.Run("INSERT INTO trees (world_id, x, y, item_id, planted_by, planted_at, grow_ms) VALUES (?, ?, ?, ?, ?, ?, ?)", world.row.world_id, x, y, tree.item_id, client.player_id, tree.planted_at, tree.grow_ms);
        }
      });
    } catch (error) {
      world.SetTile(x, y, layer, previous);
      if (tree) world.trees.delete(index);
      throw error;
    }
    world.Broadcast("tile_update", { x, y, foreground: world.foreground[index], background: world.background[index], tree: tree ? { ...tree, grow_ms: this.EffectiveGrowMs(tree) } : undefined });
    await this.services.inventory_service.PushInventory(client.player_id);
    const xp = await this.services.player_service.AwardXp(client.player_id, tree ? 2 : 1);
    if (xp.level_up) {
      this.services.progress_service.LevelUpNotice(client.player_id, xp.level_up, xp.level_reward);
      await this.services.player_service.PushSelf(client.player_id);
    }
    await this.services.progress_service.Track(client.player_id, [{ stat_key: tree ? "trees_planted" : "blocks_placed" }]);
    await this.db.Run("INSERT INTO block_statistics (item_id, placed_count) VALUES (?, 1) ON CONFLICT(item_id) DO UPDATE SET placed_count = placed_count + 1", item.item_id);
  }

  private TileOverlapsPlayer(world: LiveWorld, x: number, y: number): boolean {
    const left = x * TILE_SIZE;
    const top = y * TILE_SIZE;
    for (const other of world.players.values()) {
      if (other.x < left + TILE_SIZE && other.x + PLAYER_WIDTH > left && other.y < top + TILE_SIZE && other.y + PLAYER_HEIGHT > top) return true;
    }
    return false;
  }

  // ---------- drops ----------

  private async CreateDrop(world: LiveWorld, client: GameClient, item_id: number, quantity: number, tile_x: number, tile_y: number): Promise<void> {
    if (!world.settings.allow_drops) {
      try {
        await this.services.inventory_service.AddItem(client.player_id, item_id, quantity);
        await this.services.inventory_service.PushInventory(client.player_id);
        await this.services.progress_service.Track(client.player_id, [{ stat_key: "items_collected", amount: quantity }]);
        return;
      } catch {
        // Bag full: fall through and drop it in the world instead of losing it.
      }
    }
    if (world.drops.size >= MAX_DROPS_PER_WORLD) {
      const oldest = [...world.drops.values()].sort((a, b) => a.created_at - b.created_at)[0];
      if (oldest) await this.RemoveDropRecord(world, oldest.drop_id);
    }
    const drop = {
      drop_id: crypto.randomUUID(),
      item_id,
      quantity,
      x: tile_x * TILE_SIZE + 6 + Math.random() * 12,
      y: tile_y * TILE_SIZE + 10,
      created_at: Date.now()
    };
    await this.db.Run("INSERT INTO item_drops (drop_id, world_id, item_id, quantity, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", drop.drop_id, world.row.world_id, item_id, quantity, drop.x, drop.y, drop.created_at);
    world.drops.set(drop.drop_id, drop);
    const { created_at: _created_at, ...view } = drop;
    world.Broadcast("drop_spawn", view);
  }

  private async RemoveDropRecord(world: LiveWorld, drop_id: string): Promise<void> {
    world.drops.delete(drop_id);
    await this.db.Run("DELETE FROM item_drops WHERE drop_id = ?", drop_id);
    world.Broadcast("drop_remove", { drop_id });
  }

  async HandlePickup(client: GameClient, data: Record<string, unknown>): Promise<void> {
    const world = this.RequireWorld(client);
    if (client.is_guest) return;
    const drop_id = data.drop_id;
    if (typeof drop_id !== "string" || drop_id.length > 64) throw new ValidationError("Invalid drop.");
    const drop = world.drops.get(drop_id);
    if (!drop) return;
    const center_x = client.x + PLAYER_WIDTH / 2;
    const center_y = client.y + PLAYER_HEIGHT / 2;
    if (Math.hypot(drop.x - center_x, drop.y - center_y) > DROP_PICKUP_RANGE_TILES * TILE_SIZE) return;
    // Synchronous claim from the map is what stops two players taking the same drop.
    world.drops.delete(drop_id);
    try {
      await this.db.Transaction(async () => {
        const removed = await this.db.Run("DELETE FROM item_drops WHERE drop_id = ?", drop_id);
        if (removed.changes === 0) throw new GameError("drop_gone", "Already picked up.", 409);
        await this.services.inventory_service.AddItem(client.player_id, drop.item_id, drop.quantity);
      });
    } catch (error) {
      if (error instanceof GameError && error.code === "drop_gone") return;
      world.drops.set(drop_id, drop);
      throw error;
    }
    world.Broadcast("drop_remove", { drop_id, picked_by: client.player_id });
    client.Send("item_obtained", { item_id: drop.item_id, quantity: drop.quantity });
    await this.services.inventory_service.PushInventory(client.player_id);
    await this.services.progress_service.Track(client.player_id, [{ stat_key: "items_collected", amount: drop.quantity }]);
  }

  async HandleDropItem(client: GameClient, data: Record<string, unknown>): Promise<void> {
    const world = this.RequireWorld(client);
    this.RequireTileId(client);
    if (!world.settings.allow_drops) throw new ValidationError("Item drops are disabled in this world.");
    const slot_index = data.slot_index;
    const quantity = data.quantity;
    if (typeof slot_index !== "number" || typeof quantity !== "number") throw new ValidationError("Invalid drop request.");
    const slot = await this.services.inventory_service.RemoveFromSlot(client.player_id, slot_index, quantity);
    const tile_x = Math.floor((client.x + PLAYER_WIDTH / 2) / TILE_SIZE) + client.facing;
    const tile_y = Math.floor((client.y + PLAYER_HEIGHT / 2) / TILE_SIZE);
    const safe_x = Math.max(0, Math.min(world.width - 1, tile_x));
    const drop = { drop_id: crypto.randomUUID(), item_id: slot.item_id, quantity, x: safe_x * TILE_SIZE + 10, y: tile_y * TILE_SIZE + 8, created_at: Date.now() };
    await this.db.Run("INSERT INTO item_drops (drop_id, world_id, item_id, quantity, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", drop.drop_id, world.row.world_id, drop.item_id, quantity, drop.x, drop.y, drop.created_at);
    world.drops.set(drop.drop_id, drop);
    const { created_at: _created_at, ...view } = drop;
    world.Broadcast("drop_spawn", view);
    await this.services.inventory_service.PushInventory(client.player_id);
  }

  // ---------- interactions ----------

  async HandleInteract(client: GameClient, data: Record<string, unknown>): Promise<void> {
    const world = this.RequireWorld(client);
    this.RequireTileId(client);
    const { x, y } = this.ReadTile(world, data);
    if (!this.InRange(client, x, y, 2)) throw new ValidationError("Move closer.");
    const tile = world.foreground[world.Index(x, y)];
    if (tile === 22) {
      const stat_key = `shrine_world_${world.row.world_id}`;
      const stats = await this.services.progress_service.GetStats(client.player_id);
      if (stats[stat_key]) {
        client.Send("notification", { kind: "info", message: "The shrine hums. You have already recorded it.", created_at: Date.now() });
        return;
      }
      await this.services.progress_service.Track(client.player_id, [{ stat_key, mode: "max", amount: 1 }, { stat_key: "rare_locations" }]);
      await this.services.player_service.ChangeCoins(client.player_id, 150, "exploration", { reference_id: stat_key });
      const xp = await this.services.player_service.AwardXp(client.player_id, 200);
      if (xp.level_up) this.services.progress_service.LevelUpNotice(client.player_id, xp.level_up, xp.level_reward);
      await this.services.notification_service.Notify(client.player_id, "discovery", `You discovered the Whispering Shrine of ${world.row.world_name}! +150 coins`);
      await this.services.player_service.PushSelf(client.player_id);
      return;
    }
    const tree = world.trees.get(world.Index(x, y));
    if (tree) {
      const grow_ms = this.EffectiveGrowMs(tree);
      const left = Math.max(0, tree.planted_at + grow_ms - Date.now());
      client.Send("notification", { kind: "info", message: left === 0 ? `${GetItem(tree.item_id)!.name} is ready to harvest!` : `${GetItem(tree.item_id)!.name}: ${Math.ceil(left / 1000)}s until harvest.`, created_at: Date.now() });
    }
  }

  private StartFishing(client: GameClient, world: LiveWorld, x: number, y: number): Promise<void> {
    return (async () => {
      if (client.fishing_until > Date.now()) return;
      if ((await this.services.inventory_service.CountItem(client.player_id, 310)) < 1) throw new ValidationError("You need a Reed Fishing Rod to fish here.");
      const wait = 2500 + Math.floor(Math.random() * 3500);
      client.fishing_until = Date.now() + wait + 500;
      client.Send("fishing_start", { x, y, wait_ms: wait });
      setTimeout(() => void this.FinishFishing(client, world, x, y), wait);
    })();
  }

  private async FinishFishing(client: GameClient, world: LiveWorld, x: number, y: number): Promise<void> {
    try {
      if (client.world !== world || !this.InRange(client, x, y, INTERACT_RANGE_TILES + 1)) {
        client.Send("fish_result", { caught: false, message: "The line went slack." });
        return;
      }
      const roll = Math.random();
      const item_id = roll < 0.05 ? 0 : roll < 0.13 ? 222 : roll < 0.43 ? 221 : 220;
      if (item_id === 0) {
        client.Send("fish_result", { caught: false, message: "Nothing bit this time." });
        return;
      }
      await this.services.inventory_service.AddItem(client.player_id, item_id, 1);
      const xp = await this.services.player_service.AwardXp(client.player_id, item_id === 222 ? 40 : 10);
      if (xp.level_up) this.services.progress_service.LevelUpNotice(client.player_id, xp.level_up, xp.level_reward);
      await this.services.progress_service.Track(client.player_id, [{ stat_key: "fish_caught" }]);
      client.Send("fish_result", { caught: true, item_id, message: `You caught a ${GetItem(item_id)!.name}!` });
      await this.services.inventory_service.PushInventory(client.player_id);
      await this.services.player_service.PushSelf(client.player_id);
    } catch (error) {
      client.Send("fish_result", { caught: false, message: error instanceof GameError ? error.message : "The fish got away." });
    }
  }

  async TreeReadyNotifications(): Promise<void> {
    const rows = await this.db.All<{ world_id: number; x: number; y: number; item_id: number; planted_by: number; planted_at: number; grow_ms: number; world_name: string }>(
      `SELECT t.world_id, t.x, t.y, t.item_id, t.planted_by, t.planted_at, t.grow_ms, w.world_name FROM trees t JOIN worlds w ON w.world_id = t.world_id
       WHERE t.notified = 0 AND t.planted_by IS NOT NULL AND t.planted_at < ? LIMIT 200`,
      Date.now() - 1000
    );
    const multiplier = this.services.event_service.Effects().growth_multiplier;
    const per_player = new Map<number, { count: number; world_name: string }>();
    for (const row of rows) {
      if (row.planted_at + row.grow_ms / multiplier > Date.now()) continue;
      await this.db.Run("UPDATE trees SET notified = 1 WHERE world_id = ? AND x = ? AND y = ?", row.world_id, row.x, row.y);
      const entry = per_player.get(row.planted_by) ?? { count: 0, world_name: row.world_name };
      entry.count++;
      per_player.set(row.planted_by, entry);
    }
    for (const [player_id, entry] of per_player) {
      await this.services.notification_service.Notify(player_id, "tree_ready", `${entry.count} tree${entry.count > 1 ? "s are" : " is"} ready to harvest in ${entry.world_name}.`);
    }
  }

  // ---------- admin ----------

  async AdminTeleport(client: GameClient, tile_x: number, tile_y: number): Promise<void> {
    const world = this.RequireWorld(client);
    if (!world.InBounds(tile_x, tile_y)) throw new ValidationError("Out of bounds.");
    client.x = tile_x * TILE_SIZE + 6;
    client.y = tile_y * TILE_SIZE + TILE_SIZE - PLAYER_HEIGHT;
    client.last_grounded_y = client.y;
    client.moved = true;
    client.Send("player_correct", { x: client.x, y: client.y });
  }

  async SetSpawnHere(client: GameClient): Promise<void> {
    const world = this.RequireWorld(client);
    if (!client.access?.can_manage) throw new GameError("no_permission", "Only world managers can move the spawn.", 403);
    const tile_x = Math.floor((client.x + PLAYER_WIDTH / 2) / TILE_SIZE);
    const tile_y = Math.floor((client.y + PLAYER_HEIGHT - 1) / TILE_SIZE);
    const target = world.Index(tile_x, tile_y);
    if (world.foreground[target] !== AIR_ID) throw new ValidationError("Stand on an empty tile to set the spawn.");
    const old_x = world.row.spawn_x;
    const old_y = world.row.spawn_y;
    if (world.foreground[world.Index(old_x, old_y)] === 19) {
      world.SetTile(old_x, old_y, "foreground", AIR_ID);
      world.Broadcast("tile_update", { x: old_x, y: old_y, foreground: AIR_ID, background: world.background[world.Index(old_x, old_y)] });
    }
    world.SetTile(tile_x, tile_y, "foreground", 19);
    world.Broadcast("tile_update", { x: tile_x, y: tile_y, foreground: 19, background: world.background[target] });
    await this.services.world_service.SetSpawn(world.row.world_id, tile_x, tile_y);
    await this.FlushWorld(world);
    await this.Refresh(world.row.world_id);
  }
}
