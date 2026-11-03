/* eslint-env node, es2022 */
/* eslint-disable no-restricted-syntax, no-await-in-loop */

import { vertexConfig } from './vertex.js';

export const DEFAULT_COLLECTION = 'arco_content_gcp';

export class FirestoreVectorIndex {
  constructor(config = {}) {
    Object.assign(this, vertexConfig(config));
    this.collectionName = config.collection
      || process.env.FIRESTORE_VECTOR_COLLECTION || DEFAULT_COLLECTION;
    if (this.collectionName.includes('/')) throw new Error('Vector collection must be a collection id, not a path.');
    this.db = config.firestore || config.client;
    this.vectorValue = config.vectorValue;
    this.embeddingSpace = `${this.model}:${this.dimensions}`;
  }

  async ready() {
    if (!this.initializing) {
      this.initializing = (async () => {
        if (!this.db || !this.vectorValue) {
          const { Firestore, FieldValue } = await import('@google-cloud/firestore');
          this.db ||= new Firestore({ projectId: this.projectId });
          this.vectorValue ||= (values) => FieldValue.vector(values);
        }
        return this.db.collection(this.collectionName);
      })();
    }
    return this.initializing;
  }

  validateVector(vector) {
    if (!Array.isArray(vector) || vector.length !== this.dimensions
      || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`Vector must contain ${this.dimensions} finite Vertex embedding values.`);
    }
  }

  async query(vector, {
    topK = 10, returnMetadata = 'none', returnValues = false, filter = {},
  } = {}) {
    this.validateVector(vector);
    if (!Number.isInteger(topK) || topK < 1 || topK > 1000) throw new Error('topK must be between 1 and 1000.');
    let query = (await this.ready()).where('embeddingSpace', '==', this.embeddingSpace);
    for (const [key, condition] of Object.entries(filter)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) throw new Error(`Invalid metadata filter: ${key}`);
      const operators = condition && typeof condition === 'object' ? Object.entries(condition) : [['$eq', condition]];
      for (const [operator, value] of operators) {
        const op = {
          $eq: '==',
          $ne: '!=',
          $in: 'in',
          $nin: 'not-in',
          $gt: '>',
          $gte: '>=',
          $lt: '<',
          $lte: '<=',
        }[operator];
        if (!op) throw new Error(`Unsupported metadata filter operator: ${operator}`);
        query = query.where(`metadata.${key}`, op, value);
      }
    }
    const snapshot = await query.findNearest({
      vectorField: 'embedding',
      queryVector: this.vectorValue(vector),
      limit: topK,
      distanceMeasure: 'COSINE',
      distanceResultField: 'vectorDistance',
    }).get();
    return {
      count: snapshot.docs.length,
      matches: snapshot.docs.map((doc) => {
        const data = doc.data();
        const result = { id: doc.id, score: 1 - data.vectorDistance };
        if (returnMetadata === 'all' || returnMetadata === true) result.metadata = data.metadata || {};
        if (returnValues) result.values = data.embedding?.toArray?.() || data.embedding;
        return result;
      }),
    };
  }

  async getByIds(ids) {
    if (!Array.isArray(ids) || ids.length > 1000) throw new Error('getByIds accepts at most 1000 ids.');
    if (ids.some((id) => typeof id !== 'string' || !id || id.includes('/'))) {
      throw new Error('getByIds requires nonempty document ids without slashes.');
    }
    if (!ids.length) return [];
    const collection = await this.ready();
    const docs = await this.db.getAll(...ids.map((id) => collection.doc(id)));
    return docs.filter((doc) => (
      doc.exists && doc.data().embeddingSpace === this.embeddingSpace
    )).map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        values: data.embedding?.toArray?.() || data.embedding,
        metadata: data.metadata || {},
      };
    });
  }

  async describe() {
    const collection = await this.ready();
    const snapshot = await collection.where('embeddingSpace', '==', this.embeddingSpace).count().get();
    return {
      name: this.collectionName,
      dimensions: this.dimensions,
      metric: 'cosine',
      vectorCount: snapshot.data().count,
      embeddingModel: this.model,
      embeddingSpace: this.embeddingSpace,
    };
  }

  async upsert(vectors) {
    const collection = await this.ready();
    // Firestore commits are limited to 500 operations. Smaller batches also
    // leave headroom below its 10 MiB request limit for rich content metadata.
    for (let offset = 0; offset < vectors.length; offset += 100) {
      const batch = this.db.batch();
      vectors.slice(offset, offset + 100).forEach(({ id, values, metadata = {} }) => {
        this.validateVector(values);
        if (!id || id.includes('/')) throw new Error(`Invalid vector id: ${id}`);
        batch.set(collection.doc(id), {
          embedding: this.vectorValue(values),
          embeddingSpace: this.embeddingSpace,
          metadata,
        });
      });
      await batch.commit();
    }
    return { count: vectors.length };
  }
}

export function createVectorIndex(config = {}) {
  return new FirestoreVectorIndex(config);
}
