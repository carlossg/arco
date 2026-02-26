/**
 * Hero Block — persona-aware hero with content swap based on arco_persona cookie.
 * Reads persona profiles and swaps headline, subtext, CTA, and image alt
 * for returning visitors with a known persona.
 *
 * Variants: campaign | product | experience | quiz-result (set via block class)
 *
 * Persona data is embedded as data attributes on the block:
 *   data-persona-{tag}-headline="..."
 *   data-persona-{tag}-subtext="..."
 *   data-persona-{tag}-cta-label="..."
 *   data-persona-{tag}-cta-url="..."
 *
 * If no data attributes, falls back to the authored content.
 */

/**
 * Reads the arco_persona cookie value.
 * @returns {string|null}
 */
function getPersona() {
  const match = document.cookie.match(/(?:^|;\s*)arco_persona=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Persona hero overrides — used when data attributes are not present.
 * These match the persona-profiles.json definitions.
 */
const HERO_OVERRIDES = {
  'morning-minimalist': {
    headline: 'One perfect cup. Every morning.',
    subtext: 'The Arco Primo is built for people who want quality without complexity. Heat up in 90 seconds, pull a beautiful shot, and start your day.',
    ctaLabel: 'Meet the Primo',
    ctaUrl: '/products/pdp-canonical/arco-primo',
  },
  upgrader: {
    headline: 'Ready for the real thing.',
    subtext: 'You\'ve outgrown your first machine. The Arco Doppio gives you dual-boiler precision without the learning cliff.',
    ctaLabel: 'Compare Machines',
    ctaUrl: '/products/comparison/arco-primo-vs-arco-doppio',
  },
  'craft-barista': {
    headline: 'Built for the obsessed.',
    subtext: 'The Arco Studio Pro puts pressure profiling, PID temperature control, and competition-grade build quality on your counter.',
    ctaLabel: 'Explore Studio Pro',
    ctaUrl: '/products/pdp-canonical/arco-studio-pro',
  },
  traveller: {
    headline: 'Espresso, everywhere.',
    subtext: 'The Arco Viaggio weighs 340g and pulls genuine espresso from a mountain ledge, a hotel room, or a campervan.',
    ctaLabel: 'Meet the Viaggio',
    ctaUrl: '/products/pdp-canonical/arco-viaggio',
  },
  'non-barista': {
    headline: 'Great coffee. No barista required.',
    subtext: 'The Arco Automatico grinds, tamps, and brews with one touch. Specialty-grade espresso without the learning curve.',
    ctaLabel: 'See the Automatico',
    ctaUrl: '/products/pdp-canonical/arco-automatico',
  },
  'office-manager': {
    headline: 'Office coffee that people actually look forward to.',
    subtext: 'The Arco Ufficio is built for teams — high-volume, easy to maintain, pays for itself in under six months.',
    ctaLabel: 'Calculate Savings',
    ctaUrl: '/tools/calculators/capsule-to-bean-cost-comparison',
  },
};

/**
 * Applies persona-specific content to the hero block.
 * @param {Element} block The hero block element
 * @param {string} persona The persona tag
 */
function applyPersonaOverride(block, persona) {
  // Try data attributes first, then fallback map
  const prefix = `persona-${persona}`;
  const headline = block.dataset[`${prefix}Headline`]
    || HERO_OVERRIDES[persona]?.headline;
  const subtext = block.dataset[`${prefix}Subtext`]
    || HERO_OVERRIDES[persona]?.subtext;
  const ctaLabel = block.dataset[`${prefix}CtaLabel`]
    || HERO_OVERRIDES[persona]?.ctaLabel;
  const ctaUrl = block.dataset[`${prefix}CtaUrl`]
    || HERO_OVERRIDES[persona]?.ctaUrl;

  if (!headline) return;

  // Replace headline
  const h1 = block.querySelector('h1');
  if (h1) h1.textContent = headline;

  // Replace subtext — first non-picture, non-button-container paragraph
  const subParagraphs = [...block.querySelectorAll('p')].filter(
    (p) => !p.querySelector('picture') && !p.classList.contains('button-container'),
  );
  if (subParagraphs.length > 0 && subtext) {
    subParagraphs[0].textContent = subtext;
  }

  // Replace primary CTA
  const primaryCta = block.querySelector('a.button:not(.secondary)') || block.querySelector('.button-container a');
  if (primaryCta && ctaLabel && ctaUrl) {
    primaryCta.textContent = ctaLabel;
    primaryCta.href = ctaUrl;
  }

  // Add persona class for potential CSS targeting
  block.classList.add(`hero-persona-${persona}`);
}

/**
 * Loads and decorates the hero block.
 * @param {Element} block The hero block element
 */
export default async function decorate(block) {
  const persona = getPersona();

  // Only apply persona overrides on the homepage or when block has campaign variant
  const isHomepage = window.location.pathname === '/' || window.location.pathname === '/index';
  const isCampaign = block.classList.contains('campaign');

  if (persona && (isHomepage || isCampaign)) {
    applyPersonaOverride(block, persona);
  }
}
