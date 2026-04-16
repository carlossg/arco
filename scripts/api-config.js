/**
 * Arco - API Configuration (Cloudflare Worker)
 *
 * Central configuration for all API endpoints.
 * Recommender runs on Cloudflare Workers with Cerebras LLM inference.
 */

// ============================================
// Cloudflare Worker Endpoints
// ============================================

// Main recommender service (Cloudflare Worker)
export const ARCO_RECOMMENDER_URL = window.ARCO_CONFIG?.RECOMMENDER_URL
  || 'https://arco-recommender.franklin-prod.workers.dev';

// ============================================
// Environment Detection
// ============================================

export const IS_PRODUCTION = !window.location.hostname.includes('localhost')
  && !window.location.hostname.includes('preview');

export const IS_LOCAL = window.location.hostname.includes('localhost');

// ============================================
// Configuration Helper
// ============================================

/**
 * Get the appropriate API endpoint for the current environment.
 * Accepts an optional service name argument (currently only 'recommender' exists).
 */
export function getAPIEndpoint() {
  if (window.ARCO_CONFIG?.RECOMMENDER_URL) {
    return window.ARCO_CONFIG.RECOMMENDER_URL;
  }
  return ARCO_RECOMMENDER_URL;
}

/**
 * Log API configuration on page load
 */
if (IS_LOCAL) {
  // eslint-disable-next-line no-console
  console.log('[Arco] API Configuration:', {
    recommender: ARCO_RECOMMENDER_URL,
    environment: IS_PRODUCTION ? 'production' : 'development',
  });
}
