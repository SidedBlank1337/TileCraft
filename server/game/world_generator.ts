import type { WorldType } from "../../shared/constants.ts";

const T = {
  air: 0, dirt: 1, grass: 2, rich_soil: 3, stone: 4, deep_stone: 5, core: 6, copper: 7, silver: 8, moonstone: 9,
  crystal: 10, log: 11, leaf: 13, moss: 15, sand: 16, water: 18, beacon: 19, chest: 20, shrine: 22, clay: 23, cave_wall: 50
};

export function CreateRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function Hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function Smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function ValueNoise2(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = Smooth(x - x0);
  const fy = Smooth(y - y0);
  const top = Hash2(seed, x0, y0) * (1 - fx) + Hash2(seed, x0 + 1, y0) * fx;
  const bottom = Hash2(seed, x0, y0 + 1) * (1 - fx) + Hash2(seed, x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

function Fractal(seed: number, x: number, y: number, octaves: number): number {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += ValueNoise2(seed + i * 1013, x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / norm;
}

export interface GeneratedWorld {
  foreground: Uint16Array;
  background: Uint16Array;
  spawn_x: number;
  spawn_y: number;
}

const TYPE_PROFILE: Record<WorldType, { hills: number; caves: number; ores: number; trees: number; water: number }> = {
  public: { hills: 6, caves: 1, ores: 1, trees: 1, water: 1 },
  private: { hills: 6, caves: 1, ores: 1, trees: 1, water: 1 },
  farming: { hills: 3, caves: 0.6, ores: 0.7, trees: 1.6, water: 1.4 },
  trading: { hills: 1.5, caves: 0.5, ores: 0.6, trees: 0.6, water: 0.5 },
  adventure: { hills: 11, caves: 1.6, ores: 1.5, trees: 1, water: 0.8 },
  event: { hills: 5, caves: 1.2, ores: 1.3, trees: 1.2, water: 1 }
};

// Deterministic: the same (width, height, seed, type) always yields the same world.
export function GenerateWorld(width: number, height: number, seed: number, world_type: WorldType): GeneratedWorld {
  const profile = TYPE_PROFILE[world_type];
  const rng = CreateRng(seed);
  const foreground = new Uint16Array(width * height);
  const background = new Uint16Array(width * height);
  const index = (x: number, y: number) => y * width + x;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;

  const base = Math.floor(height * 0.32);
  const surface: number[] = [];
  for (let x = 0; x < width; x++) {
    const noise = Fractal(seed, x / 28, 0.5, 4) - 0.5;
    surface.push(Math.max(8, Math.min(height - 20, Math.round(base + noise * profile.hills * 2.4))));
  }

  const spawn_x = Math.floor(width / 2);
  // Flatten a pad around spawn so new players never land in a pit.
  const pad_height = surface[spawn_x];
  for (let x = spawn_x - 4; x <= spawn_x + 4; x++) if (x >= 0 && x < width) surface[x] = pad_height;

  const deep_start = Math.floor(height * 0.62);
  for (let x = 0; x < width; x++) {
    const top = surface[x];
    const dirt_depth = 3 + Math.floor(Hash2(seed + 7, x, 0) * 3);
    for (let y = top; y < height; y++) {
      let tile = T.stone;
      if (y === top) tile = T.grass;
      else if (y <= top + dirt_depth) tile = Fractal(seed + 31, x / 6, y / 6, 2) > 0.72 ? T.clay : T.dirt;
      else if (y >= deep_start) tile = T.deep_stone;
      foreground[index(x, y)] = tile;
      if (y > top) background[index(x, y)] = T.cave_wall;
    }
    foreground[index(x, height - 1)] = T.core;
    if (height > 2) foreground[index(x, height - 2)] = T.core;
  }

  // Caves: worm-like tunnels from thresholded noise below the dirt layer.
  for (let x = 0; x < width; x++) {
    for (let y = surface[x] + 7; y < height - 3; y++) {
      const cave = Fractal(seed + 101, x / 14, y / 9, 3);
      const threshold = 0.62 - 0.05 * profile.caves;
      if (cave > threshold && Math.abs(x - spawn_x) > 3) foreground[index(x, y)] = T.air;
    }
  }

  // Ores by depth band; denser deeper.
  for (let x = 0; x < width; x++) {
    for (let y = surface[x] + 5; y < height - 2; y++) {
      const tile = foreground[index(x, y)];
      if (tile !== T.stone && tile !== T.deep_stone) continue;
      const roll = Hash2(seed + 211, x, y);
      const depth = (y - surface[x]) / (height - surface[x]);
      const ore_scale = profile.ores;
      if (depth > 0.65 && roll < 0.006 * ore_scale) foreground[index(x, y)] = T.moonstone;
      else if (depth > 0.4 && roll < 0.02 * ore_scale) foreground[index(x, y)] = T.silver;
      else if (roll < 0.045 * ore_scale) foreground[index(x, y)] = T.copper;
    }
  }

  // Cave decoration: moss on cave floors, crystal on ceilings deeper down.
  for (let x = 1; x < width - 1; x++) {
    for (let y = surface[x] + 8; y < height - 3; y++) {
      if (foreground[index(x, y)] !== T.air) continue;
      const below = foreground[index(x, y + 1)];
      const above = foreground[index(x, y - 1)];
      const roll = Hash2(seed + 307, x, y);
      if ((below === T.stone || below === T.deep_stone) && roll < 0.12) foreground[index(x, y + 1)] = T.moss;
      else if ((above === T.deep_stone || above === T.stone) && y > deep_start - 6 && roll > 0.94) foreground[index(x, y - 1)] = T.crystal;
    }
  }

  // Surface ponds in local dips, with sand banks.
  const pond_count = Math.max(1, Math.round((width / 60) * profile.water));
  for (let i = 0; i < pond_count; i++) {
    const center = 8 + Math.floor(rng() * (width - 16));
    if (Math.abs(center - spawn_x) < 10) continue;
    const half = 3 + Math.floor(rng() * 3);
    const level = surface[center];
    for (let x = center - half; x <= center + half; x++) {
      if (!inside(x, level)) continue;
      const depth = Math.max(1, 3 - Math.floor(Math.abs(x - center) / 2));
      for (let y = level; y < level + depth; y++) foreground[index(x, y)] = T.water;
      for (let y = level + depth; y < level + depth + 2; y++) if (inside(x, y)) foreground[index(x, y)] = T.sand;
      for (let y = 0; y < level; y++) foreground[index(x, y)] = T.air;
      surface[x] = level;
    }
    for (const x of [center - half - 1, center + half + 1]) if (inside(x, surface[x])) foreground[index(x, surface[x])] = T.sand;
  }

  // Farming worlds get rich soil strips under the grass.
  if (world_type === "farming") {
    for (let x = 0; x < width; x++) if (Hash2(seed + 401, Math.floor(x / 6), 0) > 0.5 && foreground[index(x, surface[x] + 1)] === T.dirt) foreground[index(x, surface[x] + 1)] = T.rich_soil;
  }

  // Trees: trunk plus a round canopy, spaced so canopies do not merge into walls.
  let next_tree = 3;
  for (let x = 3; x < width - 3; x++) {
    if (x < next_tree || Math.abs(x - spawn_x) < 6) continue;
    if (foreground[index(x, surface[x])] !== T.grass) continue;
    if (Hash2(seed + 503, x, 1) > 0.16 * profile.trees) continue;
    const trunk = 3 + Math.floor(Hash2(seed + 509, x, 2) * 3);
    const top = surface[x] - trunk;
    if (top < 4) continue;
    for (let y = surface[x] - 1; y >= top; y--) foreground[index(x, y)] = T.log;
    for (let dy = -2; dy <= 1; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 3 || (Math.abs(dx) === 2 && dy === -2)) continue;
        const tx = x + dx;
        const ty = top + dy - 1;
        if (inside(tx, ty) && foreground[index(tx, ty)] === T.air) foreground[index(tx, ty)] = T.leaf;
      }
    }
    next_tree = x + 6;
  }

  // Buried chests sit in solid stone, never visible from the surface.
  const chest_count = Math.max(2, Math.round(width / 40));
  for (let i = 0; i < chest_count; i++) {
    const x = 2 + Math.floor(rng() * (width - 4));
    const y = surface[x] + 10 + Math.floor(rng() * Math.max(1, height - surface[x] - 14));
    if (inside(x, y) && foreground[index(x, y)] !== T.core) foreground[index(x, y)] = T.chest;
  }

  // One shrine per world in a deep cave pocket (adventure worlds always, others usually).
  if (world_type === "adventure" || rng() < 0.7) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const x = 2 + Math.floor(rng() * (width - 4));
      const y = deep_start + Math.floor(rng() * Math.max(1, height - deep_start - 4));
      if (!inside(x, y + 1) || foreground[index(x, y)] !== T.air) continue;
      const floor = foreground[index(x, y + 1)];
      if (floor === T.air || floor === T.water) continue;
      foreground[index(x, y)] = T.shrine;
      break;
    }
  }

  const spawn_y = surface[spawn_x] - 1;
  for (let y = 0; y <= spawn_y; y++) foreground[index(spawn_x, y)] = T.air;
  foreground[index(spawn_x, spawn_y)] = T.beacon;
  return { foreground, background, spawn_x, spawn_y };
}
