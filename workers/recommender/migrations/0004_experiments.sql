-- Multi-model admin experiments.
--
-- An experiment groups N parallel LLM runs executed against the same query +
-- shared upstream pipeline output (intent + RAG + prompt). Each variant is a
-- {provider, model, temperature, maxTokens} combo that produced its own
-- sections/suggestions. The full per-variant NDJSON payload lives in the
-- SESSION_STORE KV namespace under `experiment:{experimentId}:variant:{variantId}`.
--
-- `evaluator_*` columns are reserved for a phase-2 LLM judge
-- (Claude Sonnet / Opus via ANTHROPIC_EVAL_API_KEY). They stay null in v1.

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  query TEXT NOT NULL,
  page_url TEXT,
  variant_count INTEGER NOT NULL,
  status TEXT NOT NULL,             -- 'running' | 'complete' | 'error'
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  shared_intent_type TEXT,
  shared_journey_stage TEXT,
  shared_duration_ms INTEGER,       -- upstream (non-LLM) wall time
  evaluator_summary TEXT            -- phase 2: overall LLM-judge verdict
);

CREATE TABLE IF NOT EXISTS experiment_variants (
  id TEXT PRIMARY KEY,              -- same UUID used as KV runId for the variant
  experiment_id TEXT NOT NULL,
  variant_index INTEGER NOT NULL,   -- 0..N-1, display order
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  temperature REAL,
  max_tokens INTEGER,
  status TEXT NOT NULL,             -- 'running' | 'complete' | 'error'
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  title TEXT,
  block_count INTEGER,
  error TEXT,
  evaluator_score REAL,             -- phase 2: LLM-judge score (e.g. 0–1)
  evaluator_notes TEXT,             -- phase 2: LLM-judge rationale
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);

CREATE INDEX IF NOT EXISTS idx_experiments_created
  ON experiments(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_experiment_variants_exp
  ON experiment_variants(experiment_id);
