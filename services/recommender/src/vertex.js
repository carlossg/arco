/* eslint-env node, es2022 */
/* eslint-disable no-await-in-loop, no-continue */

const DEFAULT_PROJECT = 'api-project-642841493686';
const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_MODEL = 'text-embedding-005';
const DEFAULT_DIMENSIONS = 768;

export const EMBEDDING_DEFAULTS = {
  projectId: DEFAULT_PROJECT,
  location: DEFAULT_LOCATION,
  model: DEFAULT_MODEL,
  dimensions: DEFAULT_DIMENSIONS,
};

export function vertexConfig(config = {}) {
  const dimensions = Number(
    config.dimensions ?? process.env.VERTEX_EMBEDDING_DIMENSIONS ?? DEFAULT_DIMENSIONS,
  );
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 768) {
    throw new Error('Vertex embedding dimensions must be an integer between 1 and 768.');
  }
  return {
    projectId: config.projectId || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT,
    location: config.location || process.env.VERTEX_LOCATION || DEFAULT_LOCATION,
    model: config.model || process.env.VERTEX_EMBEDDING_MODEL || DEFAULT_MODEL,
    dimensions,
  };
}

export class VertexAI {
  constructor(config = {}) {
    Object.assign(this, vertexConfig(config));
    this.auth = config.auth;
    this.fetch = config.fetch || globalThis.fetch;
    this.batchSize = config.batchSize || (this.model.startsWith('gemini-embedding') ? 1 : 5);
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 5) {
      throw new Error('Vertex embedding batchSize must be between 1 and 5.');
    }
    this.maxRetries = config.maxRetries ?? 5;
    this.sleep = config.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  }

  async getAccessToken() {
    if (!this.auth) {
      const { GoogleAuth } = await import('google-auth-library');
      this.auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    }
    const result = await this.auth.getAccessToken();
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw new Error('Vertex ADC did not return an access token.');
    return token;
  }

  async predict(texts, taskType, signal) {
    const endpoint = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/locations/${encodeURIComponent(this.location)}/publishers/google/models/${encodeURIComponent(this.model)}:predict`;
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      const token = await this.getAccessToken();
      const response = await this.fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: signal || AbortSignal.timeout(30_000),
        body: JSON.stringify({
          instances: texts.map((content) => ({ content, task_type: taskType })),
          parameters: { outputDimensionality: this.dimensions, autoTruncate: false },
        }),
      });
      if (!response.ok) {
        // Never echo the remote body: it may contain request text or credentials.
        if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
          await response.body?.cancel();
          const retryAfter = response.headers.get('retry-after');
          const seconds = Number(retryAfter);
          const requestedDelay = retryAfter && Number.isFinite(seconds)
            ? seconds * 1000 : Date.parse(retryAfter || '') - Date.now();
          const backoff = response.status === 429 ? 2000 : 500;
          await this.sleep(Math.max(
            Math.min(60_000, backoff * (2 ** attempt)),
            Number.isFinite(requestedDelay) ? Math.min(120_000, requestedDelay) : 0,
          ));
          continue;
        }
        const error = new Error(`Vertex embedding request failed (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
      }
      const body = await response.json();
      const vectors = body.predictions?.map((prediction) => prediction.embeddings?.values);
      if (vectors?.length !== texts.length || vectors.some((vector) => (
        !Array.isArray(vector) || vector.length !== this.dimensions
        || vector.some((value) => !Number.isFinite(value))
      ))) {
        throw new Error(`Vertex returned invalid embeddings; expected ${texts.length} vectors of ${this.dimensions} dimensions.`);
      }
      return vectors;
    }
  }

  async embed(texts, { taskType = 'RETRIEVAL_QUERY', signal } = {}) {
    if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string' || !text.trim())) {
      throw new Error('Embedding input must be an array of nonempty strings.');
    }
    const data = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const textsBatch = texts.slice(offset, offset + this.batchSize);
      const batch = await this.predict(textsBatch, taskType, signal);
      data.push(...batch);
    }
    return { data };
  }

  async run(model, { text, signal } = {}) {
    // Existing Worker callers name a Cloudflare BGE embedding model. This is a
    // compatibility alias only: every request still uses the configured Vertex model.
    if (!/^@cf\/.*(?:bge|embedding)/.test(model || '') && model !== this.model) {
      const error = new Error(`Unsupported AI operation on GCP: ${model}`);
      error.status = 400;
      throw error;
    }
    return this.embed(typeof text === 'string' ? [text] : text, { signal });
  }
}

export function createAI(config = {}) {
  return new VertexAI(config);
}
