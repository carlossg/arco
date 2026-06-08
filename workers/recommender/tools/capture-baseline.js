#!/usr/bin/env node
/**
 * Capture baseline rendered prompts from the *current* JS-based prompt
 * builders. Run BEFORE refactoring src/recommender-prompt.js. The new
 * YAML-rendered output must match these byte-for-byte (or with tracked
 * whitespace deltas).
 *
 * Usage: node tools/capture-baseline.js
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildRecommenderSystemPrompt,
  buildRecommenderUserMessage,
} from '../src/recommender-prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../tests/fixtures');
const SNAPSHOTS_DIR = path.resolve(HERE, '../tests/snapshots/__snapshots__');

async function main() {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const fx = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), 'utf8'));
    const name = file.replace(/\.json$/, '');

    if (fx.prompt === 'suggestions') {
      // Suggestions baseline — inline the SYSTEM_PROMPT(count) + buildUserPrompt(body) logic
      // from src/suggest.js verbatim.
      const count = fx.count;
      const system = (
        `You generate ${count} short, distinct exploration prompts for a coffee/espresso brand site. `
        + 'Each prompt is 3–8 words, written as a question or short imperative the user might naturally ask. '
        + 'Output strict JSON: {"suggestions":[{"label":"…","query":"…"}]}. '
        + 'Do not repeat any string in <exclude>. '
        + 'Tailor to the user profile and recently viewed items if provided.'
      );

      // Bridge fixture shape to the legacy buildUserPrompt's expected body shape
      const profile = {
        journeyStage: fx.userProfile?.journeyStage || '',
        inferredIntent: fx.userProfile?.inferredIntent || '',
        productsViewed: fx.recentlyViewed || [],
        interests: fx.userProfile?.interests || [],
        categoriesViewed: fx.userProfile?.categories || [],
      };

      // Mirror the legacy buildUserPrompt internal slicing
      const recentlyViewed = (profile.productsViewed || []).slice(-5);
      const interests = (profile.interests || []).slice(0, 5);
      const categories = (profile.categoriesViewed || []).slice(0, 5);
      const exclude = fx.excludeQueries || [];

      const user = [
        `<pageContext>{"url":${JSON.stringify(fx.pageUrl || '')},"title":${JSON.stringify(fx.pageTitle || '')}}</pageContext>`,
        `<profile>{"journeyStage":${JSON.stringify(profile.journeyStage)},"intent":${JSON.stringify(profile.inferredIntent)},"categories":${JSON.stringify(categories)},"interests":${JSON.stringify(interests)}}</profile>`,
        `<recentlyViewed>${JSON.stringify(recentlyViewed)}</recentlyViewed>`,
        `<exclude>${JSON.stringify(exclude)}</exclude>`,
      ].join('\n');

      await writeFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`), system);
      await writeFile(path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`), user);
      console.log(`captured ${name} (suggestions)`);
      continue;
    }

    // Recommender path — existing behavior
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

    await writeFile(
      path.join(SNAPSHOTS_DIR, `baseline-${name}.system.txt`),
      system,
    );
    await writeFile(
      path.join(SNAPSHOTS_DIR, `baseline-${name}.user.txt`),
      user,
    );
    console.log(`captured ${name} (recommender)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
