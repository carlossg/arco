import {
  buildBlock,
  loadHeader,
  loadFooter,
  decorateButtons,
  decorateIcons,
  decorateSections,
  decorateBlocks,
  decorateBlock,
  loadBlock,
  decorateTemplateAndTheme,
  waitForFirstImage,
  loadSection,
  loadSections,
  loadCSS,
} from './aem.js';
import { SessionContextManager } from './session-context.js';
import { getAPIEndpoint } from './api-config.js';

/**
 * Builds hero block and prepends to main in a new section.
 * @param {Element} main The container element
 */
function buildHeroBlock(main) {
  const h1 = main.querySelector('h1');
  const picture = main.querySelector('picture');
  // eslint-disable-next-line no-bitwise
  if (h1 && picture && (h1.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_PRECEDING)) {
    // Check if h1 or picture is already inside a hero block
    if (h1.closest('.hero') || picture.closest('.hero')) {
      return; // Don't create a duplicate hero block
    }
    const section = document.createElement('div');
    section.append(buildBlock('hero', { elems: [picture, h1] }));
    main.prepend(section);
  }
}

/**
 * load fonts.css and set a session storage flag
 */
async function loadFonts() {
  await loadCSS(`${window.hlx.codeBasePath}/styles/fonts.css`);
  try {
    if (!window.location.hostname.includes('localhost')) sessionStorage.setItem('fonts-loaded', 'true');
  } catch (e) {
    // do nothing
  }
}

/**
 * Builds a personalization-banner block and prepends to main if persona cookie exists.
 * @param {Element} main The container element
 */
// eslint-disable-next-line no-unused-vars
function buildPersonalizationBanner(main) {
  const hasPersona = document.cookie.match(/(?:^|;\s*)arco_persona=([^;]*)/);
  if (!hasPersona) return;
  // Only add on homepage or pages without an existing banner
  if (main.querySelector('.personalization-banner')) return;
  const section = document.createElement('div');
  section.append(buildBlock('personalization-banner', { elems: [] }));
  main.prepend(section);
}

/**
 * Builds all synthetic blocks in a container element.
 * @param {Element} main The container element
 */
function buildAutoBlocks(main) {
  try {
    // auto load `*/fragments/*` references
    const fragments = [...main.querySelectorAll('a[href*="/fragments/"]')].filter((f) => !f.closest('.fragment'));
    if (fragments.length > 0) {
      // eslint-disable-next-line import/no-cycle
      import('../blocks/fragment/fragment.js').then(({ loadFragment }) => {
        fragments.forEach(async (fragment) => {
          try {
            const { pathname } = new URL(fragment.href);
            const frag = await loadFragment(pathname);
            fragment.parentElement.replaceWith(...frag.children);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Fragment loading failed', error);
          }
        });
      });
    }

    buildHeroBlock(main);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto Blocking failed', error);
  }
}

// Map LLM-generated block types to existing frontend blocks.
// 'false' means strip the block wrapper entirely (render as default content).
const BLOCK_ALIASES = {
  'use-case-cards': 'cards',
  'feature-highlights': 'cards',
  text: false,
};

/**
 * Decorates the main element.
 * @param {Element} main The main element
 */
// eslint-disable-next-line import/prefer-default-export
export function decorateMain(main) {
  // hopefully forward compatible button decoration
  decorateButtons(main);
  decorateIcons(main);
  buildAutoBlocks(main);
  decorateSections(main);

  // Remap aliased block names (e.g. LLM-generated blocks served from DA cache)
  Object.entries(BLOCK_ALIASES).forEach(([alias, target]) => {
    main.querySelectorAll(`.${alias}`).forEach((el) => {
      if (target === false) {
        el.replaceWith(...el.children);
      } else {
        el.classList.replace(alias, target);
      }
    });
  });

  decorateBlocks(main);
}

/**
 * Loads everything needed to get to LCP.
 * @param {Element} doc The container element
 */
async function loadEager(doc) {
  document.documentElement.lang = 'en';
  decorateTemplateAndTheme();
  const main = doc.querySelector('main');
  if (main) {
    decorateMain(main);
    document.body.classList.add('appear');
    await loadSection(main.querySelector('.section'), waitForFirstImage);
  }

  try {
    /* if desktop (proxy for fast connection) or fonts already loaded, load fonts.css */
    if (window.innerWidth >= 900 || sessionStorage.getItem('fonts-loaded')) {
      loadFonts();
    }
  } catch (e) {
    // do nothing
  }
}

/**
 * Loads everything that doesn't need to be delayed.
 * @param {Element} doc The container element
 */
async function loadLazy(doc) {
  loadHeader(doc.querySelector('header'));

  const main = doc.querySelector('main');
  await loadSections(main);

  const { hash } = window.location;
  const element = hash ? doc.getElementById(hash.substring(1)) : false;
  if (hash && element) element.scrollIntoView();

  loadFooter(doc.querySelector('footer'));

  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
  loadFonts();
}

/**
 * Loads everything that happens a lot later,
 * without impacting the user experience.
 */
function loadDelayed() {
  // eslint-disable-next-line import/no-cycle
  window.setTimeout(() => import('./delayed.js'), 3000);
  // load anything that can be postponed to the latest here
}

const PREFETCH_KEY = 'arco-quiz-prefetch';
const PREFETCH_MAX_AGE_MS = 60000;
const FORYOU_PREFETCH_KEY = 'arco-foryou-prefetch';

/**
 * Check if this is an Arco Recommender request (has ?q= or ?query= param)
 */
function isArcoRecommenderRequest() {
  const params = new URLSearchParams(window.location.search);
  return params.has('q') || params.has('query');
}

/**
 * Generate a URL-safe slug from a query
 */
/**
 * Render a streamed section block into the DOM.
 * @param {Object} data NDJSON section line: { type, html, sectionStyle, blockType }
 * @param {Element} content The #generation-content container
 */
async function renderStreamedSection(data, content) {
  const section = document.createElement('div');
  section.className = 'section';
  if (data.sectionStyle && data.sectionStyle !== 'default') {
    section.classList.add(data.sectionStyle);
  }
  section.dataset.sectionStatus = 'initialized';
  section.innerHTML = data.html;

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
 * Render pre-collected blocks from a quiz prefetch into the DOM.
 * @param {Object} prefetchData Parsed prefetch data from sessionStorage
 * @param {string} query The query string
 */
async function renderPrefetchedBlocks(prefetchData, query) {
  const main = document.querySelector('main');
  if (!main) return;

  main.innerHTML = '<div id="generation-content"></div>';
  const content = main.querySelector('#generation-content');

  // eslint-disable-next-line no-restricted-syntax
  for (const blockData of prefetchData.blocks) {
    // eslint-disable-next-line no-await-in-loop
    await renderStreamedSection(blockData, content);
  }

  // Update document title
  const h1 = content.querySelector('h1');
  if (h1) document.title = `${h1.textContent} | Arco`;

  // Save query to session context
  SessionContextManager.addQuery({
    query,
    timestamp: Date.now(),
    intent: 'general',
  });
}

/**
 * Render an Arco Recommender page from ?q= or ?query= parameter.
 * Streams NDJSON from the Cloudflare Worker via fetch + ReadableStream.
 */
async function renderArcoRecommenderPage() {
  const main = document.querySelector('main');
  if (!main) return;

  const params = new URLSearchParams(window.location.search);
  const query = params.get('q') || params.get('query');

  // Check for prefetched quiz data (one-time use)
  try {
    const raw = sessionStorage.getItem(PREFETCH_KEY);
    sessionStorage.removeItem(PREFETCH_KEY);
    if (raw) {
      const prefetchData = JSON.parse(raw);
      const age = Date.now() - (prefetchData.timestamp || 0);
      if (age < PREFETCH_MAX_AGE_MS && prefetchData.blocks?.length > 0) {
        await renderPrefetchedBlocks(prefetchData, query);
        return;
      }
    }
  } catch { /* fall through */ }

  // Check for prefetched "For You" data
  try {
    const foryouRaw = sessionStorage.getItem(FORYOU_PREFETCH_KEY);
    if (foryouRaw) {
      const prefetchData = JSON.parse(foryouRaw);
      if (prefetchData.query === query && prefetchData.blocks?.length > 0) {
        await renderPrefetchedBlocks(prefetchData, query);
        return;
      }
    }
  } catch { /* fall through */ }

  // Clear main and show loading state
  main.innerHTML = `
    <div class="section generating-container arco-recommender">
      <div class="generating-spinner" aria-hidden="true"></div>
      <h1 class="generating-title">Finding recommendations&hellip;</h1>
      <span class="generating-query">&ldquo;${query}&rdquo;</span>
    </div>
    <div id="generation-content"></div>
  `;

  const loadingState = main.querySelector('.generating-container');
  const content = main.querySelector('#generation-content');
  const startTime = Date.now();
  let blockCount = 0;

  // Build session context for POST body
  const sessionContext = SessionContextManager.buildContextParam();

  try {
    const baseUrl = getAPIEndpoint('recommender');
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        context: sessionContext,
      }),
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

      // Process complete NDJSON lines
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

        if (data.type === 'heartbeat') {
          continue; // eslint-disable-line no-continue
        }

        if (data.type === 'section') {
          if (blockCount === 0) loadingState.classList.add('done');
          blockCount += 1;
          // eslint-disable-next-line no-await-in-loop
          await renderStreamedSection(data, content);
        }

        if (data.type === 'suggestions') {
          // Render follow-up suggestion chips
          const followUpSection = document.createElement('div');
          followUpSection.className = 'section follow-up-container';
          const followUpBlock = buildBlock('follow-up', []);
          followUpBlock.dataset.suggestions = JSON.stringify(data.suggestions);
          followUpSection.appendChild(followUpBlock);
          content.appendChild(followUpSection);
          decorateBlock(followUpBlock);
          // eslint-disable-next-line no-await-in-loop
          await loadBlock(followUpBlock);
        }

        if (data.type === 'done') {
          const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
          // eslint-disable-next-line no-console
          console.log(`[Recommender] Complete in ${totalTime}s`, data.timings || {});
        }

        if (data.type === 'error') {
          // eslint-disable-next-line no-console
          console.error('[Recommender] Server error:', data.message);
          loadingState.innerHTML = `
            <h1>Something went wrong</h1>
            <p style="color: #c00;">${data.message || 'Generation failed'}</p>
            <p><a href="/">Return to homepage</a></p>
          `;
        }
      }
    }

    // Stream finished
    loadingState.remove();

    // Update document title
    const h1 = content.querySelector('h1');
    if (h1) document.title = `${h1.textContent} | Arco`;

    // Save query to session context
    SessionContextManager.addQuery({
      query,
      timestamp: Date.now(),
      intent: 'general',
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Recommender] Fetch error:', error);
    if (blockCount === 0) {
      loadingState.innerHTML = `
        <h1>Connection failed</h1>
        <p style="color: #c00;">Unable to connect to the server. Please try again.</p>
        <p><a href="/">Return to homepage</a></p>
      `;
    }
  }
}

async function loadPage() {
  // Check if this is an Arco Recommender request (?q= or ?query=)
  if (isArcoRecommenderRequest()) {
    document.documentElement.lang = 'en';
    decorateTemplateAndTheme();
    document.body.classList.add('appear', 'arco-recommender-mode');
    loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
    loadFonts();
    loadHeader(document.querySelector('header'));
    loadFooter(document.querySelector('footer'));
    await renderArcoRecommenderPage();
    return;
  }

  await loadEager(document);
  await loadLazy(document);
  loadDelayed();
}

loadPage();
