import { createOptimizedPicture } from '../../scripts/aem.js';

/**
 * Experience CTA Block — teaser for collateral experience pages.
 * Displays image, archetype label, headline, hook, and CTA.
 *
 * Expected authored structure:
 *   Row 1: Col 1 = picture, Col 2 = info
 *          (em = archetype label, heading = headline, p = hook, a = CTA)
 *   (Multiple rows = multiple CTAs rendered in a row)
 */

function buildExperienceCTA(row) {
  const cols = [...row.children];
  const imageCol = cols[0];
  const infoCol = cols[1] || cols[0];

  const card = document.createElement('article');
  card.className = 'experience-cta-item';

  // Image
  const imageWrap = document.createElement('div');
  imageWrap.className = 'experience-cta-image';
  const picture = imageCol.querySelector('picture');
  if (picture) {
    const img = picture.querySelector('img');
    const optimized = createOptimizedPicture(img.src, img.alt || '', false, [{ width: '750' }]);
    imageWrap.append(optimized);
  }
  card.append(imageWrap);

  // Overlay content
  const overlay = document.createElement('div');
  overlay.className = 'experience-cta-overlay';

  // Archetype label
  const archetype = infoCol.querySelector('em');
  if (archetype) {
    const label = document.createElement('span');
    label.className = 'experience-cta-archetype';
    label.textContent = archetype.textContent.trim();
    overlay.append(label);
  }

  // Headline
  const heading = infoCol.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading) {
    const h = document.createElement('h3');
    h.className = 'experience-cta-headline';
    h.textContent = heading.textContent.trim();
    overlay.append(h);
  }

  // Hook text
  const paragraphs = [...infoCol.querySelectorAll('p')];
  const hookPara = paragraphs.find((p) => !p.querySelector('a') && !p.querySelector('em'));
  if (hookPara) {
    const hook = document.createElement('p');
    hook.className = 'experience-cta-hook';
    hook.textContent = hookPara.textContent.trim();
    overlay.append(hook);
  }

  // CTA
  const link = infoCol.querySelector('a');
  if (link) {
    const cta = document.createElement('a');
    cta.href = link.href;
    cta.className = 'experience-cta-link';
    cta.textContent = link.textContent.trim() || 'Explore';
    overlay.append(cta);
  }

  card.append(overlay);
  return card;
}

export default async function decorate(block) {
  const rows = [...block.children];
  const grid = document.createElement('div');
  grid.className = 'experience-cta-grid';

  rows.forEach((row) => {
    grid.append(buildExperienceCTA(row));
  });

  block.replaceChildren(grid);
}
