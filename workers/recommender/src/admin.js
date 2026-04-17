/**
 * Admin Interface — session browser for the Arco recommender demo.
 *
 * Routes (all require HTTP Basic Auth — username: admin, password: ADMIN_TOKEN):
 *   GET /admin                           → self-contained HTML SPA
 *   GET /api/admin/sessions              → paginated session list
 *   GET /api/admin/sessions/:id          → session detail + all pages
 *   GET /api/admin/pages/:id             → page metadata + full KV payload
 */

import { CORS_HEADERS } from './pipeline/context.js';

// ─── Auth ────────────────────────────────────────────────────────────────────

function checkAuth(request, env) {
  if (!env.ADMIN_TOKEN) return true; // No token configured → open (dev)
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = atob(auth.slice(6));
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  const username = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);
  return username === 'admin' && password === env.ADMIN_TOKEN;
}

function unauthorized(forHtml) {
  const realm = 'Arco Admin';
  if (forHtml) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': `Basic realm="${realm}"`, 'Content-Type': 'text/plain' },
    });
  }
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Basic realm="${realm}"`,
    },
  });
}

// ─── API Handlers ─────────────────────────────────────────────────────────────

export async function handleAdminSessions(request, env) {
  if (!checkAuth(request, env)) return unauthorized(false);
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const { results } = await env.SESSIONS_DB.prepare(`
    SELECT id, ip_hash, user_agent, first_seen, last_seen, page_count
    FROM sessions
    ORDER BY last_seen DESC
    LIMIT ?1 OFFSET ?2
  `).bind(limit, offset).all();

  const { results: countRow } = await env.SESSIONS_DB.prepare(
    'SELECT COUNT(*) as total FROM sessions',
  ).all();

  return new Response(JSON.stringify({
    sessions: results,
    total: countRow[0]?.total || 0,
    limit,
    offset,
  }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

export async function handleAdminSession(request, env, sessionId) {
  if (!checkAuth(request, env)) return unauthorized(false);

  const { results: [session] } = await env.SESSIONS_DB.prepare(
    'SELECT * FROM sessions WHERE id = ?1',
  ).bind(sessionId).all();

  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { results: pages } = await env.SESSIONS_DB.prepare(`
    SELECT id, query, title, intent_type, journey_stage, flow_id, follow_up_type,
           block_count, created_at, duration_ms, input_tokens, output_tokens,
           da_path, preview_url, live_url
    FROM generated_pages
    WHERE session_id = ?1
    ORDER BY created_at ASC
  `).bind(sessionId).all();

  return new Response(JSON.stringify({ session, pages }), {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function handleAdminPage(request, env, pageId) {
  if (!checkAuth(request, env)) return unauthorized(false);

  const { results: [page] } = await env.SESSIONS_DB.prepare(
    'SELECT * FROM generated_pages WHERE id = ?1',
  ).bind(pageId).all();

  if (!page) {
    return new Response(JSON.stringify({ error: 'Page not found' }), {
      status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const kvPayload = await env.SESSION_STORE.get(`page:${pageId}`, 'json');

  return new Response(JSON.stringify({ page, payload: kvPayload }), {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ─── Admin SPA HTML ───────────────────────────────────────────────────────────

export function handleAdminUI(request, env) {
  if (!checkAuth(request, env)) return unauthorized(true);
  const url = new URL(request.url);
  const baseUrl = `${url.origin}`;

  /* eslint-disable no-useless-escape */
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arco Admin — Session Browser</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d0d0d;
    --surface: #161616;
    --border: #2a2a2a;
    --accent: #00c8ff;
    --accent2: #7c3aed;
    --text: #e8e8e8;
    --muted: #888;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
    --radius: 6px;
    --font: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; line-height: 1.6; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Layout */
  #app { display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
  header h1 { font-size: 14px; font-weight: 600; color: var(--accent); letter-spacing: 0.05em; }
  header .breadcrumb { color: var(--muted); font-size: 12px; flex: 1; }
  header .breadcrumb span { color: var(--text); }
  #main { flex: 1; overflow: auto; padding: 20px; }

  /* Cards / tables */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 16px; }
  .card-header { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .card-header h2 { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 16px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--border); font-weight: 400; }
  td { padding: 8px 16px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr.clickable:hover td { background: rgba(255,255,255,0.03); cursor: pointer; }
  .mono { font-family: var(--font); }
  .id-cell { color: var(--muted); font-size: 11px; font-family: var(--font); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge-blue { background: rgba(0,200,255,0.15); color: var(--accent); }
  .badge-purple { background: rgba(124,58,237,0.2); color: #a78bfa; }
  .badge-green { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-yellow { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .badge-gray { background: rgba(255,255,255,0.07); color: var(--muted); }

  /* Stat row */
  .stats-row { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat-box { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 20px; min-width: 120px; }
  .stat-box .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .stat-box .value { font-size: 22px; font-weight: 700; color: var(--accent); }

  /* Page detail */
  .blocks-grid { display: flex; flex-direction: column; gap: 8px; }
  .block-item { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .block-header { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface); cursor: pointer; user-select: none; }
  .block-header .block-num { color: var(--muted); font-size: 11px; min-width: 24px; }
  .block-header .block-type { flex: 1; font-size: 12px; color: var(--text); }
  .block-header .toggle { color: var(--muted); font-size: 10px; }
  .block-preview { padding: 12px; }
  .block-preview pre { white-space: pre-wrap; word-break: break-all; font-size: 11px; color: var(--muted); max-height: 300px; overflow: auto; }
  .block-render { padding: 12px; background: #fff; color: #111; border-radius: 4px; font-family: sans-serif; font-size: 13px; }
  .block-render h1, .block-render h2, .block-render h3 { margin-bottom: 8px; }
  .block-render p { margin-bottom: 6px; }
  .block-render ul, .block-render ol { padding-left: 20px; margin-bottom: 6px; }

  /* Debug panel */
  .debug-section { margin-top: 8px; }
  .debug-section summary { cursor: pointer; color: var(--muted); font-size: 12px; padding: 6px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); list-style: none; }
  .debug-section summary::-webkit-details-marker { display: none; }
  .debug-section summary::before { content: '▶ '; font-size: 10px; }
  details[open] summary::before { content: '▼ '; font-size: 10px; }
  .debug-section .debug-body { background: var(--bg); border: 1px solid var(--border); border-top: none; border-radius: 0 0 var(--radius) var(--radius); padding: 12px; overflow: auto; max-height: 500px; }
  .debug-section pre { font-size: 11px; color: #aaa; white-space: pre-wrap; word-break: break-all; }
  .kv-row { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border); }
  .kv-row:last-child { border-bottom: none; }
  .kv-key { color: var(--muted); min-width: 160px; font-size: 11px; }
  .kv-val { color: var(--text); font-size: 11px; word-break: break-all; }

  /* Pagination */
  .pagination { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
  .pagination button { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 4px 12px; border-radius: var(--radius); font-family: var(--font); font-size: 12px; cursor: pointer; }
  .pagination button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .pagination button:disabled { opacity: 0.3; cursor: default; }
  .pagination .info { color: var(--muted); font-size: 12px; }

  /* Loading / empty */
  .loading { color: var(--muted); padding: 40px; text-align: center; }
  .empty { color: var(--muted); padding: 24px 16px; font-size: 12px; font-style: italic; }

  /* Query text */
  .query-text { color: var(--text); max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Back button */
  .back-btn { background: none; border: 1px solid var(--border); color: var(--muted); padding: 4px 12px; border-radius: var(--radius); font-family: var(--font); font-size: 12px; cursor: pointer; }
  .back-btn:hover { border-color: var(--accent); color: var(--accent); }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>⬡ ARCO ADMIN</h1>
    <div class="breadcrumb" id="breadcrumb"></div>
    <button class="back-btn" id="back-btn" style="display:none" onclick="history.back()">← Back</button>
  </header>
  <div id="main">
    <div id="view"></div>
  </div>
</div>

<script>
const BASE = '${baseUrl}';

// ─── API ──────────────────────────────────────────────────────────────────────

// Browser automatically sends Basic Auth credentials on same-origin requests
// once the user has authenticated via the WWW-Authenticate challenge.
async function api(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function ts(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
}

function dur(ms) {
  if (!ms) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms/1000).toFixed(1) + 's';
}

function badge(label, color) {
  if (!label) return '<span class="badge badge-gray">—</span>';
  return '<span class="badge badge-' + color + '">' + esc(label) + '</span>';
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function intentBadge(intent) {
  const map = { espresso:'blue', 'milk-drinks':'purple', comparison:'yellow', grinder:'green', gift:'yellow', beginner:'green', support:'gray' };
  return badge(intent, map[intent] || 'blue');
}

function kv(key, val) {
  return '<div class="kv-row"><div class="kv-key">' + esc(key) + '</div><div class="kv-val">' + esc(String(val ?? '—')) + '</div></div>';
}

// ─── Routing ──────────────────────────────────────────────────────────────────

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const view = document.getElementById('view');
  const bc = document.getElementById('breadcrumb');
  const backBtn = document.getElementById('back-btn');

  if (hash === '/') {
    backBtn.style.display = 'none';
    bc.innerHTML = '<span>Sessions</span>';
    renderSessions(view);
  } else if (hash.startsWith('/sessions/')) {
    const id = hash.replace('/sessions/', '');
    backBtn.style.display = '';
    bc.innerHTML = '<a href="#/">Sessions</a> / <span>' + id.substring(0,8) + '…</span>';
    renderSession(view, id);
  } else if (hash.startsWith('/pages/')) {
    const id = hash.replace('/pages/', '');
    backBtn.style.display = '';
    bc.innerHTML = '… / <span>' + id.substring(0,8) + '…</span>';
    renderPage(view, id);
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);

// ─── Sessions List ────────────────────────────────────────────────────────────

let sessOffset = 0;
const SESS_LIMIT = 50;

async function renderSessions(el, offset) {
  offset = offset ?? 0;
  sessOffset = offset;
  el.innerHTML = '<div class="loading">Loading sessions…</div>';
  let data;
  try { data = await api('/api/admin/sessions?limit=' + SESS_LIMIT + '&offset=' + offset); }
  catch(e) { el.innerHTML = '<div class="loading" style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; return; }

  const total = data.total || 0;
  const sessions = data.sessions || [];

  el.innerHTML = '';

  // Stats
  el.innerHTML += '<div class="stats-row">'
    + '<div class="stat-box"><div class="label">Total Sessions</div><div class="value">' + total + '</div></div>'
    + '</div>';

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<div class="card-header"><h2>Sessions</h2></div>'
    + (sessions.length === 0
      ? '<div class="empty">No sessions yet. Generate some recommendations first!</div>'
      : '<table>'
        + '<thead><tr><th>Session ID</th><th>First Seen</th><th>Last Active</th><th>Pages</th><th>User Agent</th></tr></thead>'
        + '<tbody>'
        + sessions.map(s => '<tr class="clickable" onclick="location.hash=\\'/sessions/' + s.id + '\\'"><td class="id-cell">' + esc(s.id.substring(0,16)) + '…</td><td>' + ts(s.first_seen) + '</td><td>' + ts(s.last_seen) + '</td><td>' + badge(s.page_count, 'blue') + '</td><td style="color:var(--muted);font-size:11px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc((s.user_agent || '').substring(0,80)) + '</td></tr>').join('')
        + '</tbody></table>');
  el.appendChild(card);

  if (total > SESS_LIMIT) {
    const pg = document.createElement('div');
    pg.className = 'pagination';
    pg.innerHTML = '<button ' + (offset === 0 ? 'disabled' : '') + ' onclick="renderSessions(document.getElementById(\\'view\\'), ' + Math.max(0, offset-SESS_LIMIT) + ')">← Prev</button>'
      + '<span class="info">' + (offset+1) + '–' + Math.min(offset+SESS_LIMIT, total) + ' of ' + total + '</span>'
      + '<button ' + (offset+SESS_LIMIT >= total ? 'disabled' : '') + ' onclick="renderSessions(document.getElementById(\\'view\\'), ' + (offset+SESS_LIMIT) + ')">Next →</button>';
    el.appendChild(pg);
  }
}

// ─── Session Detail ───────────────────────────────────────────────────────────

async function renderSession(el, sessionId) {
  el.innerHTML = '<div class="loading">Loading session…</div>';
  let data;
  try { data = await api('/api/admin/sessions/' + sessionId); }
  catch(e) { el.innerHTML = '<div class="loading" style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; return; }

  const s = data.session;
  const pages = data.pages || [];
  el.innerHTML = '';

  // Session metadata
  el.innerHTML += '<div class="stats-row">'
    + '<div class="stat-box"><div class="label">Pages Generated</div><div class="value">' + s.page_count + '</div></div>'
    + '<div class="stat-box"><div class="label">First Seen</div><div class="value" style="font-size:13px">' + ts(s.first_seen) + '</div></div>'
    + '<div class="stat-box"><div class="label">Last Active</div><div class="value" style="font-size:13px">' + ts(s.last_seen) + '</div></div>'
    + '</div>';

  const metaCard = document.createElement('div');
  metaCard.className = 'card';
  metaCard.innerHTML = '<div class="card-header"><h2>Session Info</h2></div>'
    + '<div style="padding:12px">'
    + kv('Session ID', s.id)
    + kv('IP Hash', s.ip_hash)
    + kv('User Agent', s.user_agent)
    + '</div>';
  el.appendChild(metaCard);

  const pagesCard = document.createElement('div');
  pagesCard.className = 'card';
  pagesCard.innerHTML = '<div class="card-header"><h2>Generated Pages (' + pages.length + ')</h2></div>'
    + (pages.length === 0
      ? '<div class="empty">No pages recorded for this session.</div>'
      : '<table>'
        + '<thead><tr><th>#</th><th>Query</th><th>Intent</th><th>Blocks</th><th>Duration</th><th>Tokens</th><th>Time</th></tr></thead>'
        + '<tbody>'
        + pages.map((p,i) => '<tr class="clickable" onclick="location.hash=\\'/pages/' + p.id + '\\'"><td style="color:var(--muted)">' + (i+1) + '</td><td class="query-text">' + esc(p.query) + '</td><td>' + intentBadge(p.intent_type) + '</td><td>' + (p.block_count || '—') + '</td><td>' + dur(p.duration_ms) + '</td><td style="font-size:11px;color:var(--muted)">' + (p.input_tokens ? p.input_tokens + '↑ ' + p.output_tokens + '↓' : '—') + '</td><td style="font-size:11px">' + ts(p.created_at) + '</td></tr>').join('')
        + '</tbody></table>');
  el.appendChild(pagesCard);
}

// ─── Page Detail ──────────────────────────────────────────────────────────────

async function renderPage(el, pageId) {
  el.innerHTML = '<div class="loading">Loading page…</div>';
  let data;
  try { data = await api('/api/admin/pages/' + pageId); }
  catch(e) { el.innerHTML = '<div class="loading" style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; return; }

  const p = data.page;
  const payload = data.payload;
  el.innerHTML = '';

  // Metadata
  el.innerHTML += '<div class="stats-row">'
    + '<div class="stat-box"><div class="label">Duration</div><div class="value">' + dur(p.duration_ms) + '</div></div>'
    + '<div class="stat-box"><div class="label">Blocks</div><div class="value">' + (p.block_count||0) + '</div></div>'
    + '<div class="stat-box"><div class="label">Input Tokens</div><div class="value">' + (p.input_tokens||'—') + '</div></div>'
    + '<div class="stat-box"><div class="label">Output Tokens</div><div class="value">' + (p.output_tokens||'—') + '</div></div>'
    + '</div>';

  const metaCard = document.createElement('div');
  metaCard.className = 'card';
  metaCard.innerHTML = '<div class="card-header"><h2>Page Metadata</h2></div>'
    + '<div style="padding:12px">'
    + kv('Page ID', p.id)
    + kv('Session ID', p.session_id)
    + kv('Query', p.query)
    + kv('Title', p.title)
    + kv('Intent', p.intent_type)
    + kv('Journey Stage', p.journey_stage)
    + kv('Flow', p.flow_id)
    + kv('Follow-up Type', p.follow_up_type)
    + kv('Generated', ts(p.created_at))
    + kv('DA Path', p.da_path)
    + kv('Preview URL', p.preview_url)
    + kv('Live URL', p.live_url)
    + '</div>';
  el.appendChild(metaCard);

  if (payload?.request) {
    const reqCard = document.createElement('div');
    reqCard.className = 'card';
    reqCard.innerHTML = '<div class="card-header"><h2>Request Context</h2></div>'
      + '<div style="padding:12px">'
      + kv('Query', payload.request.query)
      + kv('Previous Queries', (payload.request.previousQueries||[]).join(' → ') || '—')
      + kv('Quiz Persona', payload.request.quizPersona)
      + kv('Follow-up', payload.request.followUp ? JSON.stringify(payload.request.followUp) : null)
      + kv('Browsing History', (payload.request.browsingHistory||[]).slice(0,5).join(', ') || '—')
      + kv('Journey Stage', payload.request.inferredProfile?.journeyStage)
      + kv('Inferred Intent', payload.request.inferredProfile?.inferredIntent)
      + kv('Products Viewed', (payload.request.inferredProfile?.productsViewed||[]).join(', ') || '—')
      + '</div>';
    el.appendChild(reqCard);
  }

  // Blocks
  if (payload?.blocks?.length) {
    const blocksCard = document.createElement('div');
    blocksCard.className = 'card';
    blocksCard.innerHTML = '<div class="card-header"><h2>Generated Blocks (' + payload.blocks.length + ')</h2></div>';
    const blocksInner = document.createElement('div');
    blocksInner.style.padding = '12px';
    blocksInner.className = 'blocks-grid';

    payload.blocks.forEach(block => {
      const item = document.createElement('div');
      item.className = 'block-item';
      const headerId = 'block-body-' + block.index;
      // eslint-disable-next-line no-useless-escape
      item.innerHTML = '<div class="block-header" onclick="toggleBlock(\'' + headerId + '\')">'
        + '<span class="block-num">#' + block.index + '</span>'
        + '<span class="block-type">' + badge(block.blockType, 'blue') + '</span>'
        + '<span class="toggle" id="' + headerId + '-arrow">▼</span>'
        + '</div>';

      const body = document.createElement('div');
      body.id = headerId;
      body.style.display = 'none';

      // Render tab + source tab
      // eslint-disable-next-line no-useless-escape
      body.innerHTML = '<div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;gap:8px">'
        // eslint-disable-next-line no-useless-escape
        + '<button onclick="showTab(\'' + headerId + '\',\'render\')" id="' + headerId + '-tab-render" class="tab-btn active-tab">Rendered</button>'
        // eslint-disable-next-line no-useless-escape
        + '<button onclick="showTab(\'' + headerId + '\',\'source\')" id="' + headerId + '-tab-source" class="tab-btn">HTML Source</button>'
        + '</div>'
        + '<div id="' + headerId + '-render" class="block-render">' + block.html + '</div>'
        + '<div id="' + headerId + '-source" style="display:none" class="block-preview"><pre>' + esc(block.html) + '</pre></div>';

      item.appendChild(body);
      blocksInner.appendChild(item);
    });

    blocksCard.appendChild(blocksInner);
    el.appendChild(blocksCard);
  }

  // Debug sections
  if (payload?.debug) {
    const dbg = payload.debug;

    // RAG context
    appendDebug(el, 'RAG Context', {
      Intent: dbg.intent?.type + (dbg.intent?.confidence ? ' (' + (dbg.intent.confidence * 100).toFixed(0) + '%)' : ''),
      Persona: dbg.rag?.persona?.name,
      'Use Case': dbg.rag?.useCase?.name,
      Products: (dbg.rag?.products||[]).map(p => p.name + ' ($' + p.price + ')').join(', '),
      Features: (dbg.rag?.features||[]).map(f => f.name).join(', '),
      FAQs: dbg.rag?.faqs?.length + ' matched',
      Reviews: dbg.rag?.reviews?.map(r => r.author + '/' + r.productId).join(', '),
      Recipes: (dbg.rag?.recipes||[]).map(r => r.name).join(', '),
      'Hero Images': (dbg.rag?.heroImages||[]).map(h => h.id + '(' + (h.score||0).toFixed(2) + ')').join(', '),
    });

    // Behavior analysis
    if (dbg.behaviorAnalysis) {
      appendDebug(el, 'Behavior Analysis', {
        'Cold Start': dbg.behaviorAnalysis.coldStart,
        'Price Tier': dbg.behaviorAnalysis.priceTier,
        'Price Range': dbg.behaviorAnalysis.catalogPriceRange ? '$' + dbg.behaviorAnalysis.catalogPriceRange.min + ' – $' + dbg.behaviorAnalysis.catalogPriceRange.max : null,
        'Use Case Priorities': (dbg.behaviorAnalysis.useCasePriorities||[]).join(', '),
        'Product Shortlist': (dbg.behaviorAnalysis.productShortlist||[]).join(', '),
        'Purchase Readiness': dbg.behaviorAnalysis.purchaseReadiness,
      });
    }

    // Timings
    if (dbg.timings) {
      const t = dbg.timings;
      appendDebug(el, 'Timings', {
        'Total': dur(t.total),
        'LLM': dur(t.llm),
        'First Token': dur(t.llmFirstToken),
        'Streaming': dur(t.llmStreaming),
        'Context': dur(t.context),
        'Prompt Build': dur(t.prompt),
        'Parse': dur(t.parse),
        'Steps': (t.steps||[]).map(s => s.step + ':' + s.ms + 'ms' + (s.gate?'[gate]':'')).join(' | '),
      });
    }

    // Prompt
    if (dbg.prompt) {
      const promptDet = document.createElement('details');
      promptDet.className = 'debug-section';
      promptDet.innerHTML = '<summary>Prompt (' + (dbg.prompt.systemLength||0) + ' + ' + (dbg.prompt.userLength||0) + ' chars)</summary>'
        + '<div class="debug-body">'
        + '<div style="margin-bottom:8px;color:var(--muted);font-size:11px">SYSTEM PROMPT</div>'
        + '<pre>' + esc(dbg.prompt.systemPrompt || '') + '</pre>'
        + '<div style="margin:8px 0;color:var(--muted);font-size:11px">USER MESSAGE</div>'
        + '<pre>' + esc(dbg.prompt.userMessage || '') + '</pre>'
        + '</div>';
      el.appendChild(promptDet);
    }

    // Raw LLM output
    if (dbg.llm?.rawOutput) {
      const rawDet = document.createElement('details');
      rawDet.className = 'debug-section';
      rawDet.innerHTML = '<summary>Raw LLM Output (' + (dbg.llm.rawOutput.length||0) + ' chars)</summary>'
        + '<div class="debug-body"><pre>' + esc(dbg.llm.rawOutput) + '</pre></div>';
      el.appendChild(rawDet);
    }
  }
}

// ─── Debug helpers ────────────────────────────────────────────────────────────

function appendDebug(parent, title, fields) {
  const det = document.createElement('details');
  det.className = 'debug-section';
  det.innerHTML = '<summary>' + title + '</summary>'
    + '<div class="debug-body">'
    + Object.entries(fields).map(([k,v]) => kv(k, v)).join('')
    + '</div>';
  parent.appendChild(det);
}

function toggleBlock(id) {
  const body = document.getElementById(id);
  const arrow = document.getElementById(id + '-arrow');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▼' : '▲';
}

function showTab(prefix, tab) {
  const render = document.getElementById(prefix + '-render');
  const source = document.getElementById(prefix + '-source');
  const tabRender = document.getElementById(prefix + '-tab-render');
  const tabSource = document.getElementById(prefix + '-tab-source');
  if (!render || !source) return;
  if (tab === 'render') {
    render.style.display = '';
    source.style.display = 'none';
    tabRender.style.color = 'var(--accent)';
    tabSource.style.color = 'var(--muted)';
  } else {
    render.style.display = 'none';
    source.style.display = '';
    tabSource.style.color = 'var(--accent)';
    tabRender.style.color = 'var(--muted)';
  }
}

// Inline tab button style
document.head.insertAdjacentHTML('beforeend', '<style>.tab-btn{background:none;border:none;color:var(--muted);font-family:var(--font);font-size:11px;cursor:pointer;padding:2px 8px;border-radius:4px}.tab-btn:hover{color:var(--text)}</style>');

// ─── Init ─────────────────────────────────────────────────────────────────────

route();
</script>
</body>
</html>`;
  /* eslint-enable no-useless-escape */

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
