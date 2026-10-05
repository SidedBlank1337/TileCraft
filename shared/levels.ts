export const MAX_LEVEL = 100;

export function XpForLevel(level: number): number {
  return Math.floor(60 * Math.pow(level, 1.55));
}

export function LevelFromLifetimeXp(lifetime_xp: number): { level: number; xp_into_level: number; xp_needed: number } {
  let level = 1;
  let remaining = lifetime_xp;
  while (level < MAX_LEVEL && remaining >= XpForLevel(level)) {
    remaining -= XpForLevel(level);
    level += 1;
  }
  return { level, xp_into_level: remaining, xp_needed: XpForLevel(level) };
}

export function LevelReward(level: number): number {
  return 50 + level * 25;
}
