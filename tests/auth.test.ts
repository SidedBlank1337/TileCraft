import { test } from "node:test";
import assert from "node:assert/strict";
import { CreateTestPlayer, CreateTestServices } from "./test_helpers.ts";
import { GameError } from "../server/services/errors.ts";

test("auth: register, login, logout, duplicates, bad credentials, expiry", async (t) => {
  const services = await CreateTestServices();
  const auth = services.auth_service;
  const base = { username: "Alice_1", email: "alice@example.com", password: "secret123", confirm_password: "secret123" };

  await t.test("register works and creates a player", async () => {
    const { user_id } = await auth.Register(base);
    const player = await services.player_service.GetPlayer(user_id);
    assert.equal(player.coins, 150);
    const row = await services.db.Get<{ password_hash: string }>("SELECT password_hash FROM users WHERE user_id = ?", user_id);
    assert.ok(row!.password_hash.startsWith("scrypt$"));
    assert.ok(!row!.password_hash.includes("secret123"));
  });

  await t.test("duplicate username and email rejected (case-insensitive)", async () => {
    await assert.rejects(auth.Register({ ...base, email: "other@example.com", username: "alice_1" }), (error: GameError) => error.code === "username_taken");
    await assert.rejects(auth.Register({ ...base, username: "Bob_1", email: "ALICE@example.com" }), (error: GameError) => error.code === "email_taken");
  });

  await t.test("password rules and confirmation enforced", async () => {
    await assert.rejects(auth.Register({ ...base, username: "weak", email: "w@example.com", password: "short", confirm_password: "short" }));
    await assert.rejects(auth.Register({ ...base, username: "nodigit", email: "n@example.com", password: "abcdefghij", confirm_password: "abcdefghij" }));
    await assert.rejects(auth.Register({ ...base, username: "mismatch", email: "m@example.com", confirm_password: "secret124" }));
    await assert.rejects(auth.Register({ ...base, username: "a", email: "a@example.com" }));
  });

  await t.test("login by username or email, wrong password rejected", async () => {
    const by_name = await auth.Login("Alice_1", "secret123");
    const by_email = await auth.Login("alice@example.com", "secret123");
    assert.ok(by_name.token && by_email.token && by_name.token !== by_email.token);
    await assert.rejects(auth.Login("Alice_1", "wrong-pass1"), (error: GameError) => error.status === 401);
    await assert.rejects(auth.Login("nobody", "secret123"), (error: GameError) => error.status === 401);
  });

  await t.test("token validation, logout and invalid sessions", async () => {
    const { token, user } = await auth.Login("Alice_1", "secret123");
    assert.equal((await auth.ValidateToken(token))?.user_id, user.user_id);
    assert.equal(await auth.ValidateToken("forged-token"), null);
    assert.equal(await auth.ValidateToken(undefined), null);
    await auth.Logout(user.session_id);
    assert.equal(await auth.ValidateToken(token), null);
  });

  await t.test("expired sessions are rejected and removed", async () => {
    const { token, user } = await auth.Login("Alice_1", "secret123");
    await services.db.Run("UPDATE sessions SET expires_at = ? WHERE session_id = ?", Date.now() - 1, user.session_id);
    assert.equal(await auth.ValidateToken(token), null);
    assert.equal(await services.db.Get("SELECT 1 FROM sessions WHERE session_id = ?", user.session_id), undefined);
  });

  await t.test("banned accounts cannot log in", async () => {
    const { player_id } = await CreateTestPlayer(services, "banned_guy");
    await services.db.Run("UPDATE users SET banned_until = ? WHERE user_id = ?", Date.now() + 60_000, player_id);
    await assert.rejects(auth.Login("banned_guy", "password123"), (error: GameError) => error.code === "banned");
  });
});
