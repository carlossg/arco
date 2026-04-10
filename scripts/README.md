# Scripts

Utility scripts for the Arco project.

## Image Generation with Adobe Firefly

`generate-images-firefly.js` generates hero images for all content files that have a `hero_image_alt` field. It uses the Adobe Firefly API (Image Model 5) and supports style references for brand-consistent output.

### Prerequisites

1. Create an OAuth credential at [Adobe Developer Console](https://developer.adobe.com/console) with the Firefly API enabled.
2. Add the credentials to `.env` in the project root:

```
FIREFLY_CLIENT_ID=your_client_id
FIREFLY_CLIENT_SECRET=your_client_secret
```

### How it works

The script scans content JSON files in `content/{blog,guides,experiences,bundles,tools,stories}/` for a `hero_image_alt` field. That field is used as the image generation prompt. Images are saved to `assets/images/{category}/{slug}/hero.png` with a sidecar `.txt` file containing the prompt and generation settings.

The script is **resumable** — it skips images that already exist. It adds a 3-second delay between API calls to stay within rate limits.

### Usage

```bash
# Preview what would be generated (no API calls)
node scripts/generate-images-firefly.js --dry-run

# Generate all missing hero images
node scripts/generate-images-firefly.js

# Generate only blog images
node scripts/generate-images-firefly.js --filter blog/

# Generate 5 images max
node scripts/generate-images-firefly.js --limit 5

# Use a style reference image for brand consistency
node scripts/generate-images-firefly.js --style-ref drafts/media/product-nano.jpeg

# Style reference from a URL
node scripts/generate-images-firefly.js --style-ref https://main--arco--froesef.aem.live/path/to/image.png

# Adjust style reference strength (0-100, default 45)
node scripts/generate-images-firefly.js --style-ref ./ref.jpg --style-strength 80

# Save as versioned files (hero-v2.png) for A/B comparison
node scripts/generate-images-firefly.js --version v2

# Generate multiple variations per prompt (1-4)
node scripts/generate-images-firefly.js --variations 3
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | — | Preview prompts and output paths without calling the API |
| `--filter <path>` | — | Only process content files whose path contains this string |
| `--limit <n>` | all | Maximum number of content items to process |
| `--style-ref <path\|url>` | none | Reference image for visual style (local file or URL) |
| `--style-strength <0-100>` | 45 | How strongly the style reference influences output |
| `--version <tag>` | — | Save files as `hero-{tag}.png` instead of `hero.png` |
| `--model <name>` | image5 | Firefly model: `image3`, `image4_standard`, `image4_ultra`, `image5` |
| `--variations <1-4>` | 1 | Number of image variations per prompt |
| `--reasoner <mode>` | quality | Prompt reasoning depth: `quality` or `speed` |
| `--upsampler <type>` | low_creativity | Upscaling strategy: `low_creativity` reduces distortions |

### Style reference

Using `--style-ref` with an existing product photo (e.g. `drafts/media/product-nano.jpeg`) produces images that match the Arco brand palette — dark slate, copper accents, warm cream tones. Without a reference, the script appends a text-based brand style description to each prompt instead.

The reference image is uploaded to Firefly temporary storage (valid for 7 days) and reused for all images in the batch.

### Output structure

```
assets/images/
  blog/
    a-visit-to-our-workshop/
      hero.png          # generated image
      hero.txt          # prompt, settings, seed
      hero-v2.png       # versioned variant
      hero-v2.txt
      hero-v2-var2.png  # second variation (when --variations 2+)
```

### Recommended settings for production

```bash
node scripts/generate-images-firefly.js \
  --style-ref drafts/media/product-nano.jpeg \
  --style-strength 45 \
  --variations 2
```

This uses Image 5 with the quality reasoner and low-creativity upsampler (both defaults), which produces the sharpest results with the fewest anatomy artifacts.
