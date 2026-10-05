# Tilecraft Realms

An original browser-based 2D multiplayer sandbox: create persistent worlds, dig, build, farm, craft, trade and chat with other players in real time.

- **Client:** React + TypeScript + Vite, HTML5 Canvas renderer (`client/`)
- **Server:** Node.js + TypeScript, Express REST API + `ws` WebSocket (`server/`)
- **Shared:** item/block registry, recipes, quests, achievements, cosmetics, shop, events, physics (`shared/`)
- **Database:** SQLite via `sqlite3` at `./data/game.sqlite` (WAL, foreign keys, busy timeout, transactions)

All art is drawn procedurally in code and all music/SFX are synthesized with Web Audio. No external game assets are used.

## Requirements

- Node.js 22 or newer (tested on Node 24)
- For `npm run test:e2e` only: a local Chrome or Edge install

## Install

```bash
npm install
```

npm 11 may warn that the `sqlite3` and `esbuild` install scripts were not run. Both ship prebuilt binaries and work without them. If `sqlite3` fails to load on your platform, run `npm install-scripts approve sqlite3 esbuild` and `npm rebuild`.

## Database

The schema is created automatically on every server start (`CREATE TABLE IF NOT EXISTS`). The `data/` directory is created if missing. To initialize it explicitly:

```bash
npm run db:init      # create schema + sync item definitions
npm run db:check     # integrity check, FK check, negative-balance check, row counts
npm run db:backup    # VACUUM INTO data/backups/game_<timestamp>.sqlite
npm run db:cleanup   # remove expired sessions, old request ids, old read notifications and chat
```

## Development

```bash
npm run dev
```

This starts the API/WebSocket server on `http://localhost:3000` (auto-restart on change) and Vite on `http://localhost:5173`. Open **http://localhost:5173**. Vite proxies `/api`, `/health` and `/ws` to the server.

## Production

```bash
npm run build        # typecheck + build the client into dist/client
npm start            # serves the API, WebSocket and built client on PORT (default 3000)
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_PATH` | `data/game.sqlite` | SQLite file |
| `PUBLIC_URL` | unset | Public origin (e.g. `https://play.example.com`); added to allowed origins, and enables `Secure` cookies when it starts with `https` |
| `SECURE_COOKIES` | derived | Force `true`/`false` for the session cookie `Secure` flag |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Run behind HTTPS in production (reverse proxy) so the session cookie gets `Secure`.

## Admin setup

Admin rights live only in the `users.is_admin` column. Register an account normally, then:

```bash
npm run admin:grant -- YourUsername
```

Log in again (or reconnect). The **Admin** button appears in the menu and HUD. Admins can also use chat commands: `/give USER ITEM QTY`, `/take USER ITEM QTY`, `/coins USER DELTA`, `/ban USER [HOURS] [REASON]`, `/unban USER`, `/kick USER`, `/mute USER [MINUTES]`, `/tp USER` or `/tp X Y`, `/world lock|unlock NAME`, `/item KEY`, `/event KEY [MINUTES]`. Every admin action is written to `admin_logs`.

## Tests

```bash
npm test             # 39 unit + integration tests (in-memory and temp-file SQLite, real HTTP + WebSocket)
npm run build && npm run test:e2e   # two real Chrome sessions play together (needs Chrome or Edge)
```

`npm test` covers auth (register, duplicates, login, logout, bad credentials, expiry, bans), inventory (stack, split, merge, sort, invalid quantity/item), crafting, coins (no negative balance, rollback), shop (stock, replay protection), marketplace (escrow, fee, concurrent purchase of one listing, double purchase, cancel), quests/achievements (no double claim), world creation/duplicates/reserved names, join, permissions, private and banned worlds, block break/place, hit-rate limiting, drop pickup races, movement anti-cheat, chat and rate limits, malformed packets, WebSocket flood, fake admin commands, CSRF origin check, trading (offer changes reset confirmations, coin conservation, disconnect cancel), deterministic world generation, and a server restart that verifies blocks, trees, inventory, coins, permissions and settings persist. The E2E script checks that two browsers see each other, see each other move, see block breaks/placements, exchange chat, observe drops consistently and see a player leave. Screenshots land in `data/e2e/`.

## Accounts: guests and TileIDs

Press **Play Online**, type a **Name** and **Connect** to play as a guest. Guests can walk, jump and chat but cannot break, place, collect, trade, shop or create worlds (enforced by the server). Choose **Create a TileID** from the in-game ⋮ menu (or on world select) to turn the guest into a full account in place; afterwards log in with **I have a TileID**. World names are 1-16 letters (A-Z). **Enter World** joins an existing world or creates a new one with the default preset (public, medium). Reach is 2 tiles.

## How to play

| Input | Action |
|---|---|
| A/D or ←/→ | Move |
| W, Space or ↑ | Jump |
| Left mouse (hold) | Break block, harvest a ready tree, fish in Still Water (with a rod), touch a shrine |
| Right mouse | Place the selected hotbar item, inspect a tree |
| 1-9 | Select hotbar slot |
| E / C / J | Inventory / Crafting / Journal |
| Enter | Chat (`/help` lists commands, `/msg NAME text`, `/trade NAME`, `/setspawn`) |
| On-screen buttons | ◀ ▶ move, ▲ jump, round button punches (fist) or places (selected item) in front of you; shown on PC too. Size preset in Options |
| 0 / F / Esc | Select fist / action button / ⋮ menu (Continue, Options, Create a TileID, Quit World) |

Loop: break blocks for materials, seeds and coins → plant seeds on solid ground (Rich Soil grows 25% faster) → harvest when trees glow → craft tools (picks unlock harder ores) → sell to the shop or list on the marketplace → buy cosmetics and build your world.

## Architecture

```
shared/        items.ts (block/item registry), recipes.ts, progression.ts (quests, achievements),
               cosmetics.ts, economy.ts (shop, events, trivia), physics.ts, protocol.ts, levels.ts
server/
  app.ts                 express app, security headers, routes, WebSocket upgrade, timers
  service_container.ts   builds every service once
  database/              connection with a serialized, re-entrant transaction gate; schema
  auth/                  scrypt password hashing, hashed session tokens, expiry
  api/                   auth, game and admin routes (Origin check, auth, per-player rate limit)
  services/              player, inventory, progress (stats/quests/achievements/notifications),
                         world, economy (crafting/shop/marketplace), social (chat/friends/trivia),
                         admin, events, security logging
  game/                  world_generator (seeded), world_manager (live worlds, actions, anti-cheat),
                         trade_manager (in-memory sessions, atomic commit)
  websocket/             game_socket (auth on upgrade, one connection per player, per-player ordered queue)
client/
  app.tsx                screens and panels
  game/                  game_engine (canvas, chunk caches, prediction, interpolation), textures
  audio/                 Web Audio synth music + SFX
  services/ state/       REST + WebSocket clients, global store
tests/                   node:test suites + e2e/two_browser.ts
```

Key safety designs:

- **Server authority:** the client sends intents (`block_hit`, `block_place`, `item_pickup`, `trade_offer`, …). Coins, items, XP, permissions, prices, break progress and positions are validated or computed on the server.
- **Transactions:** every multi-row change runs inside `db.Transaction` (`BEGIN IMMEDIATE`, rollback on error). All statements pass through one FIFO gate, so unrelated work never interleaves with an open transaction.
- **Anti-duplication:** conditional updates (`... WHERE status = 'active' AND quantity >= ?`, `coins >= ?`) with `changes` checks; drops and trees are claimed synchronously in memory before the DB delete; per-player ordered message queue; `request_id` idempotency keys on shop/market REST calls; primary keys on achievements and quest claims.
- **Persistence:** tiles are stored as 32×32 chunks in `world_chunks` and flushed every 5 s and on shutdown. Trees, drops, inventory and coins are written immediately. Movement stays in memory.

## Known limitations

- Placed and broken tiles are flushed to SQLite every 5 seconds (and on graceful shutdown). A hard crash can lose up to ~5 s of tile edits, while the matching inventory change is already committed.
- Movement validation checks speed, vertical speed, bounds, walls and sustained flight with tolerance; it does not replay full physics on the server.
- Only local username/password accounts exist. `auth_provider` / `provider_user_id` columns are in place for future OAuth.
- Single-process server: live worlds and trades are held in that process, so it does not scale horizontally as-is.
- The marketplace has no buy orders; NPC shop stock is a per-player daily limit.
- PvP is not implemented (`pvp_enabled` is stored but has no effect).
