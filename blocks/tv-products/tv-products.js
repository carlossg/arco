/**
 * TV Products Block — 10-foot product showcase for the Google TV experience.
 *
 * Renders 2–3 products side-by-side as large cards (image, name, price, a
 * one-line "why"), with the recommended product highlighted. Built for
 * lean-back viewing from across a room — big visuals, minimal text.
 *
 * Expected structure (one row per product, two cells each):
 *   <div class="tv-products" data-recommended="Primo">
 *     <div>
 *       <div><picture>…</picture></div>   ← image cell
 *       <div><h3>Primo</h3><p>$899</p><p>Best overall</p></div>  ← info cell
 *     </div>
 *     … up to 3 products
 *   </div>
 *
 * `data-recommended` carries the product name to highlight (case-insensitive,
 * matched against each card's name). Authored 2-product tables work too.
 */

/**
 * Normalize a product name for loose matching ("Arco Primo" ≈ "primo").
 */
function normalizeName(str) {
  return (str || '')
    .toLowerCase()
    .replace(/^arco\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export default async function decorate(block) {
  const recommended = normalizeName(block.dataset.recommended || '');
  const rows = [...block.children];

  const cards = rows.map((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return null;

    const [imageCell, infoCell] = cells;
    const picture = imageCell.querySelector('picture');
    const heading = infoCell.querySelector('h1, h2, h3, h4, h5, h6');
    const name = heading ? heading.textContent.trim() : '';

    const card = document.createElement('div');
    card.className = 'tv-products-card';

    const media = document.createElement('div');
    media.className = 'tv-products-media';
    if (picture) media.append(picture);
    card.append(media);

    const body = document.createElement('div');
    body.className = 'tv-products-body';
    // Move the info cell's children (name, price, tagline) into the card body.
    body.append(...infoCell.childNodes);
    card.append(body);

    if (name && recommended && normalizeName(name) === recommended) {
      card.classList.add('tv-products-recommended');
      const badge = document.createElement('span');
      badge.className = 'tv-products-badge';
      badge.textContent = 'Recommended';
      media.append(badge);
    }

    return card;
  }).filter(Boolean);

  if (cards.length === 0) return;

  const grid = document.createElement('div');
  grid.className = 'tv-products-grid';
  grid.dataset.count = String(cards.length);
  grid.append(...cards);

  block.replaceChildren(grid);
}
