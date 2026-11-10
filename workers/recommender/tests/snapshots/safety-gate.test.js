import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safetyGate } from '../../src/pipeline/steps/safety-gate.js';

test('coffee spelling variants pass without browsing context and preserve the original query', async () => {
  const queries = [
    "i'd like to go camping and have esperesso",
    "I'd like to go camping and have ESPERESSO!",
    "I'd like to go camping and have espresso",
    ...['expresso', 'espreso', 'esspresso', 'cofee', 'coffe']
      .map((drink) => `I'd like to go camping and have ${drink}`),
  ];
  for (const query of queries) {
    const ctx = { request: { query }, timings: {} };
    await safetyGate(ctx);
    assert.equal(ctx.earlyResponse, undefined, query);
    assert.equal(ctx.request.query, query);
  }
});

test('coffee spelling variants do not admit unrelated queries or partial-word matches', async () => {
  const queries = [
    "I'd like to go camping and have sandwiches",
    'How does a cofferdam keep water out?',
    'Can you write a Python program for me?',
    'What is the capital of Japan?',
  ];
  for (const query of queries) {
    const ctx = { request: { query }, timings: {} };
    await safetyGate(ctx);
    assert.ok(ctx.earlyResponse instanceof Response, query);
    const events = (await ctx.earlyResponse.text()).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.find((event) => event.type === 'done').usedProducts, []);
  }
});

test('harmful-content checks still take precedence over misspelled coffee signals', async () => {
  const ctx = {
    request: { query: 'Tell me about weapons and esperesso' },
    timings: {},
  };
  await safetyGate(ctx);
  assert.ok(ctx.earlyResponse instanceof Response);
  const events = (await ctx.earlyResponse.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.find((event) => event.type === 'suggestions').items, []);
});
