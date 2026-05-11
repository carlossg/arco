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

// ── Judge one variant ────────────────────────────────────────────────────────

async function handleJudge(env, { evalRunId, variantId }) {
  const cfg = await loadEvalRunConfig(env, evalRunId);
  if (!cfg) return;

  try {
    await judgeOneVariantInternal({ env, variantId, judgeModel: cfg.judgeModel });
  } catch (err) {
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

async function handleRejudge(env, { evalRunId, variantId }) {
  const cfg = await loadEvalRunConfig(env, evalRunId);
  if (!cfg) return;

  try {
    await judgeOneVariantInternal({ env, variantId, judgeModel: cfg.judgeModel });
  } catch (err) {
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
}

// ── Message dispatch ─────────────────────────────────────────────────────────

// eslint-disable-next-line import/prefer-default-export
export async function handleEvalQueue(batch, env) {
  for (let i = 0; i < batch.messages.length; i += 1) {
    const msg = batch.messages[i];
    const { type } = msg.body;
    try {
      if (type === 'generate') {
        // eslint-disable-next-line no-await-in-loop
        await handleGenerate(env, msg.body);
      } else if (type === 'judge') {
        // eslint-disable-next-line no-await-in-loop
        await handleJudge(env, msg.body);
      } else if (type === 'regenerate') {
        // eslint-disable-next-line no-await-in-loop
        await handleRegenerate(env, msg.body);
      } else if (type === 'rejudge') {
        // eslint-disable-next-line no-await-in-loop
        await handleRejudge(env, msg.body);
      } else {
        console.error(`[EvalQueue] unknown message type: ${type}`);
      }
    } catch (err) {
      console.error(`[EvalQueue] unhandled error for ${type}:`, err.message);
    }
    msg.ack();
  }
}
