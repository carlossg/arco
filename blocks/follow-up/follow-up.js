/**
 * Follow-up Block
 *
 * Renders suggestion chips for next queries.
 * Two modes:
 * 1. Authored mode: <a> links in block content -> chip links (CMS-authored)
 * 2. Streamed mode: dataset.suggestions JSON from recommender -> typed Keep Exploring chips
 */

const SUGGESTION_ICONS = {
  buy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  compare: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  explore: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
};

/**
 * Render typed suggestion chips from recommender JSON data.
 * @param {Element} block The follow-up block element
 * @param {Array} suggestions Array of suggestion objects from NDJSON stream
 */
function renderKeepExploring(block, suggestions) {
  const container = document.createElement('div');
  container.className = 'follow-up-keep-exploring';

  const heading = document.createElement('h3');
  heading.className = 'follow-up-heading';
  heading.textContent = 'Keep exploring';
  container.appendChild(heading);

  const chipsList = document.createElement('div');
  chipsList.className = 'follow-up-list';

  const currentPreset = new URLSearchParams(window.location.search).get('preset');

  suggestions.forEach((suggestion) => {
    const { type = 'explore', label, query } = suggestion;
    const isBuy = type === 'buy';

    const chip = document.createElement(isBuy ? 'a' : 'button');
    chip.className = `follow-up-chip chip-${type}`;

    // Icon
    const icon = SUGGESTION_ICONS[type] || SUGGESTION_ICONS.explore;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'follow-up-chip-icon';
    iconSpan.innerHTML = icon;
    chip.appendChild(iconSpan);

    // Label
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    chip.appendChild(labelSpan);

    // AI sparkle for non-buy chips
    if (!isBuy) {
      const sparkle = document.createElement('span');
      sparkle.className = 'follow-up-chip-sparkle';
      sparkle.textContent = '\u2726';
      chip.appendChild(sparkle);
    }

    if (isBuy) {
      // Buy chips link to product page
      const href = suggestion.href || `/products/${suggestion.query}`;
      chip.href = href;
      chip.dataset.type = 'buy';
    } else {
      // AI chips dispatch keep-exploring event
      chip.dataset.query = query || label;
      chip.dataset.type = type;
      chip.dataset.label = label;
      chip.addEventListener('click', () => {
        // Dim this suggestion set and mark clicked chip
        const parentContainer = block.closest('.follow-up-container');
        if (parentContainer) {
          parentContainer.classList.add('used');
          chip.classList.add('active');
        }

        const params = new URLSearchParams(window.location.search);
        if (currentPreset) params.set('preset', currentPreset);

        window.dispatchEvent(new CustomEvent('arco-keep-exploring', {
          detail: {
            query: chip.dataset.query,
            followUp: { type: chip.dataset.type, label: chip.dataset.label },
          },
        }));
      });
    }

    chipsList.appendChild(chip);
  });

  container.appendChild(chipsList);
  block.textContent = '';
  block.appendChild(container);
}

/**
 * Render authored link-based chips (original behavior).
 * @param {Element} block The follow-up block element
 */
function renderAuthoredChips(block) {
  const links = block.querySelectorAll('a');
  if (links.length === 0) return;

  const chipsContainer = document.createElement('div');
  chipsContainer.className = 'follow-up-chips';

  const heading = block.querySelector('h2, h3, h4, p strong');
  if (heading) {
    const label = document.createElement('p');
    label.className = 'follow-up-label';
    label.textContent = heading.textContent;
    chipsContainer.appendChild(label);
  }

  const chipsList = document.createElement('div');
  chipsList.className = 'follow-up-list';

  const currentPreset = new URLSearchParams(window.location.search).get('preset');

  links.forEach((link) => {
    const chip = document.createElement('a');
    chip.className = 'follow-up-chip';
    chip.textContent = link.textContent;

    const { href } = link;
    if (href.includes('?q=') || href.includes('?query=')) {
      const chipUrl = new URL(href, window.location.origin);
      if (currentPreset && !chipUrl.searchParams.has('preset')) {
        chipUrl.searchParams.set('preset', currentPreset);
      }
      chip.href = chipUrl.href;
    } else {
      const params = new URLSearchParams({ q: link.textContent });
      if (currentPreset) params.set('preset', currentPreset);
      chip.href = `/?${params.toString()}`;
    }

    chipsList.appendChild(chip);
  });

  chipsContainer.appendChild(chipsList);
  block.textContent = '';
  block.appendChild(chipsContainer);
}

export default function decorate(block) {
  // Streamed mode: JSON suggestions from recommender
  if (block.dataset.suggestions) {
    try {
      const suggestions = JSON.parse(block.dataset.suggestions);
      if (Array.isArray(suggestions) && suggestions.length > 0) {
        renderKeepExploring(block, suggestions);
        return;
      }
    } catch { /* fall through to authored mode */ }
  }

  // Authored mode: link-based chips
  renderAuthoredChips(block);
}
