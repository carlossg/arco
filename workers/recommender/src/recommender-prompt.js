/**
 * Recommender Pipeline Prompts — consultative coffee equipment advisor
 * system and user prompts.
 *
 * Key characteristics:
 * - Acts as a knowledgeable coffee equipment advisor
 * - ALWAYS generates comparison-table blocks
 * - NEVER generates "buy" suggestion types — only "explore" and "compare"
 * - All product links use the URL from product data (e.g., /products/espresso-machines/primo)
 * - Suggestion buttons gather information, not push sales
 */

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

// ── Helpers preserved from the legacy file ──────────────────────────────────

/**
 * Summarize a product ID with the hardware facts that drive follow-up
 * reasoning: whether it includes a grinder, milk frother, touchscreen, its
 * boiler type, price, and category. The LLM uses this when answering
 * "do I need a grinder?", "does it do milk?", etc. in follow-up turns — so
 * it responds in context instead of answering generically.
 *
 * @param {string} id Product ID (slug, e.g. "automatico")
 * @returns {string} compact "Name ($price, boiler, extras)" line, or the raw id
 *   when the product is not in the catalog
 */
function describeShownProduct(id) {
  const p = productsById.get(id);
  if (!p) return id;
  const s = p.specs || {};
  const tags = [];
  if (s.builtInGrinder) tags.push('built-in grinder — no separate grinder needed');
  if (s.autoMilk) tags.push('auto milk frother');
  if (s.touchscreen) tags.push('touchscreen');
  if (s.manual) tags.push('manual lever, no electricity');
  if (s.plumbedIn) tags.push('plumb-in capable');
  if (s.flowControl) tags.push('flow control');
  if (s.pressureProfiling) tags.push('pressure profiling');
  if (s.singleDose) tags.push('single-dose');
  if (s.stepless) tags.push('stepless grind');
  const boiler = s.boilers && s.boilers !== 'None (manual)' ? `${s.boilers} boiler` : '';
  const parts = [`$${p.price}`, p.category, boiler].filter(Boolean);
  const suffix = tags.length ? ` — ${tags.join(', ')}` : '';
  return `${p.name} (${parts.join(', ')}${suffix})`;
}

/**
 * Join a list of product IDs as enriched descriptions so follow-up turns
 * can reason about the specific hardware already in front of the user.
 */
function describeShownProducts(ids) {
  return (ids || []).map(describeShownProduct).join('; ');
}

/**
 * Detect hardware feature requests in the query and return the matching
 * machines from the product catalog. Surfaced to the LLM so it grounds its
 * recommendation in the actual matching set rather than padding with
 * non-matching products.
 *
 * @param {string} query
 * @returns {{feature: string, matches: Array<{name: string, id: string, price: number}>} | null}
 */
function detectFeatureRequest(query) {
  const q = (query || '').toLowerCase();

  const FEATURE_MAP = [
    {
      label: 'touchscreen',
      phrases: ['touchscreen', 'touch screen', 'touch-screen', 'touch display'],
      predicate: (p) => p.specs?.touchscreen === true,
    },
    {
      label: 'auto milk frother',
      phrases: ['auto milk', 'automatic milk', 'auto frother', 'milk frother', 'one-touch milk', 'automatic frothing'],
      predicate: (p) => p.specs?.autoMilk === true,
    },
    {
      label: 'built-in grinder',
      phrases: ['built-in grinder', 'built in grinder', 'integrated grinder', 'machine with grinder', 'all-in-one'],
      predicate: (p) => p.specs?.builtInGrinder === true,
    },
    {
      label: 'dual boiler',
      phrases: ['dual boiler', 'double boiler', 'two boilers'],
      predicate: (p) => /^dual/i.test(p.specs?.boilers || ''),
    },
    {
      label: 'triple boiler',
      phrases: ['triple boiler', 'three boilers'],
      predicate: (p) => /^triple/i.test(p.specs?.boilers || ''),
    },
    {
      label: 'flow control',
      phrases: ['flow control', 'flow profiling', 'flow paddle'],
      predicate: (p) => p.specs?.flowControl === true,
    },
    {
      label: 'pressure profiling',
      phrases: ['pressure profiling', 'pressure profile', 'pressure curve'],
      predicate: (p) => p.specs?.pressureProfiling === true,
    },
    {
      label: 'plumb-in',
      phrases: ['plumb-in', 'plumb in', 'plumbed-in', 'plumbed in', 'direct water line', 'water line'],
      predicate: (p) => p.specs?.plumbedIn === true,
    },
    {
      label: 'manual lever',
      phrases: ['manual lever', 'lever machine', 'hand lever', 'no electricity'],
      predicate: (p) => p.specs?.manual === true,
    },
    {
      label: 'rotary pump',
      phrases: ['rotary pump', 'quiet pump'],
      predicate: (p) => /rotary/i.test(p.specs?.pumpType || ''),
    },
  ];

  const hit = FEATURE_MAP.find(({ phrases }) => phrases.some((phrase) => q.includes(phrase)));
  if (!hit) return null;
  const matches = allProducts
    .filter(hit.predicate)
    .map((p) => ({ name: p.name, id: p.id, price: p.price }));
  return { feature: hit.label, matches };
}

/**
 * Build a condensed conversation history for follow-up context.
 * Gives the LLM a clear picture of what was already generated so it can build
 * on prior content rather than repeating it.
 *
 * @param {Array} previousQueries - Array of prior query objects or strings
 * @param {Object} shownContent - { shownProducts, shownSections, generatedQueries }
 * @returns {string}
 */
function buildConversationHistory(previousQueries, shownContent) {
  if (!previousQueries?.length && !shownContent?.shownSections?.length) return '';

  let history = '\n\n## Conversation History (what has already been shown)\n';

  if (previousQueries?.length > 0) {
    history += '\nPrevious queries in this session:\n';
    previousQueries.forEach((q, i) => {
      const text = typeof q === 'string' ? q : (q.query || '');
      if (text) history += `${i + 1}. "${text}"\n`;
    });
  }

  if (shownContent?.shownSections?.length > 0) {
    history += '\nContent already on the page — do NOT repeat these:\n';
    shownContent.shownSections.forEach((s) => {
      history += `- ${s.blockType}${s.headline ? `: "${s.headline}"` : ''}\n`;
    });
  }

  if (shownContent?.shownProducts?.length > 0) {
    history += `\nProducts already featured (with key facts for follow-up reasoning): ${describeShownProducts(shownContent.shownProducts)}\n`;
    history += `
IMPORTANT — session continuity: the machines listed above are the anchor for this conversation. The user has already invested attention in them, so they are the FIRST candidates for the follow-up answer, not a blocklist. Apply this rule:

1. **Check fit first.** Look at the hardware facts above and ask: does any already-featured machine still satisfy the follow-up? (e.g. follow-up about milk steaming → a machine with an auto milk frother or steam wand still fits; follow-up about touchscreen → only a machine with \`touchscreen\` still fits.)

2. **If a featured machine still fits → keep it as the primary recommendation.** Open the first content block (columns or comparison-table) with that same machine and explain *why* it still fits this new angle (e.g. "The Automatico is still your pick here — its automatic milk system steams and froths in one touch"). Continuity beats novelty; do not switch picks just because the query changed.

3. **If NO featured machine fits → add a short \`text\` block first explaining why the earlier pick no longer applies** (1–2 sentences, e.g. "The Automatico is brilliant for one-touch convenience, but it can't deliver true latte-art microfoam — for that you want a real steam wand."), then pivot to the machine that does fit. Reference the earlier pick by name so the user sees a reasoned handoff, not a contradictory recommendation.

Either way, the comparison-table should include at least one already-featured machine alongside the new candidate so the user can see the tradeoff side-by-side.
`;
  }

  history += '\nThis is a follow-up turn. Build on what came before — provide new angles, go deeper on specifics, or explore what has not been covered yet. Do NOT start with a hero block.';

  return history;
}

function pickScenario(behavior, followUp, intent) {
  if (followUp?.type === 'pivot' && followUp.product) return 'follow-up-pivot';
  if (followUp?.type === 'cheaper_alternative' && followUp.product) return 'follow-up-cheaper';
  if (followUp) return 'follow-up';
  if (behavior?.coldStart && intent?.type === 'comparison') return 'cold-start-comparison';
  if (behavior?.coldStart) return 'cold-start';
  return 'default';
}

// ── Public API ──────────────────────────────────────────────────────────────

export function buildRecommenderSystemPrompt() {
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
  const history = followUp ? buildConversationHistory(previousQueries, shownContent) : '';
  const shownProductsLine = shownContent?.shownProducts?.length
    ? describeShownProducts(shownContent.shownProducts)
    : '';
  const shownBlockTypes = shownContent?.shownSections?.length
    ? [...new Set(shownContent.shownSections.map((s) => s.blockType))]
    : null;

  const normalizedPreviousQueries = previousQueries?.length
    ? previousQueries
      .map((q) => (typeof q === 'string' ? q : (q.query || '')))
      .filter(Boolean)
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
    previousQueries: normalizedPreviousQueries,
    shownBlockTypes,
  }).user;
}
