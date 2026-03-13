import type { IntentClassification, IntentType } from '../types';

/**
 * Category paths for generated content.
 * Maps intent types to semantic URL categories.
 */
export type CategoryPath =
  | 'espresso'
  | 'guides'
  | 'products'
  | 'compare'
  | 'tips'
  | 'discover';

/**
 * Keywords that indicate espresso-specific content
 */
const ESPRESSO_KEYWORDS = [
  'espresso',
  'shot',
  'ristretto',
  'crema',
  'extraction',
  'pull',
  'dose',
  'tamp',
  'puck',
  'portafilter',
  'naked shot',
  'bottomless',
];

/**
 * Keywords that indicate guide/how-to content
 */
const GUIDE_KEYWORDS = [
  'guide',
  'how to',
  'recipe',
  'brew',
  'make',
  'prepare',
  'technique',
  'tutorial',
  'step by step',
  'dial in',
  'latte art',
  'steam milk',
];

/**
 * Classify query into a URL category based on intent types
 *
 * Mapping:
 * - use-case + espresso keywords -> espresso
 * - use-case (guides, brewing) -> guides
 * - product-detail, specs, price, reviews -> products
 * - comparison -> compare
 * - support -> tips
 * - discovery, recommendation, gift, medical, accessibility, other -> discover
 */
export function classifyCategory(
  intent: IntentClassification,
  query: string,
): CategoryPath {
  const queryLower = query.toLowerCase();
  const intentType = intent.intentType;

  // Check for espresso content first (highest priority)
  if (ESPRESSO_KEYWORDS.some((k) => queryLower.includes(k))) {
    return 'espresso';
  }

  // Use-case intent - check for guide subcategory
  if (intentType === 'use-case') {
    if (GUIDE_KEYWORDS.some((k) => queryLower.includes(k))) {
      return 'guides';
    }
    // Default use-case to discover
    return 'discover';
  }

  // Map intent types to categories
  const categoryMap: Partial<Record<IntentType, CategoryPath>> = {
    'product-detail': 'products',
    specs: 'products',
    price: 'products',
    reviews: 'products',
    comparison: 'compare',
    support: 'tips',
  };

  return categoryMap[intentType] || 'discover';
}

/**
 * All valid category routes the worker should handle
 */
export const CATEGORY_ROUTES = [
  '/espresso/',
  '/guides/',
  '/products/',
  '/compare/',
  '/tips/',
  '/discover/',
] as const;

/**
 * Check if a pathname matches a category route
 */
export function isCategoryPath(pathname: string): boolean {
  return CATEGORY_ROUTES.some((route) => pathname.startsWith(route));
}

/**
 * Extract category from a path
 */
export function getCategoryFromPath(pathname: string): CategoryPath | null {
  for (const route of CATEGORY_ROUTES) {
    if (pathname.startsWith(route)) {
      return route.slice(1, -1) as CategoryPath;
    }
  }
  return null;
}

/**
 * Generate a semantic slug from query and intent entities.
 * Uses extracted entities (products, useCases, features) to create
 * meaningful URL slugs like "studio-espresso-flow-control".
 */
export function generateSemanticSlug(
  query: string,
  intent: IntentClassification,
): string {
  // Try to build slug from entities first
  const concepts = [
    ...intent.entities.products.slice(0, 2),
    ...intent.entities.useCases.slice(0, 1),
    ...intent.entities.features.slice(0, 1),
  ].filter(Boolean);

  let baseSlug: string;

  if (concepts.length >= 2) {
    // Use entities for semantic slug
    baseSlug = concepts
      .join('-')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .substring(0, 50);
  } else {
    // Fall back to extracting keywords from query
    baseSlug = extractKeywords(query).slice(0, 4).join('-').substring(0, 50);
  }

  // Add short hash for uniqueness
  const hash = simpleHash(query + Date.now()).slice(0, 6);
  return `${baseSlug}-${hash}`;
}

/**
 * Extract meaningful keywords from a query string
 */
function extractKeywords(query: string): string[] {
  // Common stop words to filter out
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'this', 'that',
    'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do',
    'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'can', 'what', 'how', 'why', 'when', 'where', 'which', 'who',
    'my', 'your', 'me', 'i', 'we', 'you', 'make', 'get', 'want', 'need',
    'like', 'best', 'good', 'great', 'some', 'any', 'please', 'help',
  ]);

  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .slice(0, 6);
}

/**
 * Simple hash function for generating unique suffixes
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Build the full categorized path for generated content
 */
export function buildCategorizedPath(
  category: CategoryPath,
  slug: string,
): string {
  return `/${category}/${slug}`;
}

/**
 * Generate a deterministic slug from a query string.
 * Unlike generateSemanticSlug, this always produces the same output for the
 * same query, enabling cache lookups by path.
 */
export function generateDeterministicSlug(query: string): string {
  const normalized = query.toLowerCase().trim().replace(/\s+/g, ' ');
  const keywords = extractKeywords(normalized);
  const baseSlug = keywords.slice(0, 4).join('-').substring(0, 50) || 'query';
  const hash = simpleHash(normalized).slice(0, 6);
  return `${baseSlug}-${hash}`;
}

/**
 * Build a preset-scoped path for cached pages.
 * Production preset uses /discover/{slug}, others use /discover/{preset}/{slug}.
 */
export function buildPresetScopedPath(slug: string, preset?: string): string {
  if (!preset || preset === 'production') return `/discover/${slug}`;
  return `/discover/${preset}/${slug}`;
}
