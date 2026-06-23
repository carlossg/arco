/**
 * Keep-Exploring Block
 *
 * Drop-in panel that lets a user step into the AI recommender flow from any
 * authored page. Authored chips (curated by the author as table rows) render
 * immediately. If the author sets `suggested-items=N` (1–3), N additional
 * dynamic chips are fetched from /api/suggest based on the user's session
 * browsing history.
 *
 * Clicking a chip streams new generated sections inline beneath the block,
 * reusing the same /api/generate pipeline as the recommender page.
 */

import { SessionContextManager } from '../../scripts/session-context.js';
import { getAPIEndpoint } from '../../scripts/api-config.js';
import {
  streamAndAppendContent,
  replaySpeculativeResult,
  newPageId,
  getCurrentPageId,
  createBreadcrumb,
  createMiniLoader,
} from '../../scripts/recommender-stream.js';

const KNOWN_CONFIG_KEYS = new Set(['heading', 'suggested-items']);
const MAX_DYNAMIC = 3;

/**
 * Parse the authored block into config + items.
 * Rows with two cells where the first cell text matches a known config key
 * are config; otherwise they're chip items. An item row may be plain text or
 * contain an <a> link (in which case the link's text is the label and a
 * `/?q=` href is preserved as the query).
 */
function parseBlockContent(block) {
  const config = {};
  const items = [];

  [...block.children].forEach((row) => {
    const cells = [...row.children];
    if (cells.length === 2) {
      const key = cells[0].textContent.trim().toLowerCase();
      if (KNOWN_CONFIG_KEYS.has(key)) {
        config[key] = cells[1].textContent.trim();
        return;
      }
    }
    const cell = cells[0];
    if (!cell) return;
    const link = cell.querySelector('a');
    let label;
    let query;
    if (link) {
      label = link.textContent.trim();
      try {
        const url = new URL(link.href, window.location.origin);
        const q = url.searchParams.get('q') || url.searchParams.get('query');
        query = q || label;
      } catch {
        query = label;
      }
    } else {
      label = cell.textContent.trim();
      query = label;
    }
    if (label) items.push({ label, query, source: 'authored' });
  });

  return { config, items };
}

function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

const SPARKLE = '✦';

/**
 * Build a chip button. Authored items are <button> by default; skeleton items
 * are non-interactive placeholders.
 */
function buildChip({
  label, query, source = 'authored', skeleton = false,
}) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'keep-exploring-chip';
  chip.dataset.source = source;
  if (skeleton) {
    chip.classList.add('skeleton');
    chip.setAttribute('aria-hidden', 'true');
    chip.tabIndex = -1;
    chip.innerHTML = '<span class="keep-exploring-chip-skeleton-bar"></span>';
    return chip;
  }
  chip.dataset.query = query;
  chip.dataset.label = label;
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  chip.appendChild(labelSpan);
  if (source === 'dynamic') {
    const sparkle = document.createElement('span');
    sparkle.className = 'keep-exploring-chip-sparkle';
    sparkle.textContent = SPARKLE;
    chip.appendChild(sparkle);
  }
  return chip;
}

/**
 * Render the panel: heading + chip list (authored chips + N skeletons).
 * Replaces the block's children in place.
 */
function renderShell(block, heading, items, dynamicCount) {
  const panel = document.createElement('div');
  panel.className = 'keep-exploring-panel';

  const headingEl = document.createElement('h3');
  headingEl.className = 'keep-exploring-heading';
  headingEl.textContent = heading;
  panel.appendChild(headingEl);

  const list = document.createElement('div');
  list.className = 'keep-exploring-list';
  items.forEach((item) => list.appendChild(buildChip(item)));
  for (let i = 0; i < dynamicCount; i += 1) {
    list.appendChild(buildChip({ skeleton: true, source: 'dynamic' }));
  }
  panel.appendChild(list);

  block.textContent = '';
  block.appendChild(panel);
}

/**
 * Create or reuse the inline content section that holds streamed results.
 * The section sits immediately after the keep-exploring block's section
 * wrapper so streamed content appears beneath the panel and above whatever
 * follows on the page.
 */
function getOrCreateResultsSection(block) {
  const blockSection = block.closest('.keep-exploring-container') || block.closest('.section');
  if (!blockSection) return null;

  let results = blockSection.nextElementSibling;
  if (results && results.classList.contains('keep-exploring-content')) {
    return results;
  }
  results = document.createElement('div');
  results.className = 'section keep-exploring-content';
  blockSection.insertAdjacentElement('afterend', results);
  return results;
}

let isStreaming = false;

async function triggerInlineGeneration(block, query, label) {
  if (isStreaming) return;
  isStreaming = true;

  const panel = block.querySelector('.keep-exploring-panel');
  const clickedChip = block.querySelector(
    `.keep-exploring-chip[data-query="${CSS.escape(query)}"]`,
  );
  if (clickedChip) clickedChip.classList.add('active');
  if (panel) panel.classList.add('used');

  // Hide skeletons / dynamic chips that have not been clicked. Once the user
  // has committed to a query, the streamed `suggestions` event will provide
  // the next round of chips — keeping our own dynamic chips around would be
  // a duplicate suggestion bar.
  block.querySelectorAll('.keep-exploring-chip.skeleton, .keep-exploring-chip[data-source="dynamic"]')
    .forEach((c) => {
      if (!c.classList.contains('active')) c.style.display = 'none';
    });

  const results = getOrCreateResultsSection(block);
  if (!results) {
    isStreaming = false;
    return;
  }

  // Drop any stale follow-up chips from a previous turn so the new content
  // appends after the new breadcrumb.
  const staleFollowUp = results.querySelector('.follow-up-container');
  if (staleFollowUp) staleFollowUp.remove();

  const breadcrumb = createBreadcrumb(label || query);
  results.appendChild(breadcrumb);

  const loader = createMiniLoader();
  results.appendChild(loader);

  // Anchor-cap auto-scroll: capture breadcrumb's offsetTop once; only scroll
  // while the user is above the anchor (mirrors the recommender page's logic).
  let scrollAnchorY = null;
  requestAnimationFrame(() => {
    scrollAnchorY = breadcrumb.offsetTop;
    breadcrumb.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function scrollToStreamedSection() {
    requestAnimationFrame(() => {
      const anchor = scrollAnchorY ?? breadcrumb.offsetTop;
      if (window.scrollY < anchor) {
        window.scrollTo({ top: anchor, behavior: 'smooth' });
      }
    });
  }

  // Ensure the worker gets a stable pageId so analytics can attribute runs
  // back to the originating product/blog page.
  if (!getCurrentPageId()) {
    newPageId(window.location.pathname + window.location.search);
  }

  // If the user hovered the chip long enough for the speculative engine to
  // prefetch this query, replay the buffered NDJSON instead of refetching.
  const specResult = window.arcoSpeculativeEngine?.getResult(query);

  try {
    if (specResult) {
      const ready = specResult.ready || await specResult.readyPromise;
      if (ready && specResult.responseBuffer.length > 0) {
        await replaySpeculativeResult(specResult.responseBuffer, results, {
          query,
          runId: specResult.runId,
          onFirstSection: () => loader.remove(),
          onSection: scrollToStreamedSection,
        });
      } else {
        await streamAndAppendContent(query, results, {
          followUp: { type: 'explore', label: label || query },
          onFirstSection: () => loader.remove(),
          onSection: scrollToStreamedSection,
          onError: (msg) => {
            const p = document.createElement('p');
            p.className = 'keep-exploring-error';
            p.textContent = msg || 'Generation failed';
            loader.replaceChildren(p);
          },
        });
      }
    } else {
      await streamAndAppendContent(query, results, {
        followUp: { type: 'explore', label: label || query },
        onFirstSection: () => loader.remove(),
        onSection: scrollToStreamedSection,
        onError: (msg) => {
          const p = document.createElement('p');
          p.className = 'keep-exploring-error';
          p.textContent = msg || 'Generation failed';
          loader.replaceChildren(p);
        },
      });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[KeepExploring] Stream error:', error);
    const p = document.createElement('p');
    p.className = 'keep-exploring-error';
    p.textContent = 'Something went wrong. Please try again.';
    loader.replaceChildren(p);
  }

  if (loader.parentNode && !loader.querySelector('p')) loader.remove();

  isStreaming = false;
}

function attachChipHandlers(block) {
  block.addEventListener('click', (e) => {
    const chip = e.target.closest('.keep-exploring-chip');
    if (!chip || chip.classList.contains('skeleton')) return;
    if (!chip.dataset.query) return;
    e.preventDefault();
    triggerInlineGeneration(block, chip.dataset.query, chip.dataset.label);
  });
}

/**
 * Lazy-init the shared speculative engine and attach hover/touch listeners
 * to the block's chips. Called once after the initial render and again after
 * dynamic suggestions land. Hovering a chip with enough confidence kicks off
 * a background /api/generate stream, buffered for instant replay on click.
 */
function attachSpeculativeEngine(block) {
  const chips = block.querySelectorAll('.keep-exploring-chip[data-query]');
  if (chips.length === 0) return;

  if (window.arcoSpeculativeEngine) {
    window.arcoSpeculativeEngine.attachToChips(chips);
    return;
  }

  import('../../scripts/speculative-engine.js').then(({ default: createSpeculativeEngine }) => {
    if (!window.arcoSpeculativeEngine) {
      window.arcoSpeculativeEngine = createSpeculativeEngine({
        apiEndpoint: getAPIEndpoint('recommender'),
        getSessionContext: () => SessionContextManager.buildContextParam(),
        getSessionId: () => SessionContextManager.getSessionId(),
        getPageId: getCurrentPageId,
        getPageUrl: () => window.location.pathname + window.location.search,
      });
    }
    window.arcoSpeculativeEngine.attachToChips(chips);
  });
}

/**
 * Replace skeleton chips with real LLM-generated chips. Silently no-ops on
 * any failure — authored chips remain usable.
 */
async function fetchDynamicSuggestions(block, count, authoredItems) {
  const list = block.querySelector('.keep-exploring-list');
  if (!list) return;
  const skeletons = [...list.querySelectorAll('.keep-exploring-chip.skeleton')];
  if (skeletons.length === 0) return;

  const removeSkeletons = () => skeletons.forEach((s) => s.remove());

  try {
    const baseUrl = getAPIEndpoint('recommender');
    const body = {
      pageUrl: window.location.pathname,
      pageTitle: document.title,
      context: SessionContextManager.buildContextParam(),
      excludeQueries: authoredItems.map((i) => i.query),
      count,
    };
    const response = await fetch(`${baseUrl}/api/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      removeSkeletons();
      return;
    }
    const data = await response.json();
    const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
    if (suggestions.length === 0) {
      removeSkeletons();
      return;
    }
    skeletons.forEach((skeleton, idx) => {
      const s = suggestions[idx];
      if (!s || !s.label) {
        skeleton.remove();
        return;
      }
      const chip = buildChip({
        label: s.label,
        query: s.query || s.label,
        source: 'dynamic',
      });
      skeleton.replaceWith(chip);
    });
    // Re-attach engine to pick up the freshly-revealed dynamic chips
    attachSpeculativeEngine(block);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[KeepExploring] Suggest fetch failed:', error);
    removeSkeletons();
  }
}

export default function decorate(block) {
  // Bail out on recommender pages — the streamed follow-up bar already covers
  // this role and authoring this block there would just create duplicate UI.
  if (document.body.classList.contains('arco-recommender-mode')) {
    block.remove();
    return;
  }

  const { config, items } = parseBlockContent(block);
  const heading = config.heading || 'Keep exploring';
  const dynamicCount = clamp(parseInt(config['suggested-items'], 10), 0, MAX_DYNAMIC);

  if (items.length === 0 && dynamicCount === 0) {
    block.remove();
    return;
  }

  renderShell(block, heading, items, dynamicCount);
  attachChipHandlers(block);
  attachSpeculativeEngine(block);

  if (dynamicCount > 0) {
    fetchDynamicSuggestions(block, dynamicCount, items);
  }
}
