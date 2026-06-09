/**
 * Arco - API Configuration (Cloudflare Worker)
 *
 * Central configuration for all API endpoints.
 * Recommender runs on Cloudflare Workers with Cerebras LLM inference.
 */

// ============================================
// Cloudflare Worker Endpoints
// ============================================

const PRODUCTION_WORKER = 'https://arco-recommender.franklin-prod.workers.dev';

/**
 * Detect EDS branch preview hostname: {branch}--{repo}--{owner}.aem.page
 * On a non-main branch preview, rewrite the worker URL to the branch alias version.
 * e.g. branch "feature-x" → https://feature-x-arco-recommender.franklin-prod.workers.dev
 */
function resolveBranchWorkerURL() {
  if (window.ARCO_CONFIG?.RECOMMENDER_URL) return window.ARCO_CONFIG.RECOMMENDER_URL;

  const { hostname } = window.location;
  const match = hostname.match(/^(.+)--[^.]+--[^.]+\.aem\.page$/);
  if (!match || match[1] === 'main') return PRODUCTION_WORKER;

  const alias = match[1]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `https://${alias}-arco-recommender.franklin-prod.workers.dev`;
}

// Main recommender service (Cloudflare Worker)
export const ARCO_RECOMMENDER_URL = resolveBranchWorkerURL();

// Analytics service — same worker, separate endpoint
export const ARCO_ANALYTICS_URL = window.ARCO_CONFIG?.ANALYTICS_URL || ARCO_RECOMMENDER_URL;

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
