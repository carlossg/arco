/**
 * Arco - API Configuration
 *
 * Central configuration for all API endpoints.
 * Google Cloud is the default. The retained Cloudflare backend is explicit opt-in.
 */

// ============================================
// Backend Endpoints
// ============================================

const PRODUCTION_WORKER = 'https://arco-recommender.franklin-prod.workers.dev';

// Isolated worker for the carlossg fork (deployed from wrangler.carlossg.jsonc).
// Reuses the shared CF account's AI binding + Vectorize, but its own D1, KV
// session store, queues, and DA_ORG=carlossg.
const CARLOSSG_WORKER = 'https://arco-recommender-carlossg.franklin-prod.workers.dev';
const GOOGLE_SERVICE = 'https://arco-recommender-gcp-okyq6gkx3a-uc.a.run.app';
const USE_CLOUDFLARE = window.ARCO_CONFIG?.BACKEND === 'cloudflare';

function allowEndpoint(value) {
  if (!value || USE_CLOUDFLARE) return value;
  const { hostname } = new URL(value, window.location.origin || 'http://localhost');
  if (/(^|\.)(workers\.dev|cloudflare\.com)$/.test(hostname)) {
    // A previously saved Worker override must not silently undo the platform migration.
    console.warn('[Arco] Ignoring a Cloudflare URL. Set ARCO_CONFIG.BACKEND="cloudflare" to opt in.');
    return undefined;
  }
  return value;
}

/**
 * Resolve the recommender worker URL for the current environment.
 *
 * Priority:
 *   1. window.ARCO_CONFIG.RECOMMENDER_URL  — explicit global override
 *   2. localStorage['arco-recommender-url'] — runtime toggle, no code edit:
 *        localStorage.setItem('arco-recommender-url', 'http://localhost:8787')  // local wrangler dev
 *        localStorage.setItem('arco-recommender-url', '<prod url>')  // force prod locally
 *        localStorage.removeItem('arco-recommender-url')             // back to default
 *   3. Google Cloud Run (default for all hosts)
 *
 * With ARCO_CONFIG.BACKEND="cloudflare", the retained legacy routing is:
 *   localhost / 127.0.0.1 → the isolated carlossg worker
 *   4. *--arco--carlossg.aem.{page,live} → the isolated carlossg worker
 *   5. {branch}--{repo}--{owner}.aem.page → that branch's worker version
 *   6. everything else → production
 */
function resolveRecommenderURL() {
  const configured = allowEndpoint(window.ARCO_CONFIG?.RECOMMENDER_URL);
  if (configured) return configured;

  try {
    const stored = allowEndpoint(window.localStorage?.getItem('arco-recommender-url'));
    if (stored) return stored;
  } catch { /* localStorage may be unavailable (private mode / sandbox) */ }

  if (!USE_CLOUDFLARE) return GOOGLE_SERVICE;

  const { hostname } = window.location;

  // Local dev (this branch): default to the isolated carlossg worker so
  // `aem up` exercises the same backend the carlossg site uses. To target a
  // local `wrangler dev` instead, set:
  //   localStorage.setItem('arco-recommender-url', 'http://localhost:8787')
  if (hostname === 'localhost' || hostname === '127.0.0.1') return CARLOSSG_WORKER;

  // carlossg fork: its own isolated worker (own D1/SESSION_STORE/queues, DA_ORG).
  // Matches any {branch}--arco--carlossg.{aem.page,aem.live} host. The shared
  // froesef stack is never reached from a carlossg-owned site.
  if (/--arco--carlossg\.aem\.(page|live)$/.test(hostname)) {
    return CARLOSSG_WORKER;
  }

  // EDS branch preview: rewrite to the branch alias worker version.
  const match = hostname.match(/^(.+)--[^.]+--[^.]+\.aem\.page$/);
  if (!match || match[1] === 'main') return PRODUCTION_WORKER;

  const alias = match[1]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `https://${alias}-arco-recommender.franklin-prod.workers.dev`;
}

// Main recommender service
export const ARCO_RECOMMENDER_URL = resolveRecommenderURL();

// Analytics service — same worker, separate endpoint
export const ARCO_ANALYTICS_URL = allowEndpoint(window.ARCO_CONFIG?.ANALYTICS_URL)
  || ARCO_RECOMMENDER_URL;

/**
 * Admin/metrics API base.
 *
 * Uses the same Google service by default, including localhost. Override with
 * localStorage['arco-admin-url'] to inspect a local Google development server.
 * The legacy Cloudflare mode retains its local Wrangler default.
 */
function resolveAdminURL() {
  const configured = allowEndpoint(window.ARCO_CONFIG?.ADMIN_URL);
  if (configured) return configured;

  try {
    const stored = allowEndpoint(window.localStorage?.getItem('arco-admin-url'));
    if (stored) return stored;
  } catch { /* localStorage may be unavailable (private mode / sandbox) */ }

  const { hostname } = window.location;
  if (USE_CLOUDFLARE && (hostname === 'localhost' || hostname === '127.0.0.1')) {
    return 'http://localhost:8787';
  }

  return ARCO_RECOMMENDER_URL;
}

export const ARCO_ADMIN_URL = resolveAdminURL();

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
