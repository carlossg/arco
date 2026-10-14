#!/usr/bin/env node
/**
 * Resolve hero image catalog DA URLs to delivery (publish) URLs.
 *
 * DA media files (content.da.live) are auth-gated. When referenced in an
 * authored page and previewed, AEM converts them to public /media_<hash>.jpg
 * paths. This script:
 *
 *   1. Creates a temporary DA page that embeds all catalog images
 *   2. Previews it via the AEM admin API
 *   3. Scrapes the media_<hash> URLs from the preview output
 *   4. Writes `publishUrl` into each catalog entry
 *
 * Requires: .da-token in the project root (DA auth bearer token)
 *
 * Usage:
 *   node tools/resolve-hero-publish-urls.js           # resolve and update catalog
 *   node tools/resolve-hero-publish-urls.js --dry-run # show what would change
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

const CATALOG_PATH = join(PROJECT_DIR, 'data/hero-image-catalog.json');
const DA_TOKEN_PATH = join(PROJECT_DIR, '.da-token');

const DA_ORG = 'carlossg';
const DA_REPO = 'arco';
const PREVIEW_HOST = `https://main--${DA_REPO}--${DA_ORG}.aem.page`;
const DA_ADMIN_HOST = 'https://admin.da.live';
const AEM_ADMIN_HOST = 'https://admin.hlx.page';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 50; // images per temporary page (avoid huge pages)
const TEMP_PATH_PREFIX = 'drafts/tmp-hero-resolve';

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadToken() {
  try {
    return readFileSync(DA_TOKEN_PATH, 'utf8').trim();
  } catch {
    console.error('Error: .da-token not found. Run DA login first.');
    process.exit(1);
  }
}

function buildPageHtml(imageUrls) {
  // Build a minimal page where each image appears once in order
  const rows = imageUrls.map((url) => `<p><img src="${url}" alt="resolve"></p>`);
  return `<body><main><div>${rows.join('\n')}</div></main></body>`;
}

async function uploadPage(token, path, html) {
  const formData = new FormData();
  formData.append('data', new Blob([html], { type: 'text/html' }), 'index.html');

  const resp = await fetch(`${DA_ADMIN_HOST}/source/${DA_ORG}/${DA_REPO}/${path}.html`, {
    method: 'PUT',
    headers: { Authorization: token },
    body: formData,
  });
  if (!resp.ok) {
    throw new Error(`Upload failed (${resp.status}): ${await resp.text()}`);
  }
}

async function previewPage(token, path) {
  const resp = await fetch(`${AEM_ADMIN_HOST}/preview/${DA_ORG}/${DA_REPO}/main/${path}`, {
    method: 'POST',
    headers: { Authorization: token },
  });
  if (!resp.ok) {
    throw new Error(`Preview failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

async function fetchPreviewHtml(path, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const url = `${PREVIEW_HOST}/${path}.plain.html`;
    const resp = await fetch(url);
    if (resp.ok) return resp.text();
    if (attempt < retries - 1) {
      console.log(`    Retry ${attempt + 1}/${retries - 1} (got ${resp.status})...`);
    } else {
      throw new Error(`Fetch preview failed after ${retries} attempts (${resp.status}): ${url}`);
    }
  }
}

function extractMediaHashes(html) {
  // Extract unique media_<hash> paths in order of appearance
  const matches = html.matchAll(/\/media_([a-f0-9]+\.[a-z]+)/g);
  const seen = new Set();
  const result = [];
  for (const m of matches) {
    const path = `/media_${m[1]}`;
    if (!seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}

async function deletePage(token, path) {
  await fetch(`${DA_ADMIN_HOST}/source/${DA_ORG}/${DA_REPO}/${path}.html`, {
    method: 'DELETE',
    headers: { Authorization: token },
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const token = loadToken();
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const images = catalog.images;

  console.log(`Resolving publish URLs for ${images.length} catalog images...`);
  if (DRY_RUN) console.log('(dry run — catalog will not be modified)\n');

  const batches = [];
  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    batches.push(images.slice(i, i + BATCH_SIZE));
  }

  let resolved = 0;
  let failed = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const pagePath = `${TEMP_PATH_PREFIX}-${batchIdx}`;
    const daUrls = batch.map((img) => img.url);

    console.log(`\nBatch ${batchIdx + 1}/${batches.length} (${batch.length} images)...`);

    try {
      // 1. Upload temp page
      const html = buildPageHtml(daUrls);
      console.log(`  Uploading temp page: ${pagePath}`);
      await uploadPage(token, pagePath, html);

      // 2. Preview it
      console.log('  Triggering preview...');
      await previewPage(token, pagePath);

      // 3. Fetch preview HTML and extract hashes
      console.log('  Fetching preview output...');
      const previewHtml = await fetchPreviewHtml(pagePath);
      const hashes = extractMediaHashes(previewHtml);

      console.log(`  Found ${hashes.length} unique media hashes (expected ${batch.length})`);

      // 4. Map them back to catalog entries
      if (hashes.length === batch.length) {
        for (let i = 0; i < batch.length; i++) {
          batch[i].publishUrl = hashes[i];
          resolved++;
        }
      } else {
        console.warn(`  ⚠ Hash count mismatch — skipping batch (got ${hashes.length}, need ${batch.length})`);
        failed += batch.length;
      }

      // 5. Clean up temp page
      await deletePage(token, pagePath);
    } catch (err) {
      console.error(`  ✗ Batch ${batchIdx + 1} failed: ${err.message}`);
      failed += batch.length;
      // Try to clean up
      try { await deletePage(token, pagePath); } catch { /* ignore */ }
    }
  }

  console.log(`\n✓ Resolved: ${resolved}/${images.length}`);
  if (failed) console.log(`✗ Failed: ${failed}`);

  if (!DRY_RUN && resolved > 0) {
    writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n');
    console.log(`\nCatalog updated: ${CATALOG_PATH}`);
  } else if (DRY_RUN && resolved > 0) {
    console.log('\nSample resolved entries:');
    images.filter((i) => i.publishUrl).slice(0, 3).forEach((img) => {
      console.log(`  ${img.id}: ${img.publishUrl}`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
