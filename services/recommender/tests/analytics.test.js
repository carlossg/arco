import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalytics, queryStats } from '../src/analytics.js';
import { MockFirestore } from './mock-firestore.js';

test('Analytics persists all columns and returns the Worker dashboard schema', async () => {
  const firestore = new MockFirestore();
  const analytics = createAnalytics({ firestore });
  analytics.writeDataPoint({ blobs: ['generation', 'recommender', 'comparison', '/a'], doubles: [1, 20, 30, 40] });
  analytics.writeDataPoint({ blobs: ['generation', 'recommender', 'comparison', '/a'], doubles: [1, 50, 60, 70] });
  analytics.writeDataPoint({ blobs: ['page_view', 'homepage', '', '/'], doubles: [1] });
  await analytics.flush();
  const rows = [...firestore.rows.values()];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].double4, 40);
  assert.equal(typeof rows[0].created_at, 'number');
  assert.deepEqual(await queryStats({ ANALYTICS: analytics }, 24), {
    summary: { generation: 2, page_view: 1 },
    timeSeries: [],
    topIntents: [{ intent: 'comparison', count: 2 }],
    topPaths: [{ path: '/', count: 1 }],
    hoursBack: 24,
    rowsProcessed: 2,
  });
});

test('Analytics excludes old events and refuses misleading truncated totals', async () => {
  const firestore = new MockFirestore();
  const analytics = createAnalytics({ firestore, maxDocuments: 1 });
  await firestore.collection('arco_analytics_gcp').doc('old').set({ created_at: 1, blob1: 'old' });
  await analytics.writeDataPoint({ blobs: ['page_view', '', '', '/a'] });
  assert.equal((await analytics.queryStats()).summary.old, undefined);
  await analytics.writeDataPoint({ blobs: ['page_view', '', '', '/b'] });
  await assert.rejects(analytics.queryStats(), /exceeds bounded/);
});

test('Analytics failures are logged and flush surfaces them without unhandled rejection', async () => {
  const firestore = new MockFirestore();
  const analytics = createAnalytics({ firestore });
  firestore.failWrites = true;
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(JSON.parse(line));
  try {
    analytics.writeDataPoint({ blobs: ['page_view'] });
    await assert.rejects(analytics.flush(), /Analytics persistence failed/);
    assert.equal(errors[0].severity, 'ERROR');
    assert.equal(errors[0].component, 'analytics');
    await analytics.flush();
  } finally { console.error = original; }
});
