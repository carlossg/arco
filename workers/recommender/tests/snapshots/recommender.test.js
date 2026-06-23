/**
 * Snapshot tests — assert buildRecommenderUserMessage / buildRecommenderSystemPrompt
 * produce output byte-identical to the pre-refactor baselines captured by
 * tools/capture-baseline.js. The public API stays stable; whether it routes
 * through the old JS path (today) or the new YAML renderer (after Task 12),
 * this test is the regression gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildRecommenderSystemPrompt,
  buildRecommenderUserMessage,
} from '../../src/recommender-prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../fixtures');
const SNAPSHOTS_DIR = path.resolve(HERE, '__snapshots__');

const fixtures = (await readdir(FIXTURES_DIR))
  .filter((f) => f.endsWith('.json') && !f.startsWith('suggestions-'));

for (const file of fixtures) {
  const name = file.replace(/\.json$/, '');
  test(`recommender snapshot — ${name}`, async () => {
    const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), 'utf8'));

    const system = buildRecommenderSystemPrompt();
    const user = buildRecommenderUserMessage(
      fx.query,
      fx.behavior,
      fx.previousQueries || [],
      fx.followUp,
      fx.shownContent || {},
      fx.intent,
      fx.contextData || {},
    );

    const expectedSystem = await readFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`), 'utf8');
    const expectedUser = await readFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`), 'utf8');

    assert.equal(system, expectedSystem, `system prompt diverged for ${name}`);
    assert.equal(user, expectedUser, `user prompt diverged for ${name}`);
  });
}
