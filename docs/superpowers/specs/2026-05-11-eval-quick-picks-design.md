# LLM Evaluation Quick Picks — `distinct-families` + `route-latency`

**Date:** 2026-05-11
**Status:** Approved for implementation
**Scope:** Add two new Quick Pick presets to the `#/evaluations/new` form. No backend, no API, no migration changes — UI constant only.

## Motivation

The eval matrix already has three preset chips (`cerebras`, `gpt-oss`, `diverse`) that one-click-populate the 8-model picker. The current presets answer "compare Cerebras hardware" and "compare GPT-OSS hosts" but leave two important questions unanswered:

1. **Which model family generates the best fast page?** Today nobody can pick eight different families in one click — they have to add rows by hand.
2. **How much latency does the hosting route itself add?** Same model on different infrastructure (Cerebras chip vs Workers AI vs Bedrock) should produce near-identical quality but very different TTFT/duration. Today we have no preset that isolates routing overhead.

Both gaps are addressed by adding two presets. Cerebras `gpt-oss-120b` stays as the baseline anchor in both, so every preset has a common reference point.

## Constraints

- `MAX_EVAL_MODELS = 8` (already enforced in `blocks/admin/admin.js`). Each preset is exactly 8 entries.
- No Cloudflare AI Gateway entries (`anthropic/...`, `google/...`, `openai/...`, `alibaba/...`). User explicitly excluded the gateway — use Bedrock direct for Anthropic / Google when needed.
- Only existing `MODEL_CATALOG` entries — no catalog additions.

## Preset A — `distinct-families`

**Label:** Distinct families
**Description:** 8 different model families across Cerebras, Cloudflare native, and Bedrock — answers "which family writes the best fast page?"

| # | Provider | Model id | Family |
|---|----------|----------|--------|
| 1 | cerebras | `gpt-oss-120b` | GPT-OSS (baseline) |
| 2 | cloudflare | `@cf/zai-org/glm-4.7-flash` | Z.ai GLM |
| 3 | cloudflare | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Meta Llama |
| 4 | cloudflare | `@cf/moonshotai/kimi-k2.6` | Moonshot Kimi |
| 5 | bedrock | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Anthropic Claude |
| 6 | bedrock | `google.gemma-3-12b-it` | Google Gemma |
| 7 | bedrock | `amazon.nova-lite-v1:0` | Amazon Nova |
| 8 | bedrock | `mistral.ministral-3-14b-instruct` | Mistral |

Hosting mix: 1× Cerebras, 3× CF native, 4× Bedrock. Every entry is a different model family.

## Preset B — `route-latency`

**Label:** Route latency
**Description:** 4 model pairs running the same (or near-identical) model on two different routes — isolates infrastructure latency from model quality.

| Pair | Cell A | Cell B |
|------|--------|--------|
| GPT-OSS 120B | cerebras / `gpt-oss-120b` | cloudflare / `@cf/openai/gpt-oss-120b` |
| Llama 3.3 70B | cloudflare / `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | bedrock / `us.meta.llama3-3-70b-instruct-v1:0` |
| Gemma 3 12B | cloudflare / `@cf/google/gemma-3-12b-it` | bedrock / `google.gemma-3-12b-it` |
| Nemotron 120B | cloudflare / `@cf/nvidia/nemotron-3-120b-a12b` | bedrock / `nvidia.nemotron-super-3-120b` |

Three of four pairs are strict same-model matches. The Nemotron pair compares CF's `nemotron-3-120b-a12b` against Bedrock's `nemotron-super-3-120b` — same family, different release tag. We accept the slight variance to land a fourth pair and exercise an NVIDIA route on both providers.

**Interpretation:** Within a pair, judge quality should land within ~0.2 (same weights). TTFT and duration deltas inside a pair are pure route latency.

## Defaults per row

Every row uses the same defaults as existing presets:
- `temperature: 0.6`
- `maxTokens: 5120`

## Implementation

Single file edit — `blocks/admin/admin.js`, append two entries to `EVAL_MODEL_PRESETS` (currently ends at line ~2221). New entries follow the exact shape of the existing three:

```js
{
  id: 'distinct-families',
  label: 'Distinct families',
  description: '8 different model families across Cerebras, Cloudflare and Bedrock',
  models: [
    { key: 'cerebras::gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
    { key: 'cloudflare::@cf/zai-org/glm-4.7-flash', temperature: 0.6, maxTokens: 5120 },
    { key: 'cloudflare::@cf/meta/llama-3.3-70b-instruct-fp8-fast', temperature: 0.6, maxTokens: 5120 },
    { key: 'cloudflare::@cf/moonshotai/kimi-k2.6', temperature: 0.6, maxTokens: 5120 },
    { key: 'bedrock::us.anthropic.claude-haiku-4-5-20251001-v1:0', temperature: 0.6, maxTokens: 5120 },
    { key: 'bedrock::google.gemma-3-12b-it', temperature: 0.6, maxTokens: 5120 },
    { key: 'bedrock::amazon.nova-lite-v1:0', temperature: 0.6, maxTokens: 5120 },
    { key: 'bedrock::mistral.ministral-3-14b-instruct', temperature: 0.6, maxTokens: 5120 },
  ],
},
{
  id: 'route-latency',
  label: 'Route latency',
  description: '4 model pairs — same model on two routes, isolates infrastructure latency',
  models: [
    { key: 'cerebras::gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
    { key: 'cloudflare::@cf/openai/gpt-oss-120b', temperature: 0.6, maxTokens: 5120 },
    { key: 'cloudflare::@cf/meta/llama-3.3-70b-instruct-fp8-fast', temperature: 0.6, maxTokens: 5120 },
    { key: 'bedrock::us.meta.llama3-3-70b-instruct-v1:0', temperature: 0.6, maxTokens: 5120 },
    { key: 'cloudflare::@cf/google/gemma-3-12b-it', temperature: 0.6, maxTokens: 5120 },
    { key: 'bedrock::google.gemma-3-12b-it', temperature: 0.6, maxTokens: 5120 },
    { key: 'cloudflare::@cf/nvidia/nemotron-3-120b-a12b', temperature: 0.6, maxTokens: 5120 },
    { key: 'bedrock::nvidia.nemotron-super-3-120b', temperature: 0.6, maxTokens: 5120 },
  ],
},
```

No other file touches needed. The preset chips render automatically from `EVAL_MODEL_PRESETS` in `renderEvalPresetChips()` (called by the new-eval form).

## Verification

1. `npm run lint` clean.
2. Open `http://localhost:3000/admin#/evaluations/new` (or feature preview) and confirm five chips render in this order: Cerebras only · GPT-OSS providers · Diverse mix · Distinct families · Route latency.
3. Click each new chip and confirm the 8-row model picker populates with the correct entries (drop-down shows the expected model labels).
4. Submit a smoke run with `coffee-dev` suite (3 queries, ~24 cells) against each preset and confirm all variants reach `complete` — catches catalog key typos.

## Out of scope

- Adding new models to `MODEL_CATALOG`. Catalog is comprehensive for fast+quality picks.
- Reweighting the judge rubric.
- Cost estimation UI changes.
- New suites or query gold-set changes.
