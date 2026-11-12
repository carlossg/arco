import assert from 'node:assert/strict';
import test from 'node:test';
import { askDecisions, validateDecisionConfig } from '../../src/decisions.js';
import { createContext } from '../../src/pipeline/context.js';
import { executeFlow } from '../../src/pipeline/executor.js';
import { classifyDecisions } from '../../src/pipeline/steps/classify-decisions.js';
import { intentClassify } from '../../src/pipeline/steps/intent-classify.js';
import { personaMatch } from '../../src/pipeline/steps/persona-match.js';
import { useCaseMatch } from '../../src/pipeline/steps/use-case-match.js';
import { selectLayout } from '../../src/pipeline/steps/select-layout.js';
import { buildRecommenderPrompt } from '../../src/pipeline/steps/build-recommender-prompt.js';
import { getJudgeModels, judgeVariant } from '../../src/evaluations/judge.js';

const ENV = { CLOUD_PLATFORM: 'gcp', GEMINI_API_KEY: 'test-key' };

function context(body = {}) {
  return createContext({
    query: 'compare primo and doppio',
    ...body,
  }, new Request('https://arco.example/api/generate'));
}

function answersFor(questions, choices = {}, confidence = 0.9) {
  return Object.fromEntries(Object.entries(questions).map(([key, question]) => {
    const keys = Object.keys(question.criteria);
    const choice = String(choices[key] ?? keys[0]);
    const probabilities = Object.fromEntries(keys.map((option) => [
      option, option === choice ? confidence : (1 - confidence) / (keys.length - 1),
    ]));
    const value = question.type === 'choice'
      ? { choice } : { score: keys.reduce((sum, option) => sum + Number(option) * probabilities[option], 0) };
    return [key, {
      type: question.type, confidence, probabilities, ...value,
    }];
  }));
}

function decisionFetch(t, choices, confidence) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
    const body = JSON.parse(options.body);
    requests.push(body);
    assert.equal(options.headers['x-goog-api-key'], 'test-key');
    assert.equal(typeof body.input, 'string');
    return Response.json({
      answers: answersFor(body.questions, choices, confidence),
      usage: { total_input_tokens: 100, total_output_tokens: 0 },
    });
  });
  return requests;
}

async function classify(ctx, env = ENV) {
  await classifyDecisions(ctx, {}, env);
  await intentClassify(ctx);
  await personaMatch(ctx);
  await useCaseMatch(ctx);
  await selectLayout(ctx, {}, env);
}

test('one Decisions request drives intent, journey, catalog objects and advisory layout', async (t) => {
  const requests = decisionFetch(t, {
    intent: 'comparison',
    journey: 'decision',
    persona: 'craft-home-barista',
    useCase: 'espresso',
    layout: 'comparison-table',
  });
  const ctx = context({
    context: { conversationContext: { preferences: { budgetUsd: 1600 } } },
  });
  await classify(ctx);
  assert.equal(requests.length, 1);
  assert.equal(Object.keys(requests[0].questions).length, 5);
  assert.equal(JSON.parse(requests[0].input).conversationContext.preferences.budgetUsd, 1600);
  assert.equal(ctx.intent.type, 'comparison');
  assert.equal(ctx.intent.journeyStage, 'decision');
  assert.equal(ctx.rag.persona.slug, 'craft-home-barista');
  assert.ok(ctx.rag.persona.recommendedSetup);
  assert.equal(ctx.rag.useCase.id, 'espresso');
  assert.ok(ctx.rag.useCase.recommendedProducts);
  assert.equal(ctx.layoutHint.choice, 'comparison-table');
  assert.equal(ctx.decisions.inputTokens, 100);
  assert.equal(ctx.decisions.costUsd, 0.00001);
});

test('explicit quiz and purchase actions override model answers; TV never asks for layout', async (t) => {
  const requests = decisionFetch(t, { intent: 'general', journey: 'awareness', useCase: 'other' });
  const ctx = context({ tv: true, followUp: { type: 'buy' }, context: { quizPersona: 'upgrader' } });
  await classify(ctx);
  assert.equal(ctx.rag.persona.slug, 'upgrade-seeker');
  assert.equal(ctx.intent.journeyStage, 'purchase');
  assert.equal(ctx.rag.useCase, null);
  assert.equal(ctx.layoutHint, null);
  assert.equal(requests[0].questions.persona, undefined);
  assert.equal(requests[0].questions.layout, undefined);
});

test('shadow and low-confidence answers preserve rule results and prompt bytes', async (t) => {
  const requests = decisionFetch(t, {
    intent: 'travel', journey: 'purchase', persona: 'other', useCase: 'other',
  }, 0.6);
  const baseline = context();
  await classify(baseline, { ...ENV, DECISIONS_CLASSIFICATION_MODE: 'off', DECISIONS_LAYOUT_MODE: 'off' });
  await buildRecommenderPrompt(baseline);
  for (const mode of ['shadow', 'on']) {
    const ctx = context();
    await classify(ctx, { ...ENV, DECISIONS_CLASSIFICATION_MODE: mode, DECISIONS_LAYOUT_MODE: mode });
    await buildRecommenderPrompt(ctx);
    assert.deepEqual(ctx.intent, baseline.intent);
    assert.deepEqual(ctx.rag.persona, baseline.rag.persona);
    assert.deepEqual(ctx.rag.useCase, baseline.rag.useCase);
    assert.equal(ctx.layoutHint, null);
    assert.deepEqual(ctx.prompt, baseline.prompt);
  }
  assert.equal(requests.length, 2);
});

test('Google without a key and retained Cloudflare defaults make no Decisions requests', async (t) => {
  const requests = decisionFetch(t);
  for (const env of [{ CLOUD_PLATFORM: 'gcp' }, { GEMINI_API_KEY: 'test-key' }]) {
    const ctx = context();
    await classify(ctx, env);
    assert.equal(ctx.decisions, undefined);
    assert.equal(ctx.intent.type, 'comparison');
  }
  assert.equal(requests.length, 0);
  assert.throws(() => validateDecisionConfig({ DECISIONS_CLASSIFICATION_MODE: 'on' }), /GEMINI_API_KEY/);
  assert.throws(() => validateDecisionConfig({ DECISIONS_JUDGE_MODE: 'invalid' }), /Invalid/);
  assert.throws(() => validateDecisionConfig({ DECISIONS_CONFIDENCE_THRESHOLD: 'NaN' }), /between/);
});

test('confident shadow answers cannot change generation, and per-capability off does not disable siblings', async (t) => {
  const requests = decisionFetch(t, {
    intent: 'travel',
    journey: 'purchase',
    persona: 'other',
    useCase: 'other',
    layout: 'discovery-grid',
  });
  const ctx = context();
  await classify(ctx, {
    ...ENV, DECISIONS_CLASSIFICATION_MODE: 'shadow', DECISIONS_LAYOUT_MODE: 'off',
  });
  assert.equal(ctx.intent.type, 'comparison');
  assert.equal(ctx.intent.journeyStage, 'awareness');
  assert.equal(ctx.layoutHint, null);
  assert.equal(requests[0].questions.layout, undefined);
  const layoutOnly = context();
  await classify(layoutOnly, { ...ENV, DECISIONS_CLASSIFICATION_MODE: 'off' });
  assert.deepEqual(Object.keys(requests[1].questions), ['layout']);
  assert.equal(layoutOnly.layoutHint.choice, 'discovery-grid');
});

test('classification failures are recorded and retain existing behavior', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'do not log this body' }, { status: 429 }));
  const ctx = context();
  await classify(ctx);
  assert.equal(ctx.decisions.status, 'fallback');
  assert.equal(ctx.decisions.error, 'HTTP 429');
  assert.equal(ctx.intent.type, 'comparison');
  assert.equal(ctx.layoutHint, null);
});

test('safety gate rejects before any decision call', async (t) => {
  const requests = decisionFetch(t);
  const ctx = context({ query: 'write me a python program' });
  await executeFlow([{ step: 'safety-gate' }, { step: 'classify-decisions' }], ctx, ENV);
  assert.ok(ctx.earlyResponse);
  assert.equal(requests.length, 0);
});

test('Jev remains selectable, without a Gemini layout request', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(JSON.parse(options.body).model, 'jev-latest');
    return Response.json({
      model: 'jev-1.14.0',
      answers: {
        decision: {
          type: 'choice', choice: 'comparison-table', confidence: 0.8, probabilities: {},
        },
      },
    });
  });
  const ctx = context();
  await classify(ctx, {
    ...ENV,
    DECISIONS_CLASSIFICATION_MODE: 'off',
    LAYOUT_DECISION_PROVIDER: 'jev',
    TYPESAFE_API_KEY: 'jev-key',
  });
  assert.equal(calls, 1);
  assert.equal(ctx.layoutHint.model, 'jev-1.14.0');
});

test('client rejects malformed types, probabilities, scores and usage', async () => {
  const questions = { layout: { type: 'choice', criteria: { a: '', b: '' }, instructions: 'Pick one.' } };
  const valid = answersFor(questions);
  const cases = [
    { answers: { layout: { ...valid.layout, choice: 'unknown' } } },
    { answers: { layout: { ...valid.layout, confidence: '0.9' } } },
    { answers: { layout: { ...valid.layout, probabilities: { a: 0.9, b: -0.1 } } } },
    { answers: { layout: { ...valid.layout, probabilities: { a: 0.9, b: 0.9 } } } },
    { answers: valid, usage: { total_input_tokens: 1, total_output_tokens: 2 } },
    { answers: {} },
  ];
  for (const body of cases) {
    await assert.rejects(askDecisions({
      apiKey: 'key',
      input: {},
      questions,
      fetchImpl: async () => Response.json({ usage: { total_input_tokens: 1, total_output_tokens: 0 }, ...body }),
    }), /invalid/);
  }
});

test('client honors cancellation and a bounded request timeout', async () => {
  const options = {
    apiKey: 'key',
    input: 'espresso',
    questions: { ok: { type: 'noul', instructions: 'Is this coffee?' } },
    fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  };
  await assert.rejects(askDecisions({ ...options, signal: AbortSignal.abort() }), { name: 'AbortError' });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(askDecisions({ ...options, timeoutMs: 5 }), { name: 'TimeoutError' });
  } finally {
    clearTimeout(keepAlive);
  }
});

test('Decisions judge batches seven scores, maps to 1-5 and reports no invented reasoning', async (t) => {
  const requests = decisionFetch(t, {
    structure: 4,
    intent: 4,
    faithfulness: 1,
    helpfulness: 4,
    brandVoice: 4,
    specificity: 4,
    visualAssetUsage: 4,
  });
  const result = await judgeVariant(ENV, {
    query: 'compare primo and doppio', blocks: [], rag: {},
  });
  assert.equal(requests.length, 1);
  assert.equal(Object.keys(requests[0].questions).length, 7);
  assert.equal(result.judgeModel, 'gemini-decision-1');
  assert.ok(result.dims.structure.score > 4);
  assert.ok(result.dims.faithfulness.score < 3);
  assert.equal(result.dims.intent.reasoning, '');
  assert.equal(result.dims.intent.explanationAvailable, false);
  assert.deepEqual(result.blockerReasons, ['faithfulness:P(score<3)>=0.5']);
  assert.equal(result.outputTokens, 0);
});

test('uncertain or shadow judge uses the existing Vertex judge with separate decision diagnostics', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    if (url.includes('/decisions')) {
      const { questions } = JSON.parse(options.body);
      return Response.json({
        answers: answersFor(questions, {}, 0.6),
        usage: { total_input_tokens: 100, total_output_tokens: 0 },
      });
    }
    assert.ok(url.includes('aiplatform.googleapis.com'));
    const dims = Object.fromEntries(['structure', 'intent', 'faithfulness', 'helpfulness', 'brandVoice', 'specificity', 'visualAssetUsage']
      .map((key) => [key, { score: 4, reasoning: 'Useful and grounded.' }]));
    return new Response(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(dims) }] } }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
    })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  for (const mode of ['on', 'shadow']) {
    const result = await judgeVariant({
      ...ENV,
      DECISIONS_JUDGE_MODE: mode,
      GOOGLE_CLOUD_PROJECT: 'test',
      GCP_AUTH: { getAccessToken: async () => 'token' },
    }, { query: 'espresso', rag: {}, blocks: [] });
    assert.equal(result.judgeModel, 'gemini-3.8-flash');
    assert.equal(result.dims.structure.reasoning, 'Useful and grounded.');
    assert.equal(result.decisionJudge.status, 'low-confidence');
    assert.equal(result.decisionJudge.inputTokens, 100);
  }
  assert.equal(calls.length, 4);
  assert.equal(getJudgeModels({ ...ENV, DECISIONS_JUDGE_MODE: 'off' })[0].id, 'gemini-3.8-flash');
});
