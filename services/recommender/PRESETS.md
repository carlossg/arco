# Arco Recommender - Model Preset Configuration

Each preset assigns a model to each of the 4 pipeline roles:

| Role | Purpose | Max Tokens | Temperature |
|------|---------|-----------|-------------|
| **reasoning** | Deep analysis: intent classification, block selection, content planning | 2048 | 0.7 |
| **content** | HTML content generation for each block | 1536 | 0.8 |
| **classification** | Fast intent classification from user query | 512 | 0.3 |
| **validation** | Output validation and quality checks | 256 | 0.2 |

---

## Pure Presets

Single model for all 4 roles. Simplest configuration, consistent behavior.

### `gemini-3-pro`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-3-pro-preview` | 2048 | 0.7 |
| content | google | `gemini-3-pro-preview` | 1536 | 0.8 |
| classification | google | `gemini-3-pro-preview` | 512 | 0.3 |
| validation | google | `gemini-3-pro-preview` | 256 | 0.2 |

**Benchmark:** ~25s | Highest quality reasoning, slowest. Best for quality-critical generation where latency doesn't matter.

### `gemini-3-flash`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-3-flash-preview` | 2048 | 0.7 |
| content | google | `gemini-3-flash-preview` | 1536 | 0.8 |
| classification | google | `gemini-3-flash-preview` | 512 | 0.3 |
| validation | google | `gemini-3-flash-preview` | 256 | 0.2 |

**Benchmark:** ~11.5s | Good quality with moderate speed. Gen 3 capabilities at flash speed.

### `gemini-2.5-pro`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.5-pro` | 2048 | 0.7 |
| content | google | `gemini-2.5-pro` | 1536 | 0.8 |
| classification | google | `gemini-2.5-pro` | 512 | 0.3 |
| validation | google | `gemini-2.5-pro` | 256 | 0.2 |

**Benchmark:** ~25s | Strong reasoning with thinking tokens. Deep chain-of-thought but slower due to internal reasoning.

### `gemini-2.5-flash`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.5-flash` | 2048 | 0.7 |
| content | google | `gemini-2.5-flash` | 1536 | 0.8 |
| classification | google | `gemini-2.5-flash` | 512 | 0.3 |
| validation | google | `gemini-2.5-flash` | 256 | 0.2 |

**Benchmark:** ~17.7s | Balanced 2.5 generation. Thinking tokens add latency compared to 2.0 Flash but improve reasoning quality.

### `gemini-2.5-flash-lite`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.5-flash-lite` | 2048 | 0.7 |
| content | google | `gemini-2.5-flash-lite` | 1536 | 0.8 |
| classification | google | `gemini-2.5-flash-lite` | 512 | 0.3 |
| validation | google | `gemini-2.5-flash-lite` | 256 | 0.2 |

**Benchmark:** ~3.3s | Optimized for low latency. 1M context window, GA status. Faster than gemini-2.0-flash with 2.5 generation quality.

### `gemini-2.0-flash`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.0-flash` | 2048 | 0.7 |
| content | google | `gemini-2.0-flash` | 1536 | 0.8 |
| classification | google | `gemini-2.0-flash` | 512 | 0.3 |
| validation | google | `gemini-2.0-flash` | 256 | 0.2 |

**Benchmark:** ~3.8s | Fast and reliable. Previous generation workhorse, still very capable.

### `gemini-2.0-flash-lite`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.0-flash-lite` | 2048 | 0.7 |
| content | google | `gemini-2.0-flash-lite` | 1536 | 0.8 |
| classification | google | `gemini-2.0-flash-lite` | 512 | 0.3 |
| validation | google | `gemini-2.0-flash-lite` | 256 | 0.2 |

**Benchmark:** ~6.9s | Ultra-low cost. Good for high-volume, cost-sensitive workloads where quality tradeoffs are acceptable.

### `llama`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | model-garden | `llama-3.3-70b-instruct-maas` | 2048 | 0.7 |
| content | model-garden | `llama-3.3-70b-instruct-maas` | 1536 | 0.8 |
| classification | model-garden | `llama-3.3-70b-instruct-maas` | 512 | 0.3 |
| validation | model-garden | `llama-3.3-70b-instruct-maas` | 256 | 0.2 |

**Benchmark:** ~2.2s | Fastest overall. Open-source Llama 3.3 70B served via Model Garden MaaS (serverless). No GPU endpoint needed.

---

## Mixed Presets

Heavier model for reasoning, lighter model for content/classification/validation. Optimizes quality where it matters most while keeping other stages fast.

### `gemini-3-mixed`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-3-pro-preview` | 2048 | 0.7 |
| content | google | `gemini-3-flash-preview` | 1536 | 0.8 |
| classification | google | `gemini-3-flash-preview` | 512 | 0.3 |
| validation | google | `gemini-3-flash-preview` | 256 | 0.2 |

**Benchmark:** ~18s | Pro-quality reasoning with Flash-speed content generation. Best of Gen 3.

### `gemini-2.5-mixed`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.5-pro` | 2048 | 0.7 |
| content | google | `gemini-2.5-flash-lite` | 1536 | 0.8 |
| classification | google | `gemini-2.5-flash-lite` | 512 | 0.3 |
| validation | google | `gemini-2.5-flash-lite` | 256 | 0.2 |

**Benchmark:** ~20.8s | Deep thinking reasoning (2.5 Pro) with ultra-fast classification/content (2.5 Flash Lite at 560ms).

### `gemini-2.0-mixed`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.0-flash` | 2048 | 0.7 |
| content | google | `gemini-2.0-flash-lite` | 1536 | 0.8 |
| classification | google | `gemini-2.0-flash-lite` | 512 | 0.3 |
| validation | google | `gemini-2.0-flash-lite` | 256 | 0.2 |

**Benchmark:** ~3.9s | Fast and cheap. Flash reasoning quality with Lite cost savings on content/classification.

---

## Production Preset

### `production` (default)

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-3-pro-preview` | 2048 | 0.7 |
| content | google | `gemini-2.5-flash-lite` | 1536 | 0.8 |
| classification | google | `gemini-2.5-flash-lite` | 512 | 0.3 |
| validation | google | `gemini-2.5-flash-lite` | 256 | 0.2 |

**Benchmark:** ~18s | Best reasoning quality (Gemini 3 Pro) with fast, cost-effective content/classification (2.5 Flash Lite). This is the default preset used in production.

**Why this combination:**
- Reasoning is the most quality-sensitive stage — Gemini 3 Pro produces the best block selection and content planning
- Classification and content generation benefit more from speed — 2.5 Flash Lite responds in ~500ms for classification
- Content generation quality is primarily driven by the prompt (which comes from reasoning), so a lighter model suffices

---

## Model Garden Presets

Open-source models served via Vertex AI Model Garden MaaS (serverless, no GPU endpoint required).

### `llama-3.2-3b`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.0-flash` | 2048 | 0.7 |
| content | model-garden | `llama-3.2-3b-instruct-maas` | 1536 | 0.8 |
| classification | model-garden | `llama-3.2-3b-instruct-maas` | 512 | 0.3 |
| validation | model-garden | `llama-3.2-3b-instruct-maas` | 256 | 0.2 |

**Benchmark:** Partial failure (404 — model may not be available in us-central1). Uses Gemini for reasoning with tiny Llama for content.

### `mistral-small`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.0-flash` | 2048 | 0.7 |
| content | model-garden | `mistral-small-2503` | 1536 | 0.8 |
| classification | model-garden | `mistral-small-2503` | 512 | 0.3 |
| validation | model-garden | `mistral-small-2503` | 256 | 0.2 |

**Benchmark:** Partial failure (404 — model may not be available in us-central1). Uses Gemini for reasoning with Mistral for content.

---

## Gemma Presets

Self-hosted Gemma models on dedicated Vertex AI GPU endpoints. Requires deploying an endpoint first.

### `gemma-3-4b`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.0-flash` | 2048 | 0.7 |
| content | vertex-endpoint | `gemma-3-4b-it` | 1536 | 0.8 |
| classification | google | `gemini-2.0-flash-lite` | 512 | 0.3 |
| validation | google | `gemini-2.0-flash-lite` | 256 | 0.2 |

**Requires:** `GEMMA_ENDPOINT_ID` env var. Deploy with: `./infrastructure/vertex-ai/deploy-gemma.sh 4b`

### `gemma-3-12b`

| Role | Provider | Model | Max Tokens | Temp |
|------|----------|-------|-----------|------|
| reasoning | google | `gemini-2.0-flash` | 2048 | 0.7 |
| content | vertex-endpoint | `gemma-3-12b-it` | 1536 | 0.8 |
| classification | google | `gemini-2.0-flash-lite` | 512 | 0.3 |
| validation | google | `gemini-2.0-flash-lite` | 256 | 0.2 |

**Requires:** `GEMMA_ENDPOINT_ID` env var. Deploy with: `./infrastructure/vertex-ai/deploy-gemma.sh 12b`

---

## How to Use a Preset

### Via query parameter

```
GET /generate?query=best+espresso+machine&preset=gemini-2.5-flash-lite
```

### Via environment variable

```bash
# Cloud Run
gcloud run deploy arco-recommender --set-env-vars="MODEL_PRESET=gemini-2.5-flash-lite"

# Local
MODEL_PRESET=gemini-2.5-flash-lite npm start
```

### Via API

```bash
# List all presets
curl https://arco-recommender-642841493686.us-central1.run.app/api/presets

# Benchmark specific presets
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/benchmark?presets=production,gemini-2.5-flash-lite,llama'
```

---

## Adding a New Preset

In `src/ai-clients/model-factory-google.ts`:

```typescript
// Pure preset (same model for all roles)
'my-preset': purePreset('google', 'gemini-model-id'),

// Mixed preset (heavy reasoning + light rest)
'my-mixed': mixedPreset('google', 'gemini-heavy', 'google', 'gemini-light'),
```

Then update the preset list in `src/index-express.ts` (`getPresetList()`) and redeploy.
