import { createOptimizedPicture } from '../../scripts/aem.js';

/**
 * Bundle Card Block — displays a product bundle with items, total price, savings, CTA.
 * Variants: compact | editorial (set via block class)
 *
 * Expected authored structure:
 *   Row 1: Col 1 = picture, Col 2 = bundle info
 *          (heading = name, paragraphs = items, price, savings, CTA)
 */

/**
 * Parses a bundle info cell to extract components.
 * @param {Element} infoCol
 * @returns {object}
 */
function parseBundleInfo(infoCol) {
  const heading = infoCol.querySelector('h1, h2, h3, h4, h5, h6');
  const paragraphs = [...infoCol.querySelectorAll('p')];
  const link = infoCol.querySelector('a');
  const list = infoCol.querySelector('ul, ol');

  // Price: paragraph matching currency pattern
  const pricePara = paragraphs.find((p) => /[€$£]\s*[\d,.]+/.test(p.textContent.trim()));
  // Savings: paragraph containing "save" or "savings"
  const savingsPara = paragraphs.find((p) => /sav(e|ings)/i.test(p.textContent.trim()));
  // Description: first non-price, non-savings, non-link paragraph
  const descPara = paragraphs.find((p) => p !== pricePara && p !== savingsPara && !p.querySelector('a'));

  return {
    name: heading?.textContent.trim() || '',
    price: pricePara?.textContent.trim() || '',
    savings: savingsPara?.textContent.trim() || '',
    description: descPara?.textContent.trim() || '',
    items: list ? [...list.querySelectorAll('li')].map((li) => li.textContent.trim()) : [],
    cta: link ? { href: link.href, text: link.textContent.trim() || 'Shop Bundle' } : null,
  };
}

function buildBundleCard(row) {
  const cols = [...row.children];
  const imageCol = cols[0];
  const infoCol = cols[1] || cols[0];

  const card = document.createElement('article');
  card.className = 'bundle-card-item';

  // Image
  const imageWrap = document.createElement('div');
  imageWrap.className = 'bundle-card-image';
  const picture = imageCol.querySelector('picture');
  if (picture) {
    const img = picture.querySelector('img');
    const optimized = createOptimizedPicture(img.src, img.alt || '', false, [{ width: '750' }]);
    imageWrap.append(optimized);
  }
  card.append(imageWrap);

  // Body
  const info = parseBundleInfo(infoCol);
  const body = document.createElement('div');
  body.className = 'bundle-card-body';

  if (info.name) {
    const name = document.createElement('h3');
    name.className = 'bundle-card-name';
    name.textContent = info.name;
    body.append(name);
  }

  if (info.description) {
    const desc = document.createElement('p');
    desc.className = 'bundle-card-description';
    desc.textContent = info.description;
    body.append(desc);
  }

  // Product list
  if (info.items.length) {
    const list = document.createElement('ul');
    list.className = 'bundle-card-items';
    info.items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      list.append(li);
    });
    body.append(list);
  }

  // Price + savings row
  const priceRow = document.createElement('div');
  priceRow.className = 'bundle-card-pricing';

  if (info.price) {
    const price = document.createElement('span');
    price.className = 'bundle-card-price';
    price.textContent = info.price;
    priceRow.append(price);
  }

  if (info.savings) {
    const savings = document.createElement('span');
    savings.className = 'bundle-card-savings';
    savings.textContent = info.savings;
    priceRow.append(savings);
  }

  body.append(priceRow);

  // CTA
  if (info.cta) {
    const cta = document.createElement('a');
    cta.href = info.cta.href;
    cta.className = 'bundle-card-cta';
    cta.textContent = info.cta.text;
    body.append(cta);
  }

  card.append(body);
  return card;
}

export default async function decorate(block) {
  const rows = [...block.children];
  const grid = document.createElement('div');
  grid.className = 'bundle-card-grid';

  rows.forEach((row) => {
    grid.append(buildBundleCard(row));
  });

  block.replaceChildren(grid);
}
