# Vertex AI Provider Design

**Date:** 2026-06-19  
**Branch:** vertex-ai-support  
**Status:** Updated — OpenAI-compatible Model Garden vLLM endpoint

## Goal

Add Google Vertex AI as a first-class LLM provider in the recommender worker so that models deployed on Vertex AI Model Garden (via a dedicated vLLM endpoint) can be selected in Model Settings and used in evals.

## Scope

- Provider file `workers/recommender/src/providers/vertex.js`
- Registration in `workers/recommender/src/providers/index.js` (catalog + availability + auto-discovery)
- `.dev.vars.example` documentation
- Comment update in `wrangler.jsonc`

No changes to the pipeline, storage, admin UI, or eval runner — all existing machinery already consumes the normalized `{type:'delta'}` / `{type:'usage'}` contract.

## Actual Deployment Architecture

The Vertex AI deployment is a **Model Garden vLLM dedicated endpoint** — not the native `streamGenerateContent` API. It exposes an OpenAI-compatible `/chat/completions` endpoint at a dedicated DNS name.

**Endpoint pattern:**
```
https://mg-endpoint-{ID}.{REGION}-{PROJECT_NUMBER}.prediction.vertexai.goog/v1/projects/{PROJECT}/locations/{REGION}/endpoints/{ENDPOINT_ID}
```

**Model field:** numeric deployed-model ID (e.g. `2930507450790445056`), not a friendly name.

## Environment Variables

| Var | Required | Notes |
|-----|----------|-------|
| `VERTEX_AI_TOKEN` | ✓ | gcloud bearer token — set via `wrangler secret put VERTEX_AI_TOKEN $(gcloud auth print-access-token)`. Expires in 1h — must be refreshed. |
| `VERTEX_AI_ENDPOINT` | ✓ | Base URL of the dedicated endpoint (without `/chat/completions`). Set via `wrangler secret put VERTEX_AI_ENDPOINT`. |

**Token expiry note:** unlike static API keys, the gcloud bearer token expires every hour. Before running evals or switching to the vertex provider, refresh it:
```bash
wrangler secret put VERTEX_AI_TOKEN $(gcloud auth print-access-token)
```

## API Endpoint

The provider appends `/chat/completions` to `VERTEX_AI_ENDPOINT` (stripping a trailing slash). If `VERTEX_AI_ENDPOINT` already ends with `/chat/completions`, it is used as-is.

```
POST {VERTEX_AI_ENDPOINT}/chat/completions
```

Auth header:
```
Authorization: Bearer {VERTEX_AI_TOKEN}
```

## Request Body Format

OpenAI-compatible — messages are passed through as-is (no `contents`/`parts` conversion needed):

```json
{
  "model": "2930507450790445056",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.7,
  "max_tokens": 8192,
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

## SSE Response Parsing

Same OpenAI SSE format as SambaNova and vLLM — `choices[0].delta.content` for text deltas, `usage` on the final frame (from `stream_options: { include_usage: true }`). The `[DONE]` sentinel is handled (skipped).

```
data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}
data: [DONE]
```

## Normalized Usage Frame

```js
{
  prompt_tokens:      usage.prompt_tokens,
  completion_tokens:  usage.completion_tokens,
  total_tokens:       usage.total_tokens,
  cache_read_tokens:  usage.cache_read_tokens ?? 0,
  cache_write_tokens: usage.cache_write_tokens ?? 0,
}
```

## Model Auto-Discovery

`getCatalog(env)` calls `fetchVertexModels(env)` alongside `fetchVllmModels` and `fetchOllamaModels`. When `VERTEX_AI_ENDPOINT` and `VERTEX_AI_TOKEN` are set and reachable, it queries `{base}/v1/models` and replaces the placeholder catalog row with one entry per discovered model ID. Falls back to the static placeholder on any failure.

`findCatalogEntry` also has a synthesize path for vertex — any `{provider: 'vertex', model: id}` pair is valid without a catalog edit.

## TTFT and Throughput

TTFT and tokens/s are computed wall-clock by `llm-generate.js` — no provider-side work needed.

**DiffusionGemma behaviour (if deployed):** generates all tokens simultaneously and emits a single large delta chunk. TTFT ≈ total LLM wall-clock time.

## Error Handling

- Missing `VERTEX_AI_TOKEN` → `err.status = 401`, message includes refresh instructions
- Missing `VERTEX_AI_ENDPOINT` → `err.status = 401`
- Non-2xx HTTP response → `err.status = response.status`, message includes first 200 chars of body
- Malformed SSE frames are silently skipped (same pattern as sambanova/vllm)

## Files Changed

| File | Change |
|------|--------|
| `workers/recommender/src/providers/vertex.js` | Complete rewrite — OpenAI-compatible endpoint, bearer token auth, no message conversion |
| `workers/recommender/src/providers/index.js` | Single placeholder catalog entry, updated base requirements, `fetchVertexModels`, vertex in `getCatalog` + `findCatalogEntry` synthesize path |
| `workers/recommender/tests/snapshots/vertex.test.js` | Complete rewrite — new BASE_ENV, 11 tests covering auth, headers, endpoint resolution, body shape, streaming, DiffusionGemma |
| `workers/recommender/.dev.vars.example` | Updated Vertex AI block — `VERTEX_AI_TOKEN` + `VERTEX_AI_ENDPOINT`, token refresh note |
| `workers/recommender/wrangler.jsonc` | Updated comment to reflect new env vars |
