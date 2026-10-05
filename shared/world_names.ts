export const WORLD_NAME_PATTERN = /^[A-Z]{1,16}$/;

export const RESERVED_WORLD_NAMES = new Set(["ADMIN", "SYSTEM", "SERVER", "NULL", "UNDEFINED", "MODERATOR", "STAFF", "HELP", "EXIT", "LOBBY"]);

export function NormalizeWorldName(raw: string): string {
  return String(raw ?? "").toUpperCase().replace(/\s+/g, "");
}

export function ValidateWorldName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = NormalizeWorldName(raw);
  if (!WORLD_NAME_PATTERN.test(name)) return { ok: false, error: "World names are 1-16 letters (A-Z) only." };
  if (RESERVED_WORLD_NAMES.has(name)) return { ok: false, error: "That world name is reserved." };
  return { ok: true, name };
}
