/**
 * Cloud Tasks transport for the shared evaluation queue consumer.
 *
 * Cloud Tasks has no native DLQ. Failed deliveries are retained in Firestore
 * before returning success, using a stable logical task ID across delayed
 * retries. Configure the Google queue with unlimited retries (maxAttempts=-1,
 * maxRetryDuration=0) so a Firestore outage cannot discard an exhausted task.
 * Native failures use the queue's exponential retry policy; explicit consumer
 * retries create a replacement task with its requested scheduleTime.
 *
 * Parent HTTP wiring, AFTER verifying the Google OIDC token and audience:
 *   await deliverTask({
 *     body: await request.json(),
 *     ...taskDeliveryMetadata(request.headers),
 *     worker, env, ctx,
 *   });
 * Return 204 only after this resolves; return 5xx on rejection.
 * Do not pass retry/ack bookkeeping to waitUntil without awaiting it.
 *
 * Native Firestore evaluations use createEvaluations(...).deliver in place of
 * deliverTask with the D1-backed worker.queue; they own their native lifecycle.
 * Scheduler: POST /internal/scheduled every five minutes with an OIDC service
 * account allowed to invoke this service. Verify its token, then await
 * evaluations.scheduled({ cron: '*\/5 * * * *', scheduledTime: Date.now() }, env, ctx).
 * Task and Scheduler identities need run.invoker; the runtime needs
 * cloudtasks.enqueuer, queue get/purge/resume permissions for admin operations,
 * datastore.user, and iam.serviceAccounts.actAs on the task OIDC identity.
 * Both OIDC identities must belong to the queue/scheduler project. Preserve
 * Google's managed Cloud Tasks/Scheduler service-agent roles for token minting.
 * Use the service origin as the OIDC audience, not a URL with query parameters.
 */
/* eslint-env node, es2022 */

import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_ATTEMPTS = 6;
const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_OFFSET_HEADER = 'X-Arco-Task-Attempt-Offset';
const LOGICAL_ID_HEADER = 'X-Arco-Task-Id';

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function validateDelay(delaySeconds = 0) {
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0
    || delaySeconds > MAX_DELAY_SECONDS) {
    throw new TypeError('delaySeconds must be between 0 and 2592000');
  }
  return delaySeconds;
}

function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,450}$/.test(taskId)) {
    throw new TypeError('taskId must be a nonempty Cloud Tasks ID');
  }
  return taskId;
}

function isAlreadyExists(error) {
  return error?.code === 6 || error?.code === 'ALREADY_EXISTS';
}

function serializeBody(body) {
  const serialized = JSON.stringify(body);
  if (serialized === undefined) throw new TypeError('Task body must be JSON serializable');
  return serialized;
}

/**
 * Metadata is trustworthy only after the parent authenticates the request.
 * Cloud Tasks retry count is zero-based; the shared queue consumer is one-based.
 * The offset preserves attempts when retry({delaySeconds}) replaces a task.
 */
export function taskDeliveryMetadata(headers) {
  const read = (name) => headers.get(name);
  const parseCount = (name) => {
    const raw = read(name) ?? '0';
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new TypeError(`Invalid ${name}`);
    }
    return Number(raw);
  };
  const attempts = positiveInteger(
    parseCount('X-CloudTasks-TaskRetryCount') + parseCount(ATTEMPT_OFFSET_HEADER) + 1,
    'attempts',
  );
  const taskId = read(LOGICAL_ID_HEADER) || read('X-CloudTasks-TaskName')?.split('/').pop();
  return { attempts, taskId: validateTaskId(taskId) };
}

export class CloudTasksQueue {
  constructor(config = {}) {
    this.projectId = config.projectId || 'api-project-642841493686';
    this.location = config.location || 'us-central1';
    this.queue = config.queue || 'arco-eval-gcp';
    this.maxAttempts = positiveInteger(config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
    const serviceUrl = new URL(config.serviceUrl);
    if (serviceUrl.protocol !== 'https:' || serviceUrl.username || serviceUrl.password
      || serviceUrl.search || serviceUrl.hash) {
      throw new TypeError('serviceUrl must be a credential-free HTTPS URL');
    }
    if (!config.serviceAccountEmail) throw new TypeError('serviceAccountEmail is required');
    this.targetUrl = new URL('/internal/tasks/eval', serviceUrl).href;
    this.oidcAudience = config.oidcAudience || serviceUrl.origin;
    this.serviceAccountEmail = config.serviceAccountEmail;
    this.parent = `projects/${this.projectId}/locations/${this.location}/queues/${this.queue}`;
    this.client = config.client;
    this.firestore = config.firestore;
    this.deadletterCollection = config.deadletterCollection || 'arco_task_deadletters_gcp';
    this.now = config.now || Date.now;
  }

  async getClient() {
    if (!this.client) {
      this.client = import('@google-cloud/tasks').then(({ CloudTasksClient }) => new CloudTasksClient());
    }
    return this.client;
  }

  async getFirestore() {
    if (!this.firestore) {
      this.firestore = import('@google-cloud/firestore')
        .then(({ Firestore }) => new Firestore({ projectId: this.projectId }));
    }
    return this.firestore;
  }

  async createTask(body, options = {}) {
    const serialized = serializeBody(body);
    const delaySeconds = validateDelay(options.delaySeconds);
    const taskId = validateTaskId(options.taskId || randomUUID());
    const attemptOffset = options.attemptOffset ?? 0;
    positiveInteger(attemptOffset + 1, 'attemptOffset + 1');
    const name = `${this.parent}/tasks/${options.taskName || taskId}`;
    const when = this.now() + delaySeconds * 1000;
    const client = await this.getClient();
    const [task] = await client.createTask({
      parent: this.parent,
      task: {
        name,
        httpRequest: {
          httpMethod: 'POST',
          url: this.targetUrl,
          headers: {
            'Content-Type': 'application/json',
            [ATTEMPT_OFFSET_HEADER]: String(attemptOffset),
            [LOGICAL_ID_HEADER]: taskId,
          },
          body: Buffer.from(serialized),
          oidcToken: {
            serviceAccountEmail: this.serviceAccountEmail,
            audience: this.oidcAudience,
          },
        },
        scheduleTime: {
          seconds: Math.floor(when / 1000),
          nanos: Math.floor((when % 1000) * 1e6),
        },
        // Cloud Tasks HTTP maximum; runtime request timeout must be at least this.
        dispatchDeadline: { seconds: 1800 },
      },
    });
    return task;
  }

  async send(body, options = {}) {
    return this.createTask(body, { delaySeconds: options.delaySeconds });
  }

  async sendBatch(messages) {
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
    // Validate the complete batch before creating anything. Cloud Tasks does
    // not offer atomic batch creation; partial API failures reject the batch.
    messages.forEach(({ body, delaySeconds }) => {
      serializeBody(body);
      validateDelay(delaySeconds);
    });
    const pending = messages.map((message) => this.send(message.body, {
      delaySeconds: message.delaySeconds,
    }));
    const results = await Promise.allSettled(pending);
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Cloud Tasks batch creation failed');
    return results.map((result) => result.value);
  }

  async retryTask(body, { attempts, taskId, delaySeconds = 0 }) {
    positiveInteger(attempts, 'attempts');
    validateTaskId(taskId);
    try {
      return await this.createTask(body, {
        taskId,
        taskName: `${taskId}-retry-${attempts + 1}`,
        attemptOffset: attempts,
        delaySeconds,
      });
    } catch (error) {
      // Retrying the original HTTP delivery after an uncertain enqueue result
      // must not create duplicate replacements or reset their attempt count.
      if (isAlreadyExists(error)) return { alreadyExists: true };
      throw error;
    }
  }

  async deadLetter({
    taskId, body, error, attempts,
  }) {
    validateTaskId(taskId);
    const firestore = await this.getFirestore();
    try {
      await firestore.collection(this.deadletterCollection).doc(taskId).create({
        body: JSON.parse(serializeBody(body)),
        error: error?.message || String(error),
        attempts,
        createdAt: this.now(),
      });
    } catch (writeError) {
      if (!isAlreadyExists(writeError)) throw writeError;
    }
    return { deadLettered: true, taskId };
  }

  async getQueueState() {
    const client = await this.getClient();
    const [queue] = await client.getQueue({ name: this.parent });
    return {
      platform: 'gcp',
      backend: 'cloud-tasks',
      name: queue.name,
      state: queue.state,
      deliveryPaused: queue.state === 'PAUSED' || queue.state === 2,
      rateLimits: queue.rateLimits,
      retryConfig: queue.retryConfig,
      deadLetter: {
        backend: 'firestore',
        collection: this.deadletterCollection,
        maxAttempts: this.maxAttempts,
      },
    };
  }

  async getConsumerState() {
    const queue = await this.getQueueState();
    return {
      type: 'http',
      targetUrl: this.targetUrl,
      state: queue.state,
      deliveryPaused: queue.deliveryPaused,
    };
  }

  async purge() {
    const client = await this.getClient();
    await client.purgeQueue({ name: this.parent });
    return { platform: 'gcp', purged: true };
  }

  async resume() {
    const queue = await this.getQueueState();
    if (queue.state === 'RUNNING' || queue.state === 1) return queue;
    const client = await this.getClient();
    await client.resumeQueue({ name: this.parent });
    return this.getQueueState();
  }
}

/**
 * Resolves only after all required transport side effects are durable.
 * Errors thrown by worker.queue are returned to Google for native retry until
 * maxAttempts, then persisted in Firestore before acknowledging the delivery.
 * The shared consumer MUST rethrow operational errors on GCP, rather than
 * catching and acking them as the historical Cloudflare consumer does.
 */
export async function deliverTask({
  body, attempts = 1, taskId, worker, env, ctx,
  maxAttempts = env.EVAL_QUEUE.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
}) {
  positiveInteger(attempts, 'attempts');
  positiveInteger(maxAttempts, 'maxAttempts');
  validateTaskId(taskId);
  let retryOptions;
  let acknowledged = false;
  const message = {
    body,
    attempts,
    ack() {
      if (retryOptions) throw new Error('Cannot acknowledge a task after requesting retry');
      acknowledged = true;
    },
    retry(options = {}) {
      if (acknowledged) throw new Error('Cannot retry an acknowledged task');
      validateDelay(options.delaySeconds);
      retryOptions = { delaySeconds: options.delaySeconds ?? 0 };
    },
  };
  const deadLetter = (error) => env.EVAL_QUEUE.deadLetter({
    taskId, body, attempts, error,
  });
  if (attempts > maxAttempts) return deadLetter(new Error('Maximum task attempts exceeded'));
  try {
    await worker.queue({
      queue: env.EVAL_QUEUE.queue,
      messages: [message],
      ackAll: () => message.ack(),
      retryAll: (options) => message.retry(options),
    }, env, ctx);
  } catch (error) {
    if (attempts >= maxAttempts) return deadLetter(error);
    throw error;
  }
  if (retryOptions) {
    if (attempts >= maxAttempts) return deadLetter(new Error('Retry requested at maximum task attempts'));
    await env.EVAL_QUEUE.retryTask(body, { attempts, taskId, ...retryOptions });
    return { retried: true, taskId };
  }
  // As with Workers queues, a normally resolved consumer implicitly acks.
  return { acknowledged: true, taskId };
}
