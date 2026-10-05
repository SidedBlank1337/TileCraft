export type CosmeticSlot = "hair" | "hat" | "shirt" | "pants" | "shoes" | "accessory" | "title";

export interface CosmeticDefinition {
  cosmetic_key: string;
  name: string;
  slot: CosmeticSlot;
  price: number;
  color: string;
  style: string;
  default_owned?: boolean;
}

export const COSMETICS: CosmeticDefinition[] = [
  { cosmetic_key: "hair_buzz_brown", name: "Brown Buzz", slot: "hair", price: 0, color: "#5a3a20", style: "buzz", default_owned: true },
  { cosmetic_key: "hair_spiky_gold", name: "Golden Spikes", slot: "hair", price: 250, color: "#f2c14e", style: "spiky" },
  { cosmetic_key: "hair_bob_teal", name: "Teal Bob", slot: "hair", price: 250, color: "#2ec4b6", style: "bob" },
  { cosmetic_key: "hair_long_violet", name: "Violet Flow", slot: "hair", price: 400, color: "#9b5de5", style: "long" },
  { cosmetic_key: "hat_cap_red", name: "Red Cap", slot: "hat", price: 300, color: "#e63946", style: "cap" },
  { cosmetic_key: "hat_wizard", name: "Starweaver Hat", slot: "hat", price: 900, color: "#3a0ca3", style: "wizard" },
  { cosmetic_key: "hat_twig_crown", name: "Twig Crown", slot: "hat", price: 600, color: "#8a5a3b", style: "crown" },
  { cosmetic_key: "hat_top", name: "Velvet Top Hat", slot: "hat", price: 1200, color: "#1b1b1e", style: "top" },
  { cosmetic_key: "shirt_basic", name: "Plain Tunic", slot: "shirt", price: 0, color: "#4361ee", style: "basic", default_owned: true },
  { cosmetic_key: "shirt_forest", name: "Forest Vest", slot: "shirt", price: 200, color: "#2d6a4f", style: "basic" },
  { cosmetic_key: "shirt_sunset", name: "Sunset Shirt", slot: "shirt", price: 200, color: "#f3722c", style: "basic" },
  { cosmetic_key: "pants_basic", name: "Canvas Pants", slot: "pants", price: 0, color: "#3d405b", style: "basic", default_owned: true },
  { cosmetic_key: "pants_khaki", name: "Khaki Pants", slot: "pants", price: 150, color: "#b08968", style: "basic" },
  { cosmetic_key: "shoes_basic", name: "Worn Boots", slot: "shoes", price: 0, color: "#3a2414", style: "basic", default_owned: true },
  { cosmetic_key: "shoes_white", name: "Cloud Sneakers", slot: "shoes", price: 180, color: "#f1faee", style: "basic" },
  { cosmetic_key: "acc_scarf", name: "Cozy Scarf", slot: "accessory", price: 350, color: "#d62828", style: "scarf" },
  { cosmetic_key: "acc_goggles", name: "Delver Goggles", slot: "accessory", price: 0, color: "#ffb703", style: "goggles" },
  { cosmetic_key: "acc_cape_blue", name: "Azure Cape", slot: "accessory", price: 1500, color: "#219ebc", style: "cape" },
  { cosmetic_key: "title_rookie", name: "Rookie", slot: "title", price: 0, color: "#cccccc", style: "title", default_owned: true },
  { cosmetic_key: "title_wanderer", name: "Wanderer", slot: "title", price: 0, color: "#8ecae6", style: "title" },
  { cosmetic_key: "title_architect", name: "Architect", slot: "title", price: 0, color: "#ffb703", style: "title" },
  { cosmetic_key: "title_green_thumb", name: "Green Thumb", slot: "title", price: 0, color: "#80ed99", style: "title" },
  { cosmetic_key: "title_stonebreaker", name: "Stonebreaker", slot: "title", price: 0, color: "#adb5bd", style: "title" },
  { cosmetic_key: "title_merchant", name: "Merchant", slot: "title", price: 0, color: "#ffd166", style: "title" },
  { cosmetic_key: "title_tycoon", name: "Tycoon", slot: "title", price: 0, color: "#ffd700", style: "title" },
  { cosmetic_key: "title_angler", name: "Angler", slot: "title", price: 800, color: "#48cae4", style: "title" }
];

export const COSMETICS_BY_KEY = new Map(COSMETICS.map((cosmetic) => [cosmetic.cosmetic_key, cosmetic]));

export type Appearance = Partial<Record<CosmeticSlot, string>>;

export const DEFAULT_APPEARANCE: Appearance = {
  hair: "hair_buzz_brown",
  shirt: "shirt_basic",
  pants: "pants_basic",
  shoes: "shoes_basic",
  title: "title_rookie"
};
