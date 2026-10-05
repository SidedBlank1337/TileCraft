// Every statement is idempotent and runs on every boot; append new tables, never drop.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 3 AND 16),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'local',
  provider_user_id TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  banned_until INTEGER,
  ban_reason TEXT,
  muted_until INTEGER,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (auth_provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS players (
  player_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
  lifetime_xp INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_xp >= 0),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  playtime_seconds INTEGER NOT NULL DEFAULT 0,
  appearance TEXT NOT NULL DEFAULT '{}',
  settings TEXT NOT NULL DEFAULT '{}',
  last_world_id INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item_definitions (
  item_id INTEGER PRIMARY KEY,
  item_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  rarity TEXT NOT NULL,
  sell_price INTEGER NOT NULL CHECK (sell_price >= 0),
  max_stack INTEGER NOT NULL CHECK (max_stack >= 1)
);

CREATE TABLE IF NOT EXISTS player_inventory (
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  slot_index INTEGER NOT NULL CHECK (slot_index >= 0 AND slot_index < 40),
  item_id INTEGER NOT NULL REFERENCES item_definitions(item_id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (player_id, slot_index)
);

CREATE TABLE IF NOT EXISTS worlds (
  world_id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_name TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  width INTEGER NOT NULL CHECK (width BETWEEN 32 AND 400),
  height INTEGER NOT NULL CHECK (height BETWEEN 32 AND 200),
  seed INTEGER NOT NULL,
  world_type TEXT NOT NULL CHECK (world_type IN ('public','private','farming','trading','adventure','event')),
  description TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT 'noon',
  spawn_x INTEGER NOT NULL,
  spawn_y INTEGER NOT NULL,
  weather TEXT NOT NULL DEFAULT 'clear',
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  player_limit INTEGER NOT NULL DEFAULT 30 CHECK (player_limit BETWEEN 1 AND 100),
  settings TEXT NOT NULL DEFAULT '{}',
  total_visits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worlds_owner ON worlds(owner_id);

CREATE TABLE IF NOT EXISTS world_chunks (
  world_id INTEGER NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  chunk_x INTEGER NOT NULL,
  chunk_y INTEGER NOT NULL,
  foreground BLOB NOT NULL,
  background BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, chunk_x, chunk_y)
);

CREATE TABLE IF NOT EXISTS trees (
  world_id INTEGER NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  item_id INTEGER NOT NULL REFERENCES item_definitions(item_id),
  planted_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  planted_at INTEGER NOT NULL,
  grow_ms INTEGER NOT NULL CHECK (grow_ms > 0),
  notified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, x, y)
);
CREATE INDEX IF NOT EXISTS idx_trees_ready ON trees(notified, planted_at);

CREATE TABLE IF NOT EXISTS item_drops (
  drop_id TEXT PRIMARY KEY,
  world_id INTEGER NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES item_definitions(item_id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  x REAL NOT NULL,
  y REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drops_world ON item_drops(world_id);

CREATE TABLE IF NOT EXISTS world_permissions (
  world_id INTEGER NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','builder','member','banned')),
  granted_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, player_id)
);

CREATE TABLE IF NOT EXISTS world_invitations (
  invitation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  inviter_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  invitee_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked')),
  created_at INTEGER NOT NULL,
  UNIQUE (world_id, invitee_id)
);

CREATE TABLE IF NOT EXISTS world_visits (
  world_id INTEGER NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  visit_count INTEGER NOT NULL DEFAULT 0,
  last_visited_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_visits_player ON world_visits(player_id, last_visited_at);

CREATE TABLE IF NOT EXISTS world_favorites (
  world_id INTEGER NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, player_id)
);

CREATE TABLE IF NOT EXISTS player_statistics (
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  stat_key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, stat_key)
);

CREATE TABLE IF NOT EXISTS block_statistics (
  item_id INTEGER PRIMARY KEY REFERENCES item_definitions(item_id),
  broken_count INTEGER NOT NULL DEFAULT 0,
  placed_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS player_quests (
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  quest_key TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, quest_key)
);

CREATE TABLE IF NOT EXISTS player_achievements (
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  achievement_key TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, achievement_key)
);

CREATE TABLE IF NOT EXISTS player_cosmetics (
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  cosmetic_key TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, cosmetic_key)
);

CREATE TABLE IF NOT EXISTS marketplace_listings (
  listing_id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES item_definitions(item_id),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  initial_quantity INTEGER NOT NULL CHECK (initial_quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price > 0),
  status TEXT NOT NULL CHECK (status IN ('active','sold','cancelled','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON marketplace_listings(status, item_id);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON marketplace_listings(seller_id, status);

CREATE TABLE IF NOT EXISTS marketplace_transactions (
  market_transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES marketplace_listings(listing_id),
  buyer_id INTEGER NOT NULL REFERENCES players(player_id),
  seller_id INTEGER NOT NULL REFERENCES players(player_id),
  item_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL,
  total INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_tx_item ON marketplace_transactions(item_id, created_at);

CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT PRIMARY KEY,
  player_a_id INTEGER NOT NULL REFERENCES players(player_id),
  player_b_id INTEGER NOT NULL REFERENCES players(player_id),
  coins_a INTEGER NOT NULL DEFAULT 0 CHECK (coins_a >= 0),
  coins_b INTEGER NOT NULL DEFAULT 0 CHECK (coins_b >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed','cancelled')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS trade_items (
  trade_id TEXT NOT NULL REFERENCES trades(trade_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL REFERENCES item_definitions(item_id),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER,
  item_id INTEGER,
  quantity INTEGER,
  reference_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_player ON transactions(player_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, request_id)
);

CREATE TABLE IF NOT EXISTS shop_purchases (
  player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, item_id, day)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK (channel IN ('world','global','private')),
  world_id INTEGER,
  sender_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_channel ON chat_messages(channel, world_id, created_at);

CREATE TABLE IF NOT EXISTS friends (
  requester_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);

CREATE TABLE IF NOT EXISTS player_blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  started_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_player ON notifications(player_id, created_at);

CREATE TABLE IF NOT EXISTS admin_logs (
  admin_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS security_logs (
  security_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER,
  kind TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_player ON security_logs(player_id, created_at);

CREATE TABLE IF NOT EXISTS reports (
  report_id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at INTEGER NOT NULL
);
`;
