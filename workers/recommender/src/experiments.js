/**
 * Admin experiments — run the same query through N LLM variants in parallel.
 *
 * Upstream pipeline (intent + persona/use-case + RAG + prompt build) runs
 * ONCE per experiment. Then N variants fan out on the final llm-generate
 * step only, each writing NDJSON events tagged with their variantId onto the
 * shared stream. This keeps cost at ~1× RAG + N× LLM and isolates the model
 * choice as the only variable in the comparison.
 *
 * D1:  `experiments` + `experiment_variants` (see migration 0004).
 * KV:  `experiment:{experimentId}:variant:{variantId}` — full per-variant
 *      payload, same shape as the `page:{runId}` payload produced by
 *      storage.js so the admin block can render variants with the existing
 *      `renderStoredSection()` helper.
 *
 * Endpoints (all Basic or cookie auth, gated by ADMIN_TOKEN):
 *   POST /api/admin/experiments                        — create + stream
 *   GET  /api/admin/experiments?limit=&offset=         — paginated list
 *   GET  /api/admin/experiments/:id                    — metadata + variants
 *   GET  /api/admin/experiments/:id/variants/:variantId — full KV payload
 */

import { createContext, CORS_HEADERS } from './pipeline/context.js';
import { executeFlow } from './pipeline/executor.js';
import { resolveFlow } from './pipeline/flows.js';
import { STEPS } from './pipeline/steps/index.js';
import { runLlmVariant, createVariantState, extractTitle } from './pipeline/steps/llm-generate.js';
import { setHeroResult } from './images.js';
import { selectHeroImage } from './hero-images.js';
import { extractProductIds } from './context.js';
import { findCatalogEntry, catalogAvailability } from './providers/index.js';
import { resolveLlmConfig } from './llm-config.js';
import { requireAdminAuth } from './admin.js';

const VARIANT_PAYLOAD_TTL = 60 * 60 * 24 * 90; // 90 days
const MAX_VARIANTS_PER_EXPERIMENT = 12;
const KV_KEY = (expId, varId) => `experiment:${expId}:variant:${varId}`;

// ── Request validation ─────────────────────────────────────────────────────────

function validateCreateBody(body, env) {
  if (!body || typeof body !== 'object') return { error: 'Invalid body' };
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return { error: 'query is required' };
  if (query.length > 500) return { error: 'query exceeds 500 chars' };

  const rawVariants = Array.isArray(body.variants) ? body.variants : [];
  if (rawVariants.length === 0) return { error: 'at least one variant is required' };
  if (rawVariants.length > MAX_VARIANTS_PER_EXPERIMENT) {
    return { error: `at most ${MAX_VARIANTS_PER_EXPERIMENT} variants per experiment` };
  }

  const variants = [];
  for (let i = 0; i < rawVariants.length; i += 1) {
    const v = rawVariants[i];
    if (!v || typeof v !== 'object') return { error: `variant[${i}] must be an object` };
    const entry = findCatalogEntry(v.provider, v.model);
    if (!entry) return { error: `variant[${i}] unknown provider/model: ${v.provider}/${v.model}` };
    const { available, missing } = catalogAvailability(entry, env);
    if (!available) {
      return { error: `variant[${i}] (${entry.label}) not available — missing: ${missing.join(', ')}` };
    }
    const temperature = typeof v.temperature === 'number' && !Number.isNaN(v.temperature)
      ? Math.max(0, Math.min(2, v.temperature))
      : null;
    const maxTokens = typeof v.maxTokens === 'number' && !Number.isNaN(v.maxTokens)
      ? Math.max(256, Math.min(16384, Math.round(v.maxTokens)))
      : null;
    variants.push({
      provider: entry.provider,
      model: entry.model,
      label: entry.label,
      temperature,
      maxTokens,
    });
  }

  return {
    payload: {
      query,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl : null,
      variants,
    },
  };
}

// ── Streaming helpers ──────────────────────────────────────────────────────────

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

// ── Persistence ────────────────────────────────────────────────────────────────

async function insertExperimentRow(db, exp) {
  await db.prepare(`
    INSERT INTO experiments
      (id, session_id, query, page_url, variant_count, status,
       created_at, shared_intent_type, shared_journey_stage)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  `).bind(
    exp.id,
    exp.sessionId,
    exp.query,
    exp.pageUrl,
    exp.variantCount,
    'running',
    exp.createdAt,
    exp.intentType,
    exp.journeyStage,
  ).run();
}

async function insertVariantRow(db, v) {
  await db.prepare(`
    INSERT INTO experiment_variants
      (id, experiment_id, variant_index, provider, model,
       temperature, max_tokens, status)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running')
  `).bind(
    v.id,
    v.experimentId,
    v.variantIndex,
    v.provider,
    v.model,
    v.temperature,
    v.maxTokens,
  ).run();
}

async function finalizeVariantRow(db, v) {
  await db.prepare(`
    UPDATE experiment_variants
    SET status = ?1, duration_ms = ?2, input_tokens = ?3, output_tokens = ?4,
        title = ?5, block_count = ?6, error = ?7, time_to_first_token_ms = ?8
    WHERE id = ?9
  `).bind(
    v.status,
    v.durationMs,
    v.inputTokens,
    v.outputTokens,
    v.title,
    v.blockCount,
    v.error,
    v.ttftMs ?? null,
    v.id,
  ).run();
}

async function finalizeExperimentRow(db, expId, status, sharedDurationMs) {
  await db.prepare(`
    UPDATE experiments
    SET status = ?1, completed_at = ?2, shared_duration_ms = ?3
    WHERE id = ?4
  `).bind(status, Date.now(), sharedDurationMs, expId).run();
}

function buildVariantPayload(ctx, variant) {
  const { state } = variant;
  return {
    variantId: variant.id,
    experimentId: variant.experimentId,
    variantIndex: variant.variantIndex,
    provider: variant.provider,
    model: variant.model,
    temperature: variant.temperature,
    maxTokens: variant.maxTokens,
    blocks: (state.sections || []).map((html, i) => ({
      index: i,
      blockType: state.rawJsonSections?.[i]?.block || 'unknown',
      html,
    })),
    followUpOptions: state.suggestions || [],
    debug: {
      intent: ctx.intent || null,
      behaviorAnalysis: ctx.rag?.behaviorAnalysis || null,
      prompt: {
        systemLength: ctx.prompt?.system?.length || 0,
        userLength: ctx.prompt?.user?.length || 0,
        systemPrompt: ctx.prompt?.system || '',
        userMessage: ctx.prompt?.user || '',
      },
      ttftMs: variant.ttftMs ?? null,
      timings: variant.timings || {},
      llm: {
        provider: variant.provider,
        model: variant.model,
        temperature: variant.temperature,
        maxTokens: variant.maxTokens,
        inputTokens: state.usage?.prompt_tokens || null,
        outputTokens: state.usage?.completion_tokens || null,
        rawOutput: state.fullText || '',
        jsonSections: state.rawJsonSections || [],
        suggestions: state.suggestions || [],
      },
      error: variant.error || null,
    },
    request: {
      query: ctx.request?.query,
      previousQueries: ctx.request?.previousQueries || [],
      browsingHistory: ctx.request?.browsingHistory || [],
      inferredProfile: ctx.request?.inferredProfile || null,
    },
  };
}

// ── POST /api/admin/experiments ────────────────────────────────────────────────

export async function handleCreateExperiment(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validation = validateCreateBody(rawBody, env);
  if (validation.error) return jsonResponse({ error: validation.error }, { status: 400 });
  const body = validation.payload;

  // Shared pipeline context — upstream steps mutate ctx.rag, ctx.intent, ctx.prompt.
  const ctx = createContext({
    query: body.query,
    sessionId: body.sessionId,
  }, request);
  const flow = resolveFlow('default');
  ctx.flowId = flow.id;
  ctx.flowName = flow.name || flow.id;

  // Gate steps run before we open the stream (rate-limit can set ctx.earlyResponse).
  if (!ctx.timings.steps) ctx.timings.steps = [];
  const gateSteps = flow.steps.filter((s) => s.gate);
  for (let i = 0; i < gateSteps.length; i += 1) {
    if (ctx.earlyResponse) break;
    const s = gateSteps[i];
    const gateStart = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await STEPS[s.step](ctx, s.config || {}, env);
    ctx.timings.steps.push({ step: s.step, ms: Date.now() - gateStart, gate: true });
  }
  if (ctx.earlyResponse) return ctx.earlyResponse;

  // Upstream flow = every non-gate step up to and including build-recommender-prompt.
  // llm-generate is explicitly excluded — we fan it out per variant below.
  const upstreamSteps = flow.steps.filter(
    (s) => !s.gate && !(s.step === 'llm-generate'),
  );

  const experimentId = crypto.randomUUID();
  const variants = body.variants.map((v, i) => {
    const resolved = resolveLlmConfig(
      {
        provider: v.provider, model: v.model, temperature: v.temperature, maxTokens: v.maxTokens,
      },
      flow.steps.find((s) => s.step === 'llm-generate')?.config || {},
    );
    return {
      id: crypto.randomUUID(),
      experimentId,
      variantIndex: i,
      provider: resolved.provider,
      model: resolved.model,
      label: v.label,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
      state: createVariantState(),
      timings: {},
      status: 'running',
      startedAt: null,
      finishedAt: null,
      error: null,
    };
  });

  const { readable, writable } = new TransformStream();
  ctx.writer = writable.getWriter();
  ctx.encoder = new TextEncoder();

  const streamPromise = (async () => {
    const { encoder } = ctx;
    const { writer } = ctx;
    const writeLine = (obj) => writer.write(encoder.encode(`${JSON.stringify(obj)}\n`));

    try {
      await writeLine({
        type: 'experiment-start',
        experimentId,
        variantCount: variants.length,
        variants: variants.map((v) => ({
          variantId: v.id,
          variantIndex: v.variantIndex,
          provider: v.provider,
          model: v.model,
          label: v.label,
          temperature: v.temperature,
          maxTokens: v.maxTokens,
        })),
      });

      // ── Shared upstream pipeline ────────────────────────────────────────────
      const upstreamStart = Date.now();
      await executeFlow(upstreamSteps, ctx, env);
      const sharedDurationMs = Date.now() - upstreamStart;

      // Pin hero image once — shared across all variants.
      const heroImage = selectHeroImage({
        query: ctx.request?.query,
        useCases: ctx.rag?.useCase?.useCases,
        intentType: ctx.intent?.type,
        productIds: extractProductIds(ctx.request?.query || ''),
      }, ctx.rag?.heroImages || []);
      setHeroResult(heroImage);

      const intentType = ctx.intent?.type || null;
      const journeyStage = ctx.request?.inferredProfile?.journeyStage || null;

      await writeLine({
        type: 'upstream-done',
        sharedDurationMs,
        intentType,
        journeyStage,
        steps: ctx.timings.steps,
      });

      // Write D1 rows now (status=running) so the experiment is visible to the
      // list endpoint even before variants finish.
      if (env.SESSIONS_DB) {
        try {
          await insertExperimentRow(env.SESSIONS_DB, {
            id: experimentId,
            sessionId: body.sessionId,
            query: body.query,
            pageUrl: body.pageUrl,
            variantCount: variants.length,
            createdAt: Date.now(),
            intentType,
            journeyStage,
          });
          // Batch variant inserts — one per variant.
          await Promise.all(
            variants.map((v) => insertVariantRow(env.SESSIONS_DB, v)),
          );
        } catch (dbErr) {
          console.error('[Experiment] pre-fanout D1 insert failed:', dbErr.message);
        }
      }

      // ── Fan out to N LLMs in parallel ───────────────────────────────────────
      await Promise.all(variants.map(async (v) => {
        v.startedAt = Date.now();
        await writeLine({
          type: 'variant-start',
          variantId: v.id,
          variantIndex: v.variantIndex,
          provider: v.provider,
          model: v.model,
          label: v.label,
          temperature: v.temperature,
          maxTokens: v.maxTokens,
        });

        try {
          const { title, usedProducts } = await runLlmVariant(ctx, env, {
            variantId: v.id,
            provider: v.provider,
            model: v.model,
            temperature: v.temperature,
            maxTokens: v.maxTokens,
            out: v.state,
            timings: v.timings,
            emitDebug: false,
            emitDone: false,
          });
          v.finishedAt = Date.now();
          v.status = 'complete';
          v.title = title;
          v.usedProducts = usedProducts;
          v.ttftMs = (v.timings.llmFirstToken && v.timings.llmStart)
            ? v.timings.llmFirstToken - v.timings.llmStart
            : null;

          await writeLine({
            type: 'variant-done',
            variantId: v.id,
            durationMs: v.finishedAt - v.startedAt,
            ttftMs: v.ttftMs,
            inputTokens: v.state.usage?.prompt_tokens || null,
            outputTokens: v.state.usage?.completion_tokens || null,
            totalTokens: v.state.usage?.total_tokens || null,
            title,
            blockCount: v.state.sections.length,
            usedProducts,
          });
        } catch (err) {
          v.finishedAt = Date.now();
          v.status = 'error';
          v.error = err.message || 'variant failed';
          await writeLine({
            type: 'variant-error',
            variantId: v.id,
            message: v.error,
          });
        }
      }));

      // ── Persist each variant's payload to KV + update D1 rows ──────────────
      if (env.SESSION_STORE && env.SESSIONS_DB) {
        await Promise.all(variants.map(async (v) => {
          try {
            const payload = buildVariantPayload(ctx, v);
            await env.SESSION_STORE.put(
              KV_KEY(experimentId, v.id),
              JSON.stringify(payload),
              { expirationTtl: VARIANT_PAYLOAD_TTL },
            );
          } catch (kvErr) {
            console.error(`[Experiment] variant KV write failed (${v.id}):`, kvErr.message);
          }
          try {
            await finalizeVariantRow(env.SESSIONS_DB, {
              id: v.id,
              status: v.status,
              durationMs: v.finishedAt && v.startedAt ? v.finishedAt - v.startedAt : null,
              ttftMs: v.ttftMs ?? null,
              inputTokens: v.state.usage?.prompt_tokens || null,
              outputTokens: v.state.usage?.completion_tokens || null,
              title: v.title || extractTitle(v.state.sections[0] || '') || null,
              blockCount: v.state.sections.length,
              error: v.error,
            });
          } catch (dbErr) {
            console.error(`[Experiment] variant D1 finalize failed (${v.id}):`, dbErr.message);
          }
        }));
      }

      const allComplete = variants.every((v) => v.status === 'complete');
      const anyComplete = variants.some((v) => v.status === 'complete');
      let expStatus;
      if (allComplete) expStatus = 'complete';
      else if (anyComplete) expStatus = 'complete';
      else expStatus = 'error';
      if (env.SESSIONS_DB) {
        try {
          await finalizeExperimentRow(env.SESSIONS_DB, experimentId, expStatus, sharedDurationMs);
        } catch (dbErr) {
          console.error('[Experiment] experiment finalize failed:', dbErr.message);
        }
      }

      await writeLine({
        type: 'experiment-done',
        experimentId,
        status: expStatus,
        variantCount: variants.length,
        completedCount: variants.filter((v) => v.status === 'complete').length,
      });
    } catch (err) {
      await writeLine({ type: 'error', message: err.message || 'experiment failed' });
    } finally {
      await ctx.writer.close();
    }
  })();

  request.ctx?.waitUntil?.(streamPromise);
  if (!request.ctx) streamPromise.catch(() => {});

  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
}

// ── GET /api/admin/experiments ─────────────────────────────────────────────────

export async function handleListExperiments(request, env) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;
  if (!env.SESSIONS_DB) {
    return jsonResponse({
      experiments: [], total: 0, limit: 0, offset: 0,
    });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const { results: experiments } = await env.SESSIONS_DB.prepare(`
    SELECT e.id, e.query, e.variant_count, e.status, e.created_at, e.completed_at,
           e.shared_intent_type, e.shared_journey_stage, e.shared_duration_ms,
           (SELECT COUNT(*) FROM experiment_variants v
              WHERE v.experiment_id = e.id AND v.status = 'complete') as complete_count
    FROM experiments e
    ORDER BY e.created_at DESC
    LIMIT ?1 OFFSET ?2
  `).bind(limit, offset).all();

  const { results: countRow } = await env.SESSIONS_DB.prepare(
    'SELECT COUNT(*) as total FROM experiments',
  ).all();

  return jsonResponse({
    experiments,
    total: countRow[0]?.total || 0,
    limit,
    offset,
  });
}

// ── GET /api/admin/experiments/:id ─────────────────────────────────────────────

export async function handleGetExperiment(request, env, experimentId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  const { results: [experiment] } = await env.SESSIONS_DB.prepare(
    'SELECT * FROM experiments WHERE id = ?1',
  ).bind(experimentId).all();

  if (!experiment) {
    return jsonResponse({ error: 'Experiment not found' }, { status: 404 });
  }

  const { results: variants } = await env.SESSIONS_DB.prepare(
    'SELECT * FROM experiment_variants WHERE experiment_id = ?1 ORDER BY variant_index ASC',
  ).bind(experimentId).all();

  return jsonResponse({ experiment, variants });
}

// ── GET /api/admin/experiments/:id/variants/:variantId ────────────────────────

export async function handleGetExperimentVariant(request, env, experimentId, variantId) {
  const unauth = await requireAdminAuth(request, env);
  if (unauth) return unauth;

  const { results: [variant] } = await env.SESSIONS_DB.prepare(
    'SELECT * FROM experiment_variants WHERE id = ?1 AND experiment_id = ?2',
  ).bind(variantId, experimentId).all();

  if (!variant) {
    return jsonResponse({ error: 'Variant not found' }, { status: 404 });
  }

  const payload = env.SESSION_STORE
    ? await env.SESSION_STORE.get(KV_KEY(experimentId, variantId), 'json')
    : null;

  return jsonResponse({ variant, payload });
}
