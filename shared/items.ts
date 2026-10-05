export type ItemKind = "air" | "block" | "background" | "seed" | "tool" | "material" | "fruit" | "consumable";
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type TexturePattern =
  | "noise" | "grass" | "ore" | "brick" | "plank" | "log" | "leaf" | "crystal" | "glass" | "moss"
  | "water" | "chest" | "beacon" | "sand" | "lantern" | "shrine" | "core" | "wall" | "seed" | "icon";

export interface DropEntry {
  item_id: number;
  chance: number;
  min: number;
  max: number;
}

export interface TreeDefinition {
  grow_ms: number;
  yield_item_id: number;
  yield_min: number;
  yield_max: number;
  seed_return_chance: number;
}

export interface ItemDefinition {
  item_id: number;
  item_key: string;
  name: string;
  kind: ItemKind;
  category: string;
  rarity: Rarity;
  hardness: number;
  collision: boolean;
  transparent: boolean;
  breakable: boolean;
  placeable: boolean;
  required_tool_tier: number;
  tool_tier: number;
  max_stack: number;
  sell_price: number;
  xp_on_break: number;
  coins_on_break: number;
  drops: DropEntry[];
  seed_id: number | null;
  tree: TreeDefinition | null;
  palette: [string, string, string];
  pattern: TexturePattern;
  description: string;
  use_xp?: number;
  light?: boolean;
}

type ItemInput = Partial<ItemDefinition> & Pick<ItemDefinition, "item_id" | "item_key" | "name" | "kind" | "palette" | "pattern">;

function DefineItem(input: ItemInput): ItemDefinition {
  const is_tile = input.kind === "block" || input.kind === "background";
  return {
    category: input.kind,
    rarity: "common",
    hardness: 3,
    collision: input.kind === "block",
    transparent: input.kind !== "block",
    breakable: true,
    placeable: is_tile || input.kind === "seed",
    required_tool_tier: 0,
    tool_tier: 0,
    max_stack: 200,
    sell_price: 1,
    xp_on_break: is_tile ? 1 : 0,
    coins_on_break: 0,
    drops: is_tile ? [{ item_id: input.item_id, chance: 1, min: 1, max: 1 }] : [],
    seed_id: null,
    tree: null,
    description: "",
    ...input
  };
}

export const AIR_ID = 0;

export const ITEM_LIST: ItemDefinition[] = [
  DefineItem({ item_id: 0, item_key: "air", name: "Air", kind: "air", palette: ["#000", "#000", "#000"], pattern: "noise", breakable: false, placeable: false, drops: [] }),

  DefineItem({ item_id: 1, item_key: "dirt_block", name: "Loam Dirt", kind: "block", palette: ["#8a5a3b", "#6b4329", "#a87150"], pattern: "noise", hardness: 3, seed_id: 101, sell_price: 1, description: "Soft brown earth." }),
  DefineItem({ item_id: 2, item_key: "grass_block", name: "Meadow Turf", kind: "block", palette: ["#8a5a3b", "#4f9d3a", "#78c955"], pattern: "grass", hardness: 3, seed_id: 101, drops: [{ item_id: 1, chance: 1, min: 1, max: 1 }], description: "Dirt topped with springy grass." }),
  DefineItem({ item_id: 3, item_key: "rich_soil", name: "Rich Soil", kind: "block", palette: ["#4a2f22", "#33201a", "#6a4532"], pattern: "noise", hardness: 3, sell_price: 4, rarity: "uncommon", description: "Trees planted on it grow 25% faster." }),
  DefineItem({ item_id: 4, item_key: "stone_block", name: "Greystone", kind: "block", palette: ["#80858c", "#5f646b", "#a2a7ad"], pattern: "noise", hardness: 5, seed_id: 104, sell_price: 2, xp_on_break: 2 }),
  DefineItem({ item_id: 5, item_key: "deep_stone", name: "Slatestone", kind: "block", palette: ["#4b4f5a", "#363944", "#626775"], pattern: "noise", hardness: 7, sell_price: 3, xp_on_break: 3 }),
  DefineItem({ item_id: 6, item_key: "core_rock", name: "Core Rock", kind: "block", palette: ["#1d1b26", "#100f16", "#2e2a3d"], pattern: "core", breakable: false, placeable: false, drops: [], description: "The unbreakable floor of every world." }),
  DefineItem({ item_id: 7, item_key: "copper_ore", name: "Copper Vein", kind: "block", palette: ["#80858c", "#c46b32", "#f0a060"], pattern: "ore", hardness: 6, sell_price: 8, xp_on_break: 4, coins_on_break: 1, rarity: "uncommon" }),
  DefineItem({ item_id: 8, item_key: "silver_ore", name: "Silver Vein", kind: "block", palette: ["#5f646b", "#c9d3dd", "#ffffff"], pattern: "ore", hardness: 8, required_tool_tier: 1, sell_price: 18, xp_on_break: 7, coins_on_break: 2, rarity: "rare" }),
  DefineItem({ item_id: 9, item_key: "moonstone", name: "Moonstone", kind: "block", palette: ["#2c2f4a", "#8fa8ff", "#e4ecff"], pattern: "crystal", hardness: 10, required_tool_tier: 2, sell_price: 45, xp_on_break: 14, coins_on_break: 5, rarity: "epic", light: true }),
  DefineItem({ item_id: 10, item_key: "crystal_block", name: "Prism Crystal", kind: "block", palette: ["#5b2a86", "#c77dff", "#f3d6ff"], pattern: "crystal", hardness: 8, required_tool_tier: 1, seed_id: 110, sell_price: 25, xp_on_break: 8, rarity: "rare", light: true }),
  DefineItem({ item_id: 11, item_key: "wood_log", name: "Oakwood Log", kind: "block", palette: ["#7a5230", "#5a3a20", "#a2754a"], pattern: "log", hardness: 4, seed_id: 111, sell_price: 3 }),
  DefineItem({ item_id: 12, item_key: "wooden_plank", name: "Oak Plank", kind: "block", palette: ["#b98a52", "#8f6638", "#d6a96c"], pattern: "plank", hardness: 3, seed_id: 112, sell_price: 2 }),
  DefineItem({ item_id: 13, item_key: "leaf_block", name: "Canopy Leaves", kind: "block", palette: ["#2f7d32", "#1f5a22", "#55a858"], pattern: "leaf", hardness: 1, transparent: true, drops: [{ item_id: 13, chance: 1, min: 1, max: 1 }, { item_id: 130, chance: 0.08, min: 1, max: 1 }], sell_price: 1 }),
  DefineItem({ item_id: 14, item_key: "ancient_brick", name: "Ancient Brick", kind: "block", palette: ["#8c4a3c", "#5e2e25", "#b8705e"], pattern: "brick", hardness: 6, sell_price: 6, rarity: "uncommon" }),
  DefineItem({ item_id: 15, item_key: "glowing_moss", name: "Glowcap Moss", kind: "block", palette: ["#24433a", "#3ee0a0", "#b5ffe0"], pattern: "moss", hardness: 2, seed_id: 115, sell_price: 5, rarity: "uncommon", light: true }),
  DefineItem({ item_id: 16, item_key: "sand_block", name: "Dune Sand", kind: "block", palette: ["#e2c27a", "#c7a45c", "#f5dc9c"], pattern: "sand", hardness: 2, sell_price: 1 }),
  DefineItem({ item_id: 17, item_key: "glass_pane", name: "Clear Glass", kind: "block", palette: ["#bfe8ff", "#7fbfe0", "#ffffff"], pattern: "glass", hardness: 2, transparent: true, sell_price: 4 }),
  DefineItem({ item_id: 18, item_key: "water_pool", name: "Still Water", kind: "block", palette: ["#2f6fd1", "#1f4fa0", "#5f9ff0"], pattern: "water", collision: false, transparent: true, hardness: 1, drops: [], sell_price: 0, description: "Cast a fishing rod here." }),
  DefineItem({ item_id: 19, item_key: "home_beacon", name: "Home Beacon", kind: "block", palette: ["#3a2a5a", "#ffd166", "#fff3c4"], pattern: "beacon", collision: false, breakable: false, placeable: false, drops: [], light: true, description: "Marks the world spawn." }),
  DefineItem({ item_id: 20, item_key: "buried_chest", name: "Buried Chest", kind: "block", palette: ["#6b4226", "#e0b040", "#3a2414"], pattern: "chest", hardness: 4, placeable: false, drops: [{ item_id: 212, chance: 0.3, min: 1, max: 2 }], coins_on_break: 120, xp_on_break: 40, rarity: "rare", description: "Something rattles inside." }),
  DefineItem({ item_id: 21, item_key: "lantern_block", name: "Firefly Lantern", kind: "block", palette: ["#3a2a1a", "#ffcc55", "#fff6c8"], pattern: "lantern", hardness: 2, collision: false, transparent: true, sell_price: 30, light: true, rarity: "uncommon" }),
  DefineItem({ item_id: 22, item_key: "ancient_shrine", name: "Whispering Shrine", kind: "block", palette: ["#3b3f63", "#9ef0ff", "#ffffff"], pattern: "shrine", collision: false, breakable: false, placeable: false, drops: [], light: true, rarity: "legendary", description: "A rare location. Touch it to record your discovery." }),
  DefineItem({ item_id: 23, item_key: "clay_block", name: "River Clay", kind: "block", palette: ["#a67f6d", "#8a6656", "#c49c89"], pattern: "noise", hardness: 3, sell_price: 2 }),

  DefineItem({ item_id: 50, item_key: "cave_wall", name: "Cave Wall", kind: "background", palette: ["#3a3530", "#2a2622", "#4a443d"], pattern: "wall", hardness: 2, sell_price: 1 }),
  DefineItem({ item_id: 51, item_key: "plank_wall", name: "Plank Wall", kind: "background", palette: ["#7a5a36", "#5e4428", "#946f45"], pattern: "plank", hardness: 2, sell_price: 2 }),
  DefineItem({ item_id: 52, item_key: "brick_wall", name: "Brick Wall", kind: "background", palette: ["#5e3a32", "#432822", "#7a4c42"], pattern: "brick", hardness: 3, sell_price: 6 }),

  DefineItem({ item_id: 101, item_key: "dirt_seed", name: "Loam Sprout Seed", kind: "seed", palette: ["#8a5a3b", "#4f9d3a", "#c9a07a"], pattern: "seed", tree: { grow_ms: 60_000, yield_item_id: 1, yield_min: 2, yield_max: 4, seed_return_chance: 0.6 }, sell_price: 1 }),
  DefineItem({ item_id: 104, item_key: "stone_seed", name: "Pebble Pod", kind: "seed", palette: ["#80858c", "#4f9d3a", "#c0c4c8"], pattern: "seed", tree: { grow_ms: 120_000, yield_item_id: 4, yield_min: 2, yield_max: 4, seed_return_chance: 0.6 }, sell_price: 2 }),
  DefineItem({ item_id: 110, item_key: "crystal_seed", name: "Prism Bulb", kind: "seed", palette: ["#c77dff", "#4f9d3a", "#f3d6ff"], pattern: "seed", rarity: "rare", tree: { grow_ms: 600_000, yield_item_id: 10, yield_min: 1, yield_max: 3, seed_return_chance: 0.5 }, sell_price: 15 }),
  DefineItem({ item_id: 111, item_key: "log_seed", name: "Acorn", kind: "seed", palette: ["#7a5230", "#4f9d3a", "#a2754a"], pattern: "seed", tree: { grow_ms: 90_000, yield_item_id: 11, yield_min: 2, yield_max: 5, seed_return_chance: 0.6 }, sell_price: 2 }),
  DefineItem({ item_id: 112, item_key: "plank_seed", name: "Plankwood Cone", kind: "seed", palette: ["#d6a96c", "#4f9d3a", "#f0d0a0"], pattern: "seed", tree: { grow_ms: 90_000, yield_item_id: 12, yield_min: 3, yield_max: 6, seed_return_chance: 0.6 }, sell_price: 2 }),
  DefineItem({ item_id: 115, item_key: "moss_seed", name: "Glowcap Spore", kind: "seed", palette: ["#3ee0a0", "#4f9d3a", "#b5ffe0"], pattern: "seed", rarity: "uncommon", tree: { grow_ms: 240_000, yield_item_id: 15, yield_min: 2, yield_max: 4, seed_return_chance: 0.5 }, sell_price: 4 }),
  DefineItem({ item_id: 130, item_key: "sunberry_seed", name: "Sunberry Seed", kind: "seed", palette: ["#ff9f1c", "#4f9d3a", "#ffd166"], pattern: "seed", tree: { grow_ms: 180_000, yield_item_id: 200, yield_min: 3, yield_max: 6, seed_return_chance: 0.8 }, sell_price: 3 }),
  DefineItem({ item_id: 131, item_key: "frostpear_seed", name: "Frostpear Seed", kind: "seed", palette: ["#9be7ff", "#4f9d3a", "#e0faff"], pattern: "seed", rarity: "uncommon", tree: { grow_ms: 360_000, yield_item_id: 201, yield_min: 2, yield_max: 4, seed_return_chance: 0.7 }, sell_price: 8 }),

  DefineItem({ item_id: 200, item_key: "sunberry", name: "Sunberry", kind: "fruit", palette: ["#ff9f1c", "#c46b00", "#ffd166"], pattern: "icon", sell_price: 6, placeable: false }),
  DefineItem({ item_id: 201, item_key: "frost_pear", name: "Frost Pear", kind: "fruit", palette: ["#9be7ff", "#4fa8c8", "#e0faff"], pattern: "icon", sell_price: 14, rarity: "uncommon", placeable: false }),
  DefineItem({ item_id: 210, item_key: "copper_ingot", name: "Copper Ingot", kind: "material", palette: ["#c46b32", "#8a4520", "#f0a060"], pattern: "icon", sell_price: 30, placeable: false }),
  DefineItem({ item_id: 211, item_key: "silver_ingot", name: "Silver Ingot", kind: "material", palette: ["#c9d3dd", "#8a96a3", "#ffffff"], pattern: "icon", sell_price: 65, rarity: "uncommon", placeable: false }),
  DefineItem({ item_id: 212, item_key: "moon_shard", name: "Moon Shard", kind: "material", palette: ["#8fa8ff", "#4a5ab0", "#e4ecff"], pattern: "icon", sell_price: 40, rarity: "rare", placeable: false }),
  DefineItem({ item_id: 213, item_key: "crystal_dust", name: "Prism Dust", kind: "material", palette: ["#c77dff", "#7a3ab0", "#f3d6ff"], pattern: "icon", sell_price: 14, rarity: "uncommon", placeable: false }),
  DefineItem({ item_id: 220, item_key: "river_minnow", name: "River Minnow", kind: "material", category: "fish", palette: ["#7fb0c8", "#4a7a90", "#c8e8f8"], pattern: "icon", sell_price: 10, placeable: false }),
  DefineItem({ item_id: 221, item_key: "glass_carp", name: "Glass Carp", kind: "material", category: "fish", palette: ["#bfe8ff", "#6fa8c8", "#ffffff"], pattern: "icon", sell_price: 28, rarity: "uncommon", placeable: false }),
  DefineItem({ item_id: 222, item_key: "star_eel", name: "Star Eel", kind: "material", category: "fish", palette: ["#3b3f8a", "#ffd166", "#9ef0ff"], pattern: "icon", sell_price: 90, rarity: "rare", placeable: false }),
  DefineItem({ item_id: 230, item_key: "berry_tart", name: "Berry Tart", kind: "consumable", palette: ["#d9534f", "#a03030", "#ffd166"], pattern: "icon", sell_price: 20, use_xp: 120, placeable: false, description: "Eat it for 120 XP." }),

  DefineItem({ item_id: 300, item_key: "copper_pick", name: "Copper Pick", kind: "tool", palette: ["#c46b32", "#7a5230", "#f0a060"], pattern: "icon", tool_tier: 1, max_stack: 1, sell_price: 80, placeable: false, description: "Mines faster. Breaks Silver Veins and Prism Crystal." }),
  DefineItem({ item_id: 301, item_key: "silver_pick", name: "Silver Pick", kind: "tool", palette: ["#c9d3dd", "#7a5230", "#ffffff"], pattern: "icon", tool_tier: 2, max_stack: 1, sell_price: 220, rarity: "uncommon", placeable: false, description: "Mines Moonstone." }),
  DefineItem({ item_id: 302, item_key: "moon_pick", name: "Lunar Pick", kind: "tool", palette: ["#8fa8ff", "#3b3f63", "#e4ecff"], pattern: "icon", tool_tier: 3, max_stack: 1, sell_price: 600, rarity: "epic", placeable: false, description: "The fastest pick there is." }),
  DefineItem({ item_id: 310, item_key: "fishing_rod", name: "Reed Fishing Rod", kind: "tool", category: "rod", palette: ["#b98a52", "#5a3a20", "#e0e0e0"], pattern: "icon", max_stack: 1, sell_price: 60, placeable: false, description: "Select it and click Still Water to fish." })
];

export const ITEMS_BY_ID = new Map<number, ItemDefinition>(ITEM_LIST.map((item) => [item.item_id, item]));
export const ITEMS_BY_KEY = new Map<string, ItemDefinition>(ITEM_LIST.map((item) => [item.item_key, item]));

export function GetItem(item_id: number): ItemDefinition | undefined {
  return ITEMS_BY_ID.get(item_id);
}

export function ItemIdByKey(item_key: string): number {
  const item = ITEMS_BY_KEY.get(item_key);
  if (!item) throw new Error(`Unknown item key ${item_key}`);
  return item.item_id;
}

export function IsValidItemId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && ITEMS_BY_ID.has(value);
}

export function HitsToBreak(item: ItemDefinition, tool_tier: number): number {
  return Math.max(1, Math.ceil(item.hardness * (1 - 0.22 * tool_tier)));
}

export function TreeStage(elapsed_ms: number, grow_ms: number): number {
  const ratio = elapsed_ms / grow_ms;
  if (ratio >= 1) return 4;
  if (ratio >= 0.66) return 3;
  if (ratio >= 0.33) return 2;
  if (ratio >= 0.1) return 1;
  return 0;
}

export const TREE_STAGE_NAMES = ["seed", "sprout", "young", "mature", "harvestable"];
