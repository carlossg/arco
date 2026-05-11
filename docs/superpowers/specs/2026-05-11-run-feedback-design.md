# Run-Level User Feedback — Design Spec

**Date:** 2026-05-11
**Status:** Approved (brainstorming complete)
**Supersedes:** `~/.claude/plans/i-want-to-work-magical-tiger.md`

## Problem

The arco recommender persists every generation in D1 (`generated_pages`) + KV (`page:{runId}`) and is reviewed offline by an LLM-judge in the evaluations tab. There is **no signal from real visitors** about whether a generation actually helped, misled, or harmed them. Improving the page generator — intent classification, RAG retrieval, prompt phrasing, product grounding — needs ground-truth from the people the pages are written for.

## Goal

Add a low-friction widget on every freshly-generated recommender run that captures:

- A binary rating (👍 / 👎)
- An optional free-text comment
- A small set of category flags
- For negative ratings: which of the run's products were wrong

Surface the data in the admin block for manual review, expose it as a downloadable file, integrate it into the existing eval matrix as a real-user counterweight to the LLM judge, and reserve the URL for a future LLM-powered insights view.

## Decisions (brainstorming outcomes)

| # | Question | Outcome |
|---|----------|---------|
| 1 | Who consumes this data? | All of: manual review, eval cross-check, future training/insights — design for export |
| 2 | Product-specific feedback? | Run-level form, auto-populated with the run's products as a multi-select |
| 3 | Insights tab in MVP? | Scaffolding only (route + stub button), no LLM call |
| 4 | Eval cross-check tightness? | Eval matrix shows per-cell user feedback chip; no "promote to suite" action yet |
| 5 | Harmful flag escalation? | Admin badge only; no webhook, no special logging |

## Non-goals (deferred)

- LLM-powered feedback summary endpoint (the `#/insights` route is a stub)
- "Promote to eval suite" action from a flagged feedback row
- IP-hash rate limit / spam protection beyond the `UNIQUE(run_id, session_id)` dedup
- Slack / email webhook for `harmful-unsafe` flag
- Per-product-card "👎 not for me" icons
- Widget on cached `/discover/{slug}` pages
- Custom eval suite editor

---

## Architecture

```
Browser (fresh /?q=... page)             Cloudflare Worker (arco-recommender)
─────────────────────────────             ──────────────────────────────────

scripts/recommender-stream.js
  ├─ streamAndAppendContent()            POST /api/feedback ──┐
  │  ├─ NDJSON stream                                          │
  │  └─ (on completion) ──────► scripts/feedback-widget.js ────┘
  │                              ├─ attaches <div.feedback-widget>
  │                              ├─ reads products from         ┌─────────────────┐
  │                              │  this run's sections         │  D1: run_feedback│
  │                              └─ POST /api/feedback ───────► │  (UPSERT)        │
  │                                                              └─────────────────┘
  │                                                                      │
  └─ section.dataset.runId = runId                                        │
                                                                          │
blocks/admin/admin.js                                                     │
  ├─ #/feedback         ────GET /api/admin/feedback?...─────────┐         │
  ├─ #/feedback/run/:id ────GET /api/admin/feedback/run/:id─────┤         │
  ├─ #/pages/:id        ────(+ feedback tab via /run/:id call)──┤         │
  ├─ #/evaluations/:id  ────GET /api/admin/evaluations/:id?include=feedback
  ├─ #/insights         ────(stub, no calls)                              │
  └─ toolbar            ────GET /api/admin/feedback/export?format=csv|json
                                                                          │
                                  All admin endpoints join with ──────────┘
                                  generated_pages for model/intent/query
```

---

## Data model

New migration: `workers/recommender/migrations/0008_run_feedback.sql`. Auto-applied on next worker boot (Cloudflare D1 runs unapplied migrations from the configured directory).

```sql
CREATE TABLE IF NOT EXISTS run_feedback (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,           -- FK → generated_pages.id
  page_id         TEXT,
  session_id      TEXT,
  rating          INTEGER NOT NULL,        -- +1 or -1
  comment         TEXT,                    -- ≤1000 chars, server-truncated
  flags           TEXT,                    -- JSON array of category keys
  wrong_products  TEXT,                    -- JSON array of product slugs
  dwell_ms        INTEGER,                 -- time on page at submission
  user_agent      TEXT,
  ip_hash         TEXT,                    -- SHA-256 of IP, same helper as sessions
  created_at      INTEGER NOT NULL,        -- Unix seconds
  updated_at      INTEGER NOT NULL,
  UNIQUE(run_id, session_id)               -- one row per (run, session); upsert on conflict
);
CREATE INDEX IF NOT EXISTS idx_feedback_run     ON run_feedback(run_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON run_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_rating  ON run_feedback(rating, created_at DESC);
```

**Flag categories** (closed set; client and server both validate):

| Key | Label |
|-----|-------|
| `wrong-product` | Wrong product / made-up facts |
| `off-topic` | Off-topic |
| `inappropriate-tone` | Inappropriate tone / off-brand |
| `harmful-unsafe` | Harmful or unsafe |

The free-text `comment` field doubles as "other" — no explicit "other" checkbox.

**Joinable** to `generated_pages` on `run_id` to pick up `llm_provider`, `llm_model`, `intent_type`, `journey_stage`, `query`, `da_path`, `created_at`, `duration_ms`, `input_tokens`, `output_tokens`. This is what powers the export, the eval-matrix cross-check, and the admin filters.

---

## Backend

### New file: `workers/recommender/src/feedback.js`

Six handler exports:

```js
export async function handleSubmitFeedback(request, env) { /* POST /api/feedback */ }
export async function handleListFeedback(request, env)    { /* GET  /api/admin/feedback */ }
export async function handleRunFeedback(request, env, runId) { /* GET /api/admin/feedback/run/:id */ }
export async function handleFeedbackSummary(request, env) { /* GET  /api/admin/feedback/summary */ }
export async function handleFeedbackExport(request, env)  { /* GET  /api/admin/feedback/export */ }
// + helper: attachFeedbackToVariants(env, evalRunId, variants) used by admin.js
```

#### `POST /api/feedback` (public, no admin auth)

Request body:

```jsonc
{
  "runId": "uuid",                  // required
  "sessionId": "uuid",              // required
  "rating": -1,                     // required, must be -1 or +1
  "comment": "string",              // optional, server-truncates to 1000 chars
  "flags": ["wrong-product"],       // optional; unknown keys silently dropped
  "wrongProducts": ["primo","doppio"], // optional; deduped, max 20 entries
  "dwellMs": 12345                  // optional
}
```

Validation:
- `rating ∈ {-1, +1}` — anything else → 400
- `comment` trimmed + truncated to 1000 chars, never 400s
- `flags` filtered against the closed set, unknowns dropped
- `wrongProducts` deduped, max 20

Behavior:
- Hash IP via existing `hashIp()` (in `storage.js`)
- `INSERT … ON CONFLICT(run_id, session_id) DO UPDATE SET …` — upsert
- Return `204 No Content`
- CORS preflight handled by the existing top-of-handler block

#### `GET /api/admin/feedback`

Query params: `limit` (default 50, max 200), `offset`, `rating` (`up|down|all`), `flag` (one of the four keys), `model`, `q` (substring on `generated_pages.query`), `hasComment` (`true`), `since`, `until`.

Returns:

```jsonc
{
  "items": [
    {
      "id": "...", "run_id": "...", "page_id": "...", "session_id": "...",
      "rating": -1, "comment": "...", "flags": ["wrong-product"],
      "wrong_products": ["primo"], "dwell_ms": 12345,
      "created_at": 1715423000, "updated_at": 1715423000,
      "query": "...", "intent_type": "...", "journey_stage": "...",
      "llm_provider": "cerebras", "llm_model": "gpt-oss-120b",
      "da_path": "/discover/..."
    }
  ],
  "total": 1234
}
```

#### `GET /api/admin/feedback/run/:runId`

Returns: feedback rows for the run + the run's metadata + a per-flag count.

#### `GET /api/admin/feedback/summary?since=`

Aggregates over the window:

```jsonc
{
  "total": 482,
  "positive": 318,
  "negative": 164,
  "percentPositive": 65.9,
  "topFlags": [
    {"flag": "wrong-product", "count": 71, "percent": 43.3},
    {"flag": "off-topic", "count": 38, "percent": 23.2}
  ],
  "byModel": [{"model": "gpt-oss-120b", "positive": 142, "negative": 38}],
  "byIntent": [{"intent": "comparison", "positive": 51, "negative": 22}],
  "divergence": 14   // count of runs where Claude judge ≥4 but user rating = -1
}
```

`divergence` is computed by joining `experiment_variants.evaluator_score` with `run_feedback.rating` on `run_id` (when feedback's `run_id` matches a variant).

#### `GET /api/admin/feedback/export?format=csv|json&since=&until=`

Streams a flattened join. CSV columns:

```
created_at_iso, run_id, page_id, session_id, query, intent_type, journey_stage,
llm_provider, llm_model, rating, flags (semicolon-joined), wrong_products (semicolon-joined),
comment, dwell_ms, da_path
```

`format=json` → NDJSON (one JSON object per line) for stream-friendly ingestion. Both stream via `ReadableStream` to avoid loading the whole result set into memory.

### Wire-up in `workers/recommender/src/index.js`

Six new route branches, near the existing `handlePersist` block:

```js
if (url.pathname === '/api/feedback' && request.method === 'POST') return handleSubmitFeedback(request, env);

if (url.pathname.startsWith('/api/admin/feedback')) {
  const authResp = await requireAdminAuth(request, env);
  if (authResp) return authResp;

  if (url.pathname === '/api/admin/feedback' && request.method === 'GET') return handleListFeedback(request, env);
  if (url.pathname === '/api/admin/feedback/summary' && request.method === 'GET') return handleFeedbackSummary(request, env);
  if (url.pathname === '/api/admin/feedback/export' && request.method === 'GET') return handleFeedbackExport(request, env);
  const m = url.pathname.match(/^\/api\/admin\/feedback\/run\/([^/]+)$/);
  if (m && request.method === 'GET') return handleRunFeedback(request, env, m[1]);
}
```

### Patch existing eval detail handler

In `workers/recommender/src/admin.js`, the handler for `GET /api/admin/evaluations/:id`: when `?include=feedback` is set, attach a `feedback` summary to each variant row by looking up rows in `run_feedback` whose `query` matches the variant's query. Result added per variant:

```jsonc
{ "feedback": { "up": 3, "down": 1, "comments": 2 } }
```

No new endpoint — just an opt-in expansion of the existing one.

---

## Frontend

### New file: `scripts/feedback-widget.js`

One exported function:

```js
export function attachFeedbackWidget(container, { runId, pageId, sessionId, query }) { ... }
```

Behavior:

1. Builds `<div class="section feedback-widget" data-run-id="{runId}">` and appends to `container`. Sits as a sibling to streamed content sections, anchored before `.follow-up-container`.
2. Reads products from the just-rendered run's sections: `container.querySelectorAll('[data-run-id="{runId}"] a[href*="/products/"]')` — extracts slug from `href` and label from nearest heading/text. Deduped. If empty, the product multi-select is omitted from the form.
3. State machine:
   - **Idle** → two thumb buttons.
   - **👍 click** → POST `{rating: +1}` immediately, collapse to "Thanks 👍 [✏ add note]".
     - Clicking the `[✏ add note]` chip reopens with comment textarea only (no flags, no products).
   - **👎 click** → POST `{rating: -1}` immediately (capture even if user bails), expand the form:
     - `<textarea>` (rows=3, maxlength=1000, placeholder `What went wrong? (Don't include personal info)`)
     - Four flag checkboxes (in label order from the table above)
     - Product multi-select (only if products were detected)
     - `[Send]` `[Skip]`
   - **Send** → second POST with full payload (server upserts). Collapse to "Thanks 👎".
   - **Skip** → collapse without second POST (downvote already recorded).
4. Idempotency: on mount, read `localStorage[arco-feedback:{runId}]`. If present, render the collapsed acknowledged state.
5. `dwell_ms` = `performance.now()` at submission minus the time the widget mounted (close enough proxy for "time spent on this run").
6. Uses `getAPIEndpoint('recommender')` from `scripts/api-config.js` — branch-worker routing auto-handled.
7. Zero dependencies. Inline SVG thumb icons.

### New file: `scripts/feedback-widget.css`

Scoped to `.feedback-widget`. Mobile-first; matches the visual tone of `.follow-up-container`. Tap targets ≥44px.

### Modify `scripts/recommender-stream.js`

Two surgical changes:

1. Inside `renderStreamedSection(section, content, state)` (around line 100): set `section.dataset.runId = state.runId`. Thread `runId` through `state` (already created at the top of `streamAndAppendContent`).
2. At the end of `streamAndAppendContent`, after the NDJSON loop completes:

   ```js
   const { attachFeedbackWidget } = await import('./feedback-widget.js');
   attachFeedbackWidget(container, {
     runId,
     pageId: getCurrentPageId(),
     sessionId: SessionContextManager.getSessionId(),
     query,
   });
   ```

   Placed before the `addQuery` / `addGeneratedQuery` calls so it lands in the DOM as the run finishes. When the user clicks a follow-up chip, the next `streamAndAppendContent` call clears the old `.follow-up-container` but leaves this widget in place — exactly the desired behavior.

---

## Admin views

All changes inside `blocks/admin/admin.js` and `blocks/admin/admin.css`. Reuses the existing `api()` helper (Basic-auth from `localStorage['arco-admin-token']`) and `navigate()` / `parseRoute()`.

### New: `#/feedback` (list)

- Header strip from `/api/admin/feedback/summary`:
  `482 total · 65.9% 👍 · top flag wrong-product 43% · 14 judge↔user divergences`
- Toolbar filters: rating, flag, model, query substring, has-comment, date-range, `[Download CSV] [Download JSON]`.
- Table: time · query (truncated, link → `#/pages/:pageId`) · rating · flag badges · wrong-product badges · comment preview · model.
- Row click → `#/feedback/run/:runId`.

### New: `#/feedback/run/:runId`

- Run metadata + "View page" → `#/pages/:pageId`.
- All feedback rows for that run (multiple sessions): rating, flags, wrong products, full comment, dwell, UA, timestamp.

### New: `#/insights` (stub)

Empty card titled "Feedback insights" with a disabled `[Generate summary]` button. Tooltip: "Coming soon." No API calls.

### Extend `#/pages/:id` with a "Feedback" tab

Fifth tab alongside Overview / Full page / Run timeline / Debug. For each run on the page, calls `/api/admin/feedback/run/:runId` and renders the rows grouped by run.

### Extend `#/evaluations/:id` with per-cell feedback chip

When the eval-detail fetch is made, append `?include=feedback`. Each cell that has feedback for its query renders a small chip like `👍3 👎1` (clickable → modal listing those feedback rows). Cells with `evaluator_score ≥ 4` and any `rating = -1` get a distinct `⚠ divergence` tint to highlight the most interesting cases.

### CSS

Append a `/* feedback */` section to `admin.css` reusing existing tokens. No new design system.

---

## Files touched

| Status | Path |
|--------|------|
| NEW    | `workers/recommender/migrations/0008_run_feedback.sql` |
| NEW    | `workers/recommender/src/feedback.js` |
| MOD    | `workers/recommender/src/index.js` (6 route branches) |
| MOD    | `workers/recommender/src/admin.js` (eval detail `?include=feedback`) |
| NEW    | `scripts/feedback-widget.js` |
| NEW    | `scripts/feedback-widget.css` |
| MOD    | `scripts/recommender-stream.js` (data-run-id + widget attach) |
| MOD    | `blocks/admin/admin.js` (feedback list, detail, stub, page tab, eval chip) |
| MOD    | `blocks/admin/admin.css` |
| MOD    | `AGENTS.md` (new "User Feedback" section after "LLM Evaluation Tab") |

## Reused utilities

- `hashIp()` — `workers/recommender/src/storage.js`
- `requireAdminAuth()` — `workers/recommender/src/admin.js`
- `api()`, `navigate()`, `parseRoute()` — `blocks/admin/admin.js`
- `getAPIEndpoint('recommender')` — `scripts/api-config.js`
- `SessionContextManager.getSessionId()`, `getCurrentPageId()` — already used by `streamAndAppendContent`

## Verification

End-to-end manual walkthrough (no automated test runner exists for this project — matches the bar set by `admin`, `experiments`, and `evaluations`).

### 1. Migration

```
cd workers/recommender
wrangler d1 execute arco-sessions --local --file migrations/0008_run_feedback.sql
wrangler d1 execute arco-sessions --local --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='run_feedback'"
```

### 2. Dev servers

- `aem up` (port 3000)
- `cd workers/recommender && npm run dev`
- Confirm `scripts/api-config.js` resolves localhost to the local worker.

### 3. Widget happy path

1. Open `http://localhost:3000/?q=best+espresso+under+1000`.
2. After generation, widget appears at the bottom before follow-up chips.
3. Click 👍 → "Thanks 👍" plus `[✏ add note]` chip.
4. Check D1: `SELECT * FROM run_feedback ORDER BY created_at DESC LIMIT 1` shows `rating=1, comment IS NULL, flags='[]'`.
5. Refresh — widget mounts in pre-rated state from localStorage; no new D1 row.

### 4. Widget sad path with product selection

1. Click a follow-up chip → new run renders below; new widget appears with its own runId.
2. Click 👎 — confirm one D1 row with `rating=-1, flags='[]', wrong_products='[]'` written before the form expands.
3. Form expands; product multi-select lists the product cards rendered in this run.
4. Type "the Primo is way too small for what I need", check `wrong-product`, tick "Arco Primo" in the product list, click Send.
5. D1 row count unchanged; row's `comment`, `flags`, `wrong_products`, `dwell_ms`, `updated_at` updated.

### 5. Admin smoke

1. `http://localhost:3000/admin#/feedback`.
2. Header strip shows correct totals + top flag.
3. Filter `rating=down` + `flag=wrong-product` — only the second row shown.
4. Open `#/feedback/run/{runId}` — full comment + flags + product list visible.
5. Download CSV — file contains both rows with flattened columns.
6. Download JSON — NDJSON, parses cleanly with `jq -c '.'`.
7. `#/pages/{pageId}` — new "Feedback" tab lists both rows grouped by run.
8. `#/insights` — stub card renders, button disabled.

### 6. Eval integration

1. Run a small `coffee-dev` eval against the same query you just generated.
2. Open `#/evaluations/:id` — that query's row shows the `👍0 👎1` chip and (if judge score ≥4) a `⚠ divergence` tint.
3. Click the chip → modal lists the feedback comment.

### 7. Dedup verification

1. Re-submit on the same run from the same session with a different comment.
2. D1 row count unchanged; `comment` and `updated_at` updated.

### 8. Production smoke (post-deploy)

```
curl -s -X POST https://arco-recommender.franklin-prod.workers.dev/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"runId":"<existing>","sessionId":"<existing>","rating":-1,"comment":"smoke"}'
wrangler d1 execute arco-sessions --remote \
  --command "SELECT * FROM run_feedback ORDER BY created_at DESC LIMIT 1"
```

---

## Open follow-ups (separate specs)

- LLM-powered `/api/admin/insights/summary` and a real `#/insights` view
- "Promote query to eval suite" action from feedback rows
- IP-hash rate limiting and abuse handling
- Slack/email webhook for `harmful-unsafe`
- Cached `/discover/{slug}` widget variant (lookup runId via `da_path`)
- Per-product-card "👎 not for me" affordance
