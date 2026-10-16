# Arco: AI-Powered Generative Website on AEM Edge Delivery Services

Arco is a specialty espresso brand website demonstrating AI-powered personalization on Adobe Experience Manager Edge Delivery Services. This fork defaults to a serverless Google Cloud backend: Cloud Run, Firestore native storage and vector search, Vertex Gemini, and Cloud Tasks. The original Cloudflare implementation is retained as an explicit alternative, not a fallback. See [Google Cloud deployment and architecture](services/recommender/README.md).

## Demo

https://github.com/user-attachments/assets/64f534df-37ed-4c95-8422-9bba7f734d27

The [demo video](build-demo/arco-demo.mp4) walks through Arco's AI-powered personalization features, running on Adobe Experience Manager Edge Delivery Services.

1. **Passive signal collection** — As the user browses pages like *Espresso Anywhere* and the *Travel Espresso Guide*, the site passively collects browsing signals (page visits, scroll depth, time spent) and builds a real-time interest profile stored in the browser session.

2. **Personalized "For You" recommendations** — A *For You* link appears in the navigation based on the user's browsing behavior. Clicking it sends the browsing context to the backend, which generates a set of recommendations tailored to the user's interests. The page streams in progressively.

3. **Natural language AI search** — The user types a query like *"I'm looking for a coffee machine to use when camping in the middle of the forest"*. The backend runs a hybrid RAG pipeline combining keyword and native vector search. The LLM reasons over the results and generates a fully personalized page in real time.

4. **DA persistence** — Generated pages can be saved to Document Authoring and published through Edge Delivery. Generation currently runs afresh for every query; deterministic query-to-page caching is not implemented.

### Rebuilding the demo

```sh
# Record the screen (requires local dev server running on localhost:3000)
cd build-demo && node record-demo.mjs

# Assemble the narrated video (requires ELEVENLABS_API_KEY in .env)
.venv/bin/python build.py
```

## Installation

```sh
bun install --registry=https://registry.npmjs.org --ignore-scripts
```

## Linting

```sh
bun run lint:js
bun run lint:css
```

## Recommender

The site includes an AI-powered recommender at `/?q=...`. Each query streams a fresh generated page, with optional DA persistence. The default Google service uses Vertex Gemini and Firestore; runtime model selection remains available in the admin UI. The legacy Cloudflare Worker and its providers remain under `workers/recommender/`.

| Parameter | Example | Description |
|-----------|---------|-------------|
| `q` | `/?q=best+espresso` | Natural language query |
| `tv` | `/?q=compare+primo+and+doppio&tv=1` | TV comparison layout |

### Local model: DiffusionGemma (MLX / vLLM)

Two extra providers — `ollama` and `vllm` — let you drive the recommender from a model running on your own machine **under `wrangler dev` only** (a deployed Worker runs on Cloudflare's edge and can't reach `localhost`).

[DiffusionGemma](https://blog.google/innovation-and-ai/technology/developers-tools/diffusion-gemma-faster-text-generation/) is Google's diffusion-based (non-autoregressive) Gemma. **Ollama and llama.cpp can't run it** — it needs **MLX** (the native Apple-Silicon path) or **vLLM** (CUDA). Both expose an OpenAI-compatible endpoint, so the existing `vllm` provider drives it with no new code.

```sh
cd workers/recommender

# Start the model server (MLX on macOS, vLLM elsewhere; --install adds the backend).
# Auto-installs nothing without --install; ~24GB unified memory for the 26B 4-bit MLX build.
npm run model:diffusion-gemma -- --install
#   or with overrides:
#   ./start-diffusion-gemma.sh --backend mlx --model mlx-community/diffusiongemma-26B-A4B-it-4bit --port 8000

# Point the worker at it (workers/recommender/.dev.vars — gitignored):
echo 'VLLM_BASE_URL=http://localhost:8000/v1' >> .dev.vars

# Run the worker locally and the EDS dev server, then select the served model
# in /admin → Model Settings.
npm run dev
```

Notes: the default model ids in the script are starting points — confirm the exact published Hugging Face / `mlx-community` id, as quant names change. DiffusionGemma emits text in parallel blocks rather than token-by-token, so streamed deltas arrive in bursts and the TTFT / tok-s figures in the debug panel (which assume per-token streaming) read approximately. See [`AGENTS.md`](AGENTS.md) for the full local-provider reference.

## Admin

An EDS-hosted admin SPA at `/admin` provides session browsing, multi-model A/B experiments, evaluation sweeps, runtime model selection, vector inspection, and real-user feedback dashboards. Google mode uses a Vertex Gemini judge and Firestore; legacy Cloudflare mode retains the Bedrock judge and Vectorize. Login is HTTP Basic with `ADMIN_TOKEN`, stored in Secret Manager for Google deployment.

For full documentation see [`docs/ADMIN.md`](docs/ADMIN.md). Architecture references live in [`docs/CODEMAPS/`](docs/CODEMAPS/).

## Content (drafts/)

Tracked application datasets live in `data/`. The Worker imports these JSON files
at build time; indexing, image, and page-generation tools also read this directory.
`content/` is reserved for the independent DA checkout created by
`aem content clone --all`. It is ignored by the outer Git repository, and
`--force` replaces that checkout without touching the application datasets.

The `drafts/` folder contains the **pre-expansion** page set (38 pages: home, nav, footer, products, stories, experiences). These are the canonical source of truth for DA (`froesef/arco`).

> **Note:** Commit `bf566a152c` (Feb 25 2026) added 239 additional pages (guides, blog, bundles, localization, etc.). Those pages are intentionally not present in `drafts/` — the site runs on the pre-expansion content. If you need to upload or re-publish, use `./tools/upload-to-da.sh --all` followed by `./tools/preview-all.sh` and `./tools/publish-all.sh`.

## Local development

1. Install dependencies: `npm i`
2. Install the [AEM CLI](https://github.com/adobe/helix-cli): `npm install -g @adobe/aem-cli`
3. Start the dev server: `aem up` (opens your browser at `http://localhost:3000`)

### Syncing this fork

The `upstream` remote points to `https://github.com/aem-growth-adoption/arco.git`.
Fetch it and merge `upstream/main` on a sync branch. Preserve the merge commit
(do not squash) so future upstream commits remain easy to identify with
`git log HEAD..upstream/main`.

Keep `fstab.yaml`, the Cloud Manager challenge, and
`workers/recommender/wrangler.carlossg.jsonc` scoped to this fork. Preserve the
isolated Worker routing in `scripts/api-config.js`, the context inspector, and
the TV flow when resolving conflicts. Application data belongs in `data/`, not
the DA clone's `content/`.

Before deploying the new metrics endpoints to the isolated Worker, apply
`npm run migrate:events:carlossg` followed by `npm run migrate:utm:carlossg` from
`workers/recommender/`, then deploy with `npm run deploy:carlossg`.
