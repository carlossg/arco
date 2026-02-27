/**
 * Content Service
 *
 * Provides access to local JSON content for products, brew guides, use cases,
 * features, reviews, personas, product profiles, accessories, and FAQs.
 *
 * For Cloud Run: Loads JSON files at runtime from the content directory
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================
// Local Type Definitions
// ============================================
// These mirror the JSON structures found in /content/.
// The canonical domain types live in ../types.ts; the interfaces
// below are intentionally loose so we can normalise on load.

export interface Product {
  id: string;
  name: string;
  series: string;
  category?: string;
  url: string;
  price: number;
  currency?: string;
  originalPrice?: number | null;
  availability?: string;
  tagline?: string;
  description?: string;
  features?: string[];
  bestFor?: string[];
  warranty?: string;
  specs?: Record<string, unknown>;
  images?: Record<string, unknown>;
}

export interface BrewGuide {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  url?: string;
  description?: string;
  difficulty?: string;
  prepTime?: string;
  grindSize?: string;
  dose?: string;
  yield?: string;
  extractionTime?: string;
  temperature?: string;
  pressure?: string;
  technique?: string[];
  requiredEquipment?: string[];
  tips?: string[];
  recommendedProducts?: string[];
  images?: Record<string, unknown>;
}

export interface UseCase {
  id: string;
  name: string;
  slug?: string;
  icon?: string;
  description: string;
  keywords?: string[];
  recommendedProducts?: string[];
  recommendedAccessories?: string[];
  relatedRecipes?: string[];
  priority?: number;
}

export interface Feature {
  id: string;
  name: string;
  slug?: string;
  category?: string;
  description: string;
  benefits?: string[];
  products?: string[];
  importance?: string;
  learnMoreUrl?: string;
}

export interface Review {
  id: string;
  productId?: string;
  productName?: string;
  author: string;
  location?: string;
  date?: string;
  rating?: number;
  title?: string;
  body: string;
  verified?: boolean;
  helpfulCount?: number;
  pros?: string[];
  cons?: string[];
  useCase?: string;
}

export interface Persona {
  id: string;
  name: string;
  slug?: string;
  tagline?: string;
  description: string;
  avatar?: string;
  priorities?: string[];
  typicalDrinks?: string[];
  budget?: string;
  budgetRange?: { min: number; max: number };
  skillLevel?: string;
  recommendedSetup?: {
    machines?: string[];
    grinders?: string[];
    accessories?: string[];
  };
  painPoints?: string[];
}

export interface ProductProfile {
  productId: string;
  productName?: string;
  series?: string;
  scores: Record<string, number>;
  strengths?: string[];
  limitations?: string[];
}

export interface Accessory {
  id: string;
  name: string;
  type: string;
  url: string;
  price: number;
  currency?: string;
  description?: string;
  features?: string[];
  compatibility?: string[];
  images?: Record<string, unknown>;
}

export interface FAQ {
  id: string;
  category: string;
  question: string;
  answer: string;
  relatedProducts?: string[];
  priority?: number;
}

// ============================================
// JSON File Interfaces (wrapping `data` arrays)
// ============================================

interface DataFile<T> {
  total?: number;
  offset?: number;
  limit?: number;
  data: T[];
}

// Product-profiles file has additional metadata
interface ProductProfilesFile extends DataFile<ProductProfile> {
  useCases?: string[];
  description?: string;
}

// ============================================
// Content Directory & Loader
// ============================================

const CONTENT_DIR = path.join(__dirname, '../../content');

function loadJSON<T>(relativePath: string): T {
  const filePath = path.join(CONTENT_DIR, relativePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * Extract an array from a loaded JSON object.
 * Handles both `{ data: [...] }` and `{ <key>: [...] }` formats.
 */
function extractArray<T>(obj: unknown, ...keys: string[]): T[] {
  const record = obj as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data as T[];
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as T[];
  }
  return [];
}

// ============================================
// Load All Content Files
// ============================================

const productsRaw = loadJSON<DataFile<Product>>('products/products.json');
const brewGuidesRaw = loadJSON<DataFile<BrewGuide>>('recipes/recipes.json');
const accessoriesRaw = loadJSON<DataFile<Accessory>>('accessories/accessories.json');
const useCasesRaw = loadJSON<DataFile<UseCase>>('metadata/use-cases.json');
const featuresRaw = loadJSON<DataFile<Feature>>('metadata/features.json');
const reviewsRaw = loadJSON<DataFile<Review>>('metadata/reviews.json');
const personasRaw = loadJSON<DataFile<Persona>>('metadata/personas.json');
const productProfilesRaw = loadJSON<ProductProfilesFile>('metadata/product-profiles.json');
const faqsRaw = loadJSON<DataFile<FAQ>>('metadata/faqs.json');

// Extract arrays
const products: Product[] = extractArray<Product>(productsRaw, 'products');
const brewGuides: BrewGuide[] = extractArray<BrewGuide>(brewGuidesRaw, 'recipes', 'brewGuides');
const accessories: Accessory[] = extractArray<Accessory>(accessoriesRaw, 'accessories');
const useCases: UseCase[] = extractArray<UseCase>(useCasesRaw, 'useCases');
const features: Feature[] = extractArray<Feature>(featuresRaw, 'features');
const reviews: Review[] = extractArray<Review>(reviewsRaw, 'reviews');
const personas: Persona[] = extractArray<Persona>(personasRaw, 'personas');
const productProfiles: ProductProfile[] = extractArray<ProductProfile>(productProfilesRaw, 'profiles');
const faqs: FAQ[] = extractArray<FAQ>(faqsRaw, 'faqs');

// Build a map for quick product-profile lookup by productId
const profileMap: Record<string, ProductProfile> = {};
for (const profile of productProfiles) {
  profileMap[profile.productId] = profile;
}

// ============================================
// Common Coffee Terms (replaces COMMON_INGREDIENTS)
// ============================================

const COMMON_COFFEE_TERMS: string[] = [
  'espresso', 'latte', 'cappuccino', 'americano', 'flat white', 'cortado',
  'macchiato', 'mocha', 'pour over', 'cold brew', 'iced', 'drip',
  'french press', 'aeropress', 'chemex', 'v60', 'moka pot',
  'single origin', 'blend', 'arabica', 'robusta', 'specialty',
  'light roast', 'medium roast', 'dark roast',
  'crema', 'extraction', 'channeling', 'tamping', 'dosing',
  'microfoam', 'steaming', 'latte art', 'milk texture',
  'grind size', 'fine grind', 'coarse grind', 'burr', 'retention',
  'pid', 'pressure profiling', 'flow control', 'pre-infusion',
  'descaling', 'backflush', 'cleaning', 'maintenance',
];

// ============================================
// Use-Case Keywords
// ============================================

const USE_CASE_KEYWORDS: Record<string, string[]> = {
  espresso: ['espresso', 'shot', 'ristretto', 'lungo', 'extraction'],
  'milk-drinks': ['latte', 'cappuccino', 'flat white', 'cortado', 'milk', 'steam', 'microfoam', 'latte art'],
  'home-barista': ['home barista', 'craft', 'specialty', 'dial in', 'workflow'],
  office: ['office', 'workplace', 'staff', 'team', 'commercial', 'business'],
  travel: ['travel', 'portable', 'camping', 'outdoor', 'on the go'],
  'pour-over': ['pour over', 'filter', 'drip', 'chemex', 'v60', 'aeropress', 'french press'],
  beginner: ['beginner', 'first', 'new to', 'starting', 'learn', 'pods', 'nespresso', 'switching'],
  upgrade: ['upgrade', 'better', 'outgrown', 'step up', 'next level', 'replace'],
};

// ============================================
// Product Queries
// ============================================

export function getAllProducts(): Product[] {
  return products;
}

export function getProductById(id: string): Product | undefined {
  return products.find((p) => p.id === id);
}

export function getProductsByIds(ids: string[]): Product[] {
  return products.filter((p) => ids.includes(p.id));
}

export function getProductsBySeries(series: string): Product[] {
  return products.filter((p) => p.series === series);
}

export function getProductsByPriceRange(min: number, max: number): Product[] {
  return products.filter((p) => p.price >= min && p.price <= max);
}

export function getProductsByUseCase(useCase: string): Product[] {
  return products.filter((p) => p.bestFor?.includes(useCase));
}

export function searchProducts(query: string): Product[] {
  const lowerQuery = query.toLowerCase();
  return products.filter(
    (p) =>
      p.name.toLowerCase().includes(lowerQuery) ||
      p.description?.toLowerCase().includes(lowerQuery) ||
      p.features?.some((f) => f.toLowerCase().includes(lowerQuery)) ||
      p.bestFor?.some((b) => b.toLowerCase().includes(lowerQuery)),
  );
}

// ============================================
// Brew Guide Queries (replaces Recipe Queries)
// ============================================

export function getAllBrewGuides(): BrewGuide[] {
  return brewGuides;
}

export function getBrewGuideById(id: string): BrewGuide | undefined {
  return brewGuides.find((r) => r.id === id);
}

export function getBrewGuidesByCategory(category: string): BrewGuide[] {
  return brewGuides.filter((r) => r.category === category);
}

export function getBrewGuidesByDifficulty(difficulty: string): BrewGuide[] {
  return brewGuides.filter((r) => r.difficulty === difficulty);
}

export function getBrewGuidesForProduct(productId: string): BrewGuide[] {
  return brewGuides.filter((r) => r.recommendedProducts?.includes(productId));
}

export function getBrewGuideCategories(): string[] {
  return [...new Set(brewGuides.map((r) => r.category))];
}

/**
 * Search brew guides across name, description, and technique steps.
 * Uses score-based ranking for relevance.
 */
export function searchBrewGuides(query: string, maxResults = 50): BrewGuide[] {
  const lowerQuery = query.toLowerCase();
  const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 2);

  if (queryWords.length === 0) return [];

  const scored = brewGuides.map((guide) => {
    let score = 0;

    // Name matching (highest weight)
    const lowerName = guide.name.toLowerCase();
    if (lowerName.includes(lowerQuery)) {
      score += 10;
    } else {
      for (const word of queryWords) {
        if (lowerName.includes(word)) score += 3;
      }
    }

    // Description matching
    if (guide.description) {
      const lowerDesc = guide.description.toLowerCase();
      if (lowerDesc.includes(lowerQuery)) {
        score += 5;
      } else {
        for (const word of queryWords) {
          if (lowerDesc.includes(word)) score += 1;
        }
      }
    }

    // Technique / equipment matching (replaces ingredient matching)
    if (guide.technique?.length) {
      for (const step of guide.technique) {
        const lowerStep = step.toLowerCase();
        if (lowerStep.includes(lowerQuery)) {
          score += 4;
        } else {
          for (const word of queryWords) {
            if (lowerStep.includes(word)) score += 1;
          }
        }
      }
    }

    if (guide.requiredEquipment?.length) {
      for (const equip of guide.requiredEquipment) {
        const lowerEquip = equip.toLowerCase();
        if (lowerEquip.includes(lowerQuery) || lowerQuery.includes(lowerEquip)) {
          score += 6;
        }
      }
    }

    return { guide, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.guide);
}

// ============================================
// Use Case & Feature Queries
// ============================================

export function getAllUseCases(): UseCase[] {
  return useCases;
}

export function getUseCaseById(id: string): UseCase | undefined {
  return useCases.find((u) => u.id === id);
}

export function getAllFeatures(): Feature[] {
  return features;
}

export function getFeatureById(id: string): Feature | undefined {
  return features.find((f) => f.id === id);
}

export function getFeaturesForProduct(productId: string): Feature[] {
  return features.filter((f) => f.products?.includes(productId));
}

// ============================================
// Accessory Queries
// ============================================

export function getAllAccessories(): Accessory[] {
  return accessories;
}

export function getAccessoryById(id: string): Accessory | undefined {
  return accessories.find((a) => a.id === id);
}

export function getAccessoriesByType(type: string): Accessory[] {
  return accessories.filter((a) => a.type === type);
}

export function getAccessoriesForProduct(productId: string): Accessory[] {
  return accessories.filter((a) =>
    a.compatibility?.some((c) => c.toLowerCase().includes(productId.toLowerCase())),
  );
}

export function searchAccessories(query: string): Accessory[] {
  const lowerQuery = query.toLowerCase();
  return accessories.filter(
    (a) =>
      a.name.toLowerCase().includes(lowerQuery) ||
      a.description?.toLowerCase().includes(lowerQuery) ||
      a.type.toLowerCase().includes(lowerQuery),
  );
}

// ============================================
// Review Queries
// ============================================

export function getAllReviews(): Review[] {
  return reviews;
}

export function getReviewsByProduct(productId: string): Review[] {
  return reviews.filter((r) => r.productId === productId);
}

export function getReviewsByUseCase(useCase: string): Review[] {
  return reviews.filter((r) => r.useCase === useCase);
}

export function getAverageRating(productId: string): number {
  const productReviews = getReviewsByProduct(productId);
  if (productReviews.length === 0) return 0;
  const sum = productReviews.reduce((acc, r) => acc + (r.rating || 0), 0);
  return sum / productReviews.length;
}

// ============================================
// Persona Queries
// ============================================

export function getAllPersonas(): Persona[] {
  return personas;
}

export function getPersonaById(id: string): Persona | undefined {
  return personas.find((p) => p.id === id);
}

export function detectPersona(query: string): Persona | null {
  const lowerQuery = query.toLowerCase();

  for (const persona of personas) {
    // Match on pain points, priorities, and typical drinks
    const matchTerms = [
      ...(persona.painPoints || []),
      ...(persona.priorities || []),
      ...(persona.typicalDrinks || []),
    ];

    let matchCount = 0;
    for (const term of matchTerms) {
      if (lowerQuery.includes(term.toLowerCase())) {
        matchCount += 1;
      }
    }
    // Require at least 2 term matches for persona detection
    if (matchCount >= 2) {
      return persona;
    }

    // Also check the persona description for keyword overlap
    if (persona.description) {
      const descWords = persona.description.toLowerCase().split(/\s+/);
      const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 3);
      let overlap = 0;
      for (const qw of queryWords) {
        if (descWords.includes(qw)) overlap += 1;
      }
      if (overlap >= 3) return persona;
    }
  }

  return null;
}

// ============================================
// Product Profile Queries
// ============================================

export function getProductProfile(productId: string): ProductProfile | undefined {
  return profileMap[productId];
}

export function getProductsForUseCase(useCase: string, minScore = 7): Product[] {
  const matchingIds = productProfiles
    .filter((profile) => {
      const score = profile.scores?.[useCase];
      return score !== undefined && score >= minScore;
    })
    .sort((a, b) => {
      const scoreA = a.scores?.[useCase] ?? 0;
      const scoreB = b.scores?.[useCase] ?? 0;
      return scoreB - scoreA;
    })
    .map((profile) => profile.productId);

  return getProductsByIds(matchingIds);
}

export function getProductsByPriceTier(tier: 'budget' | 'mid' | 'premium'): Product[] {
  const ranges: Record<string, [number, number]> = {
    budget: [0, 800],
    mid: [800, 2000],
    premium: [2000, Infinity],
  };
  const [min, max] = ranges[tier] || [0, Infinity];
  return products.filter((p) => p.price >= min && p.price < max);
}

export function getProductsByHouseholdFit(fit: 'solo' | 'couple' | 'office'): Product[] {
  // Infer household fit from product profiles and use case scores
  const scoreKey: Record<string, string> = {
    solo: 'travel',
    couple: 'home-barista',
    office: 'office',
  };
  const useCase = scoreKey[fit] || fit;
  return getProductsForUseCase(useCase, 5);
}

// ============================================
// FAQ Queries
// ============================================

export function getAllFAQs(): FAQ[] {
  return faqs;
}

export function getFAQsByCategory(category: string): FAQ[] {
  return faqs.filter((faq) => faq.category === category);
}

export function getFAQsForQuery(query: string): FAQ[] {
  const lowerQuery = query.toLowerCase();

  const scored = faqs.map((faq) => {
    let score = 0;

    // Check related products
    if (faq.relatedProducts) {
      for (const productId of faq.relatedProducts) {
        if (lowerQuery.includes(productId.toLowerCase())) {
          score += 2;
        }
      }
    }

    // Check if question or answer contains query words
    const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 3);
    for (const word of queryWords) {
      if (faq.question.toLowerCase().includes(word)) score += 1;
      if (faq.answer.toLowerCase().includes(word)) score += 0.5;
    }

    return { faq, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.faq);
}

// ============================================
// Content Summary (for AI context)
// ============================================

export interface ContentSummary {
  productCount: number;
  brewGuideCount: number;
  useCaseCount: number;
  featureCount: number;
  priceTiers: {
    budget: { min: number; max: number; count: number };
    mid: { min: number; max: number; count: number };
    premium: { min: number; max: number; count: number };
  };
  series: string[];
  categories: string[];
}

export function getContentSummary(): ContentSummary {
  const budgetProducts = products.filter((p) => p.price < 800);
  const midProducts = products.filter((p) => p.price >= 800 && p.price < 2000);
  const premiumProducts = products.filter((p) => p.price >= 2000);

  const series = [...new Set(products.map((p) => p.series))];
  const categories = getBrewGuideCategories();

  const safePrices = (arr: Product[]) => {
    const prices = arr.map((p) => p.price);
    if (prices.length === 0) return { min: 0, max: 0 };
    return { min: Math.min(...prices), max: Math.max(...prices) };
  };

  return {
    productCount: products.length,
    brewGuideCount: brewGuides.length,
    useCaseCount: useCases.length,
    featureCount: features.length,
    priceTiers: {
      budget: { ...safePrices(budgetProducts), count: budgetProducts.length },
      mid: { ...safePrices(midProducts), count: midProducts.length },
      premium: { ...safePrices(premiumProducts), count: premiumProducts.length },
    },
    series,
    categories,
  };
}

// ============================================
// Extract Coffee Terms from Query
// ============================================

/**
 * Extract coffee-related terms from a user query.
 * Returns matching terms found in the query.
 */
export function extractCoffeeTerms(query: string): string[] {
  const lowerQuery = query.toLowerCase();
  return COMMON_COFFEE_TERMS.filter((term) => {
    const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return regex.test(lowerQuery);
  });
}

// ============================================
// Extract Keywords
// ============================================

function extractKeywords(query: string): string[] {
  const lowerQuery = query.toLowerCase();
  const keywords: string[] = [];

  for (const [useCase, terms] of Object.entries(USE_CASE_KEYWORDS)) {
    for (const term of terms) {
      if (lowerQuery.includes(term)) {
        keywords.push(useCase);
        break;
      }
    }
  }

  return keywords;
}

// ============================================
// Extract Product Models
// ============================================

/**
 * Extract Arco product model names from a query
 */
function extractProductModels(query: string): string[] {
  const models: string[] = [];

  const modelPatterns = [
    /\bprimo\b/gi,
    /\bdoppio\b/gi,
    /\bnano\b/gi,
    /\bstudio[- ]?pro\b/gi,
    /\bstudio\b/gi,
    /\bufficio\b/gi,
    /\bviaggio\b/gi,
    /\bautomatico\b/gi,
    /\bfiltro\b/gi,
    /\bpreciso\b/gi,
    /\bmacinino\b/gi,
    /\bzero\b/gi,
  ];

  for (const pattern of modelPatterns) {
    const matches = query.match(pattern);
    if (matches) {
      models.push(...matches.map((m) => m.toLowerCase().replace(/\s+/g, '-')));
    }
  }

  return [...new Set(models)];
}

// ============================================
// Build RAG Context
// ============================================

export interface RAGContext {
  relevantProducts: Product[];
  relevantBrewGuides: BrewGuide[];
  relevantUseCases: UseCase[];
  detectedPersona: Persona | null;
  contentSummary: ContentSummary;
}

export function buildRAGContext(
  query: string,
  intent?: string,
  maxProducts = 12,
  maxBrewGuides = 6,
): RAGContext {
  const lowerQuery = query.toLowerCase();

  // Detect user persona
  const detectedPersona = detectPersona(query);

  // Extract use case keywords from query
  const detectedKeywords = extractKeywords(query);

  // Extract coffee terms from query
  const detectedCoffeeTerms = extractCoffeeTerms(query);

  // Extract product model names from query
  const productModels = extractProductModels(query);

  // ----- Find Relevant Products -----

  let relevantProducts: Product[] = [];

  // Search by extracted model names first (highest priority)
  if (productModels.length > 0) {
    for (const model of productModels) {
      const modelProducts = products.filter(
        (p) =>
          p.name.toLowerCase().includes(model) ||
          p.id?.toLowerCase().includes(model),
      );
      relevantProducts = [...relevantProducts, ...modelProducts];
    }
  }

  // Then try general search if no model matches
  if (relevantProducts.length === 0) {
    relevantProducts = searchProducts(query);
  }

  // If still no products, try keyword-based search
  if (relevantProducts.length === 0 && detectedKeywords.length > 0) {
    for (const keyword of detectedKeywords) {
      const keywordProducts = products.filter(
        (p) =>
          p.bestFor?.some((bf) => bf.toLowerCase().includes(keyword)) ||
          p.features?.some((f) => f.toLowerCase().includes(keyword)) ||
          p.description?.toLowerCase().includes(keyword),
      );
      relevantProducts = [...relevantProducts, ...keywordProducts];
    }
  }

  // If persona detected, add their recommended products
  if (detectedPersona && relevantProducts.length < maxProducts) {
    const personaMachines = detectedPersona.recommendedSetup?.machines || [];
    const personaGrinders = detectedPersona.recommendedSetup?.grinders || [];
    const personaProductIds = [...personaMachines, ...personaGrinders];
    const personaProducts = getProductsByIds(personaProductIds);
    relevantProducts = [
      ...relevantProducts,
      ...personaProducts.filter((p) => !relevantProducts.some((rp) => rp.id === p.id)),
    ];
  }

  // Fallback: provide top products if nothing matched
  if (relevantProducts.length === 0) {
    relevantProducts = products.slice(0, maxProducts);
  }

  // Dedupe and limit
  relevantProducts = [...new Map(relevantProducts.map((p) => [p.id, p])).values()].slice(
    0,
    maxProducts,
  );

  // ----- Feature-Aware Ranking -----

  // Espresso-specific feature ranking
  const featureRequirements: Record<string, string[]> = {
    'milk-drinks': ['dual-boiler', 'steam'],
    espresso: ['pid-control', 'pressure-profiling'],
    grinder: ['zero-retention', 'burr'],
    'home-barista': ['flow-control', 'pressure-profiling'],
    beginner: ['automatic', 'easy'],
    office: ['plumbed', 'capacity'],
  };

  // Products with dual-boiler for milk-drink queries
  const dualBoilerProducts = ['doppio', 'studio', 'studio-pro', 'ufficio'];

  // Products with zero/low retention for grinder queries
  const zeroRetentionProducts = ['zero', 'macinino'];

  const primaryUseCase = detectedKeywords.find((kw) => featureRequirements[kw]);
  if (primaryUseCase) {
    relevantProducts.sort((a, b) => {
      let aScore = 0;
      let bScore = 0;

      // Prioritise dual-boiler for milk-drink queries
      if (primaryUseCase === 'milk-drinks') {
        if (dualBoilerProducts.includes(a.id)) aScore += 10;
        if (dualBoilerProducts.includes(b.id)) bScore += 10;
      }

      // Prioritise zero-retention for grinder queries
      if (lowerQuery.includes('grind') || lowerQuery.includes('grinder')) {
        if (zeroRetentionProducts.includes(a.id)) aScore += 10;
        if (zeroRetentionProducts.includes(b.id)) bScore += 10;
      }

      // Check features array for required features
      const requiredFeatures = featureRequirements[primaryUseCase];
      for (const feature of requiredFeatures) {
        if (a.features?.some((f) => f.toLowerCase().includes(feature.replace('-', ' ')))) {
          aScore += 5;
        }
        if (b.features?.some((f) => f.toLowerCase().includes(feature.replace('-', ' ')))) {
          bScore += 5;
        }
      }

      return bScore - aScore;
    });
  }

  // ----- Find Relevant Use Cases -----

  let relevantUseCases = useCases.filter(
    (uc) =>
      lowerQuery.includes(uc.id) ||
      lowerQuery.includes(uc.name.toLowerCase()) ||
      uc.keywords?.some((k) => lowerQuery.includes(k.toLowerCase())) ||
      detectedKeywords.includes(uc.id),
  );

  if (relevantUseCases.length === 0) {
    relevantUseCases = useCases.slice(0, 3);
  }

  // ----- Find Relevant Brew Guides -----

  let relevantBrewGuides: BrewGuide[] = [];

  // PRIORITY 1: If coffee terms detected, use term-based search
  if (detectedCoffeeTerms.length > 0) {
    const termQuery = detectedCoffeeTerms.join(' ');
    const termGuides = searchBrewGuides(termQuery, maxBrewGuides * 2);
    relevantBrewGuides = [...termGuides];
  }

  // PRIORITY 2: Search using the full query
  if (relevantBrewGuides.length < maxBrewGuides) {
    const queryGuides = searchBrewGuides(query, maxBrewGuides);
    for (const g of queryGuides) {
      if (!relevantBrewGuides.some((existing) => existing.name === g.name)) {
        relevantBrewGuides.push(g);
      }
    }
  }

  // PRIORITY 3: Try category-based search
  if (relevantBrewGuides.length < maxBrewGuides) {
    for (const keyword of detectedKeywords) {
      const categoryGuides = brewGuides.filter(
        (r) =>
          r.category?.toLowerCase().includes(keyword) ||
          r.name.toLowerCase().includes(keyword) ||
          r.description?.toLowerCase().includes(keyword),
      );
      for (const g of categoryGuides) {
        if (!relevantBrewGuides.some((existing) => existing.name === g.name)) {
          relevantBrewGuides.push(g);
        }
      }
    }
  }

  // PRIORITY 4: From matched use cases
  if (relevantBrewGuides.length === 0 && relevantUseCases.length > 0) {
    for (const uc of relevantUseCases) {
      const ucGuides = getBrewGuidesByCategory(uc.id);
      relevantBrewGuides = [...relevantBrewGuides, ...ucGuides];
    }
  }

  // PRIORITY 5: Last resort - search by query words
  if (relevantBrewGuides.length === 0) {
    const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 3);
    relevantBrewGuides = brewGuides.filter((r) =>
      queryWords.some(
        (word) =>
          r.name.toLowerCase().includes(word) ||
          r.category?.toLowerCase().includes(word),
      ),
    );
  }

  // Final fallback
  if (relevantBrewGuides.length === 0) {
    relevantBrewGuides = brewGuides.slice(0, maxBrewGuides);
  }

  // Dedupe by name and limit
  relevantBrewGuides = [...new Map(relevantBrewGuides.map((r) => [r.name, r])).values()];

  // Diversity filter: limit per category
  const guidesByCategory = new Map<string, BrewGuide[]>();
  for (const guide of relevantBrewGuides) {
    const categoryKey = guide.subcategory || guide.category || 'other';
    const existing = guidesByCategory.get(categoryKey) || [];
    existing.push(guide);
    guidesByCategory.set(categoryKey, existing);
  }

  const diverseGuides: BrewGuide[] = [];
  const categoryKeys = [...guidesByCategory.keys()];
  const maxPerCategory = 2;
  let categoryIndex = 0;
  const itemsPerCategoryTaken = new Map<string, number>();

  while (diverseGuides.length < maxBrewGuides && categoryKeys.length > 0) {
    const category = categoryKeys[categoryIndex % categoryKeys.length];
    const categoryGuides = guidesByCategory.get(category) || [];
    const taken = itemsPerCategoryTaken.get(category) || 0;

    if (taken < maxPerCategory && taken < categoryGuides.length) {
      diverseGuides.push(categoryGuides[taken]);
      itemsPerCategoryTaken.set(category, taken + 1);
    }

    categoryIndex++;

    if (taken + 1 >= maxPerCategory || taken + 1 >= categoryGuides.length) {
      const catIdx = categoryKeys.indexOf(category);
      if (catIdx > -1) {
        categoryKeys.splice(catIdx, 1);
      }
      categoryIndex = 0;
    }
  }

  if (diverseGuides.length > 0) {
    relevantBrewGuides = diverseGuides;
  }

  relevantBrewGuides = relevantBrewGuides.slice(0, maxBrewGuides);

  return {
    relevantProducts,
    relevantBrewGuides,
    relevantUseCases,
    detectedPersona,
    contentSummary: getContentSummary(),
  };
}

// ============================================
// Default Export
// ============================================

export default {
  // Products
  getAllProducts,
  getProductById,
  getProductsByIds,
  getProductsBySeries,
  getProductsByPriceRange,
  getProductsByUseCase,
  searchProducts,

  // Brew Guides
  getAllBrewGuides,
  getBrewGuideById,
  getBrewGuidesByCategory,
  getBrewGuidesByDifficulty,
  getBrewGuidesForProduct,
  getBrewGuideCategories,
  searchBrewGuides,
  extractCoffeeTerms,

  // Use Cases & Features
  getAllUseCases,
  getUseCaseById,
  getAllFeatures,
  getFeatureById,
  getFeaturesForProduct,

  // Accessories
  getAllAccessories,
  getAccessoryById,
  getAccessoriesByType,
  getAccessoriesForProduct,
  searchAccessories,

  // Reviews
  getAllReviews,
  getReviewsByProduct,
  getReviewsByUseCase,
  getAverageRating,

  // Personas
  getAllPersonas,
  getPersonaById,
  detectPersona,

  // Product Profiles
  getProductProfile,
  getProductsForUseCase,
  getProductsByPriceTier,
  getProductsByHouseholdFit,

  // FAQs
  getAllFAQs,
  getFAQsByCategory,
  getFAQsForQuery,

  // Utilities
  getContentSummary,
  buildRAGContext,
};
