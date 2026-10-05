export const TILE_SIZE = 32;
export const CHUNK_SIZE = 32;
export const INVENTORY_SLOTS = 40;
export const HOTBAR_SLOTS = 9;
export const DEFAULT_MAX_STACK = 200;
export const INTERACT_RANGE_TILES = 2;
export const MIN_HIT_INTERVAL_MS = 170;
export const PLACE_COOLDOWN_MS = 90;
export const STARTING_COINS = 150;
export const MARKET_FEE_RATE = 0.05;
export const MARKET_LISTING_HOURS = 72;
export const MAX_LISTINGS_PER_PLAYER = 20;
export const CHAT_MAX_LENGTH = 160;
export const SESSION_DAYS = 14;
export const MAX_WORLDS_PER_PLAYER = 5;
export const DROP_PICKUP_RANGE_TILES = 2.5;
export const DROP_LIFETIME_MS = 30 * 60 * 1000;

export const WORLD_TYPES = ["public", "private", "farming", "trading", "adventure", "event"] as const;
export type WorldType = (typeof WORLD_TYPES)[number];

export const WORLD_SIZES = {
  small: { width: 100, height: 60 },
  medium: { width: 150, height: 80 },
  large: { width: 200, height: 100 }
} as const;
export type WorldSize = keyof typeof WORLD_SIZES;

export const WORLD_ROLES = ["owner", "admin", "builder", "member", "visitor", "banned"] as const;
export type WorldRole = (typeof WORLD_ROLES)[number];

export const BACKGROUNDS = ["dawn", "noon", "dusk", "night", "aurora"] as const;
export type BackgroundKey = (typeof BACKGROUNDS)[number];
