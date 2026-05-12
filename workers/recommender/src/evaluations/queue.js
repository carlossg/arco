/**
 * Cloudflare Queue consumer for async eval orchestration.
 *
 * Message types:
 *   { type: 'generate', evalRunId, queryId }
 *     Run one query (all models). Increments completed_queries. When all done,
 *     publishes judge messages (unless skipJudge).
 *
 *   { type: 'judge', evalRunId, variantId }
 *     Judge one variant from KV. When all judged, finalizes the run.
 *
 *   { type: 'regenerate', evalRunId, variantId }
 *     Re-run full pipeline for one cell (generation + judge).
 *
 *   { type: 'rejudge', evalRunId, variantId }
 *     Re-judge one cell from persisted KV blocks.
 */

import {
  runOneQueryHeadless, judgeOneVariantInternal, finalizeEvalRun,
  loadEvalRunConfig, regenerateOneVariantHeadless,
} from './runner.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function markQueryFailed(env, evalRunId, queryId, errorMessage) {
  await env.SESSIONS_DB.prepare(`
    UPDATE experiment_variants SET status = 'error', error = ?1
    WHERE experiment_id IN (
      SELECT id FROM experiments WHERE eval_run_id = ?2 AND eval_query_id = ?3
    ) AND status != 'complete'
  `).bind(errorMessage, evalRunId, queryId).run();
}

async function publishJudgeMessages(env, evalRunId) {
  const { results: variants } = await env.SESSIONS_DB.prepare(`
    SELECT v.id FROM experiment_variants v
    JOIN experiments e ON v.experiment_id = e.id
    WHERE e.eval_run_id = ?1
      AND v.status = 'complete'
      AND v.evaluator_score IS NULL
  `).bind(evalRunId).all();

  if (!variants || !variants.length) {
    await finalizeEvalRun(env, evalRunId);
    await env.SESSIONS_DB.prepare(
      "UPDATE eval_runs SET phase = 'complete', last_activity_at = ?1 WHERE id = ?2",
    ).bind(Date.now(), evalRunId).run();
    return;
  }

  const messages = variants.map((v) => ({
    body: { type: 'judge', evalRunId, variantId: v.id },
  }));

  // sendBatch supports up to 100 messages; chunk if needed
  for (let i = 0; i < messages.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    await env.EVAL_QUEUE.sendBatch(messages.slice(i, i + 100));
  }
}

// ── Generate one query ───────────────────────────────────────────────────────

async function handleGenerate(env, { evalRunId, queryId }) {
  // Short-circuit when the run has already terminated (operator marked it
  // error, or it completed). Lets pending queue messages drain without
  // spinning up new generations against a dead run.
  const { results: runRows } = await env.SESSIONS_DB.prepare(
    'SELECT phase FROM eval_runs WHERE id = ?1',
  ).bind(evalRunId).all();
  const runPhase = runRows?.[0]?.phase;
  if (!runPhase || (runPhase !== 'generating' && runPhase !== 'judging')) {
    console.log(`[EvalQueue] skipping generate ${queryId} — run ${evalRunId} phase=${runPhase || 'missing'}`);
    return;
  }

  try {
    const result = await runOneQueryHeadless(env, evalRunId, queryId);
    if (!result.ok) {
      await markQueryFailed(env, evalRunId, queryId, result.error);
    }
  } catch (err) {
    console.error(`[EvalQueue] generate ${queryId} failed:`, err.message);
    await markQueryFailed(env, evalRunId, queryId, err.message).catch(() => {});
  }

  // Increment completed count
  await env.SESSIONS_DB.prepare(`
    UPDATE eval_runs
    SET completed_queries = completed_queries + 1, last_activity_at = ?1
    WHERE id = ?2
  `).bind(Date.now(), evalRunId).run();

  // Check if all queries are done
  const { results } = await env.SESSIONS_DB.prepare(
    'SELECT completed_queries, query_count, phase, status FROM eval_runs WHERE id = ?1',
  ).bind(evalRunId).all();

  const row = results?.[0];
  if (row && row.completed_queries >= row.query_count && row.phase === 'generating') {
    // CAS: only one consumer transitions generating → judging
    const cas = await env.SESSIONS_DB.prepare(
      "UPDATE eval_runs SET phase = 'judging', last_activity_at = ?1 WHERE id = ?2 AND phase = 'generating'",
    ).bind(Date.now(), evalRunId).run();
    if (cas.meta?.changes > 0) {
      if (row.status === 'skip_judge') {
        await finalizeEvalRun(env, evalRunId);
        await env.SESSIONS_DB.prepare(
          "UPDATE eval_runs SET phase = 'complete', last_activity_at = ?1 WHERE id = ?2",
        ).bind(Date.now(), evalRunId).run();
      } else {
        await publishJudgeMessages(env, evalRunId);
      }
    }
  }
}

// ── Judge retry-with-delay (for Bedrock 429) ─────────────────────────────────
// Bedrock has no Retry-After header; AWS recommends syncing retries with the
// 60-second quota refresh cycle. We escalate 429s back to the queue with a
// stair-stepped delay that crosses the 60s window: 30, 60, 90, 120, 150s.
function computeJudgeBackoffSeconds(attempts) {
  const base = 30 + (Math.max(1, attempts) - 1) * 30;
  const jitter = Math.floor(Math.random() * 10);
  return base + jitter;
}

function shouldQueueRetry(err, msg) {
  // Only escalate to queue for throttling. Other errors (auth, bad request,
  // 5xx that didn't recover in-process) are not retryable here.
  if (!msg || typeof msg.retry !== 'function') return false;
  if (err?.status !== 429) return false;
  // attempts is 1-based: 1 = first delivery. Cap to leave headroom under
  // max_retries: 5 in wrangler.jsonc (total deliveries = 6).
  const attempts = msg.attempts || 1;
  return attempts < 6;
}

// ── Judge one variant ────────────────────────────────────────────────────────

async function handleJudge(env, { evalRunId, variantId }, msg) {
  const cfg = await loadEvalRunConfig(env, evalRunId);
  if (!cfg) return { retried: false };

  try {
    await judgeOneVariantInternal({ env, variantId, judgeModel: cfg.judgeModel });
  } catch (err) {
    if (shouldQueueRetry(err, msg)) {
      const delay = computeJudgeBackoffSeconds(msg.attempts || 1);
      console.log(`[EvalQueue] judge ${variantId} 429 — requeue in ${delay}s (attempt ${msg.attempts})`);
      msg.retry({ delaySeconds: delay });
      return { retried: true };
    }
    console.error(`[EvalQueue] judge ${variantId} failed:`, err.message);
  }

  // Check if all judging is complete
  const { results } = await env.SESSIONS_DB.prepare(`
    SELECT COUNT(*) as pending FROM experiment_variants v
    JOIN experiments e ON v.experiment_id = e.id
    WHERE e.eval_run_id = ?1
      AND v.status = 'complete'
      AND v.evaluator_score IS NULL
      AND (v.evaluator_notes IS NULL OR v.evaluator_notes NOT LIKE '%judge_error%')
  `).bind(evalRunId).all();

  const pending = results?.[0]?.pending || 0;
  if (pending === 0) {
    // CAS: only one consumer finalizes
    const cas = await env.SESSIONS_DB.prepare(
      "UPDATE eval_runs SET phase = 'complete', last_activity_at = ?1 WHERE id = ?2 AND phase = 'judging'",
    ).bind(Date.now(), evalRunId).run();
    if (cas.meta?.changes > 0) {
      await finalizeEvalRun(env, evalRunId);
    }
  }
  return { retried: false };
}

// ── Regenerate one variant ───────────────────────────────────────────────────

async function handleRegenerate(env, { evalRunId, variantId }) {
  try {
    await regenerateOneVariantHeadless(env, evalRunId, variantId);
  } catch (err) {
    console.error(`[EvalQueue] regenerate ${variantId} failed:`, err.message);
  }
}

// ── Re-judge one variant ─────────────────────────────────────────────────────

async function handleRejudge(env, { evalRunId, variantId }, msg) {
  const cfg = await loadEvalRunConfig(env, evalRunId);
  if (!cfg) return { retried: false };

  try {
    await judgeOneVariantInternal({ env, variantId, judgeModel: cfg.judgeModel });
  } catch (err) {
    if (shouldQueueRetry(err, msg)) {
      const delay = computeJudgeBackoffSeconds(msg.attempts || 1);
      console.log(`[EvalQueue] rejudge ${variantId} 429 — requeue in ${delay}s (attempt ${msg.attempts})`);
      msg.retry({ delaySeconds: delay });
      return { retried: true };
    }
    console.error(`[EvalQueue] rejudge ${variantId} failed:`, err.message);
  }

  // If the run is in 'judging' phase, check if this was the last pending variant
  const { results: runRow } = await env.SESSIONS_DB.prepare(
    'SELECT phase FROM eval_runs WHERE id = ?1',
  ).bind(evalRunId).all();

  if (runRow?.[0]?.phase === 'judging') {
    const { results } = await env.SESSIONS_DB.prepare(`
      SELECT COUNT(*) as pending FROM experiment_variants v
      JOIN experiments e ON v.experiment_id = e.id
      WHERE e.eval_run_id = ?1
        AND v.status = 'complete'
        AND v.evaluator_score IS NULL
        AND (v.evaluator_notes IS NULL OR v.evaluator_notes NOT LIKE '%judge_error%')
    `).bind(evalRunId).all();

    const pending = results?.[0]?.pending || 0;
    if (pending === 0) {
      const cas = await env.SESSIONS_DB.prepare(
        "UPDATE eval_runs SET phase = 'complete', last_activity_at = ?1 WHERE id = ?2 AND phase = 'judging'",
      ).bind(Date.now(), evalRunId).run();
      if (cas.meta?.changes > 0) {
        await finalizeEvalRun(env, evalRunId);
      }
    }
  }
  return { retried: false };
}

// ── Cron fallback: process stuck runs when CF Queue delivery fails ─────────────

async function processGenerating(env, run) {
  const cfg = await loadEvalRunConfig(env, run.id);
  if (!cfg) return;

  // Reset variants stuck in 'running' — worker died before completing them
  await env.SESSIONS_DB.prepare(`
    UPDATE experiment_variants SET status = 'error', error = 'stuck_running_reset'
    WHERE experiment_id IN (SELECT id FROM experiments WHERE eval_run_id = ?1)
      AND status = 'running'
  `).bind(run.id).run();

  const allQueryIds = cfg.suite.queries.map((q) => q.id);

  const { results: ran } = await env.SESSIONS_DB.prepare(
    'SELECT eval_query_id FROM experiments WHERE eval_run_id = ?1',
  ).bind(run.id).all();
  const ranSet = new Set((ran || []).map((r) => r.eval_query_id));

  const { results: failed } = await env.SESSIONS_DB.prepare(`
    SELECT e.eval_query_id FROM experiments e
    JOIN experiment_variants v ON v.experiment_id = e.id
    WHERE e.eval_run_id = ?1
    GROUP BY e.eval_query_id
    HAVING COUNT(*) = SUM(CASE WHEN v.status = 'error' THEN 1 ELSE 0 END)
  `).bind(run.id).all();
  const failedSet = new Set((failed || []).map((r) => r.eval_query_id));

  const pending = allQueryIds.filter((qid) => !ranSet.has(qid) || failedSet.has(qid));
  if (!pending.length) return;

  console.log(`[CronFallback] run ${run.id}: processing ${Math.min(3, pending.length)} of ${pending.length} pending queries`);
  const batch = pending.slice(0, 3);
  await Promise.allSettled(
    batch.map((qid) => handleGenerate(env, { evalRunId: run.id, queryId: qid })),
  );
}

async function processJudging(env, run) {
  const cfg = await loadEvalRunConfig(env, run.id);
  if (!cfg) return;

  const { results: variants } = await env.SESSIONS_DB.prepare(`
    SELECT v.id FROM experiment_variants v
    JOIN experiments e ON v.experiment_id = e.id
    WHERE e.eval_run_id = ?1
      AND v.status = 'complete'
      AND v.evaluator_score IS NULL
      AND (v.evaluator_notes IS NULL OR v.evaluator_notes NOT LIKE '%judge_error%')
    LIMIT 3
  `).bind(run.id).all();

  if (!variants || !variants.length) {
    // All judged — finalize
    const cas = await env.SESSIONS_DB.prepare(
      "UPDATE eval_runs SET phase = 'complete', last_activity_at = ?1 WHERE id = ?2 AND phase = 'judging'",
    ).bind(Date.now(), run.id).run();
    if (cas.meta?.changes > 0) await finalizeEvalRun(env, run.id);
    return;
  }

  console.log(`[CronFallback] run ${run.id}: judging ${variants.length} variant(s)`);
  await Promise.allSettled(
    variants.map((v) => handleJudge(env, { evalRunId: run.id, variantId: v.id })),
  );
}

async function processStuckRun(env, run) {
  if (run.phase === 'generating') {
    await processGenerating(env, run);
  } else if (run.phase === 'judging') {
    await processJudging(env, run);
  }
}

export async function handleEvalCronFallback(env) {
  const staleThreshold = Date.now() - 2 * 60 * 1000; // 2 min without activity = stuck

  const { results: activeRuns } = await env.SESSIONS_DB.prepare(`
    SELECT id, phase, completed_queries, query_count, status
    FROM eval_runs
    WHERE phase IN ('generating', 'judging')
      AND (last_activity_at IS NULL OR last_activity_at < ?1)
    LIMIT 5
  `).bind(staleThreshold).all();

  if (!activeRuns || !activeRuns.length) return;
  console.log(`[CronFallback] found ${activeRuns.length} stuck run(s)`);

  for (let r = 0; r < activeRuns.length; r += 1) {
    const run = activeRuns[r];
    // eslint-disable-next-line no-await-in-loop
    await processStuckRun(env, run);
  }
}

// ── Message dispatch ─────────────────────────────────────────────────────────

// eslint-disable-next-line import/prefer-default-export
export async function handleEvalQueue(batch, env) {
  for (let i = 0; i < batch.messages.length; i += 1) {
    const msg = batch.messages[i];
    const { type } = msg.body;
    let result = null;
    try {
      if (type === 'generate') {
        // eslint-disable-next-line no-await-in-loop
        await handleGenerate(env, msg.body);
      } else if (type === 'judge') {
        // eslint-disable-next-line no-await-in-loop
        result = await handleJudge(env, msg.body, msg);
      } else if (type === 'regenerate') {
        // eslint-disable-next-line no-await-in-loop
        await handleRegenerate(env, msg.body);
      } else if (type === 'rejudge') {
        // eslint-disable-next-line no-await-in-loop
        result = await handleRejudge(env, msg.body, msg);
      } else {
        console.error(`[EvalQueue] unknown message type: ${type}`);
      }
    } catch (err) {
      console.error(`[EvalQueue] unhandled error for ${type}:`, err.message);
    }
    // Skip ack when the handler scheduled a queue retry (e.g. judge 429).
    if (!result?.retried) msg.ack();
  }
}
