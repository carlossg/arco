/* eslint-env node */
/* eslint import/no-extraneous-dependencies: ["error", { "devDependencies": true }] */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const origin = process.env.BASE_URL || 'http://localhost:3000';
let browser;

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function createPage(width = 390) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.addInitScript(() => {
    sessionStorage.setItem('arco-welcome-shown', '1');
    window.loadingMetrics = { cls: 0, lcp: 0 };
    new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        if (!entry.hadRecentInput) window.loadingMetrics.cls += entry.value;
      });
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        window.loadingMetrics.lcp = entry.startTime;
      });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  await page.route('**/api/track', (route) => route.fulfill({
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  return page;
}

[390, 1440].forEach((width) => {
  test(`real generation has stable layout at ${width}px`, async (t) => {
    const page = await createPage(width);
    const cloudflare = [];
    const errors = [];
    page.on('request', (request) => {
      if (/(^|\.)(workers\.dev|cloudflare\.com)$/.test(new URL(request.url()).hostname)) {
        cloudflare.push(request.url());
      }
    });
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const generated = page.waitForResponse((response) => (
        response.url().endsWith('/api/generate') && response.request().method() === 'POST'
      ));
      await page.goto(`${origin}/?q=portable+espresso+for+camping`);
      const response = await generated;
      assert.equal(response.status(), 200);
      await response.finished();
      const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === 'done'));
      assert.deepEqual(events.filter((event) => event.type === 'error'), []);
      await page.waitForFunction((count) => (
        document.querySelectorAll('#generation-content > .section[data-run-id][data-section-status="loaded"]').length === count
        && !document.querySelector('.generating-container')
      ), events.filter((event) => event.type === 'section').length);
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const metrics = await page.evaluate(() => window.loadingMetrics);
      t.diagnostic(JSON.stringify({ width, ...metrics }));
      assert.ok(metrics.cls < 0.1, `CLS ${metrics.cls} must remain below 0.1`);
      assert.equal(await page.evaluate(() => (
        document.documentElement.scrollWidth > window.innerWidth
      )), false);
      assert.deepEqual(cloudflare, []);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
});

[false, true].forEach((late) => {
  test(`stream errors remain visible ${late ? 'after' : 'before'} the first section`, async () => {
    const page = await createPage();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const message = 'Upstream unavailable <retry>';
    const events = [
      ...(late ? [{
        type: 'section',
        html: '<div class="hero"><div><div><h1>Partial recommendation</h1></div></div></div>',
      }] : []),
      { type: 'error', message },
    ];
    await page.route('**/api/generate', async (route) => {
      await gate;
      await route.fulfill({
        contentType: 'application/x-ndjson',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      });
    });
    try {
      await page.goto(`${origin}/?q=${encodeURIComponent('<strong>literal query</strong>')}`);
      await page.locator('.generating-query').waitFor();
      assert.match(await page.locator('.generating-query').innerText(), /<strong>literal query/);
      assert.equal(await page.locator('.generating-query strong').count(), 0);
      release();
      await page.locator('[role="alert"]').waitFor();
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      assert.equal(await page.locator('[role="alert"]').isVisible(), true);
      assert.ok((await page.locator('[role="alert"]').innerText()).includes(message));
      assert.equal(await page.locator('[role="alert"] retry').count(), 0);
      assert.equal(await page.locator('#generation-content h1').count(), late ? 1 : 0);
    } finally {
      release();
      await page.close();
    }
  });
});
