#!/usr/bin/env node
/* eslint-env node, es2022 */
/* eslint-disable no-restricted-syntax, no-await-in-loop, no-continue, no-console, max-len */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import {
  dirname, join, relative, resolve,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAI } from '../src/vertex.js';
import { createVectorIndex } from '../src/vector-index.js';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data');
const DIRECTORIES = ['products', 'accessories', 'blog', 'guides', 'recipes', 'experiences', 'bundles', 'tools', 'metadata'];
const SINGLE_FILES = ['stories-index.json', 'experiences-index.json', 'hero-image-catalog.json'];

async function jsonFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
    const full = join(path, entry.name);
    if (entry.isDirectory()) return jsonFiles(full);
    return entry.isFile() && entry.name.endsWith('.json') ? [full] : [];
  }));
  return nested.flat();
}

function flatten(value, prefix = '') {
  if (value == null) return [];
  if (typeof value !== 'object') return [`${prefix}: ${String(value)}`];
  if (Array.isArray(value)) return value.flatMap((item) => flatten(item, prefix));
  return Object.entries(value).flatMap(([key, item]) => flatten(item, prefix ? `${prefix} ${key}` : key));
}

function contentType(source, item) {
  if (source === 'hero-image-catalog.json') return 'hero-image';
  if (source.startsWith('products/comparison/')) return 'comparison';
  if (source.startsWith('products/') || source.startsWith('accessories/')) return 'product';
  if (source.startsWith('recipes/')) return 'recipe';
  if (source.startsWith('experiences/') || source === 'experiences-index.json') return 'experience';
  if (source === 'metadata/faqs.json') return 'faq';
  if (source === 'metadata/features.json') return 'feature';
  if (source === 'metadata/reviews.json') return 'review';
  if (source.startsWith('tools/')) {
    if (item.formula || /calculat/.test(source)) return 'calculator';
    if (item.data?.symptoms || /diagnos/.test(source)) return 'diagnostic';
    if (item.data?.pairings || item.data?.edges || /pairing/.test(source)) return 'pairing';
    return 'maintenance';
  }
  // The current retrieval contract consumes editorial stories as guides.
  return 'guide';
}

function splitText(text, maxChars) {
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    const boundary = Math.max(rest.lastIndexOf('\n', maxChars), rest.lastIndexOf(' ', maxChars));
    const end = boundary > maxChars / 2 ? boundary : maxChars;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function extractContent({ contentRoot = DEFAULT_ROOT, maxChars = 3000, heroesOnly = false } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 128 || maxChars > 6000) {
    throw new Error('maxChars must be between 128 and 6000.');
  }
  const files = [];
  for (const dir of DIRECTORIES) {
    try {
      files.push(...await jsonFiles(join(contentRoot, dir)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const file of SINGLE_FILES) {
    try {
      await readFile(join(contentRoot, file), 'utf8');
      files.push(join(contentRoot, file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const unpublished = new Set();
  for (const name of ['stories-index.json', 'experiences-index.json']) {
    const path = join(contentRoot, name);
    if (!files.includes(path)) continue;
    const index = JSON.parse(await readFile(path, 'utf8'));
    (index.data || []).filter((item) => item.published === false).forEach((item) => {
      unpublished.add(item.slug || item.id);
    });
  }
  const chunks = [];
  for (const file of files) {
    const source = relative(contentRoot, file).split('\\').join('/');
    if (heroesOnly && source !== 'hero-image-catalog.json') continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid content JSON in ${source}: ${error.message}`);
    }
    let items = [parsed];
    if (Array.isArray(parsed)) items = parsed;
    else if (source === 'hero-image-catalog.json' && Array.isArray(parsed.images)) {
      items = parsed.images;
    } else if (Array.isArray(parsed.data)) items = parsed.data;
    items.forEach((item, itemIndex) => {
      if (!item || typeof item !== 'object') return;
      const slug = String(item.slug || item.id || `${source.replace(/\.json$/, '')}-${itemIndex}`);
      if (item.published === false || unpublished.has(slug)) return;
      const type = contentType(source, item);
      const title = String(item.title || item.name || item.question || item.alt || slug);
      const tags = item.persona_tags || item.bestFor || [];
      const metadata = {
        slug,
        title,
        type,
        category: String(item.category || source.split('/')[0]),
        difficulty: String(item.difficulty || ''),
        personaTags: Array.isArray(tags) ? tags.join(',') : String(tags),
        source,
        contentType: source.startsWith('blog/') || source === 'stories-index.json' ? 'story' : type,
      };
      if (item.url) metadata.url = item.url;
      if (type === 'product') metadata.productId = item.id || slug;
      if (type === 'hero-image') {
        Object.assign(metadata, { id: item.id || slug, url: item.url || '', alt: item.alt || '' });
      }
      const text = type === 'hero-image'
        ? item.embeddingText || flatten(item).join('\n')
        : flatten(item).join('\n');
      splitText(text, maxChars).forEach((part, chunkIndex) => {
        const id = createHash('sha256').update(`${source}\0${slug}\0${chunkIndex}`).digest('hex').slice(0, 40);
        chunks.push({
          id,
          text: `${title.slice(0, 160)}\n${part}`,
          metadata: { ...metadata, sectionHeading: `Part ${chunkIndex + 1}`, chunkIndex },
        });
      });
    });
  }
  return chunks;
}

async function retryWrite(write, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= 4 || ![4, 8, 10, 13, 14, 429, 500, 502, 503, 504].includes(Number(error.code || error.status))) {
        throw error;
      }
      await sleep(500 * (2 ** attempt));
    }
  }
}

export async function indexContent({
  ai, index, chunks, batchSize = 5, log = console.log,
  sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }),
}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('batchSize must be between 1 and 100.');
  const start = Date.now();
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);
    try {
      const { data } = await ai.embed(batch.map((chunk) => chunk.text), { taskType: 'RETRIEVAL_DOCUMENT' });
      if (data.length !== batch.length) throw new Error('Embedding batch size mismatch.');
      await retryWrite(() => index.upsert(batch.map((chunk, i) => ({
        id: chunk.id,
        values: data[i],
        metadata: chunk.metadata,
      }))), sleep);
    } catch (error) {
      throw new Error(`Indexing batch ${Math.floor(offset / batchSize) + 1} (${batch[0].metadata.source}) failed: ${error.message}`);
    }
    log(`Indexed ${Math.min(offset + batchSize, chunks.length)}/${chunks.length} chunks (${Math.round((Date.now() - start) / 1000)}s)`);
  }
}

export function parseArgs(args) {
  const options = {};
  const values = {
    '--project': 'projectId',
    '--location': 'location',
    '--collection': 'collection',
    '--model': 'model',
    '--dimensions': 'dimensions',
    '--content-root': 'contentRoot',
    '--batch-size': 'batchSize',
    '--max-chars': 'maxChars',
    '--limit': 'limit',
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (['--dry-run', '--prune', '--heroes', '--help', '--all'].includes(arg)) {
      options[arg.slice(2)] = true;
    } else if (values[arg] && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[values[arg]] = args[i += 1];
    } else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  for (const key of ['dimensions', 'batchSize', 'maxChars', 'limit']) {
    if (options[key] != null) {
      options[key] = Number(options[key]);
      if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer.`);
    }
  }
  if (options.prune && (options.limit || options.heroes)) {
    throw new Error('--prune cannot be combined with --limit or --heroes.');
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: node services/recommender/tools/index-content.js [--project ID] [--location us-central1] [--collection arco_content_gcp] [--model text-embedding-005] [--dimensions 768] [--content-root data] [--batch-size 5] [--max-chars 3000] [--dry-run] [--limit N] [--heroes | --all] [--prune]');
    return;
  }
  let chunks = await extractContent({ ...options, heroesOnly: options.heroes });
  if (options.limit) chunks = chunks.slice(0, options.limit);
  const counts = {};
  chunks.forEach(({ metadata }) => { counts[metadata.type] = (counts[metadata.type] || 0) + 1; });
  console.log(`Extracted ${chunks.length} chunks: ${JSON.stringify(counts)}`);
  if (!chunks.length) throw new Error('No content found; check --content-root.');
  if (options['dry-run']) return;
  const { batchSize, ...vertexOptions } = options;
  const ai = createAI(vertexOptions);
  const index = createVectorIndex(options);
  console.log(`Target ${ai.projectId}/${index.collectionName}: ${ai.model}, ${ai.dimensions}d, ${ai.location}`);
  await indexContent({
    ai, index, chunks, batchSize: batchSize || 5,
  });
  if (options.prune) {
    const collection = await index.ready();
    const ids = new Set(chunks.map((chunk) => chunk.id));
    const old = await collection.where('embeddingSpace', '==', index.embeddingSpace).select().get();
    const stale = old.docs.filter((doc) => !ids.has(doc.id));
    for (let offset = 0; offset < stale.length; offset += 100) {
      await retryWrite(async () => {
        const batch = index.db.batch();
        stale.slice(offset, offset + 100).forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
      }, (ms) => new Promise((done) => { setTimeout(done, ms); }));
    }
    console.log(`Pruned ${stale.length} obsolete chunks.`);
  }
  console.log('Indexing complete.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
