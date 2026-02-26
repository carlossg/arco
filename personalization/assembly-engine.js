/**
 * Assembly Engine — runtime page composition based on persona signal
 * Provides functions for assembling personalized page content from
 * the content corpus. Vanilla ES6+, no framework dependencies.
 */

import { getPersonaFromCookie } from './quiz-logic.js';

/**
 * Hero content variants keyed by persona tag.
 */
const HERO_VARIANTS = {
  default: {
    headline: 'Precision Brewing, Beautiful Design',
    subtext: 'Arco crafts espresso machines and grinders for people who care about every detail — from bean to cup.',
    cta: { label: 'Explore Machines', url: '/products/espresso-machines' },
    image_alt: 'Arco espresso machine brewing a perfect shot on a sunlit kitchen counter',
  },
  'morning-minimalist': {
    headline: 'One perfect cup. Every morning.',
    subtext: 'The Arco Primo is built for people who want quality without complexity. Heat up in 90 seconds, pull a beautiful shot, and start your day.',
    cta: { label: 'Meet the Primo', url: '/products/pdp-canonical/arco-primo' },
    image_alt: 'A calm kitchen counter at dawn with a single espresso in a white ceramic cup next to the Arco Primo',
  },
  upgrader: {
    headline: 'Ready for the real thing.',
    subtext: 'You\'ve outgrown your first machine. The Arco Doppio gives you dual-boiler precision without the learning cliff.',
    cta: { label: 'Compare Machines', url: '/products/comparison/arco-primo-vs-arco-doppio' },
    image_alt: 'The Arco Doppio on a modern kitchen counter with a fresh double shot, steam wand in action',
  },
  'craft-barista': {
    headline: 'Built for the obsessed.',
    subtext: 'The Arco Studio Pro puts pressure profiling, PID temperature control, and competition-grade build quality on your counter.',
    cta: { label: 'Explore Studio Pro', url: '/products/pdp-canonical/arco-studio-pro' },
    image_alt: 'Close-up of the Arco Studio Pro pressure gauge and portafilter with a perfectly extracted shot flowing',
  },
  traveller: {
    headline: 'Espresso, everywhere.',
    subtext: 'The Arco Viaggio weighs 340g and pulls genuine espresso from a mountain ledge, a hotel room, or a campervan.',
    cta: { label: 'Meet the Viaggio', url: '/products/pdp-canonical/arco-viaggio' },
    image_alt: 'The Arco Viaggio portable espresso maker on a granite rock with mountain peaks in soft focus behind',
  },
  'non-barista': {
    headline: 'Great coffee. No barista required.',
    subtext: 'The Arco Automatico grinds, tamps, and brews with one touch. Specialty-grade espresso without the learning curve.',
    cta: { label: 'See the Automatico', url: '/products/pdp-canonical/arco-automatico' },
    image_alt: 'The Arco Automatico with a freshly brewed espresso, simple one-button interface visible',
  },
  'office-manager': {
    headline: 'Office coffee that people actually look forward to.',
    subtext: 'The Arco Ufficio is built for teams — high-volume, easy to maintain, and pays for itself in under six months.',
    cta: { label: 'Calculate Savings', url: '/tools/calculators/capsule-to-bean-cost-comparison' },
    image_alt: 'The Arco Ufficio in a bright modern office kitchen with multiple cups ready to serve',
  },
};

/**
 * Product recommendations keyed by persona tag.
 */
const PRODUCT_RECS = {
  default: ['arco-primo', 'arco-doppio', 'arco-studio', 'arco-macinino', 'arco-preciso', 'arco-zero'],
  'morning-minimalist': ['arco-nano', 'arco-primo', 'arco-macinino', 'arco-filtro', 'arco-doppio', 'arco-preciso'],
  upgrader: ['arco-doppio', 'arco-studio', 'arco-preciso', 'arco-primo', 'arco-macinino', 'arco-zero'],
  'craft-barista': ['arco-studio-pro', 'arco-zero', 'arco-studio', 'arco-preciso', 'arco-filtro', 'arco-doppio'],
  traveller: ['arco-viaggio', 'arco-nano', 'arco-macinino', 'arco-primo', 'arco-filtro', 'arco-doppio'],
  'non-barista': ['arco-automatico', 'arco-nano', 'arco-primo', 'arco-macinino', 'arco-doppio', 'arco-preciso'],
  'office-manager': ['arco-ufficio', 'arco-doppio', 'arco-preciso', 'arco-studio', 'arco-automatico', 'arco-macinino'],
};

/**
 * Blog feed priorities keyed by persona tag.
 */
const BLOG_FEEDS = {
  default: [
    'why-your-grinder-matters-more-than-your-machine',
    'a-visit-to-our-workshop',
    'the-architect-who-built-a-coffee-corner',
  ],
  'morning-minimalist': [
    '10-most-common-beginner-mistakes',
    'how-to-dial-in-espresso-in-under-10-minutes',
    'how-to-store-beans-properly',
  ],
  upgrader: [
    'why-your-grinder-matters-more-than-your-machine',
    'pre-infusion-what-it-is-and-why-arco-uses-it',
    'how-to-clean-a-group-head',
  ],
  'craft-barista': [
    'why-arco-chose-brass-for-the-studio-boiler',
    'blind-tasting-your-espresso',
    'calibrating-a-burr-grinder',
  ],
  traveller: [
    'the-van-lifer-and-the-viaggio',
    'espresso-bars-worth-visiting-in-milan',
    'altitude-and-espresso',
  ],
  'non-barista': [
    '10-most-common-beginner-mistakes',
    'descaling-step-by-step',
    'how-to-store-beans-properly',
  ],
  'office-manager': [
    'the-startup-office-upgrade',
    'descaling-step-by-step',
    'coffee-certifications-explained',
  ],
};

/**
 * Experience CTA data keyed by persona tag.
 */
const EXPERIENCE_CTAS = {
  default: {
    archetype: 'Discover Your Style',
    headline: 'Not sure where to start?',
    body: 'Take our 30-second quiz and we\'ll match you with the right setup.',
    cta: { label: 'Find Your Brew Style', url: '/experiences/core/morning-minimalist' },
    image_alt: 'A warm kitchen scene with multiple Arco machines arranged from simple to advanced',
  },
  'morning-minimalist': {
    archetype: 'The Morning Minimalist',
    headline: 'Your morning, simplified.',
    body: 'Everything you need for a calm, quality-first start to the day.',
    cta: { label: 'See Your Setup', url: '/experiences/core/morning-minimalist' },
    image_alt: 'A calm sunrise kitchen with a single espresso and the Arco Primo',
  },
  upgrader: {
    archetype: 'The Upgrade Path',
    headline: 'Ready for the next level?',
    body: 'See what a real upgrade looks like and what it means for your daily cup.',
    cta: { label: 'Explore Upgrades', url: '/experiences/core/the-upgrade-path' },
    image_alt: 'Side by side comparison of entry-level and mid-range Arco equipment',
  },
  'craft-barista': {
    archetype: 'Craft at Home',
    headline: 'The home setup you deserve.',
    body: 'Professional-grade equipment, pro-level technique guides, zero compromises.',
    cta: { label: 'Build Your Station', url: '/experiences/core/craft-at-home' },
    image_alt: 'A dedicated coffee corner with the Arco Studio Pro, Zero grinder, and full accessories',
  },
  traveller: {
    archetype: 'Espresso Anywhere',
    headline: 'Your coffee, wherever you go.',
    body: 'Compact gear, travel guides, and the freedom to brew anywhere on earth.',
    cta: { label: 'Pack Your Kit', url: '/experiences/core/espresso-anywhere' },
    image_alt: 'The Arco Viaggio on a wooden table overlooking a mountain landscape',
  },
  'non-barista': {
    archetype: 'The Non-Barista',
    headline: 'No skills required.',
    body: 'Specialty-grade coffee with one button press. Welcome to the easy life.',
    cta: { label: 'See How Easy It Is', url: '/experiences/core/the-non-barista' },
    image_alt: 'A person pressing a single button on the Arco Automatico with a perfect espresso appearing',
  },
  'office-manager': {
    archetype: 'Office Solutions',
    headline: 'Coffee that runs itself.',
    body: 'High-volume, low-maintenance equipment that your entire team will thank you for.',
    cta: { label: 'Office Setup Guide', url: '/bundles/persona-kits/upgrader-kit' },
    image_alt: 'The Arco Ufficio in a bright office kitchen with happy colleagues',
  },
};

/**
 * Returns hero variant data for a given persona tag.
 * @param {string} personaTag The persona identifier (or null for default)
 * @returns {object} Hero block data object
 */
export function getHeroVariant(personaTag) {
  return HERO_VARIANTS[personaTag] || HERO_VARIANTS.default;
}

/**
 * Returns ordered product recommendations for a persona.
 * @param {string} personaTag The persona identifier
 * @param {number} limit Maximum number of products to return
 * @returns {string[]} Ordered array of product slug IDs
 */
export function getProductRecommendations(personaTag, limit = 3) {
  const recs = PRODUCT_RECS[personaTag] || PRODUCT_RECS.default;
  return recs.slice(0, limit);
}

/**
 * Returns filtered and sorted blog post IDs for a persona.
 * @param {string} personaTag The persona identifier
 * @param {number} limit Maximum number of posts to return
 * @returns {string[]} Ordered array of blog post slug IDs
 */
export function getBlogFeed(personaTag, limit = 3) {
  const feed = BLOG_FEEDS[personaTag] || BLOG_FEEDS.default;
  return feed.slice(0, limit);
}

/**
 * Returns experience CTA block data for a persona.
 * @param {string} personaTag The persona identifier
 * @returns {object} CTA block data object
 */
export function getExperienceCTA(personaTag) {
  return EXPERIENCE_CTAS[personaTag] || EXPERIENCE_CTAS.default;
}

/**
 * Returns navigation customization for a persona.
 * @param {string} personaTag The persona identifier
 * @returns {object} Navigation override object with promoted/demoted items
 */
export function getNavigationOverride(personaTag) {
  const overrides = {
    'morning-minimalist': {
      promote: ['/products/espresso-machines', '/guides/fundamentals/your-first-week-with-a-machine'],
      demote: ['/guides/advanced/flow-control-profiling'],
      cta: { label: 'Your Morning Setup', url: '/experiences/core/morning-minimalist' },
    },
    upgrader: {
      promote: ['/products/comparison/arco-primo-vs-arco-doppio', '/guides/intermediate/dialing-in-new-beans'],
      demote: ['/guides/fundamentals/tamping-technique'],
      cta: { label: 'Find Your Upgrade', url: '/experiences/core/the-upgrade-path' },
    },
    'craft-barista': {
      promote: ['/guides/advanced/flow-control-profiling', '/products/espresso-machines'],
      demote: ['/guides/fundamentals/what-is-extraction'],
      cta: { label: 'Pro Setup', url: '/experiences/core/craft-at-home' },
    },
    traveller: {
      promote: ['/blog/travel/espresso-bars-worth-visiting-in-milan', '/products/espresso-machines'],
      demote: ['/guides/advanced/flow-control-profiling'],
      cta: { label: 'Travel Gear', url: '/experiences/core/espresso-anywhere' },
    },
    'non-barista': {
      promote: ['/products/espresso-machines', '/guides/fundamentals/your-first-week-with-a-machine'],
      demote: ['/guides/advanced/tds-and-extraction-yield'],
      cta: { label: 'Easy Setup', url: '/experiences/core/the-non-barista' },
    },
    'office-manager': {
      promote: ['/tools/calculators/capsule-to-bean-cost-comparison', '/products/espresso-machines'],
      demote: ['/guides/advanced/flow-control-profiling'],
      cta: { label: 'Office Solutions', url: '/bundles/persona-kits/upgrader-kit' },
    },
  };
  return overrides[personaTag] || { promote: [], demote: [], cta: null };
}

/**
 * Composes a full page data object from base content and persona signal.
 * @param {string} pageType The page type (homepage, pdp, guide, blog, experience, tool, bundle)
 * @param {string} personaTag The persona identifier (or null)
 * @param {object} baseContent The base content data object
 * @returns {object} Assembled page data with persona-specific overrides applied
 */
export function composePage(pageType, personaTag, baseContent) {
  const persona = personaTag || getPersonaFromCookie();
  const assembled = { ...baseContent };

  if (pageType === 'homepage') {
    assembled.hero = getHeroVariant(persona);
    assembled.products = getProductRecommendations(persona, 3);
    assembled.blog_feed = getBlogFeed(persona, 3);
    assembled.experience_cta = getExperienceCTA(persona);
    assembled.nav_override = getNavigationOverride(persona);
  }

  if (pageType === 'pdp' && persona && baseContent.persona_overrides?.[persona]) {
    Object.assign(assembled, baseContent.persona_overrides[persona]);
  }

  assembled._persona = persona;
  assembled._assembled_at = new Date().toISOString();

  return assembled;
}
