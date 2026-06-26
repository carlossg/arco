/**
 * Browsing Context Inspector
 *
 * A transparency widget: a floating button that opens a panel showing exactly
 * what the site has gathered about the current browsing session and how that
 * data has been categorized — the same inferred profile that powers the
 * "For You" personalized page.
 *
 * Reads (never writes) the session context from SessionContextManager and the
 * synthesized "For You" query from for-you-prefetch.js. Re-renders live on the
 * `arco-context-updated` event fired by browsing-signals.js.
 *
 * Loaded in the delayed phase via delayed.js — zero impact on LCP.
 */

import { SessionContextManager } from './session-context.js';
import { FORYOU_QUERY_KEY } from './for-you-prefetch.js';

const PANEL_ID = 'arco-context-inspector';

function loadCss() {
  if (document.querySelector('link[data-context-inspector-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/styles/context-inspector.css';
  link.setAttribute('data-context-inspector-css', '');
  document.head.appendChild(link);
}

/* ========================================================================== */
/*  Formatting helpers                                                         */
/* ========================================================================== */

function humanize(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/-/g, ' ');
}

function formatDuration(seconds) {
  if (!seconds) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function chips(items) {
  if (!items || items.length === 0) return '<span class="ci-empty">none yet</span>';
  return items
    .map((item) => `<span class="ci-chip">${humanize(item)}</span>`)
    .join('');
}

function getForYouQuery() {
  try {
    return sessionStorage.getItem(FORYOU_QUERY_KEY) || null;
  } catch {
    return null;
  }
}

/* ========================================================================== */
/*  Panel rendering                                                            */
/* ========================================================================== */

function renderBody() {
  const context = SessionContextManager.getContext();
  const profile = context.inferredProfile || {};
  const history = context.browsingHistory || [];
  const forYouQuery = getForYouQuery();

  const {
    inferredIntent = 'discovery',
    journeyStage = 'exploring',
    productsViewed = [],
    categoriesViewed = [],
    contentTypes = [],
    interests = [],
    quizAnswers,
    pagesVisited = 0,
    totalTimeOnSite = 0,
  } = profile;

  const quizValues = quizAnswers ? Object.values(quizAnswers) : [];

  const recentPages = history
    .slice(-5)
    .reverse()
    .map((v) => {
      const meta = [humanize(v.intent), `${v.timeSpent || 0}s`, `${v.scrollDepth || 0}%`]
        .filter(Boolean)
        .join(' · ');
      return `<li><span class="ci-path">${v.path || '/'}</span><span class="ci-meta">${meta}</span></li>`;
    })
    .join('');

  return `
    <div class="ci-section ci-summary">
      <div class="ci-kv"><span>Journey stage</span><strong>${humanize(journeyStage)}</strong></div>
      <div class="ci-kv"><span>Inferred intent</span><strong>${humanize(inferredIntent)}</strong></div>
      <div class="ci-kv"><span>Pages this session</span><strong>${pagesVisited}</strong></div>
      <div class="ci-kv"><span>Time on site</span><strong>${formatDuration(totalTimeOnSite)}</strong></div>
    </div>

    <div class="ci-section">
      <h4>Products viewed</h4>
      <div class="ci-chips">${chips(productsViewed)}</div>
    </div>

    <div class="ci-section">
      <h4>Categories</h4>
      <div class="ci-chips">${chips(categoriesViewed)}</div>
    </div>

    <div class="ci-section">
      <h4>Content types</h4>
      <div class="ci-chips">${chips(contentTypes)}</div>
    </div>

    ${interests.length ? `
    <div class="ci-section">
      <h4>Interests (from filters)</h4>
      <div class="ci-chips">${chips(interests)}</div>
    </div>` : ''}

    ${quizValues.length ? `
    <div class="ci-section">
      <h4>Quiz answers</h4>
      <div class="ci-chips">${chips(quizValues)}</div>
    </div>` : ''}

    <div class="ci-section">
      <h4>Recent pages</h4>
      ${recentPages ? `<ul class="ci-history">${recentPages}</ul>` : '<span class="ci-empty">none yet</span>'}
    </div>

    <div class="ci-section ci-foryou">
      <h4>"For You" query</h4>
      <p class="ci-query">${forYouQuery ? `"${forYouQuery}"` : '<span class="ci-empty">building… visit one more page</span>'}</p>
    </div>

    <p class="ci-note">This data lives only in this browser tab (sessionStorage) and resets when you close it.</p>
  `;
}

function refresh(panel) {
  const body = panel.querySelector('.ci-body');
  if (body) body.innerHTML = renderBody();
}

/* ========================================================================== */
/*  Widget construction                                                        */
/* ========================================================================== */

function buildWidget() {
  const wrapper = document.createElement('div');
  wrapper.id = PANEL_ID;
  wrapper.className = 'ci-collapsed';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ci-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', `${PANEL_ID}-panel`);
  toggle.innerHTML = '<span aria-hidden="true">🧠</span> What we know';

  const panel = document.createElement('div');
  panel.id = `${PANEL_ID}-panel`;
  panel.className = 'ci-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Your browsing context');
  panel.innerHTML = `
    <div class="ci-header">
      <h3>Your browsing context</h3>
      <button type="button" class="ci-close" aria-label="Close">×</button>
    </div>
    <div class="ci-body"></div>
  `;

  wrapper.appendChild(toggle);
  wrapper.appendChild(panel);

  function open() {
    refresh(panel);
    wrapper.classList.remove('ci-collapsed');
    wrapper.classList.add('ci-open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  function close() {
    wrapper.classList.remove('ci-open');
    wrapper.classList.add('ci-collapsed');
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', () => {
    if (wrapper.classList.contains('ci-open')) close();
    else open();
  });
  panel.querySelector('.ci-close').addEventListener('click', close);

  // Keep the panel current while it's open and signals keep arriving.
  window.addEventListener('arco-context-updated', () => {
    if (wrapper.classList.contains('ci-open')) refresh(panel);
  });

  return wrapper;
}

/**
 * Mount the context inspector widget.
 * Call from delayed.js after collectBrowsingSignals().
 */
export function initContextInspector() {
  // Skip on recommender query pages — they have their own flow/UI.
  const params = new URLSearchParams(window.location.search);
  if (params.has('q') || params.has('query')) return;
  if (window.location.pathname.startsWith('/discover/')) return;

  if (document.getElementById(PANEL_ID)) return;
  loadCss();
  document.body.appendChild(buildWidget());
}

export default initContextInspector;
