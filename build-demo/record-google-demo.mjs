/* eslint-env node */
/* eslint import/no-extraneous-dependencies: ["error", { "devDependencies": true }] */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = new URL(process.env.BASE_URL
  || 'https://feat-google-cloud-backend--arco--carlossg.aem.page');
const api = new URL(process.env.API_URL
  || 'https://arco-recommender-gcp-okyq6gkx3a-uc.a.run.app');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(process.env.OUTPUT_DIR || `build-demo/recordings/google-${stamp}`);
const query = "I'm looking for a coffee machine to use when camping in the middle of the forest";
const health = await fetch(new URL('/health', api), { signal: AbortSignal.timeout(60_000) });
assert.equal(health.status, 200);
assert.equal((await health.json()).platform, 'google-cloud');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: output, size: { width: 1920, height: 1080 } },
});
await context.addInitScript(() => sessionStorage.setItem('arco-welcome-shown', '1'));
const cloudflare = [];
const errors = [];
const generations = [];
context.on('request', (request) => {
  if (/(^|\.)(workers\.dev|cloudflare\.com)$/.test(new URL(request.url()).hostname)) {
    cloudflare.push(request.url());
  }
});
await context.route(
  (url) => /(^|\.)(workers\.dev|cloudflare\.com)$/.test(url.hostname),
  (route) => route.abort(),
);
const page = await context.newPage();
page.setDefaultTimeout(30_000);
page.setDefaultNavigationTimeout(90_000);
page.on('pageerror', (error) => errors.push(error.message));
const video = page.video();
const started = Date.now();
const acts = [];
let published;

function act(title, caption) {
  acts.push({ title, caption, start: Date.now() - started });
  console.log(`ACT ${acts.length}: ${title}`);
}

async function scroll(steps = 7) {
  for (let i = 0; i < steps; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(({ step, total }) => {
      const height = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: (height * step) / (total - 1), behavior: 'smooth' });
    }, { step: i, total: steps });
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(850);
  }
}

async function top() {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(900);
}

async function navigate(menu, path) {
  await top();
  await page.locator('header .nav-drop').filter({
    has: page.getByRole('link', { name: menu, exact: true }),
  }).evaluate((element) => element.click());
  await page.waitForTimeout(700);
  await page.locator(`header a[href="${path}"]`).click();
  await page.waitForURL(new URL(path, origin).href);
  await page.locator('main .section[data-section-status="loaded"]').first().waitFor();
  await page.waitForTimeout(3_500);
}

function generationResponse() {
  return page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/generate'
      && response.request().method() === 'POST'
  ), { timeout: 120_000 });
}

async function finishGeneration(pending) {
  const response = await pending;
  assert.equal(new URL(response.url()).origin, api.origin);
  assert.equal(response.status(), 200);
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.filter((event) => event.type === 'error'), []);
  assert.ok(events.some((event) => event.type === 'done'));
  const sections = events.filter((event) => event.type === 'section');
  assert.ok(sections.length > 0);
  await page.waitForFunction((count) => (
    document.querySelectorAll('#generation-content > .section[data-section-status="loaded"]').length
      === count && !document.querySelector('.generating-container')
  ), sections.length, { timeout: 120_000 });
  assert.ok((await page.locator('main h1').first().innerText()).length > 0);
  generations.push({ api: response.url(), sections: sections.length, url: page.url() });
  await page.waitForTimeout(2_000);
  return sections;
}

try {
  act('Homepage', 'Arco on AEM Edge Delivery Services, using the Google Cloud backend.');
  await page.goto(origin.href, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3_500);
  await scroll(5);

  act('Espresso Anywhere', 'Browsing travel-friendly coffee equipment builds real session context.');
  await navigate('Experiences', '/experiences/espresso-anywhere');
  await scroll();

  act('Travel Espresso Guide', 'A second related page adds travel and outdoor interests.');
  await navigate('Stories', '/stories/travel-espresso-guide');
  await scroll();

  act('For You', 'The For You link generates a personalized page from this browsing session.');
  await top();
  const personalized = generationResponse();
  await page.locator('header .nav-foryou[aria-hidden="false"] a').click();
  await finishGeneration(personalized);
  await scroll(9);

  act('AI Search', 'A natural-language camping query streams a new page from the Google service.');
  await page.goto(origin.href, { waitUntil: 'networkidle' });
  const search = page.locator('header input[type="search"]');
  await search.click();
  await search.pressSequentially(query, { delay: 55 });
  await page.waitForTimeout(900);
  const generated = generationResponse();
  await search.press('Enter');
  const blocks = await finishGeneration(generated);
  await scroll(9);

  act('Publish and reopen', 'The Google API saves to DA, previews and publishes. Reopen the saved page.');
  await top();
  const response = await context.request.post(new URL('/api/persist', api).href, {
    data: {
      query,
      blocks,
      title: 'Arco on Google Cloud: camping espresso',
      pageId: `google-video-${randomUUID().slice(0, 8)}`,
    },
    timeout: 240_000,
  });
  assert.equal(response.status(), 200, await response.text());
  published = await response.json();
  assert.equal(published.success, true);
  const savedUrl = new URL(published.path, origin).href;
  await page.goto(savedUrl, { waitUntil: 'networkidle' });
  await page.locator('main .hero[data-block-status="loaded"]').waitFor();
  assert.equal(await page.title(), 'Arco on Google Cloud: camping espresso');
  await page.waitForTimeout(2_000);
  await page.screenshot({ path: resolve(output, 'published-page.png'), fullPage: true });
  await scroll(8);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('main .hero[data-block-status="loaded"]').waitFor();
  await page.waitForTimeout(3_000);
  assert.equal(await page.locator('main img').first().evaluate(
    (image) => image.complete && image.naturalWidth > 0,
  ), true);
  assert.deepEqual(cloudflare, []);
  assert.deepEqual(errors, []);
} finally {
  await page.close();
  await context.close();
  await browser.close();
}

const raw = await video.path();
const duration = Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw,
], { encoding: 'utf8' }).trim());
function timestamp(ms) {
  return new Date(ms).toISOString().slice(11, 23);
}
const captions = ['WEBVTT', ''];
const chapters = [';FFMETADATA1', 'title=Arco - Google Cloud demo'];
acts.forEach((item, index) => {
  const end = acts[index + 1]?.start ?? Math.round(duration * 1_000);
  captions.push(`${timestamp(item.start)} --> ${timestamp(end)}`, item.caption, '');
  chapters.push(
    '[CHAPTER]',
    'TIMEBASE=1/1000',
    `START=${item.start}`,
    `END=${end}`,
    `title=${item.title}`,
  );
});
const subtitles = resolve(output, 'demo.vtt');
const metadata = resolve(output, 'chapters.txt');
await writeFile(subtitles, captions.join('\n'));
await writeFile(metadata, `${chapters.join('\n')}\n`);
await writeFile(resolve(output, 'report.json'), JSON.stringify({
  recordedAt: new Date().toISOString(),
  origin: origin.href,
  duration,
  acts,
  generations,
  published,
  cloudflareRequests: cloudflare,
  pageErrors: errors,
}, null, 2));
const mp4 = resolve(output, 'arco-google-cloud-demo.mp4');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-i', raw, '-i', subtitles,
  '-f', 'ffmetadata', '-i', metadata,
  '-map', '0:v:0', '-map', '1:0', '-map_metadata', '2', '-map_chapters', '2',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default',
  '-an', '-movflags', '+faststart', mp4,
], { stdio: 'inherit' });
console.log(`Verified Google demo recorded: ${mp4}`);
