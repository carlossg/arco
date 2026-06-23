<!-- Generated: 2026-05-11 | Files scanned: 8 | Token estimate: ~900 -->

# Data Architecture

## D1 Database — `arco-sessions`

Migrations live in `workers/recommender/migrations/`. Run via `wrangler d1 execute arco-sessions --file=<migration>.sql` (most migrations also auto-apply on next worker boot).

| Migration | Adds |
|-----------|------|
| `0001_sessions.sql` | `sessions`, `generated_pages` (initial schema) |
| `0002_pages_and_runs.sql` | Page-grouping + run_index columns |
| `0003_llm_vendor.sql` | `llm_provider`, `llm_model` columns on runs |
| `0004_experiments.sql` | `experiments`, `experiment_variants` tables |
| `0005_ttft.sql` | `time_to_first_token_ms` on variants |
| `0006_evaluations.sql` | `eval_runs` table + eval columns on experiments/variants |
| `0007_eval_run_progress.sql` | `completed_queries`, `last_activity_at` on eval_runs |
| `0008_run_feedback.sql` | `run_feedback` table + indexes |

### `sessions`

```sql
sessions(
  id          TEXT PRIMARY KEY,  -- sessionId (UUID, per browser tab)
  ip_hash     TEXT,              -- SHA-256(client IP)
  user_agent  TEXT,
  first_seen  TEXT,              -- ISO timestamp
  last_seen   TEXT,
  page_count  INTEGER DEFAULT 0
)
```

### `generated_pages` (runs)

```sql
generated_pages(
  id                TEXT PRIMARY KEY,  -- runId
  session_id        TEXT,              -- FK → sessions.id
  page_id           TEXT,              -- groups runs sharing one ?q= URL visit
  page_url          TEXT,
  run_index         INTEGER,           -- 0=initial, 1..N=follow-up clicks
  parent_run_id     TEXT,              -- which run's chip was clicked

  query             TEXT,
  previous_queries  TEXT,              -- JSON array
  title             TEXT,
  intent_type       TEXT,
  journey_stage     TEXT,
  flow_id           TEXT,

  follow_up_type    TEXT,
  follow_up_label   TEXT,
  follow_up_options TEXT,              -- JSON array of chips shown

  block_count       INTEGER,
  created_at        TEXT,
  duration_ms       INTEGER,
  input_tokens      INTEGER,
  output_tokens     INTEGER,

  llm_provider      TEXT,
  llm_model         TEXT,

  da_path           TEXT,
  preview_url       TEXT,
  live_url          TEXT
)
```

### `experiments`

One row per multi-model A/B run. When created by an eval, the eval-specific columns are populated.

```sql
experiments(
  id                  TEXT PRIMARY KEY,
  query               TEXT,
  variant_count       INTEGER,
  status              TEXT,
  shared_duration_ms  INTEGER,         -- upstream pipeline runs ONCE per experiment
  intent_snapshot     TEXT,            -- JSON
  journey_snapshot    TEXT,            -- JSON
  created_at          TEXT,

  -- eval-related (migration 0006)
  eval_run_id         TEXT,
  eval_query_id       TEXT
)
```

### `experiment_variants`

```sql
experiment_variants(
  id                       TEXT PRIMARY KEY,
  experiment_id            TEXT,
  provider                 TEXT,
  model                    TEXT,
  temperature              REAL,
  max_tokens               INTEGER,
  status                   TEXT,        -- pending|running|complete|error
  duration_ms              INTEGER,
  time_to_first_token_ms   INTEGER,    -- migration 0005
  input_tokens             INTEGER,
  output_tokens            INTEGER,
  title                    TEXT,
  block_count              INTEGER,
  error                    TEXT,

  -- LLM-judge (migration 0006)
  evaluator_score          REAL,        -- composite mean of 7 dimensions
  evaluator_notes          TEXT,        -- JSON: per-dim reasoning + assertions + blocker metadata
  evaluator_summary        TEXT
)
```

### `eval_runs`

```sql
eval_runs(
  id                 TEXT PRIMARY KEY,
  suite_id           TEXT,
  models             TEXT,              -- JSON array of {provider, model, temperature, maxTokens}
  judge_model        TEXT,
  query_concurrency  INTEGER,
  skip_judge         INTEGER,           -- 0/1
  status             TEXT,
  phase              TEXT,              -- generating|judging|complete|error
  query_count        INTEGER,
  model_count        INTEGER,
  completed_queries  INTEGER,
  last_activity_at   TEXT,
  summary            TEXT,              -- per-model rollup JSON (qualityCi95, ttftCi95, etc.)
  estimated_cost_usd REAL,
  created_at         TEXT
)
```

### `run_feedback`

```sql
run_feedback(
  id              TEXT PRIMARY KEY,
  run_id          TEXT,                -- FK → generated_pages.id
  page_id         TEXT,
  session_id      TEXT,
  rating          INTEGER,             -- +1 / -1
  comment         TEXT,                -- truncated to 1000 chars server-side
  flags           TEXT,                -- JSON array of {wrong-product, off-topic, inappropriate-tone, harmful-unsafe}
  wrong_products  TEXT,                -- JSON array of product slugs flagged on the run
  dwell_ms        INTEGER,
  user_agent      TEXT,
  ip_hash         TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  UNIQUE(run_id, session_id)
)
```

A re-submit from the same browser upserts on the unique constraint.

## KV Namespaces

### `SESSION_STORE` — Full generation payloads

| Key | Holds |
|-----|-------|
| `page:{runId}` | `{ blocks[], followUpOptions, followUpClicked, debug, request }` — the full run payload |
| `experiment:{expId}:variant:{vid}` | Per-variant blocks + debug + prompt (90-day TTL) |
| `experiment:{expId}:rag-context` | Cached upstream RAG context (used by rejudge / per-cell regenerate so retrieval is not re-paid) |

`debug` snapshot includes: intent classification, RAG results (products / features / FAQs / recipes / hero images), behavior analysis, full system + user prompts, timings, LLM model + token counts, raw LLM output.

### `CACHE`

| Key | Holds |
|-----|-------|
| `llm-config:active` | `{ provider, model, temperature, maxTokens, updatedAt }` — wins over per-flow defaults |
| (arbitrary) | Short-lived HTTP response cache |

### `GUIDES`

Static guide markdown/HTML by slug — used as RAG context.

### `ANALYTICS` (Analytics Engine)

`arco_usage` dataset — request-level analytics events.

## Vectorize Index — `CONTENT_INDEX`

- Index name: `arco-content`.
- Populated by `workers/recommender/scripts/index-content.js` (CLI) — reads `content/stories-index.json` and `content/experiences-index.json`, skips entries with `published: false`.
- Embeddings: Workers AI `@cf/baai/bge-base-en-v1.5`.
- Queried by `searchContent()` in `src/context.js`; inspected via `#/vectorize` and `GET /api/admin/vectorize/{stats,search}`.

## Queue — `arco-eval-queries`

Message types: `generate`, `judge`, `regenerate`, `rejudge`. Per-message retry uses `msg.retry({delaySeconds})` for Bedrock 429s with backoff `30/60/90/120/150s`. DLQ: `arco-eval-dlq`.

## Client-Side Storage (sessionStorage / localStorage)

| Key | Storage | Purpose |
|-----|---------|---------|
| `arco-session-id` | sessionStorage | UUID for this browser tab |
| `arco-quiz-prefetch` | sessionStorage | Prefetched blocks from quiz interaction |
| `arco-foryou-prefetch` | sessionStorage | Prefetched blocks for "For You" link |
| `arco-foryou-query` | sessionStorage | Query string used for For You prefetch |
| `arco-session-context` | sessionStorage | Full `SessionContextManager` state (queries, browsing history, profile) |
| `arco-feedback:{runId}` | localStorage | Suppresses re-prompt of feedback widget on page refresh |
| `arco-admin-auth` | localStorage | Basic-auth header used by `blocks/admin/admin.js`; cleared via Reset Token |

## DA Content Paths

| Preset | DA path |
|--------|---------|
| `production` (default) | `/discover/{deterministic-slug}` |
| Any other preset | `/discover/{preset}/{deterministic-slug}` |

Slug is derived deterministically from the query (keyword extraction + stable hash). Fragments uploaded by `tools/upload-to-da.sh` go under `fragments/recommender/` for modal-loadable article content.
