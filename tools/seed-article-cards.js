#!/usr/bin/env node
/**
 * Seed excerpt / image / published fields into stories-index.json and
 * experiences-index.json. Idempotent — existing values are never overwritten.
 *
 * Defaults seeded:
 *   excerpt   — first sentence of intro (stories) or hero_subtext/editorial_intro (experiences),
 *               trimmed to ~160 chars
 *   image     — '' (left blank; resolver falls back to related-product image)
 *   published — audited against the live sitemap when --audit is passed,
 *               else true. --audit rewrites published on every run so the
 *               index reflects what's actually published on aem.live.
 *
 * Usage:
 *   node tools/seed-article-cards.js            # seed missing fields only
 *   node tools/seed-article-cards.js --audit    # also refresh `published`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MAX_EXCERPT_CHARS = 160;
const SITEMAP_URL = 'https://main--arco--froesef.aem.live/sitemap.xml';
const AUDIT = process.argv.includes('--audit');

function firstSentence(text) {
  if (!text) return '';
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = match ? match[1] : text;
  return sentence.length > MAX_EXCERPT_CHARS
    ? `${sentence.slice(0, MAX_EXCERPT_CHARS - 1).trimEnd()}…`
    : sentence.trim();
}

function seedEntry(entry, excerptSource, liveSlugs) {
  let changed = false;
  if (entry.excerpt === undefined) {
    entry.excerpt = firstSentence(excerptSource);
    changed = true;
  }
  if (entry.image === undefined) {
    entry.image = '';
    changed = true;
  }
  if (AUDIT && liveSlugs) {
    const wantPublished = liveSlugs.has(entry.slug);
    if (entry.published !== wantPublished) {
      entry.published = wantPublished;
      changed = true;
    }
  } else if (entry.published === undefined) {
    entry.published = true;
    changed = true;
  }
  return changed;
}

async function fetchLiveSlugs(pathPrefix) {
  const res = await fetch(SITEMAP_URL);
  if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status}`);
  const xml = await res.text();
  const re = new RegExp(`${pathPrefix}/([^/<]+)`, 'g');
  const slugs = new Set();
  for (const match of xml.matchAll(re)) {
    const slug = match[1];
    // Skip category index pages (no leaf slug)
    if (slug && !slug.endsWith('.xml')) slugs.add(slug);
  }
  return slugs;
}

async function processFile(path, excerptField, pathPrefix) {
  const raw = readFileSync(path, 'utf-8');
  const json = JSON.parse(raw);
  const items = json.data || [];

  const liveSlugs = AUDIT ? await fetchLiveSlugs(pathPrefix) : null;

  let changedCount = 0;
  let publishedCount = 0;
  for (const item of items) {
    const source = item[excerptField] || item.hero_subtext || item.editorial_intro || item.intro || '';
    if (seedEntry(item, source, liveSlugs)) changedCount += 1;
    if (item.published) publishedCount += 1;
  }

  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${path}: ${changedCount} entries updated, ${publishedCount}/${items.length} marked published`);
}

await processFile(join(ROOT, 'content/stories-index.json'), 'intro', '/stories');
await processFile(join(ROOT, 'content/experiences-index.json'), 'hero_subtext', '/experiences');
