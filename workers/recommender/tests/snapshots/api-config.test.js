import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../../../scripts/api-config.js', import.meta.url), 'utf8');
const forkWorker = 'https://arco-recommender-carlossg.franklin-prod.workers.dev';
const googleService = 'https://arco-recommender-gcp-okyq6gkx3a-uc.a.run.app';
let moduleId = 0;

async function loadConfig(hostname, overrides = {}, stored = {}) {
  const previous = globalThis.window;
  globalThis.window = {
    location: { hostname },
    ARCO_CONFIG: overrides,
    localStorage: { getItem: (key) => stored[key] },
  };
  try {
    moduleId += 1;
    const code = Buffer.from(`${source}\n// Test instance ${moduleId}`).toString('base64');
    return await import(`data:text/javascript;base64,${code}`);
  } finally {
    globalThis.window = previous;
  }
}

test('fork preview and live hosts use Google for recommender, analytics, and admin', async () => {
  for (const hostname of [
    'main--arco--carlossg.aem.page',
    'main--arco--carlossg.aem.live',
    'feature--arco--carlossg.aem.page',
  ]) {
    const config = await loadConfig(hostname);
    assert.equal(config.ARCO_RECOMMENDER_URL, googleService);
    assert.equal(config.ARCO_ANALYTICS_URL, googleService);
    assert.equal(config.ARCO_ADMIN_URL, googleService);
  }
});

test('localhost defaults every API to Google instead of a legacy local Worker', async () => {
  const config = await loadConfig('localhost');
  assert.equal(config.ARCO_RECOMMENDER_URL, googleService);
  assert.equal(config.ARCO_ANALYTICS_URL, googleService);
  assert.equal(config.ARCO_ADMIN_URL, googleService);
});

test('runtime overrides independently route generation, analytics, and admin metrics', async () => {
  const config = await loadConfig('localhost', {
    RECOMMENDER_URL: 'https://generation.example',
    ANALYTICS_URL: 'https://analytics.example',
    ADMIN_URL: 'https://admin.example',
  }, { 'arco-recommender-url': 'https://stored.example' });
  assert.equal(config.ARCO_RECOMMENDER_URL, 'https://generation.example');
  assert.equal(config.ARCO_ANALYTICS_URL, 'https://analytics.example');
  assert.equal(config.ARCO_ADMIN_URL, 'https://admin.example');
});

test('stored generation and admin overrides remain independent', async () => {
  const config = await loadConfig('main--arco--carlossg.aem.page', {}, {
    'arco-recommender-url': 'https://generation.example',
    'arco-admin-url': 'https://admin.example',
  });
  assert.equal(config.ARCO_RECOMMENDER_URL, 'https://generation.example');
  assert.equal(config.ARCO_ADMIN_URL, 'https://admin.example');
});

test('all other hosts also default to Google without an automatic Cloudflare fallback', async () => {
  const config = await loadConfig('feature--arco--aem-growth-adoption.aem.page');
  assert.equal(config.ARCO_RECOMMENDER_URL, googleService);
});

test('Cloudflare remains available only by explicit backend opt-in', async () => {
  const fork = await loadConfig('main--arco--carlossg.aem.page', { BACKEND: 'cloudflare' });
  assert.equal(fork.ARCO_RECOMMENDER_URL, forkWorker);
  const config = await loadConfig('feature--arco--aem-growth-adoption.aem.page', { BACKEND: 'cloudflare' });
  assert.equal(config.ARCO_RECOMMENDER_URL, 'https://feature-arco-recommender.franklin-prod.workers.dev');
});

test('stale saved Cloudflare URLs cannot reactivate Cloudflare in Google mode', async () => {
  const config = await loadConfig('localhost', { ANALYTICS_URL: forkWorker }, {
    'arco-recommender-url': forkWorker,
    'arco-admin-url': forkWorker,
  });
  assert.equal(config.ARCO_RECOMMENDER_URL, googleService);
  assert.equal(config.ARCO_ANALYTICS_URL, googleService);
  assert.equal(config.ARCO_ADMIN_URL, googleService);
});
