import assert from 'node:assert/strict';
import test from 'node:test';
import { createKV } from '../src/kv.js';
import { MockFirestore } from './mock-firestore.js';

test('KV namespaces, strings, JSON, metadata, arrayBuffer, overwrite and delete', async () => {
  const firestore = new MockFirestore();
  const first = createKV({ firestore }, 'cache');
  const second = createKV({ firestore }, 'sessions');
  await first.put('key/a', '{"x":"café"}', { metadata: { source: 'test' } });
  await second.put('key/a', 'different');
  assert.deepEqual(await first.get('key/a', 'json'), { x: 'café' });
  assert.equal(await second.get('key/a'), 'different');
  assert.equal(new TextDecoder().decode(await first.get('key/a', { type: 'arrayBuffer' })), '{"x":"café"}');
  assert.deepEqual((await first.getWithMetadata('key/a')).metadata, { source: 'test' });
  await first.put('key/a', 'new');
  assert.equal(await first.get('key/a'), 'new');
  assert.equal((await first.getWithMetadata('key/a')).metadata, null);
  await first.delete('key/a');
  assert.equal(await first.get('key/a'), null);
  assert.equal(await second.get('key/a'), 'different');
});

test('KV TTL reads and paginated prefix list exclude expired entries', async () => {
  const kv = createKV({ firestore: new MockFirestore() }, 'cache');
  await kv.put('p/a', 'expired', { expiration: Math.floor(Date.now() / 1000) - 1 });
  await kv.put('p/b', 'live', { expirationTtl: 120, metadata: { n: 1 } });
  await kv.put('p/c', 'live');
  await kv.put('other', 'no');
  assert.equal(await kv.get('p/a'), null);
  const first = await kv.list({ prefix: 'p/', limit: 1 });
  assert.equal(first.list_complete, false);
  assert.equal(first.keys.length, 0);
  const second = await kv.list({ prefix: 'p/', limit: 1, cursor: first.cursor });
  assert.equal(second.keys[0].name, 'p/b');
  assert.deepEqual(second.keys[0].metadata, { n: 1 });
  const last = await kv.list({ prefix: 'p/', limit: 1, cursor: second.cursor });
  assert.deepEqual(last.keys, [{ name: 'p/c' }]);
  assert.equal(last.list_complete, true);
  await assert.rejects(kv.list({ prefix: 'wrong', cursor: first.cursor }), /Invalid KV list cursor/);
});

test('KV explicit size failure, optional GCS spill and write failure cleanup', async () => {
  const firestore = new MockFirestore();
  const kv = createKV({ firestore, inlineLimit: 400 }, 'sessions');
  await assert.rejects(kv.put('large', 'x'.repeat(1000)), /configure a GCS bucket/);
  const objects = new Map();
  const bucket = {
    file: (name) => ({
      save: async (value) => objects.set(name, Buffer.from(value)),
      download: async () => [objects.get(name)],
      delete: async () => objects.delete(name),
    }),
  };
  const spill = createKV({ firestore, bucket, inlineLimit: 400 }, 'sessions');
  await spill.put('large', 'y'.repeat(1000));
  assert.equal(await spill.get('large'), 'y'.repeat(1000));
  assert.equal(objects.size, 1);
  firestore.failWrites = true;
  await assert.rejects(spill.put('failed', 'z'.repeat(1000)), /Injected Firestore/);
  assert.equal(objects.size, 1);
});

test('KV rejects invalid data instead of silently coercing it', async () => {
  const kv = createKV({ firestore: new MockFirestore() }, 'cache');
  await assert.rejects(kv.put('a', {}), /requires a string/);
  await assert.rejects(kv.put('a', 'text', { expirationTtl: -1 }), /positive seconds/);
  await assert.rejects(kv.get('a', 'stream'), /Unsupported KV type/);
});

test('GCS spill lifecycle uses KV expiration customTime only for expiring values', async () => {
  const firestore = new MockFirestore();
  const saves = [];
  const bucket = {
    file: (name) => ({
      save: async (value, options) => saves.push({ name, value, options }),
    }),
  };
  const kv = createKV({ firestore, bucket, inlineLimit: 400 }, 'sessions');
  const expiration = Math.floor(Date.now() / 1000) + 600;
  await kv.put('permanent', 'x'.repeat(1000));
  await kv.put('expires', 'y'.repeat(1000), { expiration });
  await kv.put('ttl', 'z'.repeat(1000), { expirationTtl: 120 });
  assert.equal(Object.hasOwn(saves[0].options, 'metadata'), false);
  assert.deepEqual(saves[1].options.metadata, {
    customTime: new Date(expiration * 1000).toISOString(),
  });
  const ttlRow = (await kv.reference('ttl').get()).data();
  assert.deepEqual(saves[2].options.metadata, {
    customTime: new Date(ttlRow.expiration * 1000).toISOString(),
  });
});
