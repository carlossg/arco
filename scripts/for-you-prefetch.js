/**
 * "For You" Background Prefetch
 *
 * After 2+ page visits, synthesizes a personalized query from the user's
 * browsing context and pre-generates a recommender page in the background.
 * When the user clicks "For You" in the nav, the result renders instantly.
 *
 * Loaded in the delayed phase via delayed.js — zero impact on LCP.
 */

import { SessionContextManager } from './session-context.js';
import { ARCO_RECOMMENDER_URL } from './api-config.js';

export const FORYOU_PREFETCH_KEY = 'arco-foryou-prefetch';
export const FORYOU_QUERY_KEY = 'arco-foryou-query';

const MIN_PAGE_VISITS = 2;
const DEBOUNCE_MS = 30000;

let lastPrefetchTime = 0;
let lastPrefetchSnapshot = null;
let activeEventSource = null;

/**
 * Synthesize a natural-language query from the inferred browsing profile.
 * @param {Object} context - Session context from SessionContextManager
 * @returns {string}
 */
function synthesizeQuery(context) {
  const { inferredProfile } = context;
  if (!inferredProfile) return 'Recommend coffee equipment based on my browsing';

  const {
    productsViewed = [],
    categoriesViewed = [],
    journeyStage = 'exploring',
    interests = [],
    quizAnswers,
  } = inferredProfile;

  const parts = [];

  // Reference products by name if viewed
  if (productsViewed.length > 0) {
    const names = productsViewed
      .map((slug) => slug.replace(/-/g, ' '))
      .slice(0, 3);
    parts.push(`I've been looking at the ${names.join(' and ')}`);
  } else if (categoriesViewed.length > 0) {
    const cats = categoriesViewed
      .map((c) => c.replace(/-/g, ' '))
      .slice(0, 2);
    parts.push(`I'm interested in ${cats.join(' and ')}`);
  }

  // Add interest context
  if (interests.length > 0) {
    parts.push(`interested in ${interests.slice(0, 2).join(' and ')}`);
  }

  // Add quiz context
  if (quizAnswers && Object.keys(quizAnswers).length > 0) {
    parts.push('based on my quiz answers');
  }

  // Journey-stage framing
  if (journeyStage === 'comparing') {
    parts.push('help me compare my options');
  } else if (journeyStage === 'deciding') {
    parts.push('help me decide which to choose');
  } else if (parts.length > 0) {
    parts.push('what do you recommend?');
  }

  if (parts.length === 0) {
    return 'Recommend coffee equipment based on my browsing';
  }

  // Capitalize first letter and join with punctuation
  const query = parts.join('. ').replace(/\.\s*\./g, '.');
  return query.charAt(0).toUpperCase() + query.slice(1);
}

/**
 * Check if the browsing context has changed significantly since the last prefetch.
 * @param {Object} current - Current inferred profile
 * @param {Object} previous - Snapshot from last prefetch
 * @returns {boolean}
 */
function hasSignificantChange(current, previous) {
  if (!previous) return true;
  if (!current) return false;

  // New product viewed
  const prevProducts = new Set(previous.productsViewed || []);
  const newProducts = (current.productsViewed || []).some((p) => !prevProducts.has(p));
  if (newProducts) return true;

  // Journey stage changed
  if (current.journeyStage !== previous.journeyStage) return true;

  // Quiz taken since last prefetch
  const prevQuizCount = Object.keys(previous.quizAnswers || {}).length;
  const curQuizCount = Object.keys(current.quizAnswers || {}).length;
  if (curQuizCount > prevQuizCount) return true;

  // 2+ new page visits since last prefetch
  const prevPages = previous.pagesVisited || 0;
  const curPages = current.pagesVisited || 0;
  if (curPages - prevPages >= 2) return true;

  return false;
}

/**
 * Start a background EventSource to pre-generate a "For You" page.
 * @param {string} query - Synthesized query
 */
function startForYouPrefetch(query) {
  // Close any existing connection
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }

  const contextParam = SessionContextManager.buildEncodedContextParam();
  const preset = new URLSearchParams(window.location.search).get('preset') || 'production';
  const url = `${ARCO_RECOMMENDER_URL}/generate?query=${encodeURIComponent(query)}&preset=${encodeURIComponent(preset)}&ctx=${contextParam}`;

  window.dispatchEvent(new CustomEvent('arco-foryou-started'));

  try {
    activeEventSource = new EventSource(url);
  } catch {
    activeEventSource = null;
    return;
  }

  const blocks = [];
  let metadata = {};

  activeEventSource.addEventListener('block-content', (e) => {
    try {
      const data = JSON.parse(e.data);
      blocks.push({ html: data.html, sectionStyle: data.sectionStyle });
    } catch {
      // ignore parse errors
    }
  });

  activeEventSource.addEventListener('generation-complete', (e) => {
    try {
      metadata = JSON.parse(e.data);
    } catch {
      // ignore parse errors
    }
    activeEventSource.close();
    activeEventSource = null;

    // Save to sessionStorage
    try {
      sessionStorage.setItem(FORYOU_PREFETCH_KEY, JSON.stringify({
        query,
        blocks,
        metadata,
        isComplete: true,
        timestamp: Date.now(),
      }));
      sessionStorage.setItem(FORYOU_QUERY_KEY, query);
    } catch {
      // sessionStorage unavailable
    }

    window.dispatchEvent(new CustomEvent('arco-foryou-ready'));
  });

  activeEventSource.addEventListener('error', () => {
    activeEventSource.close();
    activeEventSource = null;
  });

  activeEventSource.onerror = () => {
    if (activeEventSource && activeEventSource.readyState === EventSource.CLOSED) {
      activeEventSource = null;
    }
  };
}

/**
 * Attempt a prefetch if conditions are met (enough visits, debounce, significant change).
 */
function attemptPrefetch() {
  const context = SessionContextManager.getContext();
  const { browsingHistory = [], inferredProfile } = context;

  // Need at least MIN_PAGE_VISITS
  if (browsingHistory.length < MIN_PAGE_VISITS) return;

  // Debounce — don't prefetch more than once per DEBOUNCE_MS
  const now = Date.now();
  if (now - lastPrefetchTime < DEBOUNCE_MS) return;

  // Only prefetch if context changed significantly
  if (!hasSignificantChange(inferredProfile, lastPrefetchSnapshot)) return;

  const query = synthesizeQuery(context);
  if (!query) return;

  lastPrefetchTime = now;
  lastPrefetchSnapshot = inferredProfile ? { ...inferredProfile } : null;

  // Store the query so the header link can use it
  try {
    sessionStorage.setItem(FORYOU_QUERY_KEY, query);
  } catch {
    // sessionStorage unavailable
  }

  // eslint-disable-next-line no-console
  console.log('[ForYou] Starting background prefetch:', query);
  startForYouPrefetch(query);
}

/**
 * Initialize the "For You" background prefetch system.
 * Call from delayed.js after collectBrowsingSignals().
 */
export function initForYouPrefetch() {
  // Skip on recommender pages
  const params = new URLSearchParams(window.location.search);
  if (params.has('q') || params.has('query')) return;

  // Listen for context updates from browsing-signals.js
  window.addEventListener('arco-context-updated', () => {
    attemptPrefetch();
  });

  // Also attempt immediately — context may exist from previous pages
  attemptPrefetch();
}
