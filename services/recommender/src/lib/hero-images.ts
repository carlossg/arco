/**
 * Hero Image Configuration
 *
 * Maps user intents and use cases to curated hero images for the Arco
 * coffee equipment site. Uses DA media URLs since we don't have a CDN.
 */

function getMediaBase(): string {
  const org = process.env.DA_ORG;
  const repo = process.env.DA_REPO;
  if (!org || !repo) {
    throw new Error('DA_ORG and DA_REPO environment variables must be set');
  }
  return `https://content.da.live/${org}/${repo}/media`;
}

/**
 * Hero images organised by category/use-case.
 * Each category has multiple images for variety.
 * Paths are relative to ARCO_MEDIA_BASE.
 */
export const HERO_IMAGES: Record<string, string[]> = {
  // Espresso machines - hero shots
  espresso: [
    '/hero-espresso-machine.jpeg',
    '/product-primo.jpeg',
    '/product-doppio.jpeg',
    '/product-studio.jpeg',
  ],

  // Milk-based drinks - latte art, milk pitcher
  'milk-drinks': [
    '/hero-latte-art.jpeg',
    '/product-milk-pitcher.jpeg',
  ],

  // Grinders - zero retention, burr sets
  grinders: [
    '/product-zero.jpeg',
    '/product-macinino.jpeg',
    '/product-preciso.jpeg',
  ],

  // Travel / portable equipment
  travel: [
    '/product-viaggio.jpeg',
  ],

  // Office / commercial setups
  office: [
    '/product-ufficio.jpeg',
  ],

  // Default / general purpose
  default: [
    '/hero-espresso-machine.jpeg',
    '/product-studio.jpeg',
    '/product-primo.jpeg',
  ],
};

/**
 * Maps intent types to relevant hero image categories
 */
const INTENT_TO_CATEGORIES: Record<string, string[]> = {
  discovery: ['default', 'espresso', 'grinders'],
  comparison: ['default', 'espresso'],
  'product-detail': ['default'],
  'use-case': ['default'], // Overridden by specific use cases
  specs: ['default', 'espresso'],
  reviews: ['default'],
  price: ['default'],
  recommendation: ['default', 'espresso', 'milk-drinks'],
  support: ['default'],
  gift: ['espresso', 'grinders', 'default'],
  medical: ['default'],
  accessibility: ['default'],
};

/**
 * Maps use-case keywords to hero image categories
 */
const USE_CASE_TO_CATEGORY: Record<string, string> = {
  // Espresso
  espresso: 'espresso',
  shot: 'espresso',
  ristretto: 'espresso',
  lungo: 'espresso',
  extraction: 'espresso',
  // Milk drinks
  latte: 'milk-drinks',
  cappuccino: 'milk-drinks',
  'flat white': 'milk-drinks',
  cortado: 'milk-drinks',
  'latte art': 'milk-drinks',
  microfoam: 'milk-drinks',
  // Grinders
  grinder: 'grinders',
  grind: 'grinders',
  burr: 'grinders',
  'zero retention': 'grinders',
  // Travel
  travel: 'travel',
  portable: 'travel',
  camping: 'travel',
  // Office
  office: 'office',
  commercial: 'office',
  workplace: 'office',
};

/**
 * Selects an appropriate hero image based on intent, use cases, and query
 *
 * @param intentType - The classified intent type
 * @param useCases - Array of extracted use cases from the query
 * @param query - The original user query (for fallback keyword matching)
 * @returns Full URL to a hero image
 */
export function selectHeroImage(
  intentType?: string,
  useCases?: string[],
  query?: string,
): string {
  let selectedCategory = 'default';
  let candidateImages: string[] = [];

  // First, try to match based on specific use cases (most specific)
  if (useCases && useCases.length > 0) {
    for (const useCase of useCases) {
      const normalizedUseCase = useCase.toLowerCase().trim();

      // Check for exact match
      if (USE_CASE_TO_CATEGORY[normalizedUseCase]) {
        selectedCategory = USE_CASE_TO_CATEGORY[normalizedUseCase];
        break;
      }

      // Check for partial match
      for (const [keyword, category] of Object.entries(USE_CASE_TO_CATEGORY)) {
        if (normalizedUseCase.includes(keyword) || keyword.includes(normalizedUseCase)) {
          selectedCategory = category;
          break;
        }
      }

      if (selectedCategory !== 'default') break;
    }
  }

  // If no use case match, try matching keywords directly from the query
  if (selectedCategory === 'default' && query) {
    const normalizedQuery = query.toLowerCase();
    for (const [keyword, category] of Object.entries(USE_CASE_TO_CATEGORY)) {
      if (normalizedQuery.includes(keyword)) {
        selectedCategory = category;
        break;
      }
    }
  }

  // If still no match, fall back to intent-based selection
  if (selectedCategory === 'default' && intentType) {
    const intentCategories = INTENT_TO_CATEGORIES[intentType] || ['default'];
    // Pick a random category from the intent's associated categories
    selectedCategory = intentCategories[Math.floor(Math.random() * intentCategories.length)];
  }

  // Get images from the selected category
  candidateImages = HERO_IMAGES[selectedCategory] || HERO_IMAGES['default'];

  // If category has no images, fall back to default
  if (!candidateImages || candidateImages.length === 0) {
    candidateImages = HERO_IMAGES['default'];
  }

  // Randomly select an image from the candidates
  const selectedImage = candidateImages[Math.floor(Math.random() * candidateImages.length)];

  // Return full URL
  return `${getMediaBase()}${selectedImage}`;
}

/**
 * Gets all available categories for debugging/testing
 */
export function getAvailableCategories(): string[] {
  return Object.keys(HERO_IMAGES);
}

/**
 * Gets image count per category for debugging/testing
 */
export function getImageCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [category, images] of Object.entries(HERO_IMAGES)) {
    counts[category] = images.length;
  }
  return counts;
}
