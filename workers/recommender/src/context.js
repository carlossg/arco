/**
 * Content retrieval: bundled metadata + guide RAG via Vectorize.
 */

/* eslint-disable import/extensions, import/no-relative-packages */
import productsData from '../../../content/products/products.json';
import personasData from '../../../content/metadata/personas.json';
import featuresData from '../../../content/metadata/features.json';
import faqsData from '../../../content/metadata/faqs.json';
import reviewsData from '../../../content/metadata/reviews.json';
import useCasesData from '../../../content/metadata/use-cases.json';
import productProfilesData from '../../../content/metadata/product-profiles.json';
import recipesData from '../../../content/recipes/recipes.json';
import accessoriesData from '../../../content/accessories/accessories.json';
/* eslint-enable import/extensions, import/no-relative-packages */

/**
 * Match query against persona trigger phrases.
 * Arco personas don't have triggerPhrases arrays, so we derive them.
 */
export function matchPersona(query) {
  const lower = query.toLowerCase();

  // Derive trigger phrases per persona from their fields
  const PERSONA_TRIGGERS = {
    'morning-minimalist': ['quick', 'fast', 'easy', 'simple', 'convenient', 'morning', 'busy', 'no fuss', 'automatic', 'one button', 'consistent', 'reliable'],
    upgrader: ['upgrade', 'better', 'improve', 'next level', 'step up', 'outgrow', 'replace', 'prosumer', 'more control', 'serious'],
    'craft-barista': ['craft', 'barista', 'precision', 'extraction', 'dial in', 'pressure profile', 'flow control', 'competition', 'advanced', 'expert', 'latte art', 'microfoam'],
    traveller: ['travel', 'portable', 'camping', 'hotel', 'carry', 'lightweight', 'compact', 'on the go', 'mobile', 'road'],
    'non-barista': ['beginner', 'first', 'new to', 'never', 'easy to use', 'simple', 'intimidated', 'not technical', 'pods', 'capsule', 'switching'],
    'office-manager': ['office', 'commercial', 'team', 'workplace', 'employees', 'staff', 'business', 'volume', 'multiple', 'company'],
  };

  let bestMatch = null;
  let bestScore = 0;

  const personas = personasData.data || [];
  personas.forEach((persona) => {
    const triggers = PERSONA_TRIGGERS[persona.slug] || [];
    const score = triggers.reduce(
      (s, phrase) => s + (lower.includes(phrase) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      bestMatch = persona;
      bestScore = score;
    }
  });

  return bestMatch;
}

/**
 * Match query against use cases.
 */
export function matchUseCase(query) {
  const lower = query.toLowerCase();
  const useCases = useCasesData.data || [];
  return useCases.find((uc) => {
    const name = (uc.name || '').toLowerCase();
    if (lower.includes(name) || lower.includes(uc.id || '')) return true;
    return (uc.keywords || []).some((kw) => lower.includes(kw.toLowerCase()));
  }) || null;
}

/**
 * Get relevant products based on persona, use case, and query.
 */
export function getRelevantProducts(query, persona, useCase) {
  const lower = query.toLowerCase();
  const profiles = productProfilesData.data || productProfilesData.profiles || {};
  const allProducts = productsData.data || [];

  const scored = allProducts.map((p) => {
    let score = 0;

    // Boost if recommended by persona
    if (persona?.recommendedSetup) {
      const recommended = [
        ...(persona.recommendedSetup.machines || []),
        ...(persona.recommendedSetup.grinders || []),
      ];
      if (recommended.includes(p.id)) score += 3;
    }

    // Boost by use case score from profiles
    const profile = profiles[p.id]
      || (Array.isArray(profiles) ? profiles.find((pr) => pr.id === p.id) : null);
    if (useCase && profile?.scores) {
      score += (profile.scores[useCase.id] || 0) / 2;
    }

    // Boost if query mentions product name or series
    const nameMatch = lower.includes((p.name || '').toLowerCase());
    const idMatch = lower.includes((p.id || '').toLowerCase());
    if (nameMatch || idMatch) {
      score += 5;
    }
    if (p.series && lower.includes(p.series.toLowerCase())) {
      score += 3;
    }

    // Boost if bestFor matches query terms
    (p.bestFor || []).forEach((bf) => {
      if (lower.includes(bf.toLowerCase())) score += 2;
    });

    return { ...p, score };
  }).sort((a, b) => b.score - a.score);

  return scored.slice(0, 8);
}

/**
 * Get relevant features based on query and matched products.
 */
export function getRelevantFeatures(query, products) {
  const lower = query.toLowerCase();
  const productIds = new Set(products.map((p) => p.id));
  const features = featuresData.data || [];

  return features.filter((f) => {
    if (lower.includes((f.name || '').toLowerCase())) return true;
    return (f.products || f.availableIn || []).some((id) => productIds.has(id));
  }).slice(0, 5);
}

/**
 * Get relevant FAQs based on query.
 */
export function getRelevantFaqs(query) {
  const lower = query.toLowerCase();
  const faqs = faqsData.data || [];
  const terms = lower.split(/\s+/).filter((t) => t.length > 2);

  return faqs.filter((f) => {
    // Match by keywords if available
    if (f.keywords) {
      return f.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    }
    // Fallback: match against question + answer text
    const text = `${f.question || ''} ${f.answer || ''}`.toLowerCase();
    return terms.some((term) => text.includes(term));
  }).slice(0, 4);
}

/**
 * Get relevant reviews.
 */
export function getRelevantReviews(query, products) {
  const lower = query.toLowerCase();
  const productIds = new Set(products.map((p) => p.id));
  const reviews = reviewsData.data || [];

  return reviews.filter((r) => {
    if (r.productId && productIds.has(r.productId)) return true;
    if (r.useCase && lower.includes(r.useCase)) return true;
    const content = (r.content || r.body || '').toLowerCase();
    return lower.split(' ').some((word) => word.length > 3 && content.includes(word));
  }).slice(0, 4);
}

/**
 * Keyword-based guide matching fallback.
 * Guides are in separate JSON files — this is a stub.
 * Real matches come from Vectorize.
 */
function keywordMatchGuides() {
  return [];
}

/**
 * Search content via Vectorize + KV fallback.
 * Uses a single embedding, queries CONTENT_INDEX, splits by metadata type.
 * Falls back to keyword matching on bundled guide/experience JSON if unavailable.
 */
export async function searchContent(query, env, config = {}) {
  const timings = {
    embedding: 0, vectorize: 0, guidesMs: 0, experiencesMs: 0, fallback: false,
  };
  const maxGuides = config.maxGuides || 5;
  const maxExperiences = config.maxExperiences || 3;

  if (!env.CONTENT_INDEX) {
    timings.fallback = true;
    return {
      guides: keywordMatchGuides(query).slice(0, maxGuides),
      experiences: [],
      timings,
    };
  }

  try {
    const embeddingStart = Date.now();
    const embeddingResponse = await env.AI?.run('@cf/baai/bge-small-en-v1.5', {
      text: [query],
    });
    timings.embedding = Date.now() - embeddingStart;

    if (!embeddingResponse?.data?.[0]) {
      return {
        guides: keywordMatchGuides(query).slice(0, maxGuides),
        experiences: [],
        timings: { ...timings, fallback: true },
      };
    }

    const embedding = embeddingResponse.data[0];

    const vectorizeStart = Date.now();
    const allResults = await env.CONTENT_INDEX.query(embedding, {
      topK: 30,
      returnMetadata: 'all',
    });
    timings.vectorize = Date.now() - vectorizeStart;

    const guideMatches = (allResults.matches || []).filter((m) => m.metadata?.type === 'guide');
    const experienceMatches = (allResults.matches || []).filter((m) => m.metadata?.type === 'experience');

    // Deduplicate by slug
    const seenGuides = new Set();
    const guides = guideMatches.reduce((acc, m) => {
      if (acc.length >= maxGuides) return acc;
      const slug = m.metadata?.slug;
      if (seenGuides.has(slug)) return acc;
      seenGuides.add(slug);
      acc.push({
        slug,
        title: m.metadata?.title,
        category: m.metadata?.category,
        difficulty: m.metadata?.difficulty,
        _score: m.score,
        _matchedSection: m.metadata?.sectionHeading,
      });
      return acc;
    }, []);

    const seenExp = new Set();
    const experiences = experienceMatches.reduce((acc, m) => {
      if (acc.length >= maxExperiences) return acc;
      const slug = m.metadata?.slug;
      if (seenExp.has(slug)) return acc;
      seenExp.add(slug);
      acc.push({
        slug,
        title: m.metadata?.title,
        category: m.metadata?.category,
        _score: m.score,
      });
      return acc;
    }, []);

    timings.guidesMs = timings.embedding + timings.vectorize;
    timings.experiencesMs = timings.embedding + timings.vectorize;

    return { guides, experiences, timings };
  } catch {
    return {
      guides: keywordMatchGuides(query).slice(0, maxGuides),
      experiences: [],
      timings: { ...timings, fallback: true },
    };
  }
}

/**
 * Get all products for prompt building.
 */
export function getAllProducts() {
  return productsData.data || [];
}

/**
 * Get all recipes for prompt building.
 */
export function getAllRecipes() {
  return recipesData.data || [];
}

/**
 * Get all accessories for prompt building.
 */
export function getAllAccessories() {
  return accessoriesData.data || [];
}
