/**
 * Analytics Analysis Block
 *
 * Displays multi-agent quality analysis results for AI-generated pages.
 * Listens for the `analytics-available` SSE event and fetches the full
 * result from the backend.
 */

const DIMENSION_LABELS = {
  contentQuality: 'Content Quality',
  layoutEffectiveness: 'Layout',
  conversionPotential: 'Conversion',
  factualAccuracy: 'Accuracy',
};

const IMPACT_COLORS = {
  high: 'var(--analytics-impact-high, #d32f2f)',
  medium: 'var(--analytics-impact-medium, #f57c00)',
  low: 'var(--analytics-impact-low, #388e3c)',
};

function renderScoreRing(score) {
  const pct = Math.round(score);
  let color = '#d32f2f';
  if (pct >= 80) color = '#388e3c';
  else if (pct >= 60) color = '#f57c00';
  return `
    <div class="analytics-score-ring" style="--score-pct: ${pct}; --score-color: ${color}">
      <span class="analytics-score-value">${pct}</span>
      <span class="analytics-score-label">Overall</span>
    </div>`;
}

function renderDimensionBar(key, value) {
  const label = DIMENSION_LABELS[key] || key;
  const pct = Math.round(value * 10); // 1-10 → 10-100
  return `
    <div class="analytics-dimension">
      <span class="analytics-dimension-label">${label}</span>
      <div class="analytics-dimension-track">
        <div class="analytics-dimension-fill" style="width: ${pct}%"></div>
      </div>
      <span class="analytics-dimension-value">${value.toFixed(1)}</span>
    </div>`;
}

function renderSuggestion(suggestion) {
  const impactColor = IMPACT_COLORS[suggestion.impact] || IMPACT_COLORS.medium;
  return `
    <li class="analytics-suggestion">
      <span class="analytics-suggestion-impact" style="background: ${impactColor}">${suggestion.impact}</span>
      <span class="analytics-suggestion-text">${suggestion.text}</span>
      <span class="analytics-suggestion-effort">${suggestion.effort} effort</span>
    </li>`;
}

function renderModelStatus(modelResults) {
  return modelResults.map((m) => {
    const icon = m.status === 'success' ? '&#10003;' : '&#10007;';
    const cls = m.status === 'success' ? 'success' : 'failed';
    const name = m.model.replace(/-/g, ' ').replace(/instruct maas/, '');
    const duration = m.duration ? ` (${(m.duration / 1000).toFixed(1)}s)` : '';
    return `<span class="analytics-model ${cls}">${icon} ${name}${duration}</span>`;
  }).join('');
}

function renderAnalytics(result) {
  const dimensions = Object.entries(result.dimensions)
    .map(([key, value]) => renderDimensionBar(key, value))
    .join('');

  const suggestions = (result.suggestions || [])
    .map(renderSuggestion)
    .join('');

  const models = renderModelStatus(result.modelResults || []);

  return `
    <div class="analytics-analysis-content">
      <div class="analytics-header">
        <h3>Quality Analysis</h3>
        <div class="analytics-models">${models}</div>
      </div>
      <div class="analytics-body">
        <div class="analytics-score-section">
          ${renderScoreRing(result.overallScore)}
        </div>
        <div class="analytics-dimensions-section">
          ${dimensions}
        </div>
      </div>
      ${suggestions ? `
      <div class="analytics-suggestions-section">
        <h4>Suggestions</h4>
        <ul class="analytics-suggestions-list">${suggestions}</ul>
      </div>` : ''}
    </div>`;
}

async function fetchAndRender(block, pageId) {
  try {
    const apiBase = window.location.hostname === 'localhost'
      ? 'http://localhost:8080'
      : '';
    const resp = await fetch(`${apiBase}/api/analytics/results/${pageId}`);
    if (!resp.ok) {
      block.innerHTML = '<div class="analytics-analysis-error">Analysis not available yet</div>';
      return;
    }
    const result = await resp.json();
    block.innerHTML = renderAnalytics(result);
  } catch {
    block.innerHTML = '<div class="analytics-analysis-error">Could not load analysis</div>';
  }
}

/**
 * Decorate the analytics-analysis block.
 * @param {Element} block
 */
export default async function decorate(block) {
  // Check if we already have a pageId in the block content (server-rendered)
  const pageIdEl = block.querySelector('[data-page-id]');
  if (pageIdEl) {
    const { pageId } = pageIdEl.dataset;
    await fetchAndRender(block, pageId);
    return;
  }

  // Otherwise, show a placeholder and wait for SSE event
  block.innerHTML = '<div class="analytics-analysis-placeholder">Analyzing page quality...</div>';
}
