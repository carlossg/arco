# Arco Recommender - Model Preset Benchmark Results

**Date:** 2026-02-26
**Query:** `best espresso machine for beginners`
**Service:** Cloud Run (`arco-recommender-642841493686.us-central1.run.app`)
**Region:** us-central1
**Presets:** 16 total (14 benchmarked, 2 require GPU endpoint)
**Total benchmark duration:** 163.7s (14 presets tested sequentially)

## Results (sorted fastest to slowest)

> **Note:** These benchmarks measure **classification + reasoning only** (Phases 1 & 3 of the pipeline).
> The full `/generate` endpoint runs additional phases — RAG context lookup, parallel content generation
> (3-4 AI calls for block HTML), and image handling — so real page generation times will be significantly
> higher than the totals shown here.

| # | Preset | Category | Classification | Reasoning | Total | Classification Model | Reasoning Model |
|---|--------|----------|---------------:|----------:|------:|---------------------|----------------|
| 1 | `llama-3.3-70b-instruct-maas` | pure | 588ms | 1,628ms | **2,235ms** | llama-3.3-70b-instruct-maas | llama-3.3-70b-instruct-maas |
| 2 | `gemini-2.5-flash-lite` | pure | 597ms | 2,729ms | **3,345ms** | gemini-2.5-flash-lite | gemini-2.5-flash-lite |
| 3 | `gemini-2.0-flash` | pure | 541ms | 3,261ms | **3,825ms** | gemini-2.0-flash | gemini-2.0-flash |
| 4 | `gemini-2.0-mixed` | mixed | 641ms | 3,262ms | **3,925ms** | gemini-2.0-flash-lite | gemini-2.0-flash |
| 5 | `gemini-2.0-flash-lite` | pure | 689ms | 6,231ms | **6,942ms** | gemini-2.0-flash-lite | gemini-2.0-flash-lite |
| 6 | `gemini-3-flash` | pure | 4,217ms | 7,268ms | **11,507ms** | gemini-3-flash-preview | gemini-3-flash-preview |
| 7 | `gemini-2.5-flash` | pure | 2,986ms | 14,658ms | **17,664ms** | gemini-2.5-flash | gemini-2.5-flash |
| 8 | `gemini-3-mixed` | mixed | 3,967ms | 14,038ms | **18,025ms** | gemini-3-flash-preview | gemini-3-pro-preview |
| 9 | `production` | production | 453ms | 17,608ms | **18,081ms** | gemini-2.5-flash-lite | gemini-3-pro-preview |
| 10 | `gemini-2.5-mixed` | mixed | 560ms | 20,238ms | **20,818ms** | gemini-2.5-flash-lite | gemini-2.5-pro |
| 11 | `gemini-3-pro` | pure | 8,328ms | 15,824ms | **25,021ms** | gemini-3-pro-preview | gemini-3-pro-preview |
| 12 | `gemini-2.5-pro` | pure | 4,806ms | 20,297ms | **25,126ms** | gemini-2.5-pro | gemini-2.5-pro |

### Partially Failed

| Preset | Category | Issue |
|--------|----------|-------|
| `llama-3.2-3b` | model-garden | Classification 404 (model not available in region) |
| `mistral-small` | model-garden | Classification 404 (model not available in region) |

### Not Tested (require GPU endpoint)

| Preset | Category | Requirement |
|--------|----------|-------------|
| `gemma-3-4b` | gemma | Vertex AI Endpoint with GPU |
| `gemma-3-12b` | gemma | Vertex AI Endpoint with GPU |

## Key Findings

1. **Fastest overall:** `llama-3.3-70b-instruct-maas` (Llama 3.3 70B via MaaS) at ~2.2s total — 11x faster than the slowest
2. **Fastest Gemini:** `gemini-2.5-flash-lite` at ~3.3s — best quality/speed/cost tradeoff among Gemini models
3. **Gemini 2.5 Flash Lite** outperforms both `gemini-2.0-flash` (3.8s) and `gemini-2.0-flash-lite` (6.9s) while being a newer generation
4. **Production preset** now uses 2.5 Flash Lite for classification (453ms) + Gemini 3 Pro for reasoning (17.6s) = ~18s total
5. **Gemini 2.5 models** with thinking (Pro/Flash) have long reasoning times (14-20s) due to chain-of-thought tokens
6. **Mixed presets** with 2.5 Flash Lite classification are very fast at the classification stage (~500ms)

## Speed Tiers

| Tier | Presets | Total Time | Best For |
|------|---------|-----------|----------|
| Ultra-fast (<5s) | llama-3.3-70b-instruct-maas, gemini-2.5-flash-lite, gemini-2.0-flash, gemini-2.0-mixed | 2-4s | Real-time UX, high throughput |
| Fast (5-12s) | gemini-2.0-flash-lite, gemini-3-flash | 7-12s | Good quality with acceptable wait |
| Standard (15-20s) | gemini-2.5-flash, gemini-3-mixed, production, gemini-2.5-mixed | 17-21s | Best quality/speed for production |
| Thorough (25-30s) | gemini-3-pro, gemini-2.5-pro | 25s | Maximum reasoning depth |

## Preset Matrix (all 16 presets)

| Preset | Reasoning | Content | Classification | Validation | Needs Endpoint |
|--------|-----------|---------|---------------|------------|:--------------:|
| **Pure** | | | | | |
| `gemini-3-pro` | gemini-3-pro-preview | gemini-3-pro-preview | gemini-3-pro-preview | gemini-3-pro-preview | |
| `gemini-3-flash` | gemini-3-flash-preview | gemini-3-flash-preview | gemini-3-flash-preview | gemini-3-flash-preview | |
| `gemini-2.5-pro` | gemini-2.5-pro | gemini-2.5-pro | gemini-2.5-pro | gemini-2.5-pro | |
| `gemini-2.5-flash` | gemini-2.5-flash | gemini-2.5-flash | gemini-2.5-flash | gemini-2.5-flash | |
| `gemini-2.5-flash-lite` | gemini-2.5-flash-lite | gemini-2.5-flash-lite | gemini-2.5-flash-lite | gemini-2.5-flash-lite | |
| `gemini-2.0-flash` | gemini-2.0-flash | gemini-2.0-flash | gemini-2.0-flash | gemini-2.0-flash | |
| `gemini-2.0-flash-lite` | gemini-2.0-flash-lite | gemini-2.0-flash-lite | gemini-2.0-flash-lite | gemini-2.0-flash-lite | |
| `llama-3.3-70b-instruct-maas` | llama-3.3-70b-instruct | llama-3.3-70b-instruct | llama-3.3-70b-instruct | llama-3.3-70b-instruct | |
| **Mixed** | | | | | |
| `gemini-3-mixed` | gemini-3-pro-preview | gemini-3-flash-preview | gemini-3-flash-preview | gemini-3-flash-preview | |
| `gemini-2.5-mixed` | gemini-2.5-pro | gemini-2.5-flash-lite | gemini-2.5-flash-lite | gemini-2.5-flash-lite | |
| `gemini-2.0-mixed` | gemini-2.0-flash | gemini-2.0-flash-lite | gemini-2.0-flash-lite | gemini-2.0-flash-lite | |
| **Production** | | | | | |
| `production` | gemini-3-pro-preview | gemini-2.5-flash-lite | gemini-2.5-flash-lite | gemini-2.5-flash-lite | |
| **Model Garden** | | | | | |
| `llama-3.2-3b` | gemini-2.0-flash | llama-3.2-3b-instruct | llama-3.2-3b-instruct | llama-3.2-3b-instruct | |
| `mistral-small` | gemini-2.0-flash | mistral-small-2503 | mistral-small-2503 | mistral-small-2503 | |
| **Gemma** | | | | | |
| `gemma-3-4b` | gemini-2.0-flash | gemma-3-4b-it | gemini-2.0-flash-lite | gemini-2.0-flash-lite | GPU |
| `gemma-3-12b` | gemini-2.0-flash | gemma-3-12b-it | gemini-2.0-flash-lite | gemini-2.0-flash-lite | GPU |

## Try It — Test Links

Click any link below to test a preset with the benchmark query on the live site:

| Preset | Category | Try It |
|--------|----------|--------|
| `production` | production | [/?q=best+espresso+machine+for+beginners&preset=production](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=production) |
| `llama-3.3-70b-instruct-maas` | pure | [/?q=best+espresso+machine+for+beginners&preset=llama-3.3-70b-instruct-maas](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=llama-3.3-70b-instruct-maas) |
| `gemini-2.5-flash-lite` | pure | [/?q=best+espresso+machine+for+beginners&preset=gemini-2.5-flash-lite](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-2.5-flash-lite) |
| `gemini-2.0-flash` | pure | [/?q=best+espresso+machine+for+beginners&preset=gemini-2.0-flash](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-2.0-flash) |
| `gemini-2.0-mixed` | mixed | [/?q=best+espresso+machine+for+beginners&preset=gemini-2.0-mixed](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-2.0-mixed) |
| `gemini-2.0-flash-lite` | pure | [/?q=best+espresso+machine+for+beginners&preset=gemini-2.0-flash-lite](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-2.0-flash-lite) |
| `gemini-3-flash` | pure | [/?q=best+espresso+machine+for+beginners&preset=gemini-3-flash](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-3-flash) |
| `gemini-2.5-flash` | pure | [/?q=best+espresso+machine+for+beginners&preset=gemini-2.5-flash](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-2.5-flash) |
| `gemini-3-mixed` | mixed | [/?q=best+espresso+machine+for+beginners&preset=gemini-3-mixed](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-3-mixed) |
| `gemini-2.5-mixed` | mixed | [/?q=best+espresso+machine+for+beginners&preset=gemini-2.5-mixed](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-2.5-mixed) |
| `gemini-3-pro` | pure | [/?q=best+espresso+machine+for+beginners&preset=gemini-3-pro](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-3-pro) |
| `gemini-2.5-pro` | pure | [/?q=best+espresso+machine+for+beginners&preset=gemini-2.5-pro](https://main--arco--carlossg.aem.page/?q=best+espresso+machine+for+beginners&preset=gemini-2.5-pro) |

For localhost testing, replace the domain with `http://localhost:3000`.

## How to Run

```bash
# Full benchmark (all presets)
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/benchmark?query=best+espresso+machine+for+beginners'

# Specific presets
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/benchmark?presets=production,gemini-2.5-flash-lite,llama'

# Custom query
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/benchmark?query=latte+art+machine+under+2000'

# List all presets
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/presets'
```
