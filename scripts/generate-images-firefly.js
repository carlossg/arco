#!/usr/bin/env node
/**
 * Image Generation Script for Arco — Adobe Firefly Edition
 *
 * Scans content JSON files for hero_image_alt fields and generates
 * hero images using Adobe Firefly API (Image Model 5) with optional
 * style reference for brand-consistent visuals.
 *
 * Usage:
 *   node scripts/generate-images-firefly.js
 *   node scripts/generate-images-firefly.js --dry-run
 *   node scripts/generate-images-firefly.js --filter blog/community
 *   node scripts/generate-images-firefly.js --limit 5
 *   node scripts/generate-images-firefly.js --style-ref ./path/to/reference.jpg
 *   node scripts/generate-images-firefly.js --style-ref https://main--arco--froesef.aem.live/products/espresso-machines/media_19aa1317eb6d1d6c64ea09d5ec801f2de8968c7e4.png
 *   node scripts/generate-images-firefly.js --style-ref ./ref.jpg --style-strength 80
 *   node scripts/generate-images-firefly.js --version v2      (saves as hero-v2.png instead of hero.png)
 *   node scripts/generate-images-firefly.js --model image5    (image3, image4_standard, image4_ultra, image5)
 *   node scripts/generate-images-firefly.js --variations 3    (1-4 variations per prompt)
 *   node scripts/generate-images-firefly.js --reasoner speed  (quality or speed)
 *
 * Environment variables (set in .env or export):
 *   FIREFLY_CLIENT_ID      — Adobe OAuth client ID
 *   FIREFLY_CLIENT_SECRET  — Adobe OAuth client secret
 *
 * Resumable: skips images that already exist.
 * Rate limited: 3-second delay between API calls.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CONTENT_ROOT = join(ROOT, 'content');
const ASSETS_DIR = join(ROOT, 'assets', 'images');

// Adobe endpoints
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const FIREFLY_API_BASE = 'https://firefly-api.adobe.io';
const FIREFLY_GENERATE_URL = `${FIREFLY_API_BASE}/v3/images/generate`;
const FIREFLY_UPLOAD_URL = `${FIREFLY_API_BASE}/v2/storage/image`;
const IMS_SCOPES = 'openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis';

// Arco brand style (used when no style reference image is provided)
const BASE_STYLE = `Photorealistic commercial photography. Clean, minimal composition. \
Natural light preferred, soft shadows. Color palette: deep slate (#1C2B35), \
warm cream (#F5F0E8), copper accents (#B5651D). No text overlays. \
Professional food and product photography aesthetic, \
similar to Kinfolk magazine or Monocle visual style.`;

const NEGATIVE_PROMPT = 'blurry, low quality, text, watermark, logo, cartoon, illustration, drawing, painting, sketch, CGI, 3D render, deformed fingers, extra fingers, fused fingers, missing fingers, bad hands, bad anatomy, distorted proportions, extra limbs, unnatural pose, disfigured';

// Content directories to scan
const CONTENT_DIRS = ['blog', 'guides', 'experiences', 'bundles', 'tools', 'stories'];

// MIME types for upload
const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
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
  } catch {
    // .env may not be readable
  }
}

function findJsonFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findJsonFiles(full));
    } else if (entry.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

function delay(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    dryRun: args.includes('--dry-run'),
    limit: Infinity,
    filter: null,
    styleRef: null,
    styleStrength: 45,
    version: null,
    model: 'image5',
    variations: 1,
    reasoner: 'quality',
    upsampler: 'low_creativity',
  };

  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1) result.limit = parseInt(args[limitIdx + 1], 10);

  const styleIdx = args.indexOf('--style-ref');
  if (styleIdx !== -1) result.styleRef = args[styleIdx + 1];

  const strengthIdx = args.indexOf('--style-strength');
  if (strengthIdx !== -1) result.styleStrength = parseInt(args[strengthIdx + 1], 10);

  const versionIdx = args.indexOf('--version');
  if (versionIdx !== -1) result.version = args[versionIdx + 1];

  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1) result.model = args[modelIdx + 1];

  const varIdx = args.indexOf('--variations');
  if (varIdx !== -1) result.variations = parseInt(args[varIdx + 1], 10);

  const reasonerIdx = args.indexOf('--reasoner');
  if (reasonerIdx !== -1) result.reasoner = args[reasonerIdx + 1];

  const upsamplerIdx = args.indexOf('--upsampler');
  if (upsamplerIdx !== -1) result.upsampler = args[upsamplerIdx + 1];

  // Filter is any positional arg that isn't a flag value
  const flagValues = new Set();
  for (const flag of ['--limit', '--style-ref', '--style-strength', '--version', '--model', '--variations', '--reasoner', '--upsampler']) {
    const idx = args.indexOf(flag);
    if (idx !== -1) { flagValues.add(idx); flagValues.add(idx + 1); }
  }
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--') && !flagValues.has(i)) {
      result.filter = args[i];
      break;
    }
  }

  return result;
}

/**
 * Determine output path and size based on content type/category.
 */
function getImageConfig(filePath, data, version) {
  const rel = relative(CONTENT_ROOT, filePath);
  const category = rel.split('/')[0];
  const slug = data.slug || data.id || 'unknown';

  // Firefly supported sizes: 2688x1536, 2688x1512, 2304x1792, 2048x2048,
  // 1792x2304, 1344x768, 1344x756, 1152x896, 1024x1024, 896x1152
  const sizeByCategory = {
    blog: { width: 2688, height: 1536 },        // ~16:9 landscape
    guides: { width: 2688, height: 1536 },       // ~16:9 landscape
    experiences: { width: 2688, height: 1536 },   // ~16:9 landscape
    bundles: { width: 2304, height: 1792 },       // ~4:3 landscape
    tools: { width: 2688, height: 1536 },         // ~16:9 landscape
    stories: { width: 2688, height: 1536 },       // ~16:9 landscape
  };

  const filename = version ? `hero-${version}.png` : 'hero.png';

  return {
    dir: join(ASSETS_DIR, category, slug),
    filename,
    size: sizeByCategory[category] || { width: 2688, height: 1536 },
  };
}

/**
 * Build Firefly prompt from content data.
 * When a style reference is used, keep the prompt focused on subject matter
 * and let the reference image handle the visual style.
 */
function buildPrompt(data, hasStyleRef) {
  let prompt = data.hero_image_alt;
  if (data.name) {
    prompt += ` The Arco ${data.name} is the main subject.`;
  }
  if (!hasStyleRef) {
    prompt += ` ${BASE_STYLE}`;
  }
  return prompt;
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

  const json = await res.json();
  return json.access_token;
}

// ── Firefly Storage (reference image upload) ───────────────────────────────

/**
 * Upload a local image file to Firefly temporary storage.
 * Returns an uploadId (UUID) valid for 7 days.
 */
async function uploadReferenceImage(filePath, clientId, accessToken) {
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(`Unsupported image format: ${ext}. Use JPG, PNG, WEBP, or TIFF.`);
  }

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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firefly upload error ${res.status}: ${text}`);
  }

  const json = await res.json();
  return json.images?.[0]?.id;
}

/**
 * Download an image from a URL and upload it to Firefly storage.
 */
async function uploadReferenceFromUrl(imageUrl, clientId, accessToken) {
  const downloadRes = await fetch(imageUrl);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download reference image: ${downloadRes.status}`);
  }

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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firefly upload error ${res.status}: ${text}`);
  }

  const json = await res.json();
  return json.images?.[0]?.id;
}

/**
 * Resolve a --style-ref argument to a Firefly uploadId.
 * Accepts a local file path or a URL.
 */
async function resolveStyleReference(styleRef, clientId, accessToken) {
  if (styleRef.startsWith('http://') || styleRef.startsWith('https://')) {
    console.log(`Uploading style reference from URL: ${styleRef}`);
    return uploadReferenceFromUrl(styleRef, clientId, accessToken);
  }

  const absPath = resolve(styleRef);
  if (!existsSync(absPath)) {
    throw new Error(`Style reference file not found: ${absPath}`);
  }
  console.log(`Uploading style reference from file: ${absPath}`);
  return uploadReferenceImage(absPath, clientId, accessToken);
}

// ── Firefly API ────────────────────────────────────────────────────────────

async function generateImage(prompt, size, clientId, accessToken, genOpts) {
  const model = genOpts.model || 'image5';

  const requestBody = {
    prompt,
    negativePrompt: NEGATIVE_PROMPT,
    numVariations: genOpts.variations || 1,
    size,
    contentClass: 'photo',
    visualIntensity: 4,
    promptBiasingLocaleCode: 'en-US',
  };

  // Upsampler type — 'low_creativity' reduces distortions during upscaling
  if (genOpts.upsampler) {
    requestBody.upsamplerType = genOpts.upsampler;
  }

  // Prompt reasoner — 'quality' enables deeper prompt understanding
  // and populates altText in response
  if (genOpts.reasoner) {
    requestBody.modelSpecificPayload = {
      prompt_reasoner: genOpts.reasoner,
    };
  }

  // Add style reference if provided
  if (genOpts.styleUploadId) {
    requestBody.style = {
      imageReference: {
        source: { uploadId: genOpts.styleUploadId },
      },
      strength: genOpts.styleStrength,
    };
  }

  // Build headers — only include x-model-version for legacy image3 variants.
  // For image4/image5, the v3 endpoint uses the latest model by default
  // when the Image 5 schema fields are present (negativePrompt, contentClass, etc.)
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'x-api-key': clientId,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (model.startsWith('image3')) {
    headers['x-model-version'] = model;
  }

  const res = await fetch(FIREFLY_GENERATE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firefly API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const outputs = json.outputs || [];
  if (outputs.length === 0) {
    throw new Error('No outputs in response');
  }

  // Download all variations
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

  if (results.length === 0) {
    throw new Error('Failed to download any images from response');
  }

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
    console.error('Create credentials at https://developer.adobe.com/console');
    console.error('Use --dry-run to preview prompts without credentials.');
    process.exit(1);
  }

  // Discover content with hero_image_alt
  const items = [];
  for (const dir of CONTENT_DIRS) {
    const dirPath = join(CONTENT_ROOT, dir);
    const files = findJsonFiles(dirPath);
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf-8'));
        if (data.hero_image_alt) {
          const rel = relative(CONTENT_ROOT, file);
          if (opts.filter && !rel.includes(opts.filter)) continue;
          items.push({ file, data, rel });
        }
      } catch { /* skip invalid JSON */ }
    }
  }

  // Apply limit
  if (opts.limit < items.length) items.splice(opts.limit);

  console.log(`Found ${items.length} content files with hero_image_alt`);
  if (opts.filter) console.log(`Filter: ${opts.filter}`);
  if (opts.limit < Infinity) console.log(`Limit: ${opts.limit}`);
  console.log(`Model: ${opts.model}`);
  console.log(`Prompt reasoner: ${opts.reasoner}`);
  console.log(`Upsampler: ${opts.upsampler}`);
  console.log(`Variations per image: ${opts.variations}`);
  if (opts.styleRef) console.log(`Style reference: ${opts.styleRef} (strength: ${opts.styleStrength})`);
  if (opts.version) console.log(`Version: ${opts.version} (files saved as hero-${opts.version}.png)`);
  console.log();

  // Authenticate and prepare style reference
  let accessToken;
  let styleUploadId = null;

  if (!opts.dryRun) {
    console.log('Authenticating with Adobe IMS...');
    accessToken = await getAccessToken(clientId, clientSecret);
    console.log('Authenticated.');

    if (opts.styleRef) {
      styleUploadId = await resolveStyleReference(opts.styleRef, clientId, accessToken);
      if (!styleUploadId) throw new Error('Failed to get uploadId for style reference');
      console.log(`Style reference uploaded (id: ${styleUploadId})`);
    }
    console.log();
  }

  // Generation options passed to the API
  const genOpts = {
    model: opts.model,
    variations: opts.variations,
    reasoner: opts.reasoner,
    upsampler: opts.upsampler,
    styleUploadId,
    styleStrength: opts.styleStrength,
  };

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += 1) {
    const { file, data, rel } = items[i];
    const config = getImageConfig(file, data, opts.version);
    const outputPath = join(config.dir, config.filename);

    // Skip existing (check first variation)
    if (existsSync(outputPath)) {
      console.log(`[${i + 1}/${items.length}] SKIP (exists): ${relative(ROOT, outputPath)}`);
      skipped += 1;
      continue;
    }

    const prompt = buildPrompt(data, !!styleUploadId);

    if (opts.dryRun) {
      console.log(`[${i + 1}/${items.length}] DRY-RUN: ${rel}`);
      console.log(`  Output: ${relative(ROOT, outputPath)}`);
      console.log(`  Size: ${config.size.width}x${config.size.height}`);
      console.log(`  Model: ${opts.model} | Reasoner: ${opts.reasoner} | Variations: ${opts.variations}`);
      console.log(`  Style ref: ${opts.styleRef || 'none (using text-based brand style)'}`);
      console.log(`  Prompt: ${prompt.substring(0, 150)}...`);
      console.log();
      skipped += 1;
      continue;
    }

    try {
      console.log(`[${i + 1}/${items.length}] Generating: ${rel}`);
      const results = await generateImage(prompt, config.size, clientId, accessToken, genOpts);
      mkdirSync(config.dir, { recursive: true });

      // Save each variation
      const seeds = [];
      for (let v = 0; v < results.length; v += 1) {
        const { buffer, seed } = results[v];
        seeds.push(seed);

        // First variation uses the base filename, others get -var2, -var3, etc.
        let varFilename;
        if (v === 0) {
          varFilename = config.filename;
        } else {
          varFilename = config.filename.replace('.png', `-var${v + 1}.png`);
        }
        const varPath = join(config.dir, varFilename);
        writeFileSync(varPath, buffer);
        console.log(`  Saved: ${relative(ROOT, varPath)} (${(buffer.length / 1024).toFixed(0)} KB, seed: ${seed})`);
      }

      // Save prompt and settings as sidecar txt file
      const metaFilename = config.filename.replace('.png', '.txt');
      const metaPath = join(config.dir, metaFilename);
      const metaContent = [
        `Generated: ${new Date().toISOString()}`,
        `Source: ${rel}`,
        `Model: Adobe Firefly ${opts.model} (v3 API)`,
        `Prompt reasoner: ${opts.reasoner}`,
        `Upsampler: ${opts.upsampler}`,
        `Size: ${config.size.width}x${config.size.height}`,
        `Content class: photo`,
        `Visual intensity: 4`,
        `Variations: ${results.length}`,
        `Seeds: ${seeds.join(', ')}`,
        `Style reference: ${opts.styleRef || 'none'}`,
        `Style strength: ${styleUploadId ? opts.styleStrength : 'n/a'}`,
        `Version: ${opts.version || 'default'}`,
        '',
        '--- Prompt ---',
        prompt,
        '',
        '--- Negative prompt ---',
        NEGATIVE_PROMPT,
      ].join('\n');
      writeFileSync(metaPath, metaContent, 'utf-8');

      generated += results.length;
      await delay(3000);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      failed += 1;
      await delay(2000);
    }
  }

  console.log('\n====================================');
  console.log(`Generated: ${generated} images`);
  console.log(`Skipped:   ${skipped} items`);
  console.log(`Failed:    ${failed} items`);
  console.log(`Total:     ${items.length} items`);
}

main();
