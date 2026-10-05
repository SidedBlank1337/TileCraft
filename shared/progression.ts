export interface Reward {
  coins?: number;
  xp?: number;
  items?: { item_id: number; quantity: number }[];
  cosmetic_key?: string;
}

export interface QuestDefinition {
  quest_key: string;
  name: string;
  description: string;
  stat_key: string;
  goal: number;
  reward: Reward;
}

export interface AchievementDefinition {
  achievement_key: string;
  name: string;
  description: string;
  stat_key: string;
  goal: number;
  reward: Reward;
}

export const STAT_KEYS = [
  "blocks_broken", "blocks_placed", "items_collected", "trees_planted", "trees_harvested", "items_crafted",
  "worlds_visited", "worlds_created", "coins_earned", "trades_completed", "market_sales", "market_purchases",
  "fish_caught", "treasures_found", "rare_locations", "chat_messages", "friends_made", "ores_mined",
  "trivia_correct", "shop_purchases", "level"
] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export const QUESTS: QuestDefinition[] = [
  { quest_key: "break_100", name: "Clearing the Way", description: "Break 100 blocks.", stat_key: "blocks_broken", goal: 100, reward: { coins: 200, xp: 150 } },
  { quest_key: "place_50", name: "Foundations", description: "Place 50 blocks.", stat_key: "blocks_placed", goal: 50, reward: { coins: 120, xp: 100, items: [{ item_id: 12, quantity: 20 }] } },
  { quest_key: "plant_10", name: "Seed Scatterer", description: "Plant 10 seeds.", stat_key: "trees_planted", goal: 10, reward: { coins: 100, xp: 120, items: [{ item_id: 131, quantity: 2 }] } },
  { quest_key: "harvest_10", name: "First Harvest", description: "Harvest 10 grown trees.", stat_key: "trees_harvested", goal: 10, reward: { coins: 250, xp: 200, items: [{ item_id: 3, quantity: 10 }] } },
  { quest_key: "craft_5", name: "Tinkerer", description: "Craft 5 items.", stat_key: "items_crafted", goal: 5, reward: { coins: 150, xp: 120 } },
  { quest_key: "visit_3", name: "Wanderer", description: "Visit 3 different worlds.", stat_key: "worlds_visited", goal: 3, reward: { coins: 150, xp: 150, cosmetic_key: "title_wanderer" } },
  { quest_key: "earn_1000", name: "Pocket Change", description: "Earn 1,000 coins.", stat_key: "coins_earned", goal: 1000, reward: { xp: 300, cosmetic_key: "hat_cap_red" } },
  { quest_key: "collect_50", name: "Gatherer", description: "Collect 50 dropped items.", stat_key: "items_collected", goal: 50, reward: { coins: 120, xp: 100 } },
  { quest_key: "find_shrine", name: "Echoes Below", description: "Discover a Whispering Shrine.", stat_key: "rare_locations", goal: 1, reward: { coins: 500, xp: 400, cosmetic_key: "acc_goggles" } },
  { quest_key: "fish_10", name: "Patient Angler", description: "Catch 10 fish.", stat_key: "fish_caught", goal: 10, reward: { coins: 300, xp: 250 } },
  { quest_key: "mine_40", name: "Vein Seeker", description: "Mine 40 ore veins.", stat_key: "ores_mined", goal: 40, reward: { coins: 300, xp: 300, items: [{ item_id: 210, quantity: 3 }] } }
];

export const ACHIEVEMENTS: AchievementDefinition[] = [
  { achievement_key: "first_block", name: "First Block", description: "Break your first block.", stat_key: "blocks_broken", goal: 1, reward: { coins: 20, xp: 20 } },
  { achievement_key: "first_world", name: "Worldsmith", description: "Create your first world.", stat_key: "worlds_created", goal: 1, reward: { coins: 50, xp: 50 } },
  { achievement_key: "master_builder", name: "Master Builder", description: "Place 1,000 blocks.", stat_key: "blocks_placed", goal: 1000, reward: { coins: 1000, xp: 1000, cosmetic_key: "title_architect" } },
  { achievement_key: "farmer", name: "Farmer", description: "Harvest 50 trees.", stat_key: "trees_harvested", goal: 50, reward: { coins: 500, xp: 500, cosmetic_key: "title_green_thumb" } },
  { achievement_key: "miner", name: "Miner", description: "Mine 200 ore veins.", stat_key: "ores_mined", goal: 200, reward: { coins: 800, xp: 800, cosmetic_key: "title_stonebreaker" } },
  { achievement_key: "trader", name: "Trader", description: "Complete 5 player trades.", stat_key: "trades_completed", goal: 5, reward: { coins: 300, xp: 300, cosmetic_key: "title_merchant" } },
  { achievement_key: "millionaire", name: "Millionaire", description: "Earn 1,000,000 coins in total.", stat_key: "coins_earned", goal: 1_000_000, reward: { xp: 5000, cosmetic_key: "title_tycoon" } },
  { achievement_key: "explorer", name: "Explorer", description: "Visit 10 different worlds.", stat_key: "worlds_visited", goal: 10, reward: { coins: 400, xp: 400, cosmetic_key: "acc_cape_blue" } },
  { achievement_key: "collector", name: "Collector", description: "Pick up 500 items.", stat_key: "items_collected", goal: 500, reward: { coins: 400, xp: 400 } },
  { achievement_key: "social_player", name: "Social Player", description: "Make 3 friends.", stat_key: "friends_made", goal: 3, reward: { coins: 200, xp: 200, cosmetic_key: "acc_scarf" } },
  { achievement_key: "treasure_hunter", name: "Treasure Hunter", description: "Open 5 buried chests.", stat_key: "treasures_found", goal: 5, reward: { coins: 500, xp: 500 } },
  { achievement_key: "seller", name: "Shopkeeper", description: "Sell 10 marketplace listings.", stat_key: "market_sales", goal: 10, reward: { coins: 300, xp: 300 } }
];
