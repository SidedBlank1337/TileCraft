import { TILE_SIZE, CHUNK_SIZE, INTERACT_RANGE_TILES } from "../../shared/constants.ts";
import { GetItem, TreeStage } from "../../shared/items.ts";
import { StepBody, PLAYER_HEIGHT, PLAYER_WIDTH, type BodyState } from "../../shared/physics.ts";
import { DecodeTiles, type DropView, type PublicPlayer, type TreeView } from "../../shared/protocol.ts";
import type { Appearance } from "../../shared/cosmetics.ts";
import { COSMETICS_BY_KEY } from "../../shared/cosmetics.ts";
import { game_socket } from "../services/socket.ts";
import { store } from "../state/store.ts";
import { audio } from "../audio/audio_engine.ts";
import { DrawCharacter, GetTexture, GetTreeTexture } from "./textures.ts";

const SKIES: Record<string, [string, string]> = {
  dawn: ["#f7a072", "#7b5ea7"],
  noon: ["#7ec8ff", "#d8f1ff"],
  dusk: ["#3d2c6b", "#f28f6b"],
  night: ["#0b1026", "#2b2d5c"],
  aurora: ["#0d1b2a", "#2ec4b6"]
};
const MOVE_SEND_MS = 66;
const HIT_REPEAT_MS = 200;
const FIXED_DT = 1 / 60;

interface RemotePlayer extends PublicPlayer {
  target_x: number;
  target_y: number;
  bubble: { text: string; until: number } | null;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export interface MobileInput {
  left: boolean;
  right: boolean;
  jump: boolean;
  action: boolean;
}

export const FIST_SLOT = -1;

export interface HoverInfo {
  tile_x: number;
  tile_y: number;
  label: string;
  in_range: boolean;
}

export interface WorldMeta {
  world_id: number;
  world_name: string;
  owner_name: string;
  description: string;
  world_type: string;
  your_role: string;
  can_build: boolean;
  can_manage: boolean;
  locked: boolean;
  settings: Record<string, boolean>;
}

export class GameEngine {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private foreground: Uint16Array = new Uint16Array(0);
  private background: Uint16Array = new Uint16Array(0);
  private chunks = new Map<string, { canvas: HTMLCanvasElement; dirty: boolean }>();
  private trees = new Map<number, TreeView>();
  private drops = new Map<string, DropView & { born: number }>();
  private pending_pickups = new Map<string, number>();
  private damage = new Map<number, { hits: number; needed: number; at: number }>();
  private remote = new Map<number, RemotePlayer>();
  private particles: Particle[] = [];
  private body: BodyState = { x: 0, y: 0, vx: 0, vy: 0, on_ground: false };
  private facing = 1;
  private anim = "idle";
  private punch_until = 0;
  private keys = new Set<string>();
  private mouse = { x: 0, y: 0, left: false, right: false, inside: false, left_click: false, right_click: false };
  private touch_active = false;
  mobile: MobileInput = { left: false, right: false, jump: false, action: false };
  private last_guest_notice = 0;
  private last_send = 0;
  private last_sent = { x: 0, y: 0 };
  private last_hit = 0;
  private last_place = 0;
  private accumulator = 0;
  private last_frame = 0;
  private frame_id = 0;
  private server_offset = 0;
  private camera = { x: 0, y: 0 };
  private background_key = "noon";
  private my_bubble: { text: string; until: number } | null = null;
  private fishing: { x: number; y: number; until: number } | null = null;
  private unsubscribers: (() => void)[] = [];
  private loaded = false;
  private was_on_ground = true;
  meta: WorldMeta | null = null;
  on_meta: (meta: WorldMeta) => void = () => undefined;
  on_hover: (info: HoverInfo | null) => void = () => undefined;
  private hover_key = "";
  private input_blocked = () => false;

  constructor(private canvas: HTMLCanvasElement, input_blocked: () => boolean) {
    this.ctx = canvas.getContext("2d")!;
    this.input_blocked = input_blocked;
    this.BindSocket();
    this.BindInput();
    // Read-only view of client state for automated browser tests; it cannot change anything on the server.
    (window as unknown as { tilecraft_debug: unknown }).tilecraft_debug = {
      remote_players: () => [...this.remote.values()].map((player) => ({ username: player.username, x: Math.round(player.x), y: Math.round(player.y) })),
      self: () => ({ x: Math.round(this.body.x), y: Math.round(this.body.y) }),
      tile: (x: number, y: number) => this.foreground[y * this.width + x],
      drops: () => this.drops.size,
      meta: () => this.meta,
      tile_to_screen: (x: number, y: number) => {
        const rect = this.canvas.getBoundingClientRect();
        const scale = this.Scale();
        return { x: rect.left + ((x + 0.5) * TILE_SIZE - this.camera.x) * scale, y: rect.top + ((y + 0.5) * TILE_SIZE - this.camera.y) * scale };
      }
    };
    // The world_state reply can arrive before React mounts this engine.
    if (game_socket.last_world_state) this.LoadWorld(game_socket.last_world_state);
    this.frame_id = requestAnimationFrame((time) => this.Frame(time));
  }

  Destroy(): void {
    cancelAnimationFrame(this.frame_id);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  // ---------- networking ----------

  private BindSocket(): void {
    const on = (event: string, handler: (data: any) => void) => this.unsubscribers.push(game_socket.On(event, handler));
    on("world_state", (data) => this.LoadWorld(data));
    on("player_join", (data: PublicPlayer) => this.remote.set(data.player_id, { ...data, target_x: data.x, target_y: data.y, bubble: null }));
    on("player_leave", (data) => this.remote.delete(data.player_id));
    on("players_moved", (data) => {
      for (const entry of data.players) {
        const player = this.remote.get(entry.player_id);
        if (!player) continue;
        player.target_x = entry.x;
        player.target_y = entry.y;
        player.facing = entry.facing;
        player.anim = entry.anim;
      }
    });
    on("player_appearance", (data) => {
      const player = this.remote.get(data.player_id);
      if (player) player.appearance = data.appearance;
    });
    on("player_correct", (data) => {
      this.body.x = data.x;
      this.body.y = data.y;
      this.body.vx = 0;
      this.body.vy = 0;
      this.last_sent = { x: data.x, y: data.y };
    });
    on("tile_update", (data) => this.ApplyTile(data));
    on("block_damage", (data) => {
      this.damage.set(data.y * this.width + data.x, { hits: data.hits, needed: data.needed, at: performance.now() });
      if (data.by !== store.Get().player?.player_id) return;
      audio.Play("hit");
    });
    on("drop_spawn", (data: DropView) => this.drops.set(data.drop_id, { ...data, born: performance.now() }));
    on("drop_remove", (data) => {
      this.drops.delete(data.drop_id);
      this.pending_pickups.delete(data.drop_id);
    });
    on("chat_message", (data) => {
      if (data.channel !== "world") return;
      const bubble = { text: data.body.slice(0, 60), until: performance.now() + 4500 };
      if (data.sender_id === store.Get().player?.player_id) this.my_bubble = bubble;
      const player = this.remote.get(data.sender_id);
      if (player) player.bubble = bubble;
    });
    on("world_settings", (data) => {
      if (!this.meta) return;
      const next: WorldMeta = { ...this.meta, ...data };
      this.meta = next;
      this.background_key = data.background ?? this.background_key;
      this.on_meta(next);
    });
    on("fishing_start", (data) => (this.fishing = { x: data.x, y: data.y, until: performance.now() + data.wait_ms }));
    on("fish_result", () => (this.fishing = null));
  }

  private LoadWorld(data: any): void {
    this.width = data.width;
    this.height = data.height;
    this.foreground = DecodeTiles(data.foreground, data.width * data.height);
    this.background = DecodeTiles(data.background_tiles, data.width * data.height);
    this.chunks.clear();
    this.trees = new Map(data.trees.map((tree: TreeView) => [tree.y * data.width + tree.x, tree]));
    this.drops = new Map(data.drops.map((drop: DropView) => [drop.drop_id, { ...drop, born: performance.now() }]));
    this.pending_pickups.clear();
    this.damage.clear();
    const my_id = store.Get().player?.player_id;
    this.remote.clear();
    for (const player of data.players as PublicPlayer[]) {
      if (player.player_id === my_id) {
        this.body = { x: player.x, y: player.y, vx: 0, vy: 0, on_ground: false };
        this.last_sent = { x: player.x, y: player.y };
      } else this.remote.set(player.player_id, { ...player, target_x: player.x, target_y: player.y, bubble: null });
    }
    this.server_offset = data.server_time - Date.now();
    this.background_key = data.background;
    this.meta = {
      world_id: data.world_id, world_name: data.world_name, owner_name: data.owner_name, description: data.description, world_type: data.world_type,
      your_role: data.your_role, can_build: data.can_build, can_manage: data.can_manage, locked: data.locked, settings: data.settings
    };
    this.loaded = true;
    this.on_meta(this.meta);
    store.Set({ current_world: data.world_name });
    game_socket.rejoin_world = data.world_name;
  }

  private ApplyTile(data: { x: number; y: number; foreground: number; background: number; tree?: TreeView; tree_removed?: boolean }): void {
    if (!this.loaded) return;
    const index = data.y * this.width + data.x;
    const previous = this.foreground[index];
    this.foreground[index] = data.foreground;
    this.background[index] = data.background;
    this.damage.delete(index);
    if (data.tree) this.trees.set(index, data.tree);
    if (data.tree_removed || (data.foreground === 0 && this.trees.has(index))) this.trees.delete(index);
    // Neighbours' outlines depend on this tile, so chunks across an edge redraw too.
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const chunk = this.chunks.get(`${Math.floor((data.x + dx) / CHUNK_SIZE)},${Math.floor((data.y + dy) / CHUNK_SIZE)}`);
      if (chunk) chunk.dirty = true;
    }
    const near = Math.hypot((data.x + 0.5) * TILE_SIZE - this.body.x, (data.y + 0.5) * TILE_SIZE - this.body.y) < TILE_SIZE * 12;
    if (data.foreground === 0 && previous !== 0) {
      this.Burst(data.x, data.y, GetItem(previous)?.palette ?? ["#888", "#666", "#aaa"]);
      if (near) audio.Play("break");
    } else if (data.foreground !== 0 && previous === 0 && near) audio.Play("place");
  }

  private Burst(tile_x: number, tile_y: number, palette: string[]): void {
    for (let i = 0; i < 10; i++) {
      this.particles.push({
        x: (tile_x + 0.5) * TILE_SIZE, y: (tile_y + 0.5) * TILE_SIZE,
        vx: (Math.random() - 0.5) * 180, vy: -Math.random() * 200, life: 0.6 + Math.random() * 0.3, color: palette[i % palette.length]
      });
    }
  }

  // ---------- input ----------

  private BindInput(): void {
    const key_down = (event: KeyboardEvent) => {
      if (this.input_blocked()) return;
      const key = event.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", " ", "arrowdown"].includes(key)) event.preventDefault();
      this.keys.add(key);
      if (/^[1-9]$/.test(key)) store.Set({ selected_slot: Number(key) - 1 });
      if (key === "0" || key === "`") store.Set({ selected_slot: FIST_SLOT });
    };
    const key_up = (event: KeyboardEvent) => this.keys.delete(event.key.toLowerCase());
    const blur = () => {
      this.keys.clear();
      this.mouse.left = this.mouse.right = false;
    };
    const mouse_move = (event: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = event.clientX - rect.left;
      this.mouse.y = event.clientY - rect.top;
      this.mouse.inside = true;
    };
    const mouse_down = (event: MouseEvent) => {
      if (this.touch_active) return;
      mouse_move(event);
      // Latched so a click shorter than one frame still acts.
      if (event.button === 0) this.mouse.left = this.mouse.left_click = true;
      if (event.button === 2) this.mouse.right = this.mouse.right_click = true;
      this.last_hit = 0;
      this.last_place = 0;
    };
    const mouse_up = (event: MouseEvent) => {
      if (event.button === 0) this.mouse.left = false;
      if (event.button === 2) this.mouse.right = false;
    };
    const touch = (event: TouchEvent) => {
      event.preventDefault();
      this.touch_active = true;
      const first = event.touches[0];
      if (!first) {
        this.mouse.left = this.mouse.right = false;
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = first.clientX - rect.left;
      this.mouse.y = first.clientY - rect.top;
      this.mouse.inside = true;
      if (event.type === "touchstart") {
        // A tap punches with the fist selected, otherwise it places the selected item.
        const punching = store.Get().selected_slot === FIST_SLOT;
        this.mouse.left = this.mouse.left_click = punching;
        this.mouse.right = this.mouse.right_click = !punching;
        this.last_hit = 0;
        this.last_place = 0;
      }
    };
    window.addEventListener("keydown", key_down);
    window.addEventListener("keyup", key_up);
    window.addEventListener("blur", blur);
    this.canvas.addEventListener("mousemove", mouse_move);
    this.canvas.addEventListener("mousedown", mouse_down);
    window.addEventListener("mouseup", mouse_up);
    this.canvas.addEventListener("mouseleave", () => (this.mouse.inside = false));
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("touchstart", touch, { passive: false });
    this.canvas.addEventListener("touchmove", touch, { passive: false });
    this.canvas.addEventListener("touchend", touch, { passive: false });
    this.unsubscribers.push(() => {
      window.removeEventListener("keydown", key_down);
      window.removeEventListener("keyup", key_up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("mouseup", mouse_up);
    });
  }

  private IsSolid = (tile_x: number, tile_y: number): boolean => {
    if (tile_x < 0 || tile_x >= this.width || tile_y >= this.height) return true;
    if (tile_y < 0) return false;
    return GetItem(this.foreground[tile_y * this.width + tile_x])?.collision ?? false;
  };

  private HoveredTile(): { x: number; y: number } | null {
    if (!this.mouse.inside) return null;
    const scale = this.Scale();
    const x = Math.floor((this.mouse.x / scale + this.camera.x) / TILE_SIZE);
    const y = Math.floor((this.mouse.y / scale + this.camera.y) / TILE_SIZE);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return { x, y };
  }

  private InRange(tile_x: number, tile_y: number, range = INTERACT_RANGE_TILES): boolean {
    const dx = (tile_x + 0.5) * TILE_SIZE - (this.body.x + PLAYER_WIDTH / 2);
    const dy = (tile_y + 0.5) * TILE_SIZE - (this.body.y + PLAYER_HEIGHT / 2);
    return Math.hypot(dx, dy) <= (range + 0.5) * TILE_SIZE;
  }

  private HandleActions(now: number): void {
    const tile = this.HoveredTile();
    this.ReportHover(tile);
    const left = this.mouse.left || this.mouse.left_click;
    const right = this.mouse.right || this.mouse.right_click;
    this.mouse.left_click = this.mouse.right_click = false;
    if (this.input_blocked()) return;
    if ((left || right || this.mobile.action) && store.Get().player?.is_guest) {
      if (now - this.last_guest_notice > 3000) {
        this.last_guest_notice = now;
        store.Toast("info", "Create a TileID from the ⋮ menu to break, place and collect.");
      }
      return;
    }
    if (this.mobile.action) this.HandleActionButton(now);
    if (!tile) return;
    const index = tile.y * this.width + tile.x;
    const fg = this.foreground[index];
    if (left && now - this.last_hit >= HIT_REPEAT_MS && this.InRange(tile.x, tile.y)) {
      this.last_hit = now;
      this.punch_until = now + 150;
      this.facing = (tile.x + 0.5) * TILE_SIZE < this.body.x + PLAYER_WIDTH / 2 ? -1 : 1;
      if (fg === 22) game_socket.Send("interact", { x: tile.x, y: tile.y });
      else if (fg !== 0 || this.background[index] !== 0) game_socket.Send("block_hit", { x: tile.x, y: tile.y });
    }
    if (right && now - this.last_place >= 160 && this.InRange(tile.x, tile.y)) {
      this.last_place = now;
      const state = store.Get();
      const slot = state.inventory.find((entry) => entry.slot_index === state.selected_slot);
      const item = slot ? GetItem(slot.item_id) : undefined;
      if (this.trees.has(index) || fg === 22) game_socket.Send("interact", { x: tile.x, y: tile.y });
      else if (item?.placeable) game_socket.Send("block_place", { x: tile.x, y: tile.y, slot_index: state.selected_slot });
    }
  }

  // On-screen action button: punch with the fist, otherwise place the selected item, aimed in front of the player.
  private HandleActionButton(now: number): void {
    const state = store.Get();
    const center_x = Math.floor((this.body.x + PLAYER_WIDTH / 2) / TILE_SIZE);
    const feet_y = Math.floor((this.body.y + PLAYER_HEIGHT - 1) / TILE_SIZE);
    const front_x = center_x + this.facing;
    if (state.selected_slot === FIST_SLOT) {
      if (now - this.last_hit < HIT_REPEAT_MS) return;
      const candidates = [[front_x, feet_y], [front_x, feet_y - 1], [front_x, feet_y + 1], [center_x, feet_y + 1]];
      const target = candidates.find(([x, y]) => x >= 0 && y >= 0 && x < this.width && y < this.height && (this.foreground[y * this.width + x] !== 0 || this.background[y * this.width + x] !== 0));
      if (!target) return;
      this.last_hit = now;
      this.punch_until = now + 150;
      const fg = this.foreground[target[1] * this.width + target[0]];
      game_socket.Send(fg === 22 ? "interact" : "block_hit", { x: target[0], y: target[1] });
      return;
    }
    if (now - this.last_place < 200) return;
    const slot = state.inventory.find((entry) => entry.slot_index === state.selected_slot);
    if (!slot || !GetItem(slot.item_id)?.placeable) return;
    const candidates = [[front_x, feet_y], [front_x, feet_y - 1]];
    const target = candidates.find(([x, y]) => x >= 0 && y >= 0 && x < this.width && y < this.height && this.foreground[y * this.width + x] === 0);
    if (!target) return;
    this.last_place = now;
    game_socket.Send("block_place", { x: target[0], y: target[1], slot_index: state.selected_slot });
  }

  private ReportHover(tile: { x: number; y: number } | null): void {
    const key = tile ? `${tile.x},${tile.y},${this.foreground[tile.y * this.width + tile.x]},${this.InRange(tile.x, tile.y)}` : "";
    if (key === this.hover_key) return;
    this.hover_key = key;
    if (!tile) return this.on_hover(null);
    const index = tile.y * this.width + tile.x;
    const tree = this.trees.get(index);
    let label: string;
    if (tree) {
      const stage = TreeStage(Date.now() + this.server_offset - tree.planted_at, tree.grow_ms);
      label = `${GetItem(tree.item_id)?.name} tree (${["seed", "sprout", "young", "mature", "ready!"][stage]})`;
    } else {
      const fg = GetItem(this.foreground[index]);
      const bg = GetItem(this.background[index]);
      label = fg && fg.item_id !== 0 ? fg.name : bg && bg.item_id !== 0 ? `${bg.name} (wall)` : "Air";
    }
    this.on_hover({ tile_x: tile.x, tile_y: tile.y, label, in_range: this.InRange(tile.x, tile.y) });
  }

  // ---------- simulation ----------

  private Frame(time: number): void {
    this.frame_id = requestAnimationFrame((next) => this.Frame(next));
    const dt = Math.min(0.1, (time - (this.last_frame || time)) / 1000);
    this.last_frame = time;
    this.Resize();
    if (!this.loaded) return this.DrawLoading();
    this.accumulator += dt;
    while (this.accumulator >= FIXED_DT) {
      this.Simulate();
      this.accumulator -= FIXED_DT;
    }
    this.HandleActions(time);
    this.UpdateRemote(dt);
    this.UpdateParticles(dt);
    this.AutoPickup(time);
    this.SendMovement(time);
    this.UpdateMusicContext();
    this.Draw(time);
  }

  private Simulate(): void {
    const blocked = this.input_blocked();
    const left = !blocked && (this.keys.has("a") || this.keys.has("arrowleft") || this.mobile.left);
    const right = !blocked && (this.keys.has("d") || this.keys.has("arrowright") || this.mobile.right);
    const jump = !blocked && (this.keys.has("w") || this.keys.has(" ") || this.keys.has("arrowup") || this.mobile.jump);
    const was_ground = this.body.on_ground;
    this.body = StepBody(this.body, { left, right, jump }, FIXED_DT, this.IsSolid);
    if (was_ground && !this.body.on_ground && this.body.vy < 0) audio.Play("jump");
    this.was_on_ground = this.body.on_ground;
    if (left && !right) this.facing = -1;
    if (right && !left) this.facing = 1;
    const now = performance.now();
    if (now < this.punch_until) this.anim = "punch";
    else if (!this.body.on_ground) this.anim = this.body.vy < 0 ? "jump" : "fall";
    else this.anim = Math.abs(this.body.vx) > 20 ? "walk" : "idle";
  }

  private SendMovement(now: number): void {
    const moved = Math.abs(this.body.x - this.last_sent.x) > 0.5 || Math.abs(this.body.y - this.last_sent.y) > 0.5;
    if (now - this.last_send < MOVE_SEND_MS || (!moved && now - this.last_send < 1000)) return;
    this.last_send = now;
    this.last_sent = { x: this.body.x, y: this.body.y };
    game_socket.Send("player_move", {
      x: Math.round(this.body.x * 100) / 100, y: Math.round(this.body.y * 100) / 100,
      vx: Math.round(this.body.vx), vy: Math.round(this.body.vy), facing: this.facing, anim: this.anim
    });
  }

  private UpdateRemote(dt: number): void {
    const blend = 1 - Math.pow(0.0005, dt);
    for (const player of this.remote.values()) {
      player.x += (player.target_x - player.x) * blend;
      player.y += (player.target_y - player.y) * blend;
      if (Math.hypot(player.target_x - player.x, player.target_y - player.y) > TILE_SIZE * 8) {
        player.x = player.target_x;
        player.y = player.target_y;
      }
    }
  }

  private UpdateParticles(dt: number): void {
    for (const particle of this.particles) {
      particle.vy += 900 * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.life -= dt;
    }
    this.particles = this.particles.filter((particle) => particle.life > 0);
  }

  private AutoPickup(now: number): void {
    const center_x = this.body.x + PLAYER_WIDTH / 2;
    const center_y = this.body.y + PLAYER_HEIGHT / 2;
    for (const drop of this.drops.values()) {
      if (Math.hypot(drop.x - center_x, drop.y - center_y) > TILE_SIZE * 1.6) continue;
      const pending = this.pending_pickups.get(drop.drop_id);
      if (pending && now - pending < 1500) continue;
      this.pending_pickups.set(drop.drop_id, now);
      game_socket.Send("item_pickup", { drop_id: drop.drop_id });
    }
  }

  private UpdateMusicContext(): void {
    if (store.Get().events.length > 0) return audio.SetMusicContext("event");
    audio.SetMusicContext(this.body.y > this.height * TILE_SIZE * 0.45 ? "underground" : "world");
  }

  // ---------- rendering ----------

  private Scale(): number {
    return this.width > 0 && window.innerWidth < 700 ? 1.25 : 1.5;
  }

  private Resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.floor(rect.width * ratio);
    const height = Math.floor(rect.height * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  private DrawLoading(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.fillStyle = "#1b1530";
    this.ctx.fillRect(0, 0, rect.width, rect.height);
    this.ctx.fillStyle = "#ffd166";
    this.ctx.font = "20px 'Pixelify Sans', monospace";
    this.ctx.textAlign = "center";
    this.ctx.fillText("Entering world...", rect.width / 2, rect.height / 2);
  }

  private ChunkCanvas(chunk_x: number, chunk_y: number): HTMLCanvasElement {
    const key = `${chunk_x},${chunk_y}`;
    let chunk = this.chunks.get(key);
    if (!chunk) {
      const canvas = document.createElement("canvas");
      canvas.width = CHUNK_SIZE * TILE_SIZE;
      canvas.height = CHUNK_SIZE * TILE_SIZE;
      chunk = { canvas, dirty: true };
      this.chunks.set(key, chunk);
    }
    if (chunk.dirty) {
      const ctx = chunk.canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, chunk.canvas.width, chunk.canvas.height);
      for (let y = 0; y < CHUNK_SIZE; y++) {
        const world_y = chunk_y * CHUNK_SIZE + y;
        if (world_y >= this.height) break;
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const world_x = chunk_x * CHUNK_SIZE + x;
          if (world_x >= this.width) break;
          const index = world_y * this.width + world_x;
          const fg = this.foreground[index];
          const fg_item = GetItem(fg);
          const bg = this.background[index];
          if (bg && (!fg || fg_item?.transparent)) {
            const texture = GetTexture(bg);
            if (texture) {
              ctx.drawImage(texture, x * TILE_SIZE, y * TILE_SIZE);
              ctx.fillStyle = "rgba(10, 6, 20, 0.45)";
              ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            }
          }
          if (fg && !this.trees.has(index) && fg_item?.kind !== "seed") {
            const texture = GetTexture(fg);
            if (texture) ctx.drawImage(texture, x * TILE_SIZE, y * TILE_SIZE);
            if (fg_item?.collision) this.OutlineExposed(ctx, world_x, world_y, x * TILE_SIZE, y * TILE_SIZE);
          }
        }
      }
      chunk.dirty = false;
    }
    return chunk.canvas;
  }

  // Dark edge on every side of a solid block that touches air, so terrain reads as shapes.
  private OutlineExposed(ctx: CanvasRenderingContext2D, world_x: number, world_y: number, px: number, py: number): void {
    const open = (x: number, y: number) => {
      if (x < 0 || x >= this.width || y < 0) return y < 0;
      if (y >= this.height) return false;
      return !(GetItem(this.foreground[y * this.width + x])?.collision ?? false);
    };
    ctx.fillStyle = "rgba(14, 10, 26, 0.85)";
    if (open(world_x, world_y - 1)) ctx.fillRect(px, py, TILE_SIZE, 2);
    if (open(world_x, world_y + 1)) ctx.fillRect(px, py + TILE_SIZE - 2, TILE_SIZE, 2);
    if (open(world_x - 1, world_y)) ctx.fillRect(px, py, 2, TILE_SIZE);
    if (open(world_x + 1, world_y)) ctx.fillRect(px + TILE_SIZE - 2, py, 2, TILE_SIZE);
  }

  private Draw(time: number): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.Scale();
    const view_width = rect.width / scale;
    const view_height = rect.height / scale;
    const world_px_width = this.width * TILE_SIZE;
    const world_px_height = this.height * TILE_SIZE;
    const target_x = this.body.x + PLAYER_WIDTH / 2 - view_width / 2;
    const target_y = this.body.y + PLAYER_HEIGHT / 2 - view_height / 2;
    this.camera.x = Math.max(0, Math.min(world_px_width - view_width, target_x));
    this.camera.y = Math.max(-TILE_SIZE * 4, Math.min(world_px_height - view_height, target_y));
    if (world_px_width < view_width) this.camera.x = (world_px_width - view_width) / 2;

    const [top, bottom] = SKIES[this.background_key] ?? SKIES.noon;
    const depth = Math.max(0, Math.min(1, (this.body.y / world_px_height - 0.35) * 2.5));
    const sky = ctx.createLinearGradient(0, 0, 0, rect.height);
    sky.addColorStop(0, top);
    sky.addColorStop(1, bottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, rect.width, rect.height);
    this.DrawHills(ctx, rect.width, rect.height);

    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-Math.round(this.camera.x), -Math.round(this.camera.y));
    const first_chunk_x = Math.max(0, Math.floor(this.camera.x / (CHUNK_SIZE * TILE_SIZE)));
    const last_chunk_x = Math.min(Math.ceil(this.width / CHUNK_SIZE) - 1, Math.floor((this.camera.x + view_width) / (CHUNK_SIZE * TILE_SIZE)));
    const first_chunk_y = Math.max(0, Math.floor(this.camera.y / (CHUNK_SIZE * TILE_SIZE)));
    const last_chunk_y = Math.min(Math.ceil(this.height / CHUNK_SIZE) - 1, Math.floor((this.camera.y + view_height) / (CHUNK_SIZE * TILE_SIZE)));
    for (let chunk_y = first_chunk_y; chunk_y <= last_chunk_y; chunk_y++) {
      for (let chunk_x = first_chunk_x; chunk_x <= last_chunk_x; chunk_x++) {
        ctx.drawImage(this.ChunkCanvas(chunk_x, chunk_y), chunk_x * CHUNK_SIZE * TILE_SIZE, chunk_y * CHUNK_SIZE * TILE_SIZE);
      }
    }

    const server_now = Date.now() + this.server_offset;
    for (const [index, tree] of this.trees) {
      const px = tree.x * TILE_SIZE;
      const py = tree.y * TILE_SIZE;
      if (px < this.camera.x - TILE_SIZE || px > this.camera.x + view_width || py < this.camera.y - TILE_SIZE || py > this.camera.y + view_height) continue;
      const stage = TreeStage(server_now - tree.planted_at, tree.grow_ms);
      const texture = GetTreeTexture(tree.item_id, stage);
      if (texture) ctx.drawImage(texture, px, py);
      if (stage === 4) {
        ctx.fillStyle = `rgba(255, 230, 120, ${0.25 + Math.sin(time / 300 + index) * 0.15})`;
        ctx.fillRect(px + 2, py - 3, TILE_SIZE - 4, 2);
      }
    }

    for (const [index, damage] of this.damage) {
      if (performance.now() - damage.at > 4000) {
        this.damage.delete(index);
        continue;
      }
      const x = (index % this.width) * TILE_SIZE;
      const y = Math.floor(index / this.width) * TILE_SIZE;
      const ratio = damage.hits / damage.needed;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < Math.ceil(ratio * 5); i++) {
        ctx.moveTo(x + 16, y + 16);
        ctx.lineTo(x + 16 + Math.cos(i * 1.3) * 14 * ratio, y + 16 + Math.sin(i * 1.3) * 14 * ratio);
      }
      ctx.stroke();
    }

    for (const drop of this.drops.values()) {
      const texture = GetTexture(drop.item_id);
      if (!texture) continue;
      const bob = Math.sin((time + drop.born) / 250) * 2;
      ctx.drawImage(texture, drop.x - 9, drop.y - 9 + bob, 18, 18);
      if (drop.quantity > 1) {
        ctx.fillStyle = "#fff";
        ctx.font = "9px monospace";
        ctx.textAlign = "left";
        ctx.fillText(String(drop.quantity), drop.x + 5, drop.y + 9 + bob);
      }
    }

    if (this.fishing) {
      const fx = (this.fishing.x + 0.5) * TILE_SIZE;
      const fy = this.fishing.y * TILE_SIZE + 6 + Math.sin(time / 200) * 2;
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.moveTo(this.body.x + PLAYER_WIDTH / 2, this.body.y + 8);
      ctx.lineTo(fx, fy);
      ctx.stroke();
      ctx.fillStyle = "#e63946";
      ctx.fillRect(fx - 3, fy - 3, 6, 6);
    }

    for (const player of this.remote.values()) this.DrawPlayer(player.x, player.y, player.appearance, player.facing, player.anim, player.username, player.level, time, player.bubble);
    const self = store.Get().player;
    if (self) this.DrawPlayer(this.body.x, this.body.y, self.appearance, this.facing, this.anim, self.username, self.level, time, this.my_bubble);

    for (const particle of this.particles) {
      ctx.globalAlpha = Math.max(0, particle.life);
      ctx.fillStyle = particle.color;
      ctx.fillRect(particle.x, particle.y, 3, 3);
    }
    ctx.globalAlpha = 1;

    const hovered = this.HoveredTile();
    if (hovered && !this.touch_active) {
      ctx.strokeStyle = this.InRange(hovered.x, hovered.y) ? "rgba(255, 220, 120, 0.9)" : "rgba(255, 90, 90, 0.6)";
      ctx.lineWidth = 2;
      ctx.strokeRect(hovered.x * TILE_SIZE + 1, hovered.y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    }
    ctx.restore();

    if (depth > 0) {
      const glow = ctx.createRadialGradient(rect.width / 2, rect.height / 2, 80, rect.width / 2, rect.height / 2, Math.max(rect.width, rect.height) * 0.7);
      glow.addColorStop(0, "rgba(5, 3, 12, 0)");
      glow.addColorStop(1, `rgba(5, 3, 12, ${0.65 * depth})`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, rect.width, rect.height);
    }
  }

  private DrawHills(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.fillStyle = "rgba(40, 30, 70, 0.25)";
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x += 20) ctx.lineTo(x, height * 0.55 + Math.sin((x + this.camera.x * 0.2) / 120) * 30);
    ctx.lineTo(width, height);
    ctx.fill();
  }

  private DrawPlayer(x: number, y: number, appearance: Appearance, facing: number, anim: string, username: string, level: number, time: number, bubble: { text: string; until: number } | null): void {
    const ctx = this.ctx;
    DrawCharacter(ctx, x, y, appearance, facing, anim, time);
    const title = appearance.title ? COSMETICS_BY_KEY.get(appearance.title) : undefined;
    ctx.font = "10px 'Pixelify Sans', monospace";
    ctx.textAlign = "center";
    const label = `${username} · ${level}`;
    const label_width = ctx.measureText(label).width + 8;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x + PLAYER_WIDTH / 2 - label_width / 2, y - 26, label_width, 13);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x + PLAYER_WIDTH / 2, y - 16);
    if (title && title.cosmetic_key !== "title_rookie") {
      ctx.fillStyle = title.color;
      ctx.font = "8px 'Pixelify Sans', monospace";
      ctx.fillText(title.name, x + PLAYER_WIDTH / 2, y - 29);
    }
    if (bubble && bubble.until > performance.now()) {
      ctx.font = "10px 'Pixelify Sans', monospace";
      const width = Math.min(180, ctx.measureText(bubble.text).width + 12);
      const bx = x + PLAYER_WIDTH / 2 - width / 2;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillRect(bx, y - 52, width, 18);
      ctx.fillStyle = "#1b1530";
      ctx.fillText(bubble.text.length > 30 ? `${bubble.text.slice(0, 29)}…` : bubble.text, x + PLAYER_WIDTH / 2, y - 39);
    }
  }
}
