import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import {
  blockCloudflareRequests,
  createGoogleServer,
  ExecutionContext,
  googleTokenVerifier,
} from '../src/http.js';

test('Google runtime blocks Cloudflare, including subdomains, before making a request', async () => {
  const calls = [];
  const fetch = blockCloudflareRequests(async (url) => { calls.push(url); return new Response('ok'); });
  ['https://api.cloudflare.com/test', 'https://arco.example.workers.dev/'].forEach((url) => {
    assert.throws(() => fetch(url), /Cloudflare requests are disabled/);
  });
  assert.equal((await fetch('https://example.run.app/')).status, 200);
  assert.equal(calls.length, 1);
});

test('background lifecycle awaits work registered by other background work', async () => {
  const ctx = new ExecutionContext();
  let completed = false;
  ctx.waitUntil(Promise.resolve().then(() => {
    ctx.waitUntil(Promise.resolve().then(() => { completed = true; }));
  }));
  await ctx.drain();
  assert.equal(completed, true);
});

test('internal routes require the configured service account, not just any Google token', async () => {
  const verify = googleTokenVerifier({
    serviceUrl: 'https://demo.run.app',
    serviceAccount: 'demo@example.iam.gserviceaccount.com',
    client: {
      async verifyIdToken({ audience }) {
        assert.equal(audience, 'https://demo.run.app');
        return { getPayload: () => ({ email_verified: true, email: 'someone-else@gmail.com' }) };
      },
    },
  });
  assert.equal(await verify(new Request('https://demo.run.app/internal/tasks/eval')), false);
  assert.equal(await verify(new Request('https://demo.run.app/internal/tasks/eval', {
    headers: { authorization: 'Bearer arbitrary' },
  })), false);
});

test('server streams NDJSON and rejects unauthenticated task invocations', async (t) => {
  let delivered = false;
  const server = createGoogleServer({
    env: {},
    handler: async () => new Response('{"type":"done"}\n', {
      headers: { 'Content-Type': 'application/x-ndjson' },
    }),
    verifyInternal: async () => false,
    deliverTask: async () => { delivered = true; },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stream = await fetch(`${origin}/api/generate`, { method: 'POST', body: '{}' });
  assert.equal(stream.headers.get('Content-Type'), 'application/x-ndjson');
  assert.equal(await stream.text(), '{"type":"done"}\n');
  assert.equal((await fetch(`${origin}/internal/tasks/eval`, { method: 'POST' })).status, 401);
  assert.equal(delivered, false);
});
