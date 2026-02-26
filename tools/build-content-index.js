#!/usr/bin/env node
/**
 * Content Index Builder
 * Scans all JSON content files and generates schema/content-index.json
 *
 * Usage: node tools/build-content-index.js
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname, relative, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONTENT_DIR = join(ROOT, 'content');
const OUTPUT_PATH = join(ROOT, 'schema', 'content-index.json');

/**
 * Recursively finds all JSON files in a directory.
 */
function findJsonFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...findJsonFiles(fullPath));
    } else if (entry.endsWith('.json') && !entry.startsWith('.')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Determines content type from file path.
 */
function getContentType(filePath) {
  const rel = relative(CONTENT_DIR, filePath);
  if (rel.startsWith('products/pdp-canonical')) return 'pdp-canonical';
  if (rel.startsWith('products/pdp-persona')) return 'pdp-persona';
  if (rel.startsWith('products/comparison')) return 'comparison';
  if (rel.startsWith('products/right-for-you')) return 'right-for-you';
  if (rel.startsWith('guides/')) return 'guide';
  if (rel.startsWith('experiences/')) return 'experience';
  if (rel.startsWith('blog/')) return 'blog';
  if (rel.startsWith('tools/calculators')) return 'calculator';
  if (rel.startsWith('tools/pairing-guides')) return 'pairing-guide';
  if (rel.startsWith('tools/maintenance')) return 'maintenance';
  if (rel.startsWith('bundles/persona-kits')) return 'persona-kit';
  if (rel.startsWith('bundles/gift-guides')) return 'gift-guide';
  if (rel.startsWith('bundles/budget-tiers')) return 'budget-tier';
  if (rel.startsWith('localization/')) return 'localization';
  if (rel.startsWith('homepage/')) return 'homepage';
  if (rel.startsWith('global/')) return 'global';
  return 'other';
}

/**
 * Determines the page URL slug from file path and data.
 */
function getPageSlug(filePath, data) {
  const rel = relative(CONTENT_DIR, filePath);
  const slug = data.slug || basename(rel, '.json');
  const dir = dirname(rel);

  if (dir === 'homepage') return '/';
  if (dir.startsWith('products/pdp-canonical')) return `/products/${slug}`;
  if (dir.startsWith('products/pdp-persona')) return `/products/persona/${slug}`;
  if (dir.startsWith('products/comparison')) return `/products/comparison/${slug}`;
  if (dir.startsWith('products/right-for-you')) return `/products/right-for-you/${slug}`;
  return `/${dir}/${slug}`;
}

function main() {
  const jsonFiles = findJsonFiles(CONTENT_DIR);
  const contentFiles = jsonFiles.filter((f) => !f.includes('/global/'));

  console.log(`Found ${contentFiles.length} content JSON files`);

  const pages = [];
  const typeCounts = {};

  for (const filePath of contentFiles) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      const type = getContentType(filePath);
      const pageSlug = getPageSlug(filePath, data);

      typeCounts[type] = (typeCounts[type] || 0) + 1;

      pages.push({
        id: data.id || data.slug || basename(filePath, '.json'),
        slug: pageSlug,
        title: data.title || data.name || data.headline || '',
        type,
        persona_tags: data.persona_tags || (data.persona_tag ? [data.persona_tag] : []),
        intent_tags: data.intent_tags || [],
        format: data.category || type,
        market: data.market || data.language || 'en',
        difficulty: data.difficulty || null,
        hero_image_alt: data.hero_image_alt || null,
        related_products: data.related_products || data.pairing_products?.map((p) => p.product_id || p) || [],
        related_experience: data.related_experience || data.experience_tag || null,
        source_file: relative(ROOT, filePath),
      });
    } catch (err) {
      console.error(`Error processing ${filePath}: ${err.message}`);
    }
  }

  const index = {
    generated_at: new Date().toISOString(),
    total_pages: pages.length,
    type_counts: typeCounts,
    pages,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(index, null, 2), 'utf-8');
  console.log(`\nContent index written to ${OUTPUT_PATH}`);
  console.log(`Total pages: ${pages.length}`);
  console.log('By type:', JSON.stringify(typeCounts, null, 2));
}

main();
