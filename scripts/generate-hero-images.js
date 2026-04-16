#!/usr/bin/env node
/**
 * Generate hero images from content/hero-images.json using Adobe Firefly.
 *
 * Usage:
 *   node scripts/generate-hero-images.js                    # generate all pending
 *   node scripts/generate-hero-images.js --limit 3          # first 3 only
 *   node scripts/generate-hero-images.js --id life-cycling  # single image by id
 *   node scripts/generate-hero-images.js --dry-run          # preview without calling API
 *   node scripts/generate-hero-images.js --style-ref ./ref.jpg --style-strength 45
 *   node scripts/generate-hero-images.js --variations 2     # 1-4 variations per prompt
 *
 * Images are saved to assets/images/heroes/<id>/hero.png
 * The hero-images.json `path` field is updated once an image is generated.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CATALOG_PATH = join(ROOT, 'content', 'hero-images.json');
const ASSETS_DIR = join(ROOT, 'assets', 'images', 'heroes');

// Adobe endpoints
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const FIREFLY_API_BASE = 'https://firefly-api.adobe.io';
const FIREFLY_GENERATE_URL = `${FIREFLY_API_BASE}/v3/images/generate`;
const FIREFLY_UPLOAD_URL = `${FIREFLY_API_BASE}/v2/storage/image`;
const IMS_SCOPES = 'openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis';

const NEGATIVE_PROMPT = 'blurry, low quality, text, watermark, logo, cartoon, illustration, drawing, painting, sketch, CGI, 3D render, deformed fingers, extra fingers, fused fingers, missing fingers, bad hands, bad anatomy, distorted proportions, extra limbs, unnatural pose, disfigured';

const MIME_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const envPath = join(ROOT, '.env');
    if (!existsSync(envPath)) return;
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* .env may not exist */ }
}

function delay(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    dryRun: args.includes('--dry-run'),
    limit: Infinity,
    id: null,
    styleRef: null,
    styleStrength: 45,
    variations: 1,
  };

  for (const [flag, key, parser] of [
    ['--limit', 'limit', (v) => parseInt(v, 10)],
    ['--id', 'id', (v) => v],
    ['--style-ref', 'styleRef', (v) => v],
    ['--style-strength', 'styleStrength', (v) => parseInt(v, 10)],
    ['--variations', 'variations', (v) => parseInt(v, 10)],
  ]) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) result[key] = parser(args[idx + 1]);
  }

  return result;
}

// ── Adobe Auth ─────────────────────────────────────────────────────────────

async function getAccessToken(clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: IMS_SCOPES,
  });

  const res = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IMS token error ${res.status}: ${text}`);
  }

  return (await res.json()).access_token;
}

// ── Firefly Storage ────────────────────────────────────────────────────────

async function uploadReferenceFromUrl(imageUrl, clientId, accessToken) {
  const downloadRes = await fetch(imageUrl);
  if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);
  const contentType = downloadRes.headers.get('content-type') || 'image/jpeg';
  const imageData = Buffer.from(await downloadRes.arrayBuffer());

  const res = await fetch(FIREFLY_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': clientId,
      'Content-Type': contentType,
      'Content-Length': imageData.length.toString(),
    },
    body: imageData,
  });
  if (!res.ok) throw new Error(`Upload error ${res.status}: ${await res.text()}`);
  return (await res.json()).images?.[0]?.id;
}

async function uploadReferenceFile(filePath, clientId, accessToken) {
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) throw new Error(`Unsupported format: ${ext}`);
  const imageData = readFileSync(filePath);

  const res = await fetch(FIREFLY_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': clientId,
      'Content-Type': mimeType,
      'Content-Length': imageData.length.toString(),
    },
    body: imageData,
  });
  if (!res.ok) throw new Error(`Upload error ${res.status}: ${await res.text()}`);
  return (await res.json()).images?.[0]?.id;
}

async function resolveStyleReference(styleRef, clientId, accessToken) {
  if (styleRef.startsWith('http://') || styleRef.startsWith('https://')) {
    console.log(`  Uploading style reference from URL: ${styleRef}`);
    return uploadReferenceFromUrl(styleRef, clientId, accessToken);
  }
  const absPath = resolve(styleRef);
  if (!existsSync(absPath)) throw new Error(`Style ref not found: ${absPath}`);
  console.log(`  Uploading style reference from file: ${absPath}`);
  return uploadReferenceFile(absPath, clientId, accessToken);
}

// ── Firefly Generation ─────────────────────────────────────────────────────

async function generateImage(prompt, size, clientId, accessToken, opts) {
  const requestBody = {
    prompt,
    negativePrompt: NEGATIVE_PROMPT,
    numVariations: opts.variations || 1,
    size,
    contentClass: 'photo',
    visualIntensity: 4,
    promptBiasingLocaleCode: 'en-US',
    upsamplerType: 'low_creativity',
    modelSpecificPayload: { prompt_reasoner: 'quality' },
  };

  if (opts.styleUploadId) {
    requestBody.style = {
      imageReference: { source: { uploadId: opts.styleUploadId } },
      strength: opts.styleStrength,
    };
  }

  const res = await fetch(FIREFLY_GENERATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': clientId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firefly API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const outputs = json.outputs || [];
  if (outputs.length === 0) throw new Error('No outputs in response');

  const results = [];
  for (const output of outputs) {
    const imageUrl = output.image?.url;
    if (!imageUrl) continue;
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) continue;
    results.push({
      buffer: Buffer.from(await imageRes.arrayBuffer()),
      seed: output.seed || null,
    });
  }
  if (results.length === 0) throw new Error('Failed to download images');
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv);

  const clientId = process.env.FIREFLY_CLIENT_ID;
  const clientSecret = process.env.FIREFLY_CLIENT_SECRET;

  if ((!clientId || !clientSecret) && !opts.dryRun) {
    console.error('FIREFLY_CLIENT_ID and FIREFLY_CLIENT_SECRET must be set.');
    process.exit(1);
  }

  // Load catalog
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
  const size = catalog._meta.firefly_settings.size;

  // Filter entries
  let entries = catalog.images.filter((img) => !img.path); // only ungenerated
  if (opts.id) {
    entries = entries.filter((img) => img.id === opts.id);
    if (entries.length === 0) {
      const exists = catalog.images.find((img) => img.id === opts.id);
      if (exists?.path) {
        console.log(`Image "${opts.id}" already has a path: ${exists.path}`);
      } else {
        console.error(`No image found with id "${opts.id}"`);
      }
      process.exit(0);
    }
  }
  if (opts.limit < entries.length) entries = entries.slice(0, opts.limit);

  console.log(`\nArco Hero Image Generator`);
  console.log(`─────────────────────────`);
  console.log(`Pending: ${entries.length} image(s)`);
  console.log(`Size: ${size.width}x${size.height}`);
  if (opts.styleRef) console.log(`Style ref: ${opts.styleRef} (strength: ${opts.styleStrength})`);
  if (opts.variations > 1) console.log(`Variations: ${opts.variations}`);
  if (opts.dryRun) console.log(`Mode: DRY RUN`);
  console.log();

  // Auth + optional style ref upload
  let accessToken;
  let styleUploadId = null;

  if (!opts.dryRun) {
    console.log('Authenticating with Adobe IMS...');
    accessToken = await getAccessToken(clientId, clientSecret);
    console.log('Authenticated.\n');

    if (opts.styleRef) {
      styleUploadId = await resolveStyleReference(opts.styleRef, clientId, accessToken);
      console.log(`  Style reference uploaded (id: ${styleUploadId})\n`);
    }
  }

  let generated = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const outDir = join(ASSETS_DIR, entry.id);
    const outPath = join(outDir, 'hero.png');

    console.log(`[${i + 1}/${entries.length}] ${entry.id}`);
    console.log(`  Scenario: ${entry.scenario}`);
    console.log(`  Category: ${entry.category}`);
    console.log(`  Output:   ${relative(ROOT, outPath)}`);

    if (opts.dryRun) {
      console.log(`  Prompt:   ${entry.prompt.substring(0, 120)}...`);
      console.log();
      continue;
    }

    // Skip if file already exists on disk
    if (existsSync(outPath)) {
      console.log(`  SKIP (file exists on disk)`);
      console.log();
      continue;
    }

    try {
      const results = await generateImage(
        entry.prompt,
        size,
        clientId,
        accessToken,
        { variations: opts.variations, styleUploadId, styleStrength: opts.styleStrength },
      );

      mkdirSync(outDir, { recursive: true });

      for (let v = 0; v < results.length; v += 1) {
        const { buffer, seed } = results[v];
        const varFilename = v === 0 ? 'hero.png' : `hero-var${v + 1}.png`;
        const varPath = join(outDir, varFilename);
        writeFileSync(varPath, buffer);
        console.log(`  Saved: ${relative(ROOT, varPath)} (${(buffer.length / 1024).toFixed(0)} KB, seed: ${seed})`);
      }

      // Save metadata sidecar
      const metaPath = join(outDir, 'hero.txt');
      writeFileSync(metaPath, [
        `id: ${entry.id}`,
        `scenario: ${entry.scenario}`,
        `category: ${entry.category}`,
        `generated: ${new Date().toISOString()}`,
        `size: ${size.width}x${size.height}`,
        `variations: ${results.length}`,
        `seeds: ${results.map((r) => r.seed).join(', ')}`,
        `style_ref: ${opts.styleRef || 'none'}`,
        '',
        '--- prompt ---',
        entry.prompt,
        '',
        '--- negative prompt ---',
        NEGATIVE_PROMPT,
      ].join('\n'), 'utf-8');

      // Update path in catalog (relative path placeholder until DA upload)
      const catalogEntry = catalog.images.find((img) => img.id === entry.id);
      if (catalogEntry) {
        catalogEntry.path = `assets/images/heroes/${entry.id}/hero.png`;
      }

      generated += 1;
      console.log(`  Done.`);

      // Rate limit between API calls
      if (i < entries.length - 1) {
        console.log(`  Waiting 3s...`);
        await delay(3000);
      }
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      failed += 1;
      await delay(2000);
    }
    console.log();
  }

  // Write updated catalog back
  if (!opts.dryRun && generated > 0) {
    writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf-8');
    console.log(`Updated hero-images.json with ${generated} new path(s).`);
  }

  console.log(`\n════════════════════════════`);
  console.log(`Generated: ${generated}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Total:     ${entries.length}`);
}

main();
