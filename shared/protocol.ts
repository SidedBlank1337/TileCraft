import type { Appearance } from "./cosmetics.ts";

export const CLIENT_EVENTS = [
  "join_world", "leave_world", "player_move", "block_hit", "block_place", "item_pickup", "item_drop",
  "interact", "chat_send", "trade_request", "trade_respond", "trade_offer", "trade_confirm", "trade_cancel", "ping"
] as const;
export type ClientEventName = (typeof CLIENT_EVENTS)[number];

export interface ClientMessage {
  event: ClientEventName;
  data: Record<string, unknown>;
}

export interface PublicPlayer {
  player_id: number;
  username: string;
  x: number;
  y: number;
  facing: number;
  anim: string;
  level: number;
  appearance: Appearance;
  role: string;
}

export interface DropView {
  drop_id: string;
  item_id: number;
  quantity: number;
  x: number;
  y: number;
}

export interface TreeView {
  x: number;
  y: number;
  item_id: number;
  planted_at: number;
  grow_ms: number;
}

export interface WorldStateView {
  world_id: number;
  world_name: string;
  owner_name: string;
  width: number;
  height: number;
  background: string;
  spawn_x: number;
  spawn_y: number;
  foreground: string;
  background_tiles: string;
  trees: TreeView[];
  drops: DropView[];
  players: PublicPlayer[];
  your_role: string;
  can_build: boolean;
  settings: WorldSettings;
  server_time: number;
}

export interface WorldSettings {
  visitors_can_build: boolean;
  members_can_build: boolean;
  allow_drops: boolean;
  chat_enabled: boolean;
  pvp_enabled: boolean;
}

export const DEFAULT_WORLD_SETTINGS: WorldSettings = {
  visitors_can_build: false,
  members_can_build: true,
  allow_drops: true,
  chat_enabled: true,
  pvp_enabled: false
};

export interface InventorySlot {
  slot_index: number;
  item_id: number;
  quantity: number;
}

export interface PlayerSelfView {
  player_id: number;
  username: string;
  coins: number;
  xp_into_level: number;
  xp_needed: number;
  lifetime_xp: number;
  level: number;
  is_admin: boolean;
  is_guest: boolean;
  appearance: Appearance;
}

export interface TradeOfferView {
  player_id: number;
  username: string;
  items: { item_id: number; quantity: number }[];
  coins: number;
  confirmed: boolean;
}

export interface TradeStateView {
  trade_id: string;
  status: "pending" | "open" | "locked";
  sides: TradeOfferView[];
}

// Base64 helpers shared by server and browser for compact tile arrays.
export function EncodeTiles(tiles: Uint16Array): string {
  const bytes = new Uint8Array(tiles.buffer, tiles.byteOffset, tiles.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function DecodeTiles(encoded: string, length: number): Uint16Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const tiles = new Uint16Array(length);
  tiles.set(new Uint16Array(bytes.buffer, 0, Math.min(length, bytes.length / 2)));
  return tiles;
}
