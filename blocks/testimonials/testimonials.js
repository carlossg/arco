/**
 * Extracts a numeric star rating from a string.
 * @param {string} text The text to parse
 * @returns {number} Rating between 1 and 5, or 0 if not found
 */
function parseRating(text) {
  const match = text.trim().match(/^([1-5])$/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Builds a star rating element.
 * @param {number} rating The number of filled stars (1-5)
 * @returns {HTMLElement} The star rating container
 */
function buildStarRating(rating) {
  const stars = document.createElement('div');
  stars.classList.add('testimonials-stars');
  stars.setAttribute('aria-label', `${rating} out of 5 stars`);
  stars.setAttribute('role', 'img');

  for (let i = 1; i <= 5; i += 1) {
    const star = document.createElement('span');
    star.classList.add('testimonials-star');
    if (i <= rating) {
      star.classList.add('testimonials-star-filled');
      star.textContent = '\u2605';
    } else {
      star.classList.add('testimonials-star-empty');
      star.textContent = '\u2606';
    }
    stars.append(star);
  }

  return stars;
}

/**
 * Builds an initial-letter avatar when no photo is provided.
 * @param {string} name The customer name
 * @returns {HTMLElement} The avatar element
 */
function buildAvatar(name) {
  const avatar = document.createElement('div');
  avatar.classList.add('testimonials-avatar');
  avatar.setAttribute('aria-hidden', 'true');
  const initial = name ? name.charAt(0).toUpperCase() : '?';
  avatar.textContent = initial;
  return avatar;
}

/**
 * Parses a single testimonial row into its component parts.
 * @param {Element} row The block row element
 * @returns {object} An object with picture, quote, name, and rating
 */
function parseTestimonial(row) {
  const cells = [...row.children];
  let picture = null;
  let contentCell = null;

  if (cells.length >= 2) {
    // Cell 1: photo (optional), Cell 2: content
    const [firstCell, secondCell] = cells;
    const pic = firstCell.querySelector('picture');
    if (pic) {
      picture = pic;
    }
    contentCell = secondCell;
  } else if (cells.length === 1) {
    [contentCell] = cells;
  }

  let quote = '';
  let name = '';
  let rating = 0;

  if (contentCell) {
    // Look for name in strong or heading elements
    const strong = contentCell.querySelector('strong');
    const heading = contentCell.querySelector('h1, h2, h3, h4, h5, h6');
    const nameEl = strong || heading;
    if (nameEl) {
      name = nameEl.textContent.trim();
    }

    // Collect all paragraphs and text nodes
    const paragraphs = [...contentCell.querySelectorAll('p')];

    // Try to find rating: check paragraphs from the end
    for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
      const p = paragraphs[i];
      // Skip paragraphs that contain the name element
      if (!nameEl || !p.contains(nameEl)) {
        const parsed = parseRating(p.textContent);
        if (parsed > 0) {
          rating = parsed;
          p.remove();
          paragraphs.splice(i, 1);
          break;
        }
      }
    }

    // The quote is everything that is not the name heading/strong and not the rating
    // Gather remaining paragraph text that is not the name
    const quoteParts = [];
    paragraphs.forEach((p) => {
      if (nameEl && p.contains(nameEl)) return;
      const text = p.textContent.trim();
      if (text) quoteParts.push(text);
    });
    quote = quoteParts.join(' ');
  }

  return {
    picture, quote, name, rating,
  };
}

/**
 * Builds a single testimonial card element.
 * @param {object} testimonial Parsed testimonial data
 * @returns {HTMLElement} The card list item
 */
function buildCard({
  picture, quote, name, rating,
}) {
  const card = document.createElement('li');
  card.classList.add('testimonials-card');

  // Photo or avatar
  const photoWrapper = document.createElement('div');
  photoWrapper.classList.add('testimonials-photo');
  if (picture) {
    photoWrapper.append(picture);
  } else {
    photoWrapper.append(buildAvatar(name));
  }
  card.append(photoWrapper);

  // Star rating
  if (rating > 0) {
    card.append(buildStarRating(rating));
  }

  // Quote
  if (quote) {
    const blockquote = document.createElement('blockquote');
    blockquote.classList.add('testimonials-quote');
    const p = document.createElement('p');
    p.textContent = quote;
    blockquote.append(p);
    card.append(blockquote);
  }

  // Customer name
  if (name) {
    const nameEl = document.createElement('p');
    nameEl.classList.add('testimonials-name');
    nameEl.textContent = name;
    card.append(nameEl);
  }

  return card;
}

/**
 * Loads and decorates the testimonials block.
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  const rows = [...block.children];
  const ul = document.createElement('ul');
  ul.classList.add('testimonials-list');

  rows.forEach((row) => {
    const testimonial = parseTestimonial(row);
    // Skip rows that aren't actual testimonials — e.g. the heading-only Row 1
    // the recommender block-guide asks for, which otherwise renders as a card
    // containing just the section label.
    if (!testimonial.quote && !testimonial.picture) return;
    ul.append(buildCard(testimonial));
  });

  block.textContent = '';
  if (!ul.children.length) return;
  block.append(ul);
}
