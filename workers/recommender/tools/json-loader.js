/**
 * Custom ESM loader hook that:
 *  1. Automatically adds `type: 'json'` import attributes for `.json` files,
 *     working around Node 24's strict requirement.
 *  2. Handles `.yaml` / `.yml` / `.njk` files as text imports, mirroring the
 *     wrangler `rules` config that treats them as `Text` bundles on CF Workers.
 *
 * Usage: node --loader ./tools/json-loader.js <script>
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEXT_EXTS = ['.yaml', '.yml', '.njk'];

export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const result = await nextLoad(url, { ...context, importAttributes: { type: 'json' } });
    return result;
  }
  if (TEXT_EXTS.some((ext) => url.endsWith(ext))) {
    // Read the file as a UTF-8 string and re-export it as a default ESM string.
    const filePath = fileURLToPath(url);
    const source = readFileSync(filePath, 'utf8');
    const escaped = JSON.stringify(source);
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${escaped};\n`,
    };
  }
  return nextLoad(url, context);
}
