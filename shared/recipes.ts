export interface RecipeDefinition {
  recipe_id: string;
  name: string;
  result_item_id: number;
  result_quantity: number;
  ingredients: { item_id: number; quantity: number }[];
  unlock_level: number;
  xp: number;
}

export const RECIPES: RecipeDefinition[] = [
  { recipe_id: "planks_from_log", name: "Saw Planks", result_item_id: 12, result_quantity: 4, ingredients: [{ item_id: 11, quantity: 1 }], unlock_level: 1, xp: 2 },
  { recipe_id: "glass_from_sand", name: "Melt Glass", result_item_id: 17, result_quantity: 2, ingredients: [{ item_id: 16, quantity: 3 }], unlock_level: 1, xp: 3 },
  { recipe_id: "brick_from_stone", name: "Fire Brick", result_item_id: 14, result_quantity: 2, ingredients: [{ item_id: 4, quantity: 2 }, { item_id: 23, quantity: 1 }], unlock_level: 2, xp: 4 },
  { recipe_id: "plank_wall", name: "Plank Wall", result_item_id: 51, result_quantity: 2, ingredients: [{ item_id: 12, quantity: 2 }], unlock_level: 1, xp: 1 },
  { recipe_id: "brick_wall", name: "Brick Wall", result_item_id: 52, result_quantity: 2, ingredients: [{ item_id: 14, quantity: 2 }], unlock_level: 3, xp: 3 },
  { recipe_id: "copper_ingot", name: "Smelt Copper", result_item_id: 210, result_quantity: 1, ingredients: [{ item_id: 7, quantity: 3 }], unlock_level: 1, xp: 6 },
  { recipe_id: "silver_ingot", name: "Smelt Silver", result_item_id: 211, result_quantity: 1, ingredients: [{ item_id: 8, quantity: 3 }], unlock_level: 4, xp: 12 },
  { recipe_id: "crystal_dust", name: "Grind Prism", result_item_id: 213, result_quantity: 3, ingredients: [{ item_id: 10, quantity: 1 }], unlock_level: 3, xp: 5 },
  { recipe_id: "copper_pick", name: "Copper Pick", result_item_id: 300, result_quantity: 1, ingredients: [{ item_id: 210, quantity: 3 }, { item_id: 12, quantity: 2 }], unlock_level: 2, xp: 25 },
  { recipe_id: "silver_pick", name: "Silver Pick", result_item_id: 301, result_quantity: 1, ingredients: [{ item_id: 211, quantity: 4 }, { item_id: 300, quantity: 1 }], unlock_level: 6, xp: 60 },
  { recipe_id: "moon_pick", name: "Lunar Pick", result_item_id: 302, result_quantity: 1, ingredients: [{ item_id: 9, quantity: 4 }, { item_id: 213, quantity: 3 }, { item_id: 301, quantity: 1 }], unlock_level: 10, xp: 150 },
  { recipe_id: "fishing_rod", name: "Reed Fishing Rod", result_item_id: 310, result_quantity: 1, ingredients: [{ item_id: 12, quantity: 3 }, { item_id: 210, quantity: 1 }], unlock_level: 2, xp: 15 },
  { recipe_id: "lantern", name: "Firefly Lantern", result_item_id: 21, result_quantity: 1, ingredients: [{ item_id: 15, quantity: 1 }, { item_id: 17, quantity: 1 }, { item_id: 210, quantity: 1 }], unlock_level: 3, xp: 10 },
  { recipe_id: "berry_tart", name: "Berry Tart", result_item_id: 230, result_quantity: 1, ingredients: [{ item_id: 200, quantity: 3 }, { item_id: 201, quantity: 1 }], unlock_level: 2, xp: 8 },
  { recipe_id: "rich_soil", name: "Compost Soil", result_item_id: 3, result_quantity: 2, ingredients: [{ item_id: 1, quantity: 2 }, { item_id: 13, quantity: 3 }], unlock_level: 1, xp: 3 }
];

export const RECIPES_BY_ID = new Map(RECIPES.map((recipe) => [recipe.recipe_id, recipe]));
