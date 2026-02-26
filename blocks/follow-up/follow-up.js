/**
 * Follow-up Block
 *
 * Renders suggestion chips for next queries.
 * Clicking a chip navigates to /?q=<suggestion>.
 */
export default function decorate(block) {
  // Find all links in the block - these are the suggestion chips
  const links = block.querySelectorAll('a');

  if (links.length === 0) return;

  // Create chips container
  const chipsContainer = document.createElement('div');
  chipsContainer.className = 'follow-up-chips';

  // Add heading if present
  const heading = block.querySelector('h2, h3, h4, p strong');
  if (heading) {
    const label = document.createElement('p');
    label.className = 'follow-up-label';
    label.textContent = heading.textContent;
    chipsContainer.appendChild(label);
  }

  // Create chip buttons from links
  const chipsList = document.createElement('div');
  chipsList.className = 'follow-up-list';

  const currentPreset = new URLSearchParams(window.location.search).get('preset');

  links.forEach((link) => {
    const chip = document.createElement('a');
    chip.className = 'follow-up-chip';
    chip.textContent = link.textContent;

    // Ensure the link uses ?q= format
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

  // Replace block content
  block.textContent = '';
  block.appendChild(chipsContainer);
}
