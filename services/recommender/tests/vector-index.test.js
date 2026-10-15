/* eslint-env node, es2022 */
/* eslint-disable max-len, no-restricted-syntax */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createVectorIndex } from '../src/vector-index.js';
import { extractContent, indexContent, parseArgs } from '../tools/index-content.js';

function firestoreStub() {
  const documents = new Map();
  const calls = { where: [], nearest: [], writes: [] };
  const snapshot = (id, data) => ({ id, exists: Boolean(data), data: () => data });
  const collection = {
    doc: (id) => ({ id }),
    where(...args) { calls.where.push(args); return this; },
    findNearest(args) {
      calls.nearest.push(args);
      return { get: async () => ({ docs: [...documents].map(([id, data]) => snapshot(id, { ...data, vectorDistance: 0.2 })) }) };
    },
    count: () => ({ get: async () => ({ data: () => ({ count: documents.size }) }) }),
  };
  const db = {
    collection: (name) => { calls.collection = name; return collection; },
    getAll: async (...refs) => refs.map((ref) => snapshot(ref.id, documents.get(ref.id))),
    batch: () => ({
      set: (ref, data) => {
        calls.writes.push(ref.id);
        documents.set(ref.id, data);
      },
      commit: async () => {},
    }),
  };
  return { db, calls, documents };
}

test('Firestore native vector adapter preserves query scores, metadata, filters and provenance', async () => {
  const stub = firestoreStub();
  const index = createVectorIndex({ firestore: stub.db, dimensions: 3, vectorValue: (values) => ({ toArray: () => values }) });
  await index.upsert([{ id: 'espresso', values: [1, 2, 3], metadata: { type: 'guide', slug: 'espresso', title: 'Espresso' } }]);
  const result = await index.query([1, 2, 3], {
    topK: 20, returnMetadata: 'all', returnValues: true, filter: { type: { $eq: 'guide' } },
  });
  assert.equal(stub.calls.collection, 'arco_content_gcp');
  assert.deepEqual(stub.calls.where, [['embeddingSpace', '==', 'text-embedding-005:3'], ['metadata.type', '==', 'guide']]);
  assert.equal(stub.calls.nearest[0].distanceMeasure, 'COSINE');
  assert.equal(stub.calls.nearest[0].vectorField, 'embedding');
  assert.equal(result.matches[0].score, 0.8);
  assert.equal(result.matches[0].metadata.slug, 'espresso');
  assert.deepEqual(result.matches[0].values, [1, 2, 3]);
  assert.deepEqual(await index.getByIds(['espresso', 'missing']), [{ id: 'espresso', values: [1, 2, 3], metadata: { type: 'guide', slug: 'espresso', title: 'Espresso' } }]);
  assert.equal((await index.describe()).vectorCount, 1);
  assert.equal((await index.query([1, 2, 3])).matches[0].metadata, undefined);
});

test('Firestore refuses invalid dimensions and IDs and does not return foreign embedding spaces', async () => {
  const stub = firestoreStub();
  const index = createVectorIndex({ firestore: stub.db, dimensions: 2, vectorValue: (values) => values });
  stub.documents.set('old', { embeddingSpace: 'cloudflare:2', embedding: [1, 2] });
  assert.deepEqual(await index.getByIds(['old']), []);
  await assert.rejects(index.query([1]), /2 finite/);
  await assert.rejects(index.query([1, 2], { topK: 0 }), /topK/);
  await assert.rejects(index.query([1, 2], { filter: { type: { $unknown: 2 } } }), /Unsupported/);
  await assert.rejects(index.upsert([{ id: 'bad/path', values: [1, 2] }]), /Invalid vector id/);
});

test('repository extraction covers every content domain with stable unique ids and no truncation', async () => {
  const chunks = await extractContent();
  const types = new Set(chunks.map((chunk) => chunk.metadata.type));
  for (const type of ['guide', 'experience', 'product', 'comparison', 'recipe', 'faq', 'feature', 'review', 'hero-image', 'maintenance', 'diagnostic', 'calculator', 'pairing']) {
    assert.ok(types.has(type), `missing ${type}`);
  }
  assert.ok(chunks.length > 500);
  assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, chunks.length);
  const second = await extractContent();
  assert.deepEqual(chunks.map((chunk) => chunk.id), second.map((chunk) => chunk.id));
  assert.ok(chunks.filter((chunk) => chunk.metadata.source === 'products/products.json').some((chunk) => chunk.text.includes('58mm commercial')));
  assert.ok(chunks.some((chunk) => chunk.metadata.contentType === 'story'));
  assert.ok(chunks.every((chunk) => chunk.text.length <= 3161));
  const heroes = await extractContent({ heroesOnly: true });
  assert.ok(heroes.every((chunk) => chunk.metadata.type === 'hero-image' && chunk.metadata.url && chunk.metadata.id));
});

test('indexer uses document task type, retries writes, reports failure and validates options', async () => {
  let writes = 0;
  const chunks = [{ id: 'stable', text: 'full text', metadata: { source: 'test.json', type: 'guide' } }];
  const ai = {
    embed: async (texts, options) => {
      assert.equal(options.taskType, 'RETRIEVAL_DOCUMENT');
      assert.deepEqual(texts, ['full text']);
      return { data: [[1, 2]] };
    },
  };
  await indexContent({
    chunks,
    ai,
    index: {
      upsert: async (vectors) => {
        writes += 1;
        if (writes === 1) throw Object.assign(new Error('busy'), { code: 14 });
        assert.equal(vectors[0].id, 'stable');
        assert.deepEqual(vectors[0].values, [1, 2]);
      },
    },
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(writes, 2);
  await assert.rejects(indexContent({ chunks, ai: { embed: async () => { throw new Error('permission denied'); } }, index: {} }), /batch 1 \(test.json\).*permission denied/);
  assert.deepEqual(parseArgs(['--project', 'demo', '--dimensions', '768', '--dry-run']), { projectId: 'demo', dimensions: 768, 'dry-run': true });
  assert.throws(() => parseArgs(['--prune', '--limit', '1']), /cannot/);
  assert.throws(() => parseArgs(['--dimensions', 'NaN']), /positive integer/);
});
