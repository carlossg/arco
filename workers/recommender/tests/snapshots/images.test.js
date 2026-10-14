import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveTokens, setHeroResult } from '../../src/images.js';

const catalog = JSON.parse(await readFile(
  new URL('../../../../data/hero-image-catalog.json', import.meta.url),
  'utf8',
));

test('public hero delivery paths resolve against the fork without DA authoring URLs', () => {
  const image = catalog.images.find((entry) => entry.publishUrl?.startsWith('/media_'));
  assert.ok(image, 'catalog must contain public hero delivery paths');
  setHeroResult({ url: image.publishUrl, alt: 'Test hero' });
  const html = resolveTokens('{{hero-image:main}}');
  assert.ok(html.includes(`https://main--arco--carlossg.aem.page${image.publishUrl}`));
  assert.ok(!html.includes('content.da.live'));
  setHeroResult(null);
});

test('auth-gated hero URLs fall back to the fork delivery image', () => {
  setHeroResult({ url: 'https://content.da.live/example/arco/media/private.jpeg', alt: 'Private' });
  const html = resolveTokens('{{hero-image:main}}');
  assert.ok(html.includes('https://main--arco--carlossg.aem.page/media_'));
  assert.ok(!html.includes('content.da.live'));
  setHeroResult(null);
});
