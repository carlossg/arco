import {
  buildBlock,
  loadHeader,
  loadFooter,
  decorateButtons,
  decorateIcons,
  decorateSections,
  decorateBlocks,
  decorateTemplateAndTheme,
  waitForFirstImage,
  loadSection,
  loadSections,
  loadCSS,
} from './aem.js';
import { SessionContextManager } from './session-context.js';
import { getAPIEndpoint } from './api-config.js';
import { BLOCK_ALIASES } from './block-aliases.js';
import showWelcomeModal from './welcome-modal.js';
import {
  newPageId,
  getCurrentPageId,
  getCurrentPageUrl,
  streamAndAppendContent,
  replaySpeculativeResult,
  renderStreamedSection,
  createBreadcrumb,
  createMiniLoader,
} from './recommender-stream.js';

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

// Canonical product URL map: short id → full path
const PRODUCT_URLS = {
  primo: '/products/espresso-machines/primo',
  doppio: '/products/espresso-machines/doppio',
  nano: '/products/espresso-machines/nano',
  studio: '/products/espresso-machines/studio',
  'studio-pro': '/products/espresso-machines/studio-pro',
  ufficio: '/products/espresso-machines/ufficio',
  viaggio: '/products/espresso-machines/viaggio',
  automatico: '/products/espresso-machines/automatico',
  filtro: '/products/grinders/filtro',
  preciso: '/products/grinders/preciso',
  macinino: '/products/grinders/macinino',
  zero: '/products/grinders/zero',
  'tamper-set': '/products/accessories/tamper-set',
  'distribution-tool': '/products/accessories/distribution-tool',
  'precision-scale': '/products/accessories/precision-scale',
  'milk-pitcher': '/products/accessories/milk-pitcher',
  'knock-box': '/products/accessories/knock-box',
  'cleaning-kit': '/products/accessories/cleaning-kit',
  'descaling-solution': '/products/accessories/descaling-solution',
  'group-head-brush': '/products/accessories/group-head-brush',
  'espresso-cups': '/products/accessories/espresso-cups',
  'double-wall-glasses': '/products/accessories/double-wall-glasses',
  'bean-vault': '/products/accessories/bean-vault',
  'dosing-cup': '/products/accessories/dosing-cup',
};

/**
 * Fix short product URLs (/products/primo) to canonical form (/products/espresso-machines/primo).
 * @param {Element} container The container to scan for links
 */
function fixProductLinks(container) {
  container.querySelectorAll('a[href^="/products/"]').forEach((a) => {
    const parts = new URL(a.href, window.location.origin).pathname.split('/').filter(Boolean);
    // Only fix short URLs: /products/{id} (2 segments), not /products/{category}/{id} (3 segments)
    if (parts.length === 2) {
      const id = parts[1];
      if (PRODUCT_URLS[id]) a.href = PRODUCT_URLS[id];
    }
  });
}

/**
 * Decorates the main element.
 * @param {Element} main The main element
 */
// eslint-disable-next-line import/prefer-default-export
export function decorateMain(main) {
  // hopefully forward compatible button decoration
  decorateButtons(main);
  decorateIcons(main);
  fixProductLinks(main);
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
  showWelcomeModal();
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
 * Render pre-collected blocks from a quiz prefetch into the DOM.
 * @param {Object} prefetchData Parsed prefetch data from sessionStorage
 * @param {string} query The query string
 */
async function renderPrefetchedBlocks(prefetchData, query) {
  const main = document.querySelector('main');
  if (!main) return;

  main.innerHTML = '<div id="generation-content"></div>';
  const content = main.querySelector('#generation-content');

  const runId = prefetchData.runId || crypto.randomUUID();

  // eslint-disable-next-line no-restricted-syntax
  for (const blockData of prefetchData.blocks) {
    // eslint-disable-next-line no-await-in-loop
    await renderStreamedSection(blockData, content, runId);
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

  if (prefetchData.blocks?.length > 0) {
    import('./feedback-widget.js').then(({ attachFeedbackWidget }) => {
      attachFeedbackWidget(content, {
        runId,
        pageId: getCurrentPageId(),
        sessionId: SessionContextManager.getSessionId(),
        query,
      });
    }).catch(() => { /* best-effort */ });
  }
}

/**
 * Lazily initialize the speculative engine and attach to chips.
 * @param {Element} container The container to find chips in
 */
function attachSpeculativeEngine(container) {
  const chips = container.querySelectorAll('.follow-up-chip[data-query]');
  if (chips.length === 0) return;

  if (window.arcoSpeculativeEngine) {
    window.arcoSpeculativeEngine.attachToChips(chips);
    return;
  }

  import('./speculative-engine.js').then(({ default: createSpeculativeEngine }) => {
    window.arcoSpeculativeEngine = createSpeculativeEngine({
      apiEndpoint: getAPIEndpoint('recommender'),
      getSessionContext: () => SessionContextManager.buildContextParam(),
      getSessionId: () => SessionContextManager.getSessionId(),
      getPageId: getCurrentPageId,
      getPageUrl: getCurrentPageUrl,
    });
    window.arcoSpeculativeEngine.attachToChips(chips);
  });
}

/**
 * Set up the keep-exploring event listener for infinite browsing.
 * Listens for chip clicks and appends new content below.
 */
function initKeepExploring() {
  let isGenerating = false;

  // Attach speculative engine to initial chips
  const content = document.querySelector('#generation-content');
  if (content) attachSpeculativeEngine(content);

  window.addEventListener('arco-keep-exploring', async (e) => {
    if (isGenerating) return;
    isGenerating = true;

    const { query, followUp } = e.detail;
    const genContent = document.querySelector('#generation-content');
    if (!genContent) { isGenerating = false; return; }

    // Check speculative engine for cached result
    const specResult = window.arcoSpeculativeEngine?.getResult(query);

    // Remove the current follow-up container so new sections append after the breadcrumb
    const existingFollowUp = genContent.querySelector('.follow-up-container');
    if (existingFollowUp) existingFollowUp.remove();

    // Insert breadcrumb so user sees their question before the new content
    const breadcrumb = createBreadcrumb(query);
    genContent.appendChild(breadcrumb);

    // Show mini loading indicator
    const loader = createMiniLoader();
    genContent.appendChild(loader);

    // Wait for layout then scroll breadcrumb to top and record its document position
    // as the "question max" — the upper bound for auto-scroll as sections stream in.
    let scrollAnchorY = null;
    requestAnimationFrame(() => {
      scrollAnchorY = breadcrumb.offsetTop;
      breadcrumb.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Called after each section is rendered. Re-scrolls to the breadcrumb so
    // it stays at the top of the viewport as content fills in below.
    // Never scrolls past the question — scrollAnchorY is the hard cap.
    function scrollToStreamedSection() {
      requestAnimationFrame(() => {
        const anchor = scrollAnchorY ?? breadcrumb.offsetTop;
        if (window.scrollY < anchor) {
          window.scrollTo({ top: anchor, behavior: 'smooth' });
        }
      });
    }

    try {
      if (specResult) {
        // Wait for speculative result if in-flight, or use immediately if ready
        const ready = specResult.ready || await specResult.readyPromise;
        if (ready && specResult.responseBuffer.length > 0) {
          await replaySpeculativeResult(specResult.responseBuffer, genContent, {
            query,
            runId: specResult.runId,
            onFirstSection: () => loader.remove(),
            onSection: scrollToStreamedSection,
          });
        } else {
          // Speculative fetch failed, fall back to normal stream
          await streamAndAppendContent(query, genContent, {
            followUp,
            onFirstSection: () => loader.remove(),
            onSection: scrollToStreamedSection,
            onError: (msg) => {
              const p = document.createElement('p');
              p.style.color = '#c00';
              p.textContent = msg || 'Generation failed';
              loader.replaceChildren(p);
            },
          });
        }
      } else {
        await streamAndAppendContent(query, genContent, {
          followUp,
          onFirstSection: () => loader.remove(),
          onSection: scrollToStreamedSection,
          onError: (msg) => {
            const p = document.createElement('p');
            p.style.color = '#c00';
            p.textContent = msg || 'Generation failed';
            loader.replaceChildren(p);
          },
        });
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[KeepExploring] Error:', error);
      const p = document.createElement('p');
      p.style.color = '#c00';
      p.textContent = 'Something went wrong. Please try again.';
      loader.replaceChildren(p);
    }

    // Remove loader only if no error message is showing
    if (loader.parentNode && !loader.querySelector('p')) loader.remove();

    // Attach speculative engine to new chips
    attachSpeculativeEngine(genContent);

    isGenerating = false;
  });
}

/**
 * Render an Arco Recommender page from ?q= or ?query= parameter.
 * Streams NDJSON from the Cloudflare Worker via fetch + ReadableStream.
 * @param {string} [explicitQuery] Optional query override (for SPA transitions)
 */
async function renderArcoRecommenderPage(explicitQuery) {
  const main = document.querySelector('main');
  if (!main) return;

  const params = new URLSearchParams(window.location.search);
  const query = explicitQuery || params.get('q') || params.get('query');

  // Start a new logical page — shared by the initial run and any follow-up clicks
  newPageId(window.location.pathname + window.location.search);

  // Check for prefetched quiz data (one-time use)
  try {
    const raw = sessionStorage.getItem(PREFETCH_KEY);
    sessionStorage.removeItem(PREFETCH_KEY);
    if (raw) {
      const prefetchData = JSON.parse(raw);
      const age = Date.now() - (prefetchData.timestamp || 0);
      if (age < PREFETCH_MAX_AGE_MS && prefetchData.blocks?.length > 0) {
        await renderPrefetchedBlocks(prefetchData, query);
        initKeepExploring();
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

  try {
    await streamAndAppendContent(query, content, {
      onFirstSection: () => loadingState.classList.add('done'),
      onError: (msg) => {
        loadingState.innerHTML = `
          <h1>Something went wrong</h1>
          <p style="color: #c00;">${msg || 'Generation failed'}</p>
          <p><a href="/">Return to homepage</a></p>
        `;
      },
    });

    // Stream finished
    loadingState.remove();

    // Update document title
    const h1 = content.querySelector('h1');
    if (h1) document.title = `${h1.textContent} | Arco`;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Recommender] Fetch error:', error);
    loadingState.innerHTML = `
      <h1>Connection failed</h1>
      <p style="color: #c00;">Unable to connect to the server. Please try again.</p>
      <p><a href="/">Return to homepage</a></p>
    `;
  }

  // Initialize keep-exploring event listener
  initKeepExploring();
}

/**
 * SPA transition to a recommender page without full page reload.
 * Used by the "For You" link to render prefetched content in-place.
 * Checks: speculative engine buffer > sessionStorage > fresh stream.
 * @param {string} query The query to render
 */
async function transitionToRecommender(query) {
  const main = document.querySelector('main');
  if (!main || !query) return;

  // Update URL without navigation
  const urlParams = new URLSearchParams({ q: query });
  const currentPreset = new URLSearchParams(window.location.search).get('preset');
  if (currentPreset) urlParams.set('preset', currentPreset);
  const newUrl = `/?${urlParams.toString()}`;
  window.history.pushState({ arcoRecommender: true }, '', newUrl);

  // New navigation → new logical page
  newPageId(newUrl);

  // Enter recommender mode
  document.body.classList.add('arco-recommender-mode');
  window.scrollTo(0, 0);

  try {
    // Check speculative engine for in-memory result
    const specResult = window.arcoSpeculativeEngine?.getResult(query);
    if (specResult) {
      const ready = specResult.ready || await specResult.readyPromise;
      if (ready && specResult.responseBuffer.length > 0) {
        main.innerHTML = '<div id="generation-content"></div>';
        const content = main.querySelector('#generation-content');
        await replaySpeculativeResult(specResult.responseBuffer, content, {
          query, runId: specResult.runId,
        });
        const h1 = content.querySelector('h1');
        if (h1) document.title = `${h1.textContent} | Arco`;
        initKeepExploring();
        try { sessionStorage.removeItem(FORYOU_PREFETCH_KEY); } catch { /* ignore */ }
        return;
      }
    }

    // Check sessionStorage for For You prefetch
    try {
      const foryouRaw = sessionStorage.getItem(FORYOU_PREFETCH_KEY);
      if (foryouRaw) {
        const prefetchData = JSON.parse(foryouRaw);
        sessionStorage.removeItem(FORYOU_PREFETCH_KEY);
        if (prefetchData.query === query) {
          // NDJSON lines from speculative engine (stored via onReady callback)
          if (prefetchData.ndjsonLines?.length > 0) {
            main.innerHTML = '<div id="generation-content"></div>';
            const content = main.querySelector('#generation-content');
            await replaySpeculativeResult(prefetchData.ndjsonLines, content, { query });
            const h1 = content.querySelector('h1');
            if (h1) document.title = `${h1.textContent} | Arco`;
            initKeepExploring();
            return;
          }
          // Block data from background prefetch (for-you-prefetch.js)
          if (prefetchData.blocks?.length > 0) {
            await renderPrefetchedBlocks(prefetchData, query);
            initKeepExploring();
            return;
          }
        }
      }
    } catch { /* fall through */ }

    // No prefetch available — stream fresh
    await renderArcoRecommenderPage(query);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[transitionToRecommender] Error:', error);
    // Fall back to full page navigation
    window.location.href = `/?${urlParams.toString()}`;
  }
}

// Handle back-button navigation from SPA-transitioned recommender pages
window.addEventListener('popstate', () => {
  if (document.body.classList.contains('arco-recommender-mode') && !isArcoRecommenderRequest()) {
    window.location.reload();
  }
});

// Expose for header.js to call
window.arcoTransitionToRecommender = transitionToRecommender;

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
