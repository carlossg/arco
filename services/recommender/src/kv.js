import { createHash, randomUUID } from 'node:crypto';

const INLINE_LIMIT = 800 * 1024;
const secondsNow = () => Math.floor(Date.now() / 1000);

/**
 * Firestore KV; bucket is an optional @google-cloud/storage Bucket instance.
 * Configure Firestore TTL on expires_at and daysSinceCustomTime: 1 for kv/.
 * Only expiring objects get customTime, set to their KV expiration. Never use
 * an age-based bucket lifecycle: non-expiring values must remain readable.
 * Retired non-expiring objects require explicit cleanup, not automatic expiry.
 */
export class FirestoreKV {
  constructor({
    firestore, bucket, inlineLimit = INLINE_LIMIT, maxDocuments = 5000,
  }, namespace) {
    if (!firestore || !namespace) throw new TypeError('firestore and namespace are required');
    this.firestore = firestore;
    this.bucket = bucket;
    this.namespace = namespace;
    this.inlineLimit = inlineLimit;
    this.maxDocuments = maxDocuments;
    this.collection = firestore.collection('arco_kv_gcp');
  }

  reference(key) {
    if (typeof key !== 'string' || !key.length) {
      throw new TypeError('KV key must be a nonempty string');
    }
    return this.collection.doc(createHash('sha256')
      .update(JSON.stringify([this.namespace, key])).digest('hex'));
  }

  async getWithMetadata(key, options = 'text') {
    const type = typeof options === 'string' ? options : options?.type || 'text';
    if (!['text', 'json', 'arrayBuffer'].includes(type)) {
      throw new TypeError(`Unsupported KV type: ${type}`);
    }
    const snapshot = await this.reference(key).get();
    const row = snapshot.exists ? snapshot.data() : null;
    if (!row || (row.expiration != null && row.expiration <= secondsNow())) {
      return { value: null, metadata: null };
    }
    let bytes;
    if (row.object) {
      if (!this.bucket) throw new Error('KV value requires its configured GCS bucket');
      [bytes] = await this.bucket.file(row.object).download();
    } else bytes = Buffer.from(row.value, 'utf8');
    let value;
    if (type === 'arrayBuffer') {
      value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } else if (type === 'json') value = JSON.parse(bytes.toString('utf8'));
    else value = bytes.toString('utf8');
    return { value, metadata: row.metadata ?? null };
  }

  async get(key, options = 'text') {
    return (await this.getWithMetadata(key, options)).value;
  }

  async put(key, value, options = {}) {
    const ref = this.reference(key);
    if (typeof value !== 'string') throw new TypeError('KV put requires a string');
    const now = secondsNow();
    let expiration = options.expiration ?? null;
    if (options.expirationTtl !== undefined) {
      if (!Number.isFinite(options.expirationTtl) || options.expirationTtl <= 0) {
        throw new TypeError('expirationTtl must be positive seconds');
      }
      expiration = now + Math.ceil(options.expirationTtl);
    }
    if (expiration !== null && (!Number.isSafeInteger(expiration) || expiration <= 0)) {
      throw new TypeError('expiration must be Unix seconds');
    }
    const row = {
      namespace: this.namespace,
      key,
      expiration,
      expires_at: expiration === null ? null : new Date(expiration * 1000),
      metadata: options.metadata ?? null,
    };
    const overhead = Buffer.byteLength(JSON.stringify(row));
    if (overhead > this.inlineLimit) {
      throw new RangeError('KV key/metadata exceeds the Firestore inline limit');
    }
    let object;
    if (Buffer.byteLength(value) + overhead > this.inlineLimit) {
      if (!this.bucket) {
        throw new RangeError(
          `KV payload exceeds ${this.inlineLimit} bytes; configure a GCS bucket for large values`,
        );
      }
      object = `kv/${ref.id}/${randomUUID()}`;
      await this.bucket.file(object).save(value, {
        resumable: false,
        contentType: 'text/plain; charset=utf-8',
        ...(expiration === null ? {} : {
          metadata: { customTime: new Date(expiration * 1000).toISOString() },
        }),
      });
      row.object = object;
    } else row.value = value;
    try {
      await ref.set(row);
    } catch (error) {
      if (object) await this.bucket.file(object).delete({ ignoreNotFound: true }).catch(() => {});
      throw error;
    }
  }

  async delete(key) { await this.reference(key).delete(); }

  async list({ prefix = '', limit = 1000, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('KV list limit must be 1..1000');
    }
    let after;
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (decoded.namespace !== this.namespace || decoded.prefix !== prefix
        || typeof decoded.key !== 'string') {
        throw new Error('Invalid KV list cursor');
      }
      after = decoded.key;
    }
    // Demo-sized namespaces are sorted locally, avoiding a required composite
    // Firestore index just for KV enumeration.
    const snapshot = await this.collection.where('namespace', '==', this.namespace)
      .limit(this.maxDocuments + 1).get();
    if (snapshot.docs.length > this.maxDocuments) {
      throw new RangeError('KV namespace exceeds bounded list scan');
    }
    const rows = snapshot.docs.map((doc) => doc.data())
      .filter((row) => row.key.startsWith(prefix) && (after === undefined || row.key > after))
      .sort((a, b) => {
        if (a.key === b.key) return 0;
        return a.key < b.key ? -1 : 1;
      });
    const scanned = rows.slice(0, limit);
    const more = rows.length > limit;
    return {
      keys: scanned.filter((row) => row.expiration == null || row.expiration > secondsNow())
        .map((row) => ({
          name: row.key,
          ...(row.expiration == null ? {} : { expiration: row.expiration }),
          ...(row.metadata == null ? {} : { metadata: row.metadata }),
        })),
      list_complete: !more,
      cursor: more ? Buffer.from(JSON.stringify({
        namespace: this.namespace, prefix, key: scanned.at(-1).key,
      })).toString('base64url') : '',
    };
  }
}

export function createKV(config, namespace) { return new FirestoreKV(config, namespace); }
