/**
 * Unit tests for the Jev (TypeSafe AI System One) client and the
 * select-layout pipeline step. All HTTP calls are mocked via injected
 * `fetchImpl` — no real network/API-key access needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askChoice } from '../../src/jev-client.js';
import { selectLayout } from '../../src/pipeline/steps/select-layout.js';

function mockFetch(response, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => response,
  });
}

test('jev-client askChoice — returns null when apiKey is missing', async () => {
  const result = await askChoice({
    apiKey: '',
    state: { query: 'espresso vs drip' },
    instructions: 'pick one',
    criteria: { a: null, b: null },
  });
  assert.equal(result, null);
});

test('jev-client askChoice — parses a successful choice answer', async () => {
  const result = await askChoice({
    apiKey: 'test-key',
    state: { query: 'compare primo and doppio' },
    instructions: 'What content shape fits best?',
    criteria: { 'comparison-table': null, 'single-recommendation': null },
    fetchImpl: mockFetch({
      model: 'jev-1.13.0',
      answers: {
        decision: {
          type: 'choice',
          choice: 'comparison-table',
          probabilities: { 'comparison-table': 0.91, 'single-recommendation': 0.09 },
          confidence: 0.87,
        },
      },
      usage: { input_tokens: 40, output_tokens: 2 },
    }),
  });
  assert.equal(result.choice, 'comparison-table');
  assert.equal(result.confidence, 0.87);
  assert.equal(result.model, 'jev-1.13.0');
});

test('jev-client askChoice — returns null on non-OK HTTP response', async () => {
  const result = await askChoice({
    apiKey: 'test-key',
    state: {},
    instructions: 'x',
    criteria: { a: null },
    fetchImpl: mockFetch({}, { ok: false, status: 401 }),
  });
  assert.equal(result, null);
});

test('jev-client askChoice — returns null when fetch throws', async () => {
  const result = await askChoice({
    apiKey: 'test-key',
    state: {},
    instructions: 'x',
    criteria: { a: null },
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(result, null);
});

function makeCtx(overrides = {}) {
  return {
    request: {
      query: 'compare primo and doppio', previousQueries: [], followUp: null, shownContent: null,
    },
    intent: { type: 'comparison', confidence: 1, journeyStage: 'awareness' },
    timings: {},
    layoutHint: undefined,
    ...overrides,
  };
}

test('select-layout step — no-ops (ctx.layoutHint stays null) without TYPESAFE_API_KEY', async () => {
  const ctx = makeCtx();
  await selectLayout(ctx, {}, {});
  assert.equal(ctx.layoutHint, null);
  assert.equal(typeof ctx.timings.selectLayout, 'number');
});

test('select-layout step — sets ctx.layoutHint on confident Jev answer', async () => {
  const ctx = makeCtx();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    model: 'jev-1.13.0',
    answers: {
      decision: {
        type: 'choice', choice: 'comparison-table', probabilities: {}, confidence: 0.9,
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  try {
    await selectLayout(ctx, {}, { TYPESAFE_API_KEY: 'test-key' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(ctx.layoutHint.choice, 'comparison-table');
});

test('select-layout step — ignores low-confidence Jev answers (below threshold)', async () => {
  const ctx = makeCtx();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    model: 'jev-1.13.0',
    answers: {
      decision: {
        type: 'choice', choice: 'discovery-grid', probabilities: {}, confidence: 0.3,
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  try {
    await selectLayout(ctx, {}, { TYPESAFE_API_KEY: 'test-key' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(ctx.layoutHint, null);
});
