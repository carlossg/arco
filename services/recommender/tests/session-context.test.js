import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionContextManager as manager } from '../../../scripts/session-context.js';

function reset(t) {
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
  t.after(() => Object.defineProperty(globalThis, 'sessionStorage', descriptor));
  manager.clear();
}

test('external URI JSON, UTF-8 base64 and base64url hydrate only allowed profile and product context', (t) => {
  reset(t);
  const incoming = {
    inferredProfile: { interests: ['café'], journeyStage: 'comparing', admin: true },
    shownProducts: ['primo', 'doppio'],
    sessionId: 'untrusted',
  };
  const json = JSON.stringify(incoming);
  for (const encoded of [json, encodeURIComponent(json), Buffer.from(json).toString('base64'), Buffer.from(json).toString('base64url')]) {
    manager.clear();
    manager.updateInferredProfile({ productsViewed: ['nano'] });
    const id = manager.getSessionId();
    const params = new URLSearchParams({ ctx: encoded, persona: 'upgrade-seeker', utm_source: 'gemini' });
    const report = manager.hydrateFromUrl(params);
    assert.deepEqual(report.errors, []);
    assert.equal(manager.getSessionId(), id);
    assert.deepEqual(manager.buildContextParam().quizPersona, { persona: 'upgrade-seeker' });
    assert.deepEqual(manager.buildContextParam().inferredProfile, { productsViewed: ['nano'], interests: ['café'], journeyStage: 'comparing' });
    assert.deepEqual(manager.getShownContent().shownProducts, ['primo', 'doppio']);
    assert.equal(params.get('utm_source'), 'gemini');
  }
});

test('malformed, oversized and invalid context is reported without clearing or partially overwriting existing context', (t) => {
  reset(t);
  manager.addShownProduct('nano');
  manager.updateInferredProfile({ interests: ['espresso'] });
  manager.setQuizPersona('upgrader');
  for (const ctx of ['invalid!', 'a'.repeat(16001), '{"inferredProfile":[]}', '{"shownProducts":[12]}', '{"shownProducts":["primo"],"inferredProfile":{"interests":"bad"}}', '{"shownProducts":["primo"],"conversationContext":{"preferences":{"budgetUsd":"invalid"}}}']) {
    const report = manager.hydrateFromUrl(new URLSearchParams({ ctx, persona: 'invented' }));
    assert.ok(report.errors.length);
    assert.deepEqual(report.applied, {});
    assert.deepEqual(manager.getShownContent().shownProducts, ['nano']);
    assert.deepEqual(manager.buildContextParam().inferredProfile, { interests: ['espresso'] });
    assert.equal(manager.getQuizPersona(), 'upgrader');
  }
  assert.equal(manager.hydrateFromUrl(new URLSearchParams()), null);
});

test('failed or expired handoffs are reported without falling back to inline URL context', async (t) => {
  reset(t);
  const params = new URLSearchParams({
    contextId: '5da98b6f-6fc9-413b-9d0c-25ee06818e41',
    ctx: JSON.stringify({ shownProducts: ['primo'] }),
  });
  for (const response of [
    new Response(null, { status: 410 }),
    new Response(null, { status: 503 }),
    Response.json({ context: { conversationContext: { summary: 'expired summary' } }, expiresAt: '2020-01-01T00:00:00Z' }),
    Response.json({ context: { conversationContext: { summary: 'invalid expiry' } }, expiresAt: 'invalid' }),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    const report = await manager.hydrateExternalContext(params, 'https://demo.run.app');
    assert.ok(report.errors.length);
    assert.deepEqual(report.applied, {});
    assert.equal(manager.buildContextParam().conversationContext, undefined);
    assert.deepEqual(manager.getShownContent().shownProducts, []);
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network unavailable'); });
  const report = await manager.hydrateExternalContext(params, 'https://demo.run.app');
  assert.match(report.errors[0], /Network unavailable/);
});
