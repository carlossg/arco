import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vertex from '../../src/providers/vertex.js';
import { getCatalog } from '../../src/providers/index.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const BASE_ENV = {
  VERTEX_AI_TOKEN: 'test-token',
  VERTEX_AI_ENDPOINT: 'https://mg-endpoint.example.com/v1/projects/proj/locations/us-central1/endpoints/ep',
};
const BASE_ARGS = {
  model: '2930507450790445056',
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0.7,
  maxTokens: 512,
};

async function collect(gen) {
  const items = [];
  for await (const item of gen) items.push(item);
  return items;
}

function makeSse(chunks, status = 200) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const CHUNK_HELLO = { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] };
const CHUNK_DONE = {
  choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

test('vertex — throws 401 when VERTEX_AI_TOKEN missing', async () => {
  await assert.rejects(
    collect(vertex.stream({ env: { VERTEX_AI_ENDPOINT: BASE_ENV.VERTEX_AI_ENDPOINT }, ...BASE_ARGS })),
    (err) => { assert.equal(err.status, 401); return true; },
  );
});

test('vertex — throws 401 when VERTEX_AI_ENDPOINT missing', async () => {
  await assert.rejects(
    collect(vertex.stream({ env: { VERTEX_AI_TOKEN: 'tok' }, ...BASE_ARGS })),
    (err) => { assert.equal(err.status, 401); return true; },
  );
});

test('vertex — throws on non-2xx response', async () => {
  globalThis.fetch = async () => new Response('{"error":"not found"}', { status: 404 });
  await assert.rejects(
    collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS })),
    (err) => { assert.equal(err.status, 404); return true; },
  );
});

test('vertex — sends Authorization: Bearer header', async () => {
  let hdrs;
  globalThis.fetch = async (_, opts) => { hdrs = opts.headers; return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: { ...BASE_ENV, VERTEX_AI_TOKEN: 'secret-456' }, ...BASE_ARGS }));
  assert.equal(hdrs.Authorization, 'Bearer secret-456');
});

test('vertex — sends Accept: text/event-stream header', async () => {
  let hdrs;
  globalThis.fetch = async (_, opts) => { hdrs = opts.headers; return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS }));
  assert.equal(hdrs.Accept, 'text/event-stream');
});

test('vertex — appends /chat/completions to endpoint base URL', async () => {
  let url;
  globalThis.fetch = async (u) => { url = String(u); return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS }));
  assert.equal(url, `${BASE_ENV.VERTEX_AI_ENDPOINT}/chat/completions`);
});

test('vertex — does NOT append /chat/completions if base URL already ends with it', async () => {
  let url;
  globalThis.fetch = async (u) => { url = String(u); return makeSse([CHUNK_DONE]); };
  const endpoint = `${BASE_ENV.VERTEX_AI_ENDPOINT}/chat/completions`;
  await collect(vertex.stream({ env: { ...BASE_ENV, VERTEX_AI_ENDPOINT: endpoint }, ...BASE_ARGS }));
  assert.equal(url, endpoint);
  assert.ok(!url.endsWith('/chat/completions/chat/completions'));
});

test('vertex — passes messages as-is (no conversion)', async () => {
  let body;
  globalThis.fetch = async (_, opts) => { body = JSON.parse(opts.body); return makeSse([CHUNK_DONE]); };
  const messages = [
    { role: 'system', content: 'Be helpful.' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: 'Next' },
  ];
  await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS, messages }));
  assert.deepEqual(body.messages, messages);
});

test('vertex — passes temperature and max_tokens', async () => {
  let body;
  globalThis.fetch = async (_, opts) => { body = JSON.parse(opts.body); return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({
    env: BASE_ENV, ...BASE_ARGS, temperature: 0.3, maxTokens: 2048,
  }));
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 2048);
});

test('vertex — includes stream: true and stream_options: { include_usage: true } in body', async () => {
  let body;
  globalThis.fetch = async (_, opts) => { body = JSON.parse(opts.body); return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS }));
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('vertex — yields delta chunks then usage frame', async () => {
  globalThis.fetch = async () => makeSse([CHUNK_HELLO, CHUNK_DONE]);
  const items = await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS }));
  assert.deepEqual(items[0], { type: 'delta', text: 'Hello' });
  assert.deepEqual(items[1], { type: 'delta', text: ' world' });
  assert.deepEqual(items[2], {
    type: 'usage',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  });
});

test('vertex — DiffusionGemma: single large chunk still yields delta + usage', async () => {
  const bigChunk = {
    choices: [{ delta: { content: 'entire response in one shot' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 },
  };
  globalThis.fetch = async () => makeSse([bigChunk]);
  const items = await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS, model: 'gemma-4-26b-diffusion' }));
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'delta');
  assert.equal(items[0].text, 'entire response in one shot');
  assert.equal(items[1].type, 'usage');
  assert.equal(items[1].usage.completion_tokens, 500);
});

test('vertex — VERTEX_AI_DIFFUSION_STEPS sets num_diffusion_steps in request body', async () => {
  let body;
  globalThis.fetch = async (_, opts) => { body = JSON.parse(opts.body); return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: { ...BASE_ENV, VERTEX_AI_DIFFUSION_STEPS: '32' }, ...BASE_ARGS }));
  assert.equal(body.num_diffusion_steps, 32);
});

test('vertex — omits num_diffusion_steps when VERTEX_AI_DIFFUSION_STEPS not set', async () => {
  let body;
  globalThis.fetch = async (_, opts) => { body = JSON.parse(opts.body); return makeSse([CHUNK_DONE]); };
  await collect(vertex.stream({ env: BASE_ENV, ...BASE_ARGS }));
  assert.ok(!('num_diffusion_steps' in body));
});

test('getCatalog — vertex: queries /models sibling of /chat/completions', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ data: [{ id: '2930507450790445056' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const env = {
    VERTEX_AI_TOKEN: 'tok',
    VERTEX_AI_ENDPOINT: 'https://mg-endpoint.example.com/v1/projects/proj/locations/us-central1/endpoints/ep',
  };
  const catalog = await getCatalog(env);
  assert.equal(capturedUrl, 'https://mg-endpoint.example.com/v1/projects/proj/locations/us-central1/endpoints/ep/models');
  assert.ok(catalog.some((e) => e.provider === 'vertex' && e.model === '2930507450790445056'));
  assert.ok(!catalog.some((e) => e.provider === 'vertex' && e.model === 'deployed-model'), 'placeholder removed');
});

test('getCatalog — vertex: falls back to placeholder when endpoint unreachable', async () => {
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const env = { VERTEX_AI_TOKEN: 'tok', VERTEX_AI_ENDPOINT: 'https://mg-endpoint.example.com/v1/projects/proj/locations/us-central1/endpoints/ep' };
  const catalog = await getCatalog(env);
  assert.ok(catalog.some((e) => e.provider === 'vertex' && e.model === 'deployed-model'));
});
