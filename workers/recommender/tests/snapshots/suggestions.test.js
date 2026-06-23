/**
 * Suggestions snapshot tests — assert renderPrompt('suggestions', ctx) is
 * byte-identical to the legacy SYSTEM_PROMPT(count)+buildUserPrompt(body)
 * output captured in tests/snapshots/__snapshots__/baseline-suggestions-*.txt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderPrompt } from '../../src/prompt-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../fixtures');
const SNAPSHOTS_DIR = path.resolve(HERE, '__snapshots__');

const fixtures = (await readdir(FIXTURES_DIR))
  .filter((f) => f.startsWith('suggestions-') && f.endsWith('.json'));

for (const file of fixtures) {
  const name = file.replace(/\.json$/, '');
  test(`suggestions snapshot — ${name}`, async () => {
    const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), 'utf8'));
    const { system, user } = renderPrompt('suggestions', fx);
    const expectedSystem = await readFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`), 'utf8');
    const expectedUser = await readFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`), 'utf8');
    assert.equal(system, expectedSystem, `suggestions system diverged for ${name}`);
    assert.equal(user, expectedUser, `suggestions user diverged for ${name}`);
  });
}
