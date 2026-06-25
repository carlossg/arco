/**
 * Node-friendly prompt loader — same public API as prompt-loader.js but loads
 * YAML/NJK templates via fs.readFileSync instead of bundler text imports.
 *
 * Used by promptfoo and any other Node tooling that can't go through wrangler's
 * bundling pipeline. The production Cloudflare Worker uses prompt-loader.js,
 * which relies on wrangler's `Text` rule for static imports.
 *
 * Both modules share the same YAML/NJK source files in prompts/ — single
 * source of truth.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import nunjucks from 'nunjucks';
import yaml from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(HERE, '../prompts');

function readTpl(rel) {
  return readFileSync(path.join(PROMPTS_DIR, rel), 'utf8');
}

const PARTIALS = {
  'partials/brand-voice.njk': readTpl('partials/brand-voice.njk'),
  'partials/block-guide.njk': readTpl('partials/block-guide.njk'),
  'partials/product-catalog.njk': readTpl('partials/product-catalog.njk'),
  'partials/accessories.njk': readTpl('partials/accessories.njk'),
};

// ── In-memory Nunjucks loader (mirrors prompt-loader.js) ────────────────────
class InMemoryLoader {
  constructor(templates) {
    this.templates = templates;
  }

  getSource(name) {
    const src = this.templates[name];
    if (src === undefined) {
      throw new Error(`Template not found: ${name}`);
    }
    return { src, path: name, noCache: false };
  }
}

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
  recommender: parsePrompt(readTpl('recommender.yaml')),
  suggestions: parsePrompt(readTpl('suggestions.yaml')),
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
    // suggestions fields (used after Task 18)
    count: ctx.count,
    userProfile: ctx.userProfile,
    recentlyViewed: ctx.recentlyViewed,
    excludeQueries: ctx.excludeQueries,
    pageUrl: ctx.pageUrl,
    pageTitle: ctx.pageTitle,
  };
}

// ── Catalog enrichment helpers ──────────────────────────────────────────────
// These pre-compute underscore fields the catalog/accessories partials consume.
// Logic mirrors prompt-loader.js exactly — single source of truth is the
// prompts/ directory, not the implementation here.

/**
 * Adds underscore fields to each product:
 *   _boiler, _group, _pump, _power, _specials, _bestFor, _warranty, _topUses, _heatUp
 *
 * @param {Array} products — raw products.json entries
 * @param {Array|object} profiles — product-profiles.json `.data` or `.profiles`
 * @returns {Array} enriched products
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
 * Adds `_description` (original `description` truncated to 80 chars) to each
 * accessory.
 *
 * @param {Array} accessories — raw accessories.json entries
 * @returns {Array} enriched accessories
 */
export function enrichAccessoriesForPrompt(accessories) {
  return (accessories || []).map((a) => ({
    ...a,
    _description: (a.description || '').substring(0, 80),
  }));
}

/**
 * Truncate fields on RAG entries that templates consume as `_snippet` /
 * `_verdictSnippet`.
 *
 * @param {object} rag
 * @returns {object} enriched rag (shallow clone)
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
 * Escape `{{...}}` token strings in rendered prompt content so that promptfoo's
 * own Nunjucks pass does not try to interpolate them as template variables.
 *
 * promptfoo runs a second Nunjucks pass over the messages returned by a JS
 * prompt function (via `renderVarsInObject`). Our rendered output contains
 * literal image/content tokens like `{{story:primo}}`, `{{product-image:doppio}}`,
 * etc. that the downstream `images.js` post-processor resolves — they are NOT
 * Nunjucks variables. Without escaping, promptfoo's Nunjucks pass errors with
 * "expected variable end" because those tokens contain colons and other chars
 * that are invalid in Nunjucks variable names.
 *
 * The escape `{{ '{{' }}` is valid Nunjucks and evaluates back to the literal
 * string `{{`, so the LLM receives exactly the original token strings.
 *
 * @param {string} s — rendered prompt text
 * @returns {string} text safe to pass through a Nunjucks renderString call
 */
function escapeNunjucksTokens(s) {
  // Single-pass replacement is essential: the two target substrings (`{{` and `}}`)
  // can appear inside each other's replacements, so two sequential replaces corrupt
  // the output.  A single combined regex avoids the interference.
  return s.replace(/\{\{|\}\}/g, (m) => (m === '{{' ? "{{ '{{' }}" : "{{ '}}' }}"));
}

/**
 * promptfoo prompt function — called as
 *   file://workers/recommender/src/prompt-loader-node.js:renderForPromptfoo
 * promptfoo passes the test's `vars` here. We expect `vars` to be a complete
 * RecommenderContext (or SuggestionsContext if `vars.prompt === 'suggestions'`).
 *
 * If `vars.catalog` / `vars.accessories` are absent, we lazy-load the JSON
 * from the content/ directory so fixtures don't need to inline the catalog.
 */
export async function renderForPromptfoo({ vars = {} } = {}) {
  const promptName = vars.prompt === 'suggestions' ? 'suggestions' : 'recommender';

  const ctx = { ...vars };

  if (promptName === 'recommender' && (!ctx.catalog || !ctx.accessories)) {
    const CONTENT_DIR = path.resolve(HERE, '../../../content');
    const products = JSON.parse(readFileSync(path.join(CONTENT_DIR, 'products/products.json'), 'utf8'));
    const profiles = JSON.parse(readFileSync(path.join(CONTENT_DIR, 'metadata/product-profiles.json'), 'utf8'));
    const accessories = JSON.parse(readFileSync(path.join(CONTENT_DIR, 'accessories/accessories.json'), 'utf8'));
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
    { role: 'system', content: escapeNunjucksTokens(system) },
    { role: 'user', content: escapeNunjucksTokens(user) },
  ];
}
