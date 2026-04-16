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
let activeController = null;

/**
 * Extract distinctive topic words from the most recent browsing history entries.
 * Deduplicates across pages and filters out generic section/stop words.
 */
function extractTopicWords(browsingHistory) {
  const sectionPaths = new Set([
    'stories', 'experiences', 'products', 'about', 'support', 'home', 'discover',
  ]);
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'with',
    'on', 'is', 'it', 'your', 'our', 'arco', 'guide', 'complete',
    'recommend', 'equipment', 'based', 'browsing', 'what', 'help',
  ]);

  const wordCounts = new Map();
  (browsingHistory || []).slice(-5)
    // Skip recommender-generated pages (cached under /discover/)
    .filter((visit) => !(visit.path || '').startsWith('/discover/'))
    .forEach((visit) => {
      const segments = (visit.path || '').split('/').filter(Boolean);
      segments
        .filter((s) => !sectionPaths.has(s))
        .flatMap((s) => s.split('-'))
        .filter((w) => w.length > 2 && !stopWords.has(w))
        .forEach((w) => wordCounts.set(w, (wordCounts.get(w) || 0) + 1));
    });

  // Sort by frequency (words appearing across multiple pages are strongest signals),
  // then return unique words
  return [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);
}

/**
 * Synthesize a natural-language query from the inferred browsing profile.
 * Produces a directive recommendation request so the backend classifies it
 * as a targeted use-case rather than generic exploration.
 * @param {Object} context - Session context from SessionContextManager
 * @returns {string}
 */
export function synthesizeQuery(context) {
  const { inferredProfile, browsingHistory } = context;
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
  } else if (browsingHistory && browsingHistory.length > 0) {
    // Build a directive query from the topic words found across visited pages
    const words = extractTopicWords(browsingHistory);
    if (words.length > 0) {
      const topic = words.slice(0, 4).join(' ');
      parts.push(`Recommend equipment for ${topic}`);
    }
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
  } else if (productsViewed.length > 0 || categoriesViewed.length > 0) {
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
 * Start a background POST fetch to pre-generate a "For You" page.
 * Streams NDJSON from /api/generate and saves lines to sessionStorage.
 * @param {string} query - Synthesized query
 */
async function startForYouPrefetch(query) {
  // Abort any in-flight prefetch
  if (activeController) {
    activeController.abort();
    activeController = null;
  }

  const controller = new AbortController();
  activeController = controller;

  const contextParam = SessionContextManager.buildContextParam();

  window.dispatchEvent(new CustomEvent('arco-foryou-started'));

  try {
    const response = await fetch(`${ARCO_RECOMMENDER_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, context: contextParam, speculative: true }),
      signal: controller.signal,
    });

    if (!response.ok) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ndjsonLines = [];
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach((line) => { if (line.trim()) ndjsonLines.push(line); });
    }
    if (buffer.trim()) ndjsonLines.push(buffer.trim());

    if (controller.signal.aborted) return;

    try {
      sessionStorage.setItem(FORYOU_PREFETCH_KEY, JSON.stringify({
        query,
        ndjsonLines,
        isComplete: true,
        timestamp: Date.now(),
      }));
      sessionStorage.setItem(FORYOU_QUERY_KEY, query);
    } catch {
      // sessionStorage unavailable
    }

    window.dispatchEvent(new CustomEvent('arco-foryou-ready'));
  } catch (err) {
    if (err.name !== 'AbortError') {
      // Best-effort background prefetch — failure is non-critical
    }
  } finally {
    if (activeController === controller) activeController = null;
  }
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
