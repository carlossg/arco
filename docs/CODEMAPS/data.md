<!-- Generated: 2026-04-22 | Files scanned: 5 | Token estimate: ~400 -->

# Data Architecture

## D1 Database — `arco-sessions`

Schema in `workers/recommender/migrations/0001_sessions.sql`

### `sessions` table

```sql
sessions(
  id           TEXT PRIMARY KEY,   -- sessionId (UUID, per browser tab)
  ip_hash      TEXT,               -- hashed client IP
  user_agent   TEXT,
  first_seen   TEXT,               -- ISO timestamp
  last_seen    TEXT,
  page_count   INTEGER DEFAULT 0
)
```

### `generated_pages` table (runs)

```sql
generated_pages(
  id              TEXT PRIMARY KEY,  -- runId (UUID, per /api/generate call)
  session_id      TEXT,              -- FK → sessions.id
  page_id         TEXT,              -- groups runs for same ?q= URL visit
  page_url        TEXT,
  run_index       INTEGER,           -- 0=initial, 1..N=follow-up clicks
  parent_run_id   TEXT,              -- which run's chip was clicked

  query           TEXT,
  previous_queries TEXT,             -- JSON array
  title           TEXT,
  intent_type     TEXT,
  journey_stage   TEXT,
  flow_id         TEXT,

  follow_up_type    TEXT,
  follow_up_label   TEXT,
  follow_up_options TEXT,            -- JSON array of chips shown

  block_count     INTEGER,
  created_at      TEXT,
  duration_ms     INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,

  da_path         TEXT,
  preview_url     TEXT,
  live_url        TEXT
)
```

## KV Namespaces

### `SESSION_STORE` — Full generation payloads

Key: `page:{runId}`

```json
{
  "blocks": [{ "index": 0, "blockType": "hero", "html": "..." }],
  "followUpOptions": ["...", "..."],
  "followUpClicked": "...",
  "debug": {
    "intent": {...},
    "rag": { "products": [...], "features": [...], "faqs": [...], "recipes": [...], "heroImages": [...] },
    "behaviorAnalysis": "...",
    "systemPrompt": "...",
    "userPrompt": "...",
    "timings": { "intentClassify": 0, "rag": 0, "llm": 0 },
    "model": "gpt-oss-120b",
    "inputTokens": 0,
    "outputTokens": 0,
    "rawLlmOutput": "..."
  },
  "request": { "query": "...", "sessionId": "...", "pageId": "...", "runId": "..." }
}
```

### `CACHE` — HTTP cache

Key: arbitrary cache key derived from request. Short-lived.

### `GUIDES` — Static guide content

Key: guide slug. Value: guide markdown/HTML content for RAG retrieval.

### `ANALYTICS` — Analytics events

Key: event ID. Value: analytics event payload.

## Vectorize Index — `CONTENT_INDEX`

Populated by `workers/recommender/scripts/index-content.js` (CLI tool).
Embeddings generated via Workers AI binding (`AI`).
Used in `searchContent()` in `src/context.js`.

## Client-Side Storage (sessionStorage)

| Key | Purpose |
|-----|---------|
| `arco-session-id` | UUID for this browser tab (generated once) |
| `arco-quiz-prefetch` | Prefetched blocks from quiz interaction |
| `arco-foryou-prefetch` | Prefetched blocks for "For You" link |
| `arco-foryou-query` | Query string used for For You prefetch |
| `arco-session-context` | Full `SessionContextManager` state (queries, browsing history, profile) |

## DA Content Paths

Generated pages are persisted to DA under deterministic paths:

| Preset | DA Path |
|--------|---------|
| production (default) | `/discover/{slug}` |
| other preset | `/discover/{preset}/{slug}` |

Slug is derived from query by keyword extraction + stable hash (no `Date.now()`).
