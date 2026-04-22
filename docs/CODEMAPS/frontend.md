<!-- Generated: 2026-04-22 | Files scanned: 25 | Token estimate: ~700 -->

# Frontend Architecture

## Entry Points

```
head.html → scripts/aem.js (core EDS decoration, DO NOT MODIFY)
          → scripts/scripts.js (main decoration + recommender rendering)
          → styles/styles.css (critical/LCP styles)
          → styles/lazy-styles.css (below-fold styles)
          → scripts/delayed.js (3s after load — starts browsing signals)
```

## Three-Phase Loading

| Phase | Trigger | Key work |
|-------|---------|---------|
| Eager | immediately | decorate sections/blocks, load first section, LCP |
| Lazy | after LCP | load header/footer, remaining blocks |
| Delayed | 3s after load | `collectBrowsingSignals()`, analytics, prefetch |

## Key Scripts

| File | Lines | Purpose |
|------|-------|---------|
| `scripts/scripts.js` | 983 | Page decoration, auto-blocks, recommender streaming renderer |
| `scripts/aem.js` | 729 | Core EDS library — block loading, section decoration (read-only) |
| `scripts/session-context.js` | 391 | `SessionContextManager` class — sessionStorage for queries + browsing history |
| `scripts/browsing-signals.js` | 349 | Passive signal collector + local rule-based intent classifier |
| `scripts/speculative-engine.js` | 423 | Mouse-deceleration heuristic for prefetching follow-up chips |
| `scripts/for-you-prefetch.js` | 205 | Background prefetch for personalized "For You" query |
| `scripts/api-config.js` | 53 | `ARCO_RECOMMENDER_URL` constant + env detection |
| `scripts/delayed.js` | 5 | Kicks off `collectBrowsingSignals()` |
| `scripts/placeholders.js` | 38 | Fetches `/query-index.json` placeholder values |
| `scripts/welcome-modal.js` | 152 | One-time welcome modal logic |

## Recommender Page Rendering (`scripts/scripts.js`)

```
renderArcoRecommenderPage(query)
  │
  ├─ Check sessionStorage for quiz prefetch (PREFETCH_KEY) → renderPrefetchedBlocks()
  ├─ Check sessionStorage for ForYou prefetch (FORYOU_PREFETCH_KEY)
  │     ├─ NDJSON lines cached → replaySpeculativeResult()
  │     └─ Block data cached → renderPrefetchedBlocks()
  └─ No prefetch → SSE stream to /api/generate
        │  NDJSON events: block | follow-up | debug | cache-hit | error
        └─ render blocks inline → attach speculative-engine to follow-up chips
```

## Auto-Blocks (`buildAutoBlocks`)

| Block | Trigger |
|-------|---------|
| `hero` | First `<h1>` + `<picture>` in main |
| `fragment` | Links matching `/fragments/` path |
| `personalization-banner` | Built from session context on recommender pages |

## Blocks (35 total)

```
blocks/
  accordion/        article-excerpt/   blog-card/         bundle-card/
  calculator/       cards/             carousel/          columns/
  comparison-table/ debug-panel/       embed/             experience-cta/
  follow-up/        footer/            form/              fragment/
  header/           hero/              modal/             personalization-banner/
  product-card/     product-detail/    product-list/      quiz/
  quote/            recipe-steps/      search/            stats/
  table/            tabs/              testimonials/      video/
  admin/            analytics-analysis/
```

### Notable Blocks

| Block | Purpose |
|-------|---------|
| `follow-up` | Renders follow-up chip suggestions from recommender |
| `debug-panel` | Shows RAG/prompt/timing debug data (admin/debug mode) |
| `quiz` | Interactive quiz that fires a prefetched recommender query |
| `product-card/list/detail` | Product display with dynamic personalization |
| `admin` | EDS-hosted admin SPA (sessions, pages, runs) |
| `search` | Site search interface |
| `speculative-engine` | Not a block — JS module attached to follow-up chips |

## Session Context Flow

```
browsing-signals.js  →  SessionContextManager (sessionStorage)
  • page signals              • queries[]
  • scroll depth              • browsingHistory[] (last 15)
  • interactions              • inferredProfile{}
  • quiz answers                  └─ intent, stage, products viewed

scripts.js reads SessionContextManager → encodes → sends with /api/generate request
```

## Speculative Prefetch

`speculative-engine.js` watches mouse deceleration toward follow-up chips.
When confidence threshold reached → fires `prefetch` request to `/api/generate` with `speculative: true`.
Result cached in sessionStorage → on click, `replaySpeculativeResult()` plays back NDJSON instantly.

## CSS Structure

```
styles/styles.css       — critical LCP styles, layout skeleton
styles/lazy-styles.css  — post-LCP styles
styles/fonts.css        — web font definitions
blocks/{name}/{name}.css — block-scoped styles (loaded on demand)
```

Responsive breakpoints: 600px (tablet), 900px (desktop), 1200px (wide). Mobile-first with `min-width`.
