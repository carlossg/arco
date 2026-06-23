# Recommender Prompt YAML Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the recommender and suggestions LLM prompts from JavaScript into Nunjucks-templated YAML files with a single renderer used by both production code and promptfoo tests.

**Architecture:** YAML templates live under `workers/recommender/prompts/`. A single `src/prompt-loader.js` module parses them at worker cold-start, compiles Nunjucks templates with an in-memory loader (no runtime filesystem), and exposes `renderPrompt(name, ctx)` for production and `renderForPromptfoo({ vars })` for tests. Brand voice and block guide become Nunjucks partials. Catalog data stays in JSON, passed as a context variable. Snapshot tests against checked-in fixtures guard the refactor — the rendered output on day one must equal what the JS code produces today.

**Tech Stack:** Cloudflare Worker (esbuild via wrangler), `nunjucks` (full runtime, ~150KB), `yaml` (parser, ~70KB), `node:test` for snapshot tests, `promptfoo` (dev dep only).

**Spec:** `docs/superpowers/specs/2026-05-21-recommender-prompt-yaml-refactor-design.md`

---

## File Structure

Files created or modified, grouped by responsibility:

**New — single source of truth:**
- `workers/recommender/prompts/recommender.yaml` — system + user templates with all conditional branches
- `workers/recommender/prompts/suggestions.yaml` — system + user templates for `/api/suggest`
- `workers/recommender/prompts/partials/brand-voice.njk` — Arco brand-voice prose
- `workers/recommender/prompts/partials/block-guide.njk` — EDS block format spec
- `workers/recommender/prompts/partials/product-catalog.njk` — `{% for p in catalog %}…{% endfor %}` loop
- `workers/recommender/prompts/partials/accessories.njk` — accessories loop
- `workers/recommender/prompts/README.md` — context object schema documentation

**New — renderer:**
- `workers/recommender/src/prompt-loader.js` — loads YAML, compiles Nunjucks, exposes `renderPrompt()` + `renderForPromptfoo()`

**Modified — production callers:**
- `workers/recommender/src/recommender-prompt.js` — shrinks to context-builder helpers + thin shims around `renderPrompt('recommender', ctx)`
- `workers/recommender/src/suggest.js` — `SYSTEM_PROMPT` constant and `buildUserPrompt()` replaced with `renderPrompt('suggestions', ctx)`
- `workers/recommender/wrangler.jsonc` — add `rules` entry so esbuild treats `.yaml` and `.njk` as text imports
- `workers/recommender/package.json` — add `nunjucks`, `yaml` deps; `promptfoo` devDep; test/bench scripts

**Deleted:**
- `workers/recommender/src/brand-voice.js` — content moved to `prompts/partials/brand-voice.njk`
- `workers/recommender/src/block-guide.js` — content moved to `prompts/partials/block-guide.njk`

**New — tests:**
- `workers/recommender/tests/fixtures/*.json` — 8 context fixtures (one per scenario)
- `workers/recommender/tests/snapshots/recommender.test.js` — node:test snapshot test
- `workers/recommender/tests/snapshots/suggestions.test.js`
- `workers/recommender/tests/snapshots/__snapshots__/*.txt` — checked-in rendered prompts
- `workers/recommender/tests/promptfoo/recommender-bench.yaml`
- `workers/recommender/tests/promptfoo/suggestions-bench.yaml`
- `workers/recommender/tests/promptfoo/README.md`

**New — tooling (optional but useful):**
- `workers/recommender/tools/capture-baseline.js` — one-shot script: runs the *current* JS prompt builder with each fixture, dumps output to `__snapshots__/baseline-*.txt`. Used to lock the byte-for-byte target before the refactor begins.
- `workers/recommender/tools/render-prompt.js` — CLI: `node tools/render-prompt.js cold-start` dumps the rendered prompt for a fixture. Manual debugging.

---

## Phase 1 — Renderer + Recommender YAML (no behavior change)

### Task 1: Add dependencies and wrangler text-import rule

**Files:**
- Modify: `workers/recommender/package.json`
- Modify: `workers/recommender/wrangler.jsonc`

- [ ] **Step 1: Install runtime deps**

Run from `workers/recommender/`:
```bash
npm install --save nunjucks@^3.2.4 yaml@^2.6.0
```
Expected: both added to `dependencies` in `package.json`.

- [ ] **Step 2: Add the text-import rule to wrangler.jsonc**

Open `workers/recommender/wrangler.jsonc`. After the closing `}` of `"analytics_engine_datasets"` (or anywhere at the top level), add:

```jsonc
  // Bundle YAML prompt templates and Nunjucks partials as text imports.
  "rules": [
    { "type": "Text", "globs": ["**/*.yaml", "**/*.yml", "**/*.njk"], "fallthrough": true }
  ],
```

- [ ] **Step 3: Verify worker builds**

Run from `workers/recommender/`:
```bash
npx wrangler deploy --dry-run --outdir /tmp/wrangler-build-check
```
Expected: build succeeds. (No prompts are imported yet — this just confirms the rule doesn't break the existing build.)

- [ ] **Step 4: Commit**

```bash
git add workers/recommender/package.json workers/recommender/package-lock.json workers/recommender/wrangler.jsonc
git commit -m "chore(recommender): add nunjucks+yaml deps and wrangler text-import rule"
```

---

### Task 2: Create brand-voice partial

**Files:**
- Create: `workers/recommender/prompts/partials/brand-voice.njk`

- [ ] **Step 1: Create the partial directory**

```bash
mkdir -p workers/recommender/prompts/partials
```

- [ ] **Step 2: Write the partial — content is the BRAND_VOICE constant verbatim**

Create `workers/recommender/prompts/partials/brand-voice.njk` containing the body of the `BRAND_VOICE` template literal from `workers/recommender/src/brand-voice.js:8-54` — i.e. starting at `## Arco Brand Voice & Tone` through `Use "espresso" not "expresso"`. Strip the surrounding backticks and the leading blank line, but keep all internal whitespace and newlines unchanged.

Read the source first:
```bash
sed -n '9,53p' workers/recommender/src/brand-voice.js > workers/recommender/prompts/partials/brand-voice.njk
```

Open the resulting file and verify the first line is `## Arco Brand Voice & Tone` and the last line is `- Use "espresso" not "expresso"`. No trailing backtick or template-literal artifacts.

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/prompts/partials/brand-voice.njk
git commit -m "feat(prompts): extract brand voice to nunjucks partial"
```

---

### Task 3: Create block-guide partial

**Files:**
- Create: `workers/recommender/prompts/partials/block-guide.njk`

- [ ] **Step 1: Identify the exported string boundary in block-guide.js**

```bash
grep -n "^export\|^const\|^\`" workers/recommender/src/block-guide.js | head -10
```
This shows you where the exported template literal starts and ends.

- [ ] **Step 2: Extract the body to the partial**

Identify the start and end line numbers of the template-literal content (lines between the opening `` ` `` and the closing `` ` ``). Run:
```bash
sed -n '<START>,<END>p' workers/recommender/src/block-guide.js > workers/recommender/prompts/partials/block-guide.njk
```
Replace `<START>` and `<END>` with the actual line numbers. Open the result and verify:
- First line is the first content line of the EDS block guide (no `` ` `` or `=`)
- Last line is the last content line (no trailing `` ` ``)
- All internal Markdown formatting preserved

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/prompts/partials/block-guide.njk
git commit -m "feat(prompts): extract EDS block guide to nunjucks partial"
```

---

### Task 4: Create product-catalog and accessories partials

**Files:**
- Create: `workers/recommender/prompts/partials/product-catalog.njk`
- Create: `workers/recommender/prompts/partials/accessories.njk`

- [ ] **Step 1: Write product-catalog.njk**

Mirror the output of `buildProductCatalog()` in `workers/recommender/src/recommender-prompt.js:68-103`. The original concatenates per-product blocks of 4 lines joined with `\n`. The Nunjucks equivalent:

```nunjucks
{%- for p in catalog -%}
{%- set profile = (productProfiles | findProfile(p.id)) -%}
{%- set topUses = profile.topUses or '' -%}
{%- set boiler = p.specs.boilers or '?' -%}
{%- set group = p.specs.groupHead or '?' -%}
{%- set power = p.specs.power or '?' -%}
{%- set pump = p.specs.pumpType or '?' -%}
{%- set specials = [] -%}
{%- if p.specs.pidControl -%}{%- set specials = (specials.push('PID'), specials) -%}{%- endif -%}
{# ...etc — see note below... #}
- **{{ p.name }}** (ID: {{ p.id }}) | ${{ p.price }} | Series: {{ p.series }} | Category: {{ p.category }}
  Specs: {{ boiler }} boiler, {{ group }}, {{ pump }}, {{ power }}{% if specials | length %} | {{ specials | join(', ') }}{% endif %}
  Best for: {{ (p.bestFor | join(', ')) or 'general' }} | Warranty: {{ p.warranty or 'N/A' }}
  {% if topUses %}Top use-cases: {{ topUses }} | {% endif %}Heat-up: {{ p.specs.heatUpTime or '?' }}
  Link: {{ p.url }}
{% endfor -%}
```

**Critical:** Nunjucks doesn't support mutable arrays cleanly with `.push()`. Instead, pre-compute the `specials` list and `topUses` string in JS before passing context to the template, OR write a small Nunjucks filter. The simplest path is **option B — pre-compute in JS**.

Adjust the partial to consume pre-computed fields. Final partial:

```nunjucks
{%- for p in catalog -%}
- **{{ p.name }}** (ID: {{ p.id }}) | ${{ p.price }} | Series: {{ p.series }} | Category: {{ p.category }}
  Specs: {{ p._boiler }} boiler, {{ p._group }}, {{ p._pump }}, {{ p._power }}{% if p._specials %} | {{ p._specials }}{% endif %}
  Best for: {{ p._bestFor }} | Warranty: {{ p._warranty }}
  {% if p._topUses %}Top use-cases: {{ p._topUses }} | {% endif %}Heat-up: {{ p._heatUp }}
  Link: {{ p.url }}
{% endfor -%}
```

Where `_boiler`, `_group`, `_pump`, `_power`, `_specials`, `_bestFor`, `_warranty`, `_topUses`, `_heatUp` are pre-computed strings on each product in `prompt-loader.js`'s context-building step. This keeps the template free of conditional spec-flag logic.

- [ ] **Step 2: Write accessories.njk**

Mirror `buildAccessoriesList()` in `workers/recommender/src/recommender-prompt.js:108-113`:

```nunjucks
{%- if accessories | length == 0 -%}
(none)
{%- else -%}
{%- for a in accessories -%}
- **{{ a.name }}** (ID: {{ a.id }}) | ${{ a.price or '?' }} | {{ a._description }}
{% endfor -%}
{%- endif -%}
```

`_description` is the original `description` truncated to 80 chars — pre-computed in the loader.

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/prompts/partials/product-catalog.njk workers/recommender/prompts/partials/accessories.njk
git commit -m "feat(prompts): extract catalog and accessories rendering to partials"
```

---

### Task 5: Create the recommender YAML template

**Files:**
- Create: `workers/recommender/prompts/recommender.yaml`

- [ ] **Step 1: Create the file with the system and user templates**

This is the largest piece. Structure:

```yaml
# Recommender prompt — Arco coffee equipment advisor.
# Variables consumed: see prompts/README.md for the full schema.
system: |
  You are an Arco coffee equipment advisor — knowledgeable, precise, and warm. Your role is to help customers find the perfect espresso machine and grinder through a consultative conversation. You educate, compare, and let the product speak for itself. You NEVER push a sale.

  {% include "partials/brand-voice.njk" %}

  ## Your Approach

  Follow this consultative flow:
  1. **Acknowledge** — Show you understand the customer's needs (from their browsing behavior, search terms, viewed products)
  2. **Recommend** — Present your top pick with clear reasoning using a columns block (product spotlight)
  3. **Compare** — Show a comparison-table with 3 products so they can decide (fall back to 2 only when fewer genuinely qualify)
  4. **Inform** — Include relevant educational content (guides, recipes, tips)
  5. **Guide** — End with suggestion buttons that help you learn MORE about their needs (not buy buttons)

  ## CRITICAL RULES

  # Copy rules 1, 2, 2a, 3, 4, 5, 6, 10, 7, 8, 9, 11 VERBATIM from
  # workers/recommender/src/recommender-prompt.js:136-158. Rule numbering
  # quirks (2a between 2 and 3; 10 before 7) are intentional — preserve them.
  # All `{{...}}` token references in the prose are LITERAL braces in the
  # rendered prompt, not Nunjucks expressions. Wrap each rule's body in
  # `{% raw %}{% endraw %}` to prevent Nunjucks from interpreting them, OR
  # escape every `{{` as `{{ '{{' }}` and `}}` as `{{ '}}' }}`. Prefer the
  # raw block — wrap the entire CRITICAL RULES section in one raw block:
  #
  # {% raw %}
  # 1. **NO BUY BUTTONS**: ...
  # 2. ...
  # {% endraw %}

  {% include "partials/block-guide.njk" %}

  ## Recommender-Specific Block Guidance

  # Copy verbatim from src/recommender-prompt.js:164-176. Same {% raw %}
  # wrapping is needed because the prose references {{recipe:NAME}} etc.

  ## Page Structure by Scenario

  # Copy the full scenario catalog verbatim from src/recommender-prompt.js:178-252.
  # This is the largest verbatim section — includes "With User Profile",
  # "Cold Start", four "Follow-Up" variants, three "Feature-Specific" variants,
  # "Hobby / Lifestyle", and "Off-Topic / Competitor Request". All inside
  # a single {% raw %}...{% endraw %} block because the prose is rich with
  # {{token:NAME}} examples.

  ## Suggestions Format

  # Copy verbatim from src/recommender-prompt.js:254-272.

  ## Full Product Catalog — Espresso Machines & Grinders

  {% include "partials/product-catalog.njk" %}

  ## Accessories

  {% include "partials/accessories.njk" %}

user: |
  {%- if scenario == 'follow-up-pivot' -%}
  # Copy the pivot branch verbatim from src/recommender-prompt.js:424-426,
  # converting `${followUp.product}` to `{{ followUp.product }}` and
  # `${buildConversationHistory(...)}` to `{{ history }}`. Wrap any
  # `{{ }}` token examples in `{% raw %}{% endraw %}` if they appear.
  {%- elif scenario == 'follow-up-cheaper' -%}
  # Copy from src/recommender-prompt.js:428-430.
  {%- elif scenario == 'follow-up' -%}
  # Copy from src/recommender-prompt.js:432-437. The `startHint` variable
  # becomes a nested {% if followUp.type == 'compare' %} branch.
  {%- elif scenario == 'cold-start-comparison' -%}
  # Copy from src/recommender-prompt.js:438-449 (substituting {{ query }}).
  {%- elif scenario == 'cold-start' -%}
  # Copy from src/recommender-prompt.js:450-463.
  {%- else -%}
  Generate a personalized coffee equipment recommendation page: "{{ query }}"

  Start with a hero that acknowledges what they've been exploring. The hero MUST include an image — use {% raw %}{{product-image:ID}}{% endraw %} of your primary recommended product, or {% raw %}{{hero-image:main}}{% endraw %} if no single product fits. Then recommend your top pick, compare alternatives, and include relevant content.
  {%- endif %}

  {%- if not behavior.coldStart %}

  ## Customer Profile (from browsing behavior)
  {%- if behavior.catalogPriceRange %}
  - Budget range: ${{ behavior.catalogPriceRange.min }}–${{ behavior.catalogPriceRange.max }} (from viewed products)
  {%- endif %}
  {%- if behavior.priceTier %}
  - Price sensitivity: {{ behavior.priceTier }} tier
  {%- endif %}
  {%- if behavior.purchaseReadiness %}
  - Purchase readiness: {{ behavior.purchaseReadiness }}
  {%- endif %}
  {%- if behavior.skillLevel %}
  - Skill level: {{ behavior.skillLevel }}
  {%- endif %}
  {%- if behavior.viewedProducts %}
  - Viewed products: {{ behavior.viewedProducts | join(', ') }}
  {%- endif %}
  {%- if behavior.searchContext %}
  - Search terms: {{ behavior.searchContext | join(', ') }}
  {%- endif %}
  {%- if behavior.useCasePriorities %}
  - Interested in: {{ behavior.useCasePriorities | join(', ') }}
  {%- endif %}

  Use this profile to personalize your recommendation. Lead with products matching their price tier and use-case interests.
  {%- if behavior.catalogPriceRange %}

  **Price guidance:** Focus your primary recommendation and comparison-table on products within the ${{ behavior.catalogPriceRange.min }}–${{ behavior.catalogPriceRange.max }} range. You may include one stretch option outside this range if it's a compelling upgrade, but do not lead with it.
  {%- endif %}
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
  ZERO machines in the Arco catalog have this feature. Follow the "Feature-Specific Query / When ZERO machines match" scenario: open with a `text` block stating this directly, then pivot to the closest-capability machine. Do NOT fabricate the feature on any machine.
  {%- elif featureMatch.matches | length == 1 %}
  EXACTLY ONE machine in the Arco catalog has this feature: **{{ featureMatch.matches[0].name }}** (${{ featureMatch.matches[0].price }}). Follow the "Feature-Specific Query / When exactly ONE machine matches" scenario. Make {{ featureMatch.matches[0].name }} the hero. The comparison-table must mark the requested feature with ✗ in any alternative's column and set `"data": {"recommended": "{{ featureMatch.matches[0].name }}"}`. State plainly in the hero copy that this is the only Arco machine with {{ featureMatch.feature }}.
  {%- else %}
  Machines with this feature: {% for m in featureMatch.matches %}{{ m.name }} (${{ m.price }}){% if not loop.last %}, {% endif %}{% endfor %}. Follow the "Feature-Specific Query / When 2–3 machines match" scenario. The comparison-table must include ONLY these machines — do NOT add a non-matching machine to pad the table.
  {%- endif %}
  {%- endif %}

  {%- if rag.products %}

  ## Recommended Products (from RAG — highest relevance to this query)
  {%- for p in rag.products %}
  - {{ p.name }} ({{ p.id }}) | ${{ p.price }} | {{ (p.bestFor | join(', ')) or 'general' }}
  {%- endfor %}
  {%- endif %}

  {%- if rag.recipes %}

  ## Recipes
  {%- for r in rag.recipes %}
  - "{{ r.name }}" ({{ r.id }})
  {%- endfor %}
  {%- endif %}

  {%- if rag.guides %}

  ## Related Articles (use {% raw %}{{story:SLUG}}{% endraw %} tokens in article-excerpt or blog-card blocks)
  IMPORTANT: Only use slugs that appear exactly in this list. Story SLUGs are the last path segment (e.g. "how-to-dial-in-espresso-in-under-10-minutes").
  {%- for g in rag.guides %}
  - "{{ g.title }}" | slug: {{ g.slug }} | category: {{ g.category or '' }}
  {%- endfor %}
  {%- endif %}

  {%- if rag.experiences %}

  ## Related Experiences (use {% raw %}{{experience:SLUG}}{% endraw %} tokens in experience-cta blocks)
  IMPORTANT: Only use slugs that appear exactly in this list.
  {%- for e in rag.experiences %}
  - "{{ e.title }}" | slug: {{ e.slug }} | archetype: {{ e.experience_archetype or '' }} | anchor: {{ e.anchor_product or '' }}
  {%- endfor %}
  {%- endif %}

  {%- if rag.reviews %}

  ## Reviews (use {% raw %}{{review:ID}}{% endraw %} tokens)
  {%- for r in rag.reviews %}
  - ID: {{ r.id }} | {{ r.author or 'Customer' }}: "{{ r._snippet }}..."
  {%- endfor %}
  {%- endif %}

  {%- if rag.faqs %}

  ## FAQs
  {%- for f in rag.faqs %}
  - Q: {{ f.question }} | A: {{ f._snippet }}...
  {%- endfor %}
  {%- endif %}

  {%- if rag.features %}

  ## Key Features
  {%- for f in rag.features %}
  - {{ f.name }}: {{ f.benefit or f.description or '' }}
  {%- endfor %}
  {%- endif %}

  {%- if rag.comparisons %}

  ## Pre-Authored Comparisons (use as ground truth when available)
  When a pre-authored comparison matches your query, use its verdict and persona recommendations as the basis for your comparison-table rather than inventing new comparisons.
  {%- for c in rag.comparisons %}
  - "{{ c.title }}" | {{ c.slug }} | Verdict: "{{ c._verdictSnippet }}..."
  {%- endfor %}
  {%- endif %}

  {%- if rag.toolContent %}

  ## Relevant Guides & Tools (maintenance, pairing, diagnostics)
  Reference these when the user asks about maintenance, troubleshooting, bean pairing, or equipment compatibility.
  {%- for t in rag.toolContent %}
  - "{{ t.title }}" | {{ t.slug }} | Type: {{ t.type or t.category or '' }}
  {%- endfor %}
  {%- endif %}

  {%- if rag.persona %}

  ## Matched Persona: {{ rag.persona.name }}
  Priorities: {{ (rag.persona.priorities | join(', ')) or '' }}
  Skill level: {{ rag.persona.skillLevel or 'unknown' }}
  Budget: {{ rag.persona.budget or 'unknown' }}
  {%- endif %}

  {%- if rag.useCase %}

  ## Primary Use Case: {{ rag.useCase.name }}
  {{ rag.useCase.description or '' }}
  {%- endif %}

  {%- if intent.type %}

  ## Intent Classification
  Detected intent: **{{ intent.type }}**{% if intent.journeyStage %} | Journey stage: {{ intent.journeyStage }}{% endif %}
  {%- endif %}

  Remember: output JSON blocks separated by ===. All product links must use the URL from the product data. End with information-gathering suggestions (type "explore" or "compare" only). Every block MUST have meaningful content. ONLY use product names, product IDs, and recipe names that appear in the data above — never invent or guess names.
  {%- if not followUp %}

  IMPORTANT: The FIRST suggestion must always be about espresso machines with milk frothing/steaming capabilities, e.g. {% raw %}{"type":"explore","label":"Best for milk drinks?","query":"which Arco machines have the best milk steaming and frothing"}{% endraw %}. Place it as the first item in the suggestions array.
  {%- endif %}
```

**Conventions used in this template:**
- `{% raw %}…{% endraw %}` wraps any literal `{{token}}` references so Nunjucks doesn't try to interpret them.
- Underscore-prefixed fields (`p._boiler`, `r._snippet`, `c._verdictSnippet`) are pre-computed strings on the context object. The renderer adds these so the template stays prose-focused.
- `intent.type` is referenced safely because the loader normalizes `intent` to `{ type: '', journeyStage: '' }` when null.

- [ ] **Step 2: Sanity-check that the file is valid YAML**

```bash
node -e "const yaml=require('yaml');const fs=require('fs');yaml.parse(fs.readFileSync('workers/recommender/prompts/recommender.yaml','utf8'));console.log('OK')"
```
Expected: `OK`. If it errors, the most common cause is unescaped `:` inside an unquoted string — the YAML body lives inside `|` block scalars so this should not happen, but if it does, indent every line of the block by 2 spaces.

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/prompts/recommender.yaml
git commit -m "feat(prompts): add nunjucks-templated recommender YAML"
```

---

### Task 6: Document the context schema

**Files:**
- Create: `workers/recommender/prompts/README.md`

- [ ] **Step 1: Write the schema doc**

Create `workers/recommender/prompts/README.md`:

```markdown
# Recommender prompt templates

YAML + Nunjucks source of truth for the recommender and suggestions LLM prompts. Rendered by `src/prompt-loader.js` from both production code and promptfoo tests.

## Files

- `recommender.yaml` — recommender system + user templates
- `suggestions.yaml` — `/api/suggest` system + user templates
- `partials/brand-voice.njk` — brand voice, included by recommender system prompt
- `partials/block-guide.njk` — EDS block format spec
- `partials/product-catalog.njk` — `{% for p in catalog %}…{% endfor %}`
- `partials/accessories.njk` — accessories loop

## Recommender context schema

Fields the recommender template consumes. Production builds this from request + RAG + intent in `src/recommender-prompt.js`; tests build it from `tests/fixtures/*.json`.

```ts
type RecommenderContext = {
  query: string;
  scenario: 'default' | 'cold-start' | 'cold-start-comparison'
          | 'follow-up' | 'follow-up-cheaper' | 'follow-up-pivot';

  // Pre-enriched catalog data — see "Underscore fields" below
  catalog: EnrichedProduct[];
  accessories: EnrichedAccessory[];

  intent: { type: string; journeyStage?: string };  // never null; loader normalizes
  followUp: {
    type: 'pivot' | 'cheaper_alternative' | 'compare' | 'explore';
    label: string;
    product?: string;
  } | null;

  behavior: {
    coldStart: boolean;
    priceTier?: 'budget' | 'mid' | 'premium';
    skillLevel?: string;
    purchaseReadiness?: string;
    viewedProducts?: string[];
    searchContext?: string[];
    useCasePriorities?: string[];
    catalogPriceRange?: { min: number; max: number };
  };

  featureMatch: { feature: string; matches: Array<{ name; id; price }> } | null;
  history: string | null;             // pre-rendered conversation-history block
  shownProductsLine: string | null;   // pre-rendered describeShownProducts() output

  rag: {
    products?: Array<{ name; id; price; bestFor?: string[] }>;
    recipes?: Array<{ name; id }>;
    guides?: Array<{ title; slug; category? }>;
    experiences?: Array<{ title; slug; experience_archetype?; anchor_product? }>;
    reviews?: Array<{ id; author?; _snippet }>;        // _snippet pre-truncated to 80 chars
    faqs?: Array<{ question; _snippet }>;              // _snippet pre-truncated to 100 chars
    features?: Array<{ name; benefit?; description? }>;
    comparisons?: Array<{ title; slug; _verdictSnippet }>;  // _verdictSnippet pre-truncated to 120
    toolContent?: Array<{ title; slug; type?; category? }>;
    persona?: { name; priorities?: string[]; skillLevel?; budget? };
    useCase?: { name; description? };
  };

  previousQueries?: string[];
  shownBlockTypes?: string[];
};
```

### Underscore fields on enriched products

Catalog rendering used to do conditional spec-flag logic in JS (`if specs.pidControl → "PID"`, etc). To keep the template free of that logic, the loader pre-computes:

- `p._boiler`, `p._group`, `p._pump`, `p._power` — `'?'` fallbacks resolved
- `p._specials` — joined string of PID/Flow Control/etc flags, or empty
- `p._bestFor` — joined `bestFor` or `'general'`
- `p._warranty` — `warranty` or `'N/A'`
- `p._topUses` — joined top-3 use-case scores from `product-profiles.json`, or empty
- `p._heatUp` — `specs.heatUpTime` or `'?'`

Likewise on accessories: `a._description` is the original `description` truncated to 80 chars.

These fields are populated by `enrichCatalogForPrompt(products, profiles)` and `enrichAccessoriesForPrompt(accessories)` in `src/prompt-loader.js`.

## Suggestions context schema

```ts
type SuggestionsContext = {
  count: number;
  userProfile?: {
    journeyStage?: string;
    inferredIntent?: string;
    categories?: string[];
    interests?: string[];
  };
  recentlyViewed?: string[];
  excludeQueries?: string[];
  pageUrl?: string;
  pageTitle?: string;
};
```

## Adding a new fixture

1. Create `tests/fixtures/<scenario>.json` with the full context object.
2. Add the fixture to the snapshot test list in `tests/snapshots/recommender.test.js`.
3. Run `npm test`. The first run creates the snapshot; subsequent runs compare against it.
```

- [ ] **Step 2: Commit**

```bash
git add workers/recommender/prompts/README.md
git commit -m "docs(prompts): document context schema for prompt templates"
```

---

### Task 7: Implement the prompt loader

**Files:**
- Create: `workers/recommender/src/prompt-loader.js`

- [ ] **Step 1: Write the loader skeleton**

Create `workers/recommender/src/prompt-loader.js`:

```js
/**
 * Prompt loader — parses YAML prompt templates and renders them with
 * Nunjucks. Used by:
 *  - production worker code: `renderPrompt(name, ctx)` → { system, user }
 *  - promptfoo tests:        `renderForPromptfoo({ vars })` → OpenAI messages
 *
 * Templates are bundled as text imports (see wrangler.jsonc `rules`) so the
 * worker needs no runtime filesystem. YAML is parsed and Nunjucks templates
 * compiled exactly once at module init.
 */

import nunjucks from 'nunjucks';
import yaml from 'yaml';

/* eslint-disable import/extensions */
import recommenderYaml from '../prompts/recommender.yaml';
import suggestionsYaml from '../prompts/suggestions.yaml';
import brandVoicePartial from '../prompts/partials/brand-voice.njk';
import blockGuidePartial from '../prompts/partials/block-guide.njk';
import productCatalogPartial from '../prompts/partials/product-catalog.njk';
import accessoriesPartial from '../prompts/partials/accessories.njk';
/* eslint-enable import/extensions */

// ── In-memory Nunjucks loader (no filesystem on Workers) ────────────────────
class InMemoryLoader {
  constructor(templates) {
    this.templates = templates; // { 'partials/brand-voice.njk': '...', ... }
  }

  getSource(name) {
    const src = this.templates[name];
    if (src === undefined) {
      throw new Error(`Template not found: ${name}`);
    }
    return { src, path: name, noCache: false };
  }
}

const PARTIALS = {
  'partials/brand-voice.njk': brandVoicePartial,
  'partials/block-guide.njk': blockGuidePartial,
  'partials/product-catalog.njk': productCatalogPartial,
  'partials/accessories.njk': accessoriesPartial,
};

const env = new nunjucks.Environment(new InMemoryLoader(PARTIALS), {
  autoescape: false,
  throwOnUndefined: false,
  trimBlocks: false,
  lstripBlocks: false,
});

// ── Parse YAML + compile templates once ─────────────────────────────────────
function parsePrompt(yamlText) {
  const parsed = yaml.parse(yamlText);
  if (!parsed?.system || !parsed?.user) {
    throw new Error('Prompt YAML missing `system` or `user` key');
  }
  return {
    system: nunjucks.compile(parsed.system, env),
    user: nunjucks.compile(parsed.user, env),
  };
}

const PROMPTS = {
  recommender: parsePrompt(recommenderYaml),
  suggestions: parsePrompt(suggestionsYaml),
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Render a named prompt with the given context object.
 *
 * @param {'recommender'|'suggestions'} name
 * @param {object} ctx — see prompts/README.md for the schema per prompt
 * @returns {{ system: string, user: string }}
 */
export function renderPrompt(name, ctx) {
  const prompt = PROMPTS[name];
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  const safe = normalizeContext(ctx);
  return {
    system: prompt.system.render(safe),
    user: prompt.user.render(safe),
  };
}

/**
 * Defensive defaults — let templates use `intent.type`, `behavior.foo`,
 * `rag.bar` without null checks. Missing optional sections render to empty.
 */
function normalizeContext(ctx) {
  return {
    query: ctx.query || '',
    scenario: ctx.scenario || 'default',
    catalog: ctx.catalog || [],
    accessories: ctx.accessories || [],
    intent: ctx.intent || { type: '', journeyStage: '' },
    followUp: ctx.followUp || null,
    behavior: ctx.behavior || { coldStart: true },
    featureMatch: ctx.featureMatch || null,
    history: ctx.history || '',
    shownProductsLine: ctx.shownProductsLine || '',
    rag: ctx.rag || {},
    previousQueries: ctx.previousQueries || null,
    shownBlockTypes: ctx.shownBlockTypes || null,
    // suggestions fields
    count: ctx.count,
    userProfile: ctx.userProfile,
    recentlyViewed: ctx.recentlyViewed,
    excludeQueries: ctx.excludeQueries,
    pageUrl: ctx.pageUrl,
    pageTitle: ctx.pageTitle,
  };
}

// ── Catalog enrichment helpers ──────────────────────────────────────────────
// Pre-computes underscore fields the catalog/accessories partials consume.

/**
 * @param {Array} products — raw products.json entries
 * @param {Array|object} profiles — product-profiles.json `.data` or `.profiles`
 * @returns enriched products with `_boiler`, `_group`, `_pump`, `_power`,
 *          `_specials`, `_bestFor`, `_warranty`, `_topUses`, `_heatUp`
 */
export function enrichCatalogForPrompt(products, profiles) {
  const profileLookup = Array.isArray(profiles)
    ? new Map(profiles.map((p) => [(p.productId || p.id), p]))
    : new Map(Object.entries(profiles || {}));

  return products.map((p) => {
    const profile = profileLookup.get(p.id);
    const topUsesStr = profile?.scores
      ? Object.entries(profile.scores)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([uc, score]) => `${uc}(${score})`)
          .join(', ')
      : '';

    const specials = [];
    if (p.specs?.pidControl) specials.push('PID');
    if (p.specs?.flowControl) specials.push('Flow Control');
    if (p.specs?.pressureProfiling) specials.push('Pressure Profiling');
    if (p.specs?.plumbedIn) specials.push('Plumb-in');
    if (p.specs?.builtInGrinder) specials.push('Built-in Grinder');
    if (p.specs?.touchscreen) specials.push('Touchscreen');
    if (p.specs?.autoMilk) specials.push('Auto Milk');
    if (p.specs?.programmableDrinks) {
      specials.push(`${p.specs.programmableDrinks} programmable drinks`);
    }

    return {
      ...p,
      _boiler: p.specs?.boilers || '?',
      _group: p.specs?.groupHead || '?',
      _pump: p.specs?.pumpType || '?',
      _power: p.specs?.power || '?',
      _specials: specials.join(', '),
      _bestFor: p.bestFor?.join(', ') || 'general',
      _warranty: p.warranty || 'N/A',
      _topUses: topUsesStr,
      _heatUp: p.specs?.heatUpTime || '?',
    };
  });
}

/**
 * @param {Array} accessories — raw accessories.json entries
 * @returns enriched accessories with `_description` truncated to 80 chars
 */
export function enrichAccessoriesForPrompt(accessories) {
  return (accessories || []).map((a) => ({
    ...a,
    _description: (a.description || '').substring(0, 80),
  }));
}

/**
 * Truncate fields on RAG entries that templates consume as `_snippet` /
 * `_verdictSnippet`. The original JS substringed these at template-build time.
 */
export function enrichRagForPrompt(rag) {
  if (!rag) return {};
  return {
    ...rag,
    reviews: rag.reviews?.map((r) => ({
      ...r,
      _snippet: (r.content || r.body || '').substring(0, 80),
    })),
    faqs: rag.faqs?.map((f) => ({
      ...f,
      _snippet: (f.answer || '').substring(0, 100),
    })),
    comparisons: rag.comparisons?.map((c) => ({
      ...c,
      _verdictSnippet: typeof c.verdict === 'string'
        ? c.verdict.substring(0, 120) : '',
    })),
  };
}

// ── promptfoo adapter ───────────────────────────────────────────────────────

/**
 * promptfoo prompt function — called as
 *   file://workers/recommender/src/prompt-loader.js:renderForPromptfoo
 * promptfoo passes the test's `vars` here. We expect `vars` to be a complete
 * RecommenderContext (or SuggestionsContext if `vars.prompt === 'suggestions'`).
 *
 * If `vars.catalog` / `vars.accessories` are absent, we lazy-load the JSON
 * from the content/ directory so fixtures don't need to inline the catalog.
 */
export async function renderForPromptfoo({ vars = {} } = {}) {
  const promptName = vars.prompt === 'suggestions' ? 'suggestions' : 'recommender';

  let ctx = { ...vars };

  if (promptName === 'recommender' && (!ctx.catalog || !ctx.accessories)) {
    const [products, profiles, accessories] = await Promise.all([
      loadJson('../../../content/products/products.json'),
      loadJson('../../../content/metadata/product-profiles.json'),
      loadJson('../../../content/accessories/accessories.json'),
    ]);
    ctx.catalog = ctx.catalog || enrichCatalogForPrompt(
      products.data || products,
      profiles.data || profiles.profiles || profiles,
    );
    ctx.accessories = ctx.accessories || enrichAccessoriesForPrompt(
      accessories.data || accessories,
    );
  }

  if (promptName === 'recommender' && ctx.rag) {
    ctx.rag = enrichRagForPrompt(ctx.rag);
  }

  const { system, user } = renderPrompt(promptName, ctx);
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function loadJson(relPath) {
  // Node-only dynamic load, used by promptfoo tests (never reached on worker).
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const txt = await readFile(path.resolve(here, relPath), 'utf8');
  return JSON.parse(txt);
}
```

- [ ] **Step 2: Verify the module parses and templates compile**

Run from `workers/recommender/`:
```bash
node --input-type=module -e "import('./src/prompt-loader.js').then(m => console.log('OK', typeof m.renderPrompt))"
```
Expected output: `OK function`. If it errors, the most common causes:
- `nunjucks` ESM import — `nunjucks` is CJS; the named-import shape above works because Node provides interop. If it still fails, use `import nunjucks from 'nunjucks/index.js'` or `const nunjucks = (await import('nunjucks')).default`.
- YAML parse error — open `recommender.yaml`, run the YAML lint snippet from Task 5 Step 2.
- Template compile error from Nunjucks — error message points at the line. Most likely a forgotten `{% raw %}` around literal `{{token}}`.

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/src/prompt-loader.js
git commit -m "feat(recommender): add prompt-loader for YAML+nunjucks rendering"
```

---

### Task 8: Create scenario fixtures

**Files:**
- Create: `workers/recommender/tests/fixtures/cold-start.json`
- Create: `workers/recommender/tests/fixtures/cold-start-comparison.json`
- Create: `workers/recommender/tests/fixtures/default-with-rag.json`
- Create: `workers/recommender/tests/fixtures/follow-up-explore.json`
- Create: `workers/recommender/tests/fixtures/follow-up-pivot.json`
- Create: `workers/recommender/tests/fixtures/follow-up-cheaper.json`
- Create: `workers/recommender/tests/fixtures/feature-match-touchscreen.json`

- [ ] **Step 1: Create the fixtures directory**

```bash
mkdir -p workers/recommender/tests/fixtures
```

**Fixture shape:** raw inputs to `buildRecommenderUserMessage(query, behaviorAnalysis, previousQueries, followUp, shownContent, intent, contextData)`. The snapshot test passes these straight to the public API; baseline capture does the same. `scenario`, `history`, `shownProductsLine`, `featureMatch`, and the enriched catalog are computed internally by the renderer — never put them in fixtures.

- [ ] **Step 2: Write cold-start.json**

```json
{
  "query": "show me all your espresso machines",
  "intent": { "type": "product-discovery" },
  "behavior": { "coldStart": true },
  "previousQueries": [],
  "followUp": null,
  "shownContent": {},
  "contextData": {}
}
```

- [ ] **Step 3: Write cold-start-comparison.json**

```json
{
  "query": "primo vs doppio which is better for a home barista?",
  "intent": { "type": "comparison" },
  "behavior": { "coldStart": true },
  "previousQueries": [],
  "followUp": null,
  "shownContent": {},
  "contextData": {
    "products": [
      { "name": "Primo", "id": "primo", "price": 899, "bestFor": ["home-barista", "espresso", "beginner"] },
      { "name": "Doppio", "id": "doppio", "price": 1599, "bestFor": ["home-barista", "milk-drinks", "espresso"] }
    ]
  }
}
```

- [ ] **Step 4: Write default-with-rag.json**

```json
{
  "query": "I'm an experienced barista who dials in single origin, what should I get?",
  "intent": { "type": "espresso", "journeyStage": "deciding" },
  "behavior": {
    "coldStart": false,
    "priceTier": "premium",
    "skillLevel": "experienced",
    "viewedProducts": ["studio", "studio-pro"],
    "useCasePriorities": ["espresso", "precision"],
    "catalogPriceRange": { "min": 2299, "max": 3499 }
  },
  "previousQueries": ["what grinders do you have"],
  "followUp": null,
  "shownContent": {
    "shownProducts": ["studio", "studio-pro"],
    "shownSections": [{ "blockType": "hero" }, { "blockType": "comparison-table" }]
  },
  "contextData": {
    "products": [
      { "name": "Studio Pro", "id": "studio-pro", "price": 3499, "bestFor": ["home-barista", "espresso", "upgrade"] },
      { "name": "Studio", "id": "studio", "price": 2299, "bestFor": ["home-barista", "espresso", "upgrade"] },
      { "name": "Macinino Pro", "id": "macinino-pro", "price": 799, "bestFor": ["espresso", "home-barista", "precision"] }
    ],
    "features": [
      { "name": "Flow Control", "benefit": "Manual control over extraction pressure mid-shot" }
    ]
  }
}
```

- [ ] **Step 5: Write follow-up-explore.json**

```json
{
  "query": "best for milk drinks?",
  "intent": { "type": "use-case" },
  "behavior": { "coldStart": false, "viewedProducts": ["primo"] },
  "previousQueries": ["what arco machine should I get"],
  "followUp": { "type": "explore", "label": "Best for milk drinks?" },
  "shownContent": {
    "shownProducts": ["primo"],
    "shownSections": [{ "blockType": "hero" }, { "blockType": "comparison-table" }, { "blockType": "columns" }]
  },
  "contextData": {
    "products": [
      { "name": "Doppio", "id": "doppio", "price": 1599, "bestFor": ["home-barista", "milk-drinks"] },
      { "name": "Automatico", "id": "automatico", "price": 1899, "bestFor": ["beginner", "office", "milk-drinks"] }
    ]
  }
}
```

- [ ] **Step 6: Write follow-up-pivot.json**

```json
{
  "query": "tell me more about the doppio",
  "intent": { "type": "product-detail" },
  "behavior": { "coldStart": false, "viewedProducts": ["primo", "doppio"] },
  "previousQueries": ["comparable espresso machines"],
  "followUp": { "type": "pivot", "label": "Tell me more about Doppio", "product": "Doppio" },
  "shownContent": {
    "shownProducts": ["primo", "doppio"],
    "shownSections": [{ "blockType": "hero" }, { "blockType": "comparison-table" }]
  },
  "contextData": {
    "products": [
      { "name": "Doppio", "id": "doppio", "price": 1599, "bestFor": ["home-barista", "milk-drinks", "espresso"] }
    ]
  }
}
```

- [ ] **Step 7: Write follow-up-cheaper.json**

```json
{
  "query": "anything cheaper than the doppio?",
  "intent": { "type": "budget" },
  "behavior": { "coldStart": false, "priceTier": "mid", "viewedProducts": ["doppio"] },
  "previousQueries": ["best espresso machine for home"],
  "followUp": { "type": "cheaper_alternative", "label": "Show me cheaper options", "product": "Doppio" },
  "shownContent": {
    "shownProducts": ["doppio"],
    "shownSections": [{ "blockType": "hero" }, { "blockType": "columns" }, { "blockType": "comparison-table" }]
  },
  "contextData": {
    "products": [
      { "name": "Primo", "id": "primo", "price": 899, "bestFor": ["home-barista", "beginner", "espresso"] },
      { "name": "Nano", "id": "nano", "price": 649, "bestFor": ["beginner", "travel", "espresso"] }
    ]
  }
}
```

- [ ] **Step 8: Write feature-match-touchscreen.json**

The `featureMatch` is computed internally by `detectFeatureRequest(query)` — the query phrase "touchscreen" triggers it. Fixture stays input-only.

```json
{
  "query": "do you have any machines with a touchscreen?",
  "intent": { "type": "espresso" },
  "behavior": { "coldStart": false, "viewedProducts": [] },
  "previousQueries": [],
  "followUp": null,
  "shownContent": {},
  "contextData": {
    "products": [
      { "name": "Automatico", "id": "automatico", "price": 1899, "bestFor": ["beginner", "office", "milk-drinks"] },
      { "name": "Studio Pro", "id": "studio-pro", "price": 3499, "bestFor": ["home-barista", "espresso", "upgrade"] }
    ]
  }
}
```

**Note on the zero-match branch:** the `{% if featureMatch.matches | length == 0 %}` branch in the template is hard to exercise via a natural query — `detectFeatureRequest` returns `null` (not `{matches: []}`) when no FEATURE_MAP phrase matches the query, so the zero-matches case only fires when a known feature phrase appears AND no product has that feature in the live catalog. The Arco catalog as of this refactor has at least one machine per FEATURE_MAP entry, so no scenario triggers this branch in production. We will exercise the branch via a small standalone unit test instead of a snapshot fixture — see Task 10 Step 4b.

- [ ] **Step 10: Commit**

```bash
git add workers/recommender/tests/fixtures/
git commit -m "test(prompts): add scenario fixtures for snapshot tests"
```

---

### Task 9: Capture pre-refactor baseline snapshots

Lock down what the current JS code produces for each fixture context. These baselines are the byte-level target for the new YAML rendering.

**Files:**
- Create: `workers/recommender/tools/capture-baseline.js`
- Create: `workers/recommender/tests/snapshots/__snapshots__/baseline-*.txt` (8 files, generated)

- [ ] **Step 1: Write the baseline-capture script**

Create `workers/recommender/tools/capture-baseline.js`:

```js
#!/usr/bin/env node
/**
 * Capture baseline rendered prompts from the *current* JS-based prompt
 * builders. Run BEFORE refactoring src/recommender-prompt.js. The new
 * YAML-rendered output must match these byte-for-byte (or with tracked
 * whitespace deltas).
 *
 * Usage: node tools/capture-baseline.js
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildRecommenderSystemPrompt,
  buildRecommenderUserMessage,
} from '../src/recommender-prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../tests/fixtures');
const SNAPSHOTS_DIR = path.resolve(HERE, '../tests/snapshots/__snapshots__');

async function main() {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), 'utf8'));
    const name = file.replace(/\.json$/, '');

    const system = buildRecommenderSystemPrompt();
    const user = buildRecommenderUserMessage(
      fx.query,
      fx.behavior,
      fx.previousQueries || [],
      fx.followUp,
      fx.shownContent || {},
      fx.intent,
      fx.rag || {},
    );

    await writeFile(
      path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`),
      system,
    );
    await writeFile(
      path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`),
      user,
    );
    console.log(`captured ${name} (system: ${system.length} chars, user: ${user.length} chars)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the capture**

From `workers/recommender/`:
```bash
node tools/capture-baseline.js
```
Expected: 8 fixtures captured, prints `captured <name> (system: NNN chars, user: NNN chars)` for each.

If any fixture throws (e.g. `Cannot read property 'foo' of undefined`), the fixture is missing a field the current JS code expects. Add the field to the fixture (using `null` or `[]`) and re-run.

- [ ] **Step 3: Verify baselines were created**

```bash
ls workers/recommender/tests/snapshots/__snapshots__/
```
Expected: 16 files (`baseline-<scenario>.system.txt` + `baseline-<scenario>.user.txt` for each of the 8 scenarios).

- [ ] **Step 4: Commit the baselines and the tool**

```bash
git add workers/recommender/tools/capture-baseline.js workers/recommender/tests/snapshots/__snapshots__/
git commit -m "test(prompts): capture pre-refactor baseline snapshots"
```

---

### Task 10: Write the snapshot test (passes immediately — proves the test setup works)

The test goes through the **public API** `buildRecommenderUserMessage` and `buildRecommenderSystemPrompt`. At this stage those still run the legacy JS code (refactor happens in Task 12), so the test compares old-JS output against baselines captured from the same old JS — it should pass on the first run. After Task 12 swaps the internals to the YAML renderer, the test becomes the byte-level regression gate.

**Files:**
- Create: `workers/recommender/tests/snapshots/recommender.test.js`

- [ ] **Step 1: Write the snapshot test**

Create `workers/recommender/tests/snapshots/recommender.test.js`:

```js
/**
 * Snapshot tests — assert buildRecommenderUserMessage / buildRecommenderSystemPrompt
 * produce output byte-identical to the pre-refactor baselines captured by
 * tools/capture-baseline.js. The public API stays stable; whether it routes
 * through the old JS path (today) or the new YAML renderer (after Task 12),
 * this test is the regression gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildRecommenderSystemPrompt,
  buildRecommenderUserMessage,
} from '../../src/recommender-prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../fixtures');
const SNAPSHOTS_DIR = path.resolve(HERE, '__snapshots__');

const fixtures = (await readdir(FIXTURES_DIR))
  .filter((f) => f.endsWith('.json') && !f.startsWith('suggestions-'));

for (const file of fixtures) {
  const name = file.replace(/\.json$/, '');
  test(`recommender snapshot — ${name}`, async () => {
    const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), 'utf8'));

    const system = buildRecommenderSystemPrompt();
    const user = buildRecommenderUserMessage(
      fx.query,
      fx.behavior,
      fx.previousQueries || [],
      fx.followUp,
      fx.shownContent || {},
      fx.intent,
      fx.contextData || {},
    );

    const expectedSystem = await readFile(
      path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`), 'utf8',
    );
    const expectedUser = await readFile(
      path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`), 'utf8',
    );

    assert.equal(system, expectedSystem, `system prompt diverged for ${name}`);
    assert.equal(user, expectedUser, `user prompt diverged for ${name}`);
  });
}
```

- [ ] **Step 2: Add a test script to package.json**

Open `workers/recommender/package.json`. Add to `"scripts"`:

```json
"test": "node --test tests/snapshots/",
"test:capture": "node tools/capture-baseline.js"
```

- [ ] **Step 3: Run the test — it should pass (tautology against the legacy code)**

```bash
npm test
```
Expected: all 7 tests PASS. They are comparing the legacy JS code's output against baselines captured from the same legacy JS code in Task 9, so this is a tautology by construction. If any test fails here, the baseline-capture and the fixture shape have diverged — fix the fixture or re-capture before continuing.

- [ ] **Step 4: Commit**

```bash
git add workers/recommender/tests/snapshots/recommender.test.js workers/recommender/package.json
git commit -m "test(prompts): snapshot tests harness (compares against baseline)"
```

- [ ] **Step 4b: Add a YAML-direct unit test for the featureMatch zero-match branch**

Create `workers/recommender/tests/snapshots/feature-match-zero.test.js`:

```js
/**
 * The featureMatch.matches.length == 0 branch isn't reachable from any natural
 * query against the current catalog (every FEATURE_MAP entry has at least one
 * matching product). This test exercises the template branch directly so we
 * don't regress it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrompt } from '../../src/prompt-loader.js';

test('recommender YAML — featureMatch zero-match branch renders', () => {
  const { user } = renderPrompt('recommender', {
    query: 'hypothetical zero-match query',
    scenario: 'default',
    intent: { type: 'espresso' },
    behavior: { coldStart: true },
    featureMatch: { feature: 'imaginary-feature', matches: [] },
    rag: {},
  });
  assert.match(user, /ZERO machines in the Arco catalog have this feature/);
});
```

- [ ] **Step 5: Run the unit test**

```bash
npm test
```
Expected: 7 snapshot tests + 1 zero-match unit test = 8 passing.

Note: the unit test fails until Task 12's refactor is complete, because before that the renderer isn't wired into the system. If running in strict order, defer Step 4b to after Task 12. Alternative: mark the test `{ skip: true }` initially and unskip after Task 12.

- [ ] **Step 6: Commit the unit test**

```bash
git add workers/recommender/tests/snapshots/feature-match-zero.test.js
git commit -m "test(prompts): direct YAML test for zero-match feature branch"
```

---

### Task 11: Add a render-prompt debug tool

**Files:**
- Create: `workers/recommender/tools/render-prompt.js`

- [ ] **Step 1: Write the tool**

```js
#!/usr/bin/env node
/**
 * Render a fixture to stdout for quick debugging.
 * Usage: node tools/render-prompt.js <fixture-name> [--system|--user]
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  renderPrompt,
  enrichCatalogForPrompt,
  enrichAccessoriesForPrompt,
  enrichRagForPrompt,
} from '../src/prompt-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../tests/fixtures');
const CONTENT_DIR = path.resolve(HERE, '../../../content');

async function main() {
  const [name, which = '--both'] = process.argv.slice(2);
  if (!name) {
    console.error('usage: node tools/render-prompt.js <fixture-name> [--system|--user|--both]');
    process.exit(2);
  }
  const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, `${name}.json`), 'utf8'));
  const [products, profiles, accessories] = await Promise.all([
    readFile(path.join(CONTENT_DIR, 'products/products.json'), 'utf8').then(JSON.parse),
    readFile(path.join(CONTENT_DIR, 'metadata/product-profiles.json'), 'utf8').then(JSON.parse),
    readFile(path.join(CONTENT_DIR, 'accessories/accessories.json'), 'utf8').then(JSON.parse),
  ]);
  const ctx = {
    ...fx,
    catalog: enrichCatalogForPrompt(products.data || products, profiles.data || profiles.profiles || profiles),
    accessories: enrichAccessoriesForPrompt(accessories.data || accessories),
    rag: enrichRagForPrompt(fx.rag || {}),
  };
  const { system, user } = renderPrompt('recommender', ctx);
  if (which === '--system') process.stdout.write(system);
  else if (which === '--user') process.stdout.write(user);
  else process.stdout.write(`===SYSTEM===\n${system}\n===USER===\n${user}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add workers/recommender/tools/render-prompt.js
git commit -m "tools(prompts): add render-prompt debug helper"
```

---

### Task 12: Wire the renderer into production code

**Files:**
- Modify: `workers/recommender/src/recommender-prompt.js`

- [ ] **Step 1: Refactor recommender-prompt.js to call the renderer**

The two exported functions stay (`buildRecommenderSystemPrompt`, `buildRecommenderUserMessage`) so call sites in `pipeline/steps/build-recommender-prompt.js` don't change. Internally they build the context and delegate to `renderPrompt`.

Replace `workers/recommender/src/recommender-prompt.js` body. Keep the JS-only helpers (`describeShownProduct`, `describeShownProducts`, `detectFeatureRequest`, `buildConversationHistory`) — those compute structured inputs. Delete `buildProductCatalog` and `buildAccessoriesList` (moved to partials). Delete the giant template literal in `buildRecommenderSystemPrompt`.

New shape (about 250 lines down from 593):

```js
/* eslint-disable import/extensions, import/no-relative-packages */
import productsData from '../../../content/products/products.json';
import productProfilesData from '../../../content/metadata/product-profiles.json';
import accessoriesData from '../../../content/accessories/accessories.json';
/* eslint-enable import/extensions, import/no-relative-packages */

import {
  renderPrompt,
  enrichCatalogForPrompt,
  enrichAccessoriesForPrompt,
  enrichRagForPrompt,
} from './prompt-loader.js';

const allProducts = productsData.data || [];
const allAccessories = accessoriesData.data || [];
const productsById = new Map(allProducts.map((p) => [p.id, p]));

// Enrich once at module load — catalog doesn't change at runtime.
const ENRICHED_CATALOG = enrichCatalogForPrompt(
  allProducts,
  productProfilesData.data || productProfilesData.profiles || productProfilesData,
);
const ENRICHED_ACCESSORIES = enrichAccessoriesForPrompt(allAccessories);

// ── Helpers preserved from the old file ─────────────────────────────────────

function describeShownProduct(id) {
  // ... copy verbatim from old recommender-prompt.js:37-58 ...
}

function describeShownProducts(ids) {
  return (ids || []).map(describeShownProduct).join('; ');
}

function detectFeatureRequest(query) {
  // ... copy verbatim from old recommender-prompt.js:295-358 ...
  // Returns { feature, matches: [{name, id, price}] } | null
}

function buildConversationHistory(previousQueries, shownContent) {
  // ... copy verbatim from old recommender-prompt.js:368-406 ...
}

// ── Public API — thin shims around renderPrompt ─────────────────────────────

export function buildRecommenderSystemPrompt() {
  // System prompt doesn't depend on per-request context — we still call
  // renderPrompt for consistency. The renderer normalizes missing fields.
  return renderPrompt('recommender', {
    scenario: 'default',
    catalog: ENRICHED_CATALOG,
    accessories: ENRICHED_ACCESSORIES,
  }).system;
}

export function buildRecommenderUserMessage(
  query,
  behaviorAnalysis,
  previousQueries,
  followUp,
  shownContent,
  intent,
  contextData,
) {
  const ba = behaviorAnalysis || { coldStart: true };
  const scenario = pickScenario(ba, followUp, intent);
  const featureMatch = detectFeatureRequest(query);
  const history = followUp ? buildConversationHistory(previousQueries, shownContent) : null;
  const shownProductsLine = shownContent?.shownProducts?.length
    ? describeShownProducts(shownContent.shownProducts)
    : null;
  const shownBlockTypes = shownContent?.shownSections?.length
    ? [...new Set(shownContent.shownSections.map((s) => s.blockType))]
    : null;

  return renderPrompt('recommender', {
    query,
    scenario,
    catalog: ENRICHED_CATALOG,
    accessories: ENRICHED_ACCESSORIES,
    intent: intent || { type: '', journeyStage: '' },
    followUp: followUp || null,
    behavior: ba,
    featureMatch,
    history,
    shownProductsLine,
    rag: enrichRagForPrompt(contextData || {}),
    previousQueries: previousQueries?.length
      ? previousQueries.map((q) => (typeof q === 'string' ? q : q.query || '')).filter(Boolean)
      : null,
    shownBlockTypes,
  }).user;
}

function pickScenario(behavior, followUp, intent) {
  if (followUp?.type === 'pivot' && followUp.product) return 'follow-up-pivot';
  if (followUp?.type === 'cheaper_alternative' && followUp.product) return 'follow-up-cheaper';
  if (followUp) return 'follow-up';
  if (behavior.coldStart && intent?.type === 'comparison') return 'cold-start-comparison';
  if (behavior.coldStart) return 'cold-start';
  return 'default';
}
```

- [ ] **Step 2: Run the snapshot tests — they will likely FAIL on first attempt**

```bash
npm test
```
Expected on first run: most or all 7 snapshot tests FAIL with diffs. The public API now routes through `renderPrompt`, which renders the YAML — so any whitespace, ordering, or branching discrepancy between the YAML template and the legacy JS string-concat code surfaces here. **This is the failing-test state of TDD for the refactor.**

Common failures and fixes:
- **Whitespace differences** around `{% if %}` blocks. Adjust `{%-` / `-%}` whitespace-control markers in `prompts/recommender.yaml`. `{%-` strips whitespace before the tag, `-%}` strips after.
- **Trailing newline differences** between Nunjucks and JS template literals. Tune the closing `{%- endif %}` and `{%- endfor %}` markers.
- **Missing sections** — the YAML branch's condition is too strict, or fields differ between fixture and template expectations.
- **Section ordering** — the legacy JS appends sections in a specific order (behavior → dedup → featureMatch → RAG → intent → footer). The YAML template must match that order exactly.

**Do not edit the baselines.** Edit the YAML, the partials, or the JS context-building until the rendered output matches.

- [ ] **Step 3: Iterate the YAML and the helpers until tests pass**

For each failing test, the assertion error prints the first divergence point. Edit `prompts/recommender.yaml` (or partials, or `recommender-prompt.js` if the context shape is wrong), re-run `npm test`, repeat.

Tips:
- Use `node tools/render-prompt.js <fixture-name>` for fast inspection of a single fixture.
- For whitespace issues, render the user message of one fixture to a temp file and `diff` it against the baseline — that gives precise byte-level locations.
- The biggest risk is the catalog rendering — the JS `buildProductCatalog()` joins per-product blocks with `\n` (no trailing newline); a Nunjucks `{% for %}…{% endfor %}` typically adds a trailing newline. Use `{%- for %}{%- endfor %}` and place the per-iteration newline manually.

End state: all 7 snapshot tests pass.

- [ ] **Step 4: Unskip / verify the zero-match unit test passes**

```bash
npm test
```
Expected: 8 passing total (7 snapshots + 1 zero-match unit test).

- [ ] **Step 5: Commit**

```bash
git add workers/recommender/src/recommender-prompt.js workers/recommender/prompts/
git commit -m "refactor(recommender): route prompt building through YAML renderer"
```

---

### Task 13: Delete the old brand-voice.js and block-guide.js

**Files:**
- Delete: `workers/recommender/src/brand-voice.js`
- Delete: `workers/recommender/src/block-guide.js`

- [ ] **Step 1: Confirm no other importers**

```bash
grep -rn "from.*brand-voice\|from.*block-guide" workers/recommender/src/
```
Expected: no matches. (The `recommender-prompt.js` from Task 12 no longer imports them — its references were replaced by partial includes inside the YAML.)

If anything still imports them, refactor those importers too before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm workers/recommender/src/brand-voice.js workers/recommender/src/block-guide.js
```

- [ ] **Step 3: Re-run tests**

```bash
npm test
```
Expected: still 8 passing.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(recommender): remove legacy brand-voice and block-guide JS modules"
```

---

### Task 14: Verify worker still builds

- [ ] **Step 1: Dry-run wrangler deploy**

From `workers/recommender/`:
```bash
npx wrangler deploy --dry-run --outdir /tmp/wrangler-build-check
```
Expected: build succeeds. Inspect the bundle size — should be larger than before by roughly the nunjucks + yaml size (~250KB) plus the YAML template text (~30KB).

- [ ] **Step 2: Local sanity check via dev server**

From repo root:
```bash
npx -y @adobe/aem-cli up --no-open --forward-browser-logs &
cd workers/recommender && npx wrangler dev &
```
Hit `http://localhost:3000/?q=best+espresso+machines` in a browser. Confirm the page renders normally (the prompt should be byte-equivalent to what shipped pre-refactor).

Stop both with `kill %1 %2`.

- [ ] **Step 3: Commit any wrangler.jsonc tweaks**

If wrangler complained about anything (e.g. the rule glob needed adjusting), fix and commit. Otherwise skip.

---

## Phase 2 — Suggestions YAML

### Task 15: Create the suggestions YAML

**Files:**
- Create: `workers/recommender/prompts/suggestions.yaml`

- [ ] **Step 1: Write the template**

Create `workers/recommender/prompts/suggestions.yaml`:

```yaml
# Suggestions prompt — used by /api/suggest to generate exploration chips.
system: |
  You generate {{ count }} short, distinct exploration prompts for a coffee/espresso brand site. Each prompt is 3–8 words, written as a question or short imperative the user might naturally ask. Output strict JSON: {% raw %}{"suggestions":[{"label":"…","query":"…"}]}{% endraw %}. Do not repeat any string in <exclude>. Tailor to the user profile and recently viewed items if provided.

user: |
  <pageContext>{"url":{{ (pageUrl or '') | dump }},"title":{{ (pageTitle or '') | dump }}}</pageContext>
  <profile>{"journeyStage":{{ (userProfile.journeyStage or '') | dump }},"intent":{{ (userProfile.inferredIntent or '') | dump }},"categories":{{ (userProfile.categories or []) | dump }},"interests":{{ (userProfile.interests or []) | dump }}}</profile>
  <recentlyViewed>{{ (recentlyViewed or []) | dump }}</recentlyViewed>
  <exclude>{{ (excludeQueries or []) | dump }}</exclude>
```

**Critical:** the JSON encoding of values must match `JSON.stringify` exactly so the baseline diff is byte-equal. The current JS at `suggest.js:74-79` calls `JSON.stringify(...)` on every value (URL, title, journeyStage, intent, arrays). The Nunjucks `dump` filter is the equivalent — it produces `"foo"` for strings (including escaping quotes/newlines) and `[]` / `["a","b"]` for arrays. The `or 'default'` fallbacks **must come before** the `| dump` pipe so the default value is what gets JSON-encoded, not a `dump`-encoded `undefined`.

- [ ] **Step 2: Commit**

```bash
git add workers/recommender/prompts/suggestions.yaml
git commit -m "feat(prompts): add suggestions YAML template"
```

---

### Task 16: Add suggestions fixtures

**Files:**
- Create: `workers/recommender/tests/fixtures/suggestions-cold.json`
- Create: `workers/recommender/tests/fixtures/suggestions-with-profile.json`

- [ ] **Step 1: Write suggestions-cold.json**

```json
{
  "prompt": "suggestions",
  "count": 3,
  "pageUrl": "https://arco.coffee/",
  "pageTitle": "Arco — Italian Precision Espresso",
  "userProfile": {},
  "recentlyViewed": [],
  "excludeQueries": []
}
```

- [ ] **Step 2: Write suggestions-with-profile.json**

```json
{
  "prompt": "suggestions",
  "count": 3,
  "pageUrl": "https://arco.coffee/products/espresso-machines/primo",
  "pageTitle": "Primo — Arco",
  "userProfile": {
    "journeyStage": "comparing",
    "inferredIntent": "product-detail",
    "categories": ["espresso-machines"],
    "interests": ["beginner", "milk-drinks"]
  },
  "recentlyViewed": ["primo", "doppio"],
  "excludeQueries": ["best espresso machines"]
}
```

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/tests/fixtures/suggestions-*.json
git commit -m "test(prompts): add suggestions fixtures"
```

---

### Task 17: Capture suggestions baseline

**Files:**
- Modify: `workers/recommender/tools/capture-baseline.js` (extend to handle suggestions)
- Create: `workers/recommender/tests/snapshots/__snapshots__/baseline-suggestions-*.txt`

- [ ] **Step 1: Extend capture-baseline.js**

Open `workers/recommender/tools/capture-baseline.js`. After the existing main loop, before `main()` is exported, add a suggestions branch. The current `suggest.js` doesn't export its prompt builders — extract them inline.

Replace the body of `main()` with logic that handles both prompt types based on the fixture's `prompt` field:

```js
// (replacement for the existing main() loop)
async function main() {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), 'utf8'));
    const name = file.replace(/\.json$/, '');

    if (fx.prompt === 'suggestions') {
      const system = `You generate ${fx.count} short, distinct exploration prompts for a coffee/espresso brand site. Each prompt is 3–8 words, written as a question or short imperative the user might naturally ask. Output strict JSON: {"suggestions":[{"label":"…","query":"…"}]}. Do not repeat any string in <exclude>. Tailor to the user profile and recently viewed items if provided.`;

      const profile = fx.userProfile || {};
      const user = [
        `<pageContext>{"url":${JSON.stringify(fx.pageUrl || '')},"title":${JSON.stringify(fx.pageTitle || '')}}</pageContext>`,
        `<profile>{"journeyStage":${JSON.stringify(profile.journeyStage || '')},"intent":${JSON.stringify(profile.inferredIntent || '')},"categories":${JSON.stringify(profile.categories || [])},"interests":${JSON.stringify(profile.interests || [])}}</profile>`,
        `<recentlyViewed>${JSON.stringify(fx.recentlyViewed || [])}</recentlyViewed>`,
        `<exclude>${JSON.stringify(fx.excludeQueries || [])}</exclude>`,
      ].join('\n');

      await writeFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`), system);
      await writeFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`), user);
      console.log(`captured ${name} (suggestions)`);
      continue;
    }

    // Recommender path (existing)
    const system = buildRecommenderSystemPrompt();
    const user = buildRecommenderUserMessage(
      fx.query, fx.behavior, fx.previousQueries || [], fx.followUp,
      fx.shownContent || {}, fx.intent, fx.rag || {},
    );
    await writeFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`), system);
    await writeFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`), user);
    console.log(`captured ${name} (recommender)`);
  }
}
```

The verbatim strings mirror `suggest.js:22-28` (SYSTEM_PROMPT) and `suggest.js:74-79` (buildUserPrompt).

- [ ] **Step 2: Run capture**

```bash
node tools/capture-baseline.js
```
Expected: 2 new baselines printed (`captured suggestions-cold (suggestions)` etc).

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/tools/capture-baseline.js workers/recommender/tests/snapshots/__snapshots__/baseline-suggestions-*
git commit -m "test(prompts): capture suggestions baselines"
```

---

### Task 18: Write the suggestions snapshot test and iterate the YAML

**Files:**
- Create: `workers/recommender/tests/snapshots/suggestions.test.js`

- [ ] **Step 1: Write the test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderPrompt } from '../../src/prompt-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../fixtures');
const SNAPSHOTS_DIR = path.resolve(HERE, '__snapshots__');

const fixtures = (await readdir(FIXTURES_DIR))
  .filter((f) => f.startsWith('suggestions-') && f.endsWith('.json'));

for (const file of fixtures) {
  const name = file.replace(/\.json$/, '');
  test(`suggestions snapshot — ${name}`, async () => {
    const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), 'utf8'));
    const { system, user } = renderPrompt('suggestions', fx);
    const expectedSystem = await readFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`), 'utf8');
    const expectedUser = await readFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`), 'utf8');
    assert.equal(system, expectedSystem, `suggestions system diverged for ${name}`);
    assert.equal(user, expectedUser, `suggestions user diverged for ${name}`);
  });
}
```

- [ ] **Step 2: Run tests, iterate YAML until passing**

```bash
npm test
```
Expected initially: suggestions tests fail. Iterate `prompts/suggestions.yaml` until they pass.

Likely tweaks:
- `(userProfile.categories | dump)` returns `[]` when categories is missing/empty, but the baseline always emits `[]` for missing — confirm parity.
- The Nunjucks `dump` filter is JSON-equivalent to `JSON.stringify` for arrays. For strings: `JSON.stringify("foo") === '"foo"'` and `dump('foo') === '"foo"'` — should match.

End state: all `npm test` passes (8 recommender + 2 suggestions = 10).

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/tests/snapshots/suggestions.test.js workers/recommender/prompts/suggestions.yaml
git commit -m "test(suggestions): snapshot tests pass against baseline"
```

---

### Task 19: Wire the renderer into suggest.js

**Files:**
- Modify: `workers/recommender/src/suggest.js`

- [ ] **Step 1: Replace SYSTEM_PROMPT and buildUserPrompt with renderPrompt**

In `workers/recommender/src/suggest.js`:

Delete:
```js
const SYSTEM_PROMPT = (count) => (
  `You generate ${count} short, distinct exploration prompts for a coffee/espresso brand site. `
  + ...
);
```

Delete the `buildUserPrompt` function (lines 65-80).

Add the import at the top:
```js
import { renderPrompt } from './prompt-loader.js';
```

Replace the `messages:` block in `handleSuggestRequest` (around line 248):

```js
// before:
//   messages: [
//     { role: 'system', content: SYSTEM_PROMPT(count) },
//     { role: 'user', content: buildUserPrompt(body) },
//   ],
const profile = body?.context?.inferredProfile || {};
const { system, user } = renderPrompt('suggestions', {
  count,
  pageUrl: body.pageUrl || '',
  pageTitle: body.pageTitle || '',
  userProfile: {
    journeyStage: profile.journeyStage,
    inferredIntent: profile.inferredIntent,
    categories: (profile.categoriesViewed || []).slice(0, 5),
    interests: (profile.interests || []).slice(0, 5),
  },
  recentlyViewed: (profile.productsViewed || []).slice(-5),
  excludeQueries: body.excludeQueries || [],
});

// then in the provider call:
//   messages: [
//     { role: 'system', content: system },
//     { role: 'user', content: user },
//   ],
```

- [ ] **Step 2: Verify the request flow still works**

Start the worker locally:
```bash
npx wrangler dev
```
In another terminal:
```bash
curl -X POST http://localhost:8787/api/suggest \
  -H 'Content-Type: application/json' \
  -d '{"count":3,"pageUrl":"/","context":{"inferredProfile":{"journeyStage":"exploring"}},"excludeQueries":[]}'
```
Expected: JSON response with up to 3 suggestion objects. (LLM may produce different content than before; we don't assert content — only that the request path works.)

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/src/suggest.js
git commit -m "refactor(suggest): route prompt building through YAML renderer"
```

---

## Phase 3 — promptfoo benchmark inside arco

### Task 20: Add promptfoo dev dependency and scripts

**Files:**
- Modify: `workers/recommender/package.json`

- [ ] **Step 1: Install promptfoo**

```bash
cd workers/recommender && npm install --save-dev promptfoo@^0.121.11
```

- [ ] **Step 2: Add bench scripts**

Edit `workers/recommender/package.json`'s `"scripts"` block to add:

```json
"bench:recommender":  "promptfoo eval -c tests/promptfoo/recommender-bench.yaml --max-concurrency 5",
"bench:suggestions":  "promptfoo eval -c tests/promptfoo/suggestions-bench.yaml --max-concurrency 5",
"bench:smoke":        "promptfoo eval -c tests/promptfoo/recommender-bench.yaml --filter-pattern 'cold-start' --max-concurrency 3 --no-cache",
"bench:view":         "promptfoo view"
```

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/package.json workers/recommender/package-lock.json
git commit -m "chore(recommender): add promptfoo dev dep + bench scripts"
```

---

### Task 21: Create the recommender benchmark config

**Files:**
- Create: `workers/recommender/tests/promptfoo/recommender-bench.yaml`

- [ ] **Step 1: Write the config**

Lift the structure from `aem-growth-arco-benchmark/recommender.yaml` but point `prompts:` at our renderer:

```yaml
description: "Arco recommender (in-repo) — multi-model benchmark"

prompts:
  - id: recommender
    file: file://../../src/prompt-loader.js:renderForPromptfoo

providers:
  # Copy the full provider list from
  # aem-growth-arco-benchmark/recommender.yaml verbatim — Vertex (Gemini,
  # Llama, Gemma, Mistral), Cerebras, Cloudflare, Bedrock. Same `id`, `label`,
  # `config` for each.

defaultTest:
  options:
    # Strip <think>...</think> and code fences (same as benchmark repo).
    transform: '(output=>{const s=typeof output==="string"?output:output?.content??JSON.stringify(output);return s.replace(/<think>[\s\S]*?<\/think>/g,"").replace(/^```(?:json)?\s*/m,"").replace(/\s*```\s*$/m,"").trim()})(output)'
  assert:
    # Tier 1-3 deterministic assertions — copy verbatim from
    # aem-growth-arco-benchmark/recommender.yaml `defaultTest.assert`.

tests:
  - description: "cold-start: new visitor, no history"
    threshold: 0.7
    vars:
      prompt: recommender
      scenario: cold-start
      query: "show me all your espresso machines"
      intent: { type: product-discovery }
      behavior: { coldStart: true }
      rag: {}
      followUp: null
      featureMatch: null
    assert:
      - type: javascript
        description: "cold start uses hero-image:main"
        value: "output.split('===')[0].includes('hero-image:main')"
        weight: 2

  - description: "beginner: switching from Nespresso"
    threshold: 0.7
    vars:
      prompt: recommender
      scenario: cold-start
      query: "switching from Nespresso, what Arco machine should I get?"
      intent: { type: beginner }
      behavior: { coldStart: true }
      rag:
        products:
          - { name: Primo, id: primo, price: 899, bestFor: [home-barista, beginner, espresso] }
          - { name: Nano, id: nano, price: 649, bestFor: [beginner, travel, espresso] }
          - { name: Automatico, id: automatico, price: 1899, bestFor: [beginner, office, milk-drinks] }
    assert:
      - type: javascript
        value: "/(primo|nano|automatico)/i.test(output)"
        weight: 2

  # ... add one test per scenario from aem-growth-arco-benchmark/recommender.yaml
  # `tests:` — translating each `scenario_prefix` + `rag_*` block into the
  # structured `vars:` shape above. Use `scenario: 'default'` for the cases
  # that aren't cold-start or follow-up.
  #
  # Add additional tests not in the benchmark repo:
  # - feature-match-touchscreen (verifies the feature-match path)
  # - feature-match-zero        (verifies the "no machine matches" path)
  # - follow-up-cheaper         (verifies the follow-up-cheaper scenario branch)
  # - follow-up-pivot           (verifies the follow-up-pivot scenario branch)
```

- [ ] **Step 2: Sanity-check that promptfoo accepts the config**

From `workers/recommender/`:
```bash
npx promptfoo eval -c tests/promptfoo/recommender-bench.yaml --dry-run --max-concurrency 1
```
Expected: prints the resolved test matrix without actually calling LLMs. If it errors on the `prompts:` file reference, double-check the path is relative to the YAML file's location.

- [ ] **Step 3: Smoke-run one model on one test**

```bash
npx promptfoo eval -c tests/promptfoo/recommender-bench.yaml \
  --filter-providers bedrock \
  --filter-pattern 'cold-start' \
  --max-concurrency 1 --no-cache
```
Expected: one cell runs (cold-start × first matching bedrock model). Output is a JSON-blocks page. Assertions print pass/fail.

If the call fails with an auth error, ensure `AWS_BEARER_TOKEN_BEDROCK` or the appropriate env var is set, then re-run. The required env vars per provider match what the benchmark repo expects.

- [ ] **Step 4: Commit**

```bash
git add workers/recommender/tests/promptfoo/recommender-bench.yaml
git commit -m "test(prompts): add promptfoo recommender benchmark config"
```

---

### Task 22: Create the suggestions benchmark config

**Files:**
- Create: `workers/recommender/tests/promptfoo/suggestions-bench.yaml`

- [ ] **Step 1: Write the config**

```yaml
description: "Arco suggestions — multi-model benchmark"

prompts:
  - id: suggestions
    file: file://../../src/prompt-loader.js:renderForPromptfoo

providers:
  # Smaller, faster models — suggestions are short and cheap.
  - id: openai:chat:llama3.1-8b
    label: cerebras/llama-3.1-8b
    config:
      apiBaseUrl: https://api.cerebras.ai/v1
      apiKeyEnvar: CEREBRAS_API_KEY
      max_tokens: 256

  - id: "openai:chat:@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    label: cloudflare/llama-3.3-70b
    config:
      apiBaseUrl: "https://api.cloudflare.com/client/v4/accounts/{{env.CLOUDFLARE_ACCOUNT_ID}}/ai/v1"
      apiKeyEnvar: CLOUDFLARE_API_TOKEN
      max_tokens: 256

  - id: bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0
    label: bedrock/claude-haiku-4.5
    config:
      region: us-east-1
      max_tokens: 256

defaultTest:
  assert:
    - type: is-json
      weight: 3
    - type: javascript
      description: "has a `suggestions` array"
      value: '(() => { try { const j = JSON.parse(output); return Array.isArray(j.suggestions); } catch { return false; } })()'
      weight: 3
    - type: javascript
      description: "each suggestion has label and query"
      value: '(() => { try { const j = JSON.parse(output); return j.suggestions.every(s => s.label && s.query); } catch { return false; } })()'
      weight: 2

tests:
  - description: "cold homepage — no profile"
    threshold: 0.7
    vars:
      prompt: suggestions
      count: 3
      pageUrl: "https://arco.coffee/"
      pageTitle: "Arco — Italian Precision Espresso"
      userProfile: {}
      recentlyViewed: []
      excludeQueries: []

  - description: "product page — profile present"
    threshold: 0.7
    vars:
      prompt: suggestions
      count: 3
      pageUrl: "https://arco.coffee/products/espresso-machines/primo"
      pageTitle: "Primo — Arco"
      userProfile:
        journeyStage: comparing
        inferredIntent: product-detail
        categories: [espresso-machines]
        interests: [beginner, milk-drinks]
      recentlyViewed: [primo, doppio]
      excludeQueries: ["best espresso machines"]
```

- [ ] **Step 2: Smoke-run**

```bash
npx promptfoo eval -c tests/promptfoo/suggestions-bench.yaml --filter-providers bedrock --max-concurrency 1 --no-cache
```
Expected: both tests run, assertions pass.

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/tests/promptfoo/suggestions-bench.yaml
git commit -m "test(prompts): add promptfoo suggestions benchmark config"
```

---

### Task 23: Document how to run the benchmarks

**Files:**
- Create: `workers/recommender/tests/promptfoo/README.md`

- [ ] **Step 1: Write the README**

```markdown
# Promptfoo benchmarks

Multi-model benchmarks for the recommender and suggestions prompts, using the same YAML+Nunjucks templates production uses.

## Quick start

```bash
# From workers/recommender/
npm run bench:smoke           # one model, one query — sanity check
npm run bench:recommender     # full matrix
npm run bench:suggestions     # suggestions only
npm run bench:view            # open the results UI
```

## Environment variables

Promptfoo reads provider credentials from environment variables. Set whatever you have access to in `workers/recommender/.env`:

```bash
# Cerebras
CEREBRAS_API_KEY=

# Cloudflare Workers AI
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=

# Vertex AI (for Gemini, Llama-on-Vertex, Gemma, Mistral)
VERTEX_PROJECT_ID=
GCLOUD_TOKEN=$(gcloud auth print-access-token)

# AWS Bedrock
AWS_BEARER_TOKEN_BEDROCK=
# or AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
```

The benchmark only runs providers it can authenticate. Missing creds for one provider don't block runs against the others.

## Adding a new test

1. Add a fixture to `../fixtures/<scenario>.json` for snapshot coverage.
2. Translate the same context into a `tests:` entry in `recommender-bench.yaml`:
   - `vars.scenario`, `vars.query`, `vars.intent`, `vars.behavior`, `vars.rag` — the structured shape consumed by `renderForPromptfoo`.
3. Add scenario-specific assertions (Tier 4+) below the inherited `defaultTest.assert` block.
4. Smoke-run: `npm run bench:smoke -- --filter-pattern '<your-test-description>'`.

## Adding a new provider

Append a new entry to `recommender-bench.yaml` `providers:`. Follow the existing patterns — pick from:
- `vertex:<model>` — Vertex AI
- `openai:chat:<model>` with `apiBaseUrl` — any OpenAI-compatible endpoint (Cerebras, Cloudflare, SambaNova, vLLM, etc.)
- `bedrock:<model-id>` — AWS Bedrock

## Caching

Promptfoo caches LLM responses by default. Add `--no-cache` to force fresh calls (e.g. after changing the prompt). The cache lives in `~/.promptfoo/cache/`.
```

- [ ] **Step 2: Commit**

```bash
git add workers/recommender/tests/promptfoo/README.md
git commit -m "docs(prompts): add promptfoo benchmark README"
```

---

## Final verification

### Task 24: Full sweep before declaring done

- [ ] **Step 1: Snapshot tests green**

```bash
cd workers/recommender && npm test
```
Expected: 10 passing (7 recommender snapshots + 1 zero-match unit test + 2 suggestions snapshots).

- [ ] **Step 2: Worker builds clean**

```bash
npx wrangler deploy --dry-run --outdir /tmp/wrangler-build-check
```
Expected: no errors. Note the bundle size; record it in the PR description as a baseline for future work.

- [ ] **Step 3: Smoke-bench passes**

```bash
npm run bench:smoke
```
Expected: at least one provider × cold-start passes its assertions.

- [ ] **Step 4: Local dev server serves a /?q= page correctly**

From repo root:
```bash
npx -y @adobe/aem-cli up --no-open --forward-browser-logs &
cd workers/recommender && npx wrangler dev --port 8788 &
```
Open `http://localhost:3000/?q=primo+vs+doppio` and confirm a normal recommender page renders. Stop both servers.

- [ ] **Step 5: Final commit / branch state check**

```bash
git status
git log --oneline main..HEAD
```
Expected: clean working tree, ~20 commits matching the task structure.

- [ ] **Step 6: Open the PR**

Follow the project's `Publishing Process` (see `AGENTS.md`). Include in the PR description:
- Link to the spec: `docs/superpowers/specs/2026-05-21-recommender-prompt-yaml-refactor-design.md`
- Link to a `/?q=primo+vs+doppio` feature preview URL once AEM Code Sync has built the branch
- Bundle-size delta (from `wrangler --dry-run` output before and after)
- Snapshot tests: 10/10 passing
- A note that the eval-suite-mirror (Phase 4 from the spec) is a follow-up
