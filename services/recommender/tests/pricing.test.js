import assert from 'node:assert/strict';
import test from 'node:test';
import { costUsd, priceFor } from '../../../workers/recommender/src/pricing.js';

test('native Gemini ROI uses its own standard token prices, not an unknown-model fallback', () => {
  assert.deepEqual(priceFor('gemini', 'gemini-2.5-flash'), {
    in: 0.30, out: 2.50, known: true, free: false,
  });
  assert.equal(costUsd('gemini', 'gemini-2.5-flash', 1000, 200), 0.0008);
  assert.deepEqual(priceFor('gemini', 'gemini-2.5-flash-lite'), {
    in: 0.10, out: 0.40, known: true, free: false,
  });
  assert.equal(costUsd('gemini', 'gemini-2.5-flash-lite', 1000, 200), 0.00018);
});
