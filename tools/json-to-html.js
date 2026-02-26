#!/usr/bin/env node
/**
 * JSON-to-HTML Converter
 * Reads all JSON content files and generates .plain.html draft pages
 * for Adobe Experience Manager Edge Delivery Services.
 *
 * Usage: node tools/json-to-html.js
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONTENT_DIR = join(ROOT, 'content');
const DRAFTS_DIR = join(ROOT, 'drafts');
const DA_BASE = 'https://content.da.live/paolomoz/arco/media';

let totalGenerated = 0;
let totalSkipped = 0;

/**
 * Escapes HTML special characters.
 */
function esc(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generates a placeholder image URL from alt text.
 */
function heroImage(alt, slug) {
  return `${DA_BASE}/${slug || 'placeholder'}.jpeg`;
}

/**
 * Wraps content in a standard EDS page structure.
 */
function wrapPage(bodyContent) {
  return `<body>
  <header></header>
  <main>
${bodyContent}
  </main>
  <footer></footer>
</body>
`;
}

/**
 * Creates a hero section from JSON data.
 */
function heroSection(data) {
  const imgAlt = esc(data.hero_image_alt || data.headline || data.title || '');
  const imgSrc = heroImage(imgAlt, data.slug);
  const headline = esc(data.headline || data.hero_headline || data.title || '');
  const sub = esc(data.subheadline || data.hero_subtext || data.description_short || '');
  const cta = data.cta || data.hero_cta;

  let ctaHtml = '';
  if (cta) {
    ctaHtml = `\n            <p><strong><a href="${esc(cta.url || '#')}">${esc(cta.label || 'Learn More')}</a></strong></p>`;
  }

  return `    <div>
      <div class="hero">
        <div>
          <div>
            <picture>
              <source type="image/webp" srcset="${imgSrc}" media="(min-width: 600px)">
              <img src="${imgSrc}" alt="${imgAlt}" loading="eager" width="1920" height="1080">
            </picture>
            <h1>${headline}</h1>
            <p>${sub}</p>${ctaHtml}
          </div>
        </div>
      </div>
    </div>`;
}

/**
 * Creates body sections from a body array.
 */
function bodySections(body) {
  if (!Array.isArray(body)) return '';
  return body.map((section) => `    <div>
      <h2>${esc(section.heading)}</h2>
      <p>${esc(section.content)}</p>
    </div>`).join('\n');
}

/**
 * Creates a key takeaways section.
 */
function takeawaysSection(takeaways) {
  if (!Array.isArray(takeaways) || !takeaways.length) return '';
  const items = takeaways.map((t) => `        <li>${esc(t)}</li>`).join('\n');
  return `    <div>
      <h2>Key Takeaways</h2>
      <ul>
${items}
      </ul>
    </div>`;
}

/**
 * Creates product cards section from product IDs.
 */
function productCardsSection(productIds, title = 'Related Products') {
  if (!Array.isArray(productIds) || !productIds.length) return '';
  const cards = productIds.map((pid) => {
    const name = pid.replace(/^arco-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return `        <div>
          <div>
            <picture>
              <img src="${DA_BASE}/product-${pid.replace('arco-', '')}.jpeg" alt="Arco ${name}" loading="lazy" width="600" height="450">
            </picture>
          </div>
          <div>
            <h3>${esc(`Arco ${name}`)}</h3>
            <p><a href="/products/pdp-canonical/${esc(pid)}">View Details</a></p>
          </div>
        </div>`;
  }).join('\n');

  return `    <div>
      <h2>${esc(title)}</h2>
      <div class="product-card">
${cards}
      </div>
    </div>`;
}

// ── Content Type Generators ──

function generatePdpCanonical(data) {
  const imgSrc = heroImage(data.hero_image_alt, data.slug);
  const specsRows = data.key_specs
    ? Object.entries(data.key_specs).map(([k, v]) => `        <div>
          <div>${esc(k.replace(/_/g, ' '))}</div>
          <div>${esc(String(v))}</div>
        </div>`).join('\n')
    : '';

  const variantsText = (data.variants || []).map((v) => v.name).join(', ');
  const inBoxItems = (data.whats_in_box || []).map((item) => `        <li>${esc(item)}</li>`).join('\n');

  let content = heroSection(data);
  content += `\n    <div>
      <div class="product-detail">
        <div>
          <div>
            <picture>
              <img src="${imgSrc}" alt="${esc(data.hero_image_alt || data.name)}" loading="eager" width="800" height="600">
            </picture>
          </div>
          <div></div>
        </div>
        <div>
          <div>Name</div>
          <div>${esc(data.name)}</div>
        </div>
        <div>
          <div>Price</div>
          <div>${esc(data.price_display || `€${data.price_eur}`)}</div>
        </div>
        <div>
          <div>Category</div>
          <div>${esc(data.category)}</div>
        </div>
        <div>
          <div>Description</div>
          <div>${esc(data.description_long || data.description_short || '')}</div>
        </div>
        <div>
          <div>Variants</div>
          <div>${esc(variantsText)}</div>
        </div>
        <div>
          <div>Specs</div>
          <div>${Object.entries(data.key_specs || {}).map(([k, v]) => `<p>${esc(k.replace(/_/g, ' '))}: ${esc(String(v))}</p>`).join('\n            ')}</div>
        </div>
      </div>
    </div>`;

  if (data.use_case_headline) {
    content += `\n    <div>
      <h2>${esc(data.use_case_headline)}</h2>
      <p>${esc(data.use_case_body || '')}</p>
    </div>`;
  }

  if (inBoxItems) {
    content += `\n    <div>
      <h2>What's in the Box</h2>
      <ul>
${inBoxItems}
      </ul>
    </div>`;
  }

  content += `\n${productCardsSection((data.pairing_products || []).map((p) => p.product_id || p), 'Pairs Well With')}`;

  return wrapPage(content);
}

function generatePdpPersona(data) {
  let content = heroSection({
    ...data,
    title: data.headline,
    description_short: data.subheadline || data.description_long,
  });

  if (data.description_long) {
    content += `\n    <div>
      <p>${esc(data.description_long)}</p>
    </div>`;
  }

  if (data.use_case_headline) {
    content += `\n    <div>
      <h2>${esc(data.use_case_headline)}</h2>
      <p>${esc(data.use_case_body || '')}</p>
    </div>`;
  }

  if (data.social_proof_quote) {
    const q = data.social_proof_quote;
    content += `\n    <div>
      <div class="quote">
        <div>
          <div>
            <p>${esc(q.quote || q)}</p>
            <p><strong>${esc(q.name || '')}</strong></p>
            <p>${esc(q.location || '')}</p>
          </div>
        </div>
      </div>
    </div>`;
  }

  return wrapPage(content);
}

function generateComparison(data) {
  const products = data.products || [];
  const table = data.comparison_table || {};

  let tableRows = '';
  Object.entries(table).forEach(([key, row]) => {
    tableRows += `        <div>
          <div>${esc(key.replace(/_/g, ' '))}</div>
          <div>${esc(String(row.product_a || row[products[0]] || ''))}</div>
          <div>${esc(String(row.product_b || row[products[1]] || ''))}</div>
        </div>\n`;
  });

  const prodAName = (products[0] || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const prodBName = (products[1] || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  let content = heroSection(data);
  content += `\n    <div>
      <p>${esc(data.comparison_intro || '')}</p>
    </div>`;
  content += `\n    <div>
      <div class="comparison-table">
        <div>
          <div>Feature</div>
          <div>${esc(prodAName)}</div>
          <div>${esc(prodBName)}</div>
        </div>
${tableRows}      </div>
    </div>`;

  if (data.verdict) {
    content += `\n    <div>
      <h2>The Verdict</h2>
      <p>${esc(data.verdict)}</p>
    </div>`;
  }

  return wrapPage(content);
}

function generateRightForYou(data) {
  let content = heroSection({
    ...data,
    title: data.headline,
    description_short: data.intro,
  });

  if (data.perfect_for) {
    const items = data.perfect_for.map((p) => `        <li>${esc(p)}</li>`).join('\n');
    content += `\n    <div>
      <h2>Perfect For</h2>
      <ul>
${items}
      </ul>
    </div>`;
  }

  if (data.not_ideal_for) {
    const items = data.not_ideal_for.map((p) => `        <li>${esc(p)}</li>`).join('\n');
    content += `\n    <div>
      <h2>Not Ideal For</h2>
      <ul>
${items}
      </ul>
    </div>`;
  }

  if (data.common_objections) {
    const faqItems = data.common_objections.map((obj) => `        <div>
          <div>${esc(obj.objection)}</div>
          <div>${esc(obj.honest_answer)}</div>
        </div>`).join('\n');
    content += `\n    <div>
      <h2>Common Questions</h2>
      <div class="accordion">
${faqItems}
      </div>
    </div>`;
  }

  return wrapPage(content);
}

function generateGuide(data) {
  let content = heroSection(data);
  content += `\n    <div>
      <p>${esc(data.intro || '')}</p>
    </div>`;
  content += `\n${bodySections(data.body)}`;
  content += `\n${takeawaysSection(data.key_takeaways)}`;
  content += `\n${productCardsSection(data.related_products)}`;
  return wrapPage(content);
}

function generateExperience(data) {
  let content = heroSection({
    ...data,
    headline: data.hero_headline,
    subheadline: data.hero_subtext,
  });

  content += `\n    <div>
      <p>${esc(data.editorial_intro || '')}</p>
    </div>`;

  if (data.editorial_body) {
    content += `\n    <div>
      <p>${esc(data.editorial_body)}</p>
    </div>`;
  }

  // Product bundle
  if (data.product_bundle?.length) {
    const bundleIds = data.product_bundle.map((p) => p.product_id || p);
    content += `\n${productCardsSection(bundleIds, data.bundle_headline || 'Your Setup')}`;
  }

  // Quiz embed for core experiences
  if (data.quiz_result) {
    content += `\n    <div>
      <h2>Find Your Brew Style</h2>
      <p>Take our 30-second quiz and we'll match you with the perfect setup.</p>
      <div class="quiz">
        <div>
          <div>When do you usually have your first coffee?</div>
          <div>Before 7am, 7–9am, After 9am, I lose track</div>
        </div>
        <div>
          <div>How do you feel about the brewing process?</div>
          <div>I want it fast, I enjoy the ritual, I want to master it, I just want it to work</div>
        </div>
        <div>
          <div>Where do you mostly brew?</div>
          <div>Home kitchen, Home office, Travelling, At the office</div>
        </div>
        <div>
          <div>What's your current setup?</div>
          <div>No machine yet, A capsule/pod machine, A basic espresso machine, A proper espresso setup</div>
        </div>
      </div>
    </div>`;
  }

  return wrapPage(content);
}

function generateBlog(data) {
  const authorLine = data.author
    ? `${data.author.name || ''}, ${data.author.role || ''} · ${data.read_time_minutes || 5} min read`
    : '';

  let content = heroSection(data);
  if (authorLine) {
    content += `\n    <div>
      <p><em>${esc(authorLine)}</em></p>
    </div>`;
  }
  content += `\n    <div>
      <p>${esc(data.intro || '')}</p>
    </div>`;
  content += `\n${bodySections(data.body)}`;
  content += `\n${takeawaysSection(data.key_takeaways)}`;
  content += `\n${productCardsSection(data.related_products)}`;
  return wrapPage(content);
}

function generateTool(data) {
  let content = heroSection(data);

  // Calculator block
  if (data.inputs) {
    const modulePath = `/content/tools/calculators/${data.slug}.js`;
    const inputRows = (data.inputs || []).map((inp) => {
      const configParts = [`type:${inp.type || 'number'}`];
      if (inp.min !== undefined) configParts.push(`min:${inp.min}`);
      if (inp.max !== undefined) configParts.push(`max:${inp.max}`);
      if (inp.step !== undefined) configParts.push(`step:${inp.step}`);
      if (inp.default !== undefined) configParts.push(`default:${inp.default}`);
      if (inp.options) configParts.push(`options:${inp.options.join('|')}`);
      return `        <div>
          <div>${esc(inp.label || inp.id)}</div>
          <div>${configParts.join(', ')}</div>
        </div>`;
    }).join('\n');

    content += `\n    <div>
      <div class="calculator">
        <div>
          <div>Title</div>
          <div>${esc(data.title)}</div>
        </div>
        <div>
          <div>Description</div>
          <div>${esc(data.description || '')}</div>
        </div>
        <div>
          <div>Module</div>
          <div>${esc(modulePath)}</div>
        </div>
${inputRows}
      </div>
    </div>`;
  } else if (data.data) {
    // Pairing guide or maintenance data — render as table/content
    content += `\n    <div>
      <p>${esc(data.description || '')}</p>
    </div>`;

    if (typeof data.data === 'object') {
      const dataStr = JSON.stringify(data.data, null, 2);
      content += `\n    <div>
      <div class="table">
        <div>
          <div>Data</div>
          <div><pre>${esc(dataStr.substring(0, 2000))}</pre></div>
        </div>
      </div>
    </div>`;
    }
  }

  return wrapPage(content);
}

function generateBundle(data) {
  const itemsList = (data.what_you_get_list || data.products || []).map((item) => {
    if (typeof item === 'string') return item;
    return item.product_id ? `${item.product_id} (${item.role || ''})` : JSON.stringify(item);
  });

  let content = heroSection({
    ...data,
    description_short: data.editorial_intro || data.description || '',
  });

  if (data.editorial_body) {
    content += `\n    <div>
      <p>${esc(data.editorial_body)}</p>
    </div>`;
  }

  if (itemsList.length) {
    const bundleItems = itemsList.map((item) => `          <li>${esc(String(item))}</li>`).join('\n');
    content += `\n    <div>
      <div class="bundle-card">
        <div>
          <div>
            <picture>
              <img src="${DA_BASE}/bundle-${data.slug || 'placeholder'}.jpeg" alt="${esc(data.title || '')}" loading="lazy" width="600" height="450">
            </picture>
          </div>
          <div>
            <h3>${esc(data.title || data.headline || '')}</h3>
            <p>${esc(data.price_display || `€${data.total_price_eur || ''}`)}</p>
            ${data.savings_vs_individual_eur ? `<p>Save €${data.savings_vs_individual_eur}</p>` : ''}
            <ul>
${bundleItems}
            </ul>
            <p><strong><a href="#">Shop Bundle</a></strong></p>
          </div>
        </div>
      </div>
    </div>`;
  }

  return wrapPage(content);
}

function generateLocalization(data) {
  return generateExperience(data);
}

// ── Routing ──

function getGenerator(filePath, data) {
  if (filePath.includes('/pdp-canonical/')) return generatePdpCanonical;
  if (filePath.includes('/pdp-persona/')) return generatePdpPersona;
  if (filePath.includes('/comparison/')) return generateComparison;
  if (filePath.includes('/right-for-you/')) return generateRightForYou;
  if (filePath.includes('/guides/')) return generateGuide;
  if (filePath.includes('/experiences/')) return generateExperience;
  if (filePath.includes('/blog/')) return generateBlog;
  if (filePath.includes('/tools/')) return generateTool;
  if (filePath.includes('/bundles/')) return generateBundle;
  if (filePath.includes('/localization/')) return generateLocalization;
  if (filePath.includes('/homepage/')) return generateExperience;
  return null;
}

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
 * Determines the output path for a JSON content file.
 */
function getOutputPath(jsonPath) {
  const rel = relative(CONTENT_DIR, jsonPath);
  const slug = basename(rel, '.json');
  const dir = dirname(rel);

  // Map content paths to draft paths
  let draftPath;
  if (dir.startsWith('products/pdp-canonical')) {
    draftPath = join('products', slug);
  } else if (dir.startsWith('products/pdp-persona')) {
    draftPath = join('products', 'persona', slug);
  } else if (dir.startsWith('products/comparison')) {
    draftPath = join('products', 'comparison', slug);
  } else if (dir.startsWith('products/right-for-you')) {
    draftPath = join('products', 'right-for-you', slug);
  } else if (dir === 'homepage') {
    draftPath = 'index';
  } else {
    draftPath = join(dir, slug);
  }

  return join(DRAFTS_DIR, `${draftPath}.plain.html`);
}

// ── Main ──

function main() {
  console.log('JSON-to-HTML Converter for Arco EDS');
  console.log('====================================\n');

  const jsonFiles = findJsonFiles(CONTENT_DIR);
  // Filter out global data files
  const contentFiles = jsonFiles.filter((f) => !f.includes('/global/'));

  console.log(`Found ${contentFiles.length} content JSON files\n`);

  for (const jsonPath of contentFiles) {
    try {
      const raw = readFileSync(jsonPath, 'utf-8');
      const data = JSON.parse(raw);
      const generator = getGenerator(jsonPath, data);

      if (!generator) {
        console.log(`  SKIP (no generator): ${relative(ROOT, jsonPath)}`);
        totalSkipped += 1;
        continue;
      }

      const html = generator(data);
      const outPath = getOutputPath(jsonPath);

      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, html, 'utf-8');
      console.log(`  OK: ${relative(ROOT, outPath)}`);
      totalGenerated += 1;
    } catch (err) {
      console.error(`  ERROR: ${relative(ROOT, jsonPath)} — ${err.message}`);
      totalSkipped += 1;
    }
  }

  console.log(`\n====================================`);
  console.log(`Generated: ${totalGenerated}`);
  console.log(`Skipped:   ${totalSkipped}`);
  console.log(`Total:     ${contentFiles.length}`);
}

main();
