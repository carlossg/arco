#!/usr/bin/env node
/**
 * Shared Cloudflare auth helper.
 *
 * Runs `wrangler whoami` to trigger an OAuth token refresh if needed,
 * then reads the fresh token from wrangler's config file.
 * Falls back to CLOUDFLARE_API_TOKEN env var if set.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export default function getAuthToken(workerDir) {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;

  execSync('npx wrangler whoami', { cwd: workerDir, stdio: 'pipe' });

  const candidates = [
    join(homedir(), '.wrangler', 'config', 'default.toml'),
    join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
  ];

  const found = candidates.reduce((result, p) => {
    if (result) return result;
    try {
      const toml = readFileSync(p, 'utf8');
      const m = toml.match(/oauth_token\s*=\s*"([^"]+)"/)
        || toml.match(/api_token\s*=\s*"([^"]+)"/);
      return m ? m[1] : null;
    } catch {
      // no-op
    }
    return null;
  }, null);

  if (found) return found;

  throw new Error('No auth token. Set CLOUDFLARE_API_TOKEN or run `wrangler login`.');
}
