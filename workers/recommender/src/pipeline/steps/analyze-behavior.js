/**
 * Analyze Behavior Step — processes browsing signals into structured recommendation signals.
 * Reads ctx.request.behaviorProfile and ctx.request.inferredProfile.
 * Writes ctx.rag.behaviorAnalysis.
 */

import { getAllProducts } from '../../context.js';

const USE_CASE_KEYWORDS = {
  espresso: ['espresso', 'shot', 'crema', 'extraction', 'barista'],
  'milk-drinks': ['latte', 'cappuccino', 'flat white', 'cortado', 'milk', 'steam'],
  'pour-over': ['pour over', 'filter', 'drip', 'v60', 'chemex', 'cold brew'],
  travel: ['travel', 'portable', 'camping', 'hotel', 'compact'],
  office: ['office', 'commercial', 'team', 'workplace', 'volume'],
  'home-barista': ['home barista', 'craft', 'precision', 'prosumer', 'professional'],
  beginner: ['beginner', 'first', 'new', 'starting', 'learn', 'easy'],
  upgrade: ['upgrade', 'better', 'improve', 'replace', 'switch'],
};

/**
 * Map a product display name to a product ID from the catalog.
 */
function nameToProductId(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  const allProducts = getAllProducts();
  const direct = allProducts.find((p) => {
    const pLower = (p.name || '').toLowerCase();
    const pId = (p.id || '').toLowerCase();
    return pLower === lower || pId === lower || pLower.includes(lower) || lower.includes(pLower);
  });
  return direct ? direct.id : null;
}

/**
 * Determine price sensitivity tier from price range and viewed product prices.
 */
function determinePriceTier(priceRange, viewedIds) {
  if (priceRange?.max) {
    if (priceRange.max < 800) return 'budget';
    if (priceRange.max <= 2000) return 'mid';
    return 'premium';
  }

  if (viewedIds.length > 0) {
    const allProducts = getAllProducts();
    const prices = viewedIds
      .map((id) => allProducts.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => p.price);
    if (prices.length > 0) {
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      if (avg < 800) return 'budget';
      if (avg <= 2000) return 'mid';
      return 'premium';
    }
  }

  return null;
}

/**
 * Extract use-case priorities from search terms and interests.
 */
function extractUseCasePriorities(interests) {
  const allTerms = (interests || []).map((t) => t.toLowerCase());

  const scored = Object.entries(USE_CASE_KEYWORDS).map(([useCase, keywords]) => {
    const score = allTerms.reduce(
      (acc, term) => acc + keywords.filter((kw) => term.includes(kw)).length,
      0,
    );
    return [useCase, score];
  });

  return scored
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([uc]) => uc);
}

// eslint-disable-next-line import/prefer-default-export
export async function analyzeBehavior(ctx) {
  const start = Date.now();
  const bp = ctx.request.behaviorProfile;
  const inferred = ctx.request.inferredProfile;

  if (!bp && !inferred) {
    ctx.rag.behaviorAnalysis = { coldStart: true };
    ctx.timings.analyzeBehavior = Date.now() - start;
    return;
  }

  // Extract viewed products from inferred profile or behavior profile
  const productsViewed = inferred?.productsViewed
    || (bp?.viewedProducts || []).map(nameToProductId).filter(Boolean)
    || [];

  const allProducts = getAllProducts();
  const catalogPrices = productsViewed
    .map((id) => allProducts.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => p.price);
  const catalogPriceRange = catalogPrices.length > 0
    ? { min: Math.min(...catalogPrices), max: Math.max(...catalogPrices) }
    : null;

  const priceTier = determinePriceTier(catalogPriceRange || bp?.priceRange, productsViewed);
  const useCasePriorities = extractUseCasePriorities(inferred?.interests || bp?.interests);

  ctx.rag.behaviorAnalysis = {
    coldStart: productsViewed.length === 0,
    priceTier,
    catalogPriceRange,
    useCasePriorities,
    productShortlist: productsViewed,
    inferredIntent: inferred?.inferredIntent || null,
    journeyStage: inferred?.journeyStage || null,
    purchaseReadiness: inferred?.journeyStage === 'deciding' ? 'considering' : 'browsing',
    productsViewed,
  };

  ctx.timings.analyzeBehavior = Date.now() - start;
}
