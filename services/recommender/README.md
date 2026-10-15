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
