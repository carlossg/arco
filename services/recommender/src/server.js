import { pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import worker from '../../../workers/recommender/src/index.js';
import { createAI } from './vertex.js';
import { createVectorIndex } from './vector-index.js';
import { createKV } from './kv.js';
import { createStorage } from './storage.js';
import { createAnalytics } from './analytics.js';
import { CloudTasksQueue, taskDeliveryMetadata } from './tasks.js';
import { createEvaluations } from './evaluations.js';
import { blockCloudflareRequests, createGoogleServer, googleTokenVerifier } from './http.js';

export default async function start(config = process.env) {
  const projectId = config.GOOGLE_CLOUD_PROJECT || 'api-project-642841493686';
  const location = config.VERTEX_LOCATION || 'us-central1';
  const serviceUrl = config.SERVICE_URL
    || 'https://arco-recommender-gcp-okyq6gkx3a-uc.a.run.app';
  const serviceAccountEmail = config.TASK_SERVICE_ACCOUNT
    || `arco-recommender-gcp@${projectId}.iam.gserviceaccount.com`;
  if (!config.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN must be configured before starting the Google backend');

  globalThis.fetch = blockCloudflareRequests();
  const firestore = new Firestore({ projectId, ignoreUndefinedProperties: true });
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const bucket = config.PAYLOAD_BUCKET
    ? new Storage({ projectId }).bucket(config.PAYLOAD_BUCKET) : undefined;
  const storageConfig = { firestore, bucket };
  const sessionStore = createKV(storageConfig, 'session-store');
  const env = {
    ...config,
    GOOGLE_CLOUD_PROJECT: projectId,
    VERTEX_LOCATION: location,
    CLOUD_PLATFORM: 'gcp',
    GCP_AUTH: auth,
    ENVIRONMENT: config.ENVIRONMENT || 'production',
    SERVICE_URL: serviceUrl,
    DA_ORG: config.DA_ORG || 'carlossg',
    DA_REPO: config.DA_REPO || 'arco',
    CACHE: createKV(storageConfig, 'cache'),
    GUIDES: createKV(storageConfig, 'guides'),
    SESSION_STORE: sessionStore,
    GCP_STORAGE: createStorage({ firestore, sessionStore }),
    ANALYTICS: createAnalytics({ firestore }),
    AI: createAI({ projectId, location, auth }),
    CONTENT_INDEX: createVectorIndex({
      projectId, location, firestore, collection: config.FIRESTORE_VECTOR_COLLECTION,
    }),
  };
  env.EVAL_QUEUE = new CloudTasksQueue({
    projectId,
    location,
    queue: config.EVAL_QUEUE_NAME || 'arco-eval-gcp',
    serviceUrl,
    serviceAccountEmail,
    firestore,
  });
  const evaluations = createEvaluations({ firestore, queue: env.EVAL_QUEUE });
  // Verify database access before Cloud Run's startup probe can succeed.
  await firestore.collection('arco_kv_gcp').limit(1).get();
  const server = createGoogleServer({
    env,
    verifyInternal: googleTokenVerifier({ serviceUrl, serviceAccount: serviceAccountEmail }),
    handler: async (request, bindings, ctx) => {
      request.ctx = ctx;
      if (request.method !== 'OPTIONS') {
        const response = await evaluations.fetch(request, bindings, ctx);
        if (response) return response;
      }
      return worker.fetch(request, bindings, ctx);
    },
    deliverTask: async (request, bindings, ctx) => evaluations.deliver({
      body: await request.json(),
      ...taskDeliveryMetadata(request.headers),
      env: bindings,
      ctx,
    }),
    scheduled: (bindings, ctx) => evaluations.scheduled({
      cron: '*/5 * * * *', scheduledTime: Date.now(),
    }, bindings, ctx),
  });
  const port = Number(config.PORT || 8080);
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Google] Listening on ${port}; Firestore, Vertex AI, Cloud Tasks; no Cloudflare`);
  });
  process.once('SIGTERM', () => server.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error('[Startup]', error);
    process.exitCode = 1;
  });
}
