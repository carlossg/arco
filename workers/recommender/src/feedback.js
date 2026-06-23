/**
 * Run-Level User Feedback — public submission + admin browsing/export.
 *
 * One row per (run_id, session_id) in `run_feedback`. Re-submits upsert
 * (the same browser updating its vote or adding a comment).
 *
 * Public:
 *   POST /api/feedback                              → submit/upsert, returns 204
 *
 * Admin (Basic-auth or cookie via requireAdminAuth):
 *   GET  /api/admin/feedback                        → list + filters
 *   GET  /api/admin/feedback/summary?since=         → aggregates for header strip
 *   GET  /api/admin/feedback/run/:runId             → per-run detail
 *   GET  /api/admin/feedback/export?format=csv|json → streaming flat export
 */

import { CORS_HEADERS } from './pipeline/context.js';
import { hashIp } from './storage.js';

const KNOWN_FLAGS = new Set([
  'wrong-product',
  'off-topic',
  'inappropriate-tone',
  'harmful-unsafe',
]);

const COMMENT_MAX = 1000;
const PRODUCTS_MAX = 20;

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function clean(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.substring(0, max) : t;
}

function sanitizeFlags(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  input.forEach((k) => {
    if (typeof k === 'string' && KNOWN_FLAGS.has(k) && !out.includes(k)) out.push(k);
  });
  return out;
}

function sanitizeProducts(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  input.forEach((s) => {
    if (typeof s !== 'string' || out.length >= PRODUCTS_MAX) return;
    const t = s.trim().substring(0, 120);
    if (t && !out.includes(t)) out.push(t);
  });
  return out;
}

function parseJsonField(value) {
  if (value == null) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ─── POST /api/feedback ──────────────────────────────────────────────────────

export async function handleSubmitFeedback(request, env) {
  if (!env.SESSIONS_DB) {
    return jsonResponse({ error: 'Storage unavailable' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const runId = clean(body.runId, 64);
  const sessionId = clean(body.sessionId, 64);
  const ratingNum = Number(body.rating);
  if (!runId || !sessionId) {
    return jsonResponse({ error: 'runId and sessionId required' }, { status: 400 });
  }
  if (ratingNum !== 1 && ratingNum !== -1) {
    return jsonResponse({ error: 'rating must be -1 or +1' }, { status: 400 });
  }

  const comment = clean(body.comment, COMMENT_MAX);
  const flags = sanitizeFlags(body.flags);
  const wrongProducts = sanitizeProducts(body.wrongProducts);
  const dwellMs = Number.isFinite(Number(body.dwellMs))
    ? Math.max(0, Math.min(Number(body.dwellMs), 24 * 60 * 60 * 1000))
    : null;
  const pageId = clean(body.pageId, 64);

  const ipHeader = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || 'unknown';
  const ip = ipHeader.split(',')[0].trim();
  const ipHashed = await hashIp(ip);
  const ua = (request.headers.get('user-agent') || '').substring(0, 200);
  const now = Math.floor(Date.now() / 1000);

  const id = crypto.randomUUID();

  try {
    await env.SESSIONS_DB.prepare(`
      INSERT INTO run_feedback
        (id, run_id, page_id, session_id, rating, comment, flags, wrong_products,
         dwell_ms, user_agent, ip_hash, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
      ON CONFLICT(run_id, session_id) DO UPDATE SET
        rating         = excluded.rating,
        comment        = COALESCE(excluded.comment, run_feedback.comment),
        flags          = excluded.flags,
        wrong_products = excluded.wrong_products,
        dwell_ms       = COALESCE(excluded.dwell_ms, run_feedback.dwell_ms),
        user_agent     = excluded.user_agent,
        ip_hash        = excluded.ip_hash,
        updated_at     = excluded.updated_at
    `).bind(
      id,
      runId,
      pageId,
      sessionId,
      ratingNum,
      comment,
      JSON.stringify(flags),
      JSON.stringify(wrongProducts),
      dwellMs,
      ua,
      ipHashed,
      now,
    ).run();
  } catch (err) {
    console.error('[Feedback] insert failed:', err.message);
    return jsonResponse({ error: 'Failed to save feedback' }, { status: 500 });
  }

  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ─── Helpers for joining with generated_pages ────────────────────────────────

function feedbackRowToDto(r) {
  return {
    id: r.id,
    run_id: r.run_id,
    page_id: r.page_id,
    session_id: r.session_id,
    rating: r.rating,
    comment: r.comment,
    flags: parseJsonField(r.flags),
    wrong_products: parseJsonField(r.wrong_products),
    dwell_ms: r.dwell_ms,
    user_agent: r.user_agent,
    created_at: r.created_at,
    updated_at: r.updated_at,
    query: r.query || null,
    intent_type: r.intent_type || null,
    journey_stage: r.journey_stage || null,
    llm_provider: r.llm_provider || null,
    llm_model: r.llm_model || null,
    da_path: r.da_path || null,
    title: r.title || null,
  };
}

// ─── GET /api/admin/feedback ─────────────────────────────────────────────────

export async function handleListFeedback(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const rating = url.searchParams.get('rating');
  const flag = url.searchParams.get('flag');
  const model = url.searchParams.get('model');
  const q = url.searchParams.get('q');
  const hasComment = url.searchParams.get('hasComment') === 'true';
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const until = parseInt(url.searchParams.get('until') || '0', 10);

  const where = ['1=1'];
  const binds = [];

  if (rating === 'up') where.push('rf.rating = 1');
  else if (rating === 'down') where.push('rf.rating = -1');

  if (flag && KNOWN_FLAGS.has(flag)) {
    binds.push(`%"${flag}"%`);
    where.push(`rf.flags LIKE ?${binds.length}`);
  }
  if (model) {
    binds.push(model);
    where.push(`gp.llm_model = ?${binds.length}`);
  }
  if (q) {
    binds.push(`%${q}%`);
    where.push(`gp.query LIKE ?${binds.length}`);
  }
  if (hasComment) where.push('rf.comment IS NOT NULL AND length(rf.comment) > 0');
  if (since > 0) {
    binds.push(since);
    where.push(`rf.created_at >= ?${binds.length}`);
  }
  if (until > 0) {
    binds.push(until);
    where.push(`rf.created_at <= ?${binds.length}`);
  }

  const whereSql = where.join(' AND ');
  binds.push(limit, offset);

  const sql = `
    SELECT rf.*, gp.query, gp.intent_type, gp.journey_stage,
           gp.llm_provider, gp.llm_model, gp.da_path, gp.title
    FROM run_feedback rf
    LEFT JOIN generated_pages gp ON gp.id = rf.run_id
    WHERE ${whereSql}
    ORDER BY rf.created_at DESC
    LIMIT ?${binds.length - 1} OFFSET ?${binds.length}
  `;

  const countBinds = binds.slice(0, -2);
  const { results } = await env.SESSIONS_DB.prepare(sql).bind(...binds).all();
  const { results: countRow } = await env.SESSIONS_DB.prepare(
    `SELECT COUNT(*) as n FROM run_feedback rf
     LEFT JOIN generated_pages gp ON gp.id = rf.run_id
     WHERE ${whereSql}`,
  ).bind(...countBinds).all();

  return jsonResponse({
    items: results.map(feedbackRowToDto),
    total: countRow[0]?.n || 0,
    limit,
    offset,
  });
}

// ─── GET /api/admin/feedback/run/:runId ──────────────────────────────────────

export async function handleRunFeedback(request, env, runId) {
  const { results: feedback } = await env.SESSIONS_DB.prepare(
    `SELECT rf.*, gp.query, gp.intent_type, gp.journey_stage,
            gp.llm_provider, gp.llm_model, gp.da_path, gp.title, gp.page_id as gp_page_id
     FROM run_feedback rf
     LEFT JOIN generated_pages gp ON gp.id = rf.run_id
     WHERE rf.run_id = ?1
     ORDER BY rf.created_at DESC`,
  ).bind(runId).all();

  const { results: runRows } = await env.SESSIONS_DB.prepare(
    'SELECT * FROM generated_pages WHERE id = ?1',
  ).bind(runId).all();

  const run = runRows[0] || null;

  const flagCounts = {};
  const productCounts = {};
  feedback.forEach((r) => {
    parseJsonField(r.flags).forEach((f) => {
      flagCounts[f] = (flagCounts[f] || 0) + 1;
    });
    parseJsonField(r.wrong_products).forEach((p) => {
      productCounts[p] = (productCounts[p] || 0) + 1;
    });
  });

  return jsonResponse({
    runId,
    run,
    feedback: feedback.map(feedbackRowToDto),
    flagCounts,
    productCounts,
  });
}

// ─── GET /api/admin/feedback/summary ─────────────────────────────────────────

export async function handleFeedbackSummary(request, env) {
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const sinceClause = since > 0 ? 'WHERE rf.created_at >= ?1' : '';
  const binds = since > 0 ? [since] : [];

  const { results: totals } = await env.SESSIONS_DB.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as positive,
       SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as negative,
       SUM(CASE WHEN comment IS NOT NULL AND length(comment) > 0 THEN 1 ELSE 0 END) as comments
     FROM run_feedback rf
     ${sinceClause}`,
  ).bind(...binds).all();

  const t = totals[0] || {};
  const total = t.total || 0;
  const positive = t.positive || 0;
  const negative = t.negative || 0;

  // Flag counts — JSON1's json_each is supported by CF D1.
  const flagCountsSql = `
    SELECT je.value as flag, COUNT(*) as n
    FROM run_feedback rf, json_each(rf.flags) je
    ${sinceClause ? `${sinceClause.replace('WHERE', 'WHERE')}` : ''}
    GROUP BY je.value
    ORDER BY n DESC
    LIMIT 10
  `;

  let flagRows = [];
  try {
    const r = await env.SESSIONS_DB.prepare(flagCountsSql).bind(...binds).all();
    flagRows = r.results || [];
  } catch (err) {
    console.warn('[Feedback] flag aggregation failed (json_each):', err.message);
  }

  const { results: byModel } = await env.SESSIONS_DB.prepare(
    `SELECT gp.llm_model as model,
            SUM(CASE WHEN rf.rating = 1 THEN 1 ELSE 0 END) as positive,
            SUM(CASE WHEN rf.rating = -1 THEN 1 ELSE 0 END) as negative,
            COUNT(*) as total
     FROM run_feedback rf
     LEFT JOIN generated_pages gp ON gp.id = rf.run_id
     ${sinceClause}
     GROUP BY gp.llm_model
     ORDER BY total DESC
     LIMIT 20`,
  ).bind(...binds).all();

  const { results: byIntent } = await env.SESSIONS_DB.prepare(
    `SELECT gp.intent_type as intent,
            SUM(CASE WHEN rf.rating = 1 THEN 1 ELSE 0 END) as positive,
            SUM(CASE WHEN rf.rating = -1 THEN 1 ELSE 0 END) as negative,
            COUNT(*) as total
     FROM run_feedback rf
     LEFT JOIN generated_pages gp ON gp.id = rf.run_id
     ${sinceClause}
     GROUP BY gp.intent_type
     ORDER BY total DESC
     LIMIT 20`,
  ).bind(...binds).all();

  // Divergence: judge score ≥ 4 but user rating = -1, joined via query equality
  // (eval suites reuse query text — same query → same eval cell).
  let divergence = 0;
  try {
    const { results: divRows } = await env.SESSIONS_DB.prepare(
      `SELECT COUNT(*) as n
       FROM run_feedback rf
       JOIN generated_pages gp ON gp.id = rf.run_id
       JOIN experiment_variants ev ON ev.evaluator_score >= 4
       JOIN experiments e ON e.id = ev.experiment_id AND e.query = gp.query
       WHERE rf.rating = -1
       ${since > 0 ? `AND rf.created_at >= ${since}` : ''}`,
    ).all();
    divergence = divRows[0]?.n || 0;
  } catch (err) {
    console.warn('[Feedback] divergence join failed:', err.message);
  }

  return jsonResponse({
    total,
    positive,
    negative,
    comments: t.comments || 0,
    percentPositive: total > 0 ? Math.round((positive / total) * 1000) / 10 : 0,
    topFlags: flagRows.map((r) => ({
      flag: r.flag,
      count: r.n,
      percent: negative > 0 ? Math.round((r.n / negative) * 1000) / 10 : 0,
    })),
    byModel,
    byIntent,
    divergence,
  });
}

// ─── GET /api/admin/feedback/export ──────────────────────────────────────────

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const EXPORT_COLUMNS = [
  'created_at_iso', 'run_id', 'page_id', 'session_id',
  'query', 'intent_type', 'journey_stage',
  'llm_provider', 'llm_model',
  'rating', 'flags', 'wrong_products',
  'comment', 'dwell_ms', 'da_path',
];

function rowToFlatExport(r) {
  return {
    created_at_iso: r.created_at ? new Date(r.created_at * 1000).toISOString() : '',
    run_id: r.run_id,
    page_id: r.page_id,
    session_id: r.session_id,
    query: r.query,
    intent_type: r.intent_type,
    journey_stage: r.journey_stage,
    llm_provider: r.llm_provider,
    llm_model: r.llm_model,
    rating: r.rating,
    flags: parseJsonField(r.flags).join(';'),
    wrong_products: parseJsonField(r.wrong_products).join(';'),
    comment: r.comment,
    dwell_ms: r.dwell_ms,
    da_path: r.da_path,
  };
}

export async function handleFeedbackExport(request, env) {
  const url = new URL(request.url);
  const format = (url.searchParams.get('format') || 'csv').toLowerCase();
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const until = parseInt(url.searchParams.get('until') || '0', 10);

  const where = ['1=1'];
  const binds = [];
  if (since > 0) {
    binds.push(since);
    where.push(`rf.created_at >= ?${binds.length}`);
  }
  if (until > 0) {
    binds.push(until);
    where.push(`rf.created_at <= ?${binds.length}`);
  }

  // No pagination — admin export, expected size is hundreds-to-low-thousands.
  const { results } = await env.SESSIONS_DB.prepare(
    `SELECT rf.*, gp.query, gp.intent_type, gp.journey_stage,
            gp.llm_provider, gp.llm_model, gp.da_path
     FROM run_feedback rf
     LEFT JOIN generated_pages gp ON gp.id = rf.run_id
     WHERE ${where.join(' AND ')}
     ORDER BY rf.created_at DESC`,
  ).bind(...binds).all();

  const stamp = new Date().toISOString().split('T')[0];
  const filename = `arco-feedback-${stamp}.${format === 'json' ? 'ndjson' : 'csv'}`;

  if (format === 'json') {
    const lines = results.map((r) => JSON.stringify(rowToFlatExport(r)));
    return new Response(`${lines.join('\n')}\n`, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  const header = EXPORT_COLUMNS.join(',');
  const rows = results.map((r) => {
    const flat = rowToFlatExport(r);
    return EXPORT_COLUMNS.map((c) => csvEscape(flat[c])).join(',');
  });
  return new Response(`${header}\n${rows.join('\n')}\n`, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// ─── Eval-matrix integration helper ──────────────────────────────────────────

/**
 * Attach feedback summaries to eval variants.
 * Called by admin.js when /api/admin/evaluations/:id is fetched with ?include=feedback.
 * Maps each variant's query → { up, down, comments } from run_feedback.
 *
 * Match key: gp.query == eval query (since eval reruns the same query
 * through the pipeline producing a separate generated_pages row whose
 * query string matches the suite query).
 */
export async function attachFeedbackToQueries(env, queries) {
  if (!env.SESSIONS_DB || !Array.isArray(queries) || queries.length === 0) {
    return new Map();
  }

  const placeholders = queries.map((_, i) => `?${i + 1}`).join(',');
  let rows = [];
  try {
    const result = await env.SESSIONS_DB.prepare(
      `SELECT gp.query as query,
              SUM(CASE WHEN rf.rating = 1 THEN 1 ELSE 0 END) as up,
              SUM(CASE WHEN rf.rating = -1 THEN 1 ELSE 0 END) as down,
              SUM(CASE WHEN rf.comment IS NOT NULL
                        AND length(rf.comment) > 0 THEN 1 ELSE 0 END) as comments
       FROM run_feedback rf
       JOIN generated_pages gp ON gp.id = rf.run_id
       WHERE gp.query IN (${placeholders})
       GROUP BY gp.query`,
    ).bind(...queries).all();
    rows = result.results || [];
  } catch (err) {
    console.warn('[Feedback] attachFeedbackToQueries failed:', err.message);
    return new Map();
  }

  return new Map(rows.map((r) => [r.query, {
    up: r.up || 0, down: r.down || 0, comments: r.comments || 0,
  }]));
}
