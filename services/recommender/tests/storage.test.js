import assert from 'node:assert/strict';
import test from 'node:test';
import { createStorage } from '../src/storage.js';
import { createKV } from '../src/kv.js';
import { MockFirestore } from './mock-firestore.js';
import { saveGeneration } from '../../../workers/recommender/src/storage.js';
import * as feedback from '../../../workers/recommender/src/feedback.js';
import * as events from '../../../workers/recommender/src/events.js';
import * as admin from '../../../workers/recommender/src/admin.js';
import * as experiments from '../../../workers/recommender/src/experiments.js';

function fixture(options = {}) {
  const firestore = new MockFirestore();
  const sessionStore = createKV({ firestore }, 'sessions');
  const storage = createStorage({ firestore, sessionStore, ...options });
  const env = { GCP_STORAGE: storage, SESSION_STORE: sessionStore };
  return { firestore, storage, env };
}
const request = (path, body) => new Request(`http://localhost${path || '/'}`, body === undefined ? {} : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const context = () => ({
  request: {
    query: 'best espresso',
    ip: '127.0.0.1',
    headers: new Headers(),
    previousQueries: ['coffee'],
    inferredProfile: { journeyStage: 'comparing' },
  },
  intent: { type: 'comparison' },
  timings: { start: Date.now() - 20 },
  llm: {
    sections: ['<h1>Espresso</h1>'],
    rawJsonSections: [{ block: 'hero' }],
    suggestions: [{ label: 'More' }],
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  },
  daPath: '/discover/espresso',
  daUrls: { preview: 'https://example.com/preview', live: 'https://example.com/live' },
});

test('Native generation hook persists complete session/run/payload and assigns atomic indices', async () => {
  const { storage, env } = fixture();
  await Promise.all([0, 1, 2].map((n) => saveGeneration(context(), env, 'session', {
    runId: `run${n}`, pageId: 'page', pageUrl: '/?q=espresso',
  })));
  const session = await storage.get('sessions', 'session');
  assert.equal(session.page_count, 3);
  assert(session.first_seen > 1e12);
  const runs = await storage.list('generated_pages');
  assert.deepEqual(runs.map((r) => r.run_index).sort(), [0, 1, 2]);
  assert.equal(runs[0].preview_url, 'https://example.com/preview');
  const payload = await env.SESSION_STORE.get('page:run0', 'json');
  assert.equal(payload.blocks[0].blockType, 'hero');
  assert.equal(payload.debug.llm.provider, 'gemini');
  assert.equal(payload.runIndex, 0);
  await saveGeneration(context(), env, 'session', { runId: 'run0', pageId: 'page' });
  assert.equal((await storage.get('sessions', 'session')).page_count, 3);
});

test('Firestore CAS permits one concurrent phase owner, and bounded scans fail explicitly', async () => {
  const { storage } = fixture({ maxDocuments: 2 });
  await storage.put('eval_runs', 'eval', { phase: 'generating', last_activity_at: Date.now() });
  const results = await Promise.all([1, 2, 3].map(() => storage.compareAndSet('eval_runs', 'eval', { phase: 'generating' }, { phase: 'judging' })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await storage.compareAndSet('eval_runs', 'missing', {}, {}), false);
  await storage.put('sessions', 'a', {});
  await storage.put('sessions', 'b', {});
  await storage.put('sessions', 'c', {});
  await assert.rejects(storage.list('sessions'), /exceeds bounded/);
  assert.throws(() => storage.collection('invalid'), /Unknown repository/);
});

test('Session/page/run admin hooks preserve auth, CORS, schemas and 404s without D1', async () => {
  const { storage, env } = fixture();
  await saveGeneration(context(), env, 'session', { runId: 'run', pageId: 'page' });
  assert.equal((await admin.handleAdminSessions(request(), { ...env, ADMIN_TOKEN: 'secret' })).status, 401);
  const listed = await admin.handleAdminSessions(request(), env);
  assert.equal(listed.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await listed.json()).total, 1);
  const session = await (await admin.handleAdminSession(request(), env, 'session')).json();
  assert.equal(session.pages[0].runCount, 1);
  assert.equal(session.pages[0].runs[0].llmProvider, 'gemini');
  const page = await (await admin.handleAdminPageGroup(request(), env, 'page')).json();
  assert.equal(page.runs[0].payload.runId, 'run');
  const run = await (await admin.handleAdminRun(request(), env, 'run')).json();
  assert.equal(run.run.id, 'run');
  assert.equal((await admin.handleAdminRun(request(), env, 'missing')).status, 404);
  await storage.remove('sessions', 'session');
  assert.equal((await admin.handleAdminSession(request(), env, 'session')).status, 404);
  assert.equal((await admin.handleAdminPageGroup(request(), env, 'missing')).status, 404);
});

test('Feedback public validation, transactional upsert, native joins, summaries and exports', async () => {
  const { storage, env } = fixture();
  await saveGeneration(context(), env, 'session', { runId: 'run', pageId: 'page' });
  assert.equal((await feedback.handleSubmitFeedback(request('/', { rating: 0 }), env)).status, 400);
  assert.equal((await feedback.handleSubmitFeedback(request('/', {
    runId: 'run',
    sessionId: 'session',
    rating: -1,
    comment: 'bad',
    flags: ['wrong-product', 'invalid'],
    wrongProducts: ['machine'],
    dwellMs: 10,
  }), env)).status, 204);
  const old = (await storage.list('run_feedback'))[0];
  await feedback.handleSubmitFeedback(request('/', { runId: 'run', sessionId: 'session', rating: 1 }), env);
  const updated = (await storage.list('run_feedback'))[0];
  assert.equal(updated.id, old.id);
  assert.equal(updated.created_at, old.created_at);
  assert.equal(updated.comment, 'bad');
  assert.equal(updated.rating, 1);
  const listed = await (await feedback.handleListFeedback(request('/?q=ESPRESSO&rating=up&hasComment=true'), env)).json();
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].llm_provider, 'gemini');
  assert.deepEqual(listed.items[0].flags, []);
  const summary = await (await feedback.handleFeedbackSummary(request(), env)).json();
  assert.equal(summary.percentPositive, 100);
  assert.equal(summary.byModel[0].total, 1);
  const detail = await (await feedback.handleRunFeedback(request(), env, 'run')).json();
  assert.equal(detail.run.id, 'run');
  const exportJson = await feedback.handleFeedbackExport(request('/?format=json'), env);
  assert.equal(JSON.parse((await exportJson.text()).trim()).comment, 'bad');
  const exportCsv = await feedback.handleFeedbackExport(request(), env);
  assert.match(await exportCsv.text(), /^created_at_iso,run_id/);
  assert.deepEqual((await feedback.attachFeedbackToQueries(env, ['best espresso'])).get('best espresso'), {
    up: 1, down: 0, comments: 1,
  });
});

test('Event batches atomically validate attribution and write exact conversions', async () => {
  const { storage, env } = fixture();
  await saveGeneration(context(), env, 'session', { runId: 'run', pageId: 'page' });
  const response = await events.handleTrack(request('/', {
    sessionId: 'session',
    events: [
      {
        eventType: 'page_view', path: '/', utmSource: 'email', utmCampaign: 'launch',
      },
      { eventType: 'product_card_click', attributedRunId: 'run', runId: 'run' },
      { eventType: 'product_view', path: '/products/machines/primo', attributedRunId: 'run' },
      {
        eventType: 'add_to_cart', productSlug: 'primo', valueCents: 9999, attributedRunId: 'run', utmSource: 'email',
      },
      { eventType: 'add_to_cart', valueCents: 500, attributedRunId: 'spoofed' },
    ],
  }), env);
  assert.equal(response.status, 204);
  const stored = await storage.list('page_events');
  assert.equal(stored.length, 5);
  const conversions = await storage.list('conversions');
  assert.equal(conversions.length, 3);
  assert.equal(stored.find((r) => r.event_type === 'product_card_click').attribution, 'direct');
  assert.equal(stored.find((r) => r.event_type === 'product_view').attribution, 'last-touch');
  assert.equal(conversions.find((r) => r.value_cents === 500).attributed_run_id, null);
  const existing = { id: 'duplicate', session_id: 'session' };
  await storage.put('page_events', existing.id, existing);
  await assert.rejects(storage.persistEvents([
    {
      id: 'would-write', sessionId: 'session', eventType: 'page_view', attributedRunId: null,
    },
    {
      id: 'duplicate', sessionId: 'session', eventType: 'page_view', attributedRunId: null,
    },
  ], { ipHash: '', userAgent: '' }), /already exists/);
  assert.equal(await storage.get('page_events', 'would-write'), null);
});

test('Every insight handler aggregates the native rows with unchanged dashboard keys', async () => {
  const { storage, env } = fixture();
  await saveGeneration(context(), env, 'session', { runId: 'run', pageId: 'page' });
  await events.handleTrack(request('/', {
    sessionId: 'session',
    events: [
      { eventType: 'page_view', path: '/', utmSource: 'email' },
      { eventType: 'product_card_click', attributedRunId: 'run' },
      { eventType: 'product_view', attributedRunId: 'run' },
      {
        eventType: 'add_to_cart', attributedRunId: 'run', valueCents: 10000, utmSource: 'email',
      },
    ],
  }), env);
  const summary = await (await events.handleInsightsSummary(request(), env)).json();
  assert.equal(summary.generation.runs, 1);
  assert.equal(summary.conversions.attributedCartValueUsd, 100);
  const funnel = await (await events.handleInsightsFunnel(request(), env)).json();
  assert.equal(funnel.funnel[3].overallRate, 1);
  const campaigns = await (await events.handleInsightsCampaigns(request(), env)).json();
  assert.equal(campaigns.campaigns.find((r) => r.utmSource === 'email').carts, 1);
  const models = await (await events.handleInsightsModels(request(), env)).json();
  assert.equal(models.models[0].cartValueUsd, 100);
  const segments = await (await events.handleInsightsSegments(request(), env)).json();
  assert.equal(segments.byIntent[0].segment, 'comparison');
  const series = await (await events.handleInsightsTimeseries(request(), env)).json();
  assert.equal(series.series[0].valueUsd, 100);
  // Native time filtering handles run milliseconds versus event seconds.
  await storage.update('generated_pages', 'run', { created_at: Date.now() - 31 * 86400000 });
  assert.equal((await (await events.handleInsightsSummary(request(), env)).json()).generation.runs, 0);
});

test('Experiment persistence lifecycle and all read hooks use Firestore + KV', async () => {
  const { storage, env } = fixture();
  await storage.insertExperiment({
    id: 'experiment',
    sessionId: null,
    query: 'coffee',
    pageUrl: null,
    variantCount: 1,
    createdAt: Date.now(),
    intentType: null,
    journeyStage: null,
  });
  await storage.insertVariant({
    id: 'variant',
    experimentId: 'experiment',
    variantIndex: 0,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    temperature: 0.7,
    maxTokens: 100,
  });
  await storage.finalizeVariant({
    id: 'variant',
    status: 'complete',
    durationMs: 10,
    inputTokens: 20,
    outputTokens: 30,
    title: 'Coffee',
    blockCount: 1,
    error: null,
    ttftMs: 3,
  });
  await storage.finalizeExperiment('experiment', 'complete', 5);
  await env.SESSION_STORE.put('experiment:experiment:variant:variant', '{"blocks":[]}');
  const listing = await (await experiments.handleListExperiments(request(), env)).json();
  assert.equal(listing.experiments[0].complete_count, 1);
  assert.equal((await (await experiments.handleGetExperiment(request(), env, 'experiment')).json()).variants.length, 1);
  const variant = await (await experiments.handleGetExperimentVariant(request(), env, 'experiment', 'variant')).json();
  assert.deepEqual(variant.payload.blocks, []);
  assert.equal(variant.variant.time_to_first_token_ms, 3);
  assert.equal((await experiments.handleGetExperimentVariant(request(), env, 'wrong', 'variant')).status, 404);
  assert.equal((await experiments.handleGetExperiment(request(), env, 'missing')).status, 404);
});
