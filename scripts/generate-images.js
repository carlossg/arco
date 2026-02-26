#!/usr/bin/env node
/**
 * Image Generation Script for Arco
 * Reads schema/content-index.json and generates images for all content
 * with hero_image_alt fields using the Gemini API.
 *
 * Usage: GEMINI_API_KEY=your_key node scripts/generate-images.js
 *
 * Resumable: skips images that already exist.
 * Rate limited: 5-second delay between API calls.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ASSETS_DIR = join(ROOT, 'assets', 'images');
const INDEX_PATH = join(ROOT, 'schema', 'content-index.json');

const BASE_STYLE = `Photorealistic commercial photography. Clean, minimal composition. \
Natural light preferred, soft shadows. Color palette: deep slate (#1C2B35), \
warm cream (#F5F0E8), copper accents (#B5651D). No text overlays. \
Shot on medium format. Professional food and product photography aesthetic, \
similar to Kinfolk magazine or Monocle visual style.`;

const BRAND_COLORS = [
  'Warm cream linen surface',
  'Deep slate kitchen background',
  'Copper hardware detail visible',
];

/**
 * Maps content type to image directory and aspect ratio.
 */
function getImageConfig(item) {
  const type = item.type || '';
  const slug = item.slug || item.id || 'unknown';

  if (type.includes('product') || type === 'pdp-canonical') {
    return {
      dir: join(ASSETS_DIR, 'products', slug),
      filename: 'hero.jpg',
      aspect: '16:9',
    };
  }
  if (type.includes('persona')) {
    const persona = item.persona_tag || 'default';
    const baseProduct = item.base_product_id || slug.split('--')[0];
    return {
      dir: join(ASSETS_DIR, 'products', baseProduct),
      filename: `hero--${persona}.jpg`,
      aspect: '16:9',
    };
  }
  if (type === 'blog') {
    return {
      dir: join(ASSETS_DIR, 'blog', slug),
      filename: 'hero.jpg',
      aspect: '4:3',
    };
  }
  if (type === 'experience') {
    return {
      dir: join(ASSETS_DIR, 'experiences', slug),
      filename: 'hero.jpg',
      aspect: '16:9',
    };
  }
  if (type === 'guide') {
    return {
      dir: join(ASSETS_DIR, 'guides', slug),
      filename: 'hero.jpg',
      aspect: '16:9',
    };
  }
  if (type === 'bundle') {
    return {
      dir: join(ASSETS_DIR, 'bundles', slug),
      filename: 'hero.jpg',
      aspect: '4:3',
    };
  }
  if (type === 'localization') {
    const market = item.market || 'en';
    return {
      dir: join(ASSETS_DIR, 'localization', market),
      filename: `${slug}.jpg`,
      aspect: '16:9',
    };
  }

  return {
    dir: join(ASSETS_DIR, 'misc'),
    filename: `${slug}.jpg`,
    aspect: '16:9',
  };
}

/**
 * Constructs the full Gemini prompt for an image.
 */
function buildPrompt(item) {
  const alt = item.hero_image_alt || item.title || '';
  const brandColor = BRAND_COLORS[Math.floor(Math.random() * BRAND_COLORS.length)];
  const config = getImageConfig(item);

  let prompt = alt;

  // Add product name if available
  if (item.name) {
    prompt += ` The Arco ${item.name} is the main subject.`;
  }

  // Add persona context for variants
  if (item.persona_tag) {
    const personaContexts = {
      'morning-minimalist': 'styled for a minimalist early riser, calm and uncluttered',
      upgrader: 'styled for an enthusiast ready to level up, technical but approachable',
      'craft-barista': 'styled for a serious home barista, professional and detailed',
      traveller: 'styled for an adventurous traveller, outdoor or hotel context',
      'non-barista': 'styled for someone who values simplicity, clean and approachable',
      'office-manager': 'styled for a modern office environment, professional and efficient',
    };
    const context = personaContexts[item.persona_tag] || '';
    if (context) prompt += ` Scene ${context}.`;
  }

  // Add brand color and style
  prompt += ` ${brandColor}. ${BASE_STYLE} Aspect ratio ${config.aspect}.`;

  return prompt;
}

/**
 * Delays execution for the specified milliseconds.
 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('GEMINI_API_KEY not set. Running in dry-run mode (prompts only).\n');
  }

  // Load content index
  if (!existsSync(INDEX_PATH)) {
    console.error(`Content index not found at ${INDEX_PATH}`);
    console.error('Run the content index generator first.');
    process.exit(1);
  }

  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  const items = index.pages || index;

  // Filter to items with hero_image_alt
  const imageItems = items.filter((item) => item.hero_image_alt);
  console.log(`Found ${imageItems.length} items with hero_image_alt\n`);

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < imageItems.length; i += 1) {
    const item = imageItems[i];
    const config = getImageConfig(item);
    const outputPath = join(config.dir, config.filename);

    // Skip if already exists
    if (existsSync(outputPath)) {
      console.log(`[${i + 1}/${imageItems.length}] SKIP (exists): ${outputPath}`);
      skipped += 1;
      continue;
    }

    const prompt = buildPrompt(item);

    if (!apiKey) {
      // Dry-run: log prompt and create placeholder
      console.log(`[${i + 1}/${imageItems.length}] DRY-RUN: ${outputPath}`);
      console.log(`  Prompt: ${prompt.substring(0, 120)}...\n`);
      skipped += 1;
      continue;
    }

    try {
      // Dynamic import for the Gemini SDK
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp-image-generation' });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['Text', 'Image'] },
      });

      const response = result.response;
      const imagePart = response.candidates?.[0]?.content?.parts?.find(
        (part) => part.inlineData?.mimeType?.startsWith('image/'),
      );

      if (imagePart) {
        mkdirSync(config.dir, { recursive: true });
        const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
        writeFileSync(outputPath, buffer);
        console.log(`[${i + 1}/${imageItems.length}] Generated: ${outputPath}`);
        generated += 1;
      } else {
        console.log(`[${i + 1}/${imageItems.length}] FAILED (no image in response): ${item.slug}`);
        failed += 1;
      }

      // Rate limit
      await delay(5000);
    } catch (err) {
      console.error(`[${i + 1}/${imageItems.length}] ERROR: ${item.slug} — ${err.message}`);
      failed += 1;
    }
  }

  // Generate manifest
  const manifest = imageItems
    .filter((item) => {
      const config = getImageConfig(item);
      return existsSync(join(config.dir, config.filename));
    })
    .map((item) => {
      const config = getImageConfig(item);
      return {
        path: join(config.dir, config.filename).replace(ROOT, ''),
        content_id: item.id || item.slug,
        persona_tag: item.persona_tag || null,
        alt_text: item.hero_image_alt,
        generated_at: new Date().toISOString(),
      };
    });

  if (manifest.length) {
    mkdirSync(ASSETS_DIR, { recursive: true });
    writeFileSync(
      join(ASSETS_DIR, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
    console.log(`\nManifest written with ${manifest.length} entries.`);
  }

  console.log('\n====================================');
  console.log(`Generated: ${generated}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Total:     ${imageItems.length}`);
}

main();
