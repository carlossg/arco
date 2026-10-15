/* eslint-env node, es2022 */
/* eslint-disable max-len, no-restricted-syntax, no-await-in-loop, import/no-relative-packages */

import test from 'node:test';
import assert from 'node:assert/strict';
import gemini from '../../../workers/recommender/src/providers/gemini.js';
import {
  getCatalog, catalogAvailability, platformDefaultEntry,
} from '../../../workers/recommender/src/providers/index.js';
import {
  getActiveLlmConfig, putActiveLlmConfig,
} from '../../../workers/recommender/src/llm-config.js';
import { getJudgeModels, isValidJudgeModel, judgeVariant } from '../../../workers/recommender/src/evaluations/judge.js';
import { createAI } from '../src/vertex.js';
import handleSuggestRequest from '../../../workers/recommender/src/suggest.js';

test('Vertex embedding compatibility aliases use ADC and never Cloudflare', async () => {
  let tokenCalls = 0;
  const requests = [];
  const ai = createAI({
    projectId: 'project-test',
    dimensions: 3,
    auth: { getAccessToken: async () => { tokenCalls += 1; return `token-${tokenCalls}`; } },
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return Response.json({ predictions: JSON.parse(init.body).instances.map(() => ({ embeddings: { values: [0.1, 0.2, 0.3] } })) });
    },
  });
  assert.deepEqual(await ai.run('@cf/baai/bge-small-en-v1.5', { text: ['espresso'] }), { data: [[0.1, 0.2, 0.3]] });
  await ai.embed(['product'], { taskType: 'RETRIEVAL_DOCUMENT' });
  assert.equal(tokenCalls, 2);
  assert.equal(requests[1].headers.Authorization, 'Bearer token-2');
  assert.match(requests[0].url, /^https:\/\/us-central1-aiplatform\.googleapis\.com\/v1\/projects\/project-test\//);
  assert.equal(JSON.parse(requests[0].body).instances[0].task_type, 'RETRIEVAL_QUERY');
  assert.equal(JSON.parse(requests[1].body).instances[0].task_type, 'RETRIEVAL_DOCUMENT');
  assert.equal(JSON.parse(requests[0].body).parameters.outputDimensionality, 3);
  await assert.rejects(ai.run('@cf/meta/llama', {}), /Unsupported AI operation/);
});

test('embeddings batch, validate dimensionality, retry only transient statuses', async () => {
  let calls = 0;
  const auth = { getAccessToken: async () => ({ token: 'adc' }) };
  const ai = createAI({
    auth,
    dimensions: 2,
    batchSize: 1,
    sleep: async () => {},
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response('private body', { status: 429 });
      return Response.json({ predictions: [{ embeddings: { values: [1, 2] } }] });
    },
  });
  assert.deepEqual((await ai.embed(['one', 'two'])).data, [[1, 2], [1, 2]]);
  assert.equal(calls, 3);
  ai.fetch = async () => Response.json({ predictions: [{ embeddings: { values: [1] } }] });
  await assert.rejects(ai.embed(['one']), /invalid embeddings/);
  ai.fetch = async () => new Response('secret', { status: 403 });
  await assert.rejects(ai.embed(['one']), (error) => error.status === 403 && !error.message.includes('secret'));
  await assert.rejects(ai.embed(['']), /nonempty/);
  assert.throws(() => createAI({ dimensions: 0.5 }), /dimensions/);
});

function geminiEnv(events) {
  let captured;
  const encoded = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  const env = {
    CLOUD_PLATFORM: 'gcp',
    GCP_AUTH: { getAccessToken: async () => 'adc' },
    GCP_FETCH: async (url, init) => {
      captured = { url, init };
      // Intentionally split bytes across SSE/CRLF/JSON boundaries.
      return new Response(new ReadableStream({
        start(controller) {
          for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
          controller.close();
        },
      }));
    },
  };
  return { env, captured: () => captured };
}

test('Gemini maps streamed text, messages, and usage to the existing provider contract', async () => {
  const stub = geminiEnv([
    { candidates: [{ content: { parts: [{ text: 'private thought', thought: true }, { text: 'Espressò' }] } }] },
    {
      candidates: [{ content: { parts: [{ text: ' coffee' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 15,
      },
    },
  ]);
  const chunks = [];
  for await (const chunk of gemini.stream({
    env: stub.env,
    model: 'gemini-2.5-flash',
    messages: [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'coffee?' }],
    temperature: 0,
    maxTokens: 100,
  })) chunks.push(chunk);
  assert.equal(chunks.filter((chunk) => chunk.type === 'delta').map((chunk) => chunk.text).join(''), 'Espressò coffee');
  assert.equal(chunks.at(-1).usage.completion_tokens, 5);
  const request = stub.captured();
  assert.match(request.url, /publishers\/google\/models\/gemini-2.5-flash:streamGenerateContent\?alt=sse/);
  const body = JSON.parse(request.init.body);
  assert.equal(body.systemInstruction.parts[0].text, 'Be helpful.');
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'coffee?' }] }]);
});

test('Gemini propagates authorization, streaming and blocked errors', async () => {
  for (const env of [
    { GCP_AUTH: { getAccessToken: async () => 'adc' }, GCP_FETCH: async () => new Response('secret', { status: 403 }) },
    geminiEnv([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }]).env,
    geminiEnv([{ promptFeedback: { blockReason: 'SAFETY' } }]).env,
  ]) {
    await assert.rejects(async () => {
      for await (const chunk of gemini.stream({ env, model: 'gemini-2.5-flash', messages: [] })) assert.ok(chunk);
    });
  }
});

test('GCP model catalog/defaults avoid Cloudflare and unconfigured AWS; Worker catalog remains intact', async () => {
  const env = { CLOUD_PLATFORM: 'gcp', GCP_AUTH: {}, GEMINI_MODEL: 'gemini-test' };
  const catalog = await getCatalog(env);
  assert.equal(catalog[0].provider, 'gemini');
  assert.equal(catalog[0].model, 'gemini-test');
  assert.equal(catalog.some((entry) => ['cloudflare', 'bedrock'].includes(entry.provider)), false);
  assert.equal(catalogAvailability({ provider: 'cloudflare' }, { ...env, AI: {} }).available, false);
  assert.equal(platformDefaultEntry({}).provider, 'cerebras');
  assert.equal((await getCatalog({})).some((entry) => entry.provider === 'cloudflare'), true);
  assert.equal((await getActiveLlmConfig(env)).provider, 'gemini');
  env.CACHE = {
    get: async () => ({ provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' }),
    put: async () => assert.fail('must not persist Cloudflare config'),
  };
  assert.equal((await getActiveLlmConfig(env)).provider, 'gemini');
  assert.match((await putActiveLlmConfig(env, { provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' })).error, /unavailable on GCP/);
});

test('GCP judge uses Gemini without AWS while preserving Worker judge list', async () => {
  const dimensions = ['structure', 'intent', 'faithfulness', 'helpfulness', 'brandVoice', 'specificity', 'visualAssetUsage'];
  const score = Object.fromEntries(dimensions.map((key) => [key, { score: 4, reasoning: 'good' }]));
  const { env } = geminiEnv([{ candidates: [{ content: { parts: [{ text: JSON.stringify(score) }] }, finishReason: 'STOP' }] }]);
  assert.equal(getJudgeModels(env)[0].id, 'gemini-2.5-flash');
  assert.equal(isValidJudgeModel('claude-sonnet-4-6', env), false);
  assert.equal(isValidJudgeModel('claude-sonnet-4-6'), true);
  const result = await judgeVariant(env, { query: 'espresso', blocks: [], rag: {} });
  assert.equal(result.score, 4);
  assert.equal(result.judgeModel, 'gemini-2.5-flash');
});

test('GCP suggestions default to Vertex Gemini with thinking disabled for the small token budget', async () => {
  const suggestions = [{ label: 'Try a flat white', query: 'How do I make a flat white?' }];
  const stub = geminiEnv([{ candidates: [{ content: { parts: [{ text: JSON.stringify({ suggestions }) }] }, finishReason: 'STOP' }] }]);
  const response = await handleSuggestRequest(new Request('https://arco.example/api/suggest', {
    method: 'POST',
    body: JSON.stringify({ pageTitle: 'Espresso', count: 1 }),
    headers: { 'Content-Type': 'application/json' },
  }), stub.env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).suggestions, suggestions);
  const body = JSON.parse(stub.captured().init.body);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(body.generationConfig.maxOutputTokens, 256);
});
