-- The single connected Instagram professional account.
CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ig_user_id TEXT NOT NULL,
  username TEXT,
  name TEXT,
  profile_picture_url TEXT,
  access_token TEXT NOT NULL,
  token_expires_at INTEGER,
  token_refreshed_at INTEGER,
  connected_at INTEGER NOT NULL
);

-- Automation settings live in `data` (JSON); counters are columns so they can be bumped atomically.
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  triggered INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Webhook de-duplication: Meta retries deliveries, and we must never DM twice for one comment.
CREATE TABLE IF NOT EXISTS processed_events (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Who has already received a DM from an automation ("send only once per person").
CREATE TABLE IF NOT EXISTS sends (
  automation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (automation_id, user_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  username TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  interactions INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  automation_id TEXT,
  user_id TEXT,
  username TEXT,
  text TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity (ts DESC);
