#!/usr/bin/env node
/**
 * Render a fixture to stdout for quick debugging.
 * Usage: node tools/render-prompt.js <fixture-name> [--system|--user|--both]
 *
 * Run with the json-loader to handle the .yaml/.njk/.json imports:
 *   node --loader ./tools/json-loader.js tools/render-prompt.js cold-start
 */

// Note: this tool intentionally skips scenario picking, conversation
// history building, and feature-match detection — it's a quick template
// renderer for system-prompt and simple RAG inspection. For full
// production-fidelity rendering use the actual production code path or
// the snapshot tests.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  renderPrompt,
  enrichCatalogForPrompt,
  enrichAccessoriesForPrompt,
  enrichRagForPrompt,
} from '../src/prompt-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../tests/fixtures');
const CONTENT_DIR = path.resolve(HERE, '../../../content');

async function main() {
  const [name, which = '--both'] = process.argv.slice(2);
  if (!name) {
    console.error('usage: node tools/render-prompt.js <fixture-name> [--system|--user|--both]');
    process.exit(2);
  }
  const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, `${name}.json`), 'utf8'));
  const [products, profiles, accessories] = await Promise.all([
    readFile(path.join(CONTENT_DIR, 'products/products.json'), 'utf8').then(JSON.parse),
    readFile(path.join(CONTENT_DIR, 'metadata/product-profiles.json'), 'utf8').then(JSON.parse),
    readFile(path.join(CONTENT_DIR, 'accessories/accessories.json'), 'utf8').then(JSON.parse),
  ]);
  const ctx = {
    ...fx,
    catalog: enrichCatalogForPrompt(products.data || products, profiles.data || profiles.profiles || profiles),
    accessories: enrichAccessoriesForPrompt(accessories.data || accessories),
    rag: enrichRagForPrompt(fx.contextData || {}),
  };
  const { system, user } = renderPrompt('recommender', ctx);
  if (which === '--system') process.stdout.write(system);
  else if (which === '--user') process.stdout.write(user);
  else process.stdout.write(`===SYSTEM===\n${system}\n===USER===\n${user}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
