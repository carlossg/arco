/**
 * Admin route handlers for the LLM Evaluation tab.
 *
 *   GET  /api/admin/eval-suites
 *   POST /api/admin/evaluations
 *   POST /api/admin/evaluations/:id/queries
 *     body: { queryId, skipJudge? }
 *   POST /api/admin/evaluations/:id/judge
 *     body: { scope?: 'pending'|'errors'|'all', judgeConcurrency? }
 *   POST /api/admin/evaluations/:id/variants/:variantId/rejudge
 *   POST /api/admin/evaluations/:id/variants/:variantId/regenerate
 *   POST /api/admin/evaluations/:id/finalize
 *   GET  /api/admin/evaluations
 *   GET  /api/admin/evaluations/:id
 *
 * The split per-query endpoint exists because Cloudflare Workers cap each
 * invocation at 1000 subrequests; running 15 queries × N models in one shot
 * blows that budget. The client orchestrates the loop in parallel.
 */

import { CORS_HEADERS } from '../pipeline/context.js';
import { requireAdminAuth } from '../admin.js';
import { listSuites, getSuite } from './suites.js';
import { JUDGE_MODELS } from './judge.js';
import { attachFeedbackToQueries } from '../feedback.js';
import {
  validateRunBody, createEvalRun, runEvalQueryStream, finalizeEvalRun,
  loadEvalRunConfig,
} from './runner.js';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

// ── GET /api/admin/eval-suites ────────────────────────────────────────────────

export async function handleListEvalSuites(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (id) {
    const suite = getSuite(id);
    if (!suite) return jsonResponse({ error: 'Suite not found' }, { status: 404 });
    return jsonResponse({ suite, judgeModels: JUDGE_MODELS });
  }
  return jsonResponse({ suites: listSuites(), judgeModels: JUDGE_MODELS });
}

// ── POST /api/admin/evaluations ───────────────────────────────────────────────

export async function handleCreateEvaluation(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validation = validateRunBody(rawBody, env);
  if (validation.error) return jsonResponse({ error: validation.error }, { status: 400 });

  try {
    const result = await createEvalRun(env, validation.payload);
    return jsonResponse(result);
  } catch (err) {
    console.error('[Eval] createEvalRun failed:', err);
    return jsonResponse({ error: err.message || 'Failed to create eval run' }, { status: 500 });
  }
}

// ── POST /api/admin/evaluations/start ─────────────────────────────────────────
// Creates eval run + publishes one queue message per query.

export async function handleStartEvaluation(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validation = validateRunBody(rawBody, env);
  if (validation.error) return jsonResponse({ error: validation.error }, { status: 400 });

  const skipJudge = rawBody.skipJudge === true;

  try {
    const result = await createEvalRun(env, validation.payload);

    // Set phase and status columns for queue-driven orchestration
    const status = skipJudge ? 'skip_judge' : 'running';
    await env.SESSIONS_DB.prepare(
      "UPDATE eval_runs SET phase = 'generating', status = ?1, last_activity_at = ?2 WHERE id = ?3",
    ).bind(status, Date.now(), result.evalRunId).run();

    // Publish one message per query to the eval queue
    if (!env.EVAL_QUEUE) {
      return jsonResponse({ error: 'EVAL_QUEUE binding not configured' }, { status: 500 });
    }
    const messages = result.queries.map((q) => ({
      body: { type: 'generate', evalRunId: result.evalRunId, queryId: q.id },
    }));
    await env.EVAL_QUEUE.sendBatch(messages);

    return jsonResponse({
      evalRunId: result.evalRunId,
      queryCount: result.queries.length,
      modelCount: result.models.length,
      variantCount: result.variantCount,
    });
  } catch (err) {
    console.error('[Eval] handleStartEvaluation failed:', err);
    return jsonResponse({ error: err.message || 'Failed to start eval run' }, { status: 500 });
  }
}

// ── GET /api/admin/evaluations/:id/progress ──────────────────────────────────

export async function handleEvalProgress(request, env, evalRunId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  if (!env.SESSIONS_DB) {
    return jsonResponse({ error: 'D1 not configured' }, { status: 500 });
  }

  const { results: [row] } = await env.SESSIONS_DB.prepare(`
    SELECT id, status, phase, completed_queries, query_count, model_count,
           last_activity_at
    FROM eval_runs WHERE id = ?1
  `).bind(evalRunId).all();

  if (!row) return jsonResponse({ error: 'Eval run not found' }, { status: 404 });

  return jsonResponse({
    evalRunId: row.id,
    status: row.status,
    phase: row.phase,
    completedQueries: row.completed_queries || 0,
    queryCount: row.query_count,
    modelCount: row.model_count,
    lastActivityAt: row.last_activity_at,
  });
}

// ── POST /api/admin/evaluations/:id/resume ───────────────────────────────────
// Re-publishes failed or missing queries to the queue.

export async function handleResumeEvaluation(request, env, evalRunId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  if (!env.EVAL_QUEUE) {
    return jsonResponse({ error: 'EVAL_QUEUE binding not configured' }, { status: 500 });
  }

  const cfg = await loadEvalRunConfig(env, evalRunId);
  if (!cfg) return jsonResponse({ error: 'Eval run not found' }, { status: 404 });

  // Find queries that either have no experiment row or have all variants failed
  const { results: experiments } = await env.SESSIONS_DB.prepare(
    'SELECT eval_query_id FROM experiments WHERE eval_run_id = ?1',
  ).bind(evalRunId).all();

  const allQueryIds = cfg.suite.queries.map((q) => q.id);
  const ranQueryIds = new Set(experiments.map((e) => e.eval_query_id));

  // Queries that were never started
  const neverStarted = allQueryIds.filter((qid) => !ranQueryIds.has(qid));

  // Queries where all variants failed
  let allFailed = [];
  if (ranQueryIds.size > 0) {
    const { results: failedRows } = await env.SESSIONS_DB.prepare(`
      SELECT e.eval_query_id, COUNT(*) as total,
             SUM(CASE WHEN v.status = 'error' THEN 1 ELSE 0 END) as errors
      FROM experiments e
      JOIN experiment_variants v ON v.experiment_id = e.id
      WHERE e.eval_run_id = ?1
      GROUP BY e.eval_query_id
      HAVING errors = total
    `).bind(evalRunId).all();
    allFailed = (failedRows || []).map((r) => r.eval_query_id);
  }

  const toResume = [...new Set([...neverStarted, ...allFailed])];
  if (!toResume.length) {
    return jsonResponse({ resumed: 0, total: allQueryIds.length });
  }

  // Reset completed_queries count to account for re-published queries
  await env.SESSIONS_DB.prepare(`
    UPDATE eval_runs
    SET phase = 'generating', completed_queries = MAX(0, completed_queries - ?1), last_activity_at = ?2
    WHERE id = ?3
  `).bind(toResume.length, Date.now(), evalRunId).run();

  // Delete experiment + variant rows for failed queries so runOneQuery creates fresh ones
  for (let i = 0; i < allFailed.length; i += 1) {
    const qid = allFailed[i];
    // eslint-disable-next-line no-await-in-loop
    await env.SESSIONS_DB.prepare(`
      DELETE FROM experiment_variants WHERE experiment_id IN (
        SELECT id FROM experiments WHERE eval_run_id = ?1 AND eval_query_id = ?2
      )
    `).bind(evalRunId, qid).run();
    // eslint-disable-next-line no-await-in-loop
    await env.SESSIONS_DB.prepare(
      'DELETE FROM experiments WHERE eval_run_id = ?1 AND eval_query_id = ?2',
    ).bind(evalRunId, qid).run();
  }

  const messages = toResume.map((qid) => ({
    body: { type: 'generate', evalRunId, queryId: qid },
  }));
  await env.EVAL_QUEUE.sendBatch(messages);

  return jsonResponse({ resumed: toResume.length, total: allQueryIds.length });
}

// ── POST /api/admin/evaluations/:id/queries ───────────────────────────────────

export async function handleRunEvalQuery(request, env, evalRunId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const queryId = typeof body?.queryId === 'string' ? body.queryId.trim() : '';
  if (!queryId) return jsonResponse({ error: 'queryId is required' }, { status: 400 });
  const skipJudge = body?.skipJudge === true;

  return runEvalQueryStream(request, env, evalRunId, queryId, { skipJudge });
}

// ── POST /api/admin/evaluations/:id/judge ─────────────────────────────────────

export async function handleJudgeEvaluation(request, env, evalRunId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  if (!env.EVAL_QUEUE) {
    return jsonResponse({ error: 'EVAL_QUEUE binding not configured' }, { status: 500 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const scope = typeof body?.scope === 'string' ? body.scope : 'pending';

  // Find variants to judge based on scope
  let whereClause;
  if (scope === 'all') {
    whereClause = "v.status = 'complete'";
  } else if (scope === 'errors') {
    whereClause = "v.status = 'complete' AND v.evaluator_notes LIKE '%judge_error%'";
  } else {
    whereClause = "v.status = 'complete' AND v.evaluator_score IS NULL AND (v.evaluator_notes IS NULL OR v.evaluator_notes NOT LIKE '%judge_error%')";
  }

  const { results: variantsToJudge } = await env.SESSIONS_DB.prepare(`
    SELECT v.id FROM experiment_variants v
    JOIN experiments e ON v.experiment_id = e.id
    WHERE e.eval_run_id = ?1 AND ${whereClause}
  `).bind(evalRunId).all();

  if (!variantsToJudge || !variantsToJudge.length) {
    return jsonResponse({ queued: 0, message: 'No variants to judge' });
  }

  // Update phase to judging
  await env.SESSIONS_DB.prepare(
    "UPDATE eval_runs SET phase = 'judging', last_activity_at = ?1 WHERE id = ?2",
  ).bind(Date.now(), evalRunId).run();

  // Publish one message per variant
  const messages = variantsToJudge.map((v) => ({
    body: { type: 'judge', evalRunId, variantId: v.id },
  }));
  for (let i = 0; i < messages.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    await env.EVAL_QUEUE.sendBatch(messages.slice(i, i + 100));
  }

  return jsonResponse({ queued: variantsToJudge.length });
}

// ── POST /api/admin/evaluations/:id/variants/:variantId/rejudge ───────────────

export async function handleRejudgeVariant(request, env, evalRunId, variantId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  if (!env.EVAL_QUEUE) {
    return jsonResponse({ error: 'EVAL_QUEUE binding not configured' }, { status: 500 });
  }

  await env.EVAL_QUEUE.send({ type: 'rejudge', evalRunId, variantId });
  return jsonResponse({ queued: true, variantId });
}

// ── POST /api/admin/evaluations/:id/variants/:variantId/regenerate ────────────

export async function handleRegenerateVariant(request, env, evalRunId, variantId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  if (!env.EVAL_QUEUE) {
    return jsonResponse({ error: 'EVAL_QUEUE binding not configured' }, { status: 500 });
  }

  // Reset variant status so the matrix shows "generating…" while queued
  if (env.SESSIONS_DB) {
    await env.SESSIONS_DB.prepare(`
      UPDATE experiment_variants
      SET status = 'running', evaluator_score = NULL, evaluator_notes = NULL,
          duration_ms = NULL, time_to_first_token_ms = NULL,
          input_tokens = NULL, output_tokens = NULL, title = NULL,
          block_count = NULL, error = NULL
      WHERE id = ?1
    `).bind(variantId).run();
  }

  await env.EVAL_QUEUE.send({ type: 'regenerate', evalRunId, variantId });
  return jsonResponse({ queued: true, variantId });
}

// ── POST /api/admin/evaluations/:id/finalize ──────────────────────────────────

export async function handleFinalizeEvaluation(request, env, evalRunId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  try {
    const result = await finalizeEvalRun(env, evalRunId);
    if (result.error) {
      const status = result.error === 'Eval run not found' ? 404 : 500;
      return jsonResponse(result, { status });
    }
    return jsonResponse(result);
  } catch (err) {
    console.error('[Eval] finalizeEvalRun failed:', err);
    return jsonResponse({ error: err.message || 'Failed to finalize' }, { status: 500 });
  }
}

// ── GET /api/admin/evaluations ────────────────────────────────────────────────

export async function handleListEvaluations(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;
  if (!env.SESSIONS_DB) {
    return jsonResponse({
      runs: [], total: 0, limit: 0, offset: 0,
    });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const { results: runs } = await env.SESSIONS_DB.prepare(`
    SELECT id, suite_id, suite_name, suite_version, models_json, judge_model,
           status, phase, completed_queries, last_activity_at,
           created_at, completed_at,
           query_count, model_count, variant_count,
           total_input_tokens, total_output_tokens,
           judge_input_tokens, judge_output_tokens, estimated_cost_usd,
           summary_json, error
    FROM eval_runs
    ORDER BY created_at DESC
    LIMIT ?1 OFFSET ?2
  `).bind(limit, offset).all();

  const { results: countRow } = await env.SESSIONS_DB.prepare(
    'SELECT COUNT(*) as total FROM eval_runs',
  ).all();

  return jsonResponse({
    runs,
    total: countRow[0]?.total || 0,
    limit,
    offset,
  });
}

// ── GET /api/admin/evaluations/:id ────────────────────────────────────────────

export async function handleGetEvaluation(request, env, evalRunId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;
  if (!env.SESSIONS_DB) {
    return jsonResponse({ error: 'D1 not configured' }, { status: 500 });
  }

  const { results: [run] } = await env.SESSIONS_DB.prepare(
    'SELECT * FROM eval_runs WHERE id = ?1',
  ).bind(evalRunId).all();
  if (!run) return jsonResponse({ error: 'Eval run not found' }, { status: 404 });

  const { results: experiments } = await env.SESSIONS_DB.prepare(`
    SELECT id, eval_query_id, query, status, created_at, completed_at,
           shared_intent_type, shared_journey_stage, shared_duration_ms
    FROM experiments
    WHERE eval_run_id = ?1
    ORDER BY created_at ASC
  `).bind(evalRunId).all();

  const expIds = experiments.map((e) => e.id);
  let variants = [];
  if (expIds.length) {
    // SQLite doesn't allow array binding directly; build a placeholder list.
    const placeholders = expIds.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await env.SESSIONS_DB.prepare(`
      SELECT id, experiment_id, variant_index, provider, model, temperature,
             max_tokens, status, duration_ms, time_to_first_token_ms,
             input_tokens, output_tokens, title, block_count, error,
             evaluator_score, evaluator_notes
      FROM experiment_variants
      WHERE experiment_id IN (${placeholders})
      ORDER BY experiment_id ASC, variant_index ASC
    `).bind(...expIds).all();
    variants = results;
  }

  // Reuse the suite definition so the matrix knows query order + expected intents.
  const suite = getSuite(run.suite_id);

  // Optional: enrich each experiment with real-user feedback for its query.
  let feedbackByQuery = null;
  const url = new URL(request.url);
  if (url.searchParams.get('include') === 'feedback') {
    const queries = experiments.map((e) => e.query).filter(Boolean);
    const map = await attachFeedbackToQueries(env, queries);
    feedbackByQuery = Object.fromEntries(map);
  }

  return jsonResponse({
    run, suite, experiments, variants, feedbackByQuery,
  });
}

// ── GET /api/admin/eval-queue ────────────────────────────────────────────────

const CF_ACCOUNT_ID = '68e6632adf76183424b251e874663bde';
const EVAL_QUEUE_ID = 'f81a3cdc972840c097984fed7be6e2d2';

export async function handleEvalQueueStatus(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  // Count pending work from D1 — more reliable than CF Queue API for depth.
  // "generating" = queries in progress or waiting, "judging" = judge calls pending.
  const { results: activeRuns } = await env.SESSIONS_DB.prepare(`
    SELECT id, phase, completed_queries, query_count, status
    FROM eval_runs
    WHERE phase IN ('generating', 'judging')
  `).all();

  let pendingGenerate = 0;
  let pendingJudge = 0;
  for (let i = 0; i < activeRuns.length; i += 1) {
    const r = activeRuns[i];
    if (r.phase === 'generating') {
      pendingGenerate += Math.max(0, (r.query_count || 0) - (r.completed_queries || 0));
    }
  }

  if (activeRuns.some((r) => r.phase === 'judging')) {
    const runIds = activeRuns
      .filter((r) => r.phase === 'judging')
      .map((r) => r.id);
    const placeholders = runIds.map((_, idx) => `?${idx + 1}`).join(', ');
    const { results: judgeRows } = await env.SESSIONS_DB.prepare(`
      SELECT COUNT(*) as cnt FROM experiment_variants v
      JOIN experiments e ON v.experiment_id = e.id
      WHERE e.eval_run_id IN (${placeholders})
        AND v.status = 'complete'
        AND v.evaluator_score IS NULL
        AND (v.evaluator_notes IS NULL OR v.evaluator_notes NOT LIKE '%judge_error%')
    `).bind(...runIds).all();
    pendingJudge = judgeRows?.[0]?.cnt || 0;
  }

  // Also count individually queued retries (running variants outside active runs)
  const { results: retryRows } = await env.SESSIONS_DB.prepare(`
    SELECT COUNT(*) as cnt FROM experiment_variants
    WHERE status = 'running'
  `).all();
  const pendingRetries = retryRows?.[0]?.cnt || 0;

  return jsonResponse({
    pendingGenerate,
    pendingJudge,
    pendingRetries,
    total: pendingGenerate + pendingJudge + pendingRetries,
    activeRuns: activeRuns.length,
  });
}

// ── Shared helper: fetch CF API and parse defensively ────────────────────────
// Reads body as text first so non-JSON responses (HTML 5xx pages, empty bodies)
// surface as a useful error instead of throwing inside res.json().
async function cfApiCall(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    const e = new Error(`CF API fetch failed: ${err.message || err}`);
    e.status = 502;
    throw e;
  }
  const rawBody = await res.text();
  let data = null;
  if (rawBody) {
    try { data = JSON.parse(rawBody); } catch { /* keep raw */ }
  }
  if (!res.ok || (data && data.success === false)) {
    const cfMsg = data?.errors?.[0]?.message
      || data?.error
      || data?.message
      || (rawBody && rawBody.slice(0, 300))
      || res.statusText
      || 'unknown CF API error';
    const e = new Error(`CF API ${options?.method || 'GET'} ${url.split('/').slice(-3).join('/')} → ${res.status}: ${cfMsg}`);
    e.status = res.status >= 400 ? res.status : 502;
    e.cfBody = data || rawBody;
    throw e;
  }
  return data ?? {};
}

// ── Shared helper: resume delivery via queue-level PUT ───────────────────────

async function cfResumeQueueDelivery(env) {
  // wrangler queues resume-delivery calls PUT /queues/{id} with settings.delivery_paused=false
  return cfApiCall(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues/${EVAL_QUEUE_ID}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        queue_name: 'arco-eval-queries',
        settings: { delivery_paused: false },
      }),
    },
  );
}

// ── GET /api/admin/eval-queue/consumers  (queue + delivery status) ────────────

export async function handleEvalQueueConsumers(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  if (!env.CF_API_TOKEN) {
    return jsonResponse({ error: 'CF_API_TOKEN not configured' }, { status: 500 });
  }

  // Fetch queue-level info (includes delivery_paused) AND consumer list in parallel
  const [queueRes, consumerRes] = await Promise.all([
    fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues/${EVAL_QUEUE_ID}`,
      { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
    ),
    fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues/${EVAL_QUEUE_ID}/consumers`,
      { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
    ),
  ]);
  const [queueData, consumerData] = await Promise.all([queueRes.json(), consumerRes.json()]);
  return jsonResponse({ queue: queueData, consumers: consumerData });
}

// ── POST /api/admin/eval-queue/resume-delivery ────────────────────────────────

export async function handleEvalQueueResumeDelivery(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  if (!env.CF_API_TOKEN) {
    return jsonResponse({ error: 'CF_API_TOKEN not configured' }, { status: 500 });
  }

  try {
    const data = await cfResumeQueueDelivery(env);
    return jsonResponse(data);
  } catch (err) {
    console.error('[eval-queue/resume-delivery] failed', err);
    return jsonResponse(
      { error: err.message || 'resume-delivery failed', cfBody: err.cfBody },
      { status: err.status || 500 },
    );
  }
}

// ── POST /api/admin/eval-queue/purge ─────────────────────────────────────────

export async function handleEvalQueuePurge(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  if (!env.CF_API_TOKEN) {
    return jsonResponse({ error: 'CF_API_TOKEN not configured' }, { status: 500 });
  }

  // Step 1: purge the CF Queue (removes all pending messages).
  // The current CF Queues API requires `delete_messages_permanently: true`
  // in the body, otherwise it 400s with a confusing error.
  try {
    await cfApiCall(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/queues/${EVAL_QUEUE_ID}/purge`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ delete_messages_permanently: true }),
      },
    );
  } catch (err) {
    console.error('[eval-queue/purge] CF API call failed', err);
    return jsonResponse(
      {
        error: err.message || 'Purge failed',
        stage: 'cf-purge',
        cfBody: err.cfBody,
      },
      { status: err.status || 500 },
    );
  }

  // Step 2: reset active runs to 'error' phase so they don't block future runs.
  try {
    await env.SESSIONS_DB.prepare(`
      UPDATE eval_runs SET phase = 'error', status = 'purged', last_activity_at = ?1
      WHERE phase IN ('generating', 'judging')
    `).bind(Date.now()).run();

    await env.SESSIONS_DB.prepare(`
      UPDATE experiment_variants SET status = 'error', error = 'queue purged'
      WHERE status = 'running'
    `).run();
  } catch (err) {
    console.error('[eval-queue/purge] D1 cleanup failed after successful purge', err);
    return jsonResponse(
      {
        error: `Queue purged but D1 cleanup failed: ${err.message || err}`,
        stage: 'd1-cleanup',
        purged: true,
      },
      { status: 500 },
    );
  }

  // Step 3: auto-resume delivery (purge always pauses the consumer).
  // Best-effort — surface the failure as a warning, don't fail the whole call.
  let resumeWarning = null;
  try {
    await cfResumeQueueDelivery(env);
  } catch (err) {
    console.error('[eval-queue/purge] resume-delivery after purge failed', err);
    resumeWarning = err.message || String(err);
  }

  return jsonResponse({ purged: true, resumeWarning });
}
