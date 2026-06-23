#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import getAuthToken from './cf-auth.js';

// eslint-disable-next-line no-underscore-dangle
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(__dirname, '..');

const wranglerPath = join(WORKER_DIR, 'wrangler.jsonc');
const wranglerRaw = readFileSync(wranglerPath, 'utf8').replace(/\/\/[^\n]*/g, '');
const wranglerConfig = JSON.parse(wranglerRaw);

const ACCOUNT_ID = wranglerConfig.account_id;
const BASE_NAME = wranglerConfig.name; // "arco-recommender"

async function listWorkers(accountId, token) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  if (!json.success) throw new Error(`CF API error: ${JSON.stringify(json.errors)}`);
  return json.result;
}

const token = getAuthToken(WORKER_DIR);
const allWorkers = await listWorkers(ACCOUNT_ID, token);

const branchPrefix = `${BASE_NAME}-`;
const branchWorkers = allWorkers.filter((w) => w.id.startsWith(branchPrefix));

if (branchWorkers.length === 0) {
  console.log('No branch workers deployed.');
  process.exit(0);
}

console.log(`Branch workers (${branchWorkers.length}):\n`);

branchWorkers.forEach((worker) => {
  const branch = worker.id.slice(branchPrefix.length);
  const modified = new Date(worker.modified_on).toLocaleString();
  console.log(`  Branch:   ${branch}`);
  console.log(`  Worker:   https://${worker.id}.franklin-prod.workers.dev`);
  console.log(`  Frontend: https://${branch}--arco--froesef.aem.page/discover`);
  console.log(`  Updated:  ${modified}`);
  console.log('');
});
