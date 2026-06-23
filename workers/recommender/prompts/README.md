# Recommender prompt templates

YAML + Nunjucks source of truth for the recommender and suggestions LLM prompts. Rendered by `src/prompt-loader.js` from both production code and promptfoo tests.

## Files

- `recommender.yaml` — recommender system + user templates
- `suggestions.yaml` — `/api/suggest` system + user templates (added in Task 15)
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
