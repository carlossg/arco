<!-- Generated: 2026-04-22 | Files scanned: 20 | Token estimate: ~700 -->

# Backend Architecture — Cloudflare Worker (Recommender)

## Entry Point

`workers/recommender/src/index.js` (387 lines) — routes all HTTP requests.

## API Routes

```
POST /api/generate      → handleGenerate()     SSE stream, runs pipeline, saves generation
POST /api/persist       → handlePersist()      Persist DA page (called after client confirms)
POST /api/track         → handleTrack()        Analytics event tracking
GET  /api/stats         → handleStats()        Aggregate analytics stats
GET  /api/admin/*       → admin.js handlers    Admin SPA API endpoints
GET  /api/debug-search  → handleDebugSearch()  Debug RAG search results
POST /api/generate (dummy) → streamDummyPipeline()  Dev/testing dummy responses
```

## Pipeline Architecture

### Flow Definition (`pipeline/flows.js`)

Single flow: `recommender` (aka `default`)

```
rate-limit (gate)
  → analyze-behavior
  → intent-classify
  → [persona-match || use-case-match] (parallel)
  → rag-products (maxResults: 8)
  → [rag-content || rag-features || rag-reviews || rag-faqs] (parallel)
  → build-recommender-prompt
  → llm-generate (gpt-oss-120b, maxTokens: 5120, temp: 0.6)
```

### Pipeline Steps (`pipeline/steps/`)

| Step | File | Purpose |
|------|------|---------|
| `rate-limit` | rate-limit.js | Gate — blocks abusive request rates |
| `analyze-behavior` | analyze-behavior.js | Summarize browsing signals into behavior context |
| `intent-classify` | intent-classify.js | Classify query intent + journey stage using LLM |
| `persona-match` | persona-match.js | Match user to a persona from context.js catalog |
| `use-case-match` | use-case-match.js | Match query to product use case |
| `rag-products` | rag-products.js | Retrieve relevant products (keyword + Vectorize) |
| `rag-features` | rag-features.js | Retrieve product features for matched products |
| `rag-faqs` | rag-faqs.js | Retrieve relevant FAQs |
| `rag-reviews` | rag-reviews.js | Retrieve product reviews |
| `rag-content` | rag-content.js | Retrieve guides, experiences, comparisons, recipes, tools |
| `build-recommender-prompt` | build-recommender-prompt.js | Assemble system + user prompts from retrieved context |
| `llm-generate` | llm-generate.js | Call Cerebras LLM, stream NDJSON blocks to client |

### Pipeline Executor (`pipeline/executor.js`, 36 lines)

Iterates flow steps. Supports sequential and `{ parallel: [...] }` steps.

### Pipeline Context (`pipeline/context.js`, 87 lines)

`PipelineContext` class — holds request params, retrieved content, generated output, timing, token counts. Passed through all steps.

## Key Source Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.js` | 387 | Router, CORS, request parsing |
| `src/context.js` | 409 | Content catalog — products, personas, use cases, features, FAQs, reviews, Vectorize search |
| `src/recommender-prompt.js` | 437 | System/user prompt templates |
| `src/block-guide.js` | 419 | EDS block authoring guide injected into LLM prompt |
| `src/da-persist.js` | 409 | DA API client — create page, trigger preview, publish to live |
| `src/storage.js` | 234 | `saveGeneration()` — writes D1 metadata + KV payload |
| `src/admin.js` | 780 | Admin route handlers + sessions/pages/runs API |
| `src/images.js` | 420 | Image selection and URL resolution |
| `src/hero-images.js` | 180 | Hero image selection logic |
| `src/json-to-eds.js` | 201 | Converts LLM JSON output to EDS HTML block markup |
| `src/analytics.js` | 175 | Analytics event processing and aggregation |
| `src/stream-parser.js` | 84 | NDJSON SSE stream parser |
| `src/sanitize.js` | 41 | Input sanitization |
| `src/brand-voice.js` | 66 | Brand voice guidelines injected into prompts |

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `SESSIONS_DB` | D1 | Session + run metadata (`sessions`, `generated_pages` tables) |
| `SESSION_STORE` | KV | Full generation payloads keyed by `page:{runId}` |
| `CACHE` | KV | HTTP response cache |
| `GUIDES` | KV | Static guide content |
| `ANALYTICS` | KV | Analytics event storage |
| `AI` | Workers AI | Generates query embeddings for Vectorize |
| `CONTENT_INDEX` | Vectorize | Semantic search index for arco content corpus |

## DA Persistence Flow

```
saveGeneration(ctx, env, sessionId)
  → D1: upsertSession() + nextRunIndex() + insertRun()
  → KV SESSION_STORE: store debug snapshot + blocks keyed by page:{runId}

persistAndPublish(path, html, env)      [da-persist.js]
  → DA API: createPage()
  → DA API: triggerPreview()
  → waitForPreview() (polls up to 10x with 1s interval)
  → DA API: publishToLive()
  → CDN: purgeCache()
```

## Admin API

Routes under `/api/admin/`:

```
GET /api/admin/sessions          → list all sessions (paginated)
GET /api/admin/sessions/:id      → session detail + grouped pages
GET /api/admin/pages/:id         → page group with all KV run payloads
GET /api/admin/runs/:id          → single run KV payload
```

Auth: HTTP Basic — username `admin`, password = `ADMIN_TOKEN` secret.

## Content Retrieval (`context.js`)

Hybrid approach:
1. Keyword matching against hardcoded product/feature/FAQ/recipe catalog
2. Vectorize semantic search (`CONTENT_INDEX`) for broader content matches
3. Results merged and deduplicated

Exported: `searchContent()`, `getRelevantProducts()`, `getRelevantFeatures()`, `getRelevantFaqs()`, `matchPersona()`, `matchUseCase()`
