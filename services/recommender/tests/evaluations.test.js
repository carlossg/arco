import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvaluations } from '../src/evaluations.js';

/* eslint no-restricted-syntax: off, no-await-in-loop: off */

function memoryFirestore() {
  const rows = new Map();
  let serial = Promise.resolve();
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  const document = (path) => ({
    path,
    id: path.split('/').pop(),
    async get() {
      return { ref: this, exists: rows.has(path), data: () => clone(rows.get(path)) };
    },
    async create(data) {
      if (rows.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
      rows.set(path, clone(data));
    },
    async set(data) { rows.set(path, clone(data)); },
    async update(changes) {
      if (!rows.has(path)) throw new Error(`Missing document: ${path}`);
      rows.set(path, { ...rows.get(path), ...clone(changes) });
    },
  });
  const query = (name, filters = [], order = undefined) => ({
    doc(id) {
      if (!id) throw new Error('Document ID required');
      return document(`${name}/${id}`);
    },
    where(field, op, value) {
      assert.equal(op, '==');
      return query(name, [...filters, [field, value]], order);
    },
    orderBy(field, direction) { return query(name, filters, [field, direction]); },
    async get() {
      let entries = [...rows.entries()].filter(([key, value]) => key.startsWith(`${name}/`)
        && filters.every(([field, expected]) => value[field] === expected));
      if (order) {
        entries = entries.sort((a, b) => (a[1][order[0]] - b[1][order[0]]) * (order[1] === 'desc' ? -1 : 1));
      }
      return {
        docs: entries.map(([path, value]) => ({
          ref: document(path), id: path.split('/').pop(), exists: true, data: () => clone(value),
        })),
      };
    },
  });
  const batch = () => {
    const operations = [];
    let wrote = false;
    return {
      async get(reference) {
        assert.equal(wrote, false, 'Firestore requires all reads before writes');
        return reference.get();
      },
      create(reference, data) { wrote = true; operations.push(() => reference.create(data)); },
      set(reference, data) { wrote = true; operations.push(() => reference.set(data)); },
      update(reference, data) { wrote = true; operations.push(() => reference.update(data)); },
      async commit() { for (const operation of operations) await operation(); },
    };
  };
  return {
    rows,
    collection: (name) => query(name),
    batch,
    runTransaction(fn) {
      const promise = serial.then(async () => {
        const tx = batch();
        const result = await fn(tx);
        await tx.commit();
        return result;
      });
      serial = promise.catch(() => {});
      return promise;
    },
  };
}

function fixture(overrides = {}) {
  const db = memoryFirestore();
  const pending = [];
  let generateCalls = 0;
  let judgeCalls = 0;
  const queue = {
    maxAttempts: 6,
    async send(body) { pending.push(body); },
    async retryTask(body, options) { pending.push({ ...body, retryOptions: options }); },
    async deadLetter({
      taskId, body, error, attempts,
    }) {
      await db.collection('arco_task_deadletters_gcp').doc(taskId).set({
        body, error: error.message, attempts, createdAt: 1000,
      });
      return { deadLettered: true, taskId };
    },
    async getQueueState() { return { platform: 'gcp', state: 'RUNNING' }; },
    async getConsumerState() { return { type: 'http', state: 'RUNNING' }; },
    async purge() { pending.length = 0; },
    async resume() { return { state: 'RUNNING' }; },
  };
  const suites = [{
    id: 'test',
    name: 'Test suite',
    version: 1,
    queries: [{ id: 'q1', query: 'Espresso machine' }, { id: 'q2', query: 'Coffee grinder' }],
  }];
  const env = { CLOUD_PLATFORM: 'gcp', EVAL_QUEUE: queue };
  const generate = async ({ models, queryDef }) => {
    generateCalls += 1;
    return models.map((model) => ({
      id: model.id,
      query: queryDef.query,
      title: queryDef.query,
      blocks: [0, 1, 2].map((index) => ({ index, blockType: 'text', html: '<p>Espresso coffee.</p>' })),
      rag: { products: [] },
      intent: { type: 'discovery' },
      input_tokens: 100,
      output_tokens: 50,
    }));
  };
  const judge = async () => {
    judgeCalls += 1;
    return {
      score: 4,
      summary: '4·4·4·4·4·4·4',
      judgeModel: 'gemini-2.5-flash',
      dims: { structure: { score: 4 }, faithfulness: { score: 4 } },
      durationMs: 1,
    };
  };
  const evaluations = createEvaluations({
    firestore: db,
    queue,
    suites,
    judgeModels: [{ id: 'gemini-2.5-flash' }],
    generate,
    judge,
    authorize: async () => null,
    now: () => 1000,
    ...overrides,
  });
  const request = async (path, method = 'GET', body = undefined) => evaluations.fetch(new Request(`https://arco.test/api/admin/${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, {});
  const start = async (body = {}, path = 'evaluations/start') => {
    const res = await request(path, 'POST', {
      suiteId: 'test', models: [{ provider: 'gemini', model: 'gemini-2.5-flash' }], ...body,
    });
    return { status: res.status, body: await res.json() };
  };
  const drain = async () => {
    while (pending.length) {
      const body = pending.shift();
      await evaluations.deliver({
        body, attempts: 1, taskId: body.jobId, env, ctx: {},
      });
    }
  };
  const rows = (table) => [...db.rows].filter(([path]) => path.startsWith(`arco_${table}_gcp/`)).map(([, row]) => row);
  return {
    db,
    queue,
    evaluations,
    pending,
    request,
    start,
    drain,
    rows,
    env,
    generate,
    generateCalls: () => generateCalls,
    judgeCalls: () => judgeCalls,
  };
}

test('native async evaluations generate, judge, finalize and expose existing admin response fields', async () => {
  const f = fixture();
  const started = await f.start({
    models: [
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      { provider: 'gemini', model: 'gemini-2.5-pro' },
    ],
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.variantCount, 4);
  assert.equal(f.rows('eval_jobs').length, 2);
  const original = f.pending[0];
  await f.drain();
  const run = f.rows('eval_runs')[0];
  assert.equal(run.phase, 'complete');
  assert.equal(run.status, 'complete');
  assert.equal(run.completed_queries, 2);
  assert.equal(f.generateCalls(), 2);
  assert.equal(f.judgeCalls(), 4);
  assert.equal(f.rows('experiments').length, 2);
  assert.equal(f.rows('eval_payloads').length, 4);
  assert.equal(JSON.parse(run.summary_json).perModel[0].avgQuality, 4);
  await f.evaluations.deliver({ body: original, env: f.env, attempts: 15 });
  assert.equal(f.generateCalls(), 2);
  const detail = await (await f.request(`evaluations/${run.id}`)).json();
  assert.equal(detail.experiments.length, 2);
  assert.equal(detail.variants.length, 4);
  const status = await (await f.request('eval-queue')).json();
  assert.equal(status.platform, 'gcp');
  assert.equal(status.total, 0);
  assert.equal((await f.request('eval-queue/consumers')).status, 200);
});

test('durable outbox recovers enqueue failure via Scheduler without losing the run', async () => {
  const f = fixture();
  const { send } = f.queue;
  f.queue.send = async () => { throw new Error('Tasks unavailable'); };
  assert.equal((await f.start()).status, 500);
  assert.equal(f.rows('eval_jobs').filter((job) => job.state === 'pending').length, 2);
  await assert.rejects(f.evaluations.scheduled({}, f.env), /Tasks unavailable/);
  f.queue.send = send;
  await f.evaluations.scheduled({}, f.env);
  await f.drain();
  assert.equal(f.rows('eval_runs')[0].status, 'complete');
});

test('skip judge, explicit judge, regenerate and rejudge retain the async lifecycle', async () => {
  const f = fixture();
  const { body: { evalRunId } } = await f.start({ skipJudge: true });
  await f.drain();
  assert.equal(f.judgeCalls(), 0);
  assert.equal((await f.request(`evaluations/${evalRunId}/judge`, 'POST', { scope: 'all' })).status, 200);
  await f.drain();
  assert.equal(f.judgeCalls(), 2);
  const variantId = f.rows('experiment_variants')[0].id;
  assert.equal((await f.request(`evaluations/${evalRunId}/variants/${variantId}/regenerate`, 'POST')).status, 200);
  assert.equal(f.rows('experiment_variants').find((variant) => variant.id === variantId).status, 'running');
  await f.drain();
  assert.equal(f.generateCalls(), 3);
  assert.equal(f.judgeCalls(), 3);
  await f.request(`evaluations/${evalRunId}/variants/${variantId}/rejudge`, 'POST');
  await f.drain();
  assert.equal(f.judgeCalls(), 4);
  assert.equal(f.rows('eval_runs')[0].completed_queries, 2);
});

test('native generation errors reject delivery, preserve job attempt counts and eventually recover', async () => {
  let calls = 0;
  const f = fixture({
    generate: async (args) => {
      calls += 1;
      if (calls === 1) throw new Error('model unavailable');
      return f.generate(args);
    },
  });
  await f.start();
  const body = f.pending.shift();
  await assert.rejects(f.evaluations.deliver({ body, env: f.env }), /model unavailable/);
  assert.equal(f.rows('eval_jobs').find((job) => job.id === body.jobId).attempts, 1);
  await f.evaluations.deliver({ body, env: f.env });
  await f.drain();
  assert.equal(f.rows('eval_runs')[0].status, 'complete');
});

test('throttled native judge schedules exact stair-step delay without acknowledging the failed work', async () => {
  const f = fixture({
    judge: async () => { throw Object.assign(new Error('quota'), { status: 429 }); },
  });
  await f.start();
  const first = f.pending.shift();
  const second = f.pending.shift();
  await f.evaluations.deliver({ body: first, env: f.env });
  await f.evaluations.deliver({ body: second, env: f.env });
  const judge = f.pending.shift();
  const result = await f.evaluations.deliver({ body: judge, attempts: 2, env: f.env });
  assert.equal(result.retried, true);
  assert.equal(f.pending.at(-1).retryOptions.delaySeconds, 60);
  assert.equal(f.pending.at(-1).retryOptions.attempts, 2);
  assert.equal(f.rows('eval_jobs').find((job) => job.id === judge.jobId).next_attempt_at, 61000);
  await f.evaluations.deliver({ body: judge, attempts: 6, env: f.env });
  assert.equal(f.rows('eval_jobs').find((job) => job.id === judge.jobId).state, 'deadletter');
  assert.match(f.rows('experiment_variants').find((variant) => variant.id === judge.variantId).evaluator_notes, /judge_error/);
});

test('native max-attempt failures require a durable Firestore deadletter before marking jobs terminal', async () => {
  const f = fixture({ generate: async () => { throw new Error('permanent error'); } });
  await f.start();
  const body = f.pending.shift();
  const { deadLetter } = f.queue;
  f.queue.deadLetter = async () => { throw new Error('Firestore unavailable'); };
  await assert.rejects(f.evaluations.deliver({ body, attempts: 6, env: f.env }), /Firestore unavailable/);
  assert.equal(f.rows('eval_jobs').find((job) => job.id === body.jobId).state, 'queued');
  f.queue.deadLetter = deadLetter;
  await f.evaluations.deliver({ body, attempts: 7, env: f.env });
  assert.equal(f.rows('task_deadletters').length, 1);
  assert.equal(f.rows('eval_jobs').find((job) => job.id === body.jobId).state, 'deadletter');
  assert.equal(f.rows('experiment_variants').find((variant) => variant.eval_query_id === body.queryId).status, 'error');
});

test('concurrent duplicate deliveries lease once and schedule the duplicate beyond the active lease', async () => {
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const f = fixture({
    generate: async (args) => { entered(); await hold; return f.generate(args); },
  });
  await f.start();
  const body = f.pending.shift();
  const running = f.evaluations.deliver({ body, env: f.env });
  await ready;
  const duplicate = await f.evaluations.deliver({ body, env: f.env });
  assert.equal(duplicate.retried, true);
  assert.ok(f.pending.at(-1).retryOptions.delaySeconds > 1800);
  f.pending.pop();
  release();
  await running;
  assert.equal(f.generateCalls(), 1);
});

test('purge fences an in-flight model call and never overwrites terminal cancelled state', async () => {
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const f = fixture({
    generate: async (args) => { entered(); await hold; return f.generate(args); },
  });
  await f.start();
  const body = f.pending.shift();
  const running = f.evaluations.deliver({ body, env: f.env });
  await ready;
  assert.equal((await f.request('eval-queue/purge', 'POST')).status, 200);
  release();
  await assert.rejects(running, /lease was lost/);
  assert.equal(f.rows('eval_runs')[0].status, 'purged');
  assert.ok(f.rows('experiment_variants').every((variant) => variant.status === 'error'));
  assert.ok(f.rows('eval_jobs').every((job) => job.state === 'cancelled'));
});

test('create-only runs are not falsely finalized by Scheduler and per-query enqueue works', async () => {
  const f = fixture();
  const { body: { evalRunId } } = await f.start({ skipJudge: true }, 'evaluations');
  await f.evaluations.scheduled({}, f.env);
  assert.equal(f.rows('eval_runs')[0].phase, 'generating');
  await f.request(`evaluations/${evalRunId}/queries`, 'POST', { queryId: 'q1' });
  await f.drain();
  assert.equal(f.rows('eval_runs')[0].phase, 'generating');
  await f.request(`evaluations/${evalRunId}/queries`, 'POST', { queryId: 'q2' });
  await f.drain();
  assert.equal(f.rows('eval_runs')[0].phase, 'complete');
});

test('a successful regeneration with an exhausted judge failure is marked partial, not silently complete', async () => {
  let fail = false;
  const f = fixture({
    judge: async () => {
      if (fail) throw new Error('judge unavailable');
      return {
        score: 4, dims: {}, inputTokens: 0, outputTokens: 0, durationMs: 0,
      };
    },
  });
  const { body: { evalRunId } } = await f.start();
  await f.drain();
  fail = true;
  const variantId = f.rows('experiment_variants')[0].id;
  await f.request(`evaluations/${evalRunId}/variants/${variantId}/regenerate`, 'POST');
  const body = f.pending.shift();
  await f.evaluations.deliver({ body, attempts: 6, env: f.env });
  assert.equal(f.rows('eval_runs')[0].status, 'partial');
  assert.match(f.rows('experiment_variants').find((variant) => variant.id === variantId).evaluator_notes, /judge_error/);
});

test('native suite loader uses packaged source content without the Worker JSON loader', async () => {
  const f = fixture({ suites: undefined });
  const res = await f.request('eval-suites');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.suites.some((suite) => suite.queryCount === 60));
});

test('native admin validates models, scope, authorization, methods and returns null for unrelated routes', async () => {
  const f = fixture();
  assert.equal((await f.start({ models: [{ provider: 'cloudflare', model: 'cf-model' }] })).status, 400);
  assert.equal(await f.evaluations.fetch(new Request('https://arco.test/api/recommend'), f.env), null);
  const res = await f.request('eval-suites');
  assert.equal((await res.json()).judgeModels[0].id, 'gemini-2.5-flash');
  assert.equal((await f.request('evaluations/start', 'POST', {})).status, 400);
  assert.equal((await f.request('evaluations/start', 'POST', null)).status, 400);
  assert.equal((await f.request('evaluations', 'OPTIONS')).status, 204);
  const denied = fixture({ authorize: async () => new Response(null, { status: 401 }) });
  assert.equal((await denied.request('eval-suites')).status, 401);
});
