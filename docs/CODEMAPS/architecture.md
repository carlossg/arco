<!-- Generated: 2026-05-11 | Files scanned: 70+ | Token estimate: ~900 -->

# Architecture Overview

## System Type

AEM Edge Delivery Services site with a Cloudflare Worker backend, RAG over Cloudflare Vectorize, a swappable multi-vendor LLM, generated pages persisted to Document Authoring (DA), and an admin SPA for sessions, experiments, evaluations, model selection, vector inspection, and user feedback.

## High-Level Data Flow

```
Browser (EDS page)
  │
  ├─ Regular pages → delayed.js → browsing-signals.js → sessionStorage
  │                                                            │
  └─ /?q=... query  ──────────────────────────────────────────┘
        │                                                      │
        ▼                                                      │
  scripts.js (renderArcoRecommenderPage)                       │
        │  reads session context ◄──── session-context.js ◄───┘
        │  NDJSON SSE stream
        ▼
  Cloudflare Worker (arco-recommender)
        ├─ fetch()      → /api/generate, /api/suggest, /api/feedback, /api/admin/*
        ├─ queue()      → arco-eval-queries  (generate / judge / regenerate / rejudge)
        └─ scheduled()  → */5 min cron — eval stuck-run fallback
              │
        Cache lookup: DAClient.exists(/discover/{slug})
              │
              ├─ Hit  → SSE cache-hit event with liveUrl → client redirects
              │
              └─ Miss → Pipeline (flows.js)
                          safety-gate → rate-limit → analyze-behavior →
                          intent-classify → [persona ‖ use-case] →
                          rag-products → [rag-content ‖ rag-features ‖
                          rag-reviews ‖ rag-faqs] → build-prompt → llm-generate
                                          │
                          ┌───────────────┼─────────────────────────────────────┐
                          ▼               ▼                                     ▼
                      Vectorize        LLM provider (Cerebras /          DA (Document Authoring)
                      (arco-content)   Cloudflare AI / SambaNova /       /discover/{slug}
                                       Bedrock — selected via KV)        (createPage → preview → live)
                                          │
                          ◄────── NDJSON blocks + preview/live URLs ──────
        │
        ▼
  Persistence: D1 (run metadata) + KV SESSION_STORE (full payload)
  Optional: user feedback widget → POST /api/feedback → D1 run_feedback
```

## Service Boundaries

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Vanilla JS + CSS, EDS blocks | Page decoration, signal collection, stream rendering, feedback widget |
| Backend | Cloudflare Worker `arco-recommender` | Recommender pipeline, admin, analytics, eval orchestration |
| Async eval | Cloudflare Queue `arco-eval-queries` | Generate/judge/regenerate/rejudge work, 429 backoff via `delaySeconds` |
| Scheduled | Cloudflare Cron (`*/5 * * * *`) | Eval stuck-run fallback (defense-in-depth for queue delivery) |
| Content store | DA (Document Authoring) | Generated page persistence + preview/publish |
| Vector DB | Cloudflare Vectorize | Semantic RAG over `arco-content` |
| LLM | Cerebras / Cloudflare AI / SambaNova / AWS Bedrock | Page content generation + judge |
| Metadata DB | Cloudflare D1 (`arco-sessions`) | Sessions, runs, experiments, eval runs, feedback |
| Run payloads | Cloudflare KV (`SESSION_STORE`) | Full block + debug + RAG context payloads |
| Cache / config | Cloudflare KV (`CACHE`) | HTTP cache + `llm-config:active` |
| Guides | Cloudflare KV (`GUIDES`) | Static guide content |

## Cache-First Page Serving

Repeat queries skip the full pipeline:
1. Client sends query + session context to `/api/generate`.
2. Worker derives a deterministic slug (keyword extraction + stable hash, no `Date.now()`), checks `DAClient.exists(/discover/{slug})`.
3. Cache hit → SSE `cache-hit` event with `liveUrl` + `previewUrl`; client redirects immediately.
4. Cache miss → pipeline runs, persists to DA at the deterministic path, streams blocks to client.
5. `?regen` bypasses cache and overwrites the existing page.
6. `?preset=foo` opens a separate cache slot under `/discover/foo/{slug}`.

## Session / Page / Run Hierarchy

```
session (sessionStorage per browser tab) — sessionId UUID
  └─ page (?q= URL visit)                — pageId UUID
      └─ run (/api/generate call)        — runId UUID
            └─ feedback (optional)       — UNIQUE(run_id, session_id) in run_feedback
```

`run_index` is `0` for the initial run and `1..N` for each follow-up chip click. `parent_run_id` links a follow-up run back to the run whose chip was clicked.

## Admin Surface

A single EDS-hosted block (`/admin`, source `blocks/admin/admin.js`) is the primary admin UI, gated by HTTP Basic auth against `ADMIN_TOKEN`. See `docs/ADMIN.md` for the complete view map and route list. Major views:

- **Sessions / Pages / Runs** — browse history of every `/api/generate` call with full debug payloads.
- **Experiments** — multi-model A/B for one query; parallel variants share the upstream RAG pipeline.
- **LLM Evaluations** — matrix of query suite × models with Claude (Bedrock) judge; async via CF Queue; deterministic assertions + blocker badges + 95% CIs.
- **Model Settings** — pick active `{provider, model, temperature, maxTokens}` (persisted in CACHE KV).
- **Vectorize** — k-NN search + index stats over `arco-content`.
- **Feedback** — list / per-run detail / CSV+JSON export; eval matrix chips cross-link to user feedback per query.
