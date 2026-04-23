/**
 * Vectorize Admin — inspection + search for the `arco-content` Vectorize index.
 *
 * Auth: shares the Basic/cookie auth from admin.js (ADMIN_TOKEN secret).
 *
 * Routes (all GET):
 *   /api/admin/vectorize/stats                 → describe() + sampled type breakdown
 *   /api/admin/vectorize/search?q=&topK=&type= → embed q, top-K similarity search
 *   /api/admin/vectorize/items/:id?values=1    → fetch a single vector by id
 *
 * Vectorize V2 does not expose a list-all-vectors operation via the binding,
 * so stats blend an exact total (from describe()) with a type distribution
 * sampled from the top-K of a broad embedding. This is clearly labelled in
 * the UI as a sample, not a census.
 */

import { CORS_HEADERS } from './pipeline/context.js';
import { requireAdminAuth } from './admin.js';

const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const SAMPLE_SEED_QUERY = 'coffee espresso machine grinder recipe maintenance guide travel beginner';
// Vectorize V2 caps topK at 50 when returnMetadata='all' or returnValues=true
// (error code 40025). Use 100 only with returnMetadata='indexed'.
const SAMPLE_TOPK = 50;
const MAX_SEARCH_TOPK = 50;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function embed(text, env) {
  const response = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
  const vec = response?.data?.[0];
  if (!vec) throw new Error('Embedding failed');
  return vec;
}

/**
 * Count metadata distributions from a batch of matches. Returns plain
 * `{ key: { value: count } }` objects so the UI can render them directly.
 */
function buildMetadataHistogram(matches, keys) {
  const hist = Object.fromEntries(keys.map((k) => [k, {}]));
  matches.forEach((m) => {
    const md = m.metadata || {};
    keys.forEach((k) => {
      const raw = md[k];
      if (raw === undefined || raw === null || raw === '') return;
      const values = Array.isArray(raw) ? raw : String(raw).split(',');
      values.forEach((v) => {
        const trimmed = String(v).trim();
        if (!trimmed) return;
        hist[k][trimmed] = (hist[k][trimmed] || 0) + 1;
      });
    });
  });
  return hist;
}

/**
 * GET /api/admin/vectorize/stats
 * Returns exact totals from describe() plus a type histogram sampled from a
 * broad similarity query. Use `?sampleTopK=N` to tune the sample size.
 */
export async function handleVectorizeStats(request, env) {
  const denied = await requireAdminAuth(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const sampleTopK = Math.min(
    parseInt(url.searchParams.get('sampleTopK') || String(SAMPLE_TOPK), 10) || SAMPLE_TOPK,
    MAX_SEARCH_TOPK,
  );

  let describe = null;
  try {
    describe = await env.CONTENT_INDEX.describe();
  } catch (err) {
    return json({ error: `describe() failed: ${err.message}` }, { status: 500 });
  }

  // Vectorize binding historically returned `vectorsCount`; current runtime
  // returns `vectorCount`. Surface both plus a canonical `totalVectors` key.
  const totalVectors = (describe && (describe.vectorCount ?? describe.vectorsCount)) ?? null;

  const sample = { matches: [], error: null };
  try {
    const vec = await embed(SAMPLE_SEED_QUERY, env);
    const res = await env.CONTENT_INDEX.query(vec, { topK: sampleTopK, returnMetadata: 'all' });
    sample.matches = res.matches || [];
  } catch (err) {
    sample.error = err.message;
  }

  const histogram = buildMetadataHistogram(sample.matches, [
    'type', 'category', 'difficulty', 'personaTags',
  ]);

  // Score distribution on the sample — useful to gauge how "dense" the space is
  const scores = sample.matches.map((m) => m.score).filter((s) => typeof s === 'number');
  const scoreStats = scores.length ? {
    count: scores.length,
    min: Math.min(...scores),
    max: Math.max(...scores),
    mean: scores.reduce((a, b) => a + b, 0) / scores.length,
  } : null;

  return json({
    index: {
      name: 'arco-content',
      binding: 'CONTENT_INDEX',
      embeddingModel: EMBEDDING_MODEL,
    },
    describe,
    totalVectors,
    sample: {
      seed: SAMPLE_SEED_QUERY,
      topK: sampleTopK,
      count: sample.matches.length,
      error: sample.error,
      histogram,
      scoreStats,
    },
  });
}

/**
 * GET /api/admin/vectorize/search
 *   ?q=<text>            (required)  — query text to embed
 *   &topK=<1-100>        (default 20)
 *   &type=<meta.type>    optional    — client-side filter on returned matches
 *   &values=1            optional    — include raw vector values in response
 *
 * Returns { query, embedding: {dims, preview}, matches: [{id, score, metadata, values?}] }
 */
export async function handleVectorizeSearch(request, env) {
  const denied = await requireAdminAuth(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  if (!query || !query.trim()) {
    return json({ error: 'Missing ?q= parameter' }, { status: 400 });
  }

  const topK = Math.min(
    Math.max(parseInt(url.searchParams.get('topK') || '20', 10) || 20, 1),
    MAX_SEARCH_TOPK,
  );
  const typeFilter = url.searchParams.get('type') || null;
  const includeValues = url.searchParams.get('values') === '1';

  const t0 = Date.now();
  let vec;
  try {
    vec = await embed(query, env);
  } catch (err) {
    return json({ error: `Embedding failed: ${err.message}` }, { status: 500 });
  }
  const embedMs = Date.now() - t0;

  const t1 = Date.now();
  let queryRes;
  try {
    queryRes = await env.CONTENT_INDEX.query(vec, {
      topK,
      returnMetadata: 'all',
      returnValues: includeValues,
    });
  } catch (err) {
    return json({ error: `Vectorize query failed: ${err.message}` }, { status: 500 });
  }
  const queryMs = Date.now() - t1;

  let matches = queryRes.matches || [];
  if (typeFilter) {
    matches = matches.filter((m) => m.metadata?.type === typeFilter);
  }

  return json({
    query,
    topK,
    typeFilter,
    includeValues,
    embedding: {
      dims: vec.length,
      preview: vec.slice(0, 8),
    },
    timings: { embedMs, queryMs, totalMs: embedMs + queryMs },
    count: matches.length,
    totalReturned: (queryRes.matches || []).length,
    matches: matches.map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata || {},
      values: includeValues ? m.values : undefined,
    })),
  });
}

/**
 * GET /api/admin/vectorize/items/:id[?values=1]
 * Fetch one vector by id. Returns 404 if not found.
 */
export async function handleVectorizeItem(request, env, id) {
  const denied = await requireAdminAuth(request, env);
  if (denied) return denied;

  if (!id) return json({ error: 'Missing id' }, { status: 400 });

  let result;
  try {
    result = await env.CONTENT_INDEX.getByIds([id]);
  } catch (err) {
    return json({ error: `getByIds failed: ${err.message}` }, { status: 500 });
  }

  const rows = Array.isArray(result) ? result : (result?.matches || result?.vectors || []);
  const row = rows[0];
  if (!row) return json({ error: 'Not found', id }, { status: 404 });

  const url = new URL(request.url);
  const includeValues = url.searchParams.get('values') === '1';

  return json({
    id: row.id,
    metadata: row.metadata || {},
    values: includeValues ? row.values : undefined,
    dims: Array.isArray(row.values) ? row.values.length : undefined,
  });
}
