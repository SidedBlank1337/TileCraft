import fs from "node:fs";
import path from "node:path";
import { Database } from "../database/database.ts";
import { CreateServices } from "../service_container.ts";

const DATABASE_PATH = process.env.DATABASE_PATH ?? path.resolve("data/game.sqlite");

async function Main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  const db = await Database.Open(DATABASE_PATH);
  try {
    switch (command) {
      case "init":
        await CreateServices(db);
        console.log(`Database ready at ${DATABASE_PATH}`);
        break;
      case "check": {
        const integrity = await db.Get<{ integrity_check: string }>("PRAGMA integrity_check");
        const foreign = await db.All("PRAGMA foreign_key_check");
        const negative = await db.Get<{ count: number }>("SELECT COUNT(*) AS count FROM players WHERE coins < 0");
        const tables = await db.All<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        console.log(`integrity: ${integrity?.integrity_check}`);
        console.log(`foreign key violations: ${foreign.length}`);
        console.log(`negative balances: ${negative?.count ?? 0}`);
        for (const table of tables) {
          const row = await db.Get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table.name}`);
          console.log(`  ${table.name.padEnd(28)} ${row?.count ?? 0}`);
        }
        break;
      }
      case "backup": {
        const directory = path.resolve("data/backups");
        fs.mkdirSync(directory, { recursive: true });
        const target = path.join(directory, `game_${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
        await db.Run("VACUUM INTO ?", target);
        console.log(`Backup written to ${target}`);
        break;
      }
      case "cleanup": {
        const now = Date.now();
        const sessions = await db.Run("DELETE FROM sessions WHERE expires_at <= ?", now);
        const keys = await db.Run("DELETE FROM idempotency_keys WHERE created_at < ?", now - 7 * 86_400_000);
        const notes = await db.Run("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?", now - 30 * 86_400_000);
        const chat = await db.Run("DELETE FROM chat_messages WHERE created_at < ?", now - 30 * 86_400_000);
        console.log(`Removed ${sessions.changes} sessions, ${keys.changes} request ids, ${notes.changes} notifications, ${chat.changes} chat messages.`);
        break;
      }
      case "grant_admin": {
        if (!argument) throw new Error("Usage: npm run admin:grant -- USERNAME");
        const result = await db.Run("UPDATE users SET is_admin = 1 WHERE username = ?", argument);
        console.log(result.changes ? `${argument} is now an administrator.` : `No user named ${argument}.`);
        break;
      }
      default:
        console.log("Commands: init | check | backup | cleanup | grant_admin USERNAME");
    }
  } finally {
    await db.Close();
  }
}

Main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
