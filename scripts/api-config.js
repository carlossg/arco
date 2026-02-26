/**
 * Arco - API Configuration (Google Cloud)
 *
 * Central configuration for all API endpoints.
 * Uses Cloud Run and Cloud Functions on Google Cloud.
 */

// ============================================
// Google Cloud Run Endpoints
// ============================================

// Google Cloud project ID (override via window.ARCO_CONFIG?.GCP_PROJECT_ID)
export const GCP_PROJECT_ID = window.ARCO_CONFIG?.GCP_PROJECT_ID
  || 'api-project-642841493686';

// Main recommender service (Cloud Run)
export const ARCO_RECOMMENDER_URL = window.ARCO_CONFIG?.RECOMMENDER_URL
  || 'https://arco-recommender-642841493686.us-central1.run.app';

// Analytics service (Cloud Function Gen2)
export const ARCO_ANALYTICS_URL = window.ARCO_CONFIG?.ANALYTICS_URL
  || `https://us-central1-${GCP_PROJECT_ID}.cloudfunctions.net/trackEvent`;

// Recipe embeddings service (Cloud Function Gen2)
export const ARCO_EMBEDDINGS_URL = window.ARCO_CONFIG?.EMBEDDINGS_URL
  || `https://us-central1-${GCP_PROJECT_ID}.cloudfunctions.net/searchRecipes`;

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
 * Get the appropriate API endpoint for the current environment
 */
export function getAPIEndpoint(service = 'recommender') {
  if (window.ARCO_CONFIG) {
    switch (service) {
      case 'recommender':
        return window.ARCO_CONFIG.RECOMMENDER_URL || ARCO_RECOMMENDER_URL;
      case 'analytics':
        return window.ARCO_CONFIG.ANALYTICS_URL || ARCO_ANALYTICS_URL;
      case 'embeddings':
        return window.ARCO_CONFIG.EMBEDDINGS_URL || ARCO_EMBEDDINGS_URL;
      default:
        break;
    }
  }

  switch (service) {
    case 'recommender':
      return ARCO_RECOMMENDER_URL;
    case 'analytics':
      return ARCO_ANALYTICS_URL;
    case 'embeddings':
      return ARCO_EMBEDDINGS_URL;
    default:
      return ARCO_RECOMMENDER_URL;
  }
}

/**
 * Log API configuration on page load
 */
if (IS_LOCAL) {
  // eslint-disable-next-line no-console
  console.log('[Arco] API Configuration (Google Cloud):', {
    recommender: ARCO_RECOMMENDER_URL,
    analytics: ARCO_ANALYTICS_URL,
    embeddings: ARCO_EMBEDDINGS_URL,
    environment: IS_PRODUCTION ? 'production' : 'development',
  });
}

/**
 * Configuration instructions for deployment (local dev only)
 */
if (IS_LOCAL) {
  window.ARCO_CONFIG_HELP = `
To configure API endpoints for your deployment:

1. Override URLs or project:
   window.ARCO_CONFIG = {
     GCP_PROJECT_ID: 'your-project-id',
     RECOMMENDER_URL: 'https://arco-recommender-xxx-uc.a.run.app',
     ANALYTICS_URL: 'https://us-central1-YOUR_PROJECT.cloudfunctions.net/trackEvent',
     EMBEDDINGS_URL: 'https://us-central1-YOUR_PROJECT.cloudfunctions.net/searchRecipes',
   };

2. Add this to your head.html or page template before loading scripts.

3. For local development with Cloud Run:
   window.ARCO_CONFIG = { RECOMMENDER_URL: 'http://localhost:8080' };
`;
}
