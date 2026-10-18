-- Schéma D1 du serveur Premium (idempotent).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- identifiant de compte obfusqué choisi par l'application (aucune donnée personnelle)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  purchase_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  base_plan_id TEXT,
  state TEXT NOT NULL,              -- SUBSCRIPTION_STATE_* de Google Play, ou REPLACED
  expiry_ms INTEGER NOT NULL,
  auto_renewing INTEGER NOT NULL DEFAULT 0,
  test_purchase INTEGER NOT NULL DEFAULT 0,
  linked_token TEXT,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id, expiry_ms);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,      -- SHA-256 du jeton : le jeton lui-même n'est jamais stocké
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

-- Copie synchronisée (une par utilisateur), JSON compressé gzip.
CREATE TABLE IF NOT EXISTS snapshots (
  user_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device TEXT,
  size INTEGER NOT NULL,
  recipes INTEGER NOT NULL DEFAULT 0,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  device TEXT,
  size INTEGER NOT NULL,
  recipes INTEGER NOT NULL DEFAULT 0,
  auto INTEGER NOT NULL DEFAULT 0,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS backups_user ON backups(user_id, created_at DESC);
