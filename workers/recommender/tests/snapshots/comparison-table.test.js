import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeBlockContent, sectionToHtml } from '../../src/json-to-eds.js';

const p = (text) => ({ type: 'p', text });

test('packed comparison values become separate product cells without changing their order', () => {
  for (const products of [['primo', 'doppio'], ['primo', 'doppio', 'nano']]) {
    const section = {
      block: 'comparison-table',
      data: { recommended: 'Primo' },
      rows: [
        [[], products.map((id) => p(`{{product-link:${id}}}`))],
        [[p('Price')], products.map((id, index) => p(`$${index + 1}`))],
        [[p('Best for espresso: {{product-link:primo}}')]],
      ],
    };
    const original = structuredClone(section);
    const result = sanitizeBlockContent(section);
    assert.deepEqual(result.rows[0], [[], ...products.map((id) => [p(`{{product-link:${id}}}`)])]);
    assert.deepEqual(result.rows[1], [[p('Price')], ...products.map((id, index) => [p(`$${index + 1}`)])]);
    assert.deepEqual(result.rows[2], section.rows[2]);
    assert.deepEqual(result.data, section.data);
    assert.match(sectionToHtml(result), /<div><p>\$1<\/p><\/div>\n {4}<div><p>\$2<\/p><\/div>/);
    assert.deepEqual(section, original);
  }
});

test('valid comparison cells keep multiline content and existing product boundaries', () => {
  const section = {
    block: 'comparison-table',
    rows: [
      [[], [p('Primo')], [p('Doppio')]],
      [[p('Features')], [p('Single boiler'), p('PID')], [p('Dual boiler'), p('PID')]],
      [[p('Best for beginners: Primo')]],
    ],
  };
  assert.equal(sanitizeBlockContent(section), section);
});

test('a trailing product-specific best-for row keeps its values in the matching product columns', () => {
  const section = {
    block: 'comparison-table',
    rows: [
      [[], [p('{{product-link:primo}}')], [p('{{product-link:doppio}}')]],
      [[p('Price')], [p('$899')], [p('$1,599')]],
      [[p('Best for espresso: {{product-link:primo}}')], [p('Best for milk: {{product-link:doppio}}')]],
    ],
  };
  const original = structuredClone(section);
  const result = sanitizeBlockContent(section);
  assert.deepEqual(result.rows.slice(0, 2), section.rows.slice(0, 2));
  assert.deepEqual(result.rows[2], [[], ...section.rows[2]]);
  assert.deepEqual(section, original);
  const reversed = { ...section, rows: [...section.rows.slice(0, 2), [...section.rows[2]].reverse()] };
  assert.equal(sanitizeBlockContent(reversed), null);
});

test('ambiguous and inconsistent comparisons are rejected instead of guessing product values', () => {
  for (const rows of [
    [],
    [null],
    [[[], [p('Primo'), p('Doppio')]]],
    [
      [[], [p('{{product-link:primo}}'), p('{{product-link:doppio}}')]],
      [[p('Price')], [p('$899')]],
    ],
  ]) {
    assert.equal(sanitizeBlockContent({ block: 'comparison-table', rows }), null);
  }
});

test('column normalization does not change other blocks with multiple paragraphs per cell', () => {
  const section = { block: 'columns', rows: [[[], [p('Primo'), p('Doppio')]]] };
  assert.equal(sanitizeBlockContent(section), section);
});
