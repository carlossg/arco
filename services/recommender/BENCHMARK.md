# Arco Recommender - Model Preset Benchmark Results

**Date:** 2026-02-26
**Query:** `best espresso machine for beginners`
**Service:** Cloud Run (`arco-recommender-642841493686.us-central1.run.app`)
**Region:** us-central1
**Presets:** 16 total (14 benchmarked, 2 require GPU endpoint)

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

## Results — Full Pipeline (sorted fastest to slowest)

End-to-end benchmark via `GET /api/benchmark-full`: classification, RAG context, reasoning, and parallel content generation for all blocks. Total benchmark duration: 272.8s (14 presets tested sequentially).

| # | Preset | Category | Blocks | Classification | Reasoning | Content Gen | **Total** |
|---|--------|----------|:------:|---------------:|----------:|------------:|----------:|
| 1 | `llama-3.3-70b-instruct-maas` | pure | 4 | 571ms | 2,859ms | 2,593ms | **5.5s** |
| 2 | `llama-3.2-3b` | model-garden | 4 | 95ms | 5,748ms | 143ms | **5.9s** |
| 3 | `gemini-2.0-flash-lite` | pure | 3 | 645ms | 3,740ms | 2,344ms | **6.1s** |
| 4 | `mistral-small` | model-garden | 4 | 84ms | 6,054ms | 256ms | **6.3s** |
| 5 | `gemini-2.5-flash-lite` | pure | 5 | 513ms | 4,099ms | 3,646ms | **7.7s** |
| 6 | `gemini-2.0-flash` | pure | 4 | 732ms | 5,797ms | 3,012ms | **8.8s** |
| 7 | `gemini-2.0-mixed` | mixed | 4 | 748ms | 6,545ms | 2,526ms | **9.1s** |
| 8 | `gemini-2.5-mixed` | mixed | 3 | 689ms | 20,839ms | 1,443ms | **22.3s** |
| 9 | `production` | production | 3 | 644ms | 21,387ms | 1,504ms | **22.9s** |
| 10 | `gemini-2.5-flash` | pure | 3 | 3,721ms | 15,784ms | 9,086ms | **24.9s** |
| 11 | `gemini-3-flash` | pure | 7 | 4,088ms | 14,956ms | 13,772ms | **28.7s** |
| 12 | `gemini-3-mixed` | mixed | 3 | 4,465ms | 25,057ms | 10,178ms | **35.2s** |
| 13 | `gemini-2.5-pro` | pure | 3 | 5,418ms | 26,160ms | 14,681ms | **40.8s** |
| 14 | `gemini-3-pro` | pure | 3 | 8,259ms | 30,338ms | 18,236ms | **48.6s** |

### Not Tested (require GPU endpoint)

| Preset | Category | Requirement |
|--------|----------|-------------|
| `gemma-3-4b` | gemma | Vertex AI Endpoint with GPU |
| `gemma-3-12b` | gemma | Vertex AI Endpoint with GPU |

## Key Findings

1. **Fastest end-to-end:** `llama-3.3-70b-instruct-maas` at **5.5s** — 9x faster than the slowest preset
2. **Fast Gemini presets now actually fast:** `gemini-2.0-flash-lite` at 6.1s, `gemini-2.5-flash-lite` at 7.7s, `gemini-2.0-flash` at 8.8s
3. **Reasoning times now reflect actual preset models** — previously all presets were incorrectly using the production reasoning model (Gemini 3 Pro). The fix dropped fast presets from ~20s to ~3-6s reasoning.
4. **Production preset:** ~23s total — uses Gemini 3 Pro reasoning (21s) + Flash Lite content (1.5s)
5. **Content generation** adds 1-18s depending on model, generated in parallel across 3-7 blocks
6. **Model Garden presets** (llama-3.2-3b, mistral-small) show near-zero content gen time, likely using fallback content

## Speed Tiers

| Tier | Presets | Total Time | Best For |
|------|---------|-----------|----------|
| Ultra-fast (<10s) | llama-3.3-70b-instruct-maas, llama-3.2-3b, gemini-2.0-flash-lite, mistral-small, gemini-2.5-flash-lite, gemini-2.0-flash, gemini-2.0-mixed | 5-9s | Real-time UX, high throughput |
| Standard (20-30s) | gemini-2.5-mixed, production, gemini-2.5-flash, gemini-3-flash | 22-29s | Best quality/speed for production |
| Thorough (35s+) | gemini-3-mixed, gemini-2.5-pro, gemini-3-pro | 35-49s | Maximum reasoning depth |

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
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/benchmark?presets=production,gemini-2.5-flash-lite,llama-3.3-70b-instruct-maas'

# Custom query
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/benchmark?query=latte+art+machine+under+2000'

# Full pipeline benchmark (classification + reasoning + content generation)
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/benchmark-full?query=best+espresso+machine+for+beginners'

# Full pipeline benchmark for specific presets
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/benchmark-full?presets=production,gemini-2.5-flash-lite,llama-3.3-70b-instruct-maas'

# List all presets
curl 'https://arco-recommender-642841493686.us-central1.run.app/api/presets'
```
