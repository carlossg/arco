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
import { ARCO_RECOMMENDER_URL } from './api-config.js';

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
    buildPersonalizationBanner(main);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto Blocking failed', error);
  }
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
  buildAutoBlocks(main);
  decorateSections(main);
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

/**
 * Valid recommender presets (must match model-factory-google.ts MODEL_PRESETS)
 */
const VALID_PRESETS = [
  'production',
  'gemini-3-pro', 'gemini-3-flash',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
  'llama-3.3-70b-instruct-maas',
  'gemini-3-mixed', 'gemini-2.5-mixed', 'gemini-2.0-mixed',
  'llama-3.2-3b', 'mistral-small',
  'gemma-3-4b', 'gemma-3-12b',
];

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
function generateSlug(query) {
  const slug = query
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);

  let hash = 0;
  const str = query + Date.now();
  for (let i = 0; i < str.length; i += 1) {
    const char = str.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) - hash) + char;
    // eslint-disable-next-line no-bitwise
    hash &= hash;
  }
  const hashStr = Math.abs(hash).toString(36).slice(0, 6);
  return `${slug}-${hashStr}`;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Persist generated page to DA
 */
async function persistToDA(query, blocks, intent) {
  try {
    // eslint-disable-next-line no-console
    console.log('[Recommender] Persisting page to DA...');

    const response = await fetch(`${ARCO_RECOMMENDER_URL}/api/persist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, blocks, intent }),
    });

    const result = await response.json();

    if (result.success && result.urls) {
      // eslint-disable-next-line no-console
      console.log('[Recommender] Page published:', result.urls.live);

      window.dispatchEvent(new CustomEvent('page-published', {
        detail: {
          url: result.urls.live,
          path: result.path,
        },
      }));

      return result;
    }
    // eslint-disable-next-line no-console
    console.error('[Recommender] Persist failed:', result.error);
    return null;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Recommender] Persist error:', error);
    return null;
  }
}

/**
 * Render an Arco Recommender page from ?q= or ?query= parameter
 * Uses the recommender service with Gemini reasoning
 */
async function renderArcoRecommenderPage() {
  const main = document.querySelector('main');
  if (!main) return;

  const params = new URLSearchParams(window.location.search);
  const query = params.get('q') || params.get('query');
  const preset = params.get('preset') || 'production';

  // Validate preset
  if (!VALID_PRESETS.includes(preset)) {
    main.innerHTML = `
      <div class="section generation-error">
        <h2>Unknown preset: &ldquo;${preset}&rdquo;</h2>
        <p>Try one of: ${VALID_PRESETS.map((p) => `<a href="/?q=${encodeURIComponent(query)}&amp;preset=${p}">${p}</a>`).join(', ')}</p>
      </div>
    `;
    return;
  }

  const slug = generateSlug(query);

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

  // Connect to SSE stream with session context
  const contextParam = SessionContextManager.buildEncodedContextParam();
  const streamUrl = `${ARCO_RECOMMENDER_URL}/generate?query=${encodeURIComponent(query)}&slug=${encodeURIComponent(slug)}&preset=${encodeURIComponent(preset)}&ctx=${contextParam}`;
  const eventSource = new EventSource(streamUrl);
  let blockCount = 0;
  const generatedBlocks = [];
  const startTime = Date.now();

  eventSource.addEventListener('block-content', async (e) => {
    const data = JSON.parse(e.data);

    // Hide loading state after first content block
    if (blockCount === 0) {
      loadingState.classList.add('done');
    }
    blockCount += 1;

    // Store for persistence
    generatedBlocks.push({ html: data.html, sectionStyle: data.sectionStyle });

    // Create section and add content
    const section = document.createElement('div');
    section.className = 'section';
    if (data.sectionStyle && data.sectionStyle !== 'default') {
      section.classList.add(data.sectionStyle);
    }
    section.dataset.sectionStatus = 'initialized';
    section.innerHTML = data.html;

    // Store original src for images
    section.querySelectorAll('img[data-gen-image]').forEach((img) => {
      img.dataset.originalSrc = img.getAttribute('src');
    });

    // Wrap block in wrapper div (EDS pattern)
    const blockEl = section.querySelector('[class]');
    if (blockEl) {
      const blockName = blockEl.classList[0];
      const wrapper = document.createElement('div');
      wrapper.className = `${blockName}-wrapper`;
      blockEl.parentNode.insertBefore(wrapper, blockEl);
      wrapper.appendChild(blockEl);
      decorateBlock(blockEl);
      section.classList.add(`${blockName}-container`);
    }

    decorateButtons(section);
    decorateIcons(section);

    content.appendChild(section);

    // Load the block (CSS + JS)
    const block = section.querySelector('.block');
    if (block) {
      await loadBlock(block);
    }

    section.dataset.sectionStatus = 'loaded';
    section.style.display = null;
  });

  eventSource.addEventListener('block-rationale', (e) => {
    const data = JSON.parse(e.data);
    // eslint-disable-next-line no-console
    console.log(`[Recommender] Block rationale for ${data.blockType}:`, data.rationale);
  });

  eventSource.addEventListener('image-ready', (e) => {
    const data = JSON.parse(e.data);
    const { imageId, url } = data;

    let resolvedUrl = url;
    if (url && url.startsWith('/')) {
      resolvedUrl = `${ARCO_RECOMMENDER_URL}${url}`;
    }

    const img = content.querySelector(`img[data-gen-image="${imageId}"]`);
    if (img && resolvedUrl) {
      const originalUrl = img.dataset.originalSrc;
      const section = img.closest('.section');
      const imgParent = img.parentNode;

      const cacheBustUrl = resolvedUrl.includes('?')
        ? `${resolvedUrl}&_t=${Date.now()}`
        : `${resolvedUrl}?_t=${Date.now()}`;

      const newImg = document.createElement('img');
      newImg.src = cacheBustUrl;
      newImg.alt = img.alt || '';
      newImg.className = img.className;
      if (img.loading) newImg.loading = img.loading;
      newImg.dataset.genImage = imageId;
      newImg.classList.add('loaded');

      if (imgParent) {
        imgParent.replaceChild(newImg, img);
      }

      // Update stored HTML
      if (section && originalUrl) {
        const sectionIndex = Array.from(content.children).indexOf(section);
        if (sectionIndex >= 0 && generatedBlocks[sectionIndex]) {
          generatedBlocks[sectionIndex].html = generatedBlocks[sectionIndex].html.replace(
            new RegExp(escapeRegExp(originalUrl), 'g'),
            resolvedUrl,
          );
        }
      }
    }
  });

  eventSource.addEventListener('generation-complete', (e) => {
    eventSource.close();
    loadingState.remove();
    const data = JSON.parse(e.data);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    // eslint-disable-next-line no-console
    console.log(`[Recommender] Complete in ${totalTime}s`, data);

    // Update document title
    const h1 = content.querySelector('h1');
    if (h1) {
      document.title = `${h1.textContent} | Arco`;
    }

    // Save query to session context
    SessionContextManager.addQuery({
      query,
      timestamp: Date.now(),
      intent: data.intent?.intentType || 'general',
      entities: data.intent?.entities || { products: [], coffeeTerms: [], goals: [] },
      generatedPath: `/discover/${slug}`,
      recommendedProducts: data.recommendations?.products || [],
      recommendedBrewGuides: data.recommendations?.brewGuides || [],
      blockTypes: data.recommendations?.blockTypes || [],
      journeyStage: data.reasoning?.journeyStage || 'exploring',
      confidence: data.reasoning?.confidence || 0.5,
      nextBestAction: data.reasoning?.nextBestAction || '',
    });

    // Auto-persist to DA
    if (generatedBlocks.length > 0) {
      persistToDA(query, generatedBlocks, data.intent);
    }
  });

  eventSource.addEventListener('error', (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      loadingState.innerHTML = `
        <h1>Something went wrong</h1>
        <p style="color: #c00;">${data.message}</p>
        <p><a href="/">Return to homepage</a></p>
      `;
    }
    eventSource.close();
  });

  eventSource.onerror = () => {
    if (eventSource.readyState === EventSource.CLOSED) {
      if (blockCount === 0) {
        loadingState.innerHTML = `
          <h1>Connection failed</h1>
          <p style="color: #c00;">Unable to connect to the server. Please try again.</p>
          <p><a href="/">Return to homepage</a></p>
        `;
      }
    }
  };
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
