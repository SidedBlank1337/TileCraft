import path from "node:path";
import { CreateGameServer } from "./app.ts";
import { CreateLogger } from "./logging/logger.ts";

const log = CreateLogger("server");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

async function Main(): Promise<void> {
  const public_url = process.env.PUBLIC_URL;
  const game = await CreateGameServer({
    database_path: process.env.DATABASE_PATH ?? path.resolve("data/game.sqlite"),
    static_dir: IS_PRODUCTION ? path.resolve("dist/client") : null,
    secure_cookies: process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES === "true" : !!public_url?.startsWith("https"),
    allowed_origins: [public_url, "http://localhost:5173", "http://127.0.0.1:5173", `http://localhost:${PORT}`].filter((value): value is string => !!value)
  });
  game.server.listen(PORT, HOST, () => log.Info("listening", { url: `http://localhost:${PORT}`, production: IS_PRODUCTION }));

  let stopping = false;
  const Shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.Info("shutting down", { signal });
    await game.Stop().catch((error) => log.Error("shutdown error", { error: String(error) }));
    process.exit(0);
  };
  process.on("SIGINT", () => void Shutdown("SIGINT"));
  process.on("SIGTERM", () => void Shutdown("SIGTERM"));
}

Main().catch((error) => {
  log.Error("fatal startup error", { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
