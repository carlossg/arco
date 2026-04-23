#!/usr/bin/env node
/**
 * Fragment Generator — Path C (modal-first article fragments).
 *
 * Produces clean `.plain.html` article fragments under
 * `fragments/recommender/{stories,experiences}/{slug}.plain.html` for every
 * entry in stories-index.json / experiences-index.json whose slug is NOT
 * already live on aem.live (per the sitemap).
 *
 * Side effect: rewrites each generated entry's `url` in the index to the
 * fragment path and sets `published: true`, so the modal handler in
 * blocks/modal/modal.js can `loadFragment(url)` directly.
 *
 * Already-live entries (slug present in the sitemap) are skipped —
 * their existing `/stories/{slug}` / `/experiences/{slug}` urls keep working.
 *
 * Usage:
 *   node tools/generate-fragments.js          # generate + rewrite index
 *   node tools/generate-fragments.js --dry    # print counts + sample, no writes
 */

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SITEMAP_URL = 'https://main--arco--froesef.aem.live/sitemap.xml';
const DRY = process.argv.includes('--dry');

const FRAGMENTS_ROOT = join(ROOT, 'fragments/recommender');

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraphs(text) {
  if (!text) return '';
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n  ');
}

function findJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return findJsonFiles(full);
    if (entry.endsWith('.json')) return [full];
    return [];
  });
}

function buildSourceMap(contentSubdir) {
  const files = findJsonFiles(join(ROOT, 'content', contentSubdir));
  const map = new Map();
  files.forEach((path) => {
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      if (data.slug) map.set(data.slug, { data, path });
    } catch {
      // Ignore malformed JSON — they won't resolve to a slug anyway.
    }
  });
  return map;
}

async function fetchLiveSlugs(pathPrefix) {
  const res = await fetch(SITEMAP_URL);
  if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status}`);
  const xml = await res.text();
  const re = new RegExp(`${pathPrefix}/([^/<]+)`, 'g');
  const slugs = new Set();
  for (const match of xml.matchAll(re)) {
    if (match[1] && !match[1].endsWith('.xml')) slugs.add(match[1]);
  }
  return slugs;
}

// ── Renderers ──────────────────────────────────────────────────────────────

function renderStory(data) {
  const title = esc(data.title);
  const metaParts = [];
  const authorName = typeof data.author === 'string' ? data.author : data.author?.name;
  if (authorName) metaParts.push(`By ${authorName}`);
  if (data.read_time_minutes) metaParts.push(`${data.read_time_minutes} min read`);
  const meta = metaParts.length ? `<p><em>${esc(metaParts.join(' · '))}</em></p>` : '';
  const intro = data.intro ? `<p>${esc(data.intro)}</p>` : '';

  const bodySections = (data.body || [])
    .filter((s) => s?.content)
    .map((s) => {
      const heading = s.heading ? `<h2>${esc(s.heading)}</h2>` : '';
      return `${heading}\n  ${paragraphs(s.content)}`;
    })
    .join('\n  ');

  const takeaways = Array.isArray(data.key_takeaways) && data.key_takeaways.length
    ? `<h2>Key takeaways</h2>\n  <ul>\n    ${data.key_takeaways.map((t) => `<li>${esc(t)}</li>`).join('\n    ')}\n  </ul>`
    : '';

  const parts = [title && `<h1>${title}</h1>`, meta, intro, bodySections, takeaways]
    .filter(Boolean)
    .join('\n  ');

  return wrapPage(`<div>\n  ${parts}\n</div>`);
}

function renderExperience(data) {
  const title = esc(data.hero_headline || data.title);
  const subtext = data.hero_subtext ? `<p><em>${esc(data.hero_subtext)}</em></p>` : '';
  const intro = data.editorial_intro ? `<p>${esc(data.editorial_intro)}</p>` : '';
  const body = paragraphs(data.editorial_body);
  const archetype = data.experience_archetype
    ? `<p><strong>${esc(data.experience_archetype)}</strong></p>`
    : '';

  const parts = [title && `<h1>${title}</h1>`, archetype, subtext, intro, body]
    .filter(Boolean)
    .join('\n  ');

  return wrapPage(`<div>\n  ${parts}\n</div>`);
}

function wrapPage(inner) {
  return `<body>\n  <header></header>\n  <main>\n    ${inner}\n  </main>\n  <footer></footer>\n</body>\n`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function processIndex({
  indexPath, contentSubdir, pathPrefix, fragmentSubdir, renderer,
}) {
  const indexJson = JSON.parse(readFileSync(indexPath, 'utf-8'));
  const items = indexJson.data || [];
  const sourceMap = buildSourceMap(contentSubdir);
  const liveSlugs = await fetchLiveSlugs(pathPrefix);

  const outDir = join(FRAGMENTS_ROOT, fragmentSubdir);
  if (!DRY) mkdirSync(outDir, { recursive: true });

  let generated = 0;
  let skippedLive = 0;
  let missingSource = 0;
  const samples = [];

  items.forEach((item) => {
    if (!item?.slug) return;
    if (liveSlugs.has(item.slug)) { skippedLive += 1; return; }

    const source = sourceMap.get(item.slug);
    if (!source) { missingSource += 1; return; }

    const html = renderer(source.data);
    const outPath = join(outDir, `${item.slug}.plain.html`);

    if (!DRY) writeFileSync(outPath, html);
    if (samples.length < 2) samples.push({ slug: item.slug, preview: html.slice(0, 160) });

    // Rewrite index entry — fragment becomes the canonical URL for this slug.
    item.url = `/fragments/recommender/${fragmentSubdir}/${item.slug}`;
    item.published = true;

    generated += 1;
  });

  if (!DRY) writeFileSync(indexPath, `${JSON.stringify(indexJson, null, 2)}\n`);

  return {
    indexPath, generated, skippedLive, missingSource, samples, total: items.length,
  };
}

const results = await Promise.all([
  processIndex({
    indexPath: join(ROOT, 'content/stories-index.json'),
    contentSubdir: 'blog',
    pathPrefix: '/stories',
    fragmentSubdir: 'stories',
    renderer: renderStory,
  }),
  processIndex({
    indexPath: join(ROOT, 'content/experiences-index.json'),
    contentSubdir: 'experiences',
    pathPrefix: '/experiences',
    fragmentSubdir: 'experiences',
    renderer: renderExperience,
  }),
]);

results.forEach((r) => {
  console.log(`\n${r.indexPath}`);
  console.log(`  total: ${r.total}`);
  console.log(`  generated: ${r.generated}${DRY ? ' (dry — not written)' : ''}`);
  console.log(`  skipped (already live): ${r.skippedLive}`);
  console.log(`  missing source JSON: ${r.missingSource}`);
  if (r.samples.length) {
    console.log('  sample output:');
    r.samples.forEach((s) => console.log(`    [${s.slug}] ${s.preview.replace(/\n/g, ' ')}...`));
  }
});
