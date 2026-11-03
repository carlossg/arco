# Google Cloud recommender

This fork defaults to Google Cloud. The original implementation remains under
`workers/recommender/`; neither building nor deploying this service deploys a
Cloudflare Worker.

The low-traffic demo uses managed, pay-per-use services, not a database server:

| Capability | Google service |
| --- | --- |
| Existing HTTP API and NDJSON streaming | Cloud Run, request-based billing, minimum 0 and maximum 1 instance |
| Sessions, events, feedback, experiments, evaluations, configuration and cache | Firestore Native |
| Semantic retrieval | Firestore native vector search, Vertex `text-embedding-005`, 768 dimensions |
| Generation and suggestions | Vertex Gemini 2.5 Flash-Lite with service-account authentication |
| Evaluation judge | Vertex Gemini 2.5 Flash |
| Background evaluations and recovery | Cloud Tasks and one authenticated Cloud Scheduler job |
| Payloads exceeding Firestore's document size limit | Private Cloud Storage bucket |
| Admin and Adobe credentials | Secret Manager |

Firestore repositories use native documents and transactions, **not a SQL
compatibility layer**. Demo dashboards aggregate at most 5,000 documents and fail
explicitly above that limit. This intentionally avoids an always-on database,
analytics warehouse, or additional infrastructure for a small demonstration.
Flash-Lite roughly halved measured generation latency in live pipeline trials;
the separate Flash judge retains the stronger evaluation model. Native text
generation list rates are $0.10 input / $0.40 output per million tokens for
Flash-Lite, and $0.30 / $2.50 for the Flash judge (approximate demo accounting,
not a billing guarantee).
Cloud Scheduler, storage, builds and inference can still incur charges even
though Cloud Run scales to zero.

## Dependencies and tests

Use Bun. The explicit registry flag overrides user `.npmrc` and environment
configuration; do not change the user's global configuration.

```sh
bun install --cwd workers/recommender --registry=https://registry.npmjs.org --ignore-scripts
bun install --cwd services/recommender --registry=https://registry.npmjs.org --ignore-scripts
bun run --cwd workers/recommender test
bun run --cwd services/recommender test
```

Bun manages dependencies and runs scripts. The container retains Node 24 for
the existing ESM loader and shared Worker pipeline.

For browser regressions, start the AEM development server against real preview
content, then run `bun run test:browser` from the repository root. Set `BASE_URL`
to test another frontend. The runner checks real Google generation at mobile
and desktop widths, requires CLS below 0.1, rejects Cloudflare requests, and
checks that early and late NDJSON errors remain visible. Successful-generation
tests use the deployed backend and persist synthetic test runs.

## Local development

Authenticate with `gcloud auth application-default login`. Configure the same
environment values as deployment, including `ADMIN_TOKEN`. The service uses
real managed Google services, not a local SQL server.

```sh
GOOGLE_CLOUD_PROJECT=api-project-642841493686 \
PAYLOAD_BUCKET=arco-gcp-payloads-642841493686 \
PORT=8081 \
bun run --cwd services/recommender start
```

Configure the frontend before loading `scripts/api-config.js`, or set a local
URL override:

```js
localStorage.setItem('arco-recommender-url', 'http://localhost:8081');
localStorage.setItem('arco-admin-url', 'http://localhost:8081');
```

Internal task and scheduler routes require a Google-signed ID token whose
audience is `SERVICE_URL` and whose verified email matches
`TASK_SERVICE_ACCOUNT`. A task header or arbitrary Google identity is not
sufficient. The public service requires `ADMIN_TOKEN` at startup.
Use `GET /health` for public health checks.

## Gemini coffee concierge (MCP)

The public, stateless Streamable HTTP endpoint is
`https://arco-recommender-gcp-okyq6gkx3a-uc.a.run.app/mcp`.
POST accepts JSON-RPC 2.0 and returns `application/json` (the JSON response
variant of Streamable HTTP). Ordinary GET returns metadata/health; GET with
`Accept: text/event-stream` returns HTTP 405 as required for a server without
standalone SSE streams. OPTIONS supports CORS. No session ID is required. Supported protocol
versions are `2025-11-25`, `2025-06-18` and `2025-03-26`; initialize negotiates
the requested supported version, otherwise offers `2025-11-25`.
Lifecycle methods are `initialize`, `notifications/initialized`, `ping`,
`tools/list` and `tools/call`. Notifications return HTTP 202 without a body.
JSON-RPC batches are not supported. Browser Origins are restricted to the
storefront preview, Gemini, AI Studio and localhost:3000; clients without an
Origin header can connect directly.

| Tool | Inputs | Result |
| --- | --- | --- |
| `recommend_coffee_setup` | Required `query`; optional `persona`, `useCase`, `persistPage` (false by default), `conversationContext` | Catalog products/specs/USD prices, matched persona/use case, features, FAQs, live Firestore retrieval and a context-carrying storefront link |
| `compare_products` | Required `productA`, `productB`; optional `contextQuery`, `conversationContext` | Catalog comparison, available authored verdict/persona guidance, context-carrying comparison link |
| `get_product_details` | Required `productIdOrName`; optional `conversationContext` | Full catalog entry, included accessories, authored pairing-guide sections and grinders mentioned in those sections, product/recommender URLs |

Persona values: `morning-minimalist`, `upgrade-seeker`, `craft-home-barista`,
`traveling-professional`, `budget-conscious-beginner`, `office-manager`.
Product lookup accepts exact short IDs, `arco-`-prefixed IDs or names, including
`Studio Pro`. Catalog specs/prices are authoritative: some older editorial
comparisons describe different prices/specs, so their tables are deliberately
not returned. Pairing guide sections can discuss several machines and grinders;
they are guidance, not a fabricated compatibility guarantee.

Recommendations use the shared RAG functions with Google embedding and
Firestore adapters, never Cloudflare APIs. Retrieval failures return an MCP
tool error rather than pretending to have searched successfully.
`persistPage: true` additionally runs the full headless generation pipeline
with a draining writer, saves/previews/publishes via Adobe DA at a unique
`/discover/gemini-<uuid>` path, and returns `liveUrl`. Generation/DA errors are
explicit; Adobe credentials must be valid. This creates permanent public
content and consumes inference/publishing resources. The demo endpoint has no
user authentication or publication quota: do not expose sensitive queries, and
add authentication/abuse controls before a broader public rollout. Tool safety
annotations conservatively mark recommendation as a possible write; never
request persistence without the user's approval.

### Carry conversation preferences into Arco generation

MCP cannot read Gemini's private chat history. Each tool's optional
`conversationContext` schema asks Gemini to summarize relevant, explicitly
shared coffee preferences, including facts from earlier turns. Gemini decides
which arguments to send; completeness is not guaranteed. Sync tool schemas in
Gemini Developer Mode after deployment.

```json
{
  "summary": "Comparing machines for a shared compact kitchen.",
  "preferences": {
    "budgetUsd": 1600,
    "drinks": ["cappuccino"],
    "people": 2,
    "priorities": ["quiet operation", "small footprint"]
  },
  "productsDiscussed": ["primo", "doppio"]
}
```

All fields are optional. Summary text is limited to 2,000 characters, drink
lists to 10 strings of 100 characters, priorities to 10 strings of 200
characters, discussed products to 20 strings of 100 characters, budgets to
1–100,000 USD, and people to integers 1–100. Unknown fields and invalid values
are rejected, both at the MCP boundary and by `/api/generate`. Do not send names,
contact details, sensitive information or full transcripts. There is no name
field; free text is not an automatic personal-data scrubber.

When supplied, context is stored in the dedicated native Firestore KV namespace
`mcp-context` with a one-hour TTL. The storefront link contains only a random
`contextId`, not the summary/preferences. `GET /api/mcp/context/{contextId}`
returns `{ context, expiresAt }` with `Cache-Control: no-store`; missing/expired
IDs return 410 and storage failures return 503. Reads enforce expiry even if
Firestore TTL deletion has not run yet. Anyone with the link can retrieve its
context until expiry: this is an opaque bearer handoff, not authentication.
Do not treat it as suitable for sensitive data.

The frontend awaits retrieval before its first `/api/generate` request, merges
the validated preferences into tab-scoped session context, and preserves them
for follow-up generations. The shared request parser retains the context,
semantic RAG searches incorporate it, and the actual LLM user prompt includes
it as untrusted preference data. Current requests override conflicting older
preferences; catalog data remains authoritative. Explicit `persistPage: true`
also passes this context into the headless generation pipeline.

**Inspect incoming app context** shows the retrieved summary, preferences,
expiry, errors, and the exact context sent to generation. Failed/expired
handoffs display a warning and generation continues with existing tab context,
not an invented external summary. Legacy inline `ctx`/`persona` links still
work. The one-hour expiry limits handoff retrieval, not copies already loaded
into sessionStorage, generated public pages, or normal generation/debug records.

Test by telling Gemini your budget, drinks and priorities, then asking
`@Arco Coffee Concierge compare Primo and Doppio`. Inspect the actual tool
arguments in Gemini's Event Log, follow the returned `contextId` link, and
expand the Arco inspector. Backend deployment alone is insufficient: the
frontend hydration code must also be delivered by AEM Code Sync.

### Curl smoke checks

```sh
MCP=https://arco-recommender-gcp-okyq6gkx3a-uc.a.run.app/mcp
curl --fail-with-body "$MCP"
curl --fail-with-body -X OPTIONS -i "$MCP"
curl --fail-with-body "$MCP" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl --fail-with-body "$MCP" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl --fail-with-body "$MCP" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl --fail-with-body "$MCP" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"recommend_coffee_setup","arguments":{"query":"My first espresso setup","persona":"budget-conscious-beginner"}}}'
curl --fail-with-body "$MCP" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"compare_products","arguments":{"productA":"Primo","productB":"Doppio"}}}'
curl --fail-with-body "$MCP" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_product_details","arguments":{"productIdOrName":"primo"}}}'
```

### Register in Google Connected Console

These are account-side steps; deployment alone does not register or approve an
app. Google controls access, eligibility and review requirements. See the
[official registration guide](https://developers.google.com/connected-apps/gpc/perform-the-steps)
for the current console labels.

1. Sign in to <https://connected.google.com/console>, choose **Create app**,
   accept the platform terms if required, name it **Arco Coffee Concierge**,
   choose the appropriate shopping category, and select **MCP server**.
2. Complete **App details** with the real app icon, description, terms/privacy
   URLs and storefront website. Add three capabilities (recommend setups,
   compare products, inspect specs) and three example prompts, including
   `@Arco Coffee Concierge compare Primo and Doppio`.
3. Open **MCP and tools setup**, enter the exact `/mcp` URL above, and download
   the domain challenge JSON. This service can host the challenge: set
   `GOOGLE_CONNECTED_VERIFICATION_TOKEN` to the value in its
   `verification_tokens` array (not the whole JSON file):

   ```sh
   gcloud run services update arco-recommender-gcp \
     --project=api-project-642841493686 --region=us-central1 \
     --update-env-vars="GOOGLE_CONNECTED_VERIFICATION_TOKEN=YOUR_PUBLIC_CHALLENGE_TOKEN"
   curl --fail-with-body \
     https://arco-recommender-gcp-okyq6gkx3a-uc.a.run.app/.well-known/google-connected-apps
   ```

   Confirm HTTP 200 without redirects, then select **Verify domain**. The
   verification route returns 404 until configured. Reapply this setting after
   running `deploy.sh`, which replaces environment settings. If Google rejects
   a shared `run.app` hostname, map a domain you own to this same service and
   register its HTTPS `/mcp` instead; do not claim ownership of `run.app`.
4. Under **Access credentials**, answer **No** to “Does your server require
   authorization?” for this public demo. Do not enter the backend's admin token;
   this endpoint does not implement OAuth or require admin access.
5. Select **Sync tools** and confirm exactly the three tools above. Review
   inputs/safety annotations. Do not request location or other extra user
   context. Require confirmation for recommendation since it can publish.
6. Configure available countries/languages/products, save, then **Add testers**
   (including your own eligible personal Google account). Allow time for
   propagation. In Gemini select the app with `@Arco Coffee Concierge`.
7. Test all three tools and follow the returned links. Request a permanent
   page only when testing publication intentionally. Submit for Google review
   and publish only after meeting its requirements; tester access is not a
   public release.

### Gemini Developer Mode and Gemini CLI

For quick MCP testing before console registration, open
<https://gemini.google.com/devmode>, choose **+ Create new**, and connect the
HTTPS `/mcp` endpoint as a custom MCP app (no authorization for this demo).
Alternatively launch Developer Mode from the registered console app.
Use **Tool Schemas** to confirm tool discovery and **Event Log** to inspect
actual arguments, result JSON, latency and errors. Try “Find a beginner espresso
setup”, “Compare Primo and Doppio” and “Give me Studio Pro specs”.
See [Developer Mode documentation](https://developers.google.com/connected-apps/mcp/dev-mode).
Availability depends on Google's rollout/account eligibility; current
[custom-app requirements](https://support.google.com/gemini/answer/17209137)
include an eligible US personal account, English and Keep Activity enabled.

If tool discovery succeeds but Gemini spins or returns a generic failure, use
**Tool Schemas > Sync schema**, start a fresh chat, and inspect **Event Log** for
an actual `tools/call` and its result. HTTP 200 access logs alone do not prove a
tool ran. The server emits structured `component: "mcp"` logs with `rpcMethod`,
`tool`, HTTP status, JSON-RPC/tool error flags and duration, without query
arguments or returned content:

```sh
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="arco-recommender-gcp" AND jsonPayload.component="mcp"' \
  --project=api-project-642841493686 --freshness=10m --limit=30 \
  --format='table(timestamp,jsonPayload.rpcMethod,jsonPayload.tool,jsonPayload.status,jsonPayload.rpcErrorCode,jsonPayload.toolError,jsonPayload.durationMs)'
```

For this stateless server, an optional GET with `Accept: text/event-stream`
must return 405, not JSON metadata; Gemini supports this response. Ordinary
GET health checks continue returning JSON metadata with 200.

For an independent client, merge this into Gemini CLI's
`~/.gemini/settings.json` (do not overwrite existing configuration):

```json
{
  "mcpServers": {
    "arco": {
      "httpUrl": "https://arco-recommender-gcp-okyq6gkx3a-uc.a.run.app/mcp",
      "timeout": 600000
    }
  }
}
```

Start `gemini`, run `/mcp` to confirm discovery, and explicitly ask it to use
Arco's tools. Do not set `trust: true`: retain confirmation for possible writes.
See the [Gemini CLI MCP guide](https://geminicli.com/docs/tools/mcp-server/).

### Fallback Custom Gem (no MCP configuration)

At <https://gemini.google.com>, open **Gems**, create a new Gem named **Arco
Coffee Concierge**, paste the following instructions, preview and save:

```text
You are an Arco coffee setup concierge. Ask briefly about budget, drink style,
experience, available space and office/travel needs. Use only facts supplied
by the user or verified from the Arco storefront. Do not invent product specs,
prices, stock, compatibility or claim you called MCP tools.

When useful, choose one persona:
morning-minimalist, upgrade-seeker, craft-home-barista,
traveling-professional, budget-conscious-beginner, office-manager.

Return a clickable link to https://main--arco--carlossg.aem.page/ with:
q=<URL-encoded summary of the coffee request>
persona=<chosen slug>
utm_source=gemini&utm_medium=connected_app&utm_campaign=mcp_concierge
Optionally add ctx=<URL-encoded JSON>, e.g.
{"inferredProfile":{"interests":["milk drinks"],"journeyStage":"exploring"}}
Only include shownProducts if exact Arco product IDs were actually shown.
Never put personal/sensitive data or the whole conversation in the URL.
Explain that Arco will generate the grounded recommendation after the click.
The user can expand "Inspect incoming app context" on Arco to verify the handoff.
Do not claim to publish a permanent page; that requires an actual MCP call.
```

A Custom Gem is a prompt-and-link fallback, **not an MCP connection**. It does
not automatically execute tools or fetch this service, and can't provide
verified live catalog data without additional supported capabilities.

### Inspect the Gemini-to-Arco context handoff

Storefront links carry `q`, a matched `persona` when available, `contextId`
(or legacy `ctx`) and UTM tags. `ctx` supports URL-encoded JSON or UTF-8
base64/base64url JSON. Before `/api/generate`, the frontend retrieves opaque
handoffs and validates and merges only bounded `conversationContext`,
`inferredProfile` fields and `shownProducts` into session context, and seeds
`setQuizPersona({ persona })`. It preserves existing history/session identity
and ignores unrelated JSON keys. Malformed/oversized context is rejected with
a visible inspector warning, not a broken page. Links with incoming context
bypass unrelated quiz prefetches.

Expand **Inspect incoming app context** above the recommender to see the decoded
received payload, accepted fields, validation errors, UTM tags, the exact most
recent generation request context and current session context. Untrusted values
render as text, never HTML. Nothing here proves the sender's identity or exposes
Gemini's private conversation; only explicitly shared fields in the URL or
retrieved handoff are available.
`captureUtm()` runs before the initial recommender call, so campaign attribution
also works on direct `?q=` landings.

Example (works on localhost:3000 with local code, or once frontend code syncs):

MCP_CONTEXT_E2E=1 node --test --test-timeout=90000 \
  --test-name-pattern='live MCP conversation context' tools/test-generation-loading.mjs
```

The opt-in live test calls the deployed MCP tool, retrieves the real Firestore
handoff in a browser, runs real Gemini generation, checks the exact preferences
in the LLM debug prompt, and verifies that the output addresses milk drinks and
quietness. It consumes inference resources and creates a normal synthetic
generation record, but does not publish an Adobe page.text
/?q=beginner+espresso&persona=budget-conscious-beginner&ctx=%7B%22shownProducts%22%3A%5B%22primo%22%5D%2C%22inferredProfile%22%3A%7B%22interests%22%3A%5B%22milk%20drinks%22%5D%7D%7D&utm_source=gemini&utm_medium=connected_app&utm_campaign=mcp_concierge
```

Do not encode secrets or personal data: links can appear in history, logs,
referrers and analytics. Hydration/inspection frontend changes require the
normal AEM code-sync publishing process separately from Cloud Run deployment.
Regression checks:

```sh
bun run --cwd services/recommender test
node --test --test-name-pattern='external app context' tools/test-generation-loading.mjs
bun run lint:js
bun run lint:css
```

## Indexing

The Firestore vector index combines `embeddingSpace ASCENDING` and a flat
768-dimensional `embedding` field. It must finish building before search works:

```sh
gcloud firestore indexes composite create \
  --project=api-project-642841493686 --database='(default)' \
  --collection-group=arco_content_gcp --query-scope=collection \
  --field-config=field-path=embeddingSpace,order=ascending \
  --field-config='field-path=embedding,vector-config={"dimension":768,"flat":{}}'

bun run --cwd services/recommender index-content \
  --project api-project-642841493686 --location us-central1 \
  --collection arco_content_gcp --model text-embedding-005 \
  --dimensions 768 --all --prune
```

The indexer reads tracked `data/`, not the ignored AEM `content/` checkout.
It generates 1,302 content chunks, including products, guides, recipes, stories,
features, FAQs, reviews, experiences, tools and hero metadata. It never reuses
Cloudflare embeddings. Query and document vectors must have the same model
and dimensions.

## Deployment

Run `bash services/recommender/deploy.sh` from the repository root after initial
project provisioning. The script builds with Bun from the `.gcloudignore`
allowlist, deploys Cloud Run, and configures the authenticated scheduler.
It contains no Wrangler or Cloudflare deployment commands.

The runtime identity needs `datastore.user`, `aiplatform.user`, queue
enqueue/get/purge/resume permissions, object access on the private payload
bucket, and access to the explicitly bound secrets. To attach its own OIDC
identity to tasks, it needs `iam.serviceAccounts.actAs` on that service account.
Google's managed Cloud Tasks and Scheduler service-agent roles must remain
intact. The runtime identity also has `run.invoker` on this service.

The Firestore TTL field is `arco_kv_gcp.expires_at`. Expired cache entries are
unreadable immediately, even before Google's asynchronous TTL cleanup.
Large expiring payloads have a GCS `customTime` matching their expiration;
the bucket deletes them one day later. Non-expiring payloads are not subject
to an age-based deletion policy.

Cloud Tasks transport retries are unlimited so a Firestore outage cannot
silently discard an exhausted job. Application attempts are capped at six;
terminal failures are durably recorded in Firestore before acknowledging.
Cloud Scheduler recovers unsent jobs and expired execution leases every five
minutes. Cloud Tasks dispatches at most one evaluation at a time.

Adobe DA publishing still requires valid Adobe credentials; Google
authentication does not replace Adobe authentication. Store `DA_TOKEN` as
`arco-gcp-da-token` in Secret Manager and bind it on deployment, or configure the
existing `DA_CLIENT_ID`, `DA_CLIENT_SECRET` and `DA_SERVICE_TOKEN` credentials.
An interactive IMS token expires and must be refreshed. Never commit it.
After rotating the secret, deploy a new Cloud Run revision so warm instances
receive the refreshed credential.

The deployed smoke runner checks actual native storage, retrieval, generation,
admin, feedback and attribution. Opt into background evaluation with
`RUN_EVAL=1`, and into real DA save, preview, publish and public read-back with
`RUN_PERSIST=1`:

```sh
ADMIN_TOKEN="$(gcloud secrets versions access latest \
  --secret=arco-gcp-admin-token --project=api-project-642841493686)" \
RUN_EVAL=1 RUN_PERSIST=1 bun services/recommender/tools/smoke.js
```

Publishing requires the runtime's valid Adobe credential. It creates a unique,
permanently published synthetic page at `/discover/google-smoke-{runId}` on
every opted-in run; it does not overwrite existing authored pages. Preview and
live delivery must both return the saved title without failed-media markers.
The smoke runner never prints credentials.

## Explicit legacy Cloudflare mode

Google is the default for generation, analytics and admin on all hosts,
including localhost. Saved `workers.dev` overrides are ignored in Google mode.
There is no automatic Cloudflare fallback.

To deliberately use the retained legacy deployment, set before page scripts:

```js
window.ARCO_CONFIG = { BACKEND: 'cloudflare' };
```

The Google runtime blocks outbound `cloudflare.com` and `workers.dev` requests.
Cloudflare bindings, resources and deployment scripts remain available but are
not created, updated or deleted by Google deployment.
