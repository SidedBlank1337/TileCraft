import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Database } from "../database/database.ts";
import { SESSION_DAYS } from "../../shared/constants.ts";
import { AuthError, GameError, ValidationError } from "../services/errors.ts";
import type { PlayerService } from "../services/player_service.ts";

const scrypt_async = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions) => Promise<Buffer>;

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export interface SessionUser {
  user_id: number;
  username: string;
  is_admin: boolean;
  is_guest: boolean;
  session_id: string;
}

export async function HashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt_async(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function VerifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, salt_b64, key_b64] = stored.split("$");
  if (scheme !== "scrypt" || !salt_b64 || !key_b64) return false;
  const expected = Buffer.from(key_b64, "base64");
  const actual = await scrypt_async(password, Buffer.from(salt_b64, "base64"), expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(expected, actual);
}

export function ValidatePasswordStrength(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password is too long.";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return "Password needs at least one letter and one number.";
  return null;
}

// The cookie holds a random token; the DB only stores its SHA-256 so a leaked DB cannot hijack sessions.
function HashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  constructor(private db: Database, private player_service: PlayerService) {}

  async Register(input: { username: unknown; email: unknown; password: unknown; confirm_password: unknown }): Promise<{ user_id: number }> {
    const username = typeof input.username === "string" ? input.username.trim() : "";
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const confirm_password = typeof input.confirm_password === "string" ? input.confirm_password : "";

    if (!USERNAME_PATTERN.test(username)) throw new ValidationError("Usernames are 3-16 letters, numbers or underscores.", { field: "username" });
    if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new ValidationError("Enter a valid email address.", { field: "email" });
    const weak = ValidatePasswordStrength(password);
    if (weak) throw new ValidationError(weak, { field: "password" });
    if (password !== confirm_password) throw new ValidationError("Passwords do not match.", { field: "confirm_password" });

    const password_hash = await HashPassword(password);
    return this.db.Transaction(async () => {
      if (await this.db.Get("SELECT 1 FROM users WHERE username = ?", username)) throw new GameError("username_taken", "That username is taken.", 409, { field: "username" });
      if (await this.db.Get("SELECT 1 FROM users WHERE email = ?", email)) throw new GameError("email_taken", "That email is already registered.", 409, { field: "email" });
      const result = await this.db.Run(
        "INSERT INTO users (username, email, password_hash, auth_provider, created_at) VALUES (?, ?, ?, 'local', ?)",
        username, email, password_hash, Date.now()
      );
      await this.player_service.CreatePlayer(result.last_id);
      return { user_id: result.last_id };
    });
  }

  async Login(login: unknown, password: unknown): Promise<{ token: string; user: SessionUser; expires_at: number }> {
    const identifier = typeof login === "string" ? login.trim() : "";
    const secret = typeof password === "string" ? password : "";
    if (!identifier || !secret) throw new AuthError("Enter your username or email and password.");
    const row = await this.db.Get<{ user_id: number; username: string; password_hash: string; is_admin: number; banned_until: number | null; ban_reason: string | null }>(
      "SELECT user_id, username, password_hash, is_admin, banned_until, ban_reason FROM users WHERE (username = ? OR email = ?) AND is_guest = 0",
      identifier, identifier.toLowerCase()
    );
    const valid = await VerifyPassword(secret, row?.password_hash ?? null);
    if (!row || !valid) throw new AuthError("Wrong username/email or password.");
    if (row.banned_until && row.banned_until > Date.now()) {
      throw new GameError("banned", `This account is banned until ${new Date(row.banned_until).toUTCString()}.`, 403);
    }
    return this.StartSession(row.user_id, row.username, row.is_admin === 1, false);
  }

  private async StartSession(user_id: number, username: string, is_admin: boolean, is_guest: boolean): Promise<{ token: string; user: SessionUser; expires_at: number }> {
    const token = crypto.randomBytes(32).toString("base64url");
    const session_id = HashToken(token);
    const now = Date.now();
    const expires_at = now + SESSION_MS;
    await this.db.Run("INSERT INTO sessions (session_id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", session_id, user_id, now, expires_at, now);
    await this.db.Run("UPDATE users SET last_login_at = ? WHERE user_id = ?", now, user_id);
    return { token, expires_at, user: { user_id, username, is_admin, is_guest, session_id } };
  }

  // Guests get a real account row so the server can track them, but no password and no interaction rights.
  async CreateGuest(raw_name: unknown): Promise<{ token: string; user: SessionUser; expires_at: number }> {
    const base = typeof raw_name === "string" ? raw_name.trim() : "";
    if (!/^[A-Za-z0-9_]{3,12}$/.test(base)) throw new ValidationError("Names are 3-12 letters, numbers or underscores.", { field: "name" });
    const user_id = await this.db.Transaction(async () => {
      let username = base;
      for (let attempt = 0; await this.db.Get("SELECT 1 FROM users WHERE username = ?", username); attempt++) {
        if (attempt > 20) throw new GameError("username_taken", "That name is busy, try another.", 409);
        username = `${base}_${Math.floor(100 + Math.random() * 900)}`;
      }
      const result = await this.db.Run(
        "INSERT INTO users (username, email, password_hash, auth_provider, is_guest, created_at) VALUES (?, ?, NULL, 'guest', 1, ?)",
        username, `guest_${crypto.randomUUID()}@guest.invalid`, Date.now()
      );
      await this.player_service.CreatePlayer(result.last_id);
      return result.last_id;
    });
    const row = await this.db.Get<{ username: string }>("SELECT username FROM users WHERE user_id = ?", user_id);
    return this.StartSession(user_id, row!.username, false, true);
  }

  // Turns a guest into a full TileID account in place, keeping all progress.
  async UpgradeGuest(user_id: number, input: { tile_id: unknown; email: unknown; password: unknown; confirm_password: unknown }): Promise<{ username: string }> {
    const username = typeof input.tile_id === "string" ? input.tile_id.trim() : "";
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!USERNAME_PATTERN.test(username)) throw new ValidationError("A TileID is 3-16 letters, numbers or underscores.", { field: "tile_id" });
    if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new ValidationError("Enter a valid email address.", { field: "email" });
    const weak = ValidatePasswordStrength(password);
    if (weak) throw new ValidationError(weak, { field: "password" });
    if (password !== input.confirm_password) throw new ValidationError("Passwords do not match.", { field: "confirm_password" });
    const password_hash = await HashPassword(password);
    await this.db.Transaction(async () => {
      const row = await this.db.Get<{ is_guest: number }>("SELECT is_guest FROM users WHERE user_id = ?", user_id);
      if (!row || row.is_guest !== 1) throw new ValidationError("This account already has a TileID.");
      if (await this.db.Get("SELECT 1 FROM users WHERE username = ? AND user_id <> ?", username, user_id)) throw new GameError("username_taken", "That TileID is taken.", 409, { field: "tile_id" });
      if (await this.db.Get("SELECT 1 FROM users WHERE email = ?", email)) throw new GameError("email_taken", "That email is already registered.", 409, { field: "email" });
      await this.db.Run("UPDATE users SET username = ?, email = ?, password_hash = ?, auth_provider = 'local', is_guest = 0 WHERE user_id = ?", username, email, password_hash, user_id);
    });
    return { username };
  }

  async ValidateToken(token: string | undefined | null): Promise<SessionUser | null> {
    if (!token || token.length > 200) return null;
    const session_id = HashToken(token);
    const row = await this.db.Get<{ user_id: number; username: string; is_admin: number; is_guest: number; expires_at: number; banned_until: number | null; last_seen_at: number }>(
      `SELECT s.user_id, s.expires_at, s.last_seen_at, u.username, u.is_admin, u.is_guest, u.banned_until
       FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ?`,
      session_id
    );
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at <= now) {
      await this.db.Run("DELETE FROM sessions WHERE session_id = ?", session_id);
      return null;
    }
    if (row.banned_until && row.banned_until > now) return null;
    if (now - row.last_seen_at > 60_000) await this.db.Run("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?", now, session_id);
    return { user_id: row.user_id, username: row.username, is_admin: row.is_admin === 1, is_guest: row.is_guest === 1, session_id };
  }

  async Logout(session_id: string): Promise<void> {
    await this.db.Run("DELETE FROM sessions WHERE session_id = ?", session_id);
  }

  async RevokeAllSessions(user_id: number): Promise<void> {
    await this.db.Run("DELETE FROM sessions WHERE user_id = ?", user_id);
  }

  async PurgeExpired(): Promise<number> {
    const result = await this.db.Run("DELETE FROM sessions WHERE expires_at <= ?", Date.now());
    return result.changes;
  }
}
