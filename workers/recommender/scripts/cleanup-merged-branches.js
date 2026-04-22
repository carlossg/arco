#!/usr/bin/env node
/**
 * Cleanup merged branches.
 *
 * For each branch already merged into main, checks:
 *   - git worktree (in .claude/worktrees/)
 *   - live Cloudflare worker preview alias (via CF API)
 *
 * Shows status, prompts y/n per branch, then removes all present artifacts
 * and deletes the local branch.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import getAuthToken from './cf-auth.js';

// eslint-disable-next-line no-underscore-dangle
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(__dirname, '..');

function getMainRepoRoot() {
  const out = execSync(`git -C ${WORKER_DIR} worktree list --porcelain`, { encoding: 'utf8' });
  const firstWorktreeLine = out.split('\n').find((l) => l.startsWith('worktree '));
  return firstWorktreeLine.slice('worktree '.length).trim();
}

const REPO_ROOT = getMainRepoRoot();
const wranglerPath = join(WORKER_DIR, 'wrangler.jsonc');
const wranglerRaw = readFileSync(wranglerPath, 'utf8').replace(/\/\/[^\n]*/g, '');
const wranglerConfig = JSON.parse(wranglerRaw);

const ACCOUNT_ID = wranglerConfig.account_id;
const WORKER_BASE = wranglerConfig.name; // "arco-recommender"

function toAlias(branch) {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchDeployedWorkers(token) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  if (!json.success) throw new Error(`CF API: ${JSON.stringify(json.errors)}`);
  return Object.fromEntries(json.result.map((w) => [w.id, w]));
}

function getMergedBranches(exclude) {
  try {
    return execSync(`git -C ${REPO_ROOT} branch --merged main`, { encoding: 'utf8' })
      .split('\n')
      .map((b) => b.replace(/^[*+]?\s+/, '').trim())
      .filter((b) => b && !exclude.includes(b));
  } catch {
    return [];
  }
}

function getCurrentBranch() {
  try {
    return execSync(`git -C ${REPO_ROOT} branch --show-current`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function getWorktrees() {
  const out = execSync(`git -C ${REPO_ROOT} worktree list --porcelain`, { encoding: 'utf8' });
  const result = [];
  let cur = {};
  out.split('\n').forEach((line) => {
    if (line.startsWith('worktree ')) {
      if (cur.path) result.push(cur);
      cur = { path: line.slice(9) };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace('refs/heads/', '');
    }
  });
  if (cur.path) result.push(cur);
  return result;
}

process.stdout.write('Scanning...\n\n');

const currentBranch = getCurrentBranch();
const deployedWorkers = await fetchDeployedWorkers(getAuthToken(WORKER_DIR));
const mergedBranches = getMergedBranches(['main', currentBranch]);
const worktrees = getWorktrees();

if (mergedBranches.length === 0) {
  console.log('No merged branches found.');
  process.exit(0);
}

console.log(`Found ${mergedBranches.length} merged branch${mergedBranches.length === 1 ? '' : 'es'}.\n`);

const branches = mergedBranches.map((branch) => {
  const alias = toAlias(branch);
  const workerId = `${WORKER_BASE}-${alias}`;
  const worktree = worktrees.find((w) => w.branch === branch) ?? null;
  const cfWorker = deployedWorkers[workerId] ?? null;
  return {
    branch, alias, workerId, worktree, cfWorker,
  };
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => { rl.question(q, (a) => { resolve(a.trim().toLowerCase()); }); });

const DIVIDER = '─'.repeat(52);
const toCleanUp = [];

// eslint-disable-next-line no-await-in-loop
await branches.reduce(async (prev, info) => {
  await prev;
  const { branch, worktree, cfWorker } = info;

  const worktreeStatus = worktree
    ? `✓  ${worktree.path.replace(`${REPO_ROOT}/`, '')}`
    : '–  not found';
  const workerStatus = cfWorker
    ? `✓  live (updated ${new Date(cfWorker.modified_on).toLocaleDateString()})`
    : '–  not deployed';

  console.log(DIVIDER);
  console.log(`  ${branch}`);
  console.log(`  worktree  ${worktreeStatus}`);
  console.log(`  worker    ${workerStatus}`);
  console.log();

  const hasArtifacts = worktree || cfWorker;
  const prompt = hasArtifacts
    ? '  Clean up worker/worktree + delete branch? [y/N] '
    : '  Delete local branch? [y/N] ';

  const answer = await ask(prompt);
  console.log();

  if (answer === 'y') toCleanUp.push(info);
}, Promise.resolve());

rl.close();

if (toCleanUp.length === 0) {
  console.log('Nothing to clean up.');
  process.exit(0);
}

console.log(DIVIDER);
console.log(`Cleaning up ${toCleanUp.length} branch${toCleanUp.length === 1 ? '' : 'es'}...\n`);

toCleanUp.forEach(({ branch, alias, worktree, cfWorker }) => {
  console.log(`  ${branch}`);

  if (cfWorker) {
    process.stdout.write('    Removing branch worker alias... ');
    const r = spawnSync(
      'npx',
      ['wrangler', 'versions', 'upload', '--preview-alias', alias, '--message', `Cleanup: releasing alias ${alias}`],
      { cwd: WORKER_DIR, encoding: 'utf8' },
    );
    console.log(r.status === 0 ? 'done' : `failed — ${(r.stderr || r.stdout || '').split('\n').find((l) => /error/i.test(l))?.trim() || 'unknown error'}`);
  }

  if (worktree) {
    process.stdout.write('    Removing worktree...            ');
    const r = spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', worktree.path], { encoding: 'utf8' });
    console.log(r.status === 0 ? 'done' : `failed — ${(r.stderr || '').trim().split('\n').pop()}`);
  }

  process.stdout.write('    Deleting branch...               ');
  const r = spawnSync('git', ['-C', REPO_ROOT, 'branch', '-d', branch], { encoding: 'utf8' });
  console.log(r.status === 0 ? 'done' : `failed — ${(r.stderr || '').trim().split('\n').pop()}`);

  console.log();
});

console.log(DIVIDER);
console.log('Done.');
