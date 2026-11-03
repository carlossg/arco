/* eslint-disable max-classes-per-file, default-param-last, import/prefer-default-export */
import assert from 'node:assert/strict';

const clone = (value) => structuredClone(value);

class Snapshot {
  constructor(ref, value) {
    this.id = ref.id;
    this.ref = ref;
    this.exists = value !== undefined;
    this.value = value;
  }

  data() { return clone(this.value); }
}

class Reference {
  constructor(db, collection, id) {
    this.db = db;
    this.collection = collection;
    this.id = id;
    this.path = `${collection}/${id}`;
  }

  async get() { return new Snapshot(this, this.db.rows.get(this.path)); }

  async set(value) {
    this.db.validate(value);
    this.db.rows.set(this.path, clone(value));
  }

  async update(changes) {
    assert(this.db.rows.has(this.path), 'Cannot update missing document');
    await this.set({ ...this.db.rows.get(this.path), ...changes });
  }

  async delete() { this.db.rows.delete(this.path); }
}

class Query {
  constructor(db, name, filters = [], ordering, maximum = Infinity, cursor) {
    Object.assign(this, {
      db, name, filters, ordering, maximum, cursor,
    });
  }

  doc(id) { return new Reference(this.db, this.name, id); }

  where(...filter) { return new Query(this.db, this.name, [...this.filters, filter], this.ordering, this.maximum, this.cursor); }

  orderBy(field, direction = 'asc') { return new Query(this.db, this.name, this.filters, [field, direction], this.maximum, this.cursor); }

  limit(maximum) { return new Query(this.db, this.name, this.filters, this.ordering, maximum, this.cursor); }

  startAfter(cursor) { return new Query(this.db, this.name, this.filters, this.ordering, this.maximum, cursor); }

  async get() {
    let rows = [...this.db.rows].filter(([path]) => path.startsWith(`${this.name}/`))
      .map(([path, value]) => ({ ref: this.doc(path.slice(this.name.length + 1)), value }));
    rows = rows.filter(({ value }) => this.filters.every(([field, op, wanted]) => {
      const actual = value[field];
      if (op === '==') return actual === wanted;
      if (op === '>') return actual > wanted;
      if (op === '>=') return actual >= wanted;
      if (op === '<') return actual < wanted;
      if (op === '<=') return actual <= wanted;
      throw new Error(`Unsupported mock operator ${op}`);
    }));
    if (this.ordering) {
      const [field, direction] = this.ordering;
      rows = rows.filter(({ value }) => value[field] !== undefined).sort((a, b) => {
        const x = a.value[field];
        const y = b.value[field];
        let comparison = 0;
        if (x < y) comparison = -1;
        if (x > y) comparison = 1;
        return comparison * (direction === 'desc' ? -1 : 1);
      });
      if (this.cursor !== undefined) rows = rows.filter(({ value }) => value[field] > this.cursor);
    }
    return { docs: rows.slice(0, this.maximum).map(({ ref, value }) => new Snapshot(ref, value)) };
  }
}

/** Enforces transaction read-before-write and rollback; serializes concurrent CAS. */
export class MockFirestore {
  constructor() {
    this.rows = new Map();
    this.tail = Promise.resolve();
    this.failWrites = false;
  }

  collection(name) { return new Query(this, name); }

  validate(value) {
    if (this.failWrites) throw new Error('Injected Firestore write failure');
    const visit = (v) => {
      assert(v !== undefined, 'Firestore rejects undefined fields');
      if (v && typeof v === 'object') Object.values(v).forEach(visit);
    };
    visit(value);
  }

  async runTransaction(callback) {
    const run = this.tail.then(async () => {
      const writes = [];
      const tx = {
        get: async (ref) => {
          assert.equal(writes.length, 0, 'Firestore transaction must read before writing');
          return ref.get();
        },
        set: (ref, row) => { this.validate(row); writes.push(['set', ref, row]); },
        create: (ref, row) => { this.validate(row); writes.push(['create', ref, row]); },
        update: (ref, row) => { this.validate(row); writes.push(['update', ref, row]); },
        delete: (ref) => writes.push(['delete', ref]),
      };
      const result = await callback(tx);
      const updated = new Map(this.rows);
      writes.forEach(([operation, ref, row]) => {
        if (operation === 'create') assert(!updated.has(ref.path), 'Document already exists');
        if (operation === 'update') assert(updated.has(ref.path), 'Cannot update missing document');
        if (operation === 'delete') updated.delete(ref.path);
        else updated.set(ref.path, clone(operation === 'update' ? { ...updated.get(ref.path), ...row } : row));
      });
      this.rows = updated;
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
