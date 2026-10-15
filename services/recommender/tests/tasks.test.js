import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudTasksQueue, deliverTask, taskDeliveryMetadata } from '../src/tasks.js';

/* eslint-env node, es2022 */

function fixture(overrides = {}) {
  const calls = [];
  const documents = new Map();
  let state = 'PAUSED';
  const client = {
    async createTask(request) {
      calls.push(['createTask', request]);
      return [{ name: request.task.name }];
    },
    async getQueue(request) {
      calls.push(['getQueue', request]);
      return [{ name: request.name, state, retryConfig: { maxAttempts: -1 } }];
    },
    async purgeQueue(request) { calls.push(['purgeQueue', request]); },
    async resumeQueue(request) { calls.push(['resumeQueue', request]); state = 'RUNNING'; },
  };
  const firestore = {
    collection(collection) {
      return {
        doc(id) {
          return {
            async create(data) {
              const key = `${collection}/${id}`;
              if (documents.has(key)) throw Object.assign(new Error('exists'), { code: 6 });
              documents.set(key, data);
            },
          };
        },
      };
    },
  };
  const queue = new CloudTasksQueue({
    serviceUrl: 'https://arco.example.test',
    serviceAccountEmail: 'tasks@example.iam.gserviceaccount.com',
    client,
    firestore,
    now: () => 1700000000123,
    ...overrides,
  });
  const env = { CLOUD_PLATFORM: 'gcp', EVAL_QUEUE: queue };
  const invoke = (handler, options = {}) => deliverTask({
    body: { type: 'judge', variantId: 'v1' },
    taskId: 'logical-id',
    worker: { queue: handler },
    env,
    ...options,
  });
  return {
    queue, client, firestore, env, calls, documents, invoke,
  };
}

test('send targets authenticated Cloud Run endpoint with unmodified JSON and exact fractional delay', async () => {
  const { queue, calls } = fixture();
  await queue.send({ type: 'generate', queryId: 'q1' }, { delaySeconds: 2.5 });
  const { parent, task } = calls[0][1];
  assert.equal(parent, 'projects/api-project-642841493686/locations/us-central1/queues/arco-eval-gcp');
  assert.equal(task.httpRequest.url, 'https://arco.example.test/internal/tasks/eval');
  assert.deepEqual(JSON.parse(task.httpRequest.body.toString()), { type: 'generate', queryId: 'q1' });
  assert.deepEqual(task.scheduleTime, { seconds: 1700000002, nanos: 623000000 });
  assert.equal(task.httpRequest.oidcToken.audience, 'https://arco.example.test');
  assert.equal(task.httpRequest.oidcToken.serviceAccountEmail, 'tasks@example.iam.gserviceaccount.com');
  assert.equal(task.httpRequest.headers['X-Arco-Task-Attempt-Offset'], '0');
});

test('sendBatch honors independent delays and waits for all API calls, rejecting partial failures', async () => {
  const { queue, calls, client } = fixture();
  await queue.sendBatch([{ body: 1 }, { body: 2, delaySeconds: 90 }]);
  assert.equal(calls[1][1].task.scheduleTime.seconds - calls[0][1].task.scheduleTime.seconds, 90);
  client.createTask = async () => { throw new Error('quota'); };
  await assert.rejects(queue.sendBatch([{ body: 1 }, { body: 2 }]), AggregateError);
});

test('invalid batch is rejected before enqueuing any task', async () => {
  const { queue, calls } = fixture();
  await assert.rejects(queue.sendBatch([{ body: 1 }, { body: 2, delaySeconds: -1 }]));
  await assert.rejects(queue.send(undefined), /JSON serializable/);
  await assert.rejects(queue.send({}, { delaySeconds: Infinity }));
  assert.equal(calls.length, 0);
});

test('task metadata converts zero-based Google counts plus delayed retry offsets', () => {
  assert.deepEqual(taskDeliveryMetadata(new Headers({
    'X-CloudTasks-TaskRetryCount': '2',
    'X-Arco-Task-Attempt-Offset': '3',
    'X-Arco-Task-Id': 'stable',
  })), { attempts: 6, taskId: 'stable' });
  assert.deepEqual(taskDeliveryMetadata(new Headers({
    'X-CloudTasks-TaskName': 'projects/p/locations/l/queues/q/tasks/task-name',
  })), { attempts: 1, taskId: 'task-name' });
  assert.throws(() => taskDeliveryMetadata(new Headers({
    'X-CloudTasks-TaskRetryCount': '-1', 'X-Arco-Task-Id': 'id',
  })));
  assert.throws(() => taskDeliveryMetadata(new Headers()), /taskId/);
});

test('resolved consumer receives the Worker queue API and implicitly acknowledges', async () => {
  const { invoke, env } = fixture();
  const context = {};
  const result = await invoke(async (batch, receivedEnv, ctx) => {
    assert.equal(receivedEnv, env);
    assert.equal(ctx, context);
    assert.equal(batch.messages[0].attempts, 1);
    batch.messages[0].ack();
  }, { ctx: context });
  assert.equal(result.acknowledged, true);
});

test('explicit retry waits for durable replacement, preserving requested delay and absolute attempts', async () => {
  const { invoke, calls } = fixture();
  const retry = async (batch) => batch.messages[0].retry({ delaySeconds: 91 });
  const result = await invoke(retry, { attempts: 3 });
  assert.equal(result.retried, true);
  const { task } = calls[0][1];
  assert.match(task.name, /logical-id-retry-4$/);
  assert.equal(task.httpRequest.headers['X-Arco-Task-Attempt-Offset'], '3');
  assert.equal(task.httpRequest.headers['X-Arco-Task-Id'], 'logical-id');
  assert.equal(task.scheduleTime.seconds, 1700000091);
});

test('replacement task enqueue failure rejects instead of acknowledging original', async () => {
  const { invoke, client } = fixture();
  client.createTask = async () => { throw new Error('Tasks unavailable'); };
  await assert.rejects(invoke(async (batch) => batch.retryAll({ delaySeconds: 60 })), /Tasks unavailable/);
  client.createTask = async () => { throw Object.assign(new Error('exists'), { code: 6 }); };
  assert.equal((await invoke(async (batch) => batch.retryAll({ delaySeconds: 60 }))).retried, true);
});

test('unhandled worker error is returned for native retry, even following ack', async () => {
  const { invoke, documents } = fixture();
  await assert.rejects(invoke(async (batch) => {
    batch.ackAll();
    throw new Error('database unavailable');
  }), /database unavailable/);
  assert.equal(documents.size, 0);
});

test('maximum-attempt failure persists durable Firestore deadletter before success and is idempotent', async () => {
  const { invoke, documents } = fixture();
  const handler = async () => { throw new Error('judge failed'); };
  const result = await invoke(handler, { attempts: 6 });
  assert.equal(result.deadLettered, true);
  const document = documents.get('arco_task_deadletters_gcp/logical-id');
  assert.equal(document.attempts, 6);
  assert.equal(document.error, 'judge failed');
  assert.equal(document.createdAt, 1700000000123);
  assert.deepEqual(document.body, { type: 'judge', variantId: 'v1' });
  await invoke(handler, { attempts: 6 });
  assert.equal(documents.size, 1);
});

test('explicit retry at final attempt goes to Firestore; above cap never invokes consumer', async () => {
  const { invoke, documents, calls } = fixture();
  await invoke(async (batch) => batch.messages[0].retry({ delaySeconds: 30 }), { attempts: 6 });
  assert.equal(documents.size, 1);
  assert.equal(calls.length, 0);
  await invoke(async () => assert.fail('must not execute'), { attempts: 7 });
});

test('Firestore outage on exhausted task rejects for Google retry, never silently drops', async () => {
  const { invoke, firestore } = fixture();
  firestore.collection = () => ({ doc: () => ({ create: async () => { throw new Error('Firestore down'); } }) });
  await assert.rejects(invoke(async () => { throw new Error('failure'); }, { attempts: 6 }), /Firestore down/);
});

test('queue diagnostics, consumers, purge and resume call Google only, propagate failures', async () => {
  const { queue, calls, client } = fixture();
  const state = await queue.getQueueState();
  assert.equal(state.platform, 'gcp');
  assert.equal(state.deliveryPaused, true);
  assert.equal(state.deadLetter.backend, 'firestore');
  assert.equal((await queue.getConsumerState()).type, 'http');
  await queue.purge();
  assert.equal((await queue.resume()).state, 'RUNNING');
  const resumeCalls = calls.filter(([operation]) => operation === 'resumeQueue').length;
  await queue.resume();
  assert.equal(calls.filter(([operation]) => operation === 'resumeQueue').length, resumeCalls);
  client.purgeQueue = async () => { throw new Error('permission denied'); };
  await assert.rejects(queue.purge(), /permission denied/);
});
