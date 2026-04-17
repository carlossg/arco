-- Arco Session Storage Schema
-- Tracks all recommender generations for admin analysis

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  user_agent TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  page_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS generated_pages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  query TEXT NOT NULL,
  previous_queries TEXT,    -- JSON array of prior queries in session
  title TEXT,
  intent_type TEXT,
  journey_stage TEXT,
  flow_id TEXT,
  follow_up_type TEXT,
  block_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  da_path TEXT,
  preview_url TEXT,
  live_url TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_pages_session  ON generated_pages(session_id);
CREATE INDEX IF NOT EXISTS idx_pages_created  ON generated_pages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_last  ON sessions(last_seen DESC);
