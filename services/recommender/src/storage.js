import { randomUUID, createHash } from 'node:crypto';
import { CORS_HEADERS } from '../../../workers/recommender/src/pipeline/context.js';
import { hashIp, rowToRunDto } from '../../../workers/recommender/src/storage.js';
import { costUsd } from '../../../workers/recommender/src/pricing.js';

const TABLES = new Set([
  'sessions', 'generated_pages', 'page_counters', 'experiments', 'experiment_variants',
  'eval_runs', 'eval_payloads', 'eval_jobs', 'run_feedback', 'page_events', 'conversions',
]);
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
});
const sum = (rows, field) => rows.reduce((n, row) => n + (Number(row[field]) || 0), 0);
const distinct = (rows, field) => new Set(rows.map((r) => r[field]).filter((v) => v != null)).size;
const descending = (rows, field = 'created_at') => (
  rows.sort((a, b) => (b[field] || 0) - (a[field] || 0))
);
const parseArray = (value) => {
  if (Array.isArray(value)) return value;
  try {
    const result = JSON.parse(value);
    return Array.isArray(result) ? result : [];
  } catch { return []; }
};
const FEEDBACK_FLAGS = new Set([
  'wrong-product', 'off-topic', 'inappropriate-tone', 'harmful-unsafe',
]);
function feedbackDto(row) {
  const keys = [
    'id', 'run_id', 'page_id', 'session_id', 'rating', 'comment', 'dwell_ms', 'user_agent',
    'created_at', 'updated_at', 'query', 'intent_type', 'journey_stage', 'llm_provider',
    'llm_model', 'da_path', 'title',
  ];
  return {
    ...Object.fromEntries(keys.map((key) => [key, row[key] ?? null])),
    flags: parseArray(row.flags),
    wrong_products: parseArray(row.wrong_products),
  };
}
function matchesLike(value, search) {
  const expression = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(expression, 'i').test(value || '');
}
const totalCost = (rows) => rows.reduce((n, r) => (
  n + costUsd(r.llm_provider, r.llm_model, r.input_tokens, r.output_tokens)
), 0);
const seconds = (value) => (value > 1e11 ? value / 1000 : value);
const snake = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value === undefined ? null : value,
]));
function pagination(request) {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(200, Math.max(1, Number.parseInt(params.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, Number.parseInt(params.get('offset') || '0', 10) || 0);
  return { limit, offset };
}
function group(rows, key) {
  const groups = new Map();
  rows.forEach((row) => {
    const value = key(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  });
  return groups;
}

/**
 * Native Firestore repository. Rows retain Worker snake_case field names;
 * there is deliberately no prepare()/SQL interface. Scans fail explicitly at
 * maxDocuments rather than returning misleading partial dashboard totals.
 */
export class FirestoreStorage {
  constructor({ firestore, sessionStore, maxDocuments = 5000 }) {
    if (!firestore) throw new TypeError('firestore is required');
    this.firestore = firestore;
    this.sessionStore = sessionStore;
    this.maxDocuments = maxDocuments;
  }

  collection(table) {
    if (!TABLES.has(table)) throw new Error(`Unknown repository collection: ${table}`);
    return this.firestore.collection(`arco_${table}_gcp`);
  }

  reference(table, id) {
    if (typeof id !== 'string' || !id) throw new TypeError('Document id must be a nonempty string');
    return this.collection(table).doc(encodeURIComponent(id));
  }

  async get(table, id) {
    const snapshot = await this.reference(table, id).get();
    return snapshot.exists ? { id, ...snapshot.data() } : null;
  }

  async list(table, {
    limit = this.maxDocuments, orderBy, direction = 'asc', where = [],
  } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxDocuments) {
      throw new RangeError(`Repository limit must be 1..${this.maxDocuments}`);
    }
    let query = this.collection(table);
    where.forEach(([field, operator, value]) => { query = query.where(field, operator, value); });
    if (orderBy) query = query.orderBy(orderBy, direction);
    const snapshot = await query.limit(limit + 1).get();
    if (snapshot.docs.length > limit) {
      throw new RangeError(`${table} exceeds bounded ${limit}-document scan`);
    }
    return snapshot.docs.map((doc) => ({ id: decodeURIComponent(doc.id), ...doc.data() }));
  }

  async put(table, id, row) { await this.reference(table, id).set({ ...row, id }); }

  async update(table, id, changes) { await this.reference(table, id).update(changes); }

  async remove(table, id) { await this.reference(table, id).delete(); }

  async compareAndSet(table, id, expected, changes) {
    const reference = this.reference(table, id);
    return this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(reference);
      if (!snapshot.exists) return false;
      const row = snapshot.data();
      if (!Object.entries(expected).every(([key, value]) => row[key] === value)) return false;
      tx.update(reference, changes);
      return true;
    });
  }

  async saveGeneration(ctx, env, sessionId, meta = {}, debug = {}) {
    const store = env.SESSION_STORE || this.sessionStore;
    if (!store) throw new Error('SESSION_STORE is required');
    const runId = meta.runId || randomUUID();
    const pageId = meta.pageId || runId;
    const pageUrl = meta.pageUrl || null;
    const parentRunId = meta.parentRunId || null;
    this.reference('sessions', sessionId);
    this.reference('page_counters', pageId);
    const priorRun = await this.get('generated_pages', runId);
    if (priorRun) {
      if (priorRun.session_id !== sessionId || priorRun.page_id !== pageId) {
        throw new Error('Run id already belongs to another session/page');
      }
      return runId;
    }
    const now = Date.now();
    const ipHash = await hashIp(ctx.request?.ip);
    const userAgent = (ctx.request?.headers?.get?.('user-agent') || '').slice(0, 200);
    const options = ctx.llm?.suggestions || [];
    const firstSection = ctx.llm?.sections?.[0] || '';
    const titleMatch = firstSection.match(/<h1[^>]*>([^<]+)<\/h1>/i)
      || firstSection.match(/<h2[^>]*>([^<]+)<\/h2>/i);
    const row = {
      id: runId,
      session_id: sessionId,
      page_id: pageId,
      page_url: pageUrl,
      parent_run_id: parentRunId,
      query: (ctx.request?.query || '').slice(0, 500),
      previous_queries: ctx.request?.previousQueries?.length
        ? JSON.stringify(ctx.request.previousQueries) : null,
      title: titleMatch ? titleMatch[1].slice(0, 200) : null,
      intent_type: ctx.intent?.type || null,
      journey_stage: ctx.request?.inferredProfile?.journeyStage || null,
      flow_id: ctx.flowId || null,
      follow_up_type: ctx.request?.followUp?.type || null,
      follow_up_label: ctx.request?.followUp?.label || null,
      follow_up_options: options.length ? JSON.stringify(options) : null,
      block_count: ctx.llm?.sections?.length || 0,
      created_at: now,
      duration_ms: ctx.timings?.start ? now - ctx.timings.start : null,
      input_tokens: ctx.llm?.usage?.prompt_tokens || null,
      output_tokens: ctx.llm?.usage?.completion_tokens || null,
      da_path: ctx.daPath || null,
      preview_url: ctx.daUrls?.preview || null,
      live_url: ctx.daUrls?.live || null,
      llm_provider: ctx.llm?.provider || null,
      llm_model: ctx.llm?.model || null,
    };
    const payload = {
      runId,
      pageId,
      sessionId,
      pageUrl,
      parentRunId,
      blocks: (ctx.llm?.sections || []).map((html, i) => ({
        index: i, blockType: ctx.llm?.rawJsonSections?.[i]?.block || 'unknown', html,
      })),
      followUpOptions: options,
      followUpClicked: ctx.request?.followUp || null,
      debug,
      request: {
        query: ctx.request?.query || '',
        previousQueries: ctx.request?.previousQueries || [],
        browsingHistory: ctx.request?.browsingHistory || [],
        inferredProfile: ctx.request?.inferredProfile || null,
        behaviorProfile: ctx.request?.behaviorProfile || null,
        quizPersona: ctx.request?.quizPersona || null,
        followUp: ctx.request?.followUp || null,
      },
    };
    // Validate/store the potentially large payload before committing metadata.
    // The transaction reserves a run index exactly once, including retries.
    await store.put(`page:${runId}`, JSON.stringify(payload), { expirationTtl: 7776000 });
    const runIndex = await this.firestore.runTransaction(async (tx) => {
      const runRef = this.reference('generated_pages', runId);
      const sessionRef = this.reference('sessions', sessionId);
      const pageRef = this.reference('page_counters', pageId);
      const [existing, session, page] = await Promise.all([
        tx.get(runRef), tx.get(sessionRef), tx.get(pageRef),
      ]);
      if (existing.exists) {
        if (existing.data().session_id !== sessionId || existing.data().page_id !== pageId) {
          throw new Error('Run id already belongs to another session/page');
        }
        return existing.data().run_index;
      }
      const previous = session.exists ? session.data() : null;
      const index = page.exists ? page.data().next_index : 0;
      tx.set(sessionRef, {
        id: sessionId,
        ip_hash: previous?.ip_hash || ipHash,
        user_agent: previous?.user_agent ?? userAgent,
        first_seen: previous?.first_seen ?? now,
        last_seen: now,
        page_count: (previous?.page_count || 0) + 1,
      });
      tx.set(pageRef, { id: pageId, next_index: index + 1 });
      tx.create(runRef, { ...row, run_index: index });
      return index;
    });
    payload.runIndex = runIndex;
    await store.put(`page:${runId}`, JSON.stringify(payload), { expirationTtl: 7776000 });
    return runId;
  }

  async saveFeedback(row) {
    const id = createHash('sha256')
      .update(JSON.stringify([row.run_id, row.session_id])).digest('hex');
    const ref = this.reference('run_feedback', id);
    await this.firestore.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      const previous = existing.exists ? existing.data() : null;
      tx.set(ref, {
        ...row,
        id: previous?.id || row.id,
        page_id: previous ? previous.page_id : row.page_id,
        created_at: previous?.created_at ?? row.created_at,
        comment: row.comment ?? previous?.comment ?? null,
        dwell_ms: row.dwell_ms ?? previous?.dwell_ms ?? null,
      });
    });
  }

  async persistEvents(events, { ipHash, userAgent }) {
    if (events.length > 50) throw new RangeError('At most 50 events per atomic batch');
    const refs = [...new Set(events.map((e) => e.attributedRunId).filter(Boolean))]
      .map((id) => this.reference('generated_pages', id));
    await this.firestore.runTransaction(async (tx) => {
      const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
      const known = new Set(snapshots.filter((s) => s.exists).map((s) => s.data().id));
      events.forEach((event) => {
        const attributed = known.has(event.attributedRunId) ? event.attributedRunId : null;
        let attribution = 'none';
        if (attributed) attribution = event.runId === attributed ? 'direct' : 'last-touch';
        const row = {
          ...snake(event),
          attributed_run_id: attributed,
          attribution,
          ip_hash: ipHash,
          user_agent: userAgent,
        };
        tx.create(this.reference('page_events', event.id), row);
        if (['product_view', 'add_to_cart'].includes(event.eventType)) {
          // Event id is also the conversion id, making the relationship explicit.
          tx.create(this.reference('conversions', event.id), {
            id: event.id,
            session_id: event.sessionId,
            event_id: event.id,
            attributed_run_id: attributed,
            attribution,
            conversion_type: event.eventType,
            product_slug: event.productSlug,
            value_cents: event.valueCents,
            created_at: event.createdAt,
          });
        }
      });
    });
  }

  async insertExperiment(exp) {
    await this.put('experiments', exp.id, {
      id: exp.id,
      session_id: exp.sessionId,
      query: exp.query,
      page_url: exp.pageUrl,
      variant_count: exp.variantCount,
      status: 'running',
      created_at: exp.createdAt,
      completed_at: null,
      shared_intent_type: exp.intentType,
      shared_journey_stage: exp.journeyStage,
      shared_duration_ms: null,
      evaluator_summary: null,
      eval_run_id: null,
      eval_query_id: null,
    });
  }

  async insertVariant(variant) {
    await this.put('experiment_variants', variant.id, {
      id: variant.id,
      experiment_id: variant.experimentId,
      variant_index: variant.variantIndex,
      provider: variant.provider,
      model: variant.model,
      temperature: variant.temperature,
      max_tokens: variant.maxTokens,
      status: 'running',
      duration_ms: null,
      input_tokens: null,
      output_tokens: null,
      title: null,
      block_count: null,
      error: null,
      evaluator_score: null,
      evaluator_notes: null,
      time_to_first_token_ms: null,
    });
  }

  async finalizeVariant(variant) {
    await this.update('experiment_variants', variant.id, {
      status: variant.status,
      duration_ms: variant.durationMs,
      input_tokens: variant.inputTokens,
      output_tokens: variant.outputTokens,
      title: variant.title,
      block_count: variant.blockCount,
      error: variant.error,
      time_to_first_token_ms: variant.ttftMs ?? null,
    });
  }

  async finalizeExperiment(id, status, sharedDurationMs) {
    await this.update('experiments', id, {
      status, completed_at: Date.now(), shared_duration_ms: sharedDurationMs,
    });
  }

  async handleAdminSessions(request) {
    const { limit, offset } = pagination(request);
    const rows = await this.list('sessions');
    rows.sort((a, b) => b.last_seen - a.last_seen);
    return json({
      sessions: rows.slice(offset, offset + limit), total: rows.length, limit, offset,
    });
  }

  async handleAdminSession(request, env, sessionId) {
    const session = await this.get('sessions', sessionId);
    if (!session) return json({ error: 'Session not found' }, 404);
    const rows = await this.list('generated_pages', { where: [['session_id', '==', sessionId]] });
    rows.sort((a, b) => a.created_at - b.created_at);
    const pages = [...group(rows.map(rowToRunDto), (r) => r.pageId)].map(([pageId, runs]) => ({
      pageId,
      pageUrl: runs[0].pageUrl,
      initialQuery: runs[0].query,
      initialIntent: runs[0].intentType,
      initialTitle: runs[0].title,
      firstRunAt: runs[0].createdAt,
      lastRunAt: Math.max(...runs.map((r) => r.createdAt)),
      runCount: runs.length,
      totalDurationMs: sum(runs, 'durationMs'),
      totalInputTokens: sum(runs, 'inputTokens'),
      totalOutputTokens: sum(runs, 'outputTokens'),
      runs,
    })).sort((a, b) => b.lastRunAt - a.lastRunAt);
    return json({ session, pages });
  }

  async handleAdminPageGroup(request, env, pageId) {
    const rows = await this.list('generated_pages', { where: [['page_id', '==', pageId]] });
    rows.sort((a, b) => a.run_index - b.run_index || a.created_at - b.created_at);
    if (!rows.length) return json({ error: 'Page not found' }, 404);
    const store = env.SESSION_STORE || this.sessionStore;
    const runs = await Promise.all(rows.map(async (run) => ({
      run, payload: await store.get(`page:${run.id}`, 'json'),
    })));
    return json({
      pageId, sessionId: rows[0].session_id, pageUrl: rows[0].page_url, runs,
    });
  }

  async handleAdminRun(request, env, runId) {
    const run = await this.get('generated_pages', runId);
    if (!run) return json({ error: 'Run not found' }, 404);
    const payload = await (env.SESSION_STORE || this.sessionStore).get(`page:${runId}`, 'json');
    return json({ run, payload });
  }

  async handleListExperiments(request) {
    const { limit, offset } = pagination(request);
    const [experiments, variants] = await Promise.all([
      this.list('experiments'), this.list('experiment_variants'),
    ]);
    const rows = descending(experiments).slice(offset, offset + limit).map((experiment) => ({
      ...experiment,
      complete_count: variants.filter((v) => (
        v.experiment_id === experiment.id && v.status === 'complete'
      )).length,
    }));
    return json({
      experiments: rows, total: experiments.length, limit, offset,
    });
  }

  async handleGetExperiment(request, env, experimentId) {
    const experiment = await this.get('experiments', experimentId);
    if (!experiment) return json({ error: 'Experiment not found' }, 404);
    const variants = await this.list('experiment_variants', {
      where: [['experiment_id', '==', experimentId]],
    });
    variants.sort((a, b) => a.variant_index - b.variant_index);
    return json({ experiment, variants });
  }

  async handleGetExperimentVariant(request, env, experimentId, variantId) {
    const variant = await this.get('experiment_variants', variantId);
    if (!variant || variant.experiment_id !== experimentId) {
      return json({ error: 'Variant not found' }, 404);
    }
    const store = env.SESSION_STORE || this.sessionStore;
    const payload = store
      ? await store.get(`experiment:${experimentId}:variant:${variantId}`, 'json') : null;
    return json({ variant, payload });
  }

  async feedbackRows(request) {
    const params = new URL(request.url).searchParams;
    const since = Number(params.get('since')) || 0;
    const until = Number(params.get('until')) || 0;
    const [feedback, runs] = await Promise.all([
      this.list('run_feedback'), this.list('generated_pages'),
    ]);
    const byId = new Map(runs.map((r) => [r.id, r]));
    return descending(feedback).filter((r) => (
      (!since || r.created_at >= since) && (!until || r.created_at <= until)
    ))
      .map((r) => {
        const run = byId.get(r.run_id) || {};
        const joined = Object.fromEntries([
          'query', 'intent_type', 'journey_stage', 'llm_provider', 'llm_model', 'da_path', 'title',
        ].map((key) => [key, run[key] ?? null]));
        return { ...r, ...joined, gp_page_id: run.page_id ?? null };
      });
  }

  async handleListFeedback(request) {
    const params = new URL(request.url).searchParams;
    const { limit, offset } = pagination(request);
    const rows = (await this.feedbackRows(request)).filter((r) => (
      (!['up', 'down'].includes(params.get('rating'))
        || r.rating === (params.get('rating') === 'up' ? 1 : -1))
      && (!FEEDBACK_FLAGS.has(params.get('flag'))
        || parseArray(r.flags).includes(params.get('flag')))
      && (!params.get('model') || r.llm_model === params.get('model'))
      && (!params.get('q') || matchesLike(r.query, params.get('q')))
      && (params.get('hasComment') !== 'true' || !!r.comment?.length)
    ));
    return json({
      items: rows.slice(offset, offset + limit).map(feedbackDto),
      total: rows.length,
      limit,
      offset,
    });
  }

  async handleRunFeedback(request, env, runId) {
    const feedback = (await this.feedbackRows(new Request(new URL(request.url).origin)))
      .filter((r) => r.run_id === runId);
    const flagCounts = {};
    const productCounts = {};
    feedback.forEach((row) => {
      parseArray(row.flags).forEach((key) => { flagCounts[key] = (flagCounts[key] || 0) + 1; });
      parseArray(row.wrong_products).forEach((key) => {
        productCounts[key] = (productCounts[key] || 0) + 1;
      });
    });
    return json({
      runId,
      run: await this.get('generated_pages', runId),
      feedback: feedback.map(feedbackDto),
      flagCounts,
      productCounts,
    });
  }

  async handleFeedbackSummary(request) {
    const rows = await this.feedbackRows(request);
    const positive = rows.filter((r) => r.rating === 1).length;
    const negative = rows.filter((r) => r.rating === -1).length;
    const flags = {};
    rows.forEach((r) => parseArray(r.flags).forEach((flag) => {
      flags[flag] = (flags[flag] || 0) + 1;
    }));
    const breakdown = (field, key) => [...group(rows, (r) => r[field] ?? null)]
      .map(([value, items]) => ({
        [key]: value,
        positive: items.filter((r) => r.rating === 1).length,
        negative: items.filter((r) => r.rating === -1).length,
        total: items.length,
      })).sort((a, b) => b.total - a.total).slice(0, 20);
    const [variants, experiments] = await Promise.all([
      this.list('experiment_variants'), this.list('experiments'),
    ]);
    const queries = new Map(experiments.map((e) => [e.id, e.query]));
    const divergence = rows.filter((r) => r.rating === -1).reduce((count, r) => count + variants
      .filter((v) => v.evaluator_score >= 4 && queries.get(v.experiment_id) === r.query).length, 0);
    return json({
      total: rows.length,
      positive,
      negative,
      comments: rows.filter((r) => r.comment?.length).length,
      percentPositive: rows.length ? Math.round((positive / rows.length) * 1000) / 10 : 0,
      topFlags: Object.entries(flags).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([flag, count]) => ({
          flag, count, percent: negative ? Math.round((count / negative) * 1000) / 10 : 0,
        })),
      byModel: breakdown('llm_model', 'model'),
      byIntent: breakdown('intent_type', 'intent'),
      divergence,
    });
  }

  async attachFeedbackToQueries(queries) {
    if (!Array.isArray(queries) || !queries.length) return new Map();
    const rows = await this.feedbackRows(new Request('http://localhost/'));
    const wanted = new Set(queries);
    return new Map([...group(rows.filter((r) => wanted.has(r.query)), (r) => r.query)]
      .map(([query, items]) => [
        query, {
          up: items.filter((r) => r.rating === 1).length,
          down: items.filter((r) => r.rating === -1).length,
          comments: items.filter((r) => r.comment?.length).length,
        },
      ]));
  }

  async insightData(request) {
    const requested = Number(new URL(request.url).searchParams.get('days') || 30);
    const days = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 365) : 30;
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const [runs, events, conversions] = await Promise.all([
      this.list('generated_pages'), this.list('page_events'), this.list('conversions'),
    ]);
    return {
      days,
      runs: runs.filter((r) => seconds(r.created_at) >= since),
      events: events.filter((r) => r.created_at >= since),
      conversions: conversions.filter((r) => r.created_at >= since),
    };
  }

  async handleInsightsSummary(request) {
    const {
      days, runs, events, conversions,
    } = await this.insightData(request);
    const carts = conversions.filter((r) => r.conversion_type === 'add_to_cart');
    const pdps = conversions.filter((r) => r.conversion_type === 'product_view');
    const attributed = carts.filter((r) => r.attributed_run_id);
    const sessions = Math.max(
      distinct(runs, 'session_id'),
      ...[...group(events, (r) => r.event_type).values()]
        .map((items) => distinct(items, 'session_id')),
    );
    const pages = new Set(runs.map((r) => r.page_id || r.id)).size;
    const cost = totalCost(runs);
    const eventCounts = Object.fromEntries([...group(events, (r) => r.event_type)]
      .map(([key, items]) => [key, items.length]));
    return json({
      days,
      generation: {
        runs: runs.length,
        pages,
        sessions: distinct(runs, 'session_id'),
        runsPerPage: pages ? runs.length / pages : 0,
        inputTokens: sum(runs, 'input_tokens'),
        outputTokens: sum(runs, 'output_tokens'),
        costUsd: cost,
        costPerRunUsd: runs.length ? cost / runs.length : 0,
        costPerPageUsd: pages ? cost / pages : 0,
        costPerSessionUsd: distinct(runs, 'session_id') ? cost / distinct(runs, 'session_id') : 0,
        avgDurationMs: runs.length ? sum(runs, 'duration_ms') / runs.length : 0,
      },
      events: eventCounts,
      conversions: {
        productViews: pdps.length,
        addToCart: carts.length,
        addToCartSessions: distinct(carts, 'session_id'),
        attributedAddToCart: attributed.length,
        cartValueUsd: sum(carts, 'value_cents') / 100,
        attributedCartValueUsd: sum(attributed, 'value_cents') / 100,
        aovUsd: carts.length ? sum(carts, 'value_cents') / 100 / carts.length : 0,
        conversionRate: sessions ? distinct(carts, 'session_id') / sessions : 0,
      },
      caveat: 'Observational, not randomized. No control group is running, so these'
        + ' figures show conversions attributed to generated pages, not incremental lift.',
    });
  }

  async handleInsightsFunnel(request) {
    const { days, runs, events } = await this.insightData(request);
    const funnel = [{
      key: 'query',
      label: 'Generated page viewed',
      sessions: distinct(runs, 'session_id'),
      events: runs.length,
    }, ...[
      ['product_card_click', 'Product card clicked'],
      ['product_view', 'Product page viewed'],
      ['add_to_cart', 'Added to cart'],
    ]
      .map(([key, label]) => {
        const rows = events.filter((r) => r.event_type === key);
        return {
          key,
          label,
          sessions: distinct(rows.filter((r) => r.attributed_run_id), 'session_id'),
          events: rows.length,
        };
      })];
    funnel.forEach((step, i) => {
      const previous = i ? funnel[i - 1].sessions : step.sessions;
      step.stepRate = previous ? step.sessions / previous : 0;
      step.overallRate = funnel[0].sessions ? step.sessions / funnel[0].sessions : 0;
      step.dropOff = Math.max(0, previous - step.sessions);
    });
    return json({ days, funnel });
  }

  async handleInsightsCampaigns(request) {
    const { days, events, conversions } = await this.insightData(request);
    const campaigns = [...group(events, (r) => JSON.stringify([
      r.utm_source ?? '(direct / none)', r.utm_medium ?? '(none)', r.utm_campaign ?? '(none)',
    ]))].map(([key, rows]) => {
      const [utmSource, utmMedium, utmCampaign] = JSON.parse(key);
      const ids = new Set(rows.map((r) => r.id));
      const carts = conversions.filter((r) => (
        r.conversion_type === 'add_to_cart' && ids.has(r.event_id)
      ));
      const sessions = distinct(rows, 'session_id');
      return {
        utmSource,
        utmMedium,
        utmCampaign,
        sessions,
        pageViews: rows.filter((r) => r.event_type === 'page_view').length,
        homepageSessions: distinct(
          rows.filter((r) => r.event_type === 'page_view' && r.path === '/'),
          'session_id',
        ),
        carts: carts.length,
        conversionRate: sessions ? carts.length / sessions : 0,
        cartValueUsd: sum(carts, 'value_cents') / 100,
      };
    }).sort((a, b) => b.sessions - a.sessions);
    return json({ days, campaigns });
  }

  async handleInsightsModels(request) {
    const { days, runs } = await this.insightData(request);
    const [feedback, variants, conversions] = await Promise.all([
      this.list('run_feedback'), this.list('experiment_variants'), this.list('conversions'),
    ]);
    const models = [...group(
      runs.filter((r) => r.llm_model != null),
      (r) => JSON.stringify([r.llm_provider, r.llm_model]),
    )]
      .map(([key, rows]) => {
        const [provider, model] = JSON.parse(key);
        const ids = new Set(rows.map((r) => r.id));
        const conv = conversions.filter((r) => ids.has(r.attributed_run_id));
        const carts = conv.filter((r) => r.conversion_type === 'add_to_cart');
        const fb = feedback.filter((r) => ids.has(r.run_id));
        const judged = variants.filter((r) => (
          r.provider === provider && r.model === model && r.evaluator_score != null
        ));
        const cost = totalCost(rows);
        const cartValueUsd = sum(carts, 'value_cents') / 100;
        return {
          provider,
          model,
          runs: rows.length,
          costUsd: cost,
          costPerRunUsd: cost / rows.length,
          avgDurationMs: sum(rows, 'duration_ms') / rows.length,
          productViews: conv.filter((r) => r.conversion_type === 'product_view').length,
          carts: carts.length,
          cartConversionRate: carts.length / rows.length,
          cartValueUsd,
          revenuePerRunUsd: cartValueUsd / rows.length,
          up: fb.filter((r) => r.rating === 1).length,
          down: fb.filter((r) => r.rating === -1).length,
          judgeScore: judged.length ? sum(judged, 'evaluator_score') / judged.length : null,
          judgeN: judged.length,
        };
      }).sort((a, b) => b.runs - a.runs);
    return json({ days, models });
  }

  async handleInsightsSegments(request) {
    const { days, runs } = await this.insightData(request);
    const conversions = await this.list('conversions');
    const build = (field) => [...group(runs, (r) => r[field] ?? 'unknown')]
      .map(([segment, rows]) => {
        const ids = new Set(rows.map((r) => r.id));
        const carts = conversions.filter((r) => (
          ids.has(r.attributed_run_id) && r.conversion_type === 'add_to_cart'
        ));
        return {
          segment,
          runs: rows.length,
          carts: carts.length,
          conversionRate: carts.length / rows.length,
          cartValueUsd: sum(carts, 'value_cents') / 100,
        };
      }).sort((a, b) => b.runs - a.runs);
    return json({ days, byIntent: build('intent_type'), byJourneyStage: build('journey_stage') });
  }

  async handleInsightsTimeseries(request) {
    const { days, runs, conversions } = await this.insightData(request);
    const byDay = new Map();
    const entry = (timestamp) => {
      const day = new Date(seconds(timestamp) * 1000).toISOString().slice(0, 10);
      if (!byDay.has(day)) {
        byDay.set(day, {
          day, runs: 0, costUsd: 0, carts: 0, valueUsd: 0,
        });
      }
      return byDay.get(day);
    };
    runs.forEach((r) => {
      const e = entry(r.created_at); e.runs += 1; e.costUsd += totalCost([r]);
    });
    conversions.filter((r) => r.conversion_type === 'add_to_cart').forEach((r) => {
      const e = entry(r.created_at); e.carts += 1; e.valueUsd += (r.value_cents || 0) / 100;
    });
    return json({ days, series: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) });
  }
}

export function createStorage(config) { return new FirestoreStorage(config); }
