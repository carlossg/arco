/**
 * Native Firestore evaluation lifecycle; deliberately does not emulate D1.
 *
 * Collections are arco_{eval_runs,experiments,experiment_variants,eval_payloads,
 * eval_jobs}_gcp. Public rows retain the admin UI's snake_case field names.
 * eval_jobs is a transactional outbox plus execution lease, not a second queue.
 * Scheduler recovers unsent jobs and expired leases through Cloud Tasks only.
 * LLM calls are at-least-once on a process crash; stable experiment/variant IDs,
 * transactional leases, and terminal job states prevent duplicate rows/counts.
 *
 * createEvaluations({firestore,queue}) returns:
 *   fetch(request,env,ctx): Response, or null for unrelated routes
 *   deliver({body,attempts,taskId,env,ctx}): await before HTTP 204
 *   queue(batch,env,ctx), scheduled(event,env,ctx), getQueueStatus()
 *
 * Mount fetch before the shared Worker router. Authenticate Google internal
 * task/scheduler requests in the parent, then call deliver / scheduled.
 * Admin requests authenticate here using the shared admin authentication.
 */
/* eslint no-restricted-syntax: off, no-await-in-loop: off, no-continue: off */
/* eslint import/no-relative-packages: off, import/prefer-default-export: off */
/* eslint no-use-before-define: ["error", { "functions": false }] */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { deliverTask } from './tasks.js';

const ACTIVE_JOB_STATES = new Set(['pending', 'queued', 'running']);
const LEASE_MS = 35 * 60 * 1000;
const STALE_MS = 5 * 60 * 1000;
const clean = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function defaultSuites() {
  return Promise.all(['coffee-extended', 'coffee-default', 'coffee-dev'].map(async (name) => JSON.parse(
    await readFile(new URL(`../../../eval/suites/${name}.json`, import.meta.url), 'utf8'),
  )));
}

async function defaultGenerate({ queryDef, models, env }) {
  const [
    { createContext }, { executeFlow }, { resolveFlow }, { STEPS },
    { runLlmVariant, createVariantState, extractTitle },
    { setHeroResult }, { selectHeroImage }, { extractProductIds },
  ] = await Promise.all([
    import('../../../workers/recommender/src/pipeline/context.js'),
    import('../../../workers/recommender/src/pipeline/executor.js'),
    import('../../../workers/recommender/src/pipeline/flows.js'),
    import('../../../workers/recommender/src/pipeline/steps/index.js'),
    import('../../../workers/recommender/src/pipeline/steps/llm-generate.js'),
    import('../../../workers/recommender/src/images.js'),
    import('../../../workers/recommender/src/hero-images.js'),
    import('../../../workers/recommender/src/context.js'),
  ]);
  const writer = new WritableStream({ write() {} }).getWriter();
  try {
    const ctx = createContext({ query: queryDef.query }, { headers: new Headers() });
    const flow = resolveFlow('default');
    ctx.flowId = flow.id;
    ctx.flowName = flow.name;
    ctx.writer = writer;
    ctx.encoder = new TextEncoder();
    ctx.timings.steps = [];
    for (const step of flow.steps.filter((entry) => entry.gate)) {
      await STEPS[step.step](ctx, step.config || {}, env);
      if (ctx.earlyResponse) throw new Error('Evaluation query was gated before generation');
    }
    await executeFlow(flow.steps.filter((entry) => !entry.gate && entry.step !== 'llm-generate'), ctx, env);
    setHeroResult(selectHeroImage({
      query: queryDef.query,
      useCases: ctx.rag?.useCase?.useCases,
      intentType: ctx.intent?.type,
      productIds: extractProductIds(queryDef.query),
    }, ctx.rag?.heroImages || []));
    // Sequential variants keep the demo's API quota and memory bounded.
    const results = [];
    for (const model of models) {
      const out = createVariantState();
      const timings = {};
      const start = Date.now();
      await runLlmVariant(ctx, env, {
        ...model, variantId: model.id, out, timings, emitDebug: false, emitDone: false,
      });
      if (!out.sections.length) throw new Error('LLM returned no blocks');
      results.push({
        id: model.id,
        blocks: out.sections.map((html, index) => ({
          index, html, blockType: out.rawJsonSections?.[index]?.block || 'unknown',
        })),
        rag: ctx.rag,
        intent: ctx.intent,
        query: queryDef.query,
        followUpOptions: out.suggestions || [],
        title: extractTitle(out.sections[0]),
        duration_ms: Date.now() - start,
        time_to_first_token_ms: timings.llmFirstToken && timings.llmStart
          ? timings.llmFirstToken - timings.llmStart : null,
        input_tokens: out.usage?.prompt_tokens || 0,
        output_tokens: out.usage?.completion_tokens || 0,
      });
    }
    return clean(results);
  } finally {
    await writer.close();
  }
}

function summarize(models, variants) {
  const average = (rows, field) => {
    const values = rows.map((row) => row[field]).filter((value) => typeof value === 'number');
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return {
    perModel: models.map((model) => {
      const rows = variants.filter((variant) => variant.provider === model.provider
        && variant.model === model.model);
      const notes = rows.map((row) => JSON.parse(row.evaluator_notes || '{}'));
      return {
        ...model,
        generations: rows.length,
        errors: rows.filter((row) => row.status === 'error').length,
        avgQuality: average(rows, 'evaluator_score'),
        qualityN: rows.filter((row) => row.evaluator_score != null).length,
        avgTtftMs: average(rows, 'time_to_first_token_ms'),
        avgDurationMs: average(rows, 'duration_ms'),
        inputTokens: rows.reduce((sum, row) => sum + (row.input_tokens || 0), 0),
        outputTokens: rows.reduce((sum, row) => sum + (row.output_tokens || 0), 0),
        blockerCount: notes.filter((note) => note.blocker).length,
        blockerRate: rows.length ? notes.filter((note) => note.blocker).length / rows.length : null,
        assertionFailCount: notes.filter((note) => note.assertions?.passed === false).length,
        assertionGradedCount: notes.filter((note) => note.assertions).length,
      };
    }),
    totalInputTokens: variants.reduce((sum, row) => sum + (row.input_tokens || 0), 0),
    totalOutputTokens: variants.reduce((sum, row) => sum + (row.output_tokens || 0), 0),
    judgeInputTokens: variants.reduce((sum, row) => sum + (row.judge_input_tokens || 0), 0),
    judgeOutputTokens: variants.reduce((sum, row) => sum + (row.judge_output_tokens || 0), 0),
  };
}

export function createEvaluations(config) {
  const {
    firestore: db, queue: transport,
    generate = defaultGenerate,
    now = Date.now,
  } = config;
  if (!db || !transport) throw new TypeError('firestore and queue are required');
  const collection = (table) => db.collection(`arco_${table}_gcp`);
  const ref = (table, id) => collection(table).doc(id);
  const runQuery = (table, id) => collection(table).where('eval_run_id', '==', id);
  const dataRows = (snapshot) => snapshot.docs.map((doc) => doc.data());
  const get = async (table, id) => {
    const snapshot = await ref(table, id).get();
    if (!snapshot.exists) throw new RequestError(`${table} not found`, 404);
    return snapshot.data();
  };
  let suitesPromise;
  const suites = () => {
    if (!suitesPromise) suitesPromise = Promise.resolve(config.suites || defaultSuites());
    return suitesPromise;
  };
  const judgeModule = () => import('../../../workers/recommender/src/evaluations/judge.js');
  const jobRow = (body, id = randomUUID()) => ({
    id,
    eval_run_id: body.evalRunId,
    body: { ...body, jobId: id },
    state: 'pending',
    attempts: 0,
    created_at: now(),
    last_activity_at: now(),
    lease_until: 0,
    lease_token: null,
  });
  const stableJob = (body) => jobRow(body, hash(JSON.stringify(body)));

  async function publish(job) {
    await transport.send(job.body);
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref('eval_jobs', job.id));
      if (snapshot.exists && ['pending', 'queued'].includes(snapshot.data().state)) {
        tx.update(snapshot.ref, { state: 'queued', last_activity_at: now() });
      }
    });
  }

  async function publishPending(runId) {
    const jobs = dataRows(await runQuery('eval_jobs', runId).get()).filter((job) => job.state === 'pending');
    for (const job of jobs) await publish(job);
  }

  async function reconcile(runId) {
    await db.runTransaction(async (tx) => {
      const [runDoc, variantDocs, jobDocs] = await Promise.all([
        tx.get(ref('eval_runs', runId)),
        tx.get(runQuery('experiment_variants', runId)),
        tx.get(runQuery('eval_jobs', runId)),
      ]);
      if (!runDoc.exists || runDoc.data().status === 'purged') return;
      const run = runDoc.data();
      const variants = dataRows(variantDocs);
      const jobs = dataRows(jobDocs);
      const generationJobs = jobs.filter((job) => job.body.type === 'generate');
      const activeQueries = new Set(generationJobs
        .filter((job) => ACTIVE_JOB_STATES.has(job.state)).map((job) => job.body.queryId));
      const terminalQueries = generationJobs.filter((job) => !ACTIVE_JOB_STATES.has(job.state)
        && !activeQueries.has(job.body.queryId));
      const completedQueries = new Set(terminalQueries.map((job) => job.body.queryId)).size;
      const changes = { completed_queries: completedQueries, last_activity_at: now() };
      const active = jobs.some((job) => ACTIVE_JOB_STATES.has(job.state));
      if (completedQueries < run.query_count || active) {
        tx.update(runDoc.ref, changes);
        return;
      }
      const existingJobs = new Set(jobs.map((job) => job.id));
      const judgeJobs = run.skip_judge ? [] : variants
        .filter((variant) => variant.status === 'complete' && variant.evaluator_score == null
          && !JSON.parse(variant.evaluator_notes || '{}').judge_error)
        .map((variant) => stableJob({ type: 'judge', evalRunId: runId, variantId: variant.id }))
        .filter((job) => !existingJobs.has(job.id));
      if (judgeJobs.length) {
        judgeJobs.forEach((job) => tx.create(ref('eval_jobs', job.id), job));
        tx.update(runDoc.ref, { ...changes, phase: 'judging' });
        return;
      }
      const summary = summarize(run.models, variants);
      const errors = variants.filter((variant) => variant.status === 'error'
        || JSON.parse(variant.evaluator_notes || '{}').judge_error).length;
      let status = 'complete';
      if (errors > 0) status = errors === variants.length ? 'error' : 'partial';
      tx.update(runDoc.ref, {
        ...changes,
        phase: 'complete',
        status,
        completed_at: now(),
        summary_json: JSON.stringify(summary),
        total_input_tokens: summary.totalInputTokens,
        total_output_tokens: summary.totalOutputTokens,
        judge_input_tokens: summary.judgeInputTokens,
        judge_output_tokens: summary.judgeOutputTokens,
      });
    });
    await publishPending(runId);
  }

  async function create(body, env, start) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new RequestError('Invalid evaluation body');
    }
    const suite = (await suites()).find((entry) => entry.id === body.suiteId);
    if (!suite || !suite.queries?.length) throw new RequestError('Unknown or empty suite');
    if (!Array.isArray(body.models) || !body.models.length || body.models.length > 8) {
      throw new RequestError('Between 1 and 8 models are required');
    }
    const models = body.models.map((model) => {
      if (model?.provider !== 'gemini' || !/^gemini-[a-z0-9.-]+$/i.test(model.model || '')) {
        throw new RequestError('Google evaluations require Gemini models');
      }
      return {
        provider: 'gemini',
        model: model.model,
        label: model.label || model.model,
        temperature: Number.isFinite(model.temperature)
          ? Math.max(0, Math.min(2, model.temperature)) : 0.6,
        maxTokens: Number.isFinite(model.maxTokens)
          ? Math.max(256, Math.min(16384, Math.round(model.maxTokens))) : 5120,
      };
    });
    const judges = config.judgeModels || (await judgeModule()).getJudgeModels(env);
    const judgeModel = body.judgeModel || judges[0].id;
    if (!judges.some((judge) => judge.id === judgeModel)) throw new RequestError('Unknown Google judge model');
    const id = randomUUID();
    const run = {
      id,
      suite_id: suite.id,
      suite_name: suite.name,
      suite_version: suite.version || 1,
      suite,
      models,
      models_json: JSON.stringify(models),
      judge_provider: 'gemini',
      judge_model: judgeModel,
      status: 'running',
      phase: 'generating',
      created_at: now(),
      last_activity_at: now(),
      completed_queries: 0,
      query_count: suite.queries.length,
      model_count: models.length,
      variant_count: suite.queries.length * models.length,
      skip_judge: body.skipJudge === true,
    };
    // Bound commits below Firestore's 500-write transaction limit.
    if (suite.queries.length * (models.length + 2) + 1 > 450) {
      throw new RequestError('Suite exceeds the native evaluation transaction limit');
    }
    const batch = db.batch();
    batch.create(ref('eval_runs', id), run);
    for (const query of suite.queries) {
      const experimentId = hash(`${id}:${query.id}`);
      batch.create(ref('experiments', experimentId), {
        id: experimentId,
        eval_run_id: id,
        eval_query_id: query.id,
        query: query.query,
        variant_count: models.length,
        status: 'running',
        created_at: now(),
      });
      models.forEach((model, index) => {
        const variantId = hash(`${experimentId}:${index}`);
        batch.create(ref('experiment_variants', variantId), {
          id: variantId,
          experiment_id: experimentId,
          eval_run_id: id,
          eval_query_id: query.id,
          variant_index: index,
          provider: model.provider,
          model: model.model,
          temperature: model.temperature,
          max_tokens: model.maxTokens,
          status: 'running',
          evaluator_score: null,
          evaluator_notes: null,
        });
      });
      if (start) {
        const job = stableJob({ type: 'generate', evalRunId: id, queryId: query.id });
        batch.create(ref('eval_jobs', job.id), job);
      }
    }
    await batch.commit();
    if (start) await publishPending(id);
    return {
      evalRunId: id,
      suiteId: suite.id,
      suiteName: suite.name,
      queries: suite.queries,
      models,
      judgeModel,
      queryCount: run.query_count,
      modelCount: run.model_count,
      variantCount: run.variant_count,
      queryConcurrency: 1,
    };
  }

  async function persistWithLease(body, token, writes) {
    await db.runTransaction(async (tx) => {
      const jobDoc = await tx.get(ref('eval_jobs', body.jobId));
      if (jobDoc.data()?.state !== 'running' || jobDoc.data().lease_token !== token) {
        throw new Error('Evaluation job lease was lost');
      }
      writes(tx);
    });
  }

  async function generateJob(body, run, env, token) {
    const variants = dataRows(await runQuery('experiment_variants', run.id).get())
      .filter((variant) => (body.variantId ? variant.id === body.variantId
        : variant.eval_query_id === body.queryId));
    if (!variants.length) throw new RequestError('No variants for evaluation job', 404);
    const queryDef = run.suite.queries.find((query) => query.id === variants[0].eval_query_id);
    const pending = variants.filter((variant) => variant.status !== 'complete');
    if (pending.length) {
      const outputs = await generate({
        queryDef,
        models: pending.map((variant) => ({
          id: variant.id,
          provider: variant.provider,
          model: variant.model,
          temperature: variant.temperature,
          maxTokens: variant.max_tokens,
        })),
        env,
      });
      for (const variant of pending) {
        const output = outputs.find((result) => result.id === variant.id);
        if (!output?.blocks?.length) throw new Error('Generation produced no durable variant content');
        const { runAssertions } = await import('../../../workers/recommender/src/evaluations/assertions.js');
        const assertions = runAssertions(output.blocks, queryDef);
        const payload = clean({
          ...output,
          variantId: variant.id,
          experimentId: variant.experiment_id,
          request: { query: queryDef.query },
        });
        // Viewer compatibility uses the same KV keys as the shared worker,
        // backed by the native Firestore KV, never Cloudflare.
        if (env.SESSION_STORE) {
          await env.SESSION_STORE.put(`experiment:${variant.experiment_id}:variant:${variant.id}`, JSON.stringify(payload));
        }
        const changes = {
          status: 'complete',
          title: output.title || '',
          block_count: output.blocks.length,
          duration_ms: output.duration_ms || 0,
          time_to_first_token_ms: output.time_to_first_token_ms ?? null,
          input_tokens: output.input_tokens || 0,
          output_tokens: output.output_tokens || 0,
          error: null,
          evaluator_score: null,
          evaluator_notes: JSON.stringify({
            assertions,
            blocker: !assertions.passed,
            blocker_reasons: assertions.passed ? [] : ['assertions-failed'],
          }),
        };
        await persistWithLease(body, token, (tx) => {
          tx.set(ref('eval_payloads', variant.id), payload);
          tx.update(ref('experiment_variants', variant.id), changes);
        });
      }
    }
    await persistWithLease(body, token, (tx) => tx.update(ref('experiments', variants[0].experiment_id), { status: 'complete', completed_at: now() }));
    if (body.type === 'regenerate') await judgeJob(body, run, env, token);
  }

  async function judgeJob(body, run, env, token) {
    const variant = await get('experiment_variants', body.variantId);
    if (variant.eval_run_id !== run.id) throw new RequestError('Variant belongs to a different evaluation', 404);
    if (variant.status !== 'complete') throw new Error('Cannot judge an incomplete variant');
    if (body.type === 'judge' && variant.evaluator_score != null) return;
    const payload = await get('eval_payloads', variant.id);
    const queryDef = run.suite.queries.find((query) => query.id === variant.eval_query_id);
    const judge = config.judge || (await judgeModule()).judgeVariant;
    const judgement = await judge(env, {
      judgeModel: run.judge_model,
      query: queryDef.query,
      expectedIntent: queryDef.expectedIntent,
      expectedBehavior: queryDef.expectedBehavior,
      classifiedIntent: payload.intent?.type,
      journeyStage: payload.journeyStage,
      rag: payload.rag,
      blocks: payload.blocks,
    });
    const notes = JSON.parse(variant.evaluator_notes || '{}');
    const reasons = [
      ...(notes.assertions?.passed === false ? ['assertions-failed'] : []),
      ...(judgement.dims?.structure?.score < 3 ? ['structure<3'] : []),
      ...(judgement.dims?.faithfulness?.score < 3 ? ['faithfulness<3'] : []),
    ];
    await persistWithLease(body, token, (tx) => tx.update(ref('experiment_variants', variant.id), {
      evaluator_score: judgement.score,
      judge_input_tokens: judgement.inputTokens || 0,
      judge_output_tokens: judgement.outputTokens || 0,
      evaluator_notes: JSON.stringify({
        ...judgement.dims,
        assertions: notes.assertions,
        blocker: reasons.length > 0,
        blocker_reasons: reasons,
        summary: judgement.summary,
        judge_model: judgement.judgeModel,
        judge_input_tokens: judgement.inputTokens || 0,
        judge_output_tokens: judgement.outputTokens || 0,
        judge_duration_ms: judgement.durationMs,
      }),
    }));
  }

  async function queue(batch, env) {
    for (const message of batch.messages) {
      const { body } = message;
      const token = randomUUID();
      const claimed = await db.runTransaction(async (tx) => {
        const [jobDoc, runDoc] = await Promise.all([
          tx.get(ref('eval_jobs', body.jobId)), tx.get(ref('eval_runs', body.evalRunId)),
        ]);
        if (!jobDoc.exists || !runDoc.exists) throw new Error('Evaluation task references missing state');
        const job = jobDoc.data();
        if (!isDeepStrictEqual(job.body, body)) throw new Error('Evaluation task body does not match durable job');
        const run = runDoc.data();
        if (run.status === 'purged' || !ACTIVE_JOB_STATES.has(job.state)) return { terminal: true, run };
        if (job.state === 'running' && job.lease_until > now()) {
          return { busy: Math.ceil((job.lease_until - now()) / 1000) + 1 };
        }
        tx.update(jobDoc.ref, {
          state: 'running',
          lease_token: token,
          lease_until: now() + LEASE_MS,
          attempts: job.attempts + 1,
          last_activity_at: now(),
        });
        return { run };
      });
      if (claimed.busy) {
        message.retry({ delaySeconds: claimed.busy });
        continue;
      }
      if (!claimed.terminal) {
        try {
          if (body.type === 'generate' || body.type === 'regenerate') await generateJob(body, claimed.run, env, token);
          else if (body.type === 'judge' || body.type === 'rejudge') await judgeJob(body, claimed.run, env, token);
          else throw new Error('Unknown evaluation task type');
          await db.runTransaction(async (tx) => {
            const snapshot = await tx.get(ref('eval_jobs', body.jobId));
            if (snapshot.data().lease_token !== token) throw new Error('Evaluation job lease was lost');
            tx.update(snapshot.ref, { state: 'complete', lease_until: 0, last_activity_at: now() });
          });
        } catch (error) {
          await db.runTransaction(async (tx) => {
            const snapshot = await tx.get(ref('eval_jobs', body.jobId));
            if (snapshot.data().lease_token === token) {
              tx.update(snapshot.ref, {
                state: 'queued', lease_until: 0, last_activity_at: now(), error: error.message,
              });
            }
          });
          if (error.status === 429) {
            const delaySeconds = 30 * Math.max(1, message.attempts);
            await ref('eval_jobs', body.jobId).update({
              next_attempt_at: now() + delaySeconds * 1000,
            });
            message.retry({ delaySeconds });
            continue;
          }
          throw error;
        }
      }
      await reconcile(body.evalRunId);
      message.ack();
    }
  }

  async function deliver({
    body, attempts = 1, taskId, env, ctx,
  }) {
    const job = await get('eval_jobs', body.jobId);
    if (!ACTIVE_JOB_STATES.has(job.state)) {
      await reconcile(body.evalRunId);
      return { acknowledged: true, taskId: body.jobId };
    }
    const result = await deliverTask({
      body,
      attempts: Math.max(attempts, job.attempts + 1),
      taskId: body.jobId || taskId,
      worker: { queue },
      env: { ...env, EVAL_QUEUE: transport },
      ctx,
    });
    if (result.deadLettered) {
      const variants = dataRows(await runQuery('experiment_variants', body.evalRunId).get())
        .filter((variant) => (body.variantId ? variant.id === body.variantId
          : variant.eval_query_id === body.queryId));
      const batch = db.batch();
      batch.update(ref('eval_jobs', body.jobId), { state: 'deadletter', lease_until: 0, last_activity_at: now() });
      variants.forEach((variant) => {
        const isGeneration = body.type === 'generate' || body.type === 'regenerate';
        if (body.type === 'generate' && variant.status === 'complete') return;
        batch.update(ref('experiment_variants', variant.id), isGeneration && variant.status !== 'complete'
          ? { status: 'error', error: 'Evaluation task exhausted retries; see Firestore deadletter' }
          : { evaluator_notes: JSON.stringify({ judge_error: 'Evaluation task exhausted retries; see Firestore deadletter' }) });
      });
      await batch.commit();
      await reconcile(body.evalRunId);
    }
    return result;
  }

  async function enqueue(runId, bodies, resetVariant = false) {
    await db.runTransaction(async (tx) => {
      const runDoc = await tx.get(ref('eval_runs', runId));
      const jobDocs = await tx.get(runQuery('eval_jobs', runId));
      const variantDocs = await tx.get(runQuery('experiment_variants', runId));
      if (!runDoc.exists) throw new RequestError('Evaluation not found', 404);
      const variants = dataRows(variantDocs);
      for (const body of bodies) {
        if (body.variantId && !variants.some((variant) => variant.id === body.variantId)) {
          throw new RequestError('Variant not found in evaluation', 404);
        }
        const conflict = dataRows(jobDocs).some((job) => ACTIVE_JOB_STATES.has(job.state)
          && (body.variantId ? job.body.variantId === body.variantId || job.body.type === 'generate'
            : job.body.queryId === body.queryId));
        if (conflict) throw new RequestError('Evaluation work is already queued or running', 409);
      }
      for (const body of bodies) {
        const job = jobRow({ ...body, evalRunId: runId });
        tx.create(ref('eval_jobs', job.id), job);
        if (resetVariant && body.variantId) {
          tx.update(ref('experiment_variants', body.variantId), {
            status: 'running', evaluator_score: null, evaluator_notes: null,
          });
        }
      }
      tx.update(runDoc.ref, {
        phase: bodies.some((body) => body.type === 'generate') ? 'generating' : 'judging',
        status: 'running',
        last_activity_at: now(),
      });
    });
    await publishPending(runId);
  }

  async function getQueueStatus() {
    const jobs = dataRows(await collection('eval_jobs').get()).filter((job) => ACTIVE_JOB_STATES.has(job.state));
    const pendingGenerate = jobs.filter((job) => job.body.type === 'generate').length;
    const pendingJudge = jobs.filter((job) => job.body.type === 'judge').length;
    return {
      platform: 'gcp',
      backend: 'cloud-tasks',
      countsSource: 'firestore-evaluation-jobs',
      pendingGenerate,
      pendingJudge,
      pendingRetries: jobs.length - pendingGenerate - pendingJudge,
      total: jobs.length,
      activeRuns: new Set(jobs.map((job) => job.eval_run_id)).size,
    };
  }

  async function scheduled() {
    const jobs = dataRows(await collection('eval_jobs').get());
    for (const job of jobs) {
      if (job.state === 'pending'
        || (job.state === 'queued' && job.last_activity_at < now() - STALE_MS
          && (!job.next_attempt_at || job.next_attempt_at <= now()))
        || (job.state === 'running' && job.lease_until < now())) {
        await publish(job);
      }
    }
    const runs = dataRows(await collection('eval_runs').get());
    for (const run of runs.filter((entry) => ['generating', 'judging'].includes(entry.phase))) {
      await reconcile(run.id);
    }
  }

  async function fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!/^\/api\/admin\/(eval-suites|evaluations|eval-queue)(\/|$)/.test(path)) return null;
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }
    const authorize = config.authorize || (await import('../../../workers/recommender/src/admin.js')).requireAdminAuth;
    const unauthorized = await authorize(request, env);
    if (unauthorized) return unauthorized;
    try {
      const parseBody = async () => {
        try { return await request.json(); } catch { throw new RequestError('Invalid JSON body'); }
      };
      if (path === '/api/admin/eval-suites' && request.method === 'GET') {
        const all = await suites();
        const judgeModels = config.judgeModels || (await judgeModule()).getJudgeModels(env);
        if (url.searchParams.has('id')) {
          const suite = all.find((entry) => entry.id === url.searchParams.get('id'));
          return suite ? response({ suite, judgeModels }) : response({ error: 'Suite not found' }, 404);
        }
        return response({
          suites: all.map(({ queries, ...suite }) => ({ ...suite, queryCount: queries.length })),
          judgeModels,
        });
      }
      if (path === '/api/admin/eval-queue' && request.method === 'GET') return response(await getQueueStatus());
      if (path === '/api/admin/eval-queue/consumers' && request.method === 'GET') {
        return response({ platform: 'gcp', queue: await transport.getQueueState(), consumers: [await transport.getConsumerState()] });
      }
      if (path === '/api/admin/eval-queue/resume-delivery' && request.method === 'POST') {
        return response({ platform: 'gcp', queue: await transport.resume() });
      }
      if (path === '/api/admin/eval-queue/purge' && request.method === 'POST') {
        // Stop native jobs/runs BEFORE purging to fence in-flight deliveries.
        const jobs = dataRows(await collection('eval_jobs').get()).filter((job) => ACTIVE_JOB_STATES.has(job.state));
        const runs = new Set(jobs.map((job) => job.eval_run_id));
        for (const runId of runs) {
          await db.runTransaction(async (tx) => {
            const runDoc = await tx.get(ref('eval_runs', runId));
            const jobDocs = await tx.get(runQuery('eval_jobs', runId));
            const variantDocs = await tx.get(runQuery('experiment_variants', runId));
            if (runDoc.exists) tx.update(runDoc.ref, { phase: 'error', status: 'purged', last_activity_at: now() });
            jobDocs.docs.filter((doc) => ACTIVE_JOB_STATES.has(doc.data().state))
              .forEach((doc) => tx.update(doc.ref, { state: 'cancelled', lease_token: null, lease_until: 0 }));
            variantDocs.docs.filter((doc) => doc.data().status === 'running')
              .forEach((doc) => tx.update(doc.ref, { status: 'error', error: 'queue purged' }));
          });
        }
        await transport.purge();
        return response({ platform: 'gcp', purged: true, resumeWarning: null });
      }
      if ((path === '/api/admin/evaluations' || path === '/api/admin/evaluations/start') && request.method === 'POST') {
        return response(await create(await parseBody(), env, path.endsWith('/start')));
      }
      if (path === '/api/admin/evaluations' && request.method === 'GET') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const rows = dataRows(await collection('eval_runs').orderBy('created_at', 'desc').get());
        return response({
          runs: rows.slice(offset, offset + limit), total: rows.length, limit, offset,
        });
      }
      const match = path.match(/^\/api\/admin\/evaluations\/([^/]+)(?:\/(.*))?$/);
      if (!match) return response({ error: 'Unknown evaluation route' }, 404);
      const [, runId, action = ''] = match;
      const run = await get('eval_runs', runId);
      if (action === 'progress' && request.method === 'GET') {
        return response({
          evalRunId: run.id,
          status: run.status,
          phase: run.phase,
          completedQueries: run.completed_queries,
          queryCount: run.query_count,
          modelCount: run.model_count,
          lastActivityAt: run.last_activity_at,
        });
      }
      if (!action && request.method === 'GET') {
        return response({
          run,
          suite: run.suite,
          experiments: dataRows(await runQuery('experiments', runId).get()),
          variants: dataRows(await runQuery('experiment_variants', runId).get()),
        });
      }
      if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
      if (action === 'finalize') {
        await reconcile(runId);
        return response({ ok: true, run: await get('eval_runs', runId) });
      }
      const variants = dataRows(await runQuery('experiment_variants', runId).get());
      if (action === 'resume' || action === 'queries') {
        const body = action === 'queries' ? await parseBody() : {};
        if (action === 'queries' && !run.suite.queries.some((query) => query.id === body.queryId)) {
          throw new RequestError('Unknown queryId');
        }
        const queries = run.suite.queries.filter((query) => (action === 'queries' ? query.id === body.queryId
          : variants.filter((variant) => variant.eval_query_id === query.id).every((variant) => variant.status !== 'complete')));
        if (!queries.length) return response({ resumed: 0, total: run.query_count });
        await enqueue(runId, queries.map((query) => ({ type: 'generate', queryId: query.id })));
        return response({ queued: true, resumed: queries.length, total: run.query_count });
      }
      if (action === 'judge') {
        let body = {};
        try { body = await request.json(); } catch { /* optional scope */ }
        const targets = variants.filter((variant) => variant.status === 'complete'
          && (body.scope === 'all' || (body.scope === 'errors'
            ? JSON.parse(variant.evaluator_notes || '{}').judge_error : variant.evaluator_score == null)));
        if (targets.length) {
          await ref('eval_runs', runId).update({ skip_judge: false });
          await enqueue(runId, targets.map((variant) => ({ type: 'rejudge', variantId: variant.id })));
        }
        return response({ queued: targets.length });
      }
      const variantAction = action.match(/^variants\/([^/]+)\/(rejudge|regenerate)$/);
      if (variantAction) {
        const [, variantId, type] = variantAction;
        await enqueue(runId, [{ type, variantId }], type === 'regenerate');
        return response({ queued: true, variantId });
      }
      return response({ error: 'Unknown evaluation route' }, 404);
    } catch (error) {
      return response({ error: error instanceof RequestError ? error.message : 'Evaluation operation failed' }, error.status || 500);
    }
  }

  return {
    fetch, queue, deliver, scheduled, getQueueStatus,
  };
}
