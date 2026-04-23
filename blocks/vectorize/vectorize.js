/**
 * Vectorize Block — inspect and search the `arco-content` Vectorize index.
 *
 * Auth: same HTTP Basic token as the Admin block (ADMIN_TOKEN secret), shared
 * via localStorage key `arco-admin-token`.
 *
 * Views (hash routing):
 *   #/                  Overview — index stats + sampled type histogram
 *   #/search            Search UI — top-K similarity search, optional type filter
 *   #/items/:id         Single vector detail (metadata + optional values)
 */

import { ARCO_RECOMMENDER_URL } from '../../scripts/api-config.js';

const TOKEN_STORAGE_KEY = 'arco-admin-token';

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function dur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtInt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

function badge(label, tone = 'muted') {
  if (label === null || label === undefined || label === '') {
    return '<span class="vec-badge vec-badge-muted">—</span>';
  }
  return `<span class="vec-badge vec-badge-${tone}">${esc(label)}</span>`;
}

function typeTone(type) {
  const map = {
    guide: 'ok',
    experience: 'purple',
    comparison: 'warn',
    product: 'accent',
    recipe: 'ok',
    'hero-image': 'purple',
    maintenance: 'warn',
    diagnostic: 'warn',
    pairing: 'accent',
    calculator: 'muted',
  };
  return map[type] || 'accent';
}

// ── Auth ────────────────────────────────────────────────────────────────────

function getToken() {
  let token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) {
    // eslint-disable-next-line no-alert
    token = window.prompt('Admin token (ADMIN_TOKEN secret):');
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  }
  return token;
}

function clearToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function api(path) {
  const token = getToken();
  if (!token) throw new Error('Admin token required');
  const res = await fetch(`${ARCO_RECOMMENDER_URL}${path}`, {
    headers: { Authorization: `Basic ${btoa(`admin:${token}`)}` },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('Unauthorized — token cleared. Reload to retry.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Routing ─────────────────────────────────────────────────────────────────

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  if (hash === '/' || hash === '') return { view: 'overview' };
  if (hash === '/search' || hash.startsWith('/search?')) return { view: 'search' };
  const itemMatch = hash.match(/^\/items\/(.+)$/);
  if (itemMatch) return { view: 'item', id: decodeURIComponent(itemMatch[1]) };
  return { view: 'overview' };
}

// ── Overview (stats) ────────────────────────────────────────────────────────

function renderHistogramBars(title, dist) {
  const entries = Object.entries(dist || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    return `<div class="vec-hist"><h4>${esc(title)}</h4><p class="vec-muted">No values in sample.</p></div>`;
  }
  const max = entries[0][1];
  return `<div class="vec-hist">
    <h4>${esc(title)}</h4>
    <ul class="vec-hist-list">
      ${entries.map(([k, v]) => {
    const pct = max > 0 ? (v / max) * 100 : 0;
    return `<li class="vec-hist-row">
          <span class="vec-hist-label">${esc(k)}</span>
          <span class="vec-hist-bar"><span style="width:${pct.toFixed(1)}%"></span></span>
          <span class="vec-hist-count">${v}</span>
        </li>`;
  }).join('')}
    </ul>
  </div>`;
}

async function renderOverview(root) {
  root.innerHTML = '<p class="vec-loading">Loading index stats…</p>';
  let data;
  try {
    data = await api('/api/admin/vectorize/stats?sampleTopK=50');
  } catch (err) {
    root.innerHTML = `<p class="vec-error">${esc(err.message)}</p>`;
    return;
  }

  const d = data.describe || {};
  const s = data.sample || {};
  const totalVectors = data.totalVectors ?? d.vectorCount ?? d.vectorsCount ?? null;
  const scoreStats = s.scoreStats || null;
  const lastMutation = d.processedUpToDatetime
    ? new Date(d.processedUpToDatetime).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    : '—';

  const metric = d.metric ? String(d.metric) : '—';

  root.innerHTML = `
    <div class="vec-stats-strip">
      <span class="vec-stat"><span class="vec-stat-value">${fmtInt(totalVectors)}</span><span class="vec-stat-label">vectors (describe)</span></span>
      <span class="vec-stat"><span class="vec-stat-value">${fmtInt(d.dimensions)}</span><span class="vec-stat-label">dimensions</span></span>
      <span class="vec-stat"><span class="vec-stat-value" style="font-size:0.95rem">${esc(metric)}</span><span class="vec-stat-label">metric</span></span>
      <span class="vec-stat"><span class="vec-stat-value" style="font-size:0.95rem">${esc((data.index?.embeddingModel || '').replace(/^@cf\//, ''))}</span><span class="vec-stat-label">model</span></span>
    </div>

    <section class="vec-card">
      <h3>Index metadata</h3>
      <dl class="vec-kvs vec-kvs-two">
        <div class="vec-kv"><dt>Name</dt><dd>${esc(data.index?.name)}</dd></div>
        <div class="vec-kv"><dt>Binding</dt><dd><code>${esc(data.index?.binding)}</code></dd></div>
        <div class="vec-kv"><dt>Embedding model</dt><dd><code>${esc(data.index?.embeddingModel)}</code></dd></div>
        <div class="vec-kv"><dt>Dimensions</dt><dd>${fmtInt(d.dimensions)}</dd></div>
        <div class="vec-kv"><dt>Metric</dt><dd>${esc(metric)}</dd></div>
        <div class="vec-kv"><dt>Total vectors</dt><dd>${fmtInt(totalVectors)}</dd></div>
        <div class="vec-kv"><dt>Processed up to</dt><dd>${esc(lastMutation)}</dd></div>
        <div class="vec-kv"><dt>Last mutation id</dt><dd class="vec-mono">${esc(d.processedUpToMutation || '—')}</dd></div>
      </dl>
      <p class="vec-muted vec-hint">
        Vectorize V2 has no list-all-vectors API, so the breakdown below is sampled from the top
        ${esc(s.topK || 50)} similarity results for a broad seed query
        (<em>${esc(s.seed || '')}</em>). It is a snapshot of the neighbourhood, not a census.
        Max topK is 50 when <code>returnMetadata=all</code> (Vectorize V2 limit).
      </p>
    </section>

    ${s.error ? `<div class="vec-card vec-error-card"><p class="vec-error">Sample failed: ${esc(s.error)}</p></div>` : `
    <section class="vec-card">
      <h3>Sampled type distribution (top ${esc(s.topK || 100)})</h3>
      ${scoreStats ? `<p class="vec-muted vec-hint">
        Score range in sample: ${scoreStats.min.toFixed(3)} – ${scoreStats.max.toFixed(3)}
        · mean ${scoreStats.mean.toFixed(3)} · n=${scoreStats.count}
      </p>` : ''}
      <div class="vec-hist-grid">
        ${renderHistogramBars('type', s.histogram?.type)}
        ${renderHistogramBars('category', s.histogram?.category)}
        ${renderHistogramBars('personaTags', s.histogram?.personaTags)}
        ${renderHistogramBars('difficulty', s.histogram?.difficulty)}
      </div>
    </section>`}

    <section class="vec-card">
      <h3>Next</h3>
      <p>Use <a href="#/search">Search</a> to embed a query and retrieve the top-K nearest vectors, or click any item id below to inspect it directly.</p>
    </section>
  `;
}

// ── Search ──────────────────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  '', 'guide', 'experience', 'comparison', 'product', 'recipe',
  'hero-image', 'maintenance', 'diagnostic', 'pairing', 'calculator',
];

function readSearchParamsFromHash() {
  const raw = window.location.hash.replace(/^#/, '');
  const [, query = ''] = raw.match(/^\/search\?(.*)$/) || [];
  const p = new URLSearchParams(query);
  return {
    q: p.get('q') || '',
    topK: parseInt(p.get('topK') || '20', 10) || 20,
    type: p.get('type') || '',
    values: p.get('values') === '1',
  };
}

function writeSearchParamsToHash({
  q, topK, type, values,
}) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (topK && topK !== 20) p.set('topK', String(topK));
  if (type) p.set('type', type);
  if (values) p.set('values', '1');
  const str = p.toString();
  window.location.hash = `/search${str ? `?${str}` : ''}`;
}

function renderSearchForm(params) {
  return `
    <section class="vec-card">
      <h3>Query</h3>
      <form class="vec-form" id="vec-search-form">
        <label class="vec-field vec-field-wide">
          <span>Query text</span>
          <input type="text" name="q" value="${esc(params.q)}" placeholder="e.g. quiet espresso machine for a small kitchen" autocomplete="off">
        </label>
        <label class="vec-field">
          <span>top K (1–50)</span>
          <input type="number" name="topK" min="1" max="50" value="${esc(params.topK)}">
        </label>
        <label class="vec-field">
          <span>type filter</span>
          <select name="type">
            ${TYPE_OPTIONS.map((t) => `<option value="${esc(t)}"${t === params.type ? ' selected' : ''}>${t ? esc(t) : '(any)'}</option>`).join('')}
          </select>
        </label>
        <label class="vec-field vec-field-check">
          <input type="checkbox" name="values"${params.values ? ' checked' : ''}>
          <span>include raw vector values</span>
        </label>
        <div class="vec-field vec-field-actions">
          <button type="submit" class="vec-btn vec-btn-accent">Search</button>
        </div>
      </form>
    </section>
  `;
}

function renderMatchRow(match) {
  const md = match.metadata || {};
  const type = md.type || '—';
  const id = match.id || '';
  const scoreFmt = typeof match.score === 'number' ? match.score.toFixed(4) : '—';
  const title = md.title || md.alt || md.sectionHeading || md.name || '';
  const badges = [
    ['type', type],
    ['category', md.category],
    ['difficulty', md.difficulty],
  ].filter(([, v]) => v).map(([k, v]) => `<span class="vec-kvtag"><b>${esc(k)}</b> ${esc(v)}</span>`).join(' ');
  const personaTags = md.personaTags
    ? String(md.personaTags).split(',').filter(Boolean)
      .map((t) => `<span class="vec-kvtag vec-kvtag-soft">persona · ${esc(t.trim())}</span>`)
      .join(' ')
    : '';
  const valuesPreview = (() => {
    if (!Array.isArray(match.values)) return '';
    const head = match.values.slice(0, 8)
      .map((v) => (typeof v === 'number' ? v.toFixed(3) : String(v)))
      .join(', ');
    const more = match.values.length > 8 ? ', …' : '';
    return `[${head}${more}] <span class="vec-muted">(dims=${match.values.length})</span>`;
  })();

  return `
    <li class="vec-result">
      <div class="vec-result-head">
        <span class="vec-score">${esc(scoreFmt)}</span>
        <span class="vec-type-chip vec-type-${esc(type)}">${badge(type, typeTone(type))}</span>
        <a class="vec-result-id vec-mono" href="#/items/${encodeURIComponent(id)}">${esc(id)}</a>
      </div>
      ${title ? `<div class="vec-result-title">${esc(title)}</div>` : ''}
      <div class="vec-result-tags">${badges}${personaTags}</div>
      ${valuesPreview ? `<div class="vec-muted vec-result-values">${valuesPreview}</div>` : ''}
      <details class="vec-result-json">
        <summary>metadata JSON</summary>
        <pre>${esc(JSON.stringify(md, null, 2))}</pre>
      </details>
    </li>
  `;
}

async function renderSearch(root) {
  const params = readSearchParamsFromHash();
  root.innerHTML = `
    <div class="vec-search-shell">
      <div class="vec-search-form" id="vec-form-slot">${renderSearchForm(params)}</div>
      <div class="vec-search-results" id="vec-results-slot"></div>
    </div>
  `;

  const form = root.querySelector('#vec-search-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    writeSearchParamsToHash({
      q: fd.get('q') || '',
      topK: parseInt(fd.get('topK') || '20', 10),
      type: fd.get('type') || '',
      values: fd.get('values') === 'on',
    });
  });

  const resultsSlot = root.querySelector('#vec-results-slot');

  if (!params.q) {
    resultsSlot.innerHTML = `
      <section class="vec-card vec-placeholder">
        <h3>Run a search</h3>
        <p class="vec-muted">Enter a query to embed it via <code>@cf/baai/bge-small-en-v1.5</code> and retrieve the top-K nearest vectors from <code>arco-content</code>.</p>
      </section>
    `;
    return;
  }

  resultsSlot.innerHTML = '<p class="vec-loading">Embedding &amp; searching…</p>';

  const qs = new URLSearchParams({ q: params.q, topK: String(params.topK) });
  if (params.type) qs.set('type', params.type);
  if (params.values) qs.set('values', '1');

  let data;
  try {
    data = await api(`/api/admin/vectorize/search?${qs.toString()}`);
  } catch (err) {
    resultsSlot.innerHTML = `<p class="vec-error">${esc(err.message)}</p>`;
    return;
  }

  const t = data.timings || {};
  const preview = (data.embedding?.preview || []).map((v) => (typeof v === 'number' ? v.toFixed(3) : String(v))).join(', ');

  resultsSlot.innerHTML = `
    <section class="vec-card">
      <div class="vec-result-toolbar">
        <div class="vec-result-count">
          <strong>${data.count}</strong> match${data.count === 1 ? '' : 'es'}
          ${params.type ? `<span class="vec-muted">after client-side <code>type=${esc(params.type)}</code> filter (raw topK=${esc(data.totalReturned)})</span>` : ''}
        </div>
        <div class="vec-result-timings vec-muted">
          embed ${dur(t.embedMs)} · query ${dur(t.queryMs)} · total ${dur(t.totalMs)}
          · dims ${esc(data.embedding?.dims || '—')}
        </div>
      </div>
      <details class="vec-result-embed">
        <summary>embedding preview (first 8 dims)</summary>
        <pre>[${esc(preview)}${data.embedding?.dims > 8 ? ', …' : ''}]</pre>
      </details>
      ${data.count === 0
    ? '<p class="vec-empty">No matches for this query.</p>'
    : `<ul class="vec-results">${data.matches.map(renderMatchRow).join('')}</ul>`}
    </section>
  `;
}

// ── Item detail ─────────────────────────────────────────────────────────────

async function renderItem(root, id) {
  root.innerHTML = `
    <nav class="vec-crumbs"><a href="#/">← Overview</a> <span>·</span> <a href="#/search">Search</a></nav>
    <p class="vec-loading">Loading item <code>${esc(id)}</code>…</p>
  `;

  let data;
  try {
    data = await api(`/api/admin/vectorize/items/${encodeURIComponent(id)}?values=1`);
  } catch (err) {
    root.innerHTML = `
      <nav class="vec-crumbs"><a href="#/">← Overview</a> <span>·</span> <a href="#/search">Search</a></nav>
      <p class="vec-error">${esc(err.message)}</p>
    `;
    return;
  }

  const md = data.metadata || {};
  const valuesPreview = Array.isArray(data.values)
    ? data.values.slice(0, 16).map((v) => (typeof v === 'number' ? v.toFixed(4) : String(v))).join(', ')
    : null;

  root.innerHTML = `
    <nav class="vec-crumbs"><a href="#/">← Overview</a> <span>·</span> <a href="#/search">Search</a></nav>
    <div class="vec-toolbar">
      <h2 class="vec-mono">${esc(data.id)}</h2>
      <div class="vec-badges">
        ${badge(md.type || 'unknown', typeTone(md.type))}
        ${data.dims ? badge(`${data.dims}d`, 'muted') : ''}
      </div>
    </div>

    <section class="vec-card">
      <h3>Metadata</h3>
      <dl class="vec-kvs vec-kvs-two">
        ${Object.entries(md).map(([k, v]) => `<div class="vec-kv"><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('') || '<p class="vec-muted">No metadata.</p>'}
      </dl>
    </section>

    ${md.url ? `
    <section class="vec-card">
      <h3>Preview</h3>
      <div class="vec-preview-media">
        <a href="${esc(md.url)}" target="_blank" rel="noopener">
          <img src="${esc(md.url)}" alt="${esc(md.alt || '')}" loading="lazy">
        </a>
        ${md.alt ? `<p class="vec-muted">${esc(md.alt)}</p>` : ''}
      </div>
    </section>` : ''}

    ${valuesPreview ? `
    <section class="vec-card">
      <h3>Vector values</h3>
      <p class="vec-muted">First 16 of ${esc(data.dims || data.values.length)} dimensions.</p>
      <pre class="vec-pre">[${esc(valuesPreview)}, …]</pre>
    </section>` : ''}
  `;
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function render(root) {
  const route = parseRoute();
  if (route.view === 'search') {
    await renderSearch(root);
  } else if (route.view === 'item') {
    await renderItem(root, route.id);
  } else {
    await renderOverview(root);
  }
}

export default async function decorate(block) {
  block.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'vec-shell';

  const header = document.createElement('header');
  header.className = 'vec-header';
  header.innerHTML = `
    <div class="vec-brand">◇ <strong>Arco Vectorize</strong></div>
    <nav class="vec-nav">
      <a href="#/" data-nav="overview">Overview</a>
      <a href="#/search" data-nav="search">Search</a>
    </nav>
    <div class="vec-header-actions">
      <button type="button" class="vec-btn vec-btn-ghost" data-action="reload">Reload</button>
      <button type="button" class="vec-btn vec-btn-ghost" data-action="logout">Reset token</button>
    </div>
  `;
  shell.appendChild(header);

  const view = document.createElement('div');
  view.className = 'vec-view';
  shell.appendChild(view);
  block.appendChild(shell);

  const applyActiveNav = () => {
    const route = parseRoute();
    header.querySelectorAll('.vec-nav a').forEach((a) => {
      a.classList.toggle('is-active', a.dataset.nav === route.view
        || (route.view === 'item' && a.dataset.nav === 'search'));
    });
  };

  header.querySelector('[data-action="reload"]').addEventListener('click', () => { render(view); });
  header.querySelector('[data-action="logout"]').addEventListener('click', () => {
    clearToken();
    render(view);
  });

  window.addEventListener('hashchange', () => {
    applyActiveNav();
    render(view);
  });
  applyActiveNav();
  await render(view);
}
