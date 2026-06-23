/**
 * Stats Block — Usage analytics dashboard
 *
 * Fetches aggregated analytics from /api/stats and renders:
 * - Summary cards (totals for the selected window)
 * - 15-minute time-series bar chart
 * - Top intents and top pages
 *
 * Block content (optional):
 *   Row 1: hours to display back (default 24, max 168)
 */

import { ARCO_ANALYTICS_URL } from '../../scripts/api-config.js';

const DEFAULT_HOURS = 24;
const EVENT_LABELS = {
  generation: 'Generations',
  page_view: 'Page views',
  product_view: 'Product views',
  recommender_query: 'Queries',
  cache_hit: 'Cache hits',
};
const EVENT_COLORS = {
  generation: '#e05',
  page_view: '#06a',
  product_view: '#390',
  recommender_query: '#a60',
  cache_hit: '#639',
};

function formatNumber(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n || 0);
}

// bucket is a Unix timestamp in seconds (from intDiv in SQL)
function toDate(bucket) {
  const n = Number(bucket);
  return new Date(n < 1e10 ? n * 1000 : n);
}

function formatBucket(bucket) {
  const d = toDate(bucket);
  if (Number.isNaN(d.getTime())) return String(bucket);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(bucket) {
  const d = toDate(bucket);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function buildSummaryCards(summary) {
  const cards = document.createElement('div');
  cards.className = 'stats-summary';

  const eventTypes = Object.keys(EVENT_LABELS);
  eventTypes.forEach((type) => {
    const count = summary[type] || 0;
    const card = document.createElement('div');
    card.className = 'stats-card';
    card.innerHTML = `
      <span class="stats-card-value">${formatNumber(count)}</span>
      <span class="stats-card-label">${EVENT_LABELS[type]}</span>
    `;
    card.style.setProperty('--card-color', EVENT_COLORS[type] || '#555');
    cards.appendChild(card);
  });

  return cards;
}

function buildTimeSeries(timeSeries, hoursBack) {
  const section = document.createElement('div');
  section.className = 'stats-chart-section';

  const heading = document.createElement('h3');
  heading.textContent = `Activity — last ${hoursBack}h (15-min buckets)`;
  section.appendChild(heading);

  if (!timeSeries.length) {
    const empty = document.createElement('p');
    empty.className = 'stats-empty';
    empty.textContent = 'No data yet.';
    section.appendChild(empty);
    return section;
  }

  // Pivot: collect all event types present and bucket labels
  const bucketSet = new Set();
  const typeSet = new Set();
  const dataByBucket = {};

  timeSeries.forEach(({ bucket, event_type: eventType, count }) => {
    bucketSet.add(bucket);
    typeSet.add(eventType);
    if (!dataByBucket[bucket]) dataByBucket[bucket] = {};
    dataByBucket[bucket][eventType] = (dataByBucket[bucket][eventType] || 0) + count;
  });

  const buckets = [...bucketSet].sort();
  const types = [...typeSet].filter((t) => EVENT_LABELS[t]);

  // Find max value for scaling
  const maxVal = Math.max(1, ...timeSeries.map((r) => r.count));

  // Legend
  const legend = document.createElement('div');
  legend.className = 'stats-legend';
  types.forEach((t) => {
    const item = document.createElement('span');
    item.className = 'stats-legend-item';
    item.innerHTML = `<span class="stats-legend-dot" style="background:${EVENT_COLORS[t] || '#555'}"></span>${EVENT_LABELS[t] || t}`;
    legend.appendChild(item);
  });
  section.appendChild(legend);

  // Bar chart — show at most 96 buckets (24h worth at 15-min intervals)
  const MAX_BUCKETS = 96;
  const displayBuckets = buckets.slice(-MAX_BUCKETS);

  const chart = document.createElement('div');
  chart.className = 'stats-chart';
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', 'Time series bar chart');

  // Date separators track
  let lastDate = '';

  displayBuckets.forEach((bucket) => {
    const col = document.createElement('div');
    col.className = 'stats-col';

    const dateLabel = formatDate(bucket);
    if (dateLabel !== lastDate) {
      col.dataset.date = dateLabel;
      lastDate = dateLabel;
    }

    types.forEach((eventType) => {
      const val = (dataByBucket[bucket] || {})[eventType] || 0;
      const pct = Math.round((val / maxVal) * 100);
      const bar = document.createElement('div');
      bar.className = 'stats-bar';
      bar.style.height = `${pct}%`;
      bar.style.background = EVENT_COLORS[eventType] || '#555';
      bar.title = `${formatBucket(bucket)} — ${EVENT_LABELS[eventType] || eventType}: ${val}`;
      col.appendChild(bar);
    });

    chart.appendChild(col);
  });

  section.appendChild(chart);
  return section;
}

function buildTopList(items, keyProp, labelProp, heading) {
  const section = document.createElement('div');
  section.className = 'stats-top-section';

  const h = document.createElement('h3');
  h.textContent = heading;
  section.appendChild(h);

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'stats-empty';
    empty.textContent = 'No data yet.';
    section.appendChild(empty);
    return section;
  }

  const maxVal = items[0][keyProp] || 1;
  const list = document.createElement('ol');
  list.className = 'stats-top-list';

  items.forEach((item) => {
    const li = document.createElement('li');
    const pct = Math.round((item[keyProp] / maxVal) * 100);
    li.innerHTML = `
      <span class="stats-top-label">${item[labelProp]}</span>
      <span class="stats-top-bar" style="width:${pct}%"></span>
      <span class="stats-top-count">${formatNumber(item[keyProp])}</span>
    `;
    list.appendChild(li);
  });

  section.appendChild(list);
  return section;
}

function buildError(message) {
  const el = document.createElement('p');
  el.className = 'stats-error';
  el.textContent = message;
  return el;
}

function buildTimeFilter(current, block) {
  const filter = document.createElement('div');
  filter.className = 'stats-filter';

  [24, 48, 168].forEach((h) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = h < 48 ? `${h}h` : `${h / 24}d`;
    btn.className = 'stats-filter-btn';
    if (h === current) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => {
      // eslint-disable-next-line no-use-before-define
      renderStats(block, h);
    });
    filter.appendChild(btn);
  });

  return filter;
}

async function renderStats(block, hoursBack = DEFAULT_HOURS) {
  block.innerHTML = '';

  const loading = document.createElement('p');
  loading.className = 'stats-loading';
  loading.textContent = 'Loading analytics…';
  block.appendChild(loading);

  const baseUrl = window.ARCO_CONFIG?.RECOMMENDER_URL || ARCO_ANALYTICS_URL;

  let stats;
  try {
    const res = await fetch(`${baseUrl}/api/stats?hours=${hoursBack}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    stats = json;
  } catch (err) {
    block.innerHTML = '';
    block.appendChild(buildError(`Failed to load analytics: ${err.message}`));
    return;
  }

  block.innerHTML = '';

  if (stats.error) {
    block.appendChild(buildError(stats.error));
    return;
  }

  // Time range filter
  block.appendChild(buildTimeFilter(hoursBack, block));

  // Summary cards
  block.appendChild(buildSummaryCards(stats.summary || {}));

  // Time-series chart (only shown when data is available)
  if (stats.timeSeries && stats.timeSeries.length > 0) {
    block.appendChild(buildTimeSeries(stats.timeSeries, hoursBack));
  }

  // Two-column bottom section
  const bottom = document.createElement('div');
  bottom.className = 'stats-bottom';
  bottom.appendChild(buildTopList(stats.topIntents || [], 'count', 'intent', 'Top intents'));
  bottom.appendChild(buildTopList(stats.topPaths || [], 'count', 'path', 'Top pages'));
  block.appendChild(bottom);
}

export default async function decorate(block) {
  // Read optional hours config from block content
  const configCell = block.querySelector(':scope > div > div');
  const hours = parseInt(configCell?.textContent?.trim(), 10) || DEFAULT_HOURS;
  block.innerHTML = '';

  await renderStats(block, hours);
}
