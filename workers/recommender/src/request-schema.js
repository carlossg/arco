/**
 * Request body schema for /api/generate.
 *
 * The client sends a JSON body with a known set of fields. Historically the
 * worker trusted whatever arrived — including client-minted UUIDs used as D1
 * primary keys. This module parses the body against an explicit whitelist,
 * validates each field's shape, and drops anything unexpected.
 *
 * Anything extra on the body is silently ignored (not rejected) so the client
 * can evolve independently without breaking production.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_QUERY_LEN = 500;
const MAX_URL_LEN = 500;
const MAX_FOLLOWUP_LABEL_LEN = 200;
const MAX_FOLLOWUP_TYPE_LEN = 32;
const MAX_FOLLOWUP_PRODUCT_LEN = 64;
const MAX_PREVIOUS_QUERIES = 10;
const MAX_BROWSING_HISTORY = 15;

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

function uuidOrNull(v) {
  return isUuid(v) ? v : null;
}

function stringOrNull(v, maxLen) {
  return (typeof v === 'string' && v.length > 0 && v.length <= maxLen) ? v : null;
}

function parseFollowUp(fu) {
  if (!fu || typeof fu !== 'object') return null;
  const type = stringOrNull(fu.type, MAX_FOLLOWUP_TYPE_LEN);
  const label = stringOrNull(fu.label, MAX_FOLLOWUP_LABEL_LEN);
  const query = stringOrNull(fu.query, MAX_QUERY_LEN);
  const product = stringOrNull(fu.product, MAX_FOLLOWUP_PRODUCT_LEN);
  if (!type && !label && !query && !product) return null;
  return {
    ...(type ? { type } : {}),
    ...(label ? { label } : {}),
    ...(query ? { query } : {}),
    ...(product ? { product } : {}),
  };
}

function parseContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const out = {};
  if (Array.isArray(ctx.previousQueries)) {
    out.previousQueries = ctx.previousQueries.slice(-MAX_PREVIOUS_QUERIES);
  }
  if (Array.isArray(ctx.browsingHistory)) {
    out.browsingHistory = ctx.browsingHistory.slice(-MAX_BROWSING_HISTORY);
  }
  if (ctx.inferredProfile && typeof ctx.inferredProfile === 'object') {
    out.inferredProfile = ctx.inferredProfile;
  }
  if (ctx.behaviorProfile && typeof ctx.behaviorProfile === 'object') {
    out.behaviorProfile = ctx.behaviorProfile;
  }
  if (ctx.shownContent && typeof ctx.shownContent === 'object') {
    out.shownContent = ctx.shownContent;
  }
  if (typeof ctx.quizPersona === 'string') {
    out.quizPersona = ctx.quizPersona.slice(0, 64);
  }
  return out;
}

/**
 * Parse and validate a /api/generate request body.
 * @param {unknown} body Parsed JSON body.
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 */
// eslint-disable-next-line import/prefer-default-export
export function parseGenerateBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid body' };
  }

  const { query } = body;
  if (typeof query !== 'string' || !query || query.length > MAX_QUERY_LEN) {
    return { ok: false, error: 'Invalid query' };
  }

  const payload = {
    query,
    sessionId: uuidOrNull(body.sessionId),
    pageId: uuidOrNull(body.pageId),
    pageUrl: stringOrNull(body.pageUrl, MAX_URL_LEN),
    runId: uuidOrNull(body.runId),
    parentRunId: uuidOrNull(body.parentRunId),
    speculative: body.speculative === true,
    flow: stringOrNull(body.flow, 32),
    followUp: parseFollowUp(body.followUp),
    context: parseContext(body.context),
  };
  return { ok: true, payload };
}
