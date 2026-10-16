import { randomUUID } from 'node:crypto';

/** Durable native analytics. Call flush() when draining each request lifecycle. */
export class FirestoreAnalytics {
  constructor({ firestore, maxDocuments = 5000 }) {
    this.firestore = firestore;
    this.maxDocuments = maxDocuments;
    this.pending = new Set();
    this.errors = [];
  }

  writeDataPoint({ blobs = [], doubles = [] } = {}) {
    const row = { created_at: Date.now() };
    for (let i = 0; i < 4; i += 1) {
      row[`blob${i + 1}`] = String(blobs[i] ?? '');
      row[`double${i + 1}`] = Number(doubles[i] ?? 0);
      if (!Number.isFinite(row[`double${i + 1}`])) throw new TypeError('Analytics doubles must be finite');
    }
    const write = this.firestore.collection('arco_analytics_gcp').doc(randomUUID()).set(row);
    const tracked = write.catch((error) => {
      this.errors.push(error);
      console.error(JSON.stringify({ severity: 'ERROR', component: 'analytics', message: error.message }));
    }).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }

  async flush() {
    while (this.pending.size) await Promise.all([...this.pending]);
    const errors = this.errors.splice(0);
    if (errors.length) throw new AggregateError(errors, 'Analytics persistence failed');
  }

  async queryStats(hoursBack = 24) {
    if (!Number.isFinite(hoursBack) || hoursBack <= 0) throw new TypeError('hoursBack must be positive');
    await this.flush();
    const snapshot = await this.firestore.collection('arco_analytics_gcp')
      .where('created_at', '>', Date.now() - Math.round(hoursBack) * 3600000)
      .limit(this.maxDocuments + 1).get();
    if (snapshot.docs.length > this.maxDocuments) {
      throw new RangeError(`Analytics exceeds bounded ${this.maxDocuments}-document scan`);
    }
    const summary = {};
    const intents = {};
    const paths = {};
    const groups = new Set();
    snapshot.docs.forEach((doc) => {
      const row = doc.data();
      if (!row.blob1) return;
      summary[row.blob1] = (summary[row.blob1] || 0) + 1;
      if (row.blob1 === 'generation' && row.blob3) intents[row.blob3] = (intents[row.blob3] || 0) + 1;
      if (row.blob1 === 'page_view' && row.blob4) paths[row.blob4] = (paths[row.blob4] || 0) + 1;
      groups.add(JSON.stringify([row.blob1, row.blob2, row.blob3, row.blob4]));
    });
    const top = (counts, key) => Object.entries(counts).sort((a, b) => b[1] - a[1])
      .slice(0, 10).map(([value, count]) => ({ [key]: value, count }));
    return {
      summary,
      timeSeries: [],
      topIntents: top(intents, 'intent'),
      topPaths: top(paths, 'path'),
      hoursBack,
      rowsProcessed: groups.size,
    };
  }
}

export function createAnalytics(config) { return new FirestoreAnalytics(config); }

export async function queryStats(env, hoursBack = 24) {
  return env.ANALYTICS ? env.ANALYTICS.queryStats(hoursBack) : null;
}
