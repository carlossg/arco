/**
 * Shared formatting helpers — used by admin, vectorize, and debug-panel blocks.
 *
 * All helpers accept `null`/`undefined` and return a visible em-dash for empty
 * values, so the caller doesn't have to guard.
 */

/**
 * Format an epoch-ms timestamp as a short local date-time string.
 */
export function formatTimestamp(ms) {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Format a duration in milliseconds. Values under 1s are shown as whole ms;
 * longer values are shown as seconds to `decimals` places.
 */
export function formatDuration(ms, decimals = 1) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(decimals)}s`;
}

/**
 * Format an integer with locale-aware thousands separators.
 */
export function formatInt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

/**
 * Map a millisecond duration to a CSS class used to colour-code perf.
 * Used by the debug panel.
 */
export function timingClass(ms) {
  if (ms == null) return '';
  if (ms < 100) return 'timing-fast';
  if (ms < 500) return 'timing-med';
  return 'timing-slow';
}
