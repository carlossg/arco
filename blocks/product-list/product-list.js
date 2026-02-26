import { createOptimizedPicture } from '../../scripts/aem.js';

/**
 * Extracts the category string from a product info cell.
 * Looks for an <em> element first, then falls back to the first
 * text node that isn't the product name or price.
 * @param {Element} infoDiv The product info cell
 * @param {string} name The product name (to exclude from search)
 * @returns {string} The category label, or 'Uncategorized'
 */
function getCategory(infoDiv, name) {
  // prefer an <em> tag as the category marker
  const em = infoDiv.querySelector('em');
  if (em) return em.textContent.trim();

  // fallback: scan paragraphs for one that isn't the name or a price
  const paragraphs = [...infoDiv.querySelectorAll('p')];
  const match = paragraphs.find((p) => {
    const text = p.textContent.trim();
    return text && text !== name && !/^\$/.test(text) && !p.querySelector('a');
  });
  return match ? match.textContent.trim() : 'Uncategorized';
}

/**
 * Extracts the product name from a product info cell.
 * Looks for a heading or <strong> element.
 * @param {Element} infoDiv The product info cell
 * @returns {string} The product name
 */
function getName(infoDiv) {
  const heading = infoDiv.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading) return heading.textContent.trim();
  const strong = infoDiv.querySelector('strong');
  if (strong) return strong.textContent.trim();
  return '';
}

/**
 * Extracts the price string from a product info cell.
 * Looks for text starting with "$" or a currency pattern.
 * @param {Element} infoDiv The product info cell
 * @returns {string} The price string, or empty string
 */
function getPrice(infoDiv) {
  const paragraphs = [...infoDiv.querySelectorAll('p')];
  const priceParagraph = paragraphs.find((p) => /^\$[\d,.]+/.test(p.textContent.trim()));
  return priceParagraph ? priceParagraph.textContent.trim() : '';
}

/**
 * Extracts the link element from a product info cell.
 * @param {Element} infoDiv The product info cell
 * @returns {Element|null} The anchor element, or null
 */
function getLink(infoDiv) {
  return infoDiv.querySelector('a');
}

/**
 * Builds a single product card element.
 * @param {Element} row A row from the authored block
 * @returns {Element} The card element
 */
function buildCard(row) {
  const card = document.createElement('li');
  card.className = 'product-list-card';

  const children = [...row.children];
  const imageDiv = children[0];
  const infoDiv = children[1] || children[0];

  const name = getName(infoDiv);
  const category = getCategory(infoDiv, name);
  const price = getPrice(infoDiv);
  const link = getLink(infoDiv);

  card.dataset.category = category.toLowerCase();

  // image
  const imageWrap = document.createElement('div');
  imageWrap.className = 'product-list-card-image';
  const picture = imageDiv.querySelector('picture');
  if (picture) {
    if (link) {
      const imageLink = document.createElement('a');
      imageLink.href = link.href;
      imageLink.append(picture);
      imageWrap.append(imageLink);
    } else {
      imageWrap.append(picture);
    }
  }
  card.append(imageWrap);

  // body
  const body = document.createElement('div');
  body.className = 'product-list-card-body';

  if (category) {
    const badge = document.createElement('span');
    badge.className = 'product-list-category-badge';
    badge.textContent = category;
    body.append(badge);
  }

  if (name) {
    const heading = document.createElement('h3');
    if (link) {
      const nameLink = document.createElement('a');
      nameLink.href = link.href;
      nameLink.textContent = name;
      heading.append(nameLink);
    } else {
      heading.textContent = name;
    }
    body.append(heading);
  }

  if (price) {
    const priceEl = document.createElement('p');
    priceEl.className = 'product-list-price';
    priceEl.textContent = price;
    body.append(priceEl);
  }

  if (link) {
    const cta = document.createElement('a');
    cta.href = link.href;
    cta.className = 'product-list-cta';
    cta.textContent = link.textContent.trim() || 'View Details';
    body.append(cta);
  }

  card.append(body);
  return card;
}

/**
 * Builds the filter bar from a set of category names.
 * @param {string[]} categories Sorted unique category names
 * @param {Element} grid The <ul> containing product cards
 * @returns {Element} The filter bar element
 */
function buildFilterBar(categories, grid) {
  const bar = document.createElement('div');
  bar.className = 'product-list-filters';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Filter products by category');

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'product-list-filter active';
  allBtn.textContent = 'All';
  allBtn.setAttribute('aria-pressed', 'true');
  bar.append(allBtn);

  categories.forEach((cat) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'product-list-filter';
    btn.textContent = cat;
    btn.dataset.category = cat.toLowerCase();
    btn.setAttribute('aria-pressed', 'false');
    bar.append(btn);
  });

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.product-list-filter');
    if (!btn) return;

    bar.querySelectorAll('.product-list-filter').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');

    const filterValue = btn.dataset.category || '';
    const cards = grid.querySelectorAll('.product-list-card');
    cards.forEach((card) => {
      if (!filterValue || card.dataset.category === filterValue) {
        card.classList.remove('product-list-hidden');
      } else {
        card.classList.add('product-list-hidden');
      }
    });
  });

  return bar;
}

/**
 * Loads and decorates the product-list block.
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  const rows = [...block.children];

  // build card list
  const ul = document.createElement('ul');
  ul.className = 'product-list-grid';

  const categorySet = new Set();

  rows.forEach((row) => {
    const card = buildCard(row);
    const cat = card.dataset.category;
    if (cat) categorySet.add(cat);
    ul.append(card);
  });

  // optimise images
  ul.querySelectorAll('picture > img').forEach((img) => {
    const optimized = createOptimizedPicture(img.src, img.alt, false, [{ width: '750' }]);
    img.closest('picture').replaceWith(optimized);
  });

  // sorted categories for consistent filter order
  const categories = [...categorySet].sort((a, b) => a.localeCompare(b));
  const displayCategories = categories.map(
    (cat) => cat.charAt(0).toUpperCase() + cat.slice(1),
  );

  // assemble block
  block.replaceChildren();

  if (displayCategories.length > 1) {
    block.append(buildFilterBar(displayCategories, ul));
  }

  block.append(ul);
}
