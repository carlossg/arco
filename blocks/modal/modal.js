import { loadFragment } from '../fragment/fragment.js';
import {
  buildBlock, decorateBlock, loadBlock, loadCSS,
} from '../../scripts/aem.js';

/*
  This is not a traditional block, so there is no decorate function.
  Instead, links to a /modals/ path are automatically transformed into a modal.
  Other blocks can also use the createModal() and openModal() functions.
*/

export async function createModal(contentNodes) {
  await loadCSS(`${window.hlx.codeBasePath}/blocks/modal/modal.css`);
  const dialog = document.createElement('dialog');
  const dialogContent = document.createElement('div');
  dialogContent.classList.add('modal-content');
  dialogContent.append(...contentNodes);
  dialog.append(dialogContent);

  const closeButton = document.createElement('button');
  closeButton.classList.add('close-button');
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.type = 'button';
  closeButton.innerHTML = '<span class="icon icon-close"></span>';
  closeButton.addEventListener('click', () => dialog.close());
  dialog.prepend(closeButton);

  const block = buildBlock('modal', '');
  document.querySelector('main').append(block);
  decorateBlock(block);
  await loadBlock(block);

  // close on click outside the dialog
  dialog.addEventListener('click', (e) => {
    const {
      left, right, top, bottom,
    } = dialog.getBoundingClientRect();
    const { clientX, clientY } = e;
    if (clientX < left || clientX > right || clientY < top || clientY > bottom) {
      dialog.close();
    }
  });

  dialog.addEventListener('close', () => {
    document.body.classList.remove('modal-open');
    block.remove();
  });

  block.innerHTML = '';
  block.append(dialog);

  return {
    block,
    showModal: () => {
      dialog.showModal();
      // reset scroll position
      setTimeout(() => { dialogContent.scrollTop = 0; }, 0);
      document.body.classList.add('modal-open');
    },
  };
}

export async function openModal(fragmentUrl) {
  const path = fragmentUrl.startsWith('http')
    ? new URL(fragmentUrl, window.location).pathname
    : fragmentUrl;

  const fragment = await loadFragment(path);

  // Append a footer with a link to the canonical full page, for sharing /
  // "give me a real tab" / SEO. Keeps the modal a preview, not a dead end.
  const footer = document.createElement('p');
  footer.className = 'modal-open-full';
  const fullLink = document.createElement('a');
  fullLink.href = path;
  fullLink.textContent = 'Open full article ↗';
  footer.append(fullLink);

  const nodes = [...fragment.childNodes, footer];
  const { showModal } = await createModal(nodes);
  showModal();
}

/**
 * Attach a click handler to an anchor that opens its href as a modal fragment.
 * Preserves cmd/ctrl/shift/middle-click, right-click, and no-JS navigation by
 * only intercepting plain left-click. Falls back to normal navigation on error.
 */
export function attachModalTrigger(anchor) {
  anchor.addEventListener('click', async (e) => {
    if (e.defaultPrevented
      || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey
      || e.button !== 0) return;
    e.preventDefault();
    try {
      await openModal(anchor.getAttribute('href'));
    } catch {
      window.location.href = anchor.href;
    }
  });
}
