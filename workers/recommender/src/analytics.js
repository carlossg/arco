/**
 * Analytics helpers — writes events to Workers Analytics Engine
 * and queries the Analytics Engine SQL API for the stats dashboard.
 *
 * Event schema (per writeDataPoint call):
 *   blob1  → event_type : page_view | generation | product_view | recommender_query | cache_hit
 *   blob2  → page_type  : homepage | product | recommender | stories | experience | other
 *   blob3  → intent     : classified intent or product slug
 *   blob4  → path       : URL path
 *   double1 → count      : always 1
 *   double2 → duration_ms
 *   double3 → input_tokens
 *   double4 → output_tokens
 */

const ACCOUNT_ID = '68e6632adf76183424b251e874663bde';
const DATASET = 'arco_usage';

/**
 * Infer a coarse page type from a URL path.
 * @param {string} path
 * @returns {string}
 */
export function classifyPageType(path) {
  if (!path || path === '/') return 'homepage';
  if (path.startsWith('/products/')) return 'product';
  if (path.startsWith('/discover/') || path.includes('?q=')) return 'recommender';
  if (path.startsWith('/stories/')) return 'stories';
  if (path.startsWith('/experiences/')) return 'experience';
  return 'other';
}

/**
 * Normalise an event type string to snake_case.
 * Accepts "page-view", "page_view", "pageView", etc.
 * @param {string} raw
 * @returns {string}
 */
function normaliseEventType(raw) {
  return (raw || 'page_view').replace(/-/g, '_').toLowerCase();
}

/**
 * Write a single analytics event to Workers Analytics Engine.
 * Fire-and-forget — never blocks request handling.
 *
 * @param {object} env              Worker env bindings
 * @param {string} eventType        e.g. 'page_view', 'generation'
 * @param {string} pageType         e.g. 'product', 'homepage'
 * @param {string} intent           intent label or product slug
 * @param {string} path             URL path
 * @param {object} [extras]         { durationMs, inputTokens, outputTokens }
 */
export function writeEvent(env, eventType, pageType, intent, path, extras = {}) {
  if (!env.ANALYTICS) return;
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: [
        normaliseEventType(eventType),
        pageType || 'other',
        intent || '',
        path || '',
      ],
      doubles: [
        1,
        extras.durationMs || 0,
        extras.inputTokens || 0,
        extras.outputTokens || 0,
      ],
    });
  } catch {
    // Analytics is best-effort — silently ignore errors
  }
}

/**
 * Query Analytics Engine SQL API for aggregated stats.
 * Requires CF_API_TOKEN secret with "Analytics Engine — read" permission.
 *
 * @param {object} env          Worker env bindings
 * @param {number} [hoursBack]  How many hours of history to query (default 24)
 * @returns {Promise<object|null>} Aggregated stats or null if unavailable
 */
export async function queryStats(env, hoursBack = 24) {
  if (!env.CF_API_TOKEN) return null;

  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`;

  // Analytics Engine SQL only allows blob/double column names in GROUP BY —
  // timestamp and expressions are not supported as GROUP BY keys.
  // We aggregate totals by blob combination and omit the time dimension from SQL.
  // Time filter uses toDateTime(unix_int) to avoid unsupported helper functions.
  const cutoff = Math.floor(Date.now() / 1000) - Math.round(hoursBack) * 3600;
  const sql = `
    SELECT
      blob1 AS event_type,
      blob2 AS page_type,
      blob3 AS intent,
      blob4 AS path,
      SUM(_sample_interval) AS count,
      avg(double2) AS avg_duration_ms,
      avg(double3) AS avg_input_tokens,
      avg(double4) AS avg_output_tokens
    FROM ${DATASET}
    WHERE timestamp > toDateTime(${cutoff})
      AND blob1 != ''
    GROUP BY blob1, blob2, blob3, blob4
    ORDER BY count DESC
    LIMIT 5000
  `;

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Analytics Engine SQL query failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  const rows = json.data || [];

  // Aggregate rows into dashboard-ready structures
  const summary = {};
  const intentCounts = {};
  const pathCounts = {};

  rows.forEach((row) => {
    const {
      event_type: eventType,
      intent,
      path,
      count,
    } = row;
    const cnt = Number(count) || 0;

    // Running totals
    summary[eventType] = (summary[eventType] || 0) + cnt;

    // Top intents (from generation events)
    if (intent && eventType === 'generation') {
      intentCounts[intent] = (intentCounts[intent] || 0) + cnt;
    }

    // Top paths (from page_view events)
    if (path && eventType === 'page_view') {
      pathCounts[path] = (pathCounts[path] || 0) + cnt;
    }
  });

  const topIntents = Object.entries(intentCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([intent, count]) => ({ intent, count }));

  const topPaths = Object.entries(pathCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));

  return {
    summary,
    timeSeries: [],
    topIntents,
    topPaths,
    hoursBack,
    rowsProcessed: rows.length,
  };
}
