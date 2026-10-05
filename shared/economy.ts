export interface ShopEntry {
  item_id: number;
  price: number;
  daily_limit: number;
}

// Shop sells at a markup over the item's sell_price so buy-then-sell loses coins.
export const SHOP_ENTRIES: ShopEntry[] = [
  { item_id: 1, price: 4, daily_limit: 200 },
  { item_id: 12, price: 8, daily_limit: 200 },
  { item_id: 16, price: 4, daily_limit: 200 },
  { item_id: 23, price: 6, daily_limit: 100 },
  { item_id: 17, price: 14, daily_limit: 100 },
  { item_id: 130, price: 12, daily_limit: 50 },
  { item_id: 131, price: 35, daily_limit: 20 },
  { item_id: 111, price: 10, daily_limit: 50 },
  { item_id: 101, price: 5, daily_limit: 50 },
  { item_id: 3, price: 18, daily_limit: 60 },
  { item_id: 310, price: 250, daily_limit: 2 },
  { item_id: 300, price: 450, daily_limit: 2 },
  { item_id: 21, price: 110, daily_limit: 20 },
  { item_id: 51, price: 9, daily_limit: 200 }
];

export const SHOP_BY_ITEM = new Map(SHOP_ENTRIES.map((entry) => [entry.item_id, entry]));

export interface EventEffects {
  xp_multiplier: number;
  drop_multiplier: number;
  growth_multiplier: number;
  coin_multiplier: number;
  treasure_bonus: number;
  meteor_chance: number;
}

export interface EventDefinition {
  event_key: string;
  name: string;
  description: string;
  effects: Partial<EventEffects>;
}

export const EVENT_DEFINITIONS: EventDefinition[] = [
  { event_key: "double_xp", name: "Double XP Weekend", description: "All XP gains are doubled.", effects: { xp_multiplier: 2 } },
  { event_key: "mining_rush", name: "Mining Rush", description: "Ore veins pay double coins and drop extra ore.", effects: { drop_multiplier: 2, coin_multiplier: 2 } },
  { event_key: "farming_festival", name: "Farming Festival", description: "Trees grow twice as fast.", effects: { growth_multiplier: 2 } },
  { event_key: "treasure_hunt", name: "Treasure Hunt", description: "Breaking stone can reveal coin pouches.", effects: { treasure_bonus: 0.04 } },
  { event_key: "meteor_shower", name: "Meteor Shower", description: "Stone sometimes contains Moon Shards.", effects: { meteor_chance: 0.03 } },
  { event_key: "harvest_moon", name: "Harvest Moon", description: "Seasonal: more XP and faster growth.", effects: { xp_multiplier: 1.5, growth_multiplier: 1.5 } }
];

export const EVENTS_BY_KEY = new Map(EVENT_DEFINITIONS.map((event) => [event.event_key, event]));

export const NEUTRAL_EFFECTS: EventEffects = {
  xp_multiplier: 1, drop_multiplier: 1, growth_multiplier: 1, coin_multiplier: 1, treasure_bonus: 0, meteor_chance: 0
};

export function MergeEffects(list: Partial<EventEffects>[]): EventEffects {
  const merged = { ...NEUTRAL_EFFECTS };
  for (const effects of list) {
    merged.xp_multiplier *= effects.xp_multiplier ?? 1;
    merged.drop_multiplier *= effects.drop_multiplier ?? 1;
    merged.growth_multiplier *= effects.growth_multiplier ?? 1;
    merged.coin_multiplier *= effects.coin_multiplier ?? 1;
    merged.treasure_bonus += effects.treasure_bonus ?? 0;
    merged.meteor_chance += effects.meteor_chance ?? 0;
  }
  return merged;
}

export interface TriviaQuestion {
  question: string;
  answers: string[];
  correct_index: number;
}

export const TRIVIA_QUESTIONS: TriviaQuestion[] = [
  { question: "Which tool tier is needed to mine Moonstone?", answers: ["None", "Copper", "Silver", "Lunar"], correct_index: 2 },
  { question: "What do trees on Rich Soil do?", answers: ["Grow faster", "Drop coins", "Glow", "Nothing"], correct_index: 0 },
  { question: "How many Copper Veins make one Copper Ingot?", answers: ["1", "2", "3", "5"], correct_index: 2 },
  { question: "Where can you fish?", answers: ["Glass", "Still Water", "Leaves", "Sand"], correct_index: 1 },
  { question: "What is the marketplace fee?", answers: ["1%", "5%", "10%", "None"], correct_index: 1 },
  { question: "Which block can never be broken?", answers: ["Greystone", "Core Rock", "Oak Plank", "Clay"], correct_index: 1 },
  { question: "What does a Berry Tart give when eaten?", answers: ["Coins", "Seeds", "XP", "A hat"], correct_index: 2 },
  { question: "How many players must confirm a trade?", answers: ["One", "Both", "An admin", "None"], correct_index: 1 }
];
