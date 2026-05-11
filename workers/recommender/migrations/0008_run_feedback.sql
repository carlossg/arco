-- Arco Run-Level User Feedback
-- One row per (run, session). Re-submits upsert via UNIQUE(run_id, session_id).

CREATE TABLE IF NOT EXISTS run_feedback (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  page_id         TEXT,
  session_id      TEXT,
  rating          INTEGER NOT NULL,          -- +1 or -1
  comment         TEXT,                       -- ≤1000 chars (server-truncated)
  flags           TEXT,                       -- JSON array of category keys
  wrong_products  TEXT,                       -- JSON array of product slugs
  dwell_ms        INTEGER,                    -- ms on page at submission
  user_agent      TEXT,
  ip_hash         TEXT,                       -- SHA-256 of IP (same helper as sessions)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(run_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_run     ON run_feedback(run_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON run_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_rating  ON run_feedback(rating, created_at DESC);
