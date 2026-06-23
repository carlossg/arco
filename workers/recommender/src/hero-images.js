/**
 * Hero Image Selection — Hybrid keyword + vector scoring.
 *
 * Uses the unified hero image catalog (content/hero-image-catalog.json) which
 * contains ~88 entries from lifestyle, curated, and product sources.
 *
 * Selection combines:
 *   1. Keyword scoring (product match +10, topic overlap +2, partial +1)
 *   2. Vector similarity from pre-computed RAG results (score * 8)
 *
 * Vector matches arrive pre-computed from the RAG step — no async needed here.
 */

/* eslint-disable import/extensions, import/no-relative-packages */
import catalogData from '../../../content/hero-image-catalog.json';
/* eslint-enable import/extensions, import/no-relative-packages */

export const HERO_IMAGE_CATALOG = catalogData.images;

// ---------------------------------------------------------------------------
// Intent fallback topics
// ---------------------------------------------------------------------------

const INTENT_FALLBACK_TOPICS = {
  beginner: ['beginner', 'welcome', 'easy', 'first-machine', 'discovery'],
  discovery: ['discovery', 'general', 'espresso', 'welcome'],
  comparison: ['comparison', 'side-by-side', 'upgrade', 'choosing'],
  'product-detail': ['espresso', 'home-barista'],
  'use-case': ['espresso', 'home'],
  specs: ['technical', 'pressure', 'extraction', 'specs'],
  reviews: ['espresso', 'home-barista'],
  price: ['budget', 'entry-level', 'choosing'],
  recommendation: ['espresso', 'home-barista', 'discovery'],
  support: ['maintenance', 'cleaning', 'support', 'troubleshooting'],
  gift: ['espresso', 'home', 'beginner'],
  medical: ['general', 'espresso'],
  accessibility: ['easy', 'automatic', 'simple'],
  technique: ['technique', 'extraction', 'dialing-in', 'precision'],
  upgrade: ['upgrade', 'comparison', 'progression', 'advanced'],
};

// ---------------------------------------------------------------------------
// Tokenization & Keyword Scoring
// ---------------------------------------------------------------------------

/**
 * Tokenise a query string and use-case list into a normalised keyword set.
 */
function tokenize(query, useCases) {
  const tokens = new Set();
  if (query) {
    query.toLowerCase().split(/[\s,;.!?]+/).forEach((word) => {
      const trimmed = word.replace(/[^a-z0-9-]/g, '');
      if (trimmed.length > 2) tokens.add(trimmed);
    });
  }
  if (useCases) {
    useCases.forEach((uc) => {
      tokens.add(uc.toLowerCase().trim());
      uc.toLowerCase().split(/[\s-]+/).forEach((word) => {
        if (word.length > 2) tokens.add(word);
      });
    });
  }
  return tokens;
}

/**
 * Score a hero image against the given query context using keywords.
 * Higher score = better match.
 */
function scoreImage(image, queryTokens, productIds) {
  let score = 0;

  // Exact product match is the strongest signal
  if (image.productIds) {
    productIds.forEach((pid) => {
      if (image.productIds.includes(pid)) score += 10;
    });
  }

  // Topic overlap with query tokens
  (image.topics || []).forEach((topic) => {
    if (queryTokens.has(topic)) {
      score += 2;
    }
    // Partial match — topic inside a token or vice versa
    queryTokens.forEach((token) => {
      if (token !== topic && (token.includes(topic) || topic.includes(token))) {
        score += 1;
      }
    });
  });

  return score;
}

// ---------------------------------------------------------------------------
// Selection — Hybrid keyword + vector
// ---------------------------------------------------------------------------

/**
 * Select the best hero image for a given query context.
 *
 * Combines keyword scoring with pre-computed vector similarity from the RAG step.
 * Product matches (+10) dominate; for mood/lifestyle queries, vector similarity
 * provides the decisive signal.
 *
 * @param {Object} keywordCtx
 * @param {string} [keywordCtx.query] - The user's search query
 * @param {string[]} [keywordCtx.useCases] - Extracted use cases
 * @param {string} [keywordCtx.intentType] - Classified intent type
 * @param {string[]} [keywordCtx.productIds] - Relevant product IDs from RAG
 * @param {Array} [vectorMatches=[]] - Pre-computed vector matches from ctx.rag.heroImages
 * @returns {{ url: string, alt: string }} Image URL and alt text
 */
// Minimum vector similarity to trust Vectorize directly (skip hybrid scoring)
const VECTOR_CONFIDENCE_THRESHOLD = 0.7;

export function selectHeroImage({
  query, useCases, intentType, productIds = [],
} = {}, vectorMatches = []) {
  const queryTokens = tokenize(query, useCases);
  if (intentType) queryTokens.add(intentType);

  // ── 1. Product match: explicit product query always wins ───────────────────
  // Check keyword scores for product images only — +10 per matched product ID
  // dominates everything else, so we can short-circuit here.
  if (productIds.length > 0) {
    const productScored = HERO_IMAGE_CATALOG
      .map((image) => ({ image, score: scoreImage(image, queryTokens, productIds) }))
      .filter((s) => s.score >= 10);
    if (productScored.length > 0) {
      productScored.sort((a, b) => b.score - a.score || Math.random() - 0.5);
      return { url: productScored[0].image.url, alt: productScored[0].image.alt };
    }
  }

  // ── 2. High-confidence vector match: trust Vectorize when it's sure ────────
  // vectorMatches are already ranked by similarity (highest first).
  // If the top match clears the threshold, use it — no keyword inflation risk.
  const topVector = vectorMatches[0];
  if (topVector?.score >= VECTOR_CONFIDENCE_THRESHOLD && topVector.url) {
    return { url: topVector.url, alt: topVector.alt };
  }

  // ── 3. Hybrid scoring: keyword + vector boost ──────────────────────────────
  const vectorScoreMap = new Map();
  vectorMatches.forEach((vm) => {
    if (vm.id && vm.score != null) vectorScoreMap.set(vm.id, vm.score);
  });

  let scored = HERO_IMAGE_CATALOG.map((image) => {
    const keywordScore = scoreImage(image, queryTokens, productIds);
    const vectorScore = vectorScoreMap.get(image.id) || 0;
    return {
      image, keywordScore, vectorScore, score: keywordScore + (vectorScore * 8),
    };
  });

  // If no signal at all, inject intent fallback topics
  const bestScore = Math.max(...scored.map((s) => s.score));
  if (bestScore <= 1 && intentType) {
    const fallbackTopics = INTENT_FALLBACK_TOPICS[intentType] || ['general', 'espresso'];
    fallbackTopics.forEach((topic) => queryTokens.add(topic));
    scored = HERO_IMAGE_CATALOG.map((image) => {
      const keywordScore = scoreImage(image, queryTokens, productIds);
      const vectorScore = vectorScoreMap.get(image.id) || 0;
      return {
        image, keywordScore, vectorScore, score: keywordScore + (vectorScore * 8),
      };
    });
  }

  scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);
  const topTier = scored.filter((s) => s.score === scored[0].score);
  const selected = topTier[Math.floor(Math.random() * topTier.length)].image;

  return { url: selected.url, alt: selected.alt };
}
