# Promptfoo benchmarks

Multi-model benchmarks for the recommender and suggestions prompts, using the same YAML+Nunjucks templates production uses.

## Quick start

From `workers/recommender/`:

```bash
npm run bench:smoke           # one model, one query — sanity check
npm run bench:recommender     # full matrix
npm run bench:suggestions     # suggestions only
npm run bench:view            # open the results UI
```

## How it works

The bench configs point at `src/prompt-loader-node.js:renderForPromptfoo`, which loads YAML + Nunjucks partials from `prompts/` via `fs.readFileSync` (Node-friendly equivalent of the Worker's bundled loader at `src/prompt-loader.js`). Both modules share the same prompt source — single source of truth.

`renderForPromptfoo` returns OpenAI-style messages. The renderer post-processes the output to escape `{{token}}` → `{{ '{{' }}token{{ '}}' }}` so promptfoo's own Nunjucks pass doesn't try to interpret production tokens like `{{product-image:primo}}` as variables.

## Environment variables

Promptfoo reads provider credentials from environment variables. Set what you have access to in your shell or a `.env` file:

```bash
# Cerebras (OpenAI-compatible, fastest)
CEREBRAS_API_KEY=

# Cloudflare Workers AI (edge inference)
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=

# Vertex AI (Gemini, Llama-on-Vertex, Gemma, Mistral)
VERTEX_PROJECT_ID=
GCLOUD_TOKEN=$(gcloud auth print-access-token)

# AWS Bedrock (Anthropic, Nova, Llama, Mistral, DeepSeek, Qwen, Nemotron)
AWS_BEARER_TOKEN_BEDROCK=
# or AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
```

Providers without credentials are skipped automatically — missing creds for one don't block the others.

## Adding a new test

1. Add a fixture to `../fixtures/<scenario>.json` for snapshot coverage (see `../README.md`).
2. Translate the same context into a `tests:` entry in `recommender-bench.yaml`:
   - `vars.scenario`, `vars.query`, `vars.intent`, `vars.behavior`, `vars.rag` — the structured shape consumed by `renderForPromptfoo`.
3. Add scenario-specific assertions below the inherited `defaultTest.assert` block.
4. Smoke-run with `--filter-pattern '<your-test-description>'`.

## Adding a new provider

Append a new entry to `recommender-bench.yaml`'s `providers:` block. Provider id shapes:

- `vertex:<model>` — Vertex AI native
- `openai:chat:<model>` with `apiBaseUrl` + `apiKeyEnvar` — any OpenAI-compatible endpoint (Cerebras, Cloudflare Workers AI, SambaNova, vLLM, etc.)
- `bedrock:<model-id>` — AWS Bedrock
- `bedrock:converse:<model-id>` — Bedrock Converse API (NVIDIA Nemotron etc.)

## Caching

Promptfoo caches LLM responses by default in `~/.promptfoo/cache/`. Add `--no-cache` to force fresh calls after editing the prompt:

```bash
npx promptfoo eval -c tests/promptfoo/recommender-bench.yaml --no-cache
```

## Files

- `recommender-bench.yaml` — recommender benchmark (full provider matrix)
- `suggestions-bench.yaml` — suggestions benchmark (3 fast models)
- `../fixtures/*.json` — input fixtures used by snapshot tests; bench configs use their own inline `vars:`
