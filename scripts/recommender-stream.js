/**
 * Recommender streaming primitives.
 *
 * Extracted from scripts.js so multiple callers (the recommender page handler
 * and any block that wants to trigger an inline generation, like
 * keep-exploring) can share the same NDJSON stream + DOM rendering pipeline
 * and the same module-level page-id state.
 */

import {
  buildBlock,
  decorateBlock,
  loadBlock,
  decorateButtons,
  decorateIcons,
} from './aem.js';
import { SessionContextManager } from './session-context.js';
import { getAPIEndpoint } from './api-config.js';
import { BLOCK_ALIASES } from './block-aliases.js';
import { processSectionMetadata } from './section-metadata.js';

// Module-level page id — resets on every new logical page (initial load,
// recommender navigation, or first inline trigger from a block).
// All runs (initial + follow-up clicks) for a single logical page share this id.
let currentPageId = null;
let currentPageUrl = null;

export function newPageId(pageUrl) {
  currentPageId = crypto.randomUUID();
  currentPageUrl = pageUrl;
  return currentPageId;
}

export function getCurrentPageId() { return currentPageId; }
export function getCurrentPageUrl() { return currentPageUrl; }

/**
 * Check if debug mode is active (?debug=true on the URL).
 */
export function isDebugMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get('debug') === 'true';
}

/**
 * Insert a debug placeholder section into the container (before follow-up chips if present).
 * Returns the section element so it can be populated later when the debug event arrives.
 */
function createDebugPlaceholder(container) {
  const section = document.createElement('div');
  section.className = 'section debug-panel-section';
  section.dataset.sectionStatus = 'loading';
  const placeholder = document.createElement('div');
  placeholder.className = 'debug-panel-loading';
  placeholder.textContent = 'Collecting debug info…';
  section.appendChild(placeholder);
  const followUp = container.querySelector('.follow-up-container');
  if (followUp) container.insertBefore(section, followUp);
  else container.appendChild(section);
  return section;
}

/**
 * Populate a debug placeholder section with the rendered debug-panel block.
 * Called when the debug NDJSON event arrives at the end of a stream.
 */
async function renderDebugPanel(debugData, sessionContext, sectionEl) {
  sectionEl.innerHTML = '';
  sectionEl.dataset.sectionStatus = 'initialized';

  const blockEl = document.createElement('div');
  blockEl.className = 'debug-panel block';
  blockEl.dataset.blockName = 'debug-panel';
  blockEl.dataset.blockStatus = 'initialized';
  blockEl.dataset.debugInfo = JSON.stringify({ ...debugData, sessionContext });

  const wrapper = document.createElement('div');
  wrapper.className = 'debug-panel-wrapper';
  wrapper.appendChild(blockEl);
  sectionEl.appendChild(wrapper);
  sectionEl.classList.add('debug-panel-container');

  await loadBlock(blockEl);
  sectionEl.dataset.sectionStatus = 'loaded';
}

/**
 * Render a streamed section block into the DOM.
 * @param {Object} data NDJSON section line: { type, html, sectionStyle, blockType }
 * @param {Element} content The container to insert into
 * @param {string} [runId] If provided, stamped on `section.dataset.runId` so
 *   downstream code (e.g., the feedback widget) can scope to a single run.
 */
export async function renderStreamedSection(data, content, runId) {
  const section = document.createElement('div');
  section.className = 'section';
  if (data.sectionStyle && data.sectionStyle !== 'default') {
    section.classList.add(data.sectionStyle);
  }
  section.dataset.sectionStatus = 'initialized';
  if (runId) section.dataset.runId = runId;
  section.innerHTML = data.html;

  processSectionMetadata(section);

  // Wrap block in wrapper div (EDS pattern)
  const blockEl = section.querySelector('[class]');
  if (blockEl) {
    const origName = blockEl.classList[0];
    const alias = origName in BLOCK_ALIASES ? BLOCK_ALIASES[origName] : origName;
    if (alias === false) {
      blockEl.replaceWith(...blockEl.children);
    } else {
      const blockName = alias;
      if (blockName !== origName) blockEl.classList.replace(origName, blockName);
      const wrapper = document.createElement('div');
      wrapper.className = `${blockName}-wrapper`;
      blockEl.parentNode.insertBefore(wrapper, blockEl);
      wrapper.appendChild(blockEl);
      decorateBlock(blockEl);
      section.classList.add(`${blockName}-container`);
    }
  }

  decorateButtons(section);
  decorateIcons(section);

  // Insert before follow-up section so it always stays at the bottom
  const followUpSection = content.querySelector('.follow-up-container');
  if (followUpSection) {
    content.insertBefore(section, followUpSection);
  } else {
    content.appendChild(section);
  }

  // Load the block (CSS + JS)
  const block = section.querySelector('.block');
  if (block) {
    await loadBlock(block);
  }

  section.dataset.sectionStatus = 'loaded';
  section.style.display = null;
}

/**
 * Create a mini loading indicator for inline content appending.
 * @returns {Element} The loading indicator element
 */
export function createMiniLoader() {
  const loader = document.createElement('div');
  loader.className = 'section follow-up-loading';
  loader.innerHTML = '<div class="follow-up-loading-dot"></div>'
    + '<div class="follow-up-loading-dot"></div>'
    + '<div class="follow-up-loading-dot"></div>';
  return loader;
}

/**
 * Create a conversation breadcrumb element.
 * @param {string} queryText The query text to display
 * @returns {Element} The breadcrumb element
 */
export function createBreadcrumb(queryText) {
  const breadcrumb = document.createElement('div');
  breadcrumb.className = 'section follow-up-breadcrumb';
  const text = document.createElement('span');
  text.className = 'breadcrumb-text';
  text.textContent = `You: “${queryText}”`;
  breadcrumb.appendChild(text);
  return breadcrumb;
}

/**
 * Extract product IDs from a rendered section's links and record them as shown.
 */
function trackSectionContent(section) {
  section.querySelectorAll('a[href*="/products/"]').forEach((link) => {
    const match = link.href.match(/\/products\/[^/]+\/([^/?#]+)/);
    if (match) SessionContextManager.addShownProduct(match[1]);
  });

  const block = section.querySelector('.block');
  const blockType = block ? block.classList[0] : 'default-content';
  const headline = section.querySelector('h1, h2, h3');
  SessionContextManager.addShownSection({
    blockType,
    headline: headline ? headline.textContent.substring(0, 80) : '',
  });
}

/**
 * Render a follow-up suggestions section into a container.
 * @param {Array} items Suggestion items from NDJSON
 * @param {Element} container The target container
 */
async function renderFollowUpSection(items, container) {
  const existing = container.querySelector('.follow-up-container');
  if (existing) existing.remove();

  const followUpSection = document.createElement('div');
  followUpSection.className = 'section follow-up-container';
  const followUpBlock = buildBlock('follow-up', []);
  followUpBlock.dataset.suggestions = JSON.stringify(items);
  followUpSection.appendChild(followUpBlock);
  container.appendChild(followUpSection);
  decorateBlock(followUpBlock);
  await loadBlock(followUpBlock);
}

/**
 * Process a single parsed NDJSON event from the recommender stream.
 *
 * @param {Object} data Parsed NDJSON object
 * @param {Element} container The content container
 * @param {{ blockCount: number, sessionContext?: Object, debugPlaceholder?: Element }} state
 *   Mutable state tracking sections seen across events
 * @param {Object} [options] onFirstSection, onSection, onError callbacks
 */
async function handleNdjsonEvent(data, container, state, options = {}) {
  if (data.type === 'heartbeat') return;

  if (data.type === 'section') {
    if (state.blockCount === 0 && options.onFirstSection) options.onFirstSection();
    state.blockCount += 1;
    await renderStreamedSection(data, container, state.runId);
    const lastSection = container.querySelector('.section:last-of-type');
    if (lastSection) {
      trackSectionContent(lastSection);
      if (options.onSection) options.onSection(lastSection);
    }
  }

  if (data.type === 'suggestions') {
    await renderFollowUpSection(data.items || [], container);
    if (options.onSuggestions) options.onSuggestions(data.items || []);
  }

  if (data.type === 'done' && data.usedProducts) {
    data.usedProducts.forEach((id) => SessionContextManager.addShownProduct(id));
  }

  if (data.type === 'debug' && isDebugMode() && state.debugPlaceholder) {
    await renderDebugPanel(data, state.sessionContext, state.debugPlaceholder);
  }

  if (data.type === 'error') {
    // eslint-disable-next-line no-console
    console.error('[Recommender] Server error:', data.message);
    if (options.onError) options.onError(data.message);
  }
}

/**
 * Stream content from the recommender and append sections to a container.
 * Used for both initial recommender page loads and inline triggers from
 * blocks like keep-exploring.
 *
 * @param {string} query The query to send
 * @param {Element} container The content container to append sections into
 * @param {Object} [options]
 * @param {Object} [options.followUp] Follow-up context { type, label }
 * @param {string} [options.parentRunId] Parent runId for follow-up attribution
 * @param {Function} [options.onFirstSection] Callback when first section arrives
 * @param {Function} [options.onSection] Callback after each section is rendered
 * @param {Function} [options.onSuggestions] Callback when suggestions event arrives
 * @param {Function} [options.onError] Callback on error
 * @returns {Promise<void>}
 */
export async function streamAndAppendContent(query, container, options = {}) {
  const startTime = Date.now();
  const sessionContext = SessionContextManager.buildContextParam();
  const baseUrl = getAPIEndpoint('recommender');
  const runId = crypto.randomUUID();
  const state = { blockCount: 0, runId };

  if (isDebugMode()) {
    state.sessionContext = sessionContext;
    state.debugPlaceholder = createDebugPlaceholder(container);
  }
  const body = {
    query,
    context: sessionContext,
    sessionId: SessionContextManager.getSessionId(),
    pageId: getCurrentPageId(),
    pageUrl: getCurrentPageUrl(),
    runId,
  };
  if (options.followUp) body.followUp = options.followUp;
  if (options.parentRunId) body.parentRunId = options.parentRunId;

  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Server error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    // eslint-disable-next-line no-restricted-syntax
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue; // eslint-disable-line no-continue

      let data;
      try {
        data = JSON.parse(trimmed);
      } catch {
        continue; // eslint-disable-line no-continue
      }

      if (data.type === 'done') {
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        // eslint-disable-next-line no-console
        console.log(`[Recommender] Complete in ${totalTime}s`, data.timings || {});
      }

      // eslint-disable-next-line no-await-in-loop
      await handleNdjsonEvent(data, container, state, options);
    }
  }

  SessionContextManager.addQuery({ query, timestamp: Date.now(), intent: 'general' });
  SessionContextManager.addGeneratedQuery(query);

  // Attach the run-level feedback widget. Loaded async so it never delays
  // first paint or the streaming loop.
  if (state.blockCount > 0) {
    import('./feedback-widget.js').then(({ attachFeedbackWidget }) => {
      attachFeedbackWidget(container, {
        runId,
        pageId: getCurrentPageId(),
        sessionId: SessionContextManager.getSessionId(),
        query,
      });
    }).catch(() => { /* widget is best-effort; never block the run */ });
  }

  return { runId };
}

/**
 * Replay buffered NDJSON lines from a speculative prefetch result.
 * @param {string[]} responseBuffer Buffered NDJSON lines
 * @param {Element} container Target container
 * @param {Object} options Same options as streamAndAppendContent
 * @param {string} [options.runId] runId issued by the speculative fetch.
 *   When provided, sections are stamped with `data-run-id` and the feedback
 *   widget attaches against the matching server-side row. When omitted, a
 *   fresh client UUID is generated so the widget still appears (feedback
 *   will be orphaned from generated_pages — recorded but not joinable).
 */
export async function replaySpeculativeResult(responseBuffer, container, options = {}) {
  const runId = options.runId || crypto.randomUUID();
  const state = {
    blockCount: 0,
    runId,
    sessionContext: options.sessionContext || null,
    debugPlaceholder: isDebugMode() ? createDebugPlaceholder(container) : null,
  };
  // eslint-disable-next-line no-restricted-syntax
  for (const line of responseBuffer) {
    const trimmed = line.trim();
    if (!trimmed) continue; // eslint-disable-line no-continue

    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      continue; // eslint-disable-line no-continue
    }

    // eslint-disable-next-line no-await-in-loop
    await handleNdjsonEvent(data, container, state, options);
  }

  SessionContextManager.addQuery({ query: options.query || '', timestamp: Date.now(), intent: 'general' });
  SessionContextManager.addGeneratedQuery(options.query || '');

  if (state.blockCount > 0) {
    import('./feedback-widget.js').then(({ attachFeedbackWidget }) => {
      attachFeedbackWidget(container, {
        runId,
        pageId: getCurrentPageId(),
        sessionId: SessionContextManager.getSessionId(),
        query: options.query || '',
      });
    }).catch(() => { /* widget is best-effort; never block the replay */ });
  }
}
