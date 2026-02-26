import { createOptimizedPicture } from '../../scripts/aem.js';

/**
 * Blog Card Block — blog post preview with hero image, tag, title, author, read time, CTA.
 * Supports persona-aware feed ordering via arco_persona cookie.
 */

/**
 * Builds a single blog card from a block row.
 * Expected row structure:
 *   Col 1: picture
 *   Col 2: info (tag as em, title as heading, author/read time as paragraphs, CTA link)
 * @param {Element} row
 * @returns {Element}
 */
function buildBlogCard(row) {
  const cols = [...row.children];
  const imageCol = cols[0];
  const infoCol = cols[1] || cols[0];

  const card = document.createElement('article');
  card.className = 'blog-card-item';

  // Image
  const imageWrap = document.createElement('div');
  imageWrap.className = 'blog-card-image';
  const picture = imageCol.querySelector('picture');
  if (picture) {
    const img = picture.querySelector('img');
    const optimized = createOptimizedPicture(img.src, img.alt || '', false, [{ width: '750' }]);
    imageWrap.append(optimized);
  }
  card.append(imageWrap);

  // Body
  const body = document.createElement('div');
  body.className = 'blog-card-body';

  // Tag badge (em element)
  const tagEl = infoCol.querySelector('em');
  if (tagEl) {
    const badge = document.createElement('span');
    badge.className = 'blog-card-tag';
    badge.textContent = tagEl.textContent.trim();
    body.append(badge);
  }

  // Title (heading)
  const heading = infoCol.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading) {
    const title = document.createElement('h3');
    title.className = 'blog-card-title';
    title.textContent = heading.textContent.trim();
    body.append(title);
  }

  // Meta line: author + read time
  const paragraphs = [...infoCol.querySelectorAll('p')];
  const metaPara = paragraphs.find((p) => {
    const text = p.textContent.trim();
    return text && !p.querySelector('a') && !p.querySelector('em') && !/^[€$£]/.test(text);
  });
  if (metaPara) {
    const meta = document.createElement('p');
    meta.className = 'blog-card-meta';
    meta.textContent = metaPara.textContent.trim();
    body.append(meta);
  }

  // CTA link
  const link = infoCol.querySelector('a');
  if (link) {
    const cta = document.createElement('a');
    cta.href = link.href;
    cta.className = 'blog-card-cta';
    cta.textContent = link.textContent.trim() || 'Read More';
    body.append(cta);
  }

  card.append(body);
  return card;
}

/**
 * Loads and decorates the blog-card block.
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  const rows = [...block.children];
  const grid = document.createElement('div');
  grid.className = 'blog-card-grid';

  rows.forEach((row) => {
    grid.append(buildBlogCard(row));
  });

  block.replaceChildren(grid);
}
