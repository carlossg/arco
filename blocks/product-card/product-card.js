import { createOptimizedPicture } from '../../scripts/aem.js';

/**
 * Product Card Block — displays product with image, name, price, tagline, persona match, CTA.
 * Variants: compact | full | featured (set via block class)
 */

/**
 * Reads the arco_persona cookie value.
 * @returns {string|null}
 */
function getPersona() {
  const match = document.cookie.match(/(?:^|;\s*)arco_persona=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Builds a single product card element from a block row.
 * Expected row structure:
 *   Col 1: picture
 *   Col 2: product info (name as heading, price, tagline, persona tags, CTA link)
 * @param {Element} row Block row element
 * @param {string|null} persona Current visitor persona
 * @returns {Element}
 */
function buildCard(row, persona) {
  const cols = [...row.children];
  const imageCol = cols[0];
  const infoCol = cols[1] || cols[0];

  const card = document.createElement('article');
  card.className = 'product-card-item';

  // Image
  const imageWrap = document.createElement('div');
  imageWrap.className = 'product-card-image';
  const picture = imageCol.querySelector('picture');
  if (picture) {
    const img = picture.querySelector('img');
    const optimized = createOptimizedPicture(img.src, img.alt || '', false, [{ width: '750' }]);
    imageWrap.append(optimized);
  }
  card.append(imageWrap);

  // Body
  const body = document.createElement('div');
  body.className = 'product-card-body';

  // Name (heading)
  const heading = infoCol.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading) {
    const name = document.createElement('h3');
    name.className = 'product-card-name';
    name.textContent = heading.textContent.trim();
    body.append(name);
  }

  // Price (paragraph starting with € or $)
  const paragraphs = [...infoCol.querySelectorAll('p')];
  const pricePara = paragraphs.find((p) => /^[€$£]/.test(p.textContent.trim()));
  if (pricePara) {
    const price = document.createElement('span');
    price.className = 'product-card-price';
    price.textContent = pricePara.textContent.trim();
    body.append(price);
  }

  // Tagline (first non-price, non-link, non-heading paragraph)
  const taglinePara = paragraphs.find((p) => {
    const text = p.textContent.trim();
    return text && !/^[€$£]/.test(text) && !p.querySelector('a') && !p.querySelector('strong');
  });
  if (taglinePara) {
    const tagline = document.createElement('p');
    tagline.className = 'product-card-tagline';
    tagline.textContent = taglinePara.textContent.trim();
    body.append(tagline);
  }

  // Persona match indicator
  const personaTags = infoCol.querySelector('em');
  if (personaTags && persona) {
    const tags = personaTags.textContent.split(',').map((t) => t.trim().toLowerCase());
    if (tags.includes(persona)) {
      const badge = document.createElement('span');
      badge.className = 'product-card-persona-match';
      badge.textContent = 'Recommended for you';
      badge.setAttribute('aria-label', 'This product matches your brew style profile');
      body.append(badge);
    }
  }

  // CTA link
  const link = infoCol.querySelector('a');
  if (link) {
    const cta = document.createElement('a');
    cta.href = link.href;
    cta.className = 'product-card-cta';
    cta.textContent = link.textContent.trim() || 'View Details';
    body.append(cta);
  }

  card.append(body);
  return card;
}

/**
 * Loads and decorates the product-card block.
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  const persona = getPersona();
  const rows = [...block.children];
  const grid = document.createElement('div');
  grid.className = 'product-card-grid';

  rows.forEach((row) => {
    grid.append(buildCard(row, persona));
  });

  block.replaceChildren(grid);
}
