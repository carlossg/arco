/**
 * Admin Block — session & page browser for the Arco recommender demo.
 *
 * Authenticates against the recommender worker's /api/admin/* endpoints
 * using HTTP Basic Auth (username: admin, password: ADMIN_TOKEN). The token
 * is prompted once and cached in localStorage.
 *
 * Model:
 *   session (one browser tab)
 *     └─ page (one ?q= URL visit)
 *         └─ run (one /api/generate call — initial or a follow-up click)
 *
 * Views (hash routing within the block):
 *   #/                    Sessions list
 *   #/sessions/:id        Session detail + pages list
 *   #/pages/:id           Page detail — overview / reconstruction / timeline / debug
 */

import {
  decorateBlock, decorateButtons, decorateIcons, loadBlock,
} from '../../scripts/aem.js';
import { ARCO_RECOMMENDER_URL } from '../../scripts/api-config.js';

const TOKEN_STORAGE_KEY = 'arco-admin-token';
const BLOCK_ALIASES = {
  'use-case-cards': 'cards',
  'feature-highlights': 'cards',
  text: false,
  'how-to-steps': 'recipe-steps',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ts(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function dur(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function badge(label, tone = 'neutral') {
  if (!label && label !== 0) return '<span class="admin-badge admin-badge-muted">—</span>';
  return `<span class="admin-badge admin-badge-${tone}">${esc(label)}</span>`;
}

function kv(label, value) {
  const v = value === null || value === undefined || value === '' ? '—' : esc(value);
  return `<div class="admin-kv"><dt>${esc(label)}</dt><dd>${v}</dd></div>`;
}

function intentTone(intent) {
  const map = {
    espresso: 'accent',
    'milk-drinks': 'purple',
    comparison: 'warn',
    grinder: 'ok',
    gift: 'warn',
    beginner: 'ok',
    support: 'muted',
  };
  return map[intent] || 'accent';
}

// ── Auth ────────────────────────────────────────────────────────────────────

function getAdminToken() {
  let token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) {
    // eslint-disable-next-line no-alert
    token = window.prompt('Admin token (ADMIN_TOKEN secret):');
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  }
  return token;
}

function clearAdminToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function api(path) {
  const token = getAdminToken();
  if (!token) throw new Error('Admin token required');
  const res = await fetch(`${ARCO_RECOMMENDER_URL}${path}`, {
    headers: { Authorization: `Basic ${btoa(`admin:${token}`)}` },
  });
  if (res.status === 401) {
    clearAdminToken();
    throw new Error('Unauthorized — token cleared. Reload to retry.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Routing ─────────────────────────────────────────────────────────────────

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  if (hash === '/') return { view: 'sessions' };
  const sessionMatch = hash.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) return { view: 'session', id: sessionMatch[1] };
  const pageMatch = hash.match(/^\/pages\/([^/]+)(?:\/(\w+))?$/);
  if (pageMatch) return { view: 'page', id: pageMatch[1], tab: pageMatch[2] || 'overview' };
  return { view: 'sessions' };
}

function navigate(hash) {
  window.location.hash = hash;
}

// ── Sessions list ───────────────────────────────────────────────────────────

async function renderSessions(root) {
  root.innerHTML = '<p class="admin-loading">Loading sessions…</p>';
  let data;
  try {
    data = await api('/api/admin/sessions?limit=100&offset=0');
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const sessions = data.sessions || [];
  const total = data.total || 0;

  root.innerHTML = `
    <div class="admin-toolbar">
      <h2>Sessions</h2>
      <div class="admin-stats">
        <span class="admin-stat"><span class="admin-stat-value">${total}</span><span class="admin-stat-label">total</span></span>
      </div>
    </div>
    ${sessions.length === 0
    ? '<p class="admin-empty">No sessions yet. Generate a recommender page first.</p>'
    : `<div class="admin-table-wrap"><table class="admin-table">
        <thead><tr>
          <th>Session</th><th>First seen</th><th>Last active</th>
          <th>Runs</th><th>User agent</th>
        </tr></thead>
        <tbody>${sessions.map((s) => `
          <tr data-href="#/sessions/${esc(s.id)}">
            <td class="admin-mono">${esc(s.id.substring(0, 8))}…</td>
            <td>${ts(s.first_seen)}</td>
            <td>${ts(s.last_seen)}</td>
            <td>${badge(s.page_count, s.page_count > 0 ? 'accent' : 'muted')}</td>
            <td class="admin-ua">${esc((s.user_agent || '').substring(0, 80))}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`}
  `;

  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { navigate(tr.dataset.href); });
  });
}

// ── Session detail (shows pages — grouped runs) ─────────────────────────────

async function renderSession(root, sessionId) {
  root.innerHTML = '<p class="admin-loading">Loading session…</p>';
  let data;
  try {
    data = await api(`/api/admin/sessions/${sessionId}`);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const s = data.session;
  const pages = data.pages || [];
  const totalRuns = pages.reduce((n, p) => n + p.runCount, 0);

  root.innerHTML = `
    <nav class="admin-crumbs"><a href="#/">← Sessions</a></nav>
    <div class="admin-toolbar">
      <h2>Session ${esc(s.id.substring(0, 8))}…</h2>
      <div class="admin-stats">
        <span class="admin-stat"><span class="admin-stat-value">${pages.length}</span><span class="admin-stat-label">pages</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${totalRuns}</span><span class="admin-stat-label">runs</span></span>
        <span class="admin-stat"><span class="admin-stat-value">${ts(s.first_seen)}</span><span class="admin-stat-label">first seen</span></span>
      </div>
    </div>

    <section class="admin-card">
      <h3>Session info</h3>
      <dl class="admin-kvs">
        ${kv('Session ID', s.id)}
        ${kv('IP hash', s.ip_hash)}
        ${kv('User agent', s.user_agent)}
      </dl>
    </section>

    <section class="admin-card">
      <h3>Pages</h3>
      ${pages.length === 0
    ? '<p class="admin-empty">No pages recorded for this session.</p>'
    : `<div class="admin-table-wrap"><table class="admin-table">
          <thead><tr>
            <th>#</th><th>Initial query</th><th>URL</th><th>Intent</th>
            <th>Runs</th><th>Total duration</th><th>Total tokens</th><th>Last activity</th>
          </tr></thead>
          <tbody>${pages.map((p, i) => `
            <tr data-href="#/pages/${esc(p.pageId)}">
              <td class="admin-muted">${i + 1}</td>
              <td class="admin-query">${esc(p.initialQuery || '')}</td>
              <td class="admin-url admin-mono" title="${esc(p.pageUrl || '')}">${esc((p.pageUrl || '').substring(0, 40))}</td>
              <td>${badge(p.initialIntent, intentTone(p.initialIntent))}</td>
              <td>${badge(p.runCount, p.runCount > 1 ? 'accent' : 'muted')}</td>
              <td>${dur(p.totalDurationMs)}</td>
              <td class="admin-muted">${p.totalInputTokens + p.totalOutputTokens > 0 ? `${p.totalInputTokens}↑ ${p.totalOutputTokens}↓` : '—'}</td>
              <td class="admin-muted">${ts(p.lastRunAt)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>`}
    </section>
  `;

  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', () => { navigate(tr.dataset.href); });
  });
}

// ── Render a single stored block into a container ──────────────────────────

async function renderStoredSection(blockData, container) {
  const section = document.createElement('div');
  section.className = 'section';
  if (blockData.sectionStyle && blockData.sectionStyle !== 'default') {
    section.classList.add(blockData.sectionStyle);
  }
  section.dataset.sectionStatus = 'initialized';
  section.innerHTML = blockData.html;

  const sectionMeta = section.querySelector('div.section-metadata');
  if (sectionMeta) {
    [...sectionMeta.querySelectorAll(':scope > div')].forEach((row) => {
      const cols = [...row.children];
      if (cols.length >= 2) {
        const key = cols[0].textContent.trim().toLowerCase();
        const val = cols[1].textContent.trim();
        if (key === 'style') {
          val.split(',').filter(Boolean).forEach((style) => {
            section.classList.add(style.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          });
        } else {
          const camel = key.replace(/[^a-z0-9]+/g, '-').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          section.dataset[camel] = val;
        }
      }
    });
    sectionMeta.remove();
  }

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
  container.appendChild(section);

  const block = section.querySelector('.block');
  if (block) {
    try {
      await loadBlock(block);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load block:', err);
    }
  }
  section.dataset.sectionStatus = 'loaded';
}

/**
 * Render an inert "follow-up chips" marker showing which options were presented
 * and which one the user clicked (if any). Used in reconstruction mode.
 */
function renderFollowUpChips(options, clickedNext, container) {
  if (!options || options.length === 0) return;
  const section = document.createElement('div');
  section.className = 'section admin-followup-marker';

  const label = document.createElement('div');
  label.className = 'admin-followup-label';
  label.textContent = 'Keep exploring — options shown';
  section.appendChild(label);

  const list = document.createElement('div');
  list.className = 'admin-followup-chips';
  options.forEach((opt) => {
    const chip = document.createElement('span');
    chip.className = 'admin-followup-chip';
    const isClicked = clickedNext
      && (clickedNext.label === opt.label || clickedNext.query === (opt.query || opt.label));
    if (isClicked) chip.classList.add('is-clicked');
    chip.innerHTML = `
      <span class="admin-followup-type">${esc(opt.type || 'explore')}</span>
      <span class="admin-followup-text">${esc(opt.label || opt.query || '—')}</span>
      ${isClicked ? '<span class="admin-followup-arrow">↓ clicked</span>' : ''}
    `;
    list.appendChild(chip);
  });
  section.appendChild(list);
  container.appendChild(section);
}

// ── Page detail ─────────────────────────────────────────────────────────────

async function fetchPage(pageId) {
  return api(`/api/admin/pages/${pageId}`);
}

function renderOverviewTab(container, data) {
  const { runs } = data;
  const totalDuration = runs.reduce((n, r) => n + (r.run?.duration_ms || 0), 0);
  const totalIn = runs.reduce((n, r) => n + (r.run?.input_tokens || 0), 0);
  const totalOut = runs.reduce((n, r) => n + (r.run?.output_tokens || 0), 0);
  const totalBlocks = runs.reduce((n, r) => n + (r.run?.block_count || 0), 0);

  container.innerHTML = `
    <div class="admin-stats admin-stats-strip">
      <span class="admin-stat"><span class="admin-stat-value">${runs.length}</span><span class="admin-stat-label">runs</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${totalBlocks}</span><span class="admin-stat-label">blocks total</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${dur(totalDuration)}</span><span class="admin-stat-label">total duration</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${totalIn}</span><span class="admin-stat-label">in tokens</span></span>
      <span class="admin-stat"><span class="admin-stat-value">${totalOut}</span><span class="admin-stat-label">out tokens</span></span>
    </div>

    <section class="admin-card">
      <h3>Page metadata</h3>
      <dl class="admin-kvs admin-kvs-two">
        ${kv('Page ID', data.pageId)}
        ${kv('Session', data.sessionId)}
        ${kv('URL', data.pageUrl)}
        ${kv('Initial query', runs[0]?.run?.query)}
        ${kv('Title', runs[0]?.run?.title)}
        ${kv('Started', ts(runs[0]?.run?.created_at))}
        ${kv('Ended', ts(runs[runs.length - 1]?.run?.created_at))}
      </dl>
    </section>
  `;
}

async function renderReconstructionTab(container, data) {
  container.innerHTML = '<p class="admin-loading">Reconstructing page…</p>';
  const stage = document.createElement('div');
  stage.className = 'admin-preview-stage';
  const main = document.createElement('main');
  main.className = 'admin-preview-main';
  stage.appendChild(main);
  container.innerHTML = '';
  container.appendChild(stage);

  const runs = data.runs || [];
  if (runs.length === 0) {
    main.innerHTML = '<p class="admin-empty">No runs stored for this page.</p>';
    return;
  }

  for (let i = 0; i < runs.length; i += 1) {
    const { run, payload } = runs[i];
    const blocks = payload?.blocks || [];

    // Divider between runs (showing which follow-up triggered this one)
    if (i > 0) {
      const divider = document.createElement('div');
      divider.className = 'section admin-run-divider';
      const clickedLabel = run.follow_up_label || run.query;
      divider.innerHTML = `
        <div class="admin-run-divider-line"></div>
        <div class="admin-run-divider-label">
          <span class="admin-run-divider-type">${esc(run.follow_up_type || 'follow-up')}</span>
          <span class="admin-run-divider-arrow">→</span>
          <span class="admin-run-divider-query">${esc(clickedLabel)}</span>
        </div>
      `;
      main.appendChild(divider);
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const blockData of blocks) {
      // eslint-disable-next-line no-await-in-loop
      await renderStoredSection(blockData, main);
    }

    // After this run's blocks, show what follow-up chips were presented and which
    // one (if any) led to the next run.
    const nextRun = runs[i + 1]?.run || null;
    const clickedNext = nextRun
      ? { label: nextRun.follow_up_label, query: nextRun.query, type: nextRun.follow_up_type }
      : null;
    renderFollowUpChips(payload?.followUpOptions || [], clickedNext, main);
  }
}

function renderTimelineTab(container, data) {
  const runs = data.runs || [];
  container.innerHTML = `
    <section class="admin-card">
      <h3>Run timeline</h3>
      <p class="admin-muted">All generations on this page in order — initial run plus each follow-up click.</p>
      <ol class="admin-timeline">
        ${runs.map(({ run, payload }, i) => {
    const options = payload?.followUpOptions || [];
    const nextRun = runs[i + 1]?.run;
    const clickedNext = nextRun
      ? { label: nextRun.follow_up_label, query: nextRun.query, type: nextRun.follow_up_type }
      : null;
    return `
            <li class="admin-timeline-item">
              <div class="admin-timeline-marker">${run.run_index != null ? run.run_index : i}</div>
              <div class="admin-timeline-body">
                <div class="admin-timeline-head">
                  ${run.run_index === 0 || (run.run_index == null && i === 0)
    ? '<span class="admin-badge admin-badge-accent">initial</span>'
    : `${badge(run.follow_up_type || 'follow-up', 'purple')} <span class="admin-muted">${esc(run.follow_up_label || '')}</span>`}
                  <span class="admin-muted admin-mono">${ts(run.created_at)}</span>
                  <span class="admin-muted">${dur(run.duration_ms)}</span>
                  <span class="admin-muted">${run.input_tokens || '—'}↑ ${run.output_tokens || '—'}↓</span>
                </div>
                <p class="admin-timeline-query">${esc(run.query)}</p>
                <p class="admin-muted admin-timeline-title">${esc(run.title || '')}</p>
                ${options.length > 0 ? `
                  <div class="admin-timeline-options">
                    <div class="admin-muted admin-timeline-options-label">Follow-up options shown (${options.length})</div>
                    <div class="admin-followup-chips">
                      ${options.map((opt) => {
    const clickedOpt = clickedNext
      && (clickedNext.label === opt.label || clickedNext.query === (opt.query || opt.label));
    return `<span class="admin-followup-chip${clickedOpt ? ' is-clicked' : ''}">
                          <span class="admin-followup-type">${esc(opt.type || 'explore')}</span>
                          <span class="admin-followup-text">${esc(opt.label || opt.query || '—')}</span>
                          ${clickedOpt ? '<span class="admin-followup-arrow">↓ clicked</span>' : ''}
                        </span>`;
  }).join('')}
                    </div>
                  </div>` : ''}
                <details class="admin-timeline-details">
                  <summary>Run ${esc(run.id.substring(0, 8))}… (${run.block_count} blocks)</summary>
                  <dl class="admin-kvs admin-kvs-two">
                    ${kv('Run ID', run.id)}
                    ${kv('Parent run', run.parent_run_id)}
                    ${kv('Intent', run.intent_type)}
                    ${kv('Flow', run.flow_id)}
                    ${kv('Journey', run.journey_stage)}
                    ${kv('DA path', run.da_path)}
                  </dl>
                </details>
              </div>
            </li>`;
  }).join('')}
      </ol>
    </section>
  `;
}

function renderDebugTab(container, data) {
  const runs = data.runs || [];
  if (runs.length === 0) {
    container.innerHTML = '<p class="admin-empty">No runs to inspect.</p>';
    return;
  }

  container.innerHTML = `
    <p class="admin-muted">Each run below captures its own intent classification, RAG context, prompt, and LLM output.</p>
    ${runs.map(({ run, payload }, i) => {
    const dbg = payload?.debug;
    if (!dbg) return `<section class="admin-card"><h3>Run ${i + 1}</h3><p class="admin-empty">No debug info.</p></section>`;
    const intent = dbg.intent ? `${dbg.intent.type}${dbg.intent.confidence ? ` (${(dbg.intent.confidence * 100).toFixed(0)}%)` : ''}` : null;
    return `
        <section class="admin-card admin-run-debug">
          <h3>Run ${run.run_index != null ? run.run_index : i} — ${esc((run.query || '').substring(0, 80))}</h3>
          <dl class="admin-kvs admin-kvs-two">
            ${kv('Intent', intent)}
            ${kv('Persona', dbg.rag?.persona?.name)}
            ${kv('Use case', dbg.rag?.useCase?.name)}
            ${kv('Products', (dbg.rag?.products || []).map((p) => `${p.name} ($${p.price})`).join(', '))}
            ${kv('Features', (dbg.rag?.features || []).map((f) => f.name).join(', '))}
            ${kv('Suggestions shown', (dbg.llm?.suggestions || []).map((s) => s.label).join(', '))}
          </dl>

          ${dbg.prompt ? `<details class="admin-collapsible">
            <summary>Prompt (${dbg.prompt.systemLength || 0} + ${dbg.prompt.userLength || 0} chars)</summary>
            <h4>System</h4>
            <pre class="admin-pre">${esc(dbg.prompt.systemPrompt || '')}</pre>
            <h4>User</h4>
            <pre class="admin-pre">${esc(dbg.prompt.userMessage || '')}</pre>
          </details>` : ''}

          ${dbg.llm?.rawOutput ? `<details class="admin-collapsible">
            <summary>Raw LLM output (${dbg.llm.rawOutput.length} chars)</summary>
            <pre class="admin-pre">${esc(dbg.llm.rawOutput)}</pre>
          </details>` : ''}
        </section>`;
  }).join('')}
  `;
}

async function renderPage(root, pageId, tab) {
  root.innerHTML = '<p class="admin-loading">Loading page…</p>';
  let data;
  try {
    data = await fetchPage(pageId);
  } catch (err) {
    root.innerHTML = `<p class="admin-error">${esc(err.message)}</p>`;
    return;
  }

  const runs = data.runs || [];
  const initialRun = runs[0]?.run;
  const sessionCrumb = data.sessionId
    ? `<a href="#/sessions/${esc(data.sessionId)}">← Session ${esc(data.sessionId.substring(0, 8))}…</a>`
    : '<a href="#/">← Sessions</a>';

  root.innerHTML = `
    <nav class="admin-crumbs">${sessionCrumb}</nav>
    <div class="admin-toolbar">
      <h2 class="admin-page-title">${esc(initialRun?.query || 'Untitled page')}</h2>
      <div class="admin-badges">
        ${badge(initialRun?.intent_type, intentTone(initialRun?.intent_type))}
        ${badge(`${runs.length} run${runs.length === 1 ? '' : 's'}`, 'accent')}
      </div>
    </div>
    <nav class="admin-tabs">
      <a data-tab="overview" href="#/pages/${esc(pageId)}">Overview</a>
      <a data-tab="reconstruction" href="#/pages/${esc(pageId)}/reconstruction">Full page</a>
      <a data-tab="timeline" href="#/pages/${esc(pageId)}/timeline">Run timeline</a>
      <a data-tab="debug" href="#/pages/${esc(pageId)}/debug">Debug</a>
    </nav>
    <div class="admin-tabpanel" id="admin-tabpanel"></div>
  `;

  root.querySelectorAll('.admin-tabs a').forEach((a) => {
    a.classList.toggle('is-active', a.dataset.tab === tab);
  });

  const panel = root.querySelector('#admin-tabpanel');
  if (tab === 'reconstruction') {
    await renderReconstructionTab(panel, data);
  } else if (tab === 'timeline') {
    renderTimelineTab(panel, data);
  } else if (tab === 'debug') {
    renderDebugTab(panel, data);
  } else {
    renderOverviewTab(panel, data);
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function render(root) {
  const route = parseRoute();
  if (route.view === 'session') {
    await renderSession(root, route.id);
  } else if (route.view === 'page') {
    await renderPage(root, route.id, route.tab);
  } else {
    await renderSessions(root);
  }
}

export default async function decorate(block) {
  block.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'admin-shell';

  const header = document.createElement('header');
  header.className = 'admin-header';
  header.innerHTML = `
    <div class="admin-brand">⬡ <strong>Arco Admin</strong></div>
    <div class="admin-header-actions">
      <button type="button" class="admin-btn admin-btn-ghost" data-action="reload">Reload</button>
      <button type="button" class="admin-btn admin-btn-ghost" data-action="logout">Reset token</button>
    </div>
  `;
  shell.appendChild(header);

  const view = document.createElement('div');
  view.className = 'admin-view';
  shell.appendChild(view);
  block.appendChild(shell);

  header.querySelector('[data-action="reload"]').addEventListener('click', () => {
    render(view);
  });
  header.querySelector('[data-action="logout"]').addEventListener('click', () => {
    clearAdminToken();
    render(view);
  });

  window.addEventListener('hashchange', () => { render(view); });
  await render(view);
}
