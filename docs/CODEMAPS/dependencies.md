<!-- Generated: 2026-04-22 | Files scanned: 4 | Token estimate: ~350 -->

# Dependencies & Integrations

## External Services

| Service | Purpose | Config |
|---------|---------|--------|
| AEM Edge Delivery Services (`*.aem.live`) | Content backend, preview/publish, CDN | `fstab.yaml` |
| Cloudflare Workers | Recommender API runtime | `workers/recommender/wrangler.jsonc` |
| Cloudflare D1 | Session/run metadata store | binding `SESSIONS_DB` |
| Cloudflare KV | Session payloads, cache, guides, analytics | bindings: `SESSION_STORE`, `CACHE`, `GUIDES`, `ANALYTICS` |
| Cloudflare Vectorize | Semantic RAG search index | binding `CONTENT_INDEX` |
| Cloudflare Workers AI | Text embedding generation | binding `AI` |
| Cerebras LLM | Page content generation (`gpt-oss-120b`) | `CEREBRAS_API_KEY` secret |
| DA (Document Authoring) | Generated page storage and CMS preview/publish | `DA_CLIENT_ID` + `DA_CLIENT_SECRET` secrets |

## Worker Secrets (set via `wrangler secret put`)

| Secret | Used by |
|--------|---------|
| `CEREBRAS_API_KEY` | LLM inference calls |
| `DA_CLIENT_ID` | DA OAuth token exchange |
| `DA_CLIENT_SECRET` | DA OAuth token exchange |
| `ADMIN_TOKEN` | HTTP Basic auth for admin routes |

## Frontend Dependencies

No runtime JS dependencies — vanilla ES6+. Dev tooling only:

| Package | Purpose |
|---------|---------|
| `@adobe/aem-cli` | Local dev server (`aem up`) |
| `eslint` + `@adobe/eslint-config-helix` | Airbnb-style linting |
| `stylelint` + `stylelint-config-standard` | CSS linting |
| `husky` + `lint-staged` | Pre-commit lint enforcement |

See `package.json` for exact versions.

## Worker Dependencies (`workers/recommender/package.json`)

Worker runs in Cloudflare's V8 isolate — no Node.js APIs.
Check `workers/recommender/package.json` for any runtime dependencies.

## Key Integration Points

### EDS → Worker

`scripts/scripts.js` POSTs to `ARCO_RECOMMENDER_URL` (from `api-config.js`) with:
```json
{
  "query": "...",
  "sessionId": "...",
  "pageId": "...",
  "runId": "...",
  "pageUrl": "...",
  "context": { "queries": [...], "browsingHistory": [...], "inferredProfile": {...} }
}
```
Response: NDJSON SSE stream of block events.

### Worker → DA

`da-persist.js` uses DA REST API with OAuth2 service-to-service tokens:
1. `POST /api/token` — exchange client credentials for access token
2. `PUT /source/{org}/{repo}/{path}` — create/update page HTML
3. `POST /preview/{org}/{repo}/{path}` — trigger preview
4. `POST /live/{org}/{repo}/{path}` — publish to live

### Worker → Vectorize

`searchContent()` in `context.js`:
1. Generate query embedding via `env.AI.run('@cf/baai/bge-base-en-v1.5', { text: query })`
2. Query `env.CONTENT_INDEX.query(embedding, { topK: N })`

### Client-Side Signal → Context → Request

```
browsing-signals.js → SessionContextManager → scripts.js /api/generate body
```
