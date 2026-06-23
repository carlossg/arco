/**
 * The featureMatch.matches.length == 0 branch isn't reachable from any natural
 * query against the current catalog (every FEATURE_MAP entry has at least one
 * matching product). This test exercises the template branch directly so we
 * don't regress it.
 *
 * Skipped until Task 12 wires the renderer into the public API — before that
 * the renderer is imported but not connected to a fixture path. Unskip after
 * Task 12.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrompt } from '../../src/prompt-loader.js';

test('recommender YAML — featureMatch zero-match branch renders', () => {
  const { user } = renderPrompt('recommender', {
    query: 'hypothetical zero-match query',
    scenario: 'default',
    intent: { type: 'espresso' },
    behavior: { coldStart: true },
    featureMatch: { feature: 'imaginary-feature', matches: [] },
    rag: {},
  });
  assert.match(user, /ZERO machines in the Arco catalog have this feature/);
});
