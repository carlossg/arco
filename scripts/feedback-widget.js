/**
 * Run-level feedback widget.
 *
 * One widget per generated run. Anchored as a sibling .section at the end of
 * the run's content (before the follow-up chips). Reads the run's product
 * cards out of the DOM so it can offer "which product was wrong?" without an
 * extra backend round-trip.
 *
 * State machine:
 *   idle → 👍  → fire-and-forget POST {rating:+1}, collapse to "Thanks 👍" + add-note chip
 *   idle → 👎  → fire-and-forget POST {rating:-1}, expand form (comment + flags + products)
 *               → Send → second POST {rating:-1, comment, flags, wrongProducts}, collapse
 *               → Skip → collapse without second POST
 *
 * The first POST captures the bare rating even if the user bails before
 * submitting the longer form. Server upserts on (run_id, session_id).
 */

import { getAPIEndpoint } from './api-config.js';

const FLAG_OPTIONS = [
  { key: 'wrong-product', label: 'Wrong product / made-up facts' },
  { key: 'off-topic', label: "Off-topic / didn't answer my question" },
  { key: 'inappropriate-tone', label: 'Inappropriate tone / off-brand' },
  { key: 'harmful-unsafe', label: 'Harmful or unsafe' },
];

const STORAGE_PREFIX = 'arco-feedback:';

const THUMBS_UP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7V10l4-8a2 2 0 0 1 2 2v1.88Z"/></svg>';
const THUMBS_DOWN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17v12l-4 8a2 2 0 0 1-2-2v-1.88Z"/></svg>';

function loadCss() {
  if (document.querySelector('link[data-feedback-widget-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/styles/feedback-widget.css';
  link.setAttribute('data-feedback-widget-css', '');
  document.head.appendChild(link);
}

/**
 * Find product cards in the run's already-rendered sections.
 * @param {Element} container The recommender container (parent of streamed sections)
 * @param {string} runId The run we're attaching to
 * @returns {Array<{slug: string, label: string}>}
 */
function detectProducts(container, runId) {
  const sections = container.querySelectorAll(`[data-run-id="${CSS.escape(runId)}"]`);
  const out = [];
  const seen = new Set();
  sections.forEach((sec) => {
    sec.querySelectorAll('a[href*="/products/"]').forEach((a) => {
      const m = a.getAttribute('href').match(/\/products\/[^/]+\/([^/?#]+)/);
      if (!m) return;
      const slug = m[1];
      if (seen.has(slug)) return;
      seen.add(slug);
      // Prefer heading near the link; fall back to link text; finally to slug.
      const card = a.closest('[class*="product"], li, article, .card, .block');
      const heading = card && card.querySelector('h1, h2, h3, h4');
      let label = heading ? heading.textContent.trim() : a.textContent.trim();
      if (!label) label = slug.replace(/-/g, ' ');
      out.push({ slug, label: label.substring(0, 120) });
    });
  });
  return out;
}

async function postFeedback(payload) {
  try {
    const baseUrl = getAPIEndpoint('recommender');
    await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[feedback] submit failed', err);
    return false;
  }
}

function makeButton(className, html, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.innerHTML = html;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  return btn;
}

function renderAcknowledged(root, ratingValue, onReopen) {
  root.replaceChildren();
  root.classList.add('feedback-widget-ack');
  const msg = document.createElement('span');
  msg.className = 'feedback-widget-ack-msg';
  msg.textContent = ratingValue > 0 ? 'Thanks 👍' : 'Thanks 👎';
  root.appendChild(msg);
  if (onReopen) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'feedback-widget-link';
    more.textContent = ratingValue > 0 ? 'Add a note' : 'Add details';
    more.addEventListener('click', onReopen);
    root.appendChild(more);
  }
}

function renderIdle(root, ctx, onChoose) {
  root.replaceChildren();
  root.classList.remove('feedback-widget-ack', 'feedback-widget-expanded');
  const prompt = document.createElement('span');
  prompt.className = 'feedback-widget-prompt';
  prompt.textContent = 'Was this helpful?';
  root.appendChild(prompt);

  const up = makeButton('feedback-widget-thumb feedback-widget-thumb-up', THUMBS_UP_SVG, 'Helpful');
  const down = makeButton('feedback-widget-thumb feedback-widget-thumb-down', THUMBS_DOWN_SVG, 'Not helpful');
  up.addEventListener('click', () => onChoose(1));
  down.addEventListener('click', () => onChoose(-1));
  root.appendChild(up);
  root.appendChild(down);
}

function renderForm(root, ctx, ratingValue, onSubmit, onSkip) {
  root.replaceChildren();
  root.classList.add('feedback-widget-expanded');
  root.classList.remove('feedback-widget-ack');

  const heading = document.createElement('div');
  heading.className = 'feedback-widget-form-heading';
  heading.textContent = ratingValue > 0
    ? 'Glad it helped — anything else to share?'
    : 'Thanks. What went wrong?';
  root.appendChild(heading);

  const ta = document.createElement('textarea');
  ta.className = 'feedback-widget-textarea';
  ta.rows = 3;
  ta.maxLength = 1000;
  ta.placeholder = ratingValue > 0
    ? 'Tell us what worked (optional)'
    : 'Tell us more (optional). Please don\'t include personal info.';
  root.appendChild(ta);

  let flagsBox = null;
  let productsBox = null;
  if (ratingValue < 0) {
    flagsBox = document.createElement('div');
    flagsBox.className = 'feedback-widget-flags';
    const flagsLabel = document.createElement('div');
    flagsLabel.className = 'feedback-widget-sublabel';
    flagsLabel.textContent = 'Flag a category (optional)';
    flagsBox.appendChild(flagsLabel);
    FLAG_OPTIONS.forEach((opt) => {
      const id = `fb-flag-${ctx.runId}-${opt.key}`;
      const wrap = document.createElement('label');
      wrap.className = 'feedback-widget-check';
      wrap.htmlFor = id;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = opt.key;
      cb.id = id;
      const txt = document.createElement('span');
      txt.textContent = opt.label;
      wrap.appendChild(cb);
      wrap.appendChild(txt);
      flagsBox.appendChild(wrap);
    });
    root.appendChild(flagsBox);

    if (ctx.products && ctx.products.length > 0) {
      productsBox = document.createElement('div');
      productsBox.className = 'feedback-widget-products';
      const pLabel = document.createElement('div');
      pLabel.className = 'feedback-widget-sublabel';
      pLabel.textContent = 'Which product was wrong? (optional)';
      productsBox.appendChild(pLabel);
      ctx.products.forEach((p) => {
        const id = `fb-prod-${ctx.runId}-${p.slug}`;
        const wrap = document.createElement('label');
        wrap.className = 'feedback-widget-check';
        wrap.htmlFor = id;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = p.slug;
        cb.id = id;
        const txt = document.createElement('span');
        txt.textContent = p.label;
        wrap.appendChild(cb);
        wrap.appendChild(txt);
        productsBox.appendChild(wrap);
      });
      root.appendChild(productsBox);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'feedback-widget-actions';
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'feedback-widget-send';
  send.textContent = 'Send';
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'feedback-widget-skip';
  skip.textContent = 'Skip';
  send.addEventListener('click', () => {
    const comment = ta.value.trim();
    const flags = flagsBox
      ? Array.from(flagsBox.querySelectorAll('input:checked')).map((i) => i.value)
      : [];
    const wrongProducts = productsBox
      ? Array.from(productsBox.querySelectorAll('input:checked')).map((i) => i.value)
      : [];
    onSubmit({ comment, flags, wrongProducts });
  });
  skip.addEventListener('click', onSkip);
  actions.appendChild(send);
  actions.appendChild(skip);
  root.appendChild(actions);

  ta.focus();
}

/**
 * Attach a feedback widget to the container for a specific run.
 * @param {Element} container Recommender container (parent of streamed sections)
 * @param {object} options
 * @param {string} options.runId
 * @param {string} [options.pageId]
 * @param {string} options.sessionId
 * @param {string} [options.query]
 */
export function attachFeedbackWidget(container, {
  runId, pageId, sessionId, query,
} = {}) {
  if (!container || !runId || !sessionId) return null;

  loadCss();

  const root = document.createElement('div');
  root.className = 'section feedback-widget';
  root.dataset.runId = runId;

  // Insert before .follow-up-container so chips stay at the bottom.
  const followUp = container.querySelector('.follow-up-container');
  if (followUp) container.insertBefore(root, followUp);
  else container.appendChild(root);

  const mountedAt = performance.now();
  const ctx = {
    runId,
    pageId,
    sessionId,
    query,
    products: detectProducts(container, runId),
  };

  const storageKey = `${STORAGE_PREFIX}${runId}`;
  let prior = null;
  try { prior = window.localStorage.getItem(storageKey); } catch { /* no-op */ }

  const dwell = () => Math.round(performance.now() - mountedAt);

  let openForm;
  const collapseAfterSubmit = (ratingValue) => {
    try { window.localStorage.setItem(storageKey, ratingValue > 0 ? 'up' : 'down'); } catch { /* no-op */ }
    renderAcknowledged(root, ratingValue, () => openForm(ratingValue));
  };
  openForm = (ratingValue) => {
    renderForm(
      root,
      ctx,
      ratingValue,
      async ({ comment, flags, wrongProducts }) => {
        await postFeedback({
          runId,
          pageId,
          sessionId,
          rating: ratingValue,
          comment,
          flags,
          wrongProducts,
          dwellMs: dwell(),
        });
        collapseAfterSubmit(ratingValue);
      },
      () => collapseAfterSubmit(ratingValue),
    );
  };

  function start() {
    renderIdle(root, ctx, (ratingValue) => {
      // Fire-and-forget initial POST so even bailers register.
      postFeedback({
        runId,
        pageId,
        sessionId,
        rating: ratingValue,
        dwellMs: dwell(),
      });
      if (ratingValue > 0) {
        collapseAfterSubmit(ratingValue);
      } else {
        openForm(ratingValue);
      }
    });
  }

  if (prior === 'up' || prior === 'down') {
    renderAcknowledged(root, prior === 'up' ? 1 : -1, () => openForm(prior === 'up' ? 1 : -1));
  } else {
    start();
  }

  return root;
}

export default attachFeedbackWidget;
