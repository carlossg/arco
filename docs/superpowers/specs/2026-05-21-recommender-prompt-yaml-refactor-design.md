# Recommender Prompt YAML Refactor — Design

**Status:** Approved (brainstorming complete)
**Date:** 2026-05-21
**Author:** ffroese@adobe.com
**Scope:** `workers/recommender/`

## Problem

The recommender LLM prompt lives entirely in JavaScript (`workers/recommender/src/recommender-prompt.js`, 593 lines). The benchmark repo (`aem-growth-arco-benchmark`) maintains a hand-copied YAML mirror of that prompt for promptfoo testing. The two have already drifted — the benchmark YAML has 8 CRITICAL RULES versus 11 in production, and is missing the feature-match scenario logic entirely.

Bringing promptfoo testing into the arco repo only multiplies the drift problem unless the prompt has a single source of truth that both production code and tests render from.

## Goal

Refactor the recommender prompt and the suggestions prompt into YAML templates with Nunjucks templating, and introduce promptfoo-based testing inside the arco repo. The same YAML file must render to the same string in both production (`/api/generate`, `/api/admin/experiments`) and tests.

The benchmark repo is out of scope — no changes there.

## Non-goals

- Refactoring the LLM judge prompt (`workers/recommender/src/evaluations/judge.js`). Stays as-is.
- Replacing the existing `/admin#/evaluations` eval queue. The promptfoo eval-suite mirror is additive, not a replacement.
- Touching intent classification or the safety gate — both are rule-based JS, no LLM call.
- Changing the rendered prompt's wording. The refactor is structural; output should be byte-identical (or near-identical) on day one. Wording changes happen in follow-up PRs.

## Architecture

```
workers/recommender/
├── prompts/                              ← single source of truth
│   ├── recommender.yaml                  ← system + user, Nunjucks templated
│   ├── suggestions.yaml                  ← system + user, Nunjucks templated
│   ├── partials/
│   │   ├── brand-voice.njk
│   │   ├── block-guide.njk
│   │   ├── product-catalog.njk
│   │   └── accessories.njk
│   └── README.md                         ← context object schema
│
├── src/
│   ├── prompt-loader.js                  ← NEW — loads YAML, exposes renderPrompt()
│   ├── recommender-prompt.js             ← shrinks to: build context → renderPrompt()
│   ├── suggest.js                        ← same shrink
│   ├── brand-voice.js                    ← DELETE (content moved to partial)
│   └── block-guide.js                    ← DELETE (content moved to partial)
│
└── tests/
    ├── fixtures/                         ← per-scenario context objects (JSON)
    │   ├── cold-start.json
    │   ├── cold-start-comparison.json
    │   ├── follow-up-comparison.json
    │   ├── follow-up-cheaper.json
    │   ├── follow-up-pivot.json
    │   ├── feature-match-touchscreen.json
    │   ├── feature-match-zero.json
    │   └── default-with-rag.json
    ├── snapshots/
    │   ├── recommender.test.js           ← Node test runner, no LLM
    │   └── __snapshots__/                ← rendered prompts checked in
    └── promptfoo/
        ├── recommender-bench.yaml        ← multi-model benchmark
        ├── suggestions-bench.yaml
        └── recommender-evalsuite-*.yaml  ← later — runs eval/suites/* via promptfoo
```

### Key load-bearing decisions

1. **One renderer module (`src/prompt-loader.js`) is the single seam.** Production worker code calls `renderPrompt('recommender', ctx)`. promptfoo calls the same module via a custom prompt function (`file://../../src/prompt-loader.js:renderForPromptfoo`). If tests and production go through different code paths, drift sneaks back in.

2. **Nunjucks for all branching.** Every conditional in `buildRecommenderUserMessage` maps 1:1 to `{% if %}` / `{% elif %}` in the template — no prose hides in JS strings. Nunjucks is promptfoo's native templating engine, so tests and production share the rendering engine, not just the source file. Adds a small dependency to the worker (~30KB minified).

3. **Catalog data is a runtime variable, not template content.** `products.json` / `accessories.json` / `product-profiles.json` are loaded by the JS code and passed as `context.catalog` etc. The `product-catalog.njk` partial iterates them. No catalog data is inlined in YAML — tests load the same JSON via the same renderer.

4. **JS computes structured inputs the template can't.** Non-templatable logic stays in JS:
   - `detectFeatureRequest()` scans the catalog with predicate functions → `context.featureMatch = { feature, matches[] }`
   - `describeShownProducts(ids)` formats a catalog-dependent line → `context.shownProductsLine` (pre-rendered string)
   - Conversation history string from `previousQueries` + `shownContent` → `context.history` (pre-rendered string)
   - Behavior analysis is already a structured object → `context.behavior`

5. **Scenario picking stays in JS.** JS sets `context.scenario` to one of `'default' | 'cold-start' | 'cold-start-comparison' | 'follow-up' | 'follow-up-cheaper' | 'follow-up-pivot'`. The template branches on this string. This is the only "logic" the template needs beyond section-presence checks.

## Context schema

The contract between production and tests. Defined in `prompts/README.md` and validated lightly at the renderer boundary (defensive defaults for missing optional fields, not full JSON-schema validation).

```js
{
  // Always present
  query: string,
  scenario: 'default' | 'cold-start' | 'cold-start-comparison'
          | 'follow-up' | 'follow-up-cheaper' | 'follow-up-pivot',
  catalog: Product[],
  accessories: Accessory[],
  productProfiles: ProductProfile[],

  // Intent / follow-up
  intent: { type: string, journeyStage?: string } | null,
  followUp: {
    type: 'pivot' | 'cheaper_alternative' | 'compare' | 'explore',
    label: string,
    product?: string,
  } | null,

  // Browsing behavior
  behavior: {
    coldStart: boolean,
    priceTier?: 'budget' | 'mid' | 'premium',
    skillLevel?: string,
    purchaseReadiness?: string,
    viewedProducts?: string[],
    searchContext?: string[],
    useCasePriorities?: string[],
    catalogPriceRange?: { min: number, max: number },
  },

  // Pre-computed by JS
  featureMatch: { feature: string, matches: Array<{ name, id, price }> } | null,
  history: string | null,                  // pre-rendered for follow-ups
  shownProductsLine: string | null,        // pre-rendered via describeShownProducts()

  // RAG (each key optional; template uses {% if %})
  rag: {
    products?: Array<{ name, id, price, bestFor?: string[] }>,
    recipes?: Array<{ name, id }>,
    guides?: Array<{ title, slug, category? }>,
    experiences?: Array<{ title, slug, experience_archetype?, anchor_product? }>,
    reviews?: Array<{ id, author?, content? }>,
    faqs?: Array<{ question, answer }>,
    features?: Array<{ name, benefit?, description? }>,
    comparisons?: Array<{ title, slug, verdict? }>,
    toolContent?: Array<{ title, slug, type?, category? }>,
    persona?: { name, priorities?: string[], skillLevel?, budget? },
    useCase?: { name, description? },
  },

  // Dedup hints (first-generation only)
  previousQueries?: string[],
  shownBlockTypes?: string[],
}
```

Suggestions context is much smaller:

```js
{
  count: number,
  userProfile?: { skillLevel?, viewedProducts?: string[], priceTier? },
  recentlyViewed?: string[],
  recentQueries?: string[],
}
```

## Renderer interface

```js
// workers/recommender/src/prompt-loader.js

// Production entry — pure function, deterministic given the same ctx.
export function renderPrompt(name: 'recommender' | 'suggestions', ctx: object)
  : { system: string, user: string };

// promptfoo entry — adapter that builds ctx from test `vars` and returns
// OpenAI-style messages.
export async function renderForPromptfoo({ vars }: { vars: object })
  : Promise<Array<{ role: 'system' | 'user', content: string }>>;
```

YAML files are loaded once at module init (worker cold-start). Nunjucks `Environment` is configured with a `FileSystemLoader` pointed at `prompts/`, so `{% include "partials/brand-voice.njk" %}` resolves naturally. Templates are compiled once and re-rendered per request.

## Template structure

### `prompts/recommender.yaml`

```yaml
system: |
  You are an Arco coffee equipment advisor — knowledgeable, precise, and warm. …

  {% include "partials/brand-voice.njk" %}

  ## Your Approach
  {# unchanged 5-step consultative flow #}

  ## CRITICAL RULES
  {# unchanged 11 rules, verbatim from today's JS #}

  {% include "partials/block-guide.njk" %}

  ## Recommender-Specific Block Guidance
  {# unchanged #}

  ## Page Structure by Scenario
  {# unchanged scenario catalog #}

  ## Suggestions Format
  {# unchanged #}

  ## Full Product Catalog — Espresso Machines & Grinders
  {% include "partials/product-catalog.njk" %}

  ## Accessories
  {% include "partials/accessories.njk" %}

user: |
  {%- if scenario == 'follow-up-pivot' -%}
  The customer wants to learn more about {{ followUp.product }}. …
  {{ history }}
  {%- elif scenario == 'follow-up-cheaper' -%}
  …
  {%- elif scenario == 'follow-up' -%}
  …
  {%- elif scenario == 'cold-start-comparison' -%}
  …
  {%- elif scenario == 'cold-start' -%}
  …
  {%- else -%}
  Generate a personalized coffee equipment recommendation page: "{{ query }}"
  …
  {%- endif %}

  {%- if not behavior.coldStart %}

  ## Customer Profile (from browsing behavior)
  {%- if behavior.catalogPriceRange %}
  - Budget range: ${{ behavior.catalogPriceRange.min }}–${{ behavior.catalogPriceRange.max }} (from viewed products)
  {%- endif %}
  {# ... rest of profile fields ... #}

  {%- endif %}

  {%- if not followUp %}
  {%- if previousQueries %}

  Previous queries (avoid repeating): {{ previousQueries | join(', ') }}
  {%- endif %}
  {%- if shownProductsLine %}

  Products already shown to the user (do NOT repeat as primary recommendation): {{ shownProductsLine }}
  {%- endif %}
  {%- if shownBlockTypes %}

  Block types already on the page (vary your approach, use different blocks): {{ shownBlockTypes | join(', ') }}
  {%- endif %}
  {%- endif %}

  {%- if featureMatch %}

  ## Feature Match — "{{ featureMatch.feature }}"
  {%- if featureMatch.matches | length == 0 %}
  ZERO machines in the Arco catalog have this feature. …
  {%- elif featureMatch.matches | length == 1 %}
  EXACTLY ONE machine in the Arco catalog has this feature: **{{ featureMatch.matches[0].name }}** (${{ featureMatch.matches[0].price }}). …
  {%- else %}
  Machines with this feature: {% for m in featureMatch.matches %}{{ m.name }} (${{ m.price }}){% if not loop.last %}, {% endif %}{% endfor %}. …
  {%- endif %}
  {%- endif %}

  {%- if rag.products %}

  ## Recommended Products (from RAG — highest relevance to this query)
  {%- for p in rag.products %}
  - {{ p.name }} ({{ p.id }}) | ${{ p.price }} | {{ p.bestFor | join(', ') or 'general' }}
  {%- endfor %}
  {%- endif %}

  {# … recipes, guides, experiences, reviews, faqs, features, comparisons,
       toolContent, persona, useCase — each as {% if rag.X %} block … #}

  {%- if intent.type %}

  ## Intent Classification
  Detected intent: **{{ intent.type }}**{% if intent.journeyStage %} | Journey stage: {{ intent.journeyStage }}{% endif %}
  {%- endif %}

  Remember: output JSON blocks separated by ===. …

  {%- if not followUp %}

  IMPORTANT: The FIRST suggestion must always be about espresso machines with milk frothing/steaming capabilities, …
  {%- endif %}
```

### Partials

- `partials/brand-voice.njk` — verbatim copy of today's `BRAND_VOICE` string from `src/brand-voice.js`.
- `partials/block-guide.njk` — verbatim copy of today's `EDS_BLOCK_GUIDE` from `src/block-guide.js`.
- `partials/product-catalog.njk` — `{% for p in catalog %}…{% endfor %}` loop matching the output of today's `buildProductCatalog()`.
- `partials/accessories.njk` — `{% for a in accessories %}…{% endfor %}` matching `buildAccessoriesList()`.

### `prompts/suggestions.yaml`

```yaml
system: |
  You generate {{ count }} short, distinct exploration prompts for a coffee/espresso brand site. …
user: |
  {%- if userProfile %}
  User profile: …
  {%- endif %}
  {%- if recentlyViewed %}
  Recently viewed: {{ recentlyViewed | join(', ') }}
  {%- endif %}
  {# … rest of today's buildUserPrompt body … #}
```

## Testing

Three test surfaces, designed top-down so the cheap ones catch most regressions before the expensive ones run.

### 1. Snapshot tests (no LLM, runs in CI)

`tests/snapshots/recommender.test.js` — Node test runner (no extra deps). For each fixture, renders the template and asserts the output matches a checked-in snapshot.

What it catches:
- Template syntax errors (broken `{% if %}` / `{% include %}`).
- Accidental prose drift (the rendered diff lights up in PR review).
- Context-schema breaks (renderer throws when a fixture's shape mismatches).

Runs via `npm test` in `workers/recommender/`. Milliseconds per fixture. **Required to pass on every PR touching `prompts/` or `src/prompt-loader.js`.**

Fixtures cover at minimum: cold-start, cold-start-comparison, follow-up (compare/explore), follow-up-cheaper, follow-up-pivot, feature-match (touchscreen/zero/multi), default with full RAG.

### 2. Multi-model benchmark (promptfoo)

`tests/promptfoo/recommender-bench.yaml` — same shape as the benchmark repo's `recommender.yaml`. Lifts the provider list, deterministic assertions (Tier 1–3), and threshold-based scoring verbatim. Difference: the `prompts:` entry points to our renderer instead of inlining the prompt.

```yaml
prompts:
  - id: recommender
    file: file://../../src/prompt-loader.js:renderForPromptfoo
```

Tests are scenario-driven `vars:` blocks. Each test supplies a complete context object (scenario, query, intent, behavior, rag). promptfoo runs the renderer per-provider, then evaluates assertions on the streamed output.

Run via `npm run bench:recommender`. Time/cost on par with the existing benchmark repo run.

### 3. Eval-suite mirror (later, designed-for)

The existing eval suites in `eval/suites/coffee-{extended,default,dev}.json` already encode 60+ queries with `gold` fields (`mustMentionAny`, `mustNotMention`, `minProductCount`). A small exporter (`asPromptfooTests`) maps each suite entry to a promptfoo test, with the `gold` field translated to `javascript` assertions that reuse `src/evaluations/assertions.js`.

This stays **out of the first PR** but the renderer interface and fixture shape are designed so it slots in without rework. Estimated work: half a day once the rest is shipped.

### Regression-test path (later)

Once a production model is settled: copy the benchmark config, restrict providers to that one model, set the threshold to 0.95+, and add it to CI. Infra is already in place from surface 2.

## Phased delivery

This refactor ships in three PRs to keep the blast radius small.

### Phase 1 — Renderer + recommender YAML, no behavior change

1. Add Nunjucks dependency to `workers/recommender/package.json`.
2. Create `src/prompt-loader.js`, `prompts/recommender.yaml`, `prompts/partials/*`.
3. Rewrite `src/recommender-prompt.js` so `buildRecommenderSystemPrompt()` and `buildRecommenderUserMessage()` become thin shims that build the context object and call `renderPrompt('recommender', ctx)`.
4. Delete `src/brand-voice.js`, `src/block-guide.js` (moved to partials).
5. Add `tests/snapshots/` with fixtures covering all scenarios.
6. **Acceptance gate:** snapshot tests show the rendered output is byte-identical (or near-identical, modulo whitespace) to today's production output for every fixture. Captured by running the old code and the new code on the same context and diffing.

**No behavior change visible to users.** Worker still serves the same prompt.

### Phase 2 — Suggestions YAML

Smaller, isolated. Mirrors phase 1 for `suggest.js`. Same snapshot-test gate.

### Phase 3 — promptfoo benchmark inside arco

1. Add `promptfoo` as a dev dependency at `workers/recommender/package.json`.
2. Create `tests/promptfoo/recommender-bench.yaml` and `tests/promptfoo/suggestions-bench.yaml`.
3. Add `npm run bench:*` scripts.
4. README under `tests/promptfoo/` documenting how to run, where API keys come from (`.env` patterns matching the benchmark repo), and how to add a new test.

After Phase 3, the eval-suite mirror and CI regression gate become follow-up tasks.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Nunjucks dependency increases worker bundle size | Nunjucks pre-built is ~30KB minified. Acceptable. Confirmed via `npm pack` before merge. If too large, swap to a smaller Nunjucks-subset library (e.g. `nunjucks-slim`) or pre-compile templates at build time. |
| Rendered output drifts from today's during refactor | Phase-1 acceptance gate is byte-level diff against current production output across all fixtures. Drift caught before merge. |
| Template syntax errors crash production cold-start | YAML is parsed and templates compiled at module init. Snapshot tests in CI catch template errors before deploy. Worker startup will fail loudly with a clear Nunjucks error rather than serving a broken prompt. |
| promptfoo's Nunjucks version diverges from worker's | Both pin the same `nunjucks` version in `package.json`. Single dependency, one source of truth for templating behavior. |
| Catalog JSON shape changes break template silently | Renderer adds a defensive smoke render at module init (renders a "canary" context) and throws if any partial fails. Catches schema breaks at deploy, not at first user request. |

## Out of scope (explicit)

- The LLM judge prompt in `src/evaluations/judge.js`. Stays in JS.
- Intent classification (rule-based, no LLM).
- The safety gate (rule-based, no LLM).
- The benchmark repo (`aem-growth-arco-benchmark/`). No changes.
- Wording changes to the prompt. Refactor is structural; wording PRs are separate.
- Replacing the existing eval queue / `/admin#/evaluations`. Promptfoo eval-suite mirror is additive.

## Open questions

None blocking. The Phase-3 eval-suite-mirror design (`asPromptfooTests` exporter) gets its own short spec when we get to it.
