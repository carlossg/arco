#!/usr/bin/env node
/**
 * Build unified hero image catalog from multiple sources.
 *
 * Sources:
 *   1. content/hero-images.json        — 43 lifestyle images (life-*.png in DA)
 *   2. content/hero-images-curated.json — 34 curated entries (*.jpeg in DA)
 *   3. drafts/media/                    — any additional media files not in the above
 *   4. drafts/**\/*.plain.html           — ~228 content page hero images from DA
 *
 * Output: content/hero-image-catalog.json
 *
 * Each entry gets an `embeddingText` field suitable for vectorization.
 *
 * Usage:
 *   node tools/build-hero-catalog.js              # build catalog
 *   node tools/build-hero-catalog.js --validate    # also HEAD-check URLs against DA
 */

import {
  readFileSync, writeFileSync, readdirSync, existsSync, statSync,
} from 'fs';
import { join, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

const DA_ORG = 'froesef';
const DA_REPO = 'arco';
const DA_MEDIA_BASE = `https://content.da.live/${DA_ORG}/${DA_REPO}/media`;

const VALIDATE = process.argv.includes('--validate');

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(relPath) {
  const absPath = join(PROJECT_DIR, relPath);
  return JSON.parse(readFileSync(absPath, 'utf8'));
}

function buildEmbeddingText(entry) {
  const parts = [];
  if (entry.scenario) parts.push(entry.scenario);
  if (entry.alt) parts.push(entry.alt);
  if (entry.topics?.length) parts.push(`Topics: ${entry.topics.join(', ')}`);
  if (entry.productIds?.length) parts.push(`Products: ${entry.productIds.join(', ')}`);
  if (entry.category) parts.push(`Category: ${entry.category}`);
  return parts.join('. ').slice(0, 2000);
}

/** Infer alt text and topics from an accessory product filename like product-knock-box.jpeg */
function inferAccessoryMeta(id) {
  const label = id.replace('product-', '').replace(/-/g, ' ');
  return {
    alt: `Arco ${label} — coffee accessory product photo`,
    topics: label.split(' ').filter((w) => w.length > 2).concat(['accessory', 'product']),
  };
}

// ── Source 1: Lifestyle images from hero-images.json ─────────────────────────

function loadLifestyleImages() {
  const data = readJSON('content/hero-images.json');
  return data.images.map((img) => {
    // Actual files in DA are .png, not .jpeg as listed in the JSON
    const ext = existsSync(join(PROJECT_DIR, 'drafts/media', `${img.id}.png`)) ? 'png' : 'jpeg';
    return {
      id: img.id,
      type: 'lifestyle',
      category: img.category || '',
      url: `${DA_MEDIA_BASE}/${img.id}.${ext}`,
      alt: img.alt,
      scenario: img.scenario || '',
      topics: img.topics || [],
      productIds: [],
    };
  });
}

// ── Source 2: Curated entries from hero-images-curated.json ───────────────────

function loadCuratedImages() {
  const data = readJSON('content/hero-images-curated.json');
  return data.images.map((img) => {
    const filename = img.path.replace(/^\//, '');
    return {
      id: img.id,
      type: img.type || 'curated',
      category: '',
      url: `${DA_MEDIA_BASE}/${filename}`,
      alt: img.alt,
      scenario: '',
      topics: img.topics || [],
      productIds: img.productIds || [],
    };
  });
}

// ── Source 3: Extra media files not covered by above ─────────────────────────

function loadExtraMedia(coveredIds) {
  const mediaDir = join(PROJECT_DIR, 'drafts/media');
  if (!existsSync(mediaDir)) return [];

  const files = readdirSync(mediaDir);
  const extras = [];

  for (const file of files) {
    const ext = extname(file);
    if (!['.png', '.jpeg', '.jpg', '.webp'].includes(ext)) continue;

    const id = basename(file, ext);
    if (coveredIds.has(id)) continue;
    // Skip avatars
    if (id.startsWith('avatar-')) continue;

    const isProduct = id.startsWith('product-');
    const meta = isProduct ? inferAccessoryMeta(id) : {
      alt: `${id.replace(/-/g, ' ')} — hero image`,
      topics: id.replace(/-/g, ' ').split(' ').filter((w) => w.length > 2),
    };

    extras.push({
      id,
      type: isProduct ? 'product' : 'other',
      category: '',
      url: `${DA_MEDIA_BASE}/${file}`,
      alt: meta.alt,
      scenario: '',
      topics: meta.topics,
      productIds: [],
    });
  }

  return extras;
}

// ── Source 4: Content page hero images from draft HTML ──────────────────────

function findFiles(dir, ext) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry === 'media') continue; // skip media subdirectory
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findFiles(full, ext));
    } else if (entry.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

function loadContentPageImages(coveredUrls) {
  const draftsDir = join(PROJECT_DIR, 'drafts');
  const htmlFiles = findFiles(draftsDir, '.plain.html');

  // Load content-index for metadata enrichment
  let pagesIndex = {};
  const ciPath = join(PROJECT_DIR, 'schema/content-index.json');
  if (existsSync(ciPath)) {
    const ci = JSON.parse(readFileSync(ciPath, 'utf8'));
    for (const p of ci.pages) {
      pagesIndex[p.slug] = p;
    }
  }

  const imgRegex = /<img\s+src="([^"]+)"\s+alt="([^"]*)"/;
  const seenUrls = new Set(coveredUrls);
  const entries = [];

  for (const file of htmlFiles) {
    const content = readFileSync(file, 'utf8');
    const match = content.match(imgRegex);
    if (!match) continue;

    const url = match[1];
    const alt = match[2];

    // Skip if already covered or duplicate URL
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    // Derive ID from URL filename
    const urlFilename = url.split('/').pop();
    const id = urlFilename.replace(/\.[^.]+$/, '');

    // Derive slug from file path for content-index lookup
    const rel = file.replace(draftsDir + '/', '').replace('.plain.html', '');
    const slug = '/' + rel;
    const page = pagesIndex[slug] || {};

    // Build topics from content-index metadata
    const topics = [];
    if (page.persona_tags) topics.push(...page.persona_tags);
    if (page.intent_tags) topics.push(...page.intent_tags);
    if (page.type) topics.push(page.type);
    if (page.format) topics.push(page.format);
    // Extract keywords from title
    if (page.title) {
      page.title.toLowerCase().split(/[\s,;:!?—–-]+/).forEach((w) => {
        const t = w.replace(/[^a-z0-9]/g, '');
        if (t.length > 3 && !topics.includes(t)) topics.push(t);
      });
    }
    // Extract product references
    const productIds = (page.related_products || []).map((p) => p.replace('arco-', ''));

    entries.push({
      id,
      type: page.type || 'content',
      category: page.format || '',
      url,
      alt,
      scenario: page.title || '',
      topics,
      productIds,
    });
  }

  return entries;
}

// ── Validate URLs ────────────────────────────────────────────────────────────

async function validateUrls(entries) {
  const BATCH = 20;
  let valid = 0;
  let invalid = 0;
  const results = [];

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const checks = await Promise.all(
      batch.map(async (entry) => {
        try {
          const res = await fetch(entry.url, { method: 'HEAD' });
          if (res.ok) {
            valid++;
            return entry;
          }
          console.error(`  404: ${entry.url}`);
          invalid++;
          return null;
        } catch {
          console.error(`  ERR: ${entry.url}`);
          invalid++;
          return null;
        }
      }),
    );
    results.push(...checks.filter(Boolean));
  }

  console.log(`Validation: ${valid} valid, ${invalid} invalid`);
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Building hero image catalog...');
  console.log('');

  // Load sources
  const lifestyle = loadLifestyleImages();
  console.log(`Source 1 — lifestyle images: ${lifestyle.length}`);

  const curated = loadCuratedImages();
  console.log(`Source 2 — curated entries:  ${curated.length}`);

  // Merge lifestyle + curated, tracking IDs
  const seen = new Map();
  for (const entry of [...curated, ...lifestyle]) {
    // curated first so lifestyle overwrites with richer metadata
    seen.set(entry.id, entry);
  }

  const extras = loadExtraMedia(new Set(seen.keys()));
  console.log(`Source 3 — extra media:      ${extras.length}`);
  for (const entry of extras) {
    seen.set(entry.id, entry);
  }

  // Collect all URLs already covered before loading content pages
  const coveredUrls = new Set(Array.from(seen.values()).map((e) => e.url));
  const contentPages = loadContentPageImages(coveredUrls);
  console.log(`Source 4 — content pages:    ${contentPages.length}`);
  for (const entry of contentPages) {
    if (!seen.has(entry.id)) {
      seen.set(entry.id, entry);
    }
  }

  let all = Array.from(seen.values());
  console.log(`\nTotal before validation: ${all.length}`);

  // Validate URLs if requested
  if (VALIDATE) {
    console.log('\nValidating URLs against DA...');
    all = await validateUrls(all);
  }

  // Add embeddingText to each entry
  for (const entry of all) {
    entry.embeddingText = buildEmbeddingText(entry);
  }

  // Sort by type then id
  all.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.id.localeCompare(b.id);
  });

  // Write output
  const output = {
    _meta: {
      description: 'Unified hero image catalog for Vectorize indexing and hero selection',
      generated: new Date().toISOString(),
      sources: [
        'content/hero-images.json',
        'content/hero-images-curated.json',
        'drafts/media/',
        'drafts/**/*.plain.html + schema/content-index.json',
      ],
    },
    images: all,
  };

  const outPath = join(PROJECT_DIR, 'content/hero-image-catalog.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  console.log(`\nWrote ${all.length} entries to content/hero-image-catalog.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
