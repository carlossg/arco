import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const origin = process.env.BASE_URL
  || 'https://arco-recommender-gcp-okyq6gkx3a-uc.a.run.app';
if (!process.env.ADMIN_TOKEN) throw new Error('Set ADMIN_TOKEN without committing or printing it');
const authorization = `Basic ${Buffer.from(`admin:${process.env.ADMIN_TOKEN}`).toString('base64')}`;
const sessionId = randomUUID();
const pageId = randomUUID();
const runId = randomUUID();

async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(path.startsWith('/api/admin/') ? { Authorization: authorization } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  if (response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
    return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [];
  }
  return text ? JSON.parse(text) : null;
}

async function generate(tv = false) {
  const id = tv ? randomUUID() : runId;
  const response = await fetch(new URL('/api/generate', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: tv ? 'Compare Primo and Doppio espresso machines' : 'Portable espresso for camping',
      sessionId,
      pageId,
      runId: id,
      tv,
    }),
    signal: AbortSignal.timeout(240_000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/x-ndjson/);
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.filter((event) => event.type === 'error'), []);
  assert.ok(events.some((event) => event.type === 'section'));
  assert.ok(events.some((event) => event.type === 'done'));
  const saved = await request(`/api/admin/runs/${id}`);
  assert.equal(saved.run.id, id);
  assert.equal(saved.run.llm_provider, 'gemini');
  assert.ok(saved.payload);
  if (tv) {
    assert.equal(saved.run.flow_id, 'tv-comparison');
    assert.equal(saved.run.block_count, 1);
    assert.equal(events.filter((event) => event.type === 'section').length, 1);
  }
  console.log(`PASS ${tv ? 'TV comparison' : 'real generation'}: streamed sections and durable run ${id}`);
  return saved;
}

assert.equal((await request('/health')).platform, 'google-cloud');
assert.equal((await fetch(new URL('/api/admin/sessions', origin))).status, 401);
assert.equal((await fetch(new URL('/internal/tasks/eval', origin), { method: 'POST' })).status, 401);
const search = await request('/api/debug/search?q=camping');
assert.ok(search.count > 0, 'Native vector retrieval must return actual indexed documents');
const { catalog } = await request('/api/admin/catalog');
assert.ok(catalog.some((entry) => entry.provider === 'gemini' && entry.available));
assert.ok(catalog.every((entry) => entry.provider !== 'cloudflare'));
const { active } = await request('/api/admin/llm-config');
assert.equal(active.provider, 'gemini');
await request('/api/admin/llm-config', active, 'PUT');
await generate();
await generate(true);

await request('/api/track', {
  sessionId,
  events: [{
    eventType: 'add_to_cart',
    path: '/products/espresso-machines/arco-viaggio',
    attributedRunId: runId,
    productSlug: 'viaggio',
    valueCents: 19900,
    utmSource: 'google-smoke',
    utmCampaign: 'google-serverless-demo',
  }],
});
await request('/api/feedback', {
  sessionId, runId, pageId, rating: 1, comment: 'Google smoke test',
});
const feedback = await request(`/api/admin/feedback/run/${runId}`);
assert.ok(feedback.feedback.some(
  (row) => row.run_id === runId && row.session_id === sessionId && row.rating === 1,
));
const exported = await request('/api/admin/feedback/export?format=json');
assert.ok(exported.some((row) => row.run_id === runId && row.session_id === sessionId));
const summary = await request('/api/admin/insights/summary');
assert.ok(summary.conversions.attributedAddToCart >= 1);
assert.ok(summary.conversions.attributedCartValueUsd >= 199);
const { campaigns } = await request('/api/admin/insights/campaigns');
const campaign = campaigns.find((row) => row.utmCampaign === 'google-serverless-demo');
assert.ok(campaign?.carts >= 1 && campaign?.cartValueUsd >= 199);
for (const path of [
  `/api/admin/sessions/${sessionId}`,
  `/api/admin/pages/${pageId}`,
  `/api/admin/feedback/run/${runId}`,
  '/api/admin/feedback/summary',
  '/api/admin/feedback/export?format=json',
  '/api/admin/insights/summary',
  '/api/admin/insights/funnel',
  '/api/admin/insights/campaigns',
  '/api/admin/insights/models',
  '/api/admin/insights/segments',
  '/api/admin/insights/timeseries',
  '/api/admin/vectorize/stats',
  '/api/admin/experiments',
  '/api/admin/eval-queue',
  '/api/admin/eval-queue/consumers',
  '/api/stats',
]) {
  // eslint-disable-next-line no-await-in-loop
  await request(path);
}
console.log('PASS authenticated admin, feedback, events, ROI/UTM, catalog, vectors and queue diagnostics');

if (process.env.RUN_EVAL === '1') {
  const evaluation = await request('/api/admin/evaluations/start', {
    suiteId: 'coffee-dev',
    models: [{ provider: 'gemini', model: 'gemini-2.5-flash', maxTokens: 4096 }],
  });
  const id = evaluation.evalRunId || evaluation.id;
  assert.ok(id, 'Evaluation start must return its ID');
  let result;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    result = await request(`/api/admin/evaluations/${id}`);
    if (result.run.phase === 'complete') break;
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(10_000);
  }
  assert.equal(result.run.status, 'complete', JSON.stringify(result.run));
  assert.equal(result.run.completed_queries, result.run.query_count);
  assert.ok(result.variants.length > 0);
  assert.ok(result.variants.every((variant) => variant.evaluator_score != null));
  console.log(`PASS Cloud Tasks generation and Gemini judging: ${id}`);
}

console.log('Google smoke tests passed. Adobe publishing requires a separate valid Adobe credential.');
