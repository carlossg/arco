<!-- Generated: 2026-05-11 -->

# Admin Functionality

The admin surface gives operators a way to inspect every recommender generation, run multi-model experiments, drive large LLM evaluation sweeps, swap models at runtime, inspect the Vectorize index, and review real-user feedback. There is also an inline feedback widget on every fresh `/?q=...` run that the admin views surface and cross-link with the LLM judge.

The primary admin UI is the **EDS-hosted admin block** (`/admin`, source `blocks/admin/admin.js` + `admin.css`). All admin API routes live under `/api/admin/*` and are gated by HTTP Basic auth against `ADMIN_TOKEN`.

## Entry Points

| Environment | URL |
|-------------|-----|
| Production | `https://main--arco--froesef.aem.live/admin` |
| Preview / feature branch | `https://{branch}--arco--froesef.aem.page/admin` |
| Local dev (`aem up`) | `http://localhost:3000/admin` |

Login: username `admin`, password = `ADMIN_TOKEN` (set via `wrangler secret put ADMIN_TOKEN`). The block stores the encoded Basic-auth header in `localStorage[arco-admin-auth]`. Click **Reset Token** in the header to clear it.

A static `drafts/admin.html` mirrors the EDS markup for local testing without the CMS. The legacy server-rendered `/admin` HTML SPA on the worker (`src/admin.js → handleAdminUI`) is still routable but new features ship in the block.

## View Map

| Hash route | View | What it shows / does |
|------------|------|----------------------|
| `#/` | Sessions list | All sessions ordered by last-active — session ID, timestamps, run count, user agent |
| `#/sessions/:id` | Session detail | Pages grouped by `page_id` with initial query, URL, run count, total duration, tokens |
| `#/pages/:id` | Page overview | Metadata + totals |
| `#/pages/:id/reconstruction` | Full page | Reconstructs every run on the page plus inline follow-up chip markers showing options + clicks |
| `#/pages/:id/timeline` | Run timeline | Per-run breakdown with options shown and selected |
| `#/pages/:id/debug` | Debug | Per-run RAG/prompt/LLM/token output |
| `#/pages/:id/feedback` | Feedback tab | Run-level feedback rows for this page |
| `#/llm-config` | Model Settings | Pick active `{provider, model, temperature, maxTokens}` |
| `#/experiments` | Experiments list | All experiments (paginated) |
| `#/experiments/new` | New experiment | Run multi-model A/B for one query, live |
| `#/experiments/:id` | Experiment detail | Side-by-side variant overview + flip-through viewer (re-renders any variant) |
| `#/experiments/:id/variants/:variantId` | Variant deep-link | Direct link to a specific variant |
| `#/evaluations` | LLM Evaluations | All eval runs with status, phase, completed/total, judge model, est. cost |
| `#/evaluations/new` | New evaluation | Suite + models (≤8) + judge model + concurrency; preset chips (Cerebras only / GPT-OSS / Diverse) |
| `#/evaluations/:id` | Evaluation matrix | Queries × models grid; TTFT, duration, tokens/sec, judge composite, blocker badges, feedback chips, retry/rejudge controls |
| `#/vectorize` | Vectorize overview | Index stats + sampled embedding histogram |
| `#/vectorize/search` | Vectorize search | k-NN search over `arco-content` |
| `#/vectorize/items/:id` | Vector item detail | Per-vector content + neighbours |
| `#/feedback` | Feedback list | Summary strip + filters + CSV/JSON export |
| `#/feedback/run/:runId` | Run feedback detail | Run metadata + every feedback row + link to the page |
| `#/insights` | Insights | Reserved — LLM-summarized feedback (disabled stub) |

## Generation — Production Pipeline

The recommender's primary path is the `/api/generate` SSE endpoint. The admin views surface and operate on this pipeline.

### Pages, Runs, and Sessions

Every completed generation persists to D1 + KV:

- **D1 `generated_pages`** — fast, queryable run metadata (`run_id`, `session_id`, `page_id`, query, intent, journey, model, tokens, duration, DA URLs).
- **KV `SESSION_STORE[page:{runId}]`** — full payload: blocks, follow-up options, debug snapshot (intent, RAG, prompts, raw LLM output, timings, token counts).

The admin's **Sessions / Pages / Runs** views reconstruct any page from these stores. The **Debug** tab on a page detail surfaces the full RAG context, system + user prompts, and raw LLM output for any run.

### Cache-First Serving

Deterministic slugs (`generateSlug(query)` — keyword extraction + stable hash, no `Date.now()`) map every query to a single DA path. `GET /api/generate` checks `DAClient.exists(path)` before running the pipeline:

| URL | Behaviour |
|-----|-----------|
| `/?q=best+espresso` | First visit generates; repeat visits redirect to cache |
| `/?q=best+espresso&regen` | Bypass cache; regenerate; overwrite |
| `/?q=best+espresso&preset=my-preset` | Separate cache slot under `/discover/my-preset/...` |

### Model Settings — Switch the Active LLM at Runtime

`#/llm-config` picks the active `{provider, model, temperature, maxTokens}` for the main `/api/generate` pipeline. Persisted in `CACHE` KV at `llm-config:active` and read by `src/llm-config.js → getActiveLlmConfig(env)`. KV wins over the per-flow defaults in `pipeline/flows.js`. If the stored entry drops out of `MODEL_CATALOG` (e.g. a model was removed), the worker warns and falls back to the catalog default.

| API | Method | Purpose |
|-----|--------|---------|
| `/api/admin/catalog` | GET | `{ catalog: [{provider, model, label, available}], limits }` |
| `/api/admin/llm-config` | GET | `{ active }` (or `null` if unset) |
| `/api/admin/llm-config` | PUT | Set active config; validates against catalog; clamps `temperature ∈ [0, 2]`, `maxTokens ∈ [256, 16384]` |

Providers: `cerebras`, `cloudflare` (Workers AI), `sambanova`, `bedrock`. Add a model by adding a row to `MODEL_CATALOG` in `workers/recommender/src/providers/index.js` and redeploying.

There is **no** automatic provider fallback — 401 / 429 / 5xx surface directly so experiments remain honest.

## Experiments — Multi-Model A/B for One Query

`#/experiments/new` runs 1–12 variants in parallel against the same query. Upstream pipeline (intent classify + RAG + prompt build) runs **once**; only `llm-generate` re-runs per variant. Output: a side-by-side overview (duration, tokens, temp, max_tokens, TTFT) + flip-through viewer that re-renders each variant's blocks.

### Storage

| Table | Holds |
|-------|-------|
| `experiments` | Query, variant count, status, `shared_duration_ms`, intent/journey snapshot |
| `experiment_variants` | Per-variant `{provider, model, temperature, max_tokens}`, status, duration, TTFT, token counts, title, block count, error, judge score |

Per-variant blocks + debug + prompt live in `SESSION_STORE` at `experiment:{expId}:variant:{vid}` (90-day TTL) — same shape as `page:{runId}` so the admin block reuses its existing `renderStoredSection()` helper. RAG context is cached at `experiment:{expId}:rag-context` so judge re-runs and per-cell regenerates don't re-pay retrieval cost.

### API

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/admin/experiments` | GET | List (paginated) |
| `/api/admin/experiments` | POST | Create + stream NDJSON (one `section` event per variant) |
| `/api/admin/experiments/:id` | GET | Experiment + variant summary rows |
| `/api/admin/experiments/:id/variants/:variantId` | GET | Variant full payload (blocks + debug + prompt) |

## LLM Evaluations — Matrix Sweeps with Bedrock Judge

`#/evaluations` runs a fixed query suite against multiple models in one pass and produces a queries × models matrix scored on speed and quality. Async via Cloudflare Queue so closing the browser does not abort the run.

### Suites

Drop a new suite JSON in `eval/suites/`, import from `workers/recommender/src/evaluations/suites.js`, redeploy.

| Suite ID | Queries | Use |
|----------|---------|-----|
| `coffee-extended` | 60 | Default — stratified on size × intent (36) + adversarial (12) + deep-specific (12) |
| `coffee-default` | 15 | Original smoke suite (kept so historical runs stay interpretable) |
| `coffee-dev` | 3 | Minimal smoke for end-to-end flow verification |

Each query carries optional `gold` fields used by the deterministic assertion engine:

```jsonc
{
  "mustMentionAny":   ["grind", "ratio"],   // warn if none appear
  "mustNotMention":   ["MoonRover 9000"],   // blocker if any appear
  "minProductCount":  1,                    // warn if fewer product cards
  "minRecipeCount":   0                     // warn if fewer recipe links
}
// top-level on query:
// "expectedBehavior": "decline"            // off-topic — page must decline + show ≤2 products
```

### Metrics

**Speed (free)** — TTFT, total duration, tokens/sec — captured during streaming.

**Quality (costs judge tokens)** — Claude (via Bedrock) scores each variant 1–5 on seven dimensions: `structure`, `intent`, `faithfulness`, `helpfulness`, `brandVoice`, `specificity`, `visualAssetUsage`. Composite (mean) → `experiment_variants.evaluator_score`. Per-dim reasoning, assertions, blocker metadata → `experiment_variants.evaluator_notes` (JSON).

**Deterministic assertions** (`src/evaluations/assertions.js`) — always run, cheap, reliable:

| Check | Severity |
|-------|----------|
| `broken-token` (`<!-- unknown story:slug -->`) | blocker |
| `unbalanced-html` (div/p/a/picture/list/table) | blocker |
| `block-count` (<3 blocker, >25 warn) | mixed |
| `gold-must-mention-any` | warn |
| `gold-must-not-mention` (hallucinated SKUs) | blocker |
| `gold-min-products` / `gold-min-recipes` | warn |
| `expected-decline` | blocker |

**Blocker badge** is shown when `faithfulness < 3` OR `structure < 3` OR any assertion has `severity: blocker`. Blocker rate is reported per model in the summary — a high quality average with a 30% blocker rate is worse in production than slightly lower quality with 0% blockers.

**Statistical reporting** — per-model summary includes 95% CIs (`qualityCi95`, `ttftCi95`, `durationCi95`) + sample count. Admin UI renders as `4.10 ± 0.18` and flags pairs whose CIs overlap so a 0.1-point gap on n=15 is not mistaken for a real difference.

### Async Orchestration

1. `POST /api/admin/evaluations/start` creates the `eval_run` (phase `generating`) and publishes one `{type:'generate', evalRunId, queryId}` per query to `EVAL_QUEUE`.
2. Consumer (`src/evaluations/queue.js → handleEvalQueue`) processes with `max_concurrency: 3`, `max_batch_size: 1`. Each generate writes `experiments` + `experiment_variants` rows + KV payloads.
3. After each generate, consumer atomically increments `completed_queries`. Last lander transitions phase `generating → judging` and `sendBatch`-publishes `{type:'judge', ...}` per `complete` variant.
4. Judge writes `evaluator_score` / `evaluator_notes`. When no pending judges remain, CAS transitions phase to `complete` and `finalizeEvalRun` runs.

**Bedrock 429 handling** (no `Retry-After` header) — two layers:
- In-process retry once at ~500 ms in `src/evaluations/judge.js`.
- Queue-level: `msg.retry({ delaySeconds })` with stair-stepped delays `30 / 60 / 90 / 120 / 150 s` to cross the 60s quota window. `max_retries: 5` → up to ~7.5 min before DLQ.

**Cron fallback** (`triggers.crons: ["*/5 * * * *"]`) — `handleEvalCronFallback` scans for runs stuck in `generating`/`judging` with `last_activity_at` older than 2 min, processes up to 5 stuck runs × 3 pending queries / 3 pending judges per tick. Resets any `running` variants → `error` first so the next pass retries them.

**Headless writer gotcha (CRITICAL)** — `runOneQueryHeadless` and `regenerateOneVariantHeadless` must use `createNoopWriter()` (a `WritableStream` with a discarding write handler). A `TransformStream` writer without a reader on the readable side will buffer-block at `await writer.write(...)` and deadlock the worker until wall-time. Never use `new TransformStream().writable.getWriter()` for headless eval paths.

### Per-cell Operations

The matrix has hover-revealed `↻` per cell:
- **Cell failed at generation** → full regenerate (upstream pipeline + LLM + assertions + judge).
- **Cell complete** → cheap KV-only re-judge (no RAG re-pay).

Toolbar:
- **Resume** — re-publishes queue messages for queries with no experiment row or all-error variants.
- **Re-judge all** — confirm dialog; re-runs judge for every cell using persisted KV blocks.
- **Retry failed cells** — re-publishes regenerate messages for `error` variants.
- **Continue judging** — for runs created with `skipJudge: true` or where Bedrock was throttled at run time.

Auto-polls `/progress` every 3 s while phase is non-terminal.

### Eval API

```
GET  /api/admin/eval-suites                                       → { suites, judgeModels }
GET  /api/admin/evaluations                                       → paginated list
POST /api/admin/evaluations/start                                 → create + publish (primary)
POST /api/admin/evaluations                                       → create row only (legacy)
GET  /api/admin/evaluations/:id[?include=feedback]                → matrix payload
GET  /api/admin/evaluations/:id/progress                          → lightweight polling
POST /api/admin/evaluations/:id/resume                            → re-publish missing
POST /api/admin/evaluations/:id/queries                           → run one query inline (NDJSON, legacy/cron)
POST /api/admin/evaluations/:id/judge                             → bulk judge inline (NDJSON, legacy/cron)
POST /api/admin/evaluations/:id/variants/:vid/rejudge             → single rejudge
POST /api/admin/evaluations/:id/variants/:vid/regenerate          → single full regenerate
POST /api/admin/evaluations/:id/finalize                          → recompute summary + close
```

### Eval Queue Ops & Diagnostics

```
GET  /api/admin/eval-queue                       → { messages, age } from CF Queues API (needs CF_API_TOKEN)
GET  /api/admin/eval-queue/consumers             → consumer registration + delivery_paused
POST /api/admin/eval-queue/purge                 → drop all pending; auto-resumes delivery
POST /api/admin/eval-queue/resume-delivery       → set delivery_paused: false
POST /api/admin/eval-queue/test-invoke           → synthesize a batch and invoke the consumer directly
                                                   (bypasses CF Queue delivery — useful when delivery is broken)
```

`CF_API_TOKEN` needs **Cloudflare Queues: Edit** + **Account Analytics: Read** permissions.

### Cost Expectations

The new-eval form shows judge-only cost. Bedrock Anthropic pricing matches direct Anthropic (Sonnet 4 ~ $3/$15 per million in/out). At ~5k input + 500 output per cell × 15 queries × 4 models ≈ 60 calls ≈ $1–2 per Sonnet sweep. Opus ~5×, Haiku ~3× less.

## User Feedback

Every fresh `/?q=...` run shows a feedback widget above follow-up chips:

- 👍 / 👎 with single-click capture (downvote captured even if the user bails on the form).
- Comment textarea (≤1000 chars, truncated server-side).
- Flag categories: `wrong-product`, `off-topic`, `inappropriate-tone`, `harmful-unsafe`.
- Wrong-product multi-select sourced from `[data-run-id="…"] a[href*="/products/"]`.

Stored in D1 `run_feedback` (joinable with `generated_pages` for model-level / intent-level aggregates). `UNIQUE(run_id, session_id)` deduplicates re-submits.

### Admin Views

| Hash | Surfaces |
|------|----------|
| `#/feedback` | List + summary strip (totals, %positive, top flag, **judge↔user divergence count**) + filters (rating/flag/model/q/has-comment) + CSV/JSON export |
| `#/feedback/run/:runId` | Single-run feedback rows + product flags + full comment + dwell + UA |
| `#/pages/:id/feedback` | Page detail Feedback tab — every run's feedback |
| `#/evaluations/:id` | Per-query `👍N 👎M` chip when real-user feedback exists for the same query string — click jumps to `#/feedback?q=…` |

The **judge↔user divergence** signal joins `experiment_variants.evaluator_score ≥ 4` against `run_feedback.rating = -1` on matching `gp.query` — spots cases where the LLM judge rated a generation high but real users keep flagging it.

### Feedback API

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/feedback` | POST | none | Upsert; 204 on success |
| `/api/admin/feedback` | GET | admin | List with filters |
| `/api/admin/feedback/summary` | GET | admin | Header-strip aggregates + divergence count |
| `/api/admin/feedback/run/:runId` | GET | admin | Single-run detail |
| `/api/admin/feedback/export` | GET | admin | `?format=csv\|json`; flattened, streaming |
| `/api/admin/evaluations/:id?include=feedback` | GET | admin | Eval matrix payload + per-query feedback counts |

Spam/abuse gates (MVP): `UNIQUE(run_id, session_id)`, server-side comment truncation, flag/product allow-listing. No IP rate-limit yet.

## Vectorize Inspector

`#/vectorize` exposes `CONTENT_INDEX` (`arco-content`):

- **Overview** — index stats + sampled embedding histogram.
- **Search** — k-NN over the index (`GET /api/admin/vectorize/search?q=...&k=N`).
- **Item detail** — per-vector content + nearest neighbours.

Re-indexing is offline via the CLI: `cd workers/recommender && node scripts/index-content.js`. The script reads `content/stories-index.json` and `content/experiences-index.json` and skips entries with `published: false`.

## Direct D1 Queries (Operator Quick Reference)

```bash
# Most active sessions
wrangler d1 execute arco-sessions --command \
  "SELECT id, page_count, first_seen, last_seen FROM sessions ORDER BY page_count DESC LIMIT 10"

# Recent generations with intent + timing + model
wrangler d1 execute arco-sessions --command \
  "SELECT query, llm_provider, llm_model, intent_type, journey_stage, duration_ms, input_tokens, output_tokens
   FROM generated_pages ORDER BY created_at DESC LIMIT 20"

# Negative feedback by model
wrangler d1 execute arco-sessions --command \
  "SELECT gp.llm_model, COUNT(*) as bad
   FROM run_feedback rf JOIN generated_pages gp ON gp.id = rf.run_id
   WHERE rf.rating = -1 GROUP BY gp.llm_model ORDER BY bad DESC"

# Flag breakdown
wrangler d1 execute arco-sessions --command \
  "SELECT je.value as flag, COUNT(*) as n
   FROM run_feedback rf, json_each(rf.flags) je
   GROUP BY je.value ORDER BY n DESC"

# Eval-run status
wrangler d1 execute arco-sessions --command \
  "SELECT id, suite_id, status, phase, completed_queries, query_count, judge_model
   FROM eval_runs ORDER BY created_at DESC LIMIT 10"
```
