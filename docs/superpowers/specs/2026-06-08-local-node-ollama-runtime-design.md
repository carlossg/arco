# Local Ollama Runtime for the Recommender Worker

**Date:** 2026-06-08
**Branch:** `local-dev`
**Status:** Approved design

## Goal

Run the Arco recommender locally on the developer's Mac and have its single
LLM-generation step talk to an **Ollama** server running on EC2, reached through
an SSH-forwarded local port (`localhost:11434`). The purpose is to evaluate
**local-model quality and speed through the real pipeline** — real RAG, real
prompts, real EDS-block output — not a toy harness.

## Decisions (from brainstorm)

| Decision | Choice | Consequence |
|---|---|---|
| What to measure | Ollama quality **+** speed via the real pipeline | RAG fidelity matters — cannot stub it out |
| Frontend | Both: browser via `aem up` **and** a backend bench script | Need the real EDS frontend to stream from the local worker |
| RAG source | Real CF Vectorize + Workers AI | Identical embeddings/index to production |
| Persistence | Local (KV/D1 emulated by Miniflare) | Admin/sessions work locally as a bonus; no shims |
| Ollama API | OpenAI-compatible `/v1/chat/completions`, model via env | Swap models by editing `.dev.vars` + restart; no code change |
| **Runtime** | **`wrangler dev` + remote bindings** (not a Node port) | Tiny change set; runs locally; `workerd` not Node |

### Why `wrangler dev` instead of a Node port

The original plan was a Node adapter (`node/server.js`) plus REST shims for
KV/D1/AI/Vectorize. `wrangler dev` makes almost all of that unnecessary:

- **Local mode runs with remote bindings enabled by default** (confirmed by the
  `--local` help text: *"Run locally with remote bindings disabled"*). So
  Vectorize and Workers AI proxy to the **real** production resources while the
  worker executes locally.
- KV (`CACHE`, `SESSION_STORE`, `GUIDES`) and D1 (`SESSIONS_DB`) are emulated by
  Miniflare and persisted under `.wrangler/state` — no shim code, and the admin
  Sessions/Eval views work locally.
- `workerd` can `fetch` the SSH-forwarded `localhost:11434`, so Ollama is
  reachable.

`--remote` is the **wrong** tool: it runs the worker *on* Cloudflare's edge,
which could not reach the developer's `localhost` Ollama tunnel.

The only thing this approach does not provide is a true **Node** runtime. Since
the workload is LLM-bound (Ollama generation dominates; RAG calls are identical
remote calls either way; the pipeline glue is sub-millisecond), `workerd` vs
Node is measurement noise for this goal. A Node adapter remains a future option
if the worker is ever deployed to EC2 as a standalone Node service — the Ollama
provider is written runtime-agnostically (plain `fetch`, no SDK) so it would
port unchanged.

## Architecture

```
Chrome (aem up :3000) ──fetch──┐  api-config.js: localhost → http://localhost:8787
                               │
curl / node bench ─────────────┤
                               ▼
              wrangler dev (local workerd, port 8787)
              ┌───────────────────────────────────────────┐
              │ worker.fetch (UNCHANGED)                   │
              │   handleGenerate → executeFlow             │
              └───────┬───────────────────────────────────┘
        ┌─────────────┼───────────────────────────────────────────┐
        ▼             ▼                            ▼               ▼
  ollama provider   env.AI / env.CONTENT_INDEX   CACHE/D1/      ANALYTICS/
  /v1/chat/...      → REMOTE bindings            SESSION_STORE  EVAL_QUEUE
  localhost:11434   (real Workers AI + Vectorize)→ local        → local
  (ssh-forwarded)                                  (Miniflare)    (Miniflare)
```

## Components

### 1. `src/providers/ollama.js` (new)

A near-verbatim clone of `src/providers/sambanova.js`. OpenAI-compatible SSE
streaming against `${OLLAMA_BASE_URL}/chat/completions`. Implements the existing
provider contract: an async generator yielding `{type:'delta', text}` chunks and
a terminal `{type:'usage', usage}` frame.

- Base URL from `env.OLLAMA_BASE_URL` (e.g. `http://localhost:11434/v1`).
- No API key required (Ollama ignores `Authorization`); send a dummy bearer for
  OpenAI-client compatibility.
- `stream: true`, `stream_options: { include_usage: true }`. Ollama's
  OpenAI-compatible endpoint returns `usage` with `prompt_tokens` /
  `completion_tokens`, mapped onto the existing usage shape.
- Errors set `err.status` so the existing 401/429/5xx messaging works.

### 2. `src/providers/index.js` (edit)

- Import `ollama`, add to the `PROVIDERS` map.
- `PROVIDER_BASE_REQUIREMENTS.ollama = (env) => env.OLLAMA_BASE_URL ? [] : ['OLLAMA_BASE_URL']`.
- `findCatalogEntry(provider, model)`: when `provider === 'ollama'` and the model
  is not in `MODEL_CATALOG`, **synthesize** `{ provider:'ollama', model, label:`Ollama · ${model}` }`.
  This lets any pulled model be selected via env or admin without editing the
  catalog for each one.
- Add a couple of representative Ollama rows to `MODEL_CATALOG` (e.g.
  `llama3.1:8b`, `qwen2.5:7b`) so the admin Model-Settings/eval dropdowns list
  the provider. Arbitrary models still work via the synthesize path.

### 3. `src/llm-config.js` (edit)

`getActiveLlmConfig(env)`: on a KV miss, if `env.OLLAMA_MODEL` is set, return
`{ provider:'ollama', model: env.OLLAMA_MODEL, temperature:null, maxTokens:null }`
instead of `null`. Effect: setting `OLLAMA_MODEL` in `.dev.vars` makes the local
worker default to Ollama with zero clicks; the admin Model-Settings KV entry
still overrides it (KV wins). Production is unaffected (`OLLAMA_MODEL` unset).

### 4. `wrangler.jsonc` (edit)

Mark the Vectorize binding (and, if needed, AI) as remote so local dev proxies
to production:

```jsonc
"vectorize": [
  { "binding": "CONTENT_INDEX", "index_name": "arco-content", "remote": true }
]
```

The remote flag is a local-dev concept; `wrangler deploy` binds the resource
natively and ignores it. Exact key (`remote` vs `experimental_remote`) to be
confirmed against wrangler 4.98 at first run; behavior is identical.

### 5. `scripts/api-config.js` (edit)

When `window.location.hostname` is localhost and no explicit
`window.ARCO_CONFIG.RECOMMENDER_URL` override is set, default the recommender URL
to `http://localhost:8787` (the `wrangler dev` port). Affects local dev only;
`*.aem.page`/`*.aem.live` paths are untouched. CORS already works — the worker
emits `Access-Control-Allow-Origin: *`.

### 6. `workers/recommender/.dev.vars.example` (new, committed)

Documents the local secrets/vars (`.dev.vars` itself is gitignored):

```
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=llama3.1:8b
# Cloudflare auth for remote bindings is provided by `wrangler login`
# (or CLOUDFLARE_API_TOKEN). DA_* are not needed locally — persist is disabled.
```

### 7. `workers/recommender/package.json` (edit)

- Bump `wrangler` devDependency `^4.83.0` → `^4.98.0`.
- Add `"dev:ollama": "node tools/precompile-prompts.js && wrangler dev"` (alias
  documenting the Ollama flow; same as `dev`).

### 8. `workers/recommender/tools/bench-ollama.js` (new)

A small Node script for the backend half of "Both": POSTs a list of queries to
`http://localhost:8787/api/generate`, reads the NDJSON stream, and records per
query TTFT, total duration, section count, and token usage to a JSON/CSV file.
Reuses an existing eval suite (`eval/suites/coffee-dev.json`) for the query list.

## Safety

- **No DA writes.** `/api/generate` does not touch DA. The only DA write is
  `persistAndPublish` via `POST /api/persist`, which the browser calls *after* a
  generation to cache the page. Running locally, this must not write to the
  production DA org. Mitigation: the bench harness never calls `/api/persist`;
  for the browser path, the page-caching persist call is disabled in local mode
  (guard on `IS_LOCAL` in the client, or leave `DA_*` unset so `persistAndPublish`
  no-ops/fails closed). Confirm during implementation that an unset DA token
  causes `/api/persist` to fail without side effects.
- **Remote bindings hit production read paths only** (Vectorize query, Workers AI
  embedding) — both read-only. No production writes.

## What is explicitly NOT built

- No Node adapter / HTTP bridge / KV/D1/AI/Vectorize REST shims (superseded by
  `wrangler dev`).
- No new persistence layer (Miniflare handles it).
- No catalog edit per Ollama model (synthesize-on-lookup handles arbitrary
  models).

## Testing / acceptance

1. `npm install` + `npm run dev` in `workers/recommender` starts `wrangler dev`
   on :8787 with remote Vectorize/AI.
2. `curl -N -XPOST localhost:8787/api/generate -d '{"query":"best espresso under 1000","sessionId":"test"}'`
   streams NDJSON sections; debug frame shows `provider: "ollama"` and the
   configured model.
3. RAG debug shows non-empty products/guides (remote Vectorize working).
4. Browser: `aem up` at :3000, submit a `/?q=` query, page streams from the
   local worker (Network tab shows `localhost:8787`).
5. `node tools/bench-ollama.js` produces a timings report.
6. Swapping `OLLAMA_MODEL` in `.dev.vars` + restart changes the model with no
   code edit.
