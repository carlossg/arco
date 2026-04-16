/**
 * Session Context Manager
 *
 * Manages query history for contextual browsing within a browser tab session.
 * Uses sessionStorage - context resets when tab closes.
 */

const CONTEXT_KEY = 'arco-session-context';
const MAX_HISTORY = 10;
const MAX_BROWSING_HISTORY = 15;
const MAX_SHOWN_ITEMS = 20;

// In-memory write-through cache — avoids redundant JSON parse/stringify on every call
let contextCache = null;

function saveContext(context) {
  contextCache = context;
  try {
    sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(context));
  } catch {
    // sessionStorage unavailable (private browsing, storage quota, etc.)
  }
}

/**
 * Session Context Manager - handles reading/writing query history for contextual browsing
 */
export class SessionContextManager {
  /**
   * Get the current session context. Reads from in-memory cache when available,
   * falling back to sessionStorage on first access.
   * @returns {Object}
   */
  static getContext() {
    if (contextCache) return contextCache;
    try {
      const stored = sessionStorage.getItem(CONTEXT_KEY);
      if (stored) {
        const context = JSON.parse(stored);
        // Ensure sessionId exists for older sessions
        if (!context.sessionId) {
          context.sessionId = crypto.randomUUID();
        }
        contextCache = context;
        return context;
      }
    } catch (e) {
      // Ignore parse errors, return fresh context
    }
    contextCache = {
      queries: [],
      browsingHistory: [],
      inferredProfile: null,
      shownProducts: [],
      shownSections: [],
      generatedQueries: [],
      sessionStart: Date.now(),
      lastUpdated: Date.now(),
      sessionId: crypto.randomUUID(),
    };
    return contextCache;
  }

  /**
   * Add a query to the session history
   * @param {Object} entry - The query entry to add
   */
  static addQuery(entry) {
    const context = this.getContext();

    // Ensure entry has required fields + enriched context fields
    const normalizedEntry = {
      query: entry.query || '',
      timestamp: entry.timestamp || Date.now(),
      intent: entry.intent || 'general',
      entities: {
        products: entry.entities?.products || [],
        coffeeTerms: entry.entities?.coffeeTerms || [],
        goals: entry.entities?.goals || [],
      },
      generatedPath: entry.generatedPath || '',
      // Enriched context fields
      recommendedProducts: entry.recommendedProducts || [],
      recommendedBrewGuides: entry.recommendedBrewGuides || [],
      blockTypes: entry.blockTypes || [],
      journeyStage: entry.journeyStage || 'exploring',
      confidence: entry.confidence || 0.5,
      nextBestAction: entry.nextBestAction || '',
    };

    context.queries.push(normalizedEntry);

    // Keep only the last MAX_HISTORY queries
    if (context.queries.length > MAX_HISTORY) {
      context.queries = context.queries.slice(-MAX_HISTORY);
    }

    context.lastUpdated = Date.now();
    saveContext(context);
  }

  /**
   * Build the context parameter object to pass to the worker
   * @returns {Object} Context param with previousQueries array
   */
  static buildContextParam() {
    const context = this.getContext();
    const param = {
      previousQueries: context.queries.map((q) => ({
        query: q.query,
        intent: q.intent,
        entities: q.entities,
        recommendedProducts: q.recommendedProducts,
        recommendedBrewGuides: q.recommendedBrewGuides,
        blockTypes: q.blockTypes,
        journeyStage: q.journeyStage,
        confidence: q.confidence,
        nextBestAction: q.nextBestAction,
      })),
    };

    if (context.browsingHistory && context.browsingHistory.length > 0) {
      param.browsingHistory = context.browsingHistory;
    }
    if (context.inferredProfile) {
      param.inferredProfile = context.inferredProfile;
    }

    // Include shown content for deduplication
    const shownContent = this.getShownContent();
    if (shownContent.shownProducts.length > 0
      || shownContent.shownSections.length > 0
      || shownContent.generatedQueries.length > 0) {
      param.shownContent = shownContent;
    }

    return param;
  }

  /**
   * Build a URL-safe encoded context parameter string
   * @returns {string} URL-encoded JSON string
   */
  static buildEncodedContextParam() {
    const contextParam = this.buildContextParam();
    return encodeURIComponent(JSON.stringify(contextParam));
  }

  /**
   * Check if we have any previous queries in this session
   * @returns {boolean}
   */
  static hasContext() {
    const context = this.getContext();
    return context.queries.length > 0
      || (context.browsingHistory && context.browsingHistory.length > 0);
  }

  /**
   * Get the session ID for analytics tracking
   * @returns {string}
   */
  static getSessionId() {
    const context = this.getContext();
    return context.sessionId;
  }

  /**
   * Get the consecutive query count for this session
   * @returns {number}
   */
  static getConsecutiveQueryCount() {
    const context = this.getContext();
    return context.queries.length;
  }

  /**
   * Get the most recent query (if any)
   * @returns {Object|null}
   */
  static getLastQuery() {
    const context = this.getContext();
    if (context.queries.length === 0) return null;
    return context.queries[context.queries.length - 1];
  }

  /**
   * Get all products mentioned across all queries in this session
   * @returns {string[]}
   */
  static getAllProducts() {
    const context = this.getContext();
    const products = new Set();
    context.queries.forEach((q) => {
      q.entities.products.forEach((p) => products.add(p));
    });
    return [...products];
  }

  /**
   * Get all coffee terms mentioned across all queries in this session
   * @returns {string[]}
   */
  static getAllCoffeeTerms() {
    const context = this.getContext();
    const terms = new Set();
    context.queries.forEach((q) => {
      q.entities.coffeeTerms.forEach((t) => terms.add(t));
    });
    return [...terms];
  }

  /**
   * Add a page visit to the browsing history
   * @param {Object} visit - Page visit signal
   */
  static addPageVisit(visit) {
    const context = this.getContext();
    if (!context.browsingHistory) context.browsingHistory = [];

    context.browsingHistory.push({
      path: visit.path,
      title: visit.title || '',
      blocks: visit.blocks || [],
      intent: visit.intent || 'discovery',
      stage: visit.stage || 'exploring',
      timestamp: visit.timestamp || Date.now(),
      timeSpent: 0,
      scrollDepth: 0,
    });

    if (context.browsingHistory.length > MAX_BROWSING_HISTORY) {
      context.browsingHistory = context.browsingHistory.slice(-MAX_BROWSING_HISTORY);
    }

    context.lastUpdated = Date.now();
    saveContext(context);
  }

  /**
   * Update the last page visit with engagement data (time spent, scroll depth)
   * @param {Object} engagement - Engagement data
   */
  static updateLastPageVisit(engagement) {
    const context = this.getContext();
    if (!context.browsingHistory || context.browsingHistory.length === 0) return;

    const last = context.browsingHistory[context.browsingHistory.length - 1];
    if (engagement.timeSpent !== undefined) last.timeSpent = engagement.timeSpent;
    if (engagement.scrollDepth !== undefined) last.scrollDepth = engagement.scrollDepth;

    context.lastUpdated = Date.now();
    saveContext(context);
  }

  /**
   * Update the inferred user profile from browsing signals
   * @param {Object} profile - Inferred profile from the local classifier
   */
  static updateInferredProfile(profile) {
    const context = this.getContext();
    context.inferredProfile = profile;
    context.lastUpdated = Date.now();
    saveContext(context);
  }

  /**
   * Get the browsing context for the backend (history + profile)
   * @returns {Object}
   */
  static getBrowsingContext() {
    const context = this.getContext();
    return {
      browsingHistory: context.browsingHistory || [],
      inferredProfile: context.inferredProfile || null,
    };
  }

  /**
   * Record a product ID that has been shown in rendered sections.
   * @param {string} productId The product ID
   */
  static addShownProduct(productId) {
    const context = this.getContext();
    if (!context.shownProducts) context.shownProducts = [];
    if (!context.shownProducts.includes(productId)) {
      context.shownProducts.push(productId);
      if (context.shownProducts.length > MAX_SHOWN_ITEMS) {
        context.shownProducts = context.shownProducts.slice(-MAX_SHOWN_ITEMS);
      }
      context.lastUpdated = Date.now();
      saveContext(context);
    }
  }

  /**
   * Record a section that has been rendered on the page.
   * @param {Object} section - { blockType, headline }
   */
  static addShownSection(section) {
    const context = this.getContext();
    if (!context.shownSections) context.shownSections = [];
    context.shownSections.push({
      blockType: section.blockType || '',
      headline: section.headline || '',
    });
    if (context.shownSections.length > MAX_SHOWN_ITEMS) {
      context.shownSections = context.shownSections.slice(-MAX_SHOWN_ITEMS);
    }
    context.lastUpdated = Date.now();
    saveContext(context);
  }

  /**
   * Record a query that produced a keep-exploring turn.
   * @param {string} query The generated query
   */
  static addGeneratedQuery(query) {
    const context = this.getContext();
    if (!context.generatedQueries) context.generatedQueries = [];
    if (!context.generatedQueries.includes(query)) {
      context.generatedQueries.push(query);
      if (context.generatedQueries.length > MAX_SHOWN_ITEMS) {
        context.generatedQueries = context.generatedQueries.slice(-MAX_SHOWN_ITEMS);
      }
    }
    context.lastUpdated = Date.now();
    saveContext(context);
  }

  /**
   * Get shown content data for deduplication in backend requests.
   * @returns {Object} { shownProducts, shownSections, generatedQueries }
   */
  static getShownContent() {
    const context = this.getContext();
    return {
      shownProducts: context.shownProducts || [],
      shownSections: context.shownSections || [],
      generatedQueries: context.generatedQueries || [],
    };
  }

  /**
   * Clear the session context (useful for testing)
   */
  static clear() {
    contextCache = null;
    sessionStorage.removeItem(CONTEXT_KEY);
  }

  /**
   * Format context as a human-readable summary (for debugging)
   * @returns {string}
   */
  static formatSummary() {
    const context = this.getContext();
    if (context.queries.length === 0) {
      return 'No previous queries in this session.';
    }
    return context.queries
      .map((q, i) => `${i + 1}. "${q.query}" (${q.intent})`)
      .join('\n');
  }
}

export default SessionContextManager;
