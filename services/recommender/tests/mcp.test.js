import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandler, handleMcpContext } from '../src/mcp.js';
import { blockCloudflareRequests } from '../src/http.js';
import { personaMatch } from '../../../workers/recommender/src/pipeline/steps/persona-match.js';
import { createKV } from '../src/kv.js';
import { MockFirestore } from './mock-firestore.js';
import { SessionContextManager as manager } from '../../../scripts/session-context.js';
import { parseGenerateBody } from '../../../workers/recommender/src/request-schema.js';
import { createContext } from '../../../workers/recommender/src/pipeline/context.js';
import { ragContent } from '../../../workers/recommender/src/pipeline/steps/rag-content.js';
import { buildRecommenderPrompt } from '../../../workers/recommender/src/pipeline/steps/build-recommender-prompt.js';
import { runLlmVariant } from '../../../workers/recommender/src/pipeline/steps/llm-generate.js';
import { getProvider } from '../../../workers/recommender/src/providers/index.js';

const conversationContext = {
  summary: 'Comparing machines for a shared compact kitchen.',
  preferences: {
    budgetUsd: 1600,
    drinks: ['cappuccino'],
    people: 2,
    priorities: ['quiet operation', 'small footprint'],
  },
  productsDiscussed: ['primo', 'doppio'],
};

function fixture(t, options) {
  const outbound = [];
  t.mock.method(globalThis, 'fetch', blockCloudflareRequests(async (input) => {
    outbound.push(String(input));
    throw new Error(`Unexpected outbound request: ${input}`);
  }));
  const calls = [];
  const env = {
    CLOUD_PLATFORM: 'gcp',
    SERVICE_URL: 'https://demo.run.app',
    MCP_CONTEXT_STORE: createKV({ firestore: new MockFirestore() }, 'mcp-context'),
    AI: {
      async run(model, { text }) {
        calls.push({ text, model });
        return { data: [[0.1, 0.2]] };
      },
    },
    CONTENT_INDEX: {
      async query(vector) {
        assert.deepEqual(vector, [0.1, 0.2]);
        calls.push('firestore-vector');
        return { matches: [{ score: 0.9, metadata: { type: 'guide', slug: 'espresso-basics', title: 'Espresso basics' } }] };
      },
    },
  };
  const handler = createMcpHandler(options);
  const send = async (method, params, extra = {}) => {
    const response = await handler(new Request('https://demo.run.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method, params, ...extra,
      }),
    }), env);
    return { response, body: response.status === 202 ? null : await response.json() };
  };
  t.after(() => assert.deepEqual(outbound, [], 'No network requests, including Cloudflare, are allowed in unit tests'));
  return {
    handler,
    send,
    env,
    calls,
    call: async (name, args) => (await send('tools/call', { name, arguments: args })).body,
  };
}

test('MCP initialize negotiates protocol, lists all schemas, accepts initialized notification and ping', async (t) => {
  const { send } = fixture(t);
  const { body } = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.deepEqual(body.result, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'arco-coffee-concierge', version: '1.0.0' },
  });
  const initialized = await send('notifications/initialized', undefined, { id: undefined });
  assert.equal(initialized.response.status, 202);
  assert.equal(initialized.body, null);
  assert.deepEqual((await send('ping')).body.result, {});
  assert.equal((await send('ping', undefined, { id: null })).body.id, null);
  assert.equal((await send('ping', undefined, { id: 0 })).body.id, 0);
  const list = (await send('tools/list')).body.result.tools;
  assert.deepEqual(list.map((entry) => entry.name), ['recommend_coffee_setup', 'compare_products', 'get_product_details']);
  assert.deepEqual(list[0].inputSchema.required, ['query']);
  assert.equal(list[0].inputSchema.properties.persistPage.default, false);
});

test('recommendation uses catalog and vector retrieval, carries persona and shown products into link, never publishes by default', async (t) => {
  const { call, calls } = fixture(t, { publish: () => assert.fail('Unexpected publication') });
  const body = await call('recommend_coffee_setup', { query: 'first espresso setup', persona: 'budget-conscious-beginner', useCase: 'home espresso' });
  assert.equal(body.result.isError, false);
  const data = body.result.structuredContent;
  assert.equal(data.persona.slug, 'budget-conscious-beginner');
  assert.ok(data.products.every((product) => product.specs && product.price > 0 && product.currency === 'USD'));
  assert.ok(data.features.length);
  assert.ok(Array.isArray(data.faqs));
  assert.equal(data.content.guides[0].slug, 'espresso-basics');
  assert.ok(calls.includes('firestore-vector'));
  const url = new URL(data.storefrontUrl);
  assert.equal(url.origin, 'https://main--arco--carlossg.aem.page');
  assert.equal(url.searchParams.get('q'), 'first espresso setup');
  assert.equal(url.searchParams.get('persona'), 'budget-conscious-beginner');
  assert.equal(url.searchParams.get('utm_campaign'), 'mcp_concierge');
  assert.deepEqual(JSON.parse(url.searchParams.get('ctx')).shownProducts, data.products.map((product) => product.id));
  assert.equal(data.liveUrl, undefined);
});

test('explicit persistence runs headless generation then publishes a unique Gemini discover page', async (t) => {
  const steps = [];
  const { call } = fixture(t, {
    generate: async ({ context }) => {
      steps.push('generate');
      assert.deepEqual(context.quizPersona, { persona: 'office-manager' });
      return ['<div><h1>Office setup</h1></div>'];
    },
    publish: async (path, html) => {
      steps.push('publish');
      assert.match(path, /^\/discover\/gemini-[0-9a-f-]{36}$/);
      assert.match(html, /Office setup/);
      return { success: true, urls: { live: `https://main--arco--carlossg.aem.live${path}` } };
    },
  });
  const body = await call('recommend_coffee_setup', { query: 'coffee for our office team', persistPage: true });
  assert.equal(body.result.isError, false);
  assert.match(body.result.structuredContent.liveUrl, /aem.live\/discover\/gemini-/);
  assert.deepEqual(steps, ['generate', 'publish']);
});

test('comparison resolves prefixed IDs and exact names, keeps catalog specs authoritative over stale editorial data', async (t) => {
  const { call } = fixture(t);
  const body = await call('compare_products', { productA: 'arco-doppio', productB: 'Primo', contextQuery: 'milk drinks' });
  const data = body.result.structuredContent;
  assert.equal(body.result.isError, false);
  assert.equal(data.comparison.price.primo, 899);
  assert.equal(data.comparison.price.doppio, 1599);
  assert.equal(data.comparison.boilers.primo, 'Single');
  assert.match(data.editorial.title, /Primo vs Arco Doppio/);
  assert.equal(data.editorial.comparison_table, undefined);
  const url = new URL(data.storefrontUrl);
  assert.equal(url.searchParams.get('q'), 'Compare Doppio and Primo');
  assert.equal(url.searchParams.get('utm_medium'), 'connected_app');
  assert.equal(JSON.parse(url.searchParams.get('ctx')).inferredProfile.interests[0], 'milk drinks');
  const missing = await call('compare_products', { productA: 'Nano', productB: 'Studio Pro' });
  assert.equal(missing.result.structuredContent.editorial, null);
  assert.equal(missing.result.structuredContent.products[1].id, 'studio-pro');
  assert.deepEqual(missing.result.structuredContent.productIds.sort(), ['arco-nano', 'arco-studio-pro']);
});

test('publication failure never returns an unpublished live URL', async (t) => {
  const { call } = fixture(t, {
    generate: async () => ['<div><h1>Setup</h1></div>'],
    publish: async () => ({ success: false, error: 'Adobe credentials expired' }),
  });
  const body = await call('recommend_coffee_setup', { query: 'espresso', persistPage: true });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /Adobe credentials expired/);
  assert.equal(body.result.structuredContent, undefined);
});

test('product details include real prices, full specs, accessories, pairing guide and direct URLs', async (t) => {
  const { call } = fixture(t);
  const body = await call('get_product_details', { productIdOrName: 'Arco Primo' });
  const data = body.result.structuredContent;
  assert.equal(data.id, 'primo');
  assert.equal(data.price, 899);
  assert.equal(data.specs.groupHead, '58mm commercial');
  assert.ok(data.bestFor.includes('beginner'));
  assert.ok(data.pairing.includedAccessories.includes('58mm tamper'));
  assert.ok(data.pairing.grinders.some((product) => product.id === 'preciso'));
  assert.match(data.productUrl, /\/products\/espresso-machines\/primo$/);
  assert.equal(new URL(data.recommenderUrl).searchParams.get('utm_source'), 'gemini');
});

test('invalid inputs never execute tools; lookup and retrieval failures surface as tool errors', async (t) => {
  const {
    call, send, env, calls,
  } = fixture(t);
  assert.equal((await call('get_product_details', {})).error.code, -32602);
  assert.equal((await call('recommend_coffee_setup', { query: 'espresso', persistPage: 'true' })).error.code, -32602);
  assert.equal((await call('recommend_coffee_setup', { query: 'espresso', persona: 'invented' })).error.code, -32602);
  assert.equal((await call('unknown', {})).error.code, -32602);
  assert.equal((await send('unknown')).body.error.code, -32601);
  const unknown = await call('get_product_details', { productIdOrName: 'fake-primo-xl' });
  assert.equal(unknown.result.isError, true);
  assert.equal((await call('compare_products', { productA: 'primo', productB: 'Primo' })).result.isError, true);
  await send('tools/call', { name: 'recommend_coffee_setup', arguments: { query: 'espresso' } }, { id: undefined });
  assert.deepEqual(calls, []);
  env.CONTENT_INDEX.query = async () => { throw new Error('Firestore unavailable'); };
  assert.equal((await call('recommend_coffee_setup', { query: 'espresso' })).result.isError, true);
});

test('metadata, preflight, malformed JSON, batch rejection, origin and protocol validation', async (t) => {
  const { handler, env } = fixture(t);
  const get = await handler(new Request('https://demo.run.app/mcp'), env);
  assert.equal((await get.json()).serverInfo.name, 'arco-coffee-concierge');
  const options = await handler(new Request('https://demo.run.app/mcp', { method: 'OPTIONS' }), env);
  assert.equal(options.status, 204);
  assert.match(options.headers.get('access-control-allow-headers'), /MCP-Protocol-Version/);
  const request = (body, headers = {}) => new Request('https://demo.run.app/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
  });
  assert.equal((await (await handler(request('{'), env)).json()).error.code, -32700);
  assert.equal((await (await handler(request('[]'), env)).json()).error.code, -32600);
  assert.equal((await handler(request('{}', { origin: 'https://untrusted.example' }), env)).status, 403);
  assert.equal((await handler(request('{}', { 'mcp-protocol-version': 'unknown' }), env)).status, 400);
  const verification = new Request('https://demo.run.app/.well-known/google-connected-apps');
  assert.equal((await handler(verification, env)).status, 404);
  env.GOOGLE_CONNECTED_VERIFICATION_TOKEN = 'public-domain-challenge';
  assert.deepEqual(await (await handler(verification, env)).json(), { verification_tokens: ['public-domain-challenge'] });
});

test('Streamable HTTP GET rejects standalone event streams while preserving metadata health checks', async (t) => {
  const { handler, env } = fixture(t);
  for (const accept of ['text/event-stream', 'application/json, text/event-stream', 'text/event-stream; charset=utf-8']) {
    const stream = await handler(new Request('https://demo.run.app/mcp', { headers: { Accept: accept } }), env);
    assert.equal(stream.status, 405);
    assert.match(stream.headers.get('Allow'), /POST/);
  }
  const metadata = await handler(new Request('https://demo.run.app/mcp', { headers: { Accept: 'application/json' } }), env);
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).serverInfo.name, 'arco-coffee-concierge');
});

test('MCP logs identify actual tool execution without logging query context or returned products', async (t) => {
  const records = [];
  t.mock.method(console, 'log', (record) => records.push(JSON.parse(record)));
  const { call } = fixture(t);
  await call('compare_products', { productA: 'Primo', productB: 'Doppio', contextQuery: 'private coffee preference' });
  assert.equal(records.length, 1);
  assert.equal(records[0].rpcMethod, 'tools/call');
  assert.equal(records[0].tool, 'compare_products');
  assert.equal(records[0].toolError, false);
  assert.equal(records[0].status, 200);
  assert.equal(JSON.stringify(records).includes('private coffee preference'), false);
  assert.equal(JSON.stringify(records).includes('Primo'), false);
});

test('pipeline honors external persona objects and retains legacy quiz strings', async () => {
  for (const quizPersona of [{ persona: 'budget-conscious-beginner' }, 'upgrader']) {
    const parsed = parseGenerateBody({ query: 'office', context: { quizPersona } });
    const ctx = createContext(parsed.payload, new Request('https://demo.run.app/api/generate'));
    await personaMatch(ctx);
    assert.equal(ctx.rag.persona.slug, typeof quizPersona === 'string' ? 'upgrade-seeker' : quizPersona.persona);
  }
});

test('all tools create expiring opaque handoffs without conversation text in recommender URLs', async (t) => {
  const { call, env, calls } = fixture(t);
  for (const [tool, args] of [
    ['recommend_coffee_setup', { query: 'espresso setup' }],
    ['compare_products', { productA: 'Primo', productB: 'Doppio' }],
    ['get_product_details', { productIdOrName: 'Primo' }],
  ]) {
    const body = await call(tool, { ...args, conversationContext });
    assert.equal(body.result.isError, false);
    const data = body.result.structuredContent;
    const url = new URL(data.storefrontUrl || data.recommenderUrl);
    assert.equal(url.searchParams.has('ctx'), false);
    assert.equal(url.href.includes('cappuccino'), false);
    const id = url.searchParams.get('contextId');
    assert.match(id, /^[0-9a-f-]{36}$/);
    const response = await handleMcpContext(new Request(`https://demo.run.app/api/mcp/context/${id}`), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const saved = await response.json();
    assert.deepEqual(saved.context.conversationContext, conversationContext);
    assert.ok(Date.parse(saved.expiresAt) > Date.now());
    assert.ok(Date.parse(saved.expiresAt) <= Date.now() + 3600000);
    const row = (await env.MCP_CONTEXT_STORE.reference(id).get()).data();
    assert.ok(row.expires_at instanceof Date, 'Native Firestore TTL is set');
  }
  assert.ok(calls.some((entry) => entry.text?.[0]?.includes('cappuccino')), 'Recommendation RAG uses preferences');
});

test('MCP handoff survives browser hydration and request parsing and reaches the actual LLM provider', async (t) => {
  const { call, env, calls } = fixture(t);
  const data = (await call('compare_products', {
    productA: 'Primo', productB: 'Doppio', conversationContext,
  })).result.structuredContent;
  const storage = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else delete globalThis.sessionStorage;
  });
  manager.clear();
  t.mock.method(globalThis, 'fetch', (input) => {
    assert.match(input, /^https:\/\/demo.run.app\/api\/mcp\/context\//);
    return handleMcpContext(new Request(input), env);
  });
  const params = new URL(data.storefrontUrl).searchParams;
  const report = await manager.hydrateExternalContext(params, env.SERVICE_URL);
  assert.deepEqual(report.errors, []);
  const parsed = parseGenerateBody({
    query: params.get('q'), context: manager.buildContextParam(),
  });
  assert.equal(parsed.ok, true);
  const ctx = createContext(parsed.payload, new Request('https://demo.run.app/api/generate'));
  await ragContent(ctx, {}, env);
  assert.ok(calls.some((entry) => entry.text?.[0]?.includes('quiet operation')));
  await buildRecommenderPrompt(ctx);
  let receivedMessages;
  t.mock.method(getProvider('gemini'), 'stream', async function* stream({ messages }) {
    receivedMessages = messages;
    yield {
      type: 'delta',
      text: JSON.stringify({
        block: 'hero',
        rows: [[[{ type: 'h1', text: 'For your cappuccinos' }]]],
      }),
    };
  });
  ctx.writer = new WritableStream({ write() {} }).getWriter();
  ctx.encoder = new TextEncoder();
  try {
    await runLlmVariant(ctx, { ...env, GOOGLE_CLOUD_PROJECT: 'test', GCP_AUTH: {} }, {
      provider: 'gemini', model: 'gemini-2.5-flash', maxTokens: 512, temperature: 0.6,
    });
  } finally {
    await ctx.writer.close();
  }
  assert.match(receivedMessages[1].content, /"budgetUsd":1600/);
  assert.match(receivedMessages[1].content, /"drinks":\["cappuccino"\]/);
  assert.match(receivedMessages[1].content, /"people":2/);
  assert.match(receivedMessages[1].content, /quiet operation/);
  assert.match(receivedMessages[1].content, /current request overrides conflicting older preferences/);
  assert.ok(ctx.llm.sections.length, 'Real generation processing emits a section');
  assert.deepEqual(ctx.request.conversationContext, conversationContext);
});

test('conversation context is also passed into explicit headless publication', async (t) => {
  let received;
  const { call } = fixture(t, {
    generate: async ({ context }) => {
      received = context.conversationContext;
      return ['<div><h1>Your quiet kitchen setup</h1></div>'];
    },
    publish: async () => ({ success: true, urls: { live: 'https://example.test/discover/test' } }),
  });
  const body = await call('recommend_coffee_setup', {
    query: 'espresso setup', conversationContext, persistPage: true,
  });
  assert.equal(body.result.isError, false);
  assert.deepEqual(received, conversationContext);
});

test('invalid context is rejected at MCP and generation boundaries; expired or failed storage is explicit', async (t) => {
  const { call, env } = fixture(t);
  for (const incoming of [
    null, [], { name: 'John' }, { summary: 'x'.repeat(2001) },
    { preferences: { budgetUsd: -1 } }, { preferences: { people: 1.5 } },
    { preferences: { drinks: [12] } }, { productsDiscussed: Array(21).fill('primo') },
    { preferences: { email: 'not-allowed' } },
  ]) {
    const result = await call('compare_products', {
      productA: 'Primo', productB: 'Doppio', conversationContext: incoming,
    });
    assert.equal(result.error.code, -32602);
    const parsed = parseGenerateBody({ query: 'espresso', context: { conversationContext: incoming } });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error);
  }
  assert.deepEqual((await env.MCP_CONTEXT_STORE.list()).keys, []);
  const data = (await call('get_product_details', {
    productIdOrName: 'Primo', conversationContext,
  })).result.structuredContent;
  const id = new URL(data.recommenderUrl).searchParams.get('contextId');
  const request = new Request(`https://demo.run.app/api/mcp/context/${id}`);
  await env.MCP_CONTEXT_STORE.reference(id).update({ expiration: Math.floor(Date.now() / 1000) - 1 });
  assert.equal((await handleMcpContext(request, env)).status, 410);
  assert.equal((await handleMcpContext(new Request('https://demo.run.app/api/mcp/context/not-a-uuid'), env)).status, 400);
  assert.equal((await handleMcpContext(new Request(request.url, { method: 'OPTIONS' }), env)).status, 204);
  assert.equal((await handleMcpContext(new Request(request.url, { method: 'POST' }), env)).status, 405);
  t.mock.method(env.MCP_CONTEXT_STORE, 'get', async () => { throw new Error('Firestore unavailable'); });
  assert.equal((await handleMcpContext(request, env)).status, 503);
  t.mock.method(env.MCP_CONTEXT_STORE, 'put', async () => { throw new Error('Firestore unavailable'); });
  const failure = await call('get_product_details', { productIdOrName: 'Primo', conversationContext });
  assert.equal(failure.result.isError, true);
  assert.equal(failure.result.structuredContent, undefined, 'Never return a broken context link');
});
