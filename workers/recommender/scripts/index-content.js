#!/usr/bin/env node

/**
 * Vectorize Content Indexer
 *
 * Reads content JSON files (blog, guides, experiences, bundles, tools),
 * chunks them by section, generates embeddings via Cloudflare Workers AI,
 * and upserts vectors into the arco-content Vectorize index.
 *
 * Usage:
 *   node scripts/index-content.js
 *
 * Authentication:
 *   Reads the OAuth token from wrangler's config at
 *   ~/.wrangler/config/default.toml (or ~/Library/Preferences/.wrangler/...)
 *
 * Environment variables (optional overrides):
 *   CLOUDFLARE_API_TOKEN  — Bearer token for Cloudflare API
 *   CLOUDFLARE_ACCOUNT_ID — Account ID (defaults to wrangler.jsonc value)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Config ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '68e6632adf76183424b251e874663bde';
const INDEX_NAME = 'arco-content';
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const EMBEDDING_DIMENSIONS = 384;
const VECTORIZE_BATCH_SIZE = 100;
const EMBEDDING_DELAY_MS = 50; // rate-limit courtesy delay between embedding calls
const MAX_TEXT_CHARS = 2000; // ~500 tokens, fits bge-small context window

const CONTENT_ROOT = resolve(import.meta.dirname, '../../../content');

// Directories to index (relative to CONTENT_ROOT)
const INDEX_DIRS = ['blog', 'guides', 'experiences', 'bundles', 'tools', 'stories'];

// ── Auth ────────────────────────────────────────────────────────────────────

function getApiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;

  // Read from wrangler OAuth config
  const candidates = [
    join(homedir(), '.wrangler', 'config', 'default.toml'),
    join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf-8');
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }

  throw new Error(
    'No API token found. Set CLOUDFLARE_API_TOKEN or log in with `wrangler login`.',
  );
}

// ── File Discovery ──────────────────────────────────────────────────────────

function findJsonFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findJsonFiles(full));
    } else if (entry.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

// ── Chunking ────────────────────────────────────────────────────────────────

/**
 * Extract indexable text chunks from a content JSON file.
 * Returns array of { id, text, metadata }.
 */
function chunkContent(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn(`  Skipping invalid JSON: ${filePath}`);
    return [];
  }

  const slug = data.slug || data.id;
  if (!slug) return [];

  const title = data.title || '';
  const category = data.category || filePath.split('/content/')[1]?.split('/')[0] || 'unknown';
  const difficulty = data.difficulty || '';
  const personaTags = data.persona_tags || (data.persona_tag ? [data.persona_tag] : []);

  const baseMeta = {
    slug,
    title,
    category,
    difficulty,
    personaTags: personaTags.join(','),
  };

  const chunks = [];

  // Type 1: body[] array of sections (guides, blogs, tools, bundles)
  if (Array.isArray(data.body) && data.body.length > 0) {
    baseMeta.type = 'guide';
    data.body.forEach((section, idx) => {
      const heading = section.heading || `Section ${idx + 1}`;
      const content = section.content || '';
      if (!content) return;

      const text = `${title} — ${heading}: ${content}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${idx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: heading },
      });
    });
  }

  // Type 2: editorial_body string (experiences)
  if (typeof data.editorial_body === 'string' && data.editorial_body.length > 0) {
    baseMeta.type = 'experience';
    // Split long editorial into ~2000 char chunks by paragraph
    const paragraphs = data.editorial_body.split('\n\n').filter(Boolean);
    let currentChunk = '';
    let chunkIdx = 0;

    for (const para of paragraphs) {
      if (currentChunk.length + para.length > MAX_TEXT_CHARS && currentChunk.length > 0) {
        chunks.push({
          id: `${slug}--${chunkIdx}`,
          text: `${title}: ${currentChunk}`,
          metadata: { ...baseMeta, sectionHeading: `Part ${chunkIdx + 1}` },
        });
        chunkIdx += 1;
        currentChunk = '';
      }
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
    if (currentChunk) {
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text: `${title}: ${currentChunk}`.slice(0, MAX_TEXT_CHARS),
        metadata: { ...baseMeta, sectionHeading: `Part ${chunkIdx + 1}` },
      });
    }
  }

  // Type 3: intro-only fallback (if no body or editorial_body)
  if (chunks.length === 0 && data.intro) {
    baseMeta.type = category;
    chunks.push({
      id: `${slug}--0`,
      text: `${title}: ${data.intro}`.slice(0, MAX_TEXT_CHARS),
      metadata: { ...baseMeta, sectionHeading: 'intro' },
    });
  }

  return chunks;
}

// ── Cloudflare API ──────────────────────────────────────────────────────────

async function generateEmbedding(text, token) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: [text] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API error ${res.status}: ${body}`);
  }

  const json = await res.json();
  const embedding = json.result?.data?.[0];
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding shape: ${embedding?.length}`);
  }
  return embedding;
}

async function upsertVectors(vectors, token) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/upsert`;

  // Vectorize expects NDJSON format
  const ndjson = vectors.map((v) => JSON.stringify({
    id: v.id,
    values: v.values,
    metadata: v.metadata,
  })).join('\n');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-ndjson',
    },
    body: ndjson,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vectorize upsert error ${res.status}: ${body}`);
  }

  return res.json();
}

function sleep(ms) {
  return new Promise((resolve_) => { setTimeout(resolve_, ms); });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const token = getApiToken();
  console.log(`Using account: ${ACCOUNT_ID}`);
  console.log(`Index: ${INDEX_NAME} (${EMBEDDING_DIMENSIONS}d, ${EMBEDDING_MODEL})`);
  console.log(`Content root: ${CONTENT_ROOT}\n`);

  // 1. Discover and chunk all content
  const allChunks = [];
  for (const dir of INDEX_DIRS) {
    const dirPath = join(CONTENT_ROOT, dir);
    const files = findJsonFiles(dirPath);
    console.log(`[${dir}] Found ${files.length} JSON files`);

    for (const file of files) {
      const chunks = chunkContent(file);
      allChunks.push(...chunks);
    }
  }

  console.log(`\nTotal chunks to index: ${allChunks.length}\n`);

  if (allChunks.length === 0) {
    console.log('No chunks found. Check that content directories exist and contain valid JSON.');
    process.exit(1);
  }

  // 2. Generate embeddings
  console.log('Generating embeddings...');
  const vectors = [];
  let embedded = 0;

  for (const chunk of allChunks) {
    try {
      const embedding = await generateEmbedding(chunk.text, token);
      vectors.push({
        id: chunk.id,
        values: embedding,
        metadata: chunk.metadata,
      });
      embedded += 1;
      if (embedded % 25 === 0) {
        console.log(`  Embedded ${embedded}/${allChunks.length}`);
      }
      await sleep(EMBEDDING_DELAY_MS);
    } catch (err) {
      console.error(`  Failed to embed ${chunk.id}: ${err.message}`);
    }
  }

  console.log(`\nEmbedded ${embedded}/${allChunks.length} chunks\n`);

  // 3. Upsert in batches
  console.log('Upserting vectors...');
  let upserted = 0;

  for (let i = 0; i < vectors.length; i += VECTORIZE_BATCH_SIZE) {
    const batch = vectors.slice(i, i + VECTORIZE_BATCH_SIZE);
    try {
      await upsertVectors(batch, token);
      upserted += batch.length;
      console.log(`  Upserted ${upserted}/${vectors.length}`);
    } catch (err) {
      console.error(`  Batch upsert failed at offset ${i}: ${err.message}`);
    }
  }

  console.log(`\nDone! Indexed ${upserted} vectors into ${INDEX_NAME}.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
