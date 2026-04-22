<!-- Generated: 2026-04-22 | Files scanned: 60+ | Token estimate: ~600 -->

# Architecture Overview

## System Type
AEM Edge Delivery Services site with Cloudflare Worker backend and AI-powered recommender.

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
        │  NDJSON SSE stream ──────────────────────────────────────────────┐
        │                                                                  ▼
        │                                            Cloudflare Worker (recommender)
        │                                              /api/generate
        │                                              /api/persist
        │                                              /api/track
        │                                              /api/admin/*
        │                                                    │
        │                                            Pipeline (flows.js)
        │                                              rate-limit → analyze-behavior →
        │                                              intent-classify → persona-match +
        │                                              use-case-match → rag-products →
        │                                              [rag-content + rag-features +
        │                                               rag-reviews + rag-faqs] →
        │                                              build-prompt → llm-generate
        │                                                    │
        │                                            ┌───────┴──────────┐
        │                                            ▼                  ▼
        │                                        Vectorize           Cerebras LLM
        │                                        (arco-content)     (gpt-oss-120b)
        │                                            │
        │                                            ▼
        │                                        DA (Document Authoring)
        │                                        /discover/{slug}
        │                                            │
        ◄────────────────────── preview_url + NDJSON blocks ───────────────┘
```

## Service Boundaries

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Vanilla JS + CSS, EDS blocks | Page decoration, signal collection, stream rendering |
| Backend | Cloudflare Worker | Recommender pipeline, admin, analytics |
| Content store | DA (Document Authoring) | Generated page persistence + preview/publish |
| Vector DB | Cloudflare Vectorize | Semantic RAG search over product/content corpus |
| LLM | Cerebras (`gpt-oss-120b`) | Page content generation |
| Metadata DB | Cloudflare D1 (SQLite) | Session/run metadata (`arco-sessions`) |
| Session store | Cloudflare KV (`SESSION_STORE`) | Full generation payloads keyed by runId |
| Cache | Cloudflare KV (`CACHE`) | HTTP cache layer |
| Guides | Cloudflare KV (`GUIDES`) | Static guide content |

## Cache-First Page Serving

Repeat queries skip the full pipeline:
1. Client sends query + session context to `/api/generate`
2. Worker checks `DAClient.exists(/discover/{slug})`
3. Cache hit → SSE `cache-hit` event with `liveUrl`, client redirects immediately
4. Cache miss → pipeline runs, persists to DA, streams blocks to client
5. `?regen` param bypasses cache and regenerates

## Session/Page/Run Hierarchy

```
session (sessionStorage per browser tab) — sessionId UUID
  └─ page (?q= URL visit) — pageId UUID
      └─ run (/api/generate call) — runId UUID
```
